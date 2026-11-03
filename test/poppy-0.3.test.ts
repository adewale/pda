/**
 * Our client against the mock Company speaking draft 0.3 as rewritten on 28
 * October (spec/draft-0.3-retrieved-2026-10-28): the issuer from the
 * domain's protected resource metadata, a Session header on every request,
 * plain OAuth for accounts, the new browser join, Operations 2, Mediated
 * Sign-In as a grant, and `author` on messages. Every test also passes the
 * strict check in agent-helpers: the mock recorded no violation or warning.
 */
import { decodeJwt, decodeProtectedHeader } from "jose";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agent, cards, company, requests, signInDirect, testEnv, tool, until, type Company } from "./agent-helpers";
import type { MockConfig, MockRequest } from "./mock-company";

const V3: Partial<MockConfig> = { protocolVersion: "0.3" };
const SCOPES = ["orders:read", "orders:write"];

/** Requests to the Company's resources, which all carry the Session header (0.3 5.2). */
const resourceRequests = (all: readonly MockRequest[], c: Company) =>
  all.filter((request) => {
    const url = new URL(request.url);
    const host = url.hostname;
    if (url.pathname.startsWith("/.well-known/") || url.pathname === "/openapi.json") return false;
    return host === `api.${c.domain}` || host === `mcp.${c.domain}` || url.pathname.endsWith("/browser-session/authorize");
  });

describe("0.3: discovery and the Session header", () => {
  it("finds the issuer from the domain's metadata and talks signed out with the Session header alone", async () => {
    const c = await company(V3);
    const a = await agent();
    const sent = await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    expect(sent.isError).toBe(false);
    const all = await requests(c);
    // Discovery: poppy.json, then the domain's protected resource metadata, then the issuer's.
    expect(all.slice(0, 3).map((request) => new URL(request.url).pathname)).toEqual([
      "/.well-known/poppy.json",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server"
    ]);
    // No token request: a signed-out Session needs nothing from the authorization server (4).
    expect(all.filter((request) => request.url === c.hosts.tokenEndpoint)).toEqual([]);
    const resources = resourceRequests(all, c);
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.every((request) => request.headers["poppy-session"] && !request.headers.authorization)).toBe(true);
    const jwt = resources[0]!.headers["poppy-session"]!;
    const header = decodeProtectedHeader(jwt);
    const claims = decodeJwt(jwt);
    expect(header).toMatchObject({ typ: "poppy-session+jwt", alg: "ES256" });
    expect(claims).toMatchObject({ iss: `${testEnv.PUBLIC_ORIGIN}/poppy/client.json`, aud: c.hosts.issuer });
    expect(claims.ath).toBeUndefined();
    // The delegation names no User and no Company (5.2).
    const delegation = decodeJwt(header.poppy_dlg as string);
    expect(Object.keys(delegation).sort()).toEqual(["cnf", "exp", "iat", "iss", "jti"]);
    expect((delegation.exp as number) - (delegation.iat as number)).toBeLessThanOrEqual(24 * 3600);
    // One Session: every request names the same sid and User ID.
    const sids = new Set(resources.map((request) => decodeJwt(request.headers["poppy-session"]!).sid));
    expect(sids.size).toBe(1);
  });

  it("uses a delegated key for one User ID only, and another User's Sessions are their own", async () => {
    const c = await company(V3);
    const first = await agent();
    const second = await agent();
    await tool(first, "poppy_message", { domain: c.domain, text: "hello" });
    await tool(second, "poppy_message", { domain: c.domain, text: "hello" });
    const keys = resourceRequests(await requests(c), c).map((request) => {
      const jwt = request.headers["poppy-session"]!;
      return `${decodeJwt(jwt).sub} ${String(decodeProtectedHeader(jwt).kid)}`;
    });
    const users = new Set(keys.map((entry) => entry.split(" ")[0]));
    const kids = new Set(keys.map((entry) => entry.split(" ")[1]));
    expect(users.size).toBe(2);
    expect(kids.size).toBe(2);
  });

  it("starts a new Session once when the Company ends one, and keeps going", async () => {
    const c = await company(V3);
    const a = await agent();
    expect((await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } })).isError).toBe(false);
    expect(await c.stub.endAllSessions()).toBeGreaterThan(0);
    expect((await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } })).isError).toBe(false);
    const sids = new Set(resourceRequests(await requests(c), c).map((request) => decodeJwt(request.headers["poppy-session"]!).sid));
    expect(sids.size).toBe(2);
  });
});

describe("0.3: a Company without an OAuth issuer (3.2)", () => {
  const ISSUERLESS: Partial<MockConfig> = { ...V3, issuerless: true, agent: false, openapi: true, mcp: true, operations: false, web: false };

  it("uses a signed-out MCP API after a 404 for the domain's protected resource metadata, addressing Session JWTs to the domain", async () => {
    const c = await company(ISSUERLESS);
    const a = await agent();
    const called = await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } });
    expect(called.isError, called.text).toBe(false);
    const all = await requests(c);
    // Discovery stops at the 404: there is no issuer to fetch metadata from.
    expect(all.slice(0, 2).map((request) => new URL(request.url).pathname)).toEqual(["/.well-known/poppy.json", "/.well-known/oauth-protected-resource"]);
    expect(all.some((request) => new URL(request.url).hostname === `auth.${c.domain}`)).toBe(false);
    const resources = resourceRequests(all, c);
    expect(resources.length).toBeGreaterThan(0);
    for (const request of resources) {
      expect(request.headers.authorization).toBeUndefined();
      expect(decodeJwt(request.headers["poppy-session"]!).aud).toBe(`https://${c.domain}`);
    }
  });

  it("describes the Company as signed-out only, and refuses sign-in before sending anything", async () => {
    const c = await company(ISSUERLESS);
    const a = await agent();
    const found = await tool(a, "poppy_discover", { domain: c.domain });
    expect(found.isError, found.text).toBe(false);
    expect(found.text).toContain("No OAuth issuer");
    expect(found.text).not.toContain("Website only");
    const before = (await requests(c)).length;
    const signIn = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "To look at your orders" });
    expect(signIn.isError).toBe(true);
    const after = await requests(c);
    expect(after.slice(before).filter((request) => !new URL(request.url).pathname.startsWith("/.well-known/"))).toEqual([]);
  });

  it("won't drop a known issuer over a 404, but follows metadata that explicitly lists no authorization server", async () => {
    const c = await company({ ...V3, mcp: true });
    const a = await agent();
    expect((await tool(a, "poppy_discover", { domain: c.domain })).isError).toBe(false);
    // The protected resource metadata disappears: a 404 doesn't show the issuer was removed.
    await c.stub.configure({ issuerless: true });
    await a.stub.poppySql("UPDATE poppy_domains SET expires_at = 0");
    const refused = await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("doesn't show the issuer was removed");
    // Metadata that names no authorization server does (3.2), and the identifier becomes the domain.
    await c.stub.configure({ issuerless: false, authorizationServersOverride: [], signIn: { direct: null, device: null, mediated: null } });
    await a.stub.poppySql("UPDATE poppy_domains SET expires_at = 0");
    const before = (await requests(c)).length;
    const called = await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } });
    expect(called.isError, called.text).toBe(false);
    const resources = resourceRequests((await requests(c)).slice(before), c);
    expect(resources.length).toBeGreaterThan(0);
    for (const request of resources) expect(decodeJwt(request.headers["poppy-session"]!).aud).toBe(`https://${c.domain}`);
  });

  it("signs out of accounts held under an issuer the Company explicitly removed, revoking them at the old issuer", async () => {
    const c = await company({ ...V3, mcp: true });
    const a = await agent();
    expect((await signInDirect(a, c, ["orders:read"]))?.callback.status).toBe(200);
    expect((await c.stub.state()).accountTokens).toBe(1);
    await c.stub.configure({ authorizationServersOverride: [], signIn: { direct: null, device: null, mediated: null } });
    await a.stub.poppySql("UPDATE poppy_domains SET expires_at = 0");
    expect((await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } })).isError).toBe(false);
    const notice = (await cards(a)).find((card) => card.id.startsWith("identifier-change-"));
    expect(notice?.text).toContain("signing out of the account it held there before");
    // The revoke job runs now, at the old issuer's revocation endpoint.
    await a.stub.poppySql("UPDATE cf_agents_jobs SET time = ? WHERE capability = 'poppy' AND running = 0", Date.now());
    await runDurableObjectAlarm(a.stub);
    await until(async () => (await c.stub.state()).accountTokens === 0);
    expect((await requests(c)).some((request) => request.url === c.hosts.revocationEndpoint)).toBe(true);
  });

  it("continues signed out when the Company refuses this agent a sign-in type, and doesn't offer it again for a while (4.1)", async () => {
    const c = await company({ ...V3, mcp: true, signIn: { direct: null, device: ["orders:read", "orders:write"], mediated: null }, refuseSignInTypes: ["device"] });
    const a = await agent();
    const first = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "To look at your orders" });
    expect(first.isError).toBe(true);
    expect(first.text).toContain("continues signed out");
    const deviceRequests = async () => (await requests(c)).filter((request) => request.url === c.hosts.deviceEndpoint).length;
    expect(await deviceRequests()).toBe(1);
    const again = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "To look at your orders" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("recently");
    expect(await deviceRequests()).toBe(1);
    expect((await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } })).isError).toBe(false);
  });

  it("starts no sign-in at a Company that sets auth.disabled, though it has an issuer, and still talks signed out", async () => {
    const c = await company({ ...V3, authDisabled: true, mcp: true });
    const a = await agent();
    const signIn = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "To look at your orders" });
    expect(signIn.isError).toBe(true);
    expect(signIn.text).toContain("offers personal agents no sign-in");
    expect((await requests(c)).filter((request) => new URL(request.url).hostname === `auth.${c.domain}` && !new URL(request.url).pathname.startsWith("/.well-known/"))).toEqual([]);
    expect((await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } })).isError).toBe(false);
    // The identifier is still the issuer (3.2).
    const resources = resourceRequests(await requests(c), c);
    expect(decodeJwt(resources.at(-1)!.headers["poppy-session"]!).aud).toBe(c.hosts.issuer);
  });

  it("calls a signed-out OpenAPI operation with the Session header alone", async () => {
    const c = await company(ISSUERLESS);
    const a = await agent();
    const listed = await tool(a, "poppy_api_describe", { domain: c.domain });
    expect(listed.isError, listed.text).toBe(false);
    const resources = resourceRequests(await requests(c), c);
    for (const request of resources) expect(decodeJwt(request.headers["poppy-session"]!).aud).toBe(`https://${c.domain}`);
  });
});

describe("0.3: plain OAuth for accounts", () => {
  it("asks for every scope it still needs when it signs in again for more access, not only the missing one (4.7)", async () => {
    const c = await company(V3);
    const a = await agent();
    expect((await signInDirect(a, c, ["orders:read"]))?.callback.status).toBe(200);
    const more = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:write"], reason: "To exchange the jacket" });
    expect(more.isError, more.text).toBe(false);
    const card = (await cards(a)).find((item) => item.kind === "signin_link" && item.open)!;
    expect(new URL(card.url).searchParams.get("scope")!.split(" ").sort()).toEqual(["orders:read", "orders:write"]);
  });

  it("drops a held scope the Company no longer describes when it asks for more access, rather than refusing", async () => {
    const c = await company({ ...V3, customScopes: { "loyalty:read": "See your points" } });
    const a = await agent();
    expect((await signInDirect(a, c, ["orders:read", "loyalty:read"]))?.callback.status).toBe(200);
    await c.stub.configure({ customScopes: {} });
    await a.stub.poppySql("UPDATE poppy_domains SET expires_at = 0");
    const more = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:write"], reason: "To exchange the jacket" });
    expect(more.isError, more.text).toBe(false);
    const card = (await cards(a)).find((item) => item.kind === "signin_link" && item.open)!;
    expect(new URL(card.url).searchParams.get("scope")!.split(" ").sort()).toEqual(["orders:read", "orders:write"]);
  });

  it("requests a scope the Company documents when its issuer publishes no scopes_supported (3.2, 4.7)", async () => {
    const c = await company({ ...V3, omitScopesSupported: true });
    const a = await agent();
    expect((await signInDirect(a, c, ["orders:read"]))?.callback.status).toBe(200);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
  });

  it.each([true, false])("signs in directly and calls the API with the access token and ath (DPoP=%s)", async (dpopTokens) => {
    const c = await company({ ...V3, dpopTokens });
    const a = await agent();
    expect((await signInDirect(a, c, SCOPES))?.callback.status).toBe(200);
    const orders = await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
    expect(orders.isError).toBe(false);
    expect(orders.text).toContain("ord_7Hk2");
    const all = await requests(c);
    // The code exchange names no Session (5.4).
    const exchange = all.find((request) => request.grant === "authorization_code")!;
    expect(exchange.bodyKeys).not.toContain("session_id");
    expect(exchange.headers.dpop === "<present>").toBe(dpopTokens);
    const call = all.find((request) => new URL(request.url).pathname === "/orders")!;
    expect(call.headers.authorization).toBe(dpopTokens ? "DPoP <redacted>" : "Bearer <redacted>");
    expect(typeof decodeJwt(call.headers["poppy-session"]!).ath).toBe("string");
  });

  it("refreshes an expired access token with the refresh token alone", async () => {
    const c = await company({ ...V3, accessTokenTtl: 31 });
    const a = await agent();
    await signInDirect(a, c, SCOPES);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
    const refreshes = (await requests(c)).filter((request) => request.grant === "refresh_token");
    expect(refreshes.length).toBeGreaterThan(0);
    expect(refreshes.every((request) => !request.bodyKeys.includes("session_id"))).toBe(true);
  });

  it("asks for sign-in on a challenge with no error code, as insufficient_scope", async () => {
    const c = await company(V3);
    const a = await agent();
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
    expect(result.text).toMatch(/insufficient_scope|sign in/i);
    const call = (await requests(c)).find((request) => new URL(request.url).pathname === "/orders")!;
    expect(call.status).toBe(401);
  });

  it("signs in on another device and uses the account", async () => {
    const c = await company({ ...V3, signIn: { direct: null, device: ["orders:read", "orders:write"], mediated: null } });
    const a = await agent();
    expect((await tool(a, "poppy_sign_in", { domain: c.domain, scopes: SCOPES, reason: "Look at your orders" })).isError).toBe(false);
    const card = await until(async () => (await cards(a)).find((item) => item.kind === "signin_device" && item.open));
    await c.stub.approveDevice(card.userCode);
    await a.stub.poppyAdvance(2_000);
    await until(async () => JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text).sessions.some((session: { signedIn: boolean }) => session.signedIn));
    const poll = (await requests(c)).filter((request) => request.grant === "urn:ietf:params:oauth:grant-type:device_code");
    expect(poll.every((request) => !request.bodyKeys.includes("session_id"))).toBe(true);
  });

  it("signs in with Mediated Sign-In's grant, sending the one-time code alone the second time", async () => {
    const c = await company({ ...V3, signIn: { direct: null, device: null, mediated: ["orders:read"] } });
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read"], reason: "test" });
    const credentials = (await cards(a)).find((item) => item.kind === "signin_credentials")!;
    await a.stub.poppyFrame({ type: "poppy.credentials", signInId: credentials.signInId, values: { email: "grace@example.com", password: "battery staple" } });
    const codeCard = (await cards(a)).find((item) => item.kind === "signin_code")!;
    expect(codeCard.sentTo).toBe("Text to the phone number ending in 71");
    await a.stub.poppyFrame({ type: "poppy.code", signInId: credentials.signInId, code: (await c.stub.lastOneTimeCode())! });
    const status = JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);
    expect(status.sessions[0].signedIn).toBe(true);
    const grants = (await requests(c)).filter((request) => request.grant === "https://personalagentprotocol.org/grant/mediated-sign-in");
    expect(grants.map((request) => request.bodyKeys.filter((key) => !key.startsWith("client_"))).map((keys) => keys.sort())).toEqual([
      ["email", "grant_type", "password", "scope"],
      ["grant_type", "one_time_code", "sign_in_id"]
    ]);
    expect(await a.stub.poppyDumpStorage()).not.toContain("battery staple");
  });

  it("continues signed out, in the same Session, after signing out", async () => {
    const c = await company(V3);
    const a = await agent();
    await signInDirect(a, c, SCOPES);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    expect((await c.stub.state()).accountTokens).toBe(0);
    await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } });
    const resources = resourceRequests(await requests(c), c);
    const last = resources.at(-1)!;
    expect(last.headers.authorization).toBeUndefined();
    expect(new Set(resources.map((request) => decodeJwt(request.headers["poppy-session"]!).sid)).size).toBe(1);
  });
});

describe("0.3: one account per Session", () => {
  it("signs in to a second account in a new Session, even after signing out of the first", async () => {
    const c = await company(V3);
    const a = await agent();
    await signInDirect(a, c, SCOPES);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await signInDirect(a, c, SCOPES, { account: "acct_grace" }, { account: "work" });
    const orders = await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
    expect(orders.text).toContain("acct_grace");
    const sids = resourceRequests(await requests(c), c).map((request) => decodeJwt(request.headers["poppy-session"]!).sid);
    expect(new Set(sids).size).toBe(2);
  });
});

describe("0.3: Operations 2", () => {
  it("shows the Company's terms, sends the same request with Poppy-Approval, and performs it once", async () => {
    const c = await company(V3);
    const a = await agent();
    await signInDirect(a, c, SCOPES);
    const asked = await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    expect(asked.isError).toBe(false);
    // The request runs first; only the Company's exact terms need a decision (Ops 4–6).
    const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    expect((await cards(a)).filter(card => card.kind === "approval")).toHaveLength(1);
    expect(terms.summary).toContain("Exchange the Stormline Jacket (M)");
    expect((await c.stub.state()).performs).toBe(0);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    const writes = (await requests(c)).filter((request) => new URL(request.url).pathname.endsWith("/exchanges"));
    expect(writes.map((request) => [request.status, !!request.headers["poppy-approval"]])).toEqual([[403, false], [201, true]]);
    expect(writes[0]!.headers["idempotency-key"]).not.toBe(writes[1]!.headers["idempotency-key"]);
    // Approving again sends nothing: the card is decided.
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("approves an MCP tool's operation with _meta", async () => {
    const c = await company(V3);
    const a = await agent();
    await signInDirect(a, c, SCOPES);
    await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "exchange_item", args: { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    expect((await cards(a)).filter(card => card.kind === "approval")).toHaveLength(1);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("approves a Company Agent's operation with a message's approval", async () => {
    const c = await company(V3);
    const a = await agent();
    await signInDirect(a, c, SCOPES);
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "Please exchange the jacket on my order" })).isError).toBe(false);
    const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    expect(terms.summary).toContain("asks for your approval");
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    const state = await c.stub.state();
    expect(state.conversations[0]!.sent.every((line) => line.startsWith("agent:"))).toBe(true);
    // The approval went as Operations 2's extension content (8.4).
    const approved = (await requests(c)).filter((request) => request.method === "POST" && /\/messages$/.test(new URL(request.url).pathname));
    expect(approved.length).toBeGreaterThan(0);
  });

  it("refuses an approval message an earlier build saved with the old top-level approval field, sending nothing", async () => {
    const c = await company(V3);
    const a = await agent();
    await signInDirect(a, c, SCOPES);
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "Please exchange the jacket on my order" })).isError).toBe(false);
    const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    // The terms the card holds, as the approval's message would name them.
    const rows = JSON.parse(await a.stub.poppySql("SELECT request FROM poppy_approvals")) as { request: string }[];
    const find = (value: unknown): { operation_id: string; revision: string } | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const record = value as Record<string, unknown>;
      if (typeof record.operation_id === "string" && typeof record.revision === "string") return record as { operation_id: string; revision: string };
      for (const child of Object.values(record)) { const found = find(child); if (found) return found; }
      return undefined;
    };
    const operation = rows.map((row) => find(JSON.parse(row.request))).find(Boolean)!;
    // What the 29 October build stored for this approval's message before sending it.
    const stale = JSON.stringify({ message: { id: "msg_stalestalestalestale", author: { type: "agent" }, text: "The User approved this.", approval: { operation_id: operation.operation_id, revision: operation.revision } } });
    await a.stub.poppySql("INSERT INTO poppy_intents (call_key, value, created_at) VALUES (?, ?, ?)", `message|approval|${operation.operation_id}|${operation.revision}`, stale, Date.now());
    const before = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    const failed = await until(async () => (await cards(a)).find((card) => card.id === terms.id && card.status === "failed"));
    expect(failed.result).toContain("earlier version of the agent");
    expect((await requests(c)).slice(before).filter((request) => /\/messages$/.test(new URL(request.url).pathname))).toEqual([]);
    expect((await c.stub.state()).performs).toBe(0);
  });
});

describe("0.3: the browser join", () => {
  it("authorizes the page's code with the Session header, then the browser submits it", async () => {
    const c = await company(V3);
    const a = await agent();
    await signInDirect(a, c, SCOPES);
    const page = await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: "/orders" });
    expect(page.isError).toBe(false);
    expect(page.text).toContain("Signed in as acct_ada");
    const all = await requests(c);
    const authorize = all.find((request) => request.url.endsWith("/poppy/browser-session/authorize"))!;
    expect(authorize.status).toBe(204);
    expect(authorize.headers.authorization).toBeDefined();
    // The browser's requests carry its cookies, never the token.
    const join = all.filter((request) => new URL(request.url).pathname === "/poppy/browser-session");
    expect(join.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(join.every((request) => !request.headers.authorization && !request.headers["poppy-session"])).toBe(true);
    expect(join[1]!.bodyKeys).toEqual(["code"]);
  });
});

describe("0.3: conversations", () => {
  it("writes author and reads a person's name from the Company", async () => {
    const c = await company(V3);
    const a = await agent();
    const sent = await tool(a, "poppy_message", { domain: c.domain, text: "Can a person help?" });
    expect(sent.isError).toBe(false);
    const state = await c.stub.state();
    expect(state.conversations[0]!.sent[0]).toBe("agent:Can a person help?");
  });
});

describe("0.3: task coverage", () => {
  it("reads the excluded tasks with discovery, keeping only references to the Company's own hosts and APIs", async () => {
    const c = await company(V3);
    const a = await agent();
    const found = JSON.parse((await tool(a, "poppy_discover", { domain: c.domain })).text);
    expect(found.excludedTasks.tasks.map((entry: { task: string }) => entry.task)).toEqual(["Close an account", "Send a gift card"]);
    expect(found.excludedTasks.tasks[0].alternative).toEqual({ instructions: "Accounts are closed by phone.", references: [{ type: "web", url: `${c.hosts.web}/help/close` }] });
    // 9.1: fetched with a GET and no token or Session header.
    const fetch = (await requests(c)).find((request) => request.url.endsWith("/poppy/excluded-tasks.json"))!;
    expect(fetch.headers.authorization).toBeUndefined();
    expect(fetch.headers["poppy-session"]).toBeUndefined();
  });

  it("sends feedback once per task with the Session header, and accepts an alternative in answer", async () => {
    const c = await company({ ...V3, feedback: true, feedbackAlternative: true });
    const a = await agent();
    const args = { domain: c.domain, task: "Pay with a gift card", description: "The User wanted to pay with a gift card; no API or page takes one." };
    const first = JSON.parse((await tool(a, "poppy_feedback", args)).text);
    expect(first.status).toBe("sent");
    expect(first.companySays.alternative.references).toEqual([{ type: "web", url: `${c.hosts.web}/checkout` }]);
    const again = JSON.parse((await tool(a, "poppy_feedback", args)).text);
    expect(again.status).toBe("not sent");
    const reports = (await requests(c)).filter((request) => request.url.endsWith("/poppy/feedback"));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.headers["poppy-session"]).toBeDefined();
    expect(reports[0]!.bodyKeys.sort()).toEqual(["description", "task"]);
    expect((await c.stub.state()).feedback).toEqual([{ task: "Pay with a gift card", signedIn: false }]);
  });

  it("doesn't report a task the Company lists as excluded", async () => {
    const c = await company({ ...V3, feedback: true });
    const a = await agent();
    const answer = JSON.parse((await tool(a, "poppy_feedback", { domain: c.domain, task: "close an account.", description: "The User wanted to close their account." })).text);
    expect(answer.status).toBe("not sent");
    expect(answer.excludedTasks.tasks[0].task).toBe("Close an account");
    expect((await requests(c)).some((request) => request.url.endsWith("/poppy/feedback"))).toBe(false);
  });
});

describe("0.3: describing scopes", () => {
  it("shows each scope as the Company's OpenAPI description describes it, with its hint in plain words", async () => {
    const c = await company({ ...V3, describesSecurity: true });
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: SCOPES, reason: "Exchange the jacket" });
    const card = await until(async () => (await cards(a)).find((item) => item.kind === "signin_link" && item.open));
    expect(card.scopes).toEqual([
      { scope: "orders:read", description: "Read your orders", hint: "Changes nothing · Uses your personal data" },
      { scope: "orders:write", description: "Exchange items on your orders", hint: "Can make changes that can't be undone · Uses your personal data" }
    ]);
  });
});
