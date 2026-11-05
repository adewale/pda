import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { AgentData } from "../src/agent-data";
import type { StorageProbe } from "./worker";
import { agent, company, fetchWorker, ORIGIN, sessionCookie, signInDirect, tool } from "./agent-helpers";

const request = (cookie: string, method = "GET", origin = ORIGIN) => new Request(`${ORIGIN}/api/agent-data`, {
  method, headers: { Cookie: cookie, Origin: origin, "X-PDA-Delete": "delete-my-agent" }
});

describe("personal data controls", () => {
  it("commits erasure and the old-login cutoff together, or retains both records and retry state", async () => {
    const probes = (env as unknown as { STORAGE_PROBE: DurableObjectNamespace<StorageProbe> }).STORAGE_PROBE;
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
      const storage = state.storage;
      const data = new AgentData(storage);
      storage.sql.exec("CREATE TABLE private_records (text TEXT)");
      storage.sql.exec("INSERT INTO private_records VALUES ('KEEP_UNTIL_COMMIT')");
      storage.kv.put("private-metadata", "ALSO_PRIVATE");
      data.begin();
      const failingSql = new Proxy(storage.sql, { get(target, key) {
        if (key === "exec") return (query: string, ...bindings: SqlStorageValue[]) => {
          if (query.startsWith("UPDATE agent_data_state SET deleting = 0")) throw new Error("cutoff write interrupted");
          return target.exec(query, ...bindings);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const failingStorage = new Proxy(storage, { get(target, key) {
        if (key === "sql") return failingSql;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      await expect(new AgentData(failingStorage).erase("failed")).rejects.toThrow("cutoff write interrupted");
      expect(storage.sql.exec("SELECT text FROM private_records").one().text).toBe("KEEP_UNTIL_COMMIT");
      expect(storage.kv.get("private-metadata")).toBe("ALSO_PRIVATE");
      expect(data.deleting).toBe(true);
      expect(data.completed("failed")).toBe(false);
      await data.erase("committed");
      expect(data.completed("committed")).toBe(true);
      expect([...storage.kv.list()]).toEqual([]);
      expect(storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'private_records'").toArray()).toEqual([]);
      const identity = { provider: "google" as const, sub: "owner", email: null, domain: null, sessionId: crypto.randomUUID(), sessionExpiresAt: Date.now() + 10000, sessionCreatedAt: 1 };
      expect(new AgentData(storage).admits(identity)).toBe(false);
    });
  });
  it("exposes only public build provenance without requiring a personal session", async () => {
    const response = await fetchWorker(new Request(`${ORIGIN}/api/build-info`));
    expect(response.status).toBe(200);
    const build = await response.json() as Record<string, unknown>;
    expect(Object.keys(build).sort()).toEqual(["commit", "dirty", "protocolRevision", "protocolVersions", "workerVersion"]);
    expect(build.protocolRevision).toBe("2026-11-03");
    expect(build.protocolVersions).toEqual(["0.3"]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("exports the caller's records and chunked photos without stored credentials or another person's records", async () => {
    const a = await agent();
    const b = await agent();
    await a.stub.poppySql("INSERT INTO memories (text, source, created_at) VALUES ('MY_PRIVATE_NOTE', 'user', 1)");
    await b.stub.poppySql("INSERT INTO memories (text, source, created_at) VALUES ('SOMEONE_ELSES_NOTE', 'user', 1)");
    await a.stub.poppySql("INSERT INTO model_keys (slot, provider, sealed, status, source, added_at, generation) VALUES (1, 'anthropic', 'SEALED_CREDENTIAL', 'valid', 'pasted', 1, 'generation')");
    await tool(a, "poppy_status", {}); // Initialize the lazily owned Company store.
    await a.stub.poppySql("INSERT INTO poppy_accounts (issuer, account, token, scope, expires_at, updated_at) VALUES ('https://auth.example', 'account', 'SEALED_REFRESH_CREDENTIAL', '', NULL, 1)");
    const bytes = new Uint8Array(2 * 1024 * 1024);
    bytes.set([0xff, 0xd8, 0xff]);
    await a.stub.attach(a.identity, "photo.jpg", bytes.buffer, null);
    const response = await fetchWorker(request(a.cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toContain("attachment;");
    const text = await response.text();
    const data = JSON.parse(text);
    expect(data.format).toBe("pda-personal-data");
    expect(text).toContain("MY_PRIVATE_NOTE");
    expect(text).not.toContain("SOMEONE_ELSES_NOTE");
    expect(text).not.toContain("SEALED_CREDENTIAL");
    expect(text).not.toContain("SEALED_REFRESH_CREDENTIAL");
    expect(data.tables.poppy_accounts[0].token).toEqual({ omitted: "credential" });
    expect(data.tables.model_keys).toBeUndefined();
    expect(data.tables.attachment_chunks).toHaveLength(2);
    expect(data.tables.attachment_chunks[0].bytes).toMatchObject({ encoding: "base64" });
    expect((await fetchWorker(request(""))).status).toBe(401);
  });

  it("erases local state and revokes every pre-deletion cookie while allowing a fresh sign-in", async () => {
    const a = await agent();
    const sibling = await sessionCookie(a.identity);
    await a.stub.poppySql("INSERT INTO memories (text, source, created_at) VALUES ('ERASE_ME', 'user', 1)");
    const response = await fetchWorker(request(a.cookie, "DELETE"));
    expect(response.status).toBe(204);
    expect(response.headers.get("Clear-Site-Data")).toContain('"cache"');
    for (const cookie of [a.cookie, sibling]) {
      expect((await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } }))).status).toBe(401);
    }
    const fresh = await sessionCookie(a.identity);
    expect((await fetchWorker(request(fresh))).status).toBe(200);
    expect(await (await fetchWorker(request(fresh))).text()).not.toContain("ERASE_ME");
  });

  it("requires same-origin confirmation before any destructive work", async () => {
    const a = await agent();
    expect((await fetchWorker(request(a.cookie, "DELETE", "https://other.example"))).status).toBe(403);
    expect((await fetchWorker(new Request(`${ORIGIN}/api/agent-data`, { method: "DELETE", headers: { Cookie: a.cookie, Origin: ORIGIN } }))).status).toBe(403);
    expect((await fetchWorker(request(a.cookie))).status).toBe(200);
  });

  it("retains data while a pending Company sign-in could still issue credentials", async () => {
    const a = await agent();
    const c = await company();
    const started = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "Check an order" });
    expect(started.isError).toBe(false);
    const response = await fetchWorker(request(a.cookie, "DELETE"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("sign-in or action") });
    expect((await fetchWorker(request(a.cookie))).status).toBe(200);
  });

  it("revokes Company refresh tokens before erasing their local credentials", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    const before = await c.stub.state();
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(204);
    const after = await c.stub.state();
    expect(before.accountTokens).toBeGreaterThan(0);
    expect(after.accountTokens).toBe(0);
    expect(after.revocationHints).toContain("refresh_token");
    const fresh = await sessionCookie(a.identity);
    const data = await (await fetchWorker(request(fresh))).json() as { tables: Record<string, unknown[]> };
    expect(data.tables.poppy_accounts ?? []).toEqual([]);
  });

  it("retains local records and the revocation credential if a Company refuses, then completes on retry", async () => {
    const a = await agent();
    const c = await company({ refuseRevocations: 1 });
    await signInDirect(a, c);
    await a.stub.poppySql("INSERT INTO memories (text, source, created_at) VALUES ('KEEP_UNTIL_REVOKED', 'user', 1)");
    const first = await fetchWorker(request(a.cookie, "DELETE"));
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ companies: [c.domain] });
    expect((await c.stub.state()).accountTokens).toBeGreaterThan(0);
    expect(await a.stub.poppySql("SELECT text FROM memories")).toContain("KEEP_UNTIL_REVOKED");
    expect(JSON.parse(await a.stub.poppySql("SELECT token FROM poppy_signouts WHERE token IS NOT NULL"))).toHaveLength(1);
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(204);
    expect((await c.stub.state()).accountTokens).toBe(0);
  });
});
