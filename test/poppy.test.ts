import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentNameFor, createSession } from "../src/session";
import { hostsFor, type MockCompany, type MockConfig } from "./mock-company";
import worker from "./worker";
import type { PersonalAgent } from "./worker";

/**
 * Conformance tests: the Personal Agent against a strict mock Company. Each
 * `describe` is a section of Personal Agent Protocol Draft 0.1 or the
 * Operations extension; every test also asserts the mock saw no violations.
 */

type TestEnv = Env & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> };
const testEnv = env as TestEnv;
const ORIGIN = "https://agent.test";

async function company(config: Partial<MockConfig> = {}) {
  const id = `c${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const stub = testEnv.MOCK_COMPANY.getByName(id);
  await stub.configure({ deviceInterval: 1, ...config });
  return { id, stub, domain: `${id}.shop.test`, hosts: hostsFor(id) };
}

async function agent() {
  const identity = { provider: "github" as const, sub: `u${crypto.randomUUID()}`, email: "person@example.com" };
  const stub = testEnv.PersonalAgent.getByName(await agentNameFor(identity)) as unknown as DurableObjectStub<PersonalAgent>;
  const cookie = (await createSession(identity, env.SESSION_SECRET)).split(";")[0]!;
  return { stub, cookie };
}

type Agent = Awaited<ReturnType<typeof agent>>;
type Company = Awaited<ReturnType<typeof company>>;

async function until<T>(check: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function tool(a: Agent, name: string, args: Record<string, unknown>, callId?: string) {
  return a.stub.poppyTool(name, args, callId);
}

async function cards(a: Agent): Promise<Array<Record<string, any>>> {
  return JSON.parse(await a.stub.poppyCards());
}

async function noViolations(c: Company) {
  expect((await c.stub.state()).violations).toEqual([]);
}

/** Direct Sign-In end to end: the test plays the User on the Company's page. */
async function signInDirect(a: Agent, c: Company, scopes = ["poppy:read", "poppy:write"], decision: { approve?: boolean; scopes?: string[]; account?: string } = {}) {
  const started = await tool(a, "poppy_sign_in", { domain: c.domain, scopes, reason: "To look at your orders" });
  expect(started.isError).toBe(false);
  if (started.text.includes("signed in with access")) return null;
  const card = (await cards(a)).find((item) => item.kind === "signin_link" && item.open);
  expect(card).toBeDefined();
  const location = await c.stub.approveAuthorization(card!.url, { approve: decision.approve ?? true, account: decision.account ?? "acct_ada", ...(decision.scopes ? { scopes: decision.scopes } : {}) });
  const callback = await worker.fetch(new Request(location, { headers: { Cookie: a.cookie } }), env);
  return { callback, location, text: await callback.text() };
}

describe("4.1 agent identity", () => {
  it("serves the client metadata document at its own client_id", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/poppy/client.json`), env);
    const doc = (await response.json()) as Record<string, any>;
    expect(doc.client_id).toBe(`${ORIGIN}/poppy/client.json`);
    expect(doc.jwks_uri).toBe(`${ORIGIN}/poppy/jwks.json`);
    expect(doc.redirect_uris).toEqual([`${ORIGIN}/poppy/callback`]);
    expect(doc.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(doc.extensions).toEqual({ operations: { version: "1" } });
  });

  it("publishes only public keys, each with a kid", async () => {
    const jwks = (await (await worker.fetch(new Request(`${ORIGIN}/poppy/jwks.json`), env)).json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(2);
    for (const key of jwks.keys) {
      expect(key.d).toBeUndefined();
      expect(typeof key.kid).toBe("string");
    }
  });

  it("serves its identity only on PUBLIC_ORIGIN", async () => {
    const response = await worker.fetch(new Request("https://elsewhere.example/poppy/client.json"), env);
    expect(response.status).toBe(404);
  });
});

describe("3 discovery", () => {
  it("discovers a Company, skipping unknown APIs, protocols and extensions", async () => {
    const c = await company();
    const a = await agent();
    const result = await tool(a, "poppy_discover", { domain: c.domain });
    expect(result.isError).toBe(false);
    const found = JSON.parse(result.text);
    expect(found.signIn).toEqual(["direct", "device", "mediated"]);
    expect(found.apis.map((api: { type: string }) => api.type).sort()).toEqual(["mcp", "openapi"]);
    expect(found.extensions).toEqual(["operations"]);
    expect(found.agent).toContain("available");
    await noViolations(c);
  });

  it("follows an HTTPS redirect of the well-known URL", async () => {
    const c = await company({ wellKnownRedirect: "https" });
    const a = await agent();
    expect((await tool(a, "poppy_discover", { domain: c.domain })).isError).toBe(false);
  });

  it("refuses a redirect to http", async () => {
    const c = await company({ wellKnownRedirect: "http" });
    const result = await tool(await agent(), "poppy_discover", { domain: c.domain });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/HTTPS/);
  });

  it("refuses an unsupported major version", async () => {
    const c = await company({ protocolVersion: "1.0" });
    const result = await tool(await agent(), "poppy_discover", { domain: c.domain });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/version 1.0/);
  });

  it("refuses a document whose organization.domain doesn't match", async () => {
    const c = await company({ organizationDomain: "other.shop.test" });
    expect((await tool(await agent(), "poppy_discover", { domain: c.domain })).isError).toBe(true);
  });

  it("refuses an issuer whose metadata doesn't match", async () => {
    const c = await company({ issuerOverride: "https://auth.evil.shop.test" });
    const result = await tool(await agent(), "poppy_discover", { domain: c.domain });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/issuer/);
  });

  it("refuses an issuer whose poppy_domains leaves the domain out", async () => {
    const c = await company({ poppyDomainsOverride: ["someone-else.test"] });
    const result = await tool(await agent(), "poppy_discover", { domain: c.domain });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/poppy_domains/);
  });

  it("treats two domains naming one issuer as one Company, with one User ID", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    await tool(a, "poppy_message", { domain: `${c.id}.shop-uk.test`, text: "hello again" });
    const ids = JSON.parse(await a.stub.poppySql("SELECT user_id FROM poppy_user_ids"));
    expect(ids).toHaveLength(1);
    expect((await c.stub.state()).userIds).toEqual([ids[0].user_id]);
    await noViolations(c);
  });
});

describe("4.2–4.3 sessions, tokens and DPoP", () => {
  it("starts a signed-out Session with a random User ID", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    const state = await c.stub.state();
    expect(state.userIds).toHaveLength(1);
    expect(state.userIds[0]).toMatch(/^usr_[A-Za-z0-9_-]{22}$/);
    expect(state.userIds[0]).not.toContain("person");
    expect(state.sessions[0]?.signedIn).toBe(false);
    await noViolations(c);
  });

  it("supports DPoP nonces", async () => {
    const c = await company({ requireNonce: true });
    const a = await agent();
    const result = await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    expect(result.isError).toBe(false);
    await noViolations(c);
  });

  it("waits out Retry-After on 429 before retrying", async () => {
    const c = await company({ rateLimit: { tokenRequests429: 1, requests429: 1, retryAfterSeconds: 1 } });
    const a = await agent();
    const result = await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    expect(result.isError).toBe(false);
    await noViolations(c);
  });

  it("reports a Company that hasn't registered this agent", async () => {
    const c = await company({ requireRegistration: ["https://someone-else.test/client.json"] });
    const result = await tool(await agent(), "poppy_message", { domain: c.domain, text: "hello" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/invalid_client/);
  });

  it("gets new tokens with a new DPoP key after an eviction", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    await a.stub.poppyForgetMemory();
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello again" })).isError).toBe(false);
    expect((await c.stub.state()).sessions.filter((s) => !s.ended)).toHaveLength(1);
    await noViolations(c);
  });
});

describe("4.4–4.5 Direct Sign-In", () => {
  it("signs in through the Company's page and checks state and iss", async () => {
    const c = await company();
    const a = await agent();
    const result = await signInDirect(a, c);
    expect(result!.callback.status).toBe(200);
    const status = JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);
    expect(status.sessions[0]).toMatchObject({ signedIn: true, scope: "poppy:read poppy:write" });
    expect((await c.stub.state()).accountTokens).toBe(1);
    expect((await a.stub.poppyNotices()).some((n) => n.includes(`Signed in to Mock Shop ${c.id}`))).toBe(true);
    await noViolations(c);
  });

  it("uses each state once", async () => {
    const c = await company();
    const a = await agent();
    const result = await signInDirect(a, c);
    const again = await worker.fetch(new Request(result!.location, { headers: { Cookie: a.cookie } }), env);
    expect(again.status).toBe(400);
  });

  it("rejects a response whose iss isn't the Company's issuer", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_link")!;
    const location = new URL(await c.stub.approveAuthorization(card.url, { approve: true, account: "acct_ada" }));
    location.searchParams.set("iss", "https://auth.evil.shop.test");
    const callback = await worker.fetch(new Request(location.href, { headers: { Cookie: a.cookie } }), env);
    expect(callback.status).toBe(400);
    expect((await c.stub.state()).accountTokens).toBe(0);
  });

  it("needs the person's own app session for the callback", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_link")!;
    const location = await c.stub.approveAuthorization(card.url, { approve: true, account: "acct_ada" });
    const callback = await worker.fetch(new Request(location), env);
    expect(callback.status).toBe(401);
  });

  it("notices when the User approves fewer scopes", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c, ["poppy:read", "poppy:write"], { scopes: ["poppy:read"] });
    expect((await a.stub.poppyNotices()).some((n) => n.includes('not granted "poppy:write"'))).toBe(true);
    await noViolations(c);
  });

  it("handles a declined sign-in", async () => {
    const c = await company();
    const a = await agent();
    const result = await signInDirect(a, c, ["poppy:read"], { approve: false });
    expect(result!.callback.status).toBe(400);
    expect((await a.stub.poppyNotices()).some((n) => n.includes("the User declined"))).toBe(true);
  });

  it("reuses an Account Token that covers the task instead of asking again", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const again = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "again", session: "second" });
    expect(again.text).toContain("signed in with access the User granted earlier");
    await noViolations(c);
  });

  it("steps up: signs in again for more scopes and revokes the old Account Token", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c, ["poppy:read"]);
    await signInDirect(a, c, ["poppy:read", "poppy:write"]);
    expect((await c.stub.state()).accountTokens).toBe(1);
    await noViolations(c);
  });
});

describe("4.6 Device Sign-In", () => {
  it("shows the code, polls at the interval and signs in when the User approves", async () => {
    const c = await company({ signIn: { direct: null, device: ["poppy:read", "poppy:write"], mediated: null } });
    const a = await agent();
    const started = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    expect(started.text).toContain("device");
    const card = (await cards(a)).find((item) => item.kind === "signin_device")!;
    expect(card.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(JSON.stringify(card)).not.toContain("device_code");
    await c.stub.approveDevice(card.userCode, { account: "acct_ada" });
    await until(async () => (await a.stub.poppyNotices()).some((n) => n.includes("Signed in to")));
    await noViolations(c);
  });

  it("stops when the User declines", async () => {
    const c = await company({ signIn: { direct: null, device: ["poppy:read"], mediated: null } });
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_device")!;
    await c.stub.denyDevice(card.userCode);
    await until(async () => (await a.stub.poppyNotices()).some((n) => n.includes("the User declined")));
    await noViolations(c);
  });
});

describe("4.7 Mediated Sign-In", () => {
  const mediatedOnly = { signIn: { direct: null, device: null, mediated: ["poppy:read"] } };

  it("sends the credentials only to the endpoint, never to the model, logs or storage", async () => {
    const c = await company(mediatedOnly);
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_credentials")!;
    expect(card.fields.find((field: { name: string }) => field.name === "password").secret).toBe(true);
    await a.stub.poppyFrame({ type: "poppy.credentials", signInId: card.signInId, values: { email: "ada@example.com", password: "correct horse" } });
    const status = JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);
    expect(status.sessions[0].signedIn).toBe(true);
    const everything = JSON.stringify([
      await a.stub.poppyNotices(),
      await a.stub.poppyCards(),
      await a.stub.poppySql("SELECT * FROM poppy_signins"),
      await a.stub.poppySql("SELECT * FROM poppy_intents"),
      await a.stub.poppySql("SELECT * FROM poppy_messages")
    ]);
    expect(everything).not.toContain("correct horse");
    await noViolations(c);
  });

  it("submits only the one-time code when the Company asks for one", async () => {
    const c = await company(mediatedOnly);
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const credentials = (await cards(a)).find((item) => item.kind === "signin_credentials")!;
    await a.stub.poppyFrame({ type: "poppy.credentials", signInId: credentials.signInId, values: { email: "grace@example.com", password: "battery staple" } });
    const codeCard = (await cards(a)).find((item) => item.kind === "signin_code")!;
    expect(codeCard.sentTo).toBeTruthy();
    await a.stub.poppyFrame({ type: "poppy.code", signInId: credentials.signInId, code: (await c.stub.lastOneTimeCode())! });
    const status = JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);
    expect(status.sessions[0].signedIn).toBe(true);
    expect(await a.stub.poppySql("SELECT * FROM poppy_signins")).not.toContain("battery staple");
    await noViolations(c);
  });

  it("reports a wrong password without retrying", async () => {
    const c = await company(mediatedOnly);
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_credentials")!;
    await a.stub.poppyFrame({ type: "poppy.credentials", signInId: card.signInId, values: { email: "ada@example.com", password: "wrong" } });
    expect((await a.stub.poppyNotices()).some((n) => n.includes("didn't complete"))).toBe(true);
    await noViolations(c);
  });
});

describe("4.8–4.9 Account Tokens and signing out", () => {
  it("uses a rotated Account Token from then on", async () => {
    const c = await company({ rotateRefreshTokens: true });
    const a = await agent();
    await signInDirect(a, c);
    for (let i = 0; i < 2; i++) {
      await a.stub.poppyForgetMemory();
      expect((await tool(a, "poppy_message", { domain: c.domain, text: `hello ${i}` })).isError).toBe(false);
    }
    await noViolations(c);
  });

  it("signs out by revoking the Account Token; the Session continues signed out", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const issuer = c.hosts.issuer;
    await a.stub.poppyFrame({ type: "poppy.signout", issuer, account: "default" });
    expect((await c.stub.state()).accountTokens).toBe(0);
    await a.stub.poppyForgetMemory();
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "still there?" })).isError).toBe(false);
    const status = JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);
    expect(status.sessions[0].signedIn).toBe(false);
    await noViolations(c);
  });

  it("continues signed out when the User disconnects the agent at the Company", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    await c.stub.revokeAllForAccount("acct_ada");
    await a.stub.poppyForgetMemory();
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
    expect((await cards(a)).some((card) => card.kind === "notice" && card.text.includes("ended this agent's access"))).toBe(true);
    expect(await a.stub.poppySql("SELECT * FROM poppy_accounts")).toBe("[]");
    await noViolations(c);
  });

  it("stores Account Tokens encrypted", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const stored = await a.stub.poppySql("SELECT token FROM poppy_accounts");
    expect(stored).not.toContain("pat_");
  });
});

describe("5 web browsing", () => {
  it("joins the browser to the Session before browsing, and sees the account", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const page = await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: "/orders" });
    expect(page.isError).toBe(false);
    expect(page.text).toContain("Signed in as acct_ada");
    expect((await c.stub.state()).browserJoins).toBe(1);
    await noViolations(c);
  });

  it("browses only the Company's own domain", async () => {
    const c = await company();
    const result = await tool(await agent(), "poppy_browse", { domain: c.domain, action: "open", url: "https://elsewhere.test/" });
    expect(result.isError).toBe(true);
  });

  it("never opens the Company's sign-in pages", async () => {
    const c = await company();
    const result = await tool(await agent(), "poppy_browse", { domain: c.domain, action: "open", url: `${c.hosts.issuer}/oauth/authorize` });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("sign-in pages");
  });

  it("never types credentials into a website", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: "/" });
    const result = await tool(a, "poppy_browse", { domain: c.domain, action: "fill", selector: "#password", value: "x" });
    expect(result.isError).toBe(true);
  });
});

describe("6 APIs", () => {
  it("lists and calls OpenAPI operations with DPoP", async () => {
    const c = await company();
    const a = await agent();
    const described = JSON.parse((await tool(a, "poppy_api_describe", { domain: c.domain })).text);
    expect(described.operations.length).toBeGreaterThan(0);
    const products = await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } });
    expect(products.isError).toBe(false);
    await noViolations(c);
  });

  it("asks for sign-in when an API needs the account", async () => {
    const c = await company();
    const a = await agent();
    const orders = await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /orders" });
    expect(orders.text).toMatch(/sign_in_required|insufficient_scope/);
  });

  it("gets a proposal, not an action, from a write at a Company with operations", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const result = await tool(a, "poppy_api_call", {
      domain: c.domain,
      operation: "POST /orders/{order_id}/exchanges",
      params: { order_id: "ord_7Hk2" },
      body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
    });
    expect(result.text).toContain("proposed");
    expect((await c.stub.state()).performs).toBe(0);
    await noViolations(c);
  });

  it("waits for the User's approval of a write at a Company without operations, then makes it once", async () => {
    const c = await company({ operations: false });
    const a = await agent();
    await signInDirect(a, c);
    const result = await tool(a, "poppy_api_call", {
      domain: c.domain,
      operation: "POST /orders/{order_id}/exchanges",
      params: { order_id: "ord_7Hk2" },
      body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
    });
    expect(result.text).toContain("Waiting for the User's approval");
    expect((await c.stub.state()).performs).toBe(0);
    const card = (await cards(a)).find((item) => item.kind === "approval")!;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    await noViolations(c);
  });

  it("calls MCP tools with a Bearer token issued for that server only", async () => {
    const c = await company();
    const a = await agent();
    const tools = JSON.parse((await tool(a, "poppy_mcp_list", { domain: c.domain })).text);
    expect(tools.tools.map((t: { name: string }) => t.name)).toContain("search_products");
    const result = await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } });
    expect(result.isError).toBe(false);
    await noViolations(c);
  });

  it("refuses an MCP server whose metadata doesn't name the issuer", async () => {
    const c = await company({ mcpPrmOmitIssuer: true });
    const result = await tool(await agent(), "poppy_mcp_list", { domain: c.domain });
    expect(result.isError).toBe(true);
  });
});

describe("7 conversations", () => {
  it("starts a conversation with context and gets the reply", async () => {
    const c = await company();
    const a = await agent();
    await a.stub.poppyFrame({ type: "poppy.context", locale: "en-GB", time_zone: "Europe/London" });
    const result = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    expect(result.replies.map((r: { text: string }) => r.text)).toContain("Hi! How can I help?");
    const conversation = (await c.stub.state()).conversations[0]!;
    expect(conversation.sent).toEqual(["agent:hello"]);
    expect(JSON.parse(conversation.context)).toMatchObject({ locale: "en-GB", time_zone: "Europe/London" });
    await noViolations(c);
  });

  it("refuses JSON in text", async () => {
    const c = await company();
    const result = await tool(await agent(), "poppy_message", { domain: c.domain, text: '{"order": 1042}' });
    expect(result.isError).toBe(true);
  });

  it("resends the same message id when a tool call is replayed", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_message", { domain: c.domain, text: "hello" }, "call-1");
    await tool(a, "poppy_message", { domain: c.domain, text: "hello" }, "call-1");
    const state = await c.stub.state();
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0]!.sent).toEqual(["agent:hello"]);
    await noViolations(c);
  });

  it("reads later events in the background, streaming, and tells the model", async () => {
    const c = await company({ streaming: true, textDeltas: true });
    const a = await agent();
    const result = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.say(result.conversationId, "One more thing: we have a sale on.");
    await until(async () => (await a.stub.poppyNotices()).some((n) => n.includes("we have a sale on")));
    await noViolations(c);
  });

  it("handles an authorization event, then continues signed in", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "I'd like to return order ord_7Hk2" })).text);
    await until(async () => (await a.stub.poppyNotices()).some((n) => n.includes("needs the User signed in")));
    await signInDirect(a, c);
    await tool(a, "poppy_message", { domain: c.domain, conversation: first.conversationId, text: "I'm signed in now; please exchange it for the insulated one." });
    await until(async () => (await cards(a)).find((card) => card.kind === "operation" && card.open));
    await noViolations(c);
  });

  it("hands off to a person after a summary", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    const handed = JSON.parse((await tool(a, "poppy_handoff", { conversation: first.conversationId, summary: "The jacket isn't warm enough; the user wants an exchange." })).text);
    expect(handed.status).toBe("queued");
    await c.stub.humanJoin(first.conversationId, "Hi, I'm Sam. I can help with that.");
    await until(async () => (await a.stub.poppyNotices()).some((n) => n.includes("A person at")));
    const sent = (await c.stub.state()).conversations[0]!.sent;
    expect(sent.at(-1)).toContain("isn't warm enough");
    await noViolations(c);
  });

  it("offers the User a Direct Conversation and sends their own words as human", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.pushEvent(first.conversationId, { type: "user_requested", reason: "A specialist needs to confirm the exchange." });
    await until(async () => (await cards(a)).find((card) => card.kind === "direct_invite"));
    await a.stub.poppyFrame({ type: "poppy.direct.start", conversationId: first.conversationId, text: "Hi, it's me." });
    const state = await c.stub.state();
    const direct = state.conversations.find((conv) => conv.direct)!;
    expect(direct.parent).toBe(first.conversationId);
    expect(direct.sent).toEqual(["human:Hi, it's me."]);
    const blocked = await tool(a, "poppy_message", { domain: c.domain, conversation: first.conversationId, text: "anything else?" });
    expect(blocked.text).toContain("direct_conversation_open");
    await a.stub.poppyFrame({ type: "poppy.direct.close", conversationId: direct.id });
    await noViolations(c);
  });

  it("tells the User when part of a conversation has expired", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.say(first.conversationId, "Are you still there?");
    // The agent last read up to an event the Company then stops keeping.
    const [oldest] = JSON.parse(await a.stub.poppySql("SELECT event_id FROM poppy_events WHERE conversation_id = ? ORDER BY rowid LIMIT 1", first.conversationId));
    await c.stub.expireEvents(first.conversationId);
    await a.stub.poppySql("UPDATE poppy_conversations SET cursor = ? WHERE id = ?", oldest.event_id, first.conversationId);
    await a.stub.poppyReadNow(first.conversationId);
    expect((await cards(a)).find((card) => card.kind === "notice" && card.text.includes("no longer has part"))).toBeDefined();
    await noViolations(c);
  });

  it("skips event types it doesn't know", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.pushEvent(first.conversationId, { type: "example.test/confetti", colour: "gold" });
    await c.stub.say(first.conversationId, "After the confetti.");
    await until(async () => (await a.stub.poppyNotices()).some((n) => n.includes("After the confetti.")));
    expect((await a.stub.poppyNotices()).join("\n")).not.toContain("confetti\"");
    await noViolations(c);
  });

  it("lets the agent offer the User a Direct Conversation", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await tool(a, "poppy_invite_user", { conversation: first.conversationId, reason: "You may want to explain the fit yourself." });
    const card = (await cards(a)).find((item) => item.kind === "direct_invite")!;
    expect(card.reason).toContain("explain the fit");
    expect((await c.stub.state()).conversations.filter((conv) => conv.direct)).toHaveLength(0);
  });

  it("closes a conversation", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await tool(a, "poppy_close", { conversation: first.conversationId });
    expect((await c.stub.state()).conversations[0]!.status).toBe("closed");
    await noViolations(c);
  });
});

describe("Operations extension", () => {
  async function proposal(config: Partial<MockConfig> = {}) {
    const c = await company(config);
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_api_call", {
      domain: c.domain,
      operation: "POST /orders/{order_id}/exchanges",
      params: { order_id: "ord_7Hk2" },
      body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
    });
    const card = (await cards(a)).find((item) => item.kind === "operation")!;
    return { c, a, card };
  }

  it("shows the Company's summary verbatim and confirms once after the User approves", async () => {
    const { c, a, card } = await proposal();
    expect(card.summary).toMatch(/Exchange/);
    expect(card.highlights.join(" ")).toMatch(/Cost/);
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.operations[0]).toMatchObject({ state: "succeeded", approvedBy: "user" });
    expect((await a.stub.poppyNotices()).some((n) => n.includes("is succeeded"))).toBe(true);
    await noViolations(c);
  });

  it("needs a new approval when the terms change", async () => {
    const { c, a, card } = await proposal();
    await c.stub.reviseOperation(card.operationId, "Exchange for size L instead, for $70.00 more.", { size: "L", price_difference: { amount: "70.00", currency: "USD" } });
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    const updated = (await cards(a)).find((item) => item.kind === "operation" && item.revision === 2)!;
    expect(updated.open).toBe(true);
    expect(updated.previousSummary).toBe(card.summary);
    expect((await c.stub.state()).performs).toBe(0);
    await noViolations(c);
  });

  it("confirms under a standing permission within its limits", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange", maxAmount: "100", currency: "USD", maxUses: 1 });
    await tool(a, "poppy_api_call", { domain: c.domain, operation: "POST /orders/{order_id}/exchanges", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    const state = await c.stub.state();
    expect(state.operations[0]).toMatchObject({ state: "succeeded", approvedBy: "standing_permission" });
    await noViolations(c);
  });

  it("asks the User when a standing permission's limit is exceeded", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange", maxAmount: "10", currency: "USD" });
    await tool(a, "poppy_api_call", { domain: c.domain, operation: "POST /orders/{order_id}/exchanges", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    expect((await cards(a)).find((item) => item.kind === "operation")!.open).toBe(true);
    expect((await c.stub.state()).performs).toBe(0);
  });

  it("never uses a standing permission when the Company requires the User's approval", async () => {
    const c = await company({ userApprovalRequired: true });
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange" });
    await tool(a, "poppy_api_call", { domain: c.domain, operation: "POST /orders/{order_id}/exchanges", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    expect((await c.stub.state()).performs).toBe(0);
    await noViolations(c);
  });

  it("tracks a slow operation to its final state", async () => {
    const { c, a, card } = await proposal({ slowConfirm: true });
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    await until(async () => (await c.stub.state()).operations[0]?.state === "succeeded");
    await until(async () => (await a.stub.poppyNotices()).some((n) => n.includes("is succeeded")));
    expect((await c.stub.state()).performs).toBe(1);
    await noViolations(c);
  });

  it("declines a proposal by cancelling it", async () => {
    const { c, a, card } = await proposal();
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "decline" });
    expect((await c.stub.state()).operations[0]!.state).toBe("cancelled");
    expect((await c.stub.state()).performs).toBe(0);
    await noViolations(c);
  });
});
