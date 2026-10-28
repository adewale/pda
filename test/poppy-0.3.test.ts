/**
 * Our client against the mock Company speaking draft 0.3 as rewritten on 28
 * October (spec/draft-0.3-retrieved-2026-10-28): the issuer from the
 * domain's protected resource metadata, a Session header on every request,
 * plain OAuth for accounts, the new browser join, Operations 2, Mediated
 * Sign-In as a grant, and `author` on messages. Every test also passes the
 * strict check in agent-helpers: the mock recorded no violation or warning.
 */
import { decodeJwt, decodeProtectedHeader } from "jose";
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
    expect(claims).toMatchObject({ iss: `${testEnv.PUBLIC_ORIGIN}/poppy/0.3/client.json`, aud: c.hosts.issuer });
    expect(claims.ath).toBeUndefined();
    // The delegation names no User and no Company (5.2).
    const delegation = decodeJwt(header.pap_dlg as string);
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

describe("0.3: plain OAuth for accounts", () => {
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
    const c = await company({ ...V3, sessionTokenTtl: 31 });
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
    const c = await company({ ...V3, signIn: { direct: null, device: ["poppy:read", "poppy:write"], mediated: null } });
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
    const c = await company({ ...V3, signIn: { direct: null, device: null, mediated: ["poppy:read"] } });
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

describe("0.3: Operations 2", () => {
  it("shows the Company's terms, sends the same request with Poppy-Approval, and performs it once", async () => {
    const c = await company(V3);
    const a = await agent();
    await signInDirect(a, c, SCOPES);
    const asked = await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    expect(asked.isError).toBe(false);
    // Our own card first: a write waits for the User (Safety).
    const ours = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: ours.approvalId, decision: "approve" });
    // Then the Company's terms, on a card of their own.
    const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open && card.approvalId !== ours.approvalId));
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
    const ours = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: ours.approvalId, decision: "approve" });
    const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open && card.approvalId !== ours.approvalId));
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
