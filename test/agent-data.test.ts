import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { AgentData } from "../src/agent-data";
import type { StorageProbe } from "./worker";
import { agent, cards, company, fetchWorker, ORIGIN, requests, sessionCookie, signInDirect, tool, until } from "./agent-helpers";

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
      data.begin("request-a");
      data.join("request-b");
      expect(data.completed("request-a")).toBe(false);
      expect(data.completed("request-b")).toBe(false);
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
      expect(data.completed("request-a")).toBe(true);
      expect(data.completed("request-b")).toBe(true);
      expect(data.completed("unrelated")).toBe(false);
      expect([...storage.kv.list()]).toEqual([]);
      expect(storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'private_records'").toArray()).toEqual([]);
      const identity = { provider: "google" as const, sub: "owner", email: null, domain: null, sessionId: crypto.randomUUID(), sessionExpiresAt: Date.now() + 10000, sessionCreatedAt: 1 };
      expect(new AgentData(storage).admits(identity)).toBe(false);
      data.begin("new-attempt");
      data.cancel();
      for (const receipt of ["committed", "request-a", "request-b", "new-attempt"]) expect(data.completed(receipt)).toBe(false);
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

  it("confirms one completed erasure to every concurrent deletion caller", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    await a.stub.poppyFault({ method: "POST", url: c.hosts.revocationEndpoint, mode: "pause" });
    const first = fetchWorker(request(a.cookie, "DELETE"));
    await until(async () => await a.stub.poppyHeldCount() === 1);
    const second = fetchWorker(request(a.cookie, "DELETE"));
    await until(async () => JSON.parse(await a.stub.poppySql("SELECT json_array_length(request_receipts) AS n FROM agent_data_state")).some((row: { n: number }) => row.n === 2));
    await a.stub.poppyReleaseHeld();
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.status)).toEqual([204, 204]);
    for (const response of responses) expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await c.stub.state()).accountTokens).toBe(0);
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

  it.each(["used", "sent"] as const)("retires an abandoned %s sign-in without repeating its token grant", async status => {
    const a = await agent();
    const c = await company(status === "sent" ? { signIn: { direct: null, device: null, mediated: ["orders:read"] } } : {});
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "Check an order" });
    // The isolate died before completing the request; no live invocation or saved token answer exists.
    await a.stub.poppySql("UPDATE poppy_signins SET status = ?, expires_at = 1", status);
    const grantsBefore = (await requests(c)).filter(item => item.url === c.hosts.tokenEndpoint).length;
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(204);
    expect((await requests(c)).filter(item => item.url === c.hosts.tokenEndpoint)).toHaveLength(grantsBefore);
    expect((await c.stub.state()).accountTokens).toBe(0);
  });

  it("retains a live mediated sign-in until its issued token can be revoked", async () => {
    const a = await agent();
    const c = await company({ signIn: { direct: null, device: null, mediated: ["orders:read"] } });
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "Check an order" });
    const card = (await cards(a)).find(item => item.kind === "signin_credentials")!;
    await a.stub.poppyFault({ method: "POST", url: c.hosts.tokenEndpoint, grant: "https://personalagentprotocol.org/grant/mediated-sign-in", mode: "pause" });
    const signingIn = a.stub.poppyFrame({ type: "poppy.credentials", signInId: card.signInId, values: { email: "ada@example.com", password: "correct horse" } });
    await until(async () => await a.stub.poppyHeldCount() === 1);
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(409);
    expect(JSON.parse(await a.stub.poppySql("SELECT status FROM poppy_signins"))).toContainEqual({ status: "sent" });
    await a.stub.poppyReleaseHeld();
    await signingIn;
    expect((await c.stub.state()).accountTokens).toBeGreaterThan(0);
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(204);
    expect((await c.stub.state()).accountTokens).toBe(0);
  });

  it("retains a sealed exchanged token answer when recovery cannot bind it", async () => {
    const a = await agent();
    const c = await company();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "Check an order" });
    // A kept answer must survive even if its discovery context cannot currently be revalidated.
    await a.stub.poppySql("UPDATE poppy_signins SET status = 'exchanged', secret = 'SEALED_ISSUED_TOKEN_ANSWER'");
    await a.stub.poppySql("DELETE FROM poppy_task_contexts WHERE kind = 'signin'");
    await a.stub.poppySql("DELETE FROM poppy_domains");
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(409);
    expect(JSON.parse(await a.stub.poppySql("SELECT secret, status FROM poppy_signins"))).toContainEqual({ secret: "SEALED_ISSUED_TOKEN_ANSWER", status: "exchanged" });
  });

  it("revokes Company refresh tokens before erasing a stored sign-in and its bound credentials", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    // The token is bound, but the isolate stopped before finishing the sign-in's card/notification.
    await a.stub.poppySql("UPDATE poppy_signins SET status = 'stored'");
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
