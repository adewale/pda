import { describe, expect, it } from "vitest";
import { memorySql } from "../impls/pda-agent/sqlite";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client";
import { recoverSignIns } from "../../src/poppy/signin";
import { migrate } from "../../src/poppy/store";
import type { Company } from "../../src/poppy/discovery";
import { PROTOCOL_REVISION } from "../../src/poppy/protocol-version";

const ISSUER = "https://auth.shop.example";

function fixture() {
  const sql = memorySql();
  migrate(sql);
  const requests: string[] = [];
  const host: PoppyHost = {
    env: {
      PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Migration test",
      POPPY_LOGO_URI: "https://agent.example/logo.svg", TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64")
    } as unknown as Env,
    sql,
    fetcher: async request => {
      requests.push(request.url);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return Response.json({
        issuer: ISSUER, token_endpoint: `${ISSUER}/token`, revocation_endpoint: `${ISSUER}/revoke`,
        grant_types_supported: ["refresh_token"], scopes_supported: ["orders:read"], protected_resources: ["https://shop.example"]
      });
      if (url.pathname === "/.well-known/oauth-protected-resource") return Response.json({ resource: "https://shop.example", authorization_servers: [ISSUER] });
      return Response.json({ protocol_version: "0.3", organization: { name: "Shop", domain: "shop.example" }, auth: { scopes: { "orders:read": "See orders" } }, agent: { protocols: [{ type: "poppy", endpoint: "https://shop.example/conversations" }] } });
    },
    showCard: async () => {}, notifyModel: async () => {}, schedule: async () => {}, hasJob: () => false,
    pushDirect: () => {}, userContext: () => ({ user_available: true }), sleep: async () => {}, now: Date.now
  };
  return { sql, host, client: new PoppyClient(host), requests };
}

async function unfinished(f: ReturnType<typeof fixture>, company: Company, id: string, status: string) {
  const secret = await f.client.sealer.seal("kept sign-in answer", `signin|${ISSUER}|${id}`);
  f.client.rememberCompany("signin", id, company);
  f.sql.exec(`INSERT INTO poppy_signins (id, type, issuer, label, account, scopes, secret, expires_at, status, created_at)
    VALUES (?, 'direct', ?, 'old-task', 'default', 'orders:read', ?, ?, ?, ?)`, id, ISSUER, secret, Date.now() - 1_000, status, Date.now() - 10_000);
  return secret;
}

describe("state retained across the 0.3 upgrade", () => {
  it.each(["exchanging", "exchanged", "stored"])("retires an incompatible %s sign-in without blocking new signed-out tasks", async status => {
    const f = fixture();
    const company = await f.client.company("shop.example");
    const legacy = { ...company, protocolVersion: "0.2", specificationRevision: "2026-10-19" };
    const secret = await unfinished(f, legacy, "old-signin", status);
    migrate(f.sql);
    await recoverSignIns(f.client);
    expect(await f.client.token(company, { label: "new-task" })).toBeNull();
    expect(f.sql.exec("SELECT status, secret FROM poppy_signins WHERE id = 'old-signin'").one()).toMatchObject({ status: "failed", secret });
    const card = JSON.parse(String(f.sql.exec("SELECT card FROM poppy_cards WHERE id = 'signin-old-signin'").one().card));
    expect(card).toMatchObject({ kind: "notice", open: false, company: "Shop" });
    expect(card.text).toContain("No credentials were resent");
    expect(JSON.stringify(card)).not.toContain(secret);
    expect(f.requests.every(url => url.includes("/.well-known/"))).toBe(true);
  });

  it("keeps current 0.3 pending and recovery records, their secrets and cards on repeated migrations", async () => {
    const f = fixture();
    const company = await f.client.company("shop.example");
    expect(company.specificationRevision).toBe(PROTOCOL_REVISION);
    for (const status of ["pending", "code", "exchanging", "exchanged", "stored"]) {
      const secret = await unfinished(f, company, status, status);
      const card = JSON.stringify({ id: `signin-${status}`, kind: "signin_link", company: "Shop", open: true });
      f.sql.exec("INSERT INTO poppy_cards (id, card, open, updated_at) VALUES (?, ?, 1, 123)", `signin-${status}`, card);
      migrate(f.sql);
      migrate(f.sql);
      expect(f.sql.exec("SELECT status, secret FROM poppy_signins WHERE id = ?", status).one()).toMatchObject({ status, secret });
      expect(f.sql.exec("SELECT card, open, updated_at FROM poppy_cards WHERE id = ?", `signin-${status}`).one()).toMatchObject({ card, open: 1, updated_at: 123 });
    }
  });

  it("retires legacy sign-ins that predate immutable discovery contexts", async () => {
    const f = fixture();
    const company = await f.client.company("shop.example");
    await unfinished(f, company, "no-context", "exchanging");
    f.sql.exec("DELETE FROM poppy_task_contexts WHERE task_id = 'no-context'");
    migrate(f.sql);
    expect(f.sql.exec("SELECT status FROM poppy_signins WHERE id = 'no-context'").one().status).toBe("failed");
    expect(await f.client.token(company)).toBeNull();
  });

  it("converts retired operation cards into closed notices without resurfacing old history", () => {
    const f = fixture();
    const old = { kind: "operation", company: "Shop", domain: "shop.example", operationId: "op1", revision: 1, state: "proposed", summary: "Buy a jacket" };
    for (const open of [0, 1]) {
      const id = `operation-${open}`;
      f.sql.exec("INSERT INTO poppy_cards (id, card, open, updated_at) VALUES (?, ?, ?, 123)", id, JSON.stringify({ ...old, id, open: !!open }), open);
    }
    const current = JSON.stringify({ id: "approval-current", kind: "approval", open: true, approvalId: "apr_current", status: "pending" });
    f.sql.exec("INSERT INTO poppy_cards (id, card, open, updated_at) VALUES ('approval-current', ?, 1, 123)", current);
    migrate(f.sql);
    for (const open of [0, 1]) {
      const row = f.sql.exec("SELECT card, open, updated_at FROM poppy_cards WHERE id = ?", `operation-${open}`).one();
      expect(JSON.parse(String(row.card))).toMatchObject({ kind: "notice", company: "Shop", domain: "shop.example", open: false });
      expect(String(row.card)).toContain("did not cancel or confirm anything");
      expect(row.open).toBe(0);
      expect(row.updated_at).toEqual(open ? expect.any(Number) : 123);
    }
    const beforeRepeat = f.sql.exec("SELECT * FROM poppy_cards ORDER BY id").toArray();
    migrate(f.sql);
    expect(f.sql.exec("SELECT * FROM poppy_cards ORDER BY id").toArray()).toEqual(beforeRepeat);
    expect(f.sql.exec("SELECT card FROM poppy_cards WHERE id = 'approval-current'").one().card).toBe(current);
  });

  it("adds the optional terms continuation to an existing approvals table once", () => {
    const sql = memorySql();
    sql.exec(`CREATE TABLE poppy_approvals (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, label TEXT NOT NULL,
      summary TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, terms TEXT)`);
    sql.exec("INSERT INTO poppy_approvals VALUES ('apr', ?, 'main', 'summary', '{}', 'pending', NULL, 123, NULL)", ISSUER);
    migrate(sql);
    migrate(sql);
    expect(sql.exec("PRAGMA table_info(poppy_approvals)").toArray().filter(row => row.name === "terms_approval_id")).toHaveLength(1);
    expect(sql.exec("SELECT terms_approval_id FROM poppy_approvals WHERE id = 'apr'").one().terms_approval_id).toBeNull();
  });

  it("adds a local authority generation without changing an existing Session's identity", () => {
    const sql = memorySql();
    sql.exec(`CREATE TABLE poppy_sessions (issuer TEXT NOT NULL, label TEXT NOT NULL, session_id TEXT NOT NULL,
      account TEXT, signed_in INTEGER NOT NULL, scope TEXT NOT NULL, updated_at INTEGER NOT NULL,
      used_account TEXT, PRIMARY KEY (issuer, label))`);
    sql.exec("INSERT INTO poppy_sessions VALUES (?, 'main', 'same-session', 'default', 1, 'orders:read', 123, 'default')", ISSUER);
    migrate(sql);
    expect(sql.exec("SELECT session_id, authority_generation FROM poppy_sessions").one()).toMatchObject({ session_id: "same-session", authority_generation: 0 });
    sql.exec("UPDATE poppy_sessions SET authority_generation = 2");
    migrate(sql);
    expect(sql.exec("SELECT session_id, authority_generation FROM poppy_sessions").one()).toMatchObject({ session_id: "same-session", authority_generation: 2 });
    expect(sql.exec("PRAGMA table_info(poppy_sessions)").toArray().filter(row => row.name === "authority_generation")).toHaveLength(1);
  });
});
