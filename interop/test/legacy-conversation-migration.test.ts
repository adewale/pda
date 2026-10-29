import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import { memorySql } from "../impls/pda-agent/sqlite";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client";
import { migrate } from "../../src/poppy/store";
import { readConversation, updateAvailability } from "../../src/poppy/conversations";
import { buildActivity, openAtCompanies } from "../../src/poppy/activity";
import { PROTOCOL_REVISION } from "../../src/poppy/protocol-version";
import type { Company } from "../../src/poppy/discovery";

const ISSUER = "https://auth.shop.example";

async function fixture() {
  const sql = memorySql();
  migrate(sql);
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const signing = { ...await exportJWK(privateKey), kid: "conversation-migration-test", alg: "ES256", use: "sig" };
  const requests: { url: string; method: string }[] = [];
  const host: PoppyHost = {
    env: {
      PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Conversation migration test", POPPY_LOGO_URI: "https://agent.example/logo.svg",
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"), POPPY_SIGNING_JWKS: JSON.stringify([signing]),
      CompanyLimiter: { getByName: () => ({ delay: async () => 0, observe: async () => {}, blockUntil: async () => {} }) }
    } as unknown as Env,
    sql,
    fetcher: async request => {
      requests.push({ url: request.url, method: request.method });
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/poppy.json") return Response.json({ protocol_version: "0.3", organization: { name: "Shop", domain: "shop.example" },
        auth: { scopes: { read: "Read orders" } }, agent: { protocols: [{ type: "poppy", endpoint: "https://shop.example/conversations" }] } });
      if (url.pathname === "/.well-known/oauth-protected-resource") return Response.json({ resource: "https://shop.example", authorization_servers: [ISSUER] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: ISSUER, token_endpoint: `${ISSUER}/token`, revocation_endpoint: `${ISSUER}/revoke`,
        grant_types_supported: ["refresh_token"], protected_resources: ["https://shop.example"] });
      if (url.pathname === "/conversations/remote_current/messages" && request.method === "POST") return Response.json({ conversation_id: "remote_current", status: "idle", responder: "agent" });
      throw new Error(`Unexpected protocol request: ${request.method} ${request.url}`);
    },
    showCard: async () => {}, notifyModel: async () => {}, schedule: async () => {}, hasJob: () => false,
    pushDirect: () => {}, userContext: () => ({ user_available: true }), sleep: async () => {}, now: Date.now
  };
  const client = new PoppyClient(host);
  return { sql, host, client, requests, company: await client.company("shop.example") };
}

function addConversation(f: Awaited<ReturnType<typeof fixture>>, id: string, company: Company, direct = false, remember = true) {
  if (remember) f.client.rememberCompany("conversation", id, company);
  f.sql.exec(`INSERT INTO poppy_conversations (id, issuer, remote_id, label, direct, status, responder, cursor, context, last_event_at, created_at)
    VALUES (?, ?, ?, 'main', ?, 'idle', 'agent', 'kept-cursor', '{"user_available":false}', ?, ?)`, id, ISSUER, `remote_${id.slice(4)}`, direct ? 1 : 0, Date.now(), Date.now());
}

function evidence(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    inbox: f.sql.exec("SELECT * FROM poppy_inbox").toArray(),
    events: f.sql.exec("SELECT * FROM poppy_events").toArray(),
    messages: f.sql.exec("SELECT * FROM poppy_messages WHERE id = 'msg_pending'").toArray(),
    contexts: f.sql.exec("SELECT * FROM poppy_task_contexts ORDER BY task_id").toArray()
  };
}

describe("retiring conversations that cannot survive the protocol upgrade", () => {
  it.each(["0.1", "0.2", "older 0.3 revision"])("stops %s conversations locally, preserves evidence, and lets current presence updates continue", async version => {
    const f = await fixture();
    const legacy = { ...f.company, protocolVersion: version === "older 0.3 revision" ? "0.3" : version,
      specificationRevision: version === "older 0.3 revision" ? "2026-10-28" : "2026-10-19" };
    addConversation(f, "cnv_current", f.company);
    addConversation(f, "cnv_legacy", legacy);
    addConversation(f, "cnv_direct", legacy, true);
    f.sql.exec("INSERT INTO poppy_inbox (conversation_id, event, created_at) VALUES ('cnv_legacy', ?, 123)", JSON.stringify({ id: "event_kept", type: "message", message: { id: "msg_company", author: { type: "agent" }, text: "Earlier Company reply" } }));
    f.sql.exec("INSERT INTO poppy_events VALUES ('cnv_legacy', 'event_kept')");
    f.sql.exec("INSERT INTO poppy_messages VALUES ('msg_pending', ?, 'cnv_legacy', ?, 123)", ISSUER, JSON.stringify({ message: { id: "msg_pending", author: { type: "agent" }, text: "Message whose earlier delivery is uncertain" } }));
    const invitation = { id: "direct-invite-cnv_legacy", kind: "direct_invite", company: "Shop", open: true, conversationId: "cnv_legacy", reason: "Talk directly" };
    f.sql.exec("INSERT INTO poppy_cards VALUES (?, ?, 1, 123)", invitation.id, JSON.stringify(invitation));
    const kept = evidence(f);
    const before = f.requests.length;
    migrate(f.sql);
    expect(f.requests).toHaveLength(before);
    for (const id of ["cnv_legacy", "cnv_direct"]) {
      expect(f.sql.exec("SELECT status, cursor, context FROM poppy_conversations WHERE id = ?", id).one())
        .toEqual({ status: "closed", cursor: "kept-cursor", context: '{"user_available":false}' });
      expect(f.sql.exec("SELECT retired_at FROM poppy_conversations WHERE id = ?", id).one()).toEqual({ retired_at: expect.any(Number) });
      expect(await readConversation(f.client, id, 0)).toBeNull();
      expect(openAtCompanies(f.client).conversations.some(row => row.conversation === id)).toBe(false);
      const activity = buildActivity(f.client).log.find(row => row.id === `conversation-${id}`);
      expect(activity).toMatchObject({ result: "unknown", outcome: expect.stringContaining("stopped locally") });
      const notice = f.sql.exec("SELECT card FROM poppy_cards WHERE id = ?", `conversation-retired-${id}`).one();
      expect(JSON.parse(String(notice.card))).toMatchObject({ kind: "notice", company: "Shop", open: false, text: expect.stringContaining("did not cancel or confirm") });
    }
    expect(evidence(f)).toEqual(kept);
    const oldInvite = f.sql.exec("SELECT card, open FROM poppy_cards WHERE id = ?", invitation.id).one();
    expect(oldInvite.open).toBe(0);
    expect(JSON.parse(String(oldInvite.card))).toMatchObject({ kind: "notice", open: false });
    const beforeRestart = f.sql.exec("SELECT * FROM poppy_cards ORDER BY id").toArray();
    const retired = f.sql.exec("SELECT retired_at FROM poppy_conversations WHERE id = 'cnv_legacy'").one();
    migrate(f.sql);
    migrate(f.sql);
    expect(f.sql.exec("SELECT * FROM poppy_cards ORDER BY id").toArray()).toEqual(beforeRestart);
    expect(f.sql.exec("SELECT retired_at FROM poppy_conversations WHERE id = 'cnv_legacy'").one()).toEqual(retired);
    expect(await readConversation(new PoppyClient(f.host), "cnv_legacy", 0)).toBeNull();
    expect(f.requests).toHaveLength(before);
    await updateAvailability(f.client);
    expect(f.requests.slice(before)).toEqual([{ url: "https://shop.example/conversations/remote_current/messages", method: "POST" }]);
    expect(evidence(f)).toEqual(kept);
  });

  it.each([undefined, PROTOCOL_REVISION])("preserves a current conversation with revision=%s on repeated migrations", async specificationRevision => {
    const f = await fixture();
    const current = { ...f.company, specificationRevision };
    addConversation(f, "cnv_current", current);
    const original = f.sql.exec("SELECT * FROM poppy_conversations WHERE id = 'cnv_current'").one();
    migrate(f.sql);
    migrate(f.sql);
    expect(f.sql.exec("SELECT * FROM poppy_conversations WHERE id = 'cnv_current'").one()).toEqual(original);
    expect(f.sql.exec("SELECT * FROM poppy_cards").toArray()).toEqual([]);
    expect(openAtCompanies(f.client).conversations).toContainEqual(expect.objectContaining({ conversation: "cnv_current", status: "idle" }));
  });

  it("uses a legacy cached Company only when an immutable conversation context is missing", async () => {
    const f = await fixture();
    addConversation(f, "cnv_current", f.company);
    addConversation(f, "cnv_legacy", { ...f.company, protocolVersion: "0.2" }, false, false);
    f.sql.exec("UPDATE poppy_domains SET company = ?", JSON.stringify({ ...f.company, protocolVersion: "0.2" }));
    migrate(f.sql);
    expect(f.sql.exec("SELECT status FROM poppy_conversations WHERE id = 'cnv_legacy'").one()).toEqual({ status: "closed" });
    expect(f.sql.exec("SELECT status FROM poppy_conversations WHERE id = 'cnv_current'").one()).toEqual({ status: "idle" });
  });

  it("resumes interrupted retirement without repeating or resurfacing its explanation", async () => {
    const f = await fixture();
    addConversation(f, "cnv_legacy", { ...f.company, protocolVersion: "0.2" });
    const exec = f.sql.exec.bind(f.sql);
    const writing = vi.spyOn(f.sql, "exec").mockImplementation((query, ...bindings) => {
      if (query.startsWith("UPDATE poppy_conversations SET status = 'closed', retired_at")) throw new Error("migration interrupted before local close");
      return exec(query, ...bindings);
    });
    try { expect(() => migrate(f.sql)).toThrow("migration interrupted before local close"); }
    finally { writing.mockRestore(); }
    expect(f.sql.exec("SELECT status FROM poppy_conversations WHERE id = 'cnv_legacy'").one()).toEqual({ status: "idle" });
    const id = "conversation-retired-cnv_legacy";
    f.sql.exec("UPDATE poppy_cards SET updated_at = 0 WHERE id = ?", id);
    const explanation = f.sql.exec("SELECT * FROM poppy_cards WHERE id = ?", id).one();
    migrate(f.sql);
    migrate(f.sql);
    expect(f.sql.exec("SELECT status FROM poppy_conversations WHERE id = 'cnv_legacy'").one()).toEqual({ status: "closed" });
    expect(f.sql.exec("SELECT * FROM poppy_cards WHERE id = ?", id).one()).toEqual(explanation);
    expect(f.sql.exec("SELECT * FROM poppy_cards").toArray()).toHaveLength(1);
  });

  it("adds nullable retirement metadata to an existing conversation table without retiring supported work", async () => {
    const f = await fixture();
    const sql = memorySql();
    sql.exec(`CREATE TABLE poppy_conversations (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, remote_id TEXT NOT NULL DEFAULT '',
      quarantined INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL, parent TEXT, direct INTEGER NOT NULL, status TEXT NOT NULL,
      responder TEXT NOT NULL, cursor TEXT, context TEXT, last_event_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    sql.exec("CREATE TABLE poppy_task_contexts (kind TEXT NOT NULL, task_id TEXT NOT NULL, issuer TEXT NOT NULL, company TEXT NOT NULL, PRIMARY KEY (kind, issuer, task_id))");
    sql.exec("INSERT INTO poppy_task_contexts VALUES ('conversation', 'cnv_current', ?, ?)", ISSUER, JSON.stringify(f.company));
    sql.exec("INSERT INTO poppy_conversations VALUES ('cnv_current', ?, 'remote_current', 0, 'main', NULL, 0, 'idle', 'agent', 'kept', '{}', 123, 123)", ISSUER);
    migrate(sql);
    migrate(sql);
    expect(sql.exec("SELECT status, cursor, context, retired_at FROM poppy_conversations WHERE id = 'cnv_current'").one())
      .toEqual({ status: "idle", cursor: "kept", context: "{}", retired_at: null });
    expect(sql.exec("PRAGMA table_info(poppy_conversations)").toArray().filter(row => row.name === "retired_at")).toHaveLength(1);
    expect(sql.exec("SELECT * FROM poppy_cards").toArray()).toEqual([]);
  });
});
