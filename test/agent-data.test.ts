import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { AgentData } from "../src/agent-data";
import { unclassifiedStorage } from "../src/agent-data-export";
import { unrevokedAccess } from "../src/poppy/signout";
import type { StorageProbe } from "./worker";
import { agent, cards, chat, company, connect, fetchWorker, ORIGIN, person, requests, sessionCookie, signInDirect, tool, until } from "./agent-helpers";

const request = (cookie: string, method = "GET", origin = ORIGIN, body?: string) => new Request(`${ORIGIN}/api/agent-data`, {
  method, headers: { Cookie: cookie, Origin: origin, "X-PDA-Delete": "delete-my-agent" }, ...(body === undefined ? {} : { body })
});
const abandon = (cookie: string, ...ids: string[]) => fetchWorker(request(cookie, "DELETE", ORIGIN, JSON.stringify({ abandonRevocations: ids })));
type Unrevoked = { id: string; domain: string; code: string; liveUntil: number | null };
const unrevoked = async (response: Response) => (await response.json() as { unrevoked: Unrevoked[] }).unrevoked;
const agentStillAnswers = async (cookie: string) => (await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } }))).status === 200;

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
    expect(Object.keys(build).sort()).toEqual(["commit", "dirty", "protocolRevision", "protocolRevisions", "protocolVersions", "workerVersion"]);
    // The newest version's revision, and each version's.
    expect(build.protocolRevision).toBe("2026-11-11");
    expect(build.protocolRevisions).toEqual({ "0.4": "2026-11-11" });
    expect(build.protocolVersions).toEqual(["0.4"]);
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

  it("returns the saved Company selection only to its owner, and a reset chat starts empty", async () => {
    const identity = person();
    const a = { ...(await agent(identity)), ...(await connect(identity)) };
    const saved = async () => (await (await fetchWorker(new Request(`${ORIGIN}/api/task-companies`, { headers: { Cookie: a.cookie } }))).json() as { companies: string[] }).companies;
    expect(await saved()).toEqual([]);
    expect((await fetchWorker(new Request(`${ORIGIN}/api/task-companies`))).status).toBe(401);
    await chat(a.socket, a.client, "hello", undefined, { companies: ["shop.example"], uploads: [] });
    expect(await saved()).toEqual(["shop.example"]);
    const other = await agent();
    expect(await (await fetchWorker(new Request(`${ORIGIN}/api/task-companies`, { headers: { Cookie: other.cookie } }))).json()).toEqual({ companies: [] });
    a.socket.send(JSON.stringify({ type: "reset", id: crypto.randomUUID() }));
    await until(async () => (await saved()).length === 0);
  });

  it("classifies every stored table and column, so a new one can't reach an export by default", async () => {
    const identity = person();
    const a = { ...(await agent(identity)), ...(await connect(identity)) };
    await chat(a.socket, a.client, "hello");
    await tool(a, "poppy_status", {});
    const unclassified = await runInDurableObject(a.stub, async (_, state) => unclassifiedStorage(state.storage.sql));
    expect(unclassified.filter(name => !name.startsWith("test_budget_scope"))).toEqual([]);
    // Every exported table is read by rowid, dependencies' tables included.
    const exported = JSON.parse(await (await fetchWorker(request(a.cookie))).text());
    expect(exported.tables.pi_entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(exported.tables)).toContain("hello");
  });

  it("withholds push addresses, queued jobs and one-time sign-in values, and an unclassified column", async () => {
    const a = await agent();
    const c = await company();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "Check an order" });
    const link = (await cards(a)).find(item => item.kind === "signin_link") as unknown as { url: string };
    await a.stub.poppySql("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES ('https://push.example/DEVICE_ADDRESS', 'DEVICE_KEY', 'DEVICE_AUTH', 1)");
    await a.stub.poppySql("ALTER TABLE memories ADD COLUMN future_secret TEXT");
    await a.stub.poppySql("INSERT INTO memories (text, source, created_at, future_secret) VALUES ('note', 'user', 1, 'FUTURE_SECRET')");
    const text = await (await fetchWorker(request(a.cookie))).text();
    const data = JSON.parse(text);
    for (const secret of ["DEVICE_ADDRESS", "DEVICE_KEY", "DEVICE_AUTH", "FUTURE_SECRET", link.url, new URL(link.url).searchParams.get("state")!]) expect(text).not.toContain(secret);
    expect(data.tables.push_subscriptions[0].endpoint).toEqual({ omitted: "credential" });
    expect(data.tables.cf_agents_jobs).toBeUndefined();
    expect(data.withheldUnclassified).toContain("memories.future_secret");
    const card = data.tables.poppy_cards.map((row: { card: string }) => JSON.parse(row.card)).find((item: { kind: string }) => item.kind === "signin_link");
    expect(card.url).toEqual({ omitted: "credential" });
    expect(card.reason).toBe("Check an order");
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
    const refused = await fetchWorker(request(a.cookie, "DELETE"));
    expect(refused.status).toBe(409);
    expect(JSON.parse(await a.stub.poppySql("SELECT secret, status FROM poppy_signins"))).toContainEqual({ secret: "SEALED_ISSUED_TOKEN_ANSWER", status: "exchanged" });
    // Nothing will ever finish this sign-in, so it can't be what keeps a person's data here.
    const [held] = await unrevoked(refused);
    expect(held).toMatchObject({ code: "sign_in_unfinished" });
    expect((await abandon(a.cookie, held!.id)).status).toBe(204);
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
    expect(await unrevoked(first)).toEqual([expect.objectContaining({ domain: c.domain, code: "invalid_client" })]);
    expect((await c.stub.state()).accountTokens).toBeGreaterThan(0);
    expect(await a.stub.poppySql("SELECT text FROM memories")).toContain("KEEP_UNTIL_REVOKED");
    expect(JSON.parse(await a.stub.poppySql("SELECT token FROM poppy_signouts WHERE token IS NOT NULL"))).toHaveLength(1);
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(204);
    expect((await c.stub.state()).accountTokens).toBe(0);
  });

  it("erases everything once the person abandons a credential a Company will never revoke", async () => {
    const a = await agent();
    const c = await company({ refuseRevocations: 1000 });
    await signInDirect(a, c);
    await a.stub.poppySql("INSERT INTO memories (text, source, created_at) VALUES ('ERASE_ME', 'user', 1)");
    const refused = await fetchWorker(request(a.cookie, "DELETE"));
    expect(refused.status).toBe(409);
    const items = await unrevoked(refused);
    expect(items).toHaveLength(1);
    expect(await a.stub.poppySql("SELECT text FROM memories")).toContain("ERASE_ME");
    expect(await agentStillAnswers(a.cookie)).toBe(true);
    const attempts = (await c.stub.state()).revocationHints.length;
    expect((await abandon(a.cookie, items[0]!.id)).status).toBe(204);
    // Revocation is always tried first: a Company that recovered needs no abandoning.
    expect((await c.stub.state()).revocationHints.length).toBeGreaterThan(attempts);
    expect((await c.stub.state()).accountTokens).toBeGreaterThan(0);
    const fresh = await sessionCookie(a.identity);
    const text = await (await fetchWorker(request(fresh))).text();
    expect(text).not.toContain("ERASE_ME");
    expect(JSON.parse(text).tables.poppy_signouts ?? []).toEqual([]);
  });

  it("leaves open pages connected when deletion stops short, so a kept agent still works", async () => {
    const identity = person();
    const a = { ...(await agent(identity)), ...(await connect(identity)) };
    const c = await company({ refuseRevocations: 1000 });
    await signInDirect(a, c);
    let closed = false;
    a.socket.addEventListener("close", () => { closed = true; });
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(409);
    await chat(a.socket, a.client, "still here?");
    expect(closed).toBe(false);
  });

  it("says so when a resumed deletion stops short, so it can't end silently", async () => {
    const a = await agent();
    const c = await company({ refuseRevocations: 1000 });
    await signInDirect(a, c);
    await a.stub.poppySql("INSERT INTO memories (text, source, created_at) VALUES ('KEEP', 'user', 1)");
    await runInDurableObject(a.stub, async instance => {
      instance.data.begin("interrupted");
      await instance.onJob({ job: { fn: "agent-delete", payload: { receipt: "interrupted" } } } as unknown as Parameters<typeof instance.onJob>[0]);
    });
    expect((await cards(a)).find(card => card.id === "agent-delete-interrupted")).toMatchObject({ open: true, text: expect.stringContaining(c.hosts.domain.split(".")[0]!) });
    expect(await a.stub.poppySql("SELECT text FROM memories")).toContain("KEEP");
    expect(JSON.parse(await a.stub.poppySql("SELECT deleting FROM agent_data_state"))).toEqual([{ deleting: 0 }]);
  });

  it("holds a waiver to the credentials it names", async () => {
    const a = await agent();
    const c = await company({ refuseRevocations: 1000 });
    await signInDirect(a, c);
    await a.stub.poppySql("INSERT INTO memories (text, source, created_at) VALUES ('KEEP', 'user', 1)");
    const [item] = await unrevoked(await fetchWorker(request(a.cookie, "DELETE")));
    const other = await abandon(a.cookie, "so_some_other_credential");
    expect(other.status).toBe(409);
    expect(await unrevoked(other)).toEqual([expect.objectContaining({ id: item!.id })]);
    expect(await a.stub.poppySql("SELECT text FROM memories")).toContain("KEEP");
  });

  it("revokes what it can when another Company refuses, and asks only about the refusal", async () => {
    const a = await agent();
    const refusing = await company({ refuseRevocations: 1000 });
    const willing = await company();
    await signInDirect(a, refusing);
    await signInDirect(a, willing);
    const items = await unrevoked(await fetchWorker(request(a.cookie, "DELETE")));
    expect(items.map(item => item.domain)).toEqual([refusing.domain]);
    expect((await willing.stub.state()).accountTokens).toBe(0);
  });

  it("erases while an export is unread or cancelled: no read holds a table open", async () => {
    const a = await agent();
    await a.stub.poppySql("INSERT INTO memories (text, source, created_at) VALUES ('ERASE_ME', 'user', 1)");
    const reader = (await fetchWorker(request(a.cookie))).body!.getReader();
    await reader.read();
    const cancelled = (await fetchWorker(request(a.cookie))).body!.getReader();
    await cancelled.read();
    await cancelled.cancel();
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(204);
  });

  it("exports every row of a table longer than one read", async () => {
    const a = await agent();
    for (let index = 0; index < 250; index++) await a.stub.poppySql("INSERT INTO memories (text, source, created_at) VALUES (?, 'user', 1)", `note ${index}`);
    const data = await (await fetchWorker(request(a.cookie))).json() as { tables: { memories: { text: string }[] } };
    expect(data.tables.memories.map(row => row.text)).toEqual(Array.from({ length: 250 }, (_, index) => `note ${index}`));
  });

  it.each(["exchanging", "pending"] as const)("doesn't wait for a %s sign-in that can never finish", async status => {
    const a = await agent();
    const c = await company();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "Check an order" });
    await a.stub.poppySql("UPDATE poppy_signins SET status = ?, expires_at = 1", status);
    expect((await fetchWorker(request(a.cookie, "DELETE"))).status).toBe(204);
  });

  it("ignores the page's frames while deleting, since they can start new Company work", async () => {
    const a = await agent();
    const c = await company();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "Check an order" });
    const card = (await cards(a)).find(item => item.open)!;
    await runInDurableObject(a.stub, async instance => { instance.data.begin("deleting"); });
    await a.stub.poppyFrame({ type: "poppy.card.dismiss", cardId: card.id });
    await runInDurableObject(a.stub, async instance => { instance.data.cancel(); });
    expect((await cards(a)).find(item => item.id === card.id)).toMatchObject({ open: true });
    await a.stub.poppyFrame({ type: "poppy.card.dismiss", cardId: card.id });
  });

  it("stops the website browser while deleting: its cookie-bearing requests and saved forms stay here", async () => {
    const c = await company();
    const a = await agent();
    // The browser is signed in only with poppy:browser-sign-in (6).
    await signInDirect(a, c, ["orders:read", "orders:write", "poppy:browser-sign-in"]);
    const browse = (args: Record<string, unknown>) => a.stub.poppyTool("poppy_browse", { domain: c.domain, ...args });
    await browse({ action: "open", url: "/account/address" });
    const saved = JSON.parse((await browse({ action: "submit", selector: "#address" })).text).proposed;
    const before = (await requests(c)).length;
    await runInDurableObject(a.stub, async instance => { instance.data.begin("deleting"); });
    const refused = await browse({ action: "open", url: "/orders" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("deletion");
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: saved, decision: "approve" });
    expect((await c.stub.state()).formPosts).toEqual([]);
    expect((await requests(c)).length).toBe(before);
    // The same requests go out once deletion stops, so only the deletion was holding them back.
    await runInDurableObject(a.stub, async instance => { instance.data.cancel(); });
    expect((await browse({ action: "open", url: "/orders" })).text).toContain("Signed in as acct_ada");
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: saved, decision: "approve" });
    expect((await c.stub.state()).formPosts).toHaveLength(1);
  });

  it("lists an account sign-out hasn't reached, so it can't be erased unasked", async () => {
    const a = await agent();
    await tool(a, "poppy_status", {});
    await a.stub.poppySql("INSERT INTO poppy_accounts (issuer, account, token, scope, expires_at, updated_at) VALUES ('https://auth.gone.example', 'default', 'SEALED', '', NULL, 1)");
    const listed = await runInDurableObject(a.stub, async instance => unrevokedAccess(instance.poppy.client));
    expect(listed).toEqual([expect.objectContaining({ domain: "auth.gone.example", code: "not_signed_out", liveUntil: null })]);
  });

  it("does not lock the agent when a Company's records are gone, and can still erase", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    // Nothing is known of the issuer any more, so there is no endpoint to revoke at.
    await a.stub.poppySql("DELETE FROM poppy_domains");
    await a.stub.poppySql("DELETE FROM poppy_task_contexts");
    const refused = await fetchWorker(request(a.cookie, "DELETE"));
    expect(refused.status).toBe(409);
    const items = await unrevoked(refused);
    expect(items).toHaveLength(1);
    expect(await agentStillAnswers(a.cookie)).toBe(true);
    expect(JSON.parse(await a.stub.poppySql("SELECT deleting FROM agent_data_state"))).toEqual([{ deleting: 0 }]);
    expect((await abandon(a.cookie, items[0]!.id)).status).toBe(204);
  });

  it("refuses a malformed waiver before any destructive work", async () => {
    const a = await agent();
    for (const body of ["not json", '{"abandonRevocations":"so_x"}', "{}", JSON.stringify({ abandonRevocations: Array(65).fill("so_x") }), JSON.stringify({ abandonRevocations: ["x".repeat(9000)] })]) {
      expect((await fetchWorker(request(a.cookie, "DELETE", ORIGIN, body))).status).toBe(400);
    }
    expect(await agentStillAnswers(a.cookie)).toBe(true);
  });

  it("keeps a deletion's waivers through a retry, and drops them when it stops", async () => {
    const probes = (env as unknown as { STORAGE_PROBE: DurableObjectNamespace<StorageProbe> }).STORAGE_PROBE;
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_, state) => {
      const data = new AgentData(state.storage);
      expect([...data.waivers]).toEqual([]);
      data.begin("first", ["so_a"]);
      data.begin("resumed", ["so_b"]);
      expect([...new AgentData(state.storage).waivers]).toEqual(["so_a"]);
      data.cancel();
      expect([...data.waivers]).toEqual([]);
    });
  });
});
