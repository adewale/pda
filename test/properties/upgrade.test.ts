import { describe, expect, it } from "vitest";
import { memorySql } from "../../interop/impls/pda-agent/sqlite";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client";
import { migrate } from "../../src/poppy/store";
import type { Company } from "../../src/poppy/discovery";
import type { Card } from "../../src/poppy/wire";

const ISSUER = "https://auth.shop.example";

/**
 * Real SQLite migrations and discovery, with transport fixtures; no token or
 * network needed. Each domain serves a 0.3 poppy.json and protected resource
 * metadata naming one issuer, whose metadata lists both domains (3.2).
 */
function fixture() {
  const sql = memorySql();
  migrate(sql);
  let version = "0.3";
  let conversations = "https://shop.example/conversations";
  let scopes: Record<string, string> = { "orders:read": "See your orders" };
  const cards: Card[] = [];
  const requests: string[] = [];
  const host: PoppyHost = {
    env: { PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Upgrade test", POPPY_LOGO_URI: "https://agent.example/logo.svg", TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64") } as unknown as Env,
    sql,
    fetcher: async (request) => {
      requests.push(request.url);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: ISSUER,
          token_endpoint: `${ISSUER}/token`,
          revocation_endpoint: `${ISSUER}/revoke`,
          grant_types_supported: ["refresh_token"],
          scopes_supported: Object.keys(scopes),
          protected_resources: ["https://shop.example", "https://other.example"]
        });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource") return Response.json({ resource: `https://${url.hostname}`, authorization_servers: [ISSUER] });
      return Response.json({ protocol_version: version, organization: { name: "Shop", domain: url.hostname }, auth: { scopes }, agent: { protocols: [{ type: "poppy", endpoint: conversations }] } });
    },
    showCard: async (card) => { cards.push(card); }, notifyModel: async () => {}, schedule: async () => {}, hasJob: () => false,
    pushDirect: () => {}, userContext: () => ({ user_available: true }), sleep: async () => {}, now: () => Date.now()
  };
  const expire = () => sql.exec("UPDATE poppy_domains SET expires_at = 0");
  return {
    sql, host, client: new PoppyClient(host), cards, requests,
    change: (next: { version?: string; conversations?: string; scopes?: Record<string, string> }) => {
      version = next.version ?? version;
      conversations = next.conversations ?? conversations;
      scopes = next.scopes ?? scopes;
      expire();
    }
  };
}

describe("upgrade state and pending-work compatibility", () => {
  it("reruns additive migration and restarts without changing an issuer's User ID or sealed data", async () => {
    const f = fixture();
    const company = await f.client.company("shop.example");
    const userId = f.client.userId(company.issuer);
    const secret = await f.client.sealer.seal("account-token", `account|${company.issuer}|default`);
    f.client.rememberCompany("approval", "apr_1", company);
    migrate(f.sql);
    const restarted = new PoppyClient(f.host);
    expect(restarted.userId(company.issuer)).toBe(userId);
    expect(await restarted.sealer.open(secret, `account|${company.issuer}|default`)).toBe("account-token");
    expect((await restarted.resumeCompany(company.issuer, "approval", "apr_1")).protocolVersion).toBe("0.3");
  });

  it.each([
    ["its interfaces", { conversations: "https://shop.example/new-conversations" }],
    ["its auth", { scopes: { "orders:read": "See your orders", addresses: "Your addresses" } }]
  ] as const)("holds pending approvals when %s change, without replaying an action", async (_, next) => {
    const f = fixture();
    const original = await f.client.company("shop.example");
    f.client.rememberCompany("approval", "apr_1", original);
    f.change(next);
    await expect(f.client.resumeCompany(original.issuer, "approval", "apr_1")).rejects.toMatchObject({ code: "company_changed" });
    expect(f.requests.every((url) => url.includes(".well-known/"))).toBe(true);
    expect(f.cards.at(-1)).toMatchObject({ kind: "notice", domain: original.domain });
  });

  it("holds a pending approval when its Company moves to a version this agent doesn't speak, without replaying an action", async () => {
    const f = fixture();
    const original = await f.client.company("shop.example");
    f.client.rememberCompany("approval", "apr_1", original);
    f.change({ version: "0.4" });
    await expect(f.client.resumeCompany(original.issuer, "approval", "apr_1")).rejects.toMatchObject({ name: "DiscoveryError" });
    expect(f.requests.every((url) => url.includes(".well-known/"))).toBe(true);
  });

  it("holds a task begun under 0.2, before this agent spoke 0.3 only, without replaying it", async () => {
    const f = fixture();
    const current = await f.client.company("shop.example");
    const legacy = { ...current, protocolVersion: "0.2" } as Company & { specificationRevision?: string };
    delete legacy.specificationRevision;
    f.client.rememberCompany("approval", "apr_old", legacy);
    await expect(f.client.resumeCompany(current.issuer, "approval", "apr_old")).rejects.toMatchObject({ code: "company_changed" });
    expect(f.requests.every((url) => url.includes(".well-known/"))).toBe(true);
    expect(f.cards.at(-1)).toMatchObject({ kind: "notice", domain: current.domain });
  });

  it("refuses ambiguous legacy tasks instead of picking the newest domain for an issuer", async () => {
    const f = fixture();
    const original = await f.client.company("shop.example");
    await f.client.company("other.example");
    expect((await f.client.company("other.example")).issuer).toBe(original.issuer);
    await expect(f.client.resumeCompany(original.issuer, "signin", "old")).rejects.toMatchObject({ code: "company_changed" });
  });

  it("rediscovers an entry an older agent cached, without changing exact issuer identity", async () => {
    const f = fixture();
    const original = await f.client.company("shop.example");
    const legacy = { ...original, protocolVersion: "0.2" } as Company & { specificationRevision?: string };
    delete legacy.specificationRevision;
    // Still fresh, but from a version this agent no longer speaks: never used as it is.
    f.sql.exec("UPDATE poppy_domains SET company = ?", JSON.stringify(legacy));
    const before = f.requests.length;
    const current = await f.client.company("shop.example");
    expect(f.requests.length).toBeGreaterThan(before);
    expect(current.protocolVersion).toBe("0.3");
    expect(current.specificationRevision).toBe(original.specificationRevision);
    expect(current.issuer).toBe(original.issuer);
    expect(f.client.userId(current.issuer)).toBe(f.client.userId(original.issuer));
  });
});
