import { describe, expect, it } from "vitest";
import { memorySql } from "../../interop/impls/pda-agent/sqlite";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client";
import { migrate } from "../../src/poppy/store";
import type { Company } from "../../src/poppy/discovery";
import type { Card } from "../../src/poppy/wire";

/** Real SQLite migrations and discovery, with transport fixtures; no token or network needed. */
function fixture() {
  const sql = memorySql();
  migrate(sql);
  let version = "0.1";
  let conversations = "https://shop.example/conversations";
  const cards: Card[] = [];
  const requests: string[] = [];
  const host: PoppyHost = {
    env: { PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Upgrade test", POPPY_LOGO_URI: "https://agent.example/logo.svg", TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64") } as unknown as Env,
    sql,
    fetcher: async (request) => {
      requests.push(request.url);
      return Response.json(request.url.includes("oauth-authorization-server")
        ? { issuer: "https://auth.shop.example", token_endpoint: "https://auth.shop.example/token", revocation_endpoint: "https://auth.shop.example/revoke", poppy_domains: ["shop.example", "other.example"] }
        : { protocol_version: version, organization: { name: "Shop", domain: new URL(request.url).hostname }, auth: { issuer: "https://auth.shop.example" }, agent: { protocols: [{ type: "poppy", endpoint: conversations }] } });
    },
    showCard: async (card) => { cards.push(card); }, notifyModel: async () => {}, schedule: async () => {}, hasJob: () => false,
    pushDirect: () => {}, userContext: () => ({ user_available: true }), sleep: async () => {}, now: () => Date.now()
  };
  return { sql, host, client: new PoppyClient(host), cards, requests, change: (v: string, endpoint = conversations) => { version = v; conversations = endpoint; sql.exec("UPDATE poppy_domains SET expires_at = 0"); } };
}

describe("upgrade state and pending-work compatibility", () => {
  it("reruns additive migration and restarts without changing an issuer's User ID or sealed data", async () => {
    const f = fixture();
    const company = await f.client.company("shop.example");
    const userId = f.client.userId(company.issuer);
    const secret = await f.client.sealer.seal("account-token", `account|${company.issuer}|default`);
    f.client.rememberCompany("operation", "op1", company);
    migrate(f.sql);
    const restarted = new PoppyClient(f.host);
    expect(restarted.userId(company.issuer)).toBe(userId);
    expect(await restarted.sealer.open(secret, `account|${company.issuer}|default`)).toBe("account-token");
    expect((await restarted.resumeCompany(company.issuer, "operation", "op1")).protocolVersion).toBe("0.1");
  });

  it.each(["version", "interface"])("holds pending approvals when the %s changes, without replaying an action", async (change) => {
    const f = fixture();
    const original = await f.client.company("shop.example");
    f.client.rememberCompany("operation", "op1", original);
    f.change(change === "version" ? "0.2" : "0.1", change === "interface" ? "https://shop.example/new-conversations" : undefined);
    await expect(f.client.resumeCompany(original.issuer, "operation", "op1")).rejects.toMatchObject({ code: "company_changed" });
    expect(f.requests.every((url) => url.includes(".well-known/"))).toBe(true);
    expect(f.cards.at(-1)).toMatchObject({ kind: "notice", domain: original.domain });
  });

  it("refuses ambiguous legacy tasks instead of picking the newest domain for an issuer", async () => {
    const f = fixture();
    const original = await f.client.company("shop.example");
    await f.client.company("other.example");
    await expect(f.client.resumeCompany(original.issuer, "signin", "old")).rejects.toMatchObject({ code: "company_changed" });
  });

  it("revalidates an old cache entry without changing exact issuer identity", async () => {
    const f = fixture();
    const original = await f.client.company("shop.example");
    const legacy = { ...original } as Company & { specificationRevision?: string };
    delete legacy.specificationRevision;
    f.sql.exec("UPDATE poppy_domains SET company = ?", JSON.stringify(legacy));
    f.change("0.2");
    const current = await f.client.company("shop.example");
    expect(current.protocolVersion).toBe("0.2");
    expect(current.issuer).toBe(original.issuer);
    expect(f.client.userId(current.issuer)).toBe(f.client.userId(original.issuer));
  });
});
