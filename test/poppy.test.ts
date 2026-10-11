import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { tokenHostAllowed } from "../src/poppy/discovery";
import { assertPublicHost, fetchJson, PoppyFetchError, type Fetcher } from "../src/poppy/fetch";
import { agentNameFor, createSession } from "../src/session";
import { hostsFor, type MockCompany, type MockConfig, type MockRequest } from "./mock-company";
import worker from "./worker";
import type { PersonalAgent } from "./worker";

/**
 * Conformance tests: the Personal Agent against a strict mock Company. Each
 * `describe` is a section of Personal Agent Protocol Draft 0.1 or the
 * Operations extension. After every test, every mock it created must have
 * recorded no violations, unless the test said which it expects.
 */

type TestEnv = Env & { MOCK_COMPANY: DurableObjectNamespace<MockCompany> };
const testEnv = env as TestEnv;
const ORIGIN = "https://agent.test";

type Company = {
  readonly id: string;
  readonly stub: DurableObjectStub<MockCompany>;
  readonly domain: string;
  readonly hosts: ReturnType<typeof hostsFor>;
  /** This test breaks the protocol on purpose: exactly these violations, and no others. */
  expectViolations(...patterns: RegExp[]): void;
};

/** Every mock Company the current test created, with the violations it expects. */
const created: { company: Company; expected: RegExp[] }[] = [];

/** Violations no pattern expects, and patterns no violation matched. */
function compareViolations(violations: readonly string[], expected: readonly RegExp[]) {
  return {
    unexpected: violations.filter((violation) => !expected.some((pattern) => pattern.test(violation))),
    missing: expected.filter((pattern) => !violations.some((violation) => pattern.test(violation))).map(String)
  };
}

afterEach(async () => {
  const mocks = created.splice(0);
  for (const { company: c, expected } of mocks) {
    const violations = (await c.stub.state()).violations;
    expect(compareViolations(violations, expected), `violations at mock Company ${c.id}`).toEqual({ unexpected: [], missing: [] });
  }
});

async function company(config: Partial<MockConfig> = {}): Promise<Company> {
  const id = `c${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const stub = testEnv.MOCK_COMPANY.getByName(id);
  await stub.configure({ deviceInterval: 1, ...config });
  const entry = { company: undefined as unknown as Company, expected: [] as RegExp[] };
  entry.company = {
    id,
    stub,
    domain: `${id}.shop.test`,
    hosts: hostsFor(id, { issuerTrailingSlash: config.issuerTrailingSlash ?? false }),
    expectViolations: (...patterns) => entry.expected.push(...patterns)
  };
  created.push(entry);
  return entry.company;
}

async function agent() {
  const identity = { provider: "google" as const, sub: `u${crypto.randomUUID()}`, email: "person@workspace.example", domain: "workspace.example" };
  const stub = testEnv.PersonalAgent.getByName(await agentNameFor(identity)) as unknown as DurableObjectStub<PersonalAgent>;
  const cookie = (await createSession(identity, env.SESSION_SECRET)).split(";")[0]!;
  return { stub, cookie };
}

type Agent = Awaited<ReturnType<typeof agent>>;

/** Poll for a card (or anything else a test reads back); notices have `poppyWaitForNotice`. */
async function until<T>(check: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function tool(a: Agent, name: string, args: Record<string, unknown>, callId?: string) {
  return a.stub.poppyTool(name, args, callId);
}

async function cards(a: Agent): Promise<Array<Record<string, any>>> {
  return JSON.parse(await a.stub.poppyCards());
}

async function requests(c: Company): Promise<MockRequest[]> {
  return (await c.stub.state()).requests;
}

/** Direct Sign-In end to end: the test plays the User on the Company's page. */
async function signInDirect(
  a: Agent,
  c: Company,
  scopes = ["poppy:read", "poppy:write"],
  decision: { approve?: boolean; scopes?: string[]; account?: string } = {},
  /** More `poppy_sign_in` arguments: `session`, `account`. */
  args: Record<string, unknown> = {}
) {
  const started = await tool(a, "poppy_sign_in", { domain: c.domain, scopes, reason: "To look at your orders", ...args });
  expect(started.isError).toBe(false);
  if (started.text.includes("signed in with access")) return null;
  const card = (await cards(a)).find((item) => item.kind === "signin_link" && item.open);
  expect(card).toBeDefined();
  const location = await c.stub.approveAuthorization(card!.url, { approve: decision.approve ?? true, account: decision.account ?? "acct_ada", ...(decision.scopes ? { scopes: decision.scopes } : {}) });
  const callback = await worker.fetch(new Request(location, { headers: { Cookie: a.cookie } }), env);
  return { callback, location, text: await callback.text() };
}

/**
 * Readings of questions the draft leaves open (docs/spec-issues.md). Sign-in,
 * Sessions and DPoP, and signing out run under each, so a misreading our
 * client and our mock share can't pass by agreement.
 */
const PROFILES: readonly { name: string; config: Partial<MockConfig> }[] = [
  { name: "lenient aud, no nonces", config: {} },
  { name: "client assertion aud exactly the endpoint called (S1)", config: { clientAssertionAud: "exact" } },
  { name: "a DPoP nonce per origin (S23)", config: { requireNonce: true, nonceScope: "origin" } },
  { name: "one DPoP nonce per Company (S23)", config: { requireNonce: true, nonceScope: "company" } },
  { name: "lenient assertions: no typ or kid needed, 300 s (S2)", config: { strictAssertions: false } },
  { name: "an issuer with a trailing slash, compared exactly (S7)", config: { issuerTrailingSlash: true } }
];

describe("the violation check after each test", () => {
  it("passes exactly the violations a test expects", () => {
    expect(compareViolations([], [])).toEqual({ unexpected: [], missing: [] });
    expect(compareViolations(["[code.pkce] x"], [])).toEqual({ unexpected: ["[code.pkce] x"], missing: [] });
    expect(compareViolations([], [/^\[code\.pkce\]/])).toEqual({ unexpected: [], missing: ["/^\\[code\\.pkce\\]/"] });
    expect(compareViolations(["[code.pkce] x", "[code.reused] y"], [/^\[code\.pkce\]/])).toEqual({ unexpected: ["[code.reused] y"], missing: [] });
  });

  it("lets a test that breaks the protocol on purpose say so", async () => {
    const c = await company();
    c.expectViolations(/^\[secret\.token-in-url\] token sent in URL /);
    const response = await c.stub.fetch(new Request(`${c.hosts.api}/products?access_token=at_not_a_token`));
    expect(response.status).toBe(401);
  });
});

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
  });

  it("follows an HTTPS redirect of the well-known URL", async () => {
    const c = await company({ wellKnownRedirect: "https" });
    const a = await agent();
    const result = await tool(a, "poppy_discover", { domain: c.domain });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).signIn).toEqual(["direct", "device", "mediated"]);
    const seen = (await requests(c)).map((request) => `${request.status} ${request.method} ${request.url}`);
    expect(seen).toContain(`302 GET https://${c.domain}/.well-known/poppy.json`);
    expect(seen).toContain(`200 GET https://cdn.${c.domain}/poppy.json?for=${c.domain}`);
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
    const result = await tool(await agent(), "poppy_discover", { domain: c.domain });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/organization\.domain/);
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
  });
});

describe("Guides: fetching metadata safely", () => {
  const PRIVATE_HOSTS = ["127.0.0.1", "[::1]", "intranet", "x.localhost", "10.0.0.1"];

  it.each(PRIVATE_HOSTS)("never fetches from %s, directly or by redirect", async (host) => {
    const target = `https://${host}/openapi.json`;
    expect(() => assertPublicHost(new URL(target))).toThrow(PoppyFetchError);
    const fetched: string[] = [];
    const answer = (response: () => Response): Fetcher => async (request) => {
      fetched.push(request.url);
      return response();
    };
    await expect(fetchJson(answer(() => Response.json({})), target)).rejects.toThrow(/non-public host/);
    expect(fetched).toEqual([]);
    const redirect = answer(() => new Response(null, { status: 302, headers: { Location: target } }));
    await expect(fetchJson(redirect, "https://public.example/openapi.json")).rejects.toThrow(/non-public host/);
    expect(fetched).toEqual(["https://public.example/openapi.json"]);
  });

  it.each(PRIVATE_HOSTS)("never discovers %s", async (host) => {
    const result = await tool(await agent(), "poppy_discover", { domain: host });
    expect(result.isError).toBe(true);
    // Rejected as no domain at all, or as a host that isn't public.
    expect(result.text).toMatch(/isn't a domain name|isn't a public host/);
  });

  it("fetches a public host's document", async () => {
    expect(() => assertPublicHost(new URL("https://api.shop.example/openapi.json"))).not.toThrow();
    const document = await fetchJson(async () => Response.json({ openapi: "3.1.0" }), "https://api.shop.example/openapi.json");
    expect(document.json).toEqual({ openapi: "3.1.0" });
  });

  it("never fetches an OpenAPI document a Company lists on a private host", async () => {
    const c = await company({ openapiUrlOverride: "https://10.0.0.1/openapi.json" });
    const a = await agent();
    const described = await tool(a, "poppy_api_describe", { domain: c.domain });
    expect(described.isError).toBe(true);
    expect(described.text).toMatch(/non-public host 10\.0\.0\.1/);
  });
});

describe.each(PROFILES)("4.2–4.3 sessions, tokens and DPoP ($name)", ({ config: profile }) => {
  const companyHere = (config: Partial<MockConfig> = {}) => company({ ...profile, ...config });

  it("starts a signed-out Session with a random User ID", async () => {
    const c = await companyHere();
    const a = await agent();
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
    const state = await c.stub.state();
    expect(state.userIds).toHaveLength(1);
    expect(state.userIds[0]).toMatch(/^usr_[A-Za-z0-9_-]{22}$/);
    expect(state.userIds[0]).not.toContain("person");
    expect(state.sessions[0]?.signedIn).toBe(false);
  });

  it("supports DPoP nonces", async () => {
    const c = await companyHere({ requireNonce: true });
    const a = await agent();
    const result = await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    expect(result.isError).toBe(false);
    const seen = await requests(c);
    // Each server asked for a nonce, and the very next request there carried it.
    for (const origin of [new URL(c.hosts.tokenEndpoint).origin, c.hosts.api]) {
      const here = seen.filter((request) => request.url.startsWith(origin) && request.headers.dpop);
      const demanded = here.findIndex((request) => request.error === "use_dpop_nonce");
      expect(demanded, `a nonce demanded at ${origin}`).toBeGreaterThanOrEqual(0);
      expect(here[demanded]!.proofNonce).toBeNull();
      expect(here[demanded + 1]!.proofNonce).toEqual(expect.any(String));
      expect(here[demanded + 1]!.status).toBeLessThan(400);
      expect(here.slice(demanded + 1).every((request) => request.proofNonce !== null)).toBe(true);
    }
    if (profile.nonceScope === "origin") {
      const nonces = new Set(seen.map((request) => request.proofNonce).filter(Boolean));
      expect(nonces.size).toBe(2);
    }
  });

  it("waits out Retry-After on 429 before retrying", async () => {
    const c = await companyHere({ rateLimit: { tokenRequests429: 1, requests429: 1, retryAfterSeconds: 1 } });
    const a = await agent();
    const result = await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    expect(result.isError).toBe(false);
    // The client waited at least a second, twice, on the fake clock...
    expect((await a.stub.poppyClock()).sleeps.filter((ms) => ms >= 1000)).toHaveLength(2);
    // ...and the Company saw each retry at least a second after its 429.
    const seen = (await requests(c)).filter((request) => request.method === "POST");
    const limited = seen.filter((request) => request.status === 429);
    expect(limited).toHaveLength(2);
    for (const refused of limited) {
      const path = new URL(refused.url).pathname;
      const retry = seen.find((request) => request.at > refused.at && new URL(request.url).pathname === path)!;
      expect(retry.at - refused.at).toBeGreaterThanOrEqual(1000);
    }
  });

  it("reports a Company that hasn't registered this agent", async () => {
    const c = await companyHere({ requireRegistration: ["https://someone-else.test/client.json"] });
    const result = await tool(await agent(), "poppy_message", { domain: c.domain, text: "hello" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/invalid_client/);
  });

  it("gets new tokens with a new DPoP key after an eviction", async () => {
    const c = await companyHere();
    const a = await agent();
    await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    await a.stub.poppyForgetMemory();
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello again" })).isError).toBe(false);
    expect((await c.stub.state()).sessions.filter((s) => !s.ended)).toHaveLength(1);
  });
});

describe.each(PROFILES)("4.4–4.5 Direct Sign-In ($name)", ({ config: profile }) => {
  const companyHere = (config: Partial<MockConfig> = {}) => company({ ...profile, ...config });
  const codeExchanges = async (c: Company) => (await requests(c)).filter((request) => request.grant === "authorization_code");

  it("signs in through the Company's page and checks state and iss", async () => {
    const c = await companyHere();
    const a = await agent();
    const result = await signInDirect(a, c);
    expect(result!.callback.status).toBe(200);
    const status = JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);
    expect(status.sessions[0]).toMatchObject({ signedIn: true, scope: "poppy:read poppy:write" });
    expect((await c.stub.state()).accountTokens).toBe(1);
    expect((await a.stub.poppyNotices()).some((n) => n.includes(`Signed in to Mock Shop ${c.id}`))).toBe(true);
  });

  it("uses each state once", async () => {
    const c = await companyHere();
    const a = await agent();
    const result = await signInDirect(a, c);
    expect(result!.callback.status).toBe(200);
    expect(await codeExchanges(c)).toHaveLength(1);
    // The same redirect again: our client refuses it before any token request.
    const again = await worker.fetch(new Request(result!.location, { headers: { Cookie: a.cookie } }), env);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("already used");
    expect(await codeExchanges(c)).toHaveLength(1);
  });

  it("rejects a response whose iss isn't the Company's issuer", async () => {
    const c = await companyHere();
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_link")!;
    const location = new URL(await c.stub.approveAuthorization(card.url, { approve: true, account: "acct_ada" }));
    location.searchParams.set("iss", "https://auth.evil.shop.test");
    const callback = await worker.fetch(new Request(location.href, { headers: { Cookie: a.cookie } }), env);
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("come from the expected company");
    expect(await codeExchanges(c)).toHaveLength(0);
    expect((await c.stub.state()).accountTokens).toBe(0);
  });

  it("needs the person's own app session for the callback", async () => {
    const c = await companyHere();
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_link")!;
    const location = await c.stub.approveAuthorization(card.url, { approve: true, account: "acct_ada" });
    const callback = await worker.fetch(new Request(location), env);
    expect(callback.status).toBe(401);
    expect(await codeExchanges(c)).toHaveLength(0);
  });

  it("notices when the User approves fewer scopes", async () => {
    const c = await companyHere();
    const a = await agent();
    await signInDirect(a, c, ["poppy:read", "poppy:write"], { scopes: ["poppy:read"] });
    expect((await a.stub.poppyNotices()).some((n) => n.includes('not granted "poppy:write"'))).toBe(true);
  });

  it("handles a declined sign-in", async () => {
    const c = await companyHere();
    const a = await agent();
    const result = await signInDirect(a, c, ["poppy:read"], { approve: false });
    expect(result!.callback.status).toBe(400);
    expect((await a.stub.poppyNotices()).some((n) => n.includes("the User declined"))).toBe(true);
    expect(await codeExchanges(c)).toHaveLength(0);
  });

  it("reuses an Account Token that covers the task instead of asking again", async () => {
    const c = await companyHere();
    const a = await agent();
    await signInDirect(a, c);
    const again = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "again", session: "second" });
    expect(again.text).toContain("signed in with access the User granted earlier");
  });

  it("steps up: signs in again for more scopes and revokes the old Account Token", async () => {
    const c = await companyHere();
    const a = await agent();
    await signInDirect(a, c, ["poppy:read"]);
    await signInDirect(a, c, ["poppy:read", "poppy:write"]);
    const state = await c.stub.state();
    expect(state.accountTokens).toBe(1);
    expect(state.revocationHints).toEqual(["refresh_token"]);
  });
});

describe.each(PROFILES)("4.6 Device Sign-In ($name)", ({ config: profile }) => {
  const companyHere = (config: Partial<MockConfig> = {}) => company({ ...profile, ...config });
  const polls = async (c: Company) =>
    (await requests(c)).filter((request) => request.grant === "urn:ietf:params:oauth:grant-type:device_code");

  it("shows the code, polls at the interval and signs in when the User approves", async () => {
    const c = await companyHere({ signIn: { direct: null, device: ["poppy:read", "poppy:write"], mediated: null } });
    const a = await agent();
    const started = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    expect(started.text).toContain("device");
    const card = (await cards(a)).find((item) => item.kind === "signin_device")!;
    expect(card.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(JSON.stringify(card)).not.toContain("device_code");
    // Nothing before the interval; one poll once it has passed.
    await a.stub.poppyAdvance(500);
    expect(await polls(c)).toHaveLength(0);
    await a.stub.poppyAdvance(500);
    expect((await polls(c)).map((poll) => poll.error)).toEqual(["authorization_pending"]);
    await c.stub.approveDevice(card.userCode, { account: "acct_ada" });
    await a.stub.poppyAdvance(1000);
    await a.stub.poppyWaitForNotice("Signed in to");
    const [first, second] = await polls(c);
    expect(second!.status).toBe(200);
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(1000);
  });

  it("stops when the User declines", async () => {
    const c = await companyHere({ signIn: { direct: null, device: ["poppy:read"], mediated: null } });
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_device")!;
    await c.stub.denyDevice(card.userCode);
    await a.stub.poppyAdvance(1000);
    await a.stub.poppyWaitForNotice("the User declined");
    // No more polls, however long we wait.
    await a.stub.poppyAdvance(60_000);
    expect((await polls(c)).map((poll) => poll.error)).toEqual(["access_denied"]);
  });
});

describe.each(PROFILES)("4.7 Mediated Sign-In ($name)", ({ config: profile }) => {
  const mediatedOnly = { ...profile, signIn: { direct: null, device: null, mediated: ["poppy:read"] } };

  it("sends the credentials only to the endpoint, never to the model, logs or storage", async () => {
    const c = await company(mediatedOnly);
    const a = await agent();
    const logMark = await a.stub.poppyLogMark();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_credentials")!;
    expect(card.fields.find((field: { name: string }) => field.name === "password").secret).toBe(true);
    await a.stub.poppyFrame({ type: "poppy.credentials", signInId: card.signInId, values: { email: "ada@example.com", password: "correct horse" } });
    const status = JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);
    expect(status.sessions[0].signedIn).toBe(true);
    // The model's notices, the cards, and every table in the agent's storage.
    expect(JSON.stringify(await a.stub.poppyNotices())).not.toContain("correct horse");
    expect(await a.stub.poppyCards()).not.toContain("correct horse");
    expect(await a.stub.poppyDumpStorage()).not.toContain("correct horse");
    // Everything written to the console meanwhile; the probe shows the capture works.
    console.log("poppy log capture probe");
    const logs = (await a.stub.poppyLogsSince(logMark)).join("\n");
    expect(logs).toContain("poppy log capture probe");
    expect(logs).not.toContain("correct horse");
    // The mock saw the password once, in the body of the mediated endpoint (and nowhere else, or it would be a violation).
    const sent = (await requests(c)).filter((request) => request.bodyKeys.includes("credentials"));
    expect(sent.map((request) => request.url)).toEqual([c.hosts.mediatedEndpoint]);
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
    expect(await a.stub.poppyDumpStorage()).not.toContain("battery staple");
    const submitted = (await requests(c)).filter((request) => request.url.startsWith(`${c.hosts.mediatedEndpoint}/`));
    expect(submitted.map((request) => request.bodyKeys)).toEqual([["code"]]);
  });

  it("reports a wrong password without retrying", async () => {
    const c = await company(mediatedOnly);
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_credentials")!;
    await a.stub.poppyFrame({ type: "poppy.credentials", signInId: card.signInId, values: { email: "ada@example.com", password: "wrong" } });
    expect((await a.stub.poppyNotices()).some((n) => n.includes("didn't complete"))).toBe(true);
    expect((await requests(c)).filter((request) => request.url === c.hosts.mediatedEndpoint)).toHaveLength(1);
  });
});

describe.each(PROFILES)("4.8–4.9 Account Tokens and signing out ($name)", ({ config: profile }) => {
  const companyHere = (config: Partial<MockConfig> = {}) => company({ ...profile, ...config });

  it("uses a rotated Account Token from then on", async () => {
    const c = await companyHere({ rotateRefreshTokens: true });
    const a = await agent();
    await signInDirect(a, c);
    for (let i = 0; i < 2; i++) {
      await a.stub.poppyForgetMemory();
      expect((await tool(a, "poppy_message", { domain: c.domain, text: `hello ${i}` })).isError).toBe(false);
    }
    expect((await requests(c)).filter((request) => request.grant === "refresh_token" && request.status === 200).length).toBeGreaterThanOrEqual(2);
  });

  it("signs out by revoking the Account Token; the Session continues signed out", async () => {
    const c = await companyHere();
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    const state = await c.stub.state();
    expect(state.accountTokens).toBe(0);
    // RFC 7009 makes the hint optional; we send it.
    expect(state.revocationHints).toEqual(["refresh_token"]);
    await a.stub.poppyForgetMemory();
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "still there?" })).isError).toBe(false);
    const status = JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);
    expect(status.sessions[0].signedIn).toBe(false);
  });

  it("continues signed out when the User disconnects the agent at the Company", async () => {
    const c = await companyHere();
    const a = await agent();
    await signInDirect(a, c);
    await c.stub.revokeAllForAccount("acct_ada");
    await a.stub.poppyForgetMemory();
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
    expect((await cards(a)).some((card) => card.kind === "notice" && card.text.includes("ended this agent's access"))).toBe(true);
    expect(await a.stub.poppySql("SELECT * FROM poppy_accounts")).toBe("[]");
  });

  it("stores Account Tokens encrypted", async () => {
    const c = await companyHere();
    const a = await agent();
    await signInDirect(a, c);
    const rows = JSON.parse(await a.stub.poppySql("SELECT issuer, account, token FROM poppy_accounts")) as { issuer: string; account: string; token: string }[];
    expect(rows).toHaveLength(1);
    const [token] = await c.stub.accountTokenValues();
    const stored = rows[0]!.token;
    expect(token).toMatch(/^pat_/);
    expect(stored).not.toContain(token);
    const base64 = btoa(token!);
    expect(stored).not.toContain(base64.replace(/=+$/, ""));
    expect(stored).not.toContain(base64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
    // Sealed for its own row: it opens there and nowhere else.
    const [{ user_id: userId }] = JSON.parse(await a.stub.poppySql("SELECT user_id FROM poppy_user_ids")) as { user_id: string }[];
    const context = (account: string, issuer = rows[0]!.issuer) => `account|${issuer}|${userId}|${account}`;
    expect(await a.stub.poppyOpenSealed(stored, context(rows[0]!.account))).toBe(token);
    expect(await a.stub.poppyOpenSealed(stored, context("someone-else"))).toBeNull();
    expect(await a.stub.poppyOpenSealed(stored, context(rows[0]!.account, "https://auth.other.shop.test"))).toBeNull();
  });
});

describe("4.4, 4.8 token responses without scope (spec issue N6)", () => {
  const status = async (a: Agent, c: Company) => JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);

  it("takes an omitted scope as the scope asked for, at sign-in, renewal and refresh", async () => {
    const c = await company({ omitTokenScope: true });
    const a = await agent();
    // Sign-in: what was asked for was granted, so nothing is reported missing.
    await signInDirect(a, c);
    expect(await a.stub.poppyWaitForNotice("Signed in to")).toContain('with "poppy:read poppy:write"');
    expect(JSON.parse(await a.stub.poppySql("SELECT scope FROM poppy_accounts"))).toEqual([{ scope: "poppy:read poppy:write" }]);
    // Renewal after an eviction: a refresh grant that asks for no scope keeps the Account Token's.
    await a.stub.poppyForgetMemory();
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
    expect((await status(a, c)).sessions[0]).toMatchObject({ signedIn: true, scope: "poppy:read poppy:write" });
    // A second Session: the stored scope covers the task, so the User isn't asked again.
    const again = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "again", session: "second" });
    expect(again.text).toContain("signed in with access the User granted earlier");
    // A narrowed read-only refresh gets the scope it asked for.
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /orders", session: "second" })).text).toContain("ord_7Hk2");
    const refreshes = (await requests(c)).filter((request) => request.grant === "refresh_token");
    expect(refreshes.some((request) => request.bodyKeys.includes("scope") && request.status === 200)).toBe(true);
  });

  it("keeps a signed-out Session's empty scope when the response leaves it out", async () => {
    const c = await company({ omitTokenScope: true });
    const a = await agent();
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } })).isError).toBe(false);
    expect((await status(a, c)).sessions[0]).toMatchObject({ signedIn: false, scope: "" });
  });
});

describe("4.4 one account per Session", () => {
  it("starts a new Session when the Company says it belongs to another account (account_mismatch)", async () => {
    const c = await company();
    const a = await agent();
    // Ada signs in on the main Session, Grace on another.
    await signInDirect(a, c, ["poppy:read"], { account: "acct_ada" });
    await signInDirect(a, c, ["poppy:read"], { account: "acct_grace" }, { session: "other", account: "grace" });
    // Ada signs out; the main Session continues signed out, but the Company keeps it bound to Ada.
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } })).isError).toBe(false);
    const [main] = JSON.parse(await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE label = 'main'")) as { session_id: string }[];
    // The main Session now needs Grace's account: the Company refuses to switch it, so a new one starts.
    const signedIn = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "Grace's orders", account: "grace" });
    expect(signedIn.text).toContain("signed in with access the User granted earlier");
    expect((await requests(c)).filter((request) => request.error === "account_mismatch")).toHaveLength(1);
    const [after] = JSON.parse(await a.stub.poppySql("SELECT session_id, account FROM poppy_sessions WHERE label = 'main'")) as { session_id: string; account: string }[];
    expect(after!.session_id).not.toBe(main!.session_id);
    expect(after!.account).toBe("grace");
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /orders" })).text).toContain("acct_grace");
  });
});

describe("4.8 rotation with reuse detection", () => {
  it("never uses a rotated Account Token twice, even when renewals run in parallel", async () => {
    const c = await company({ rotateRefreshTokens: true, reuseDetection: true });
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyForgetMemory();
    // Three calls at once, each needing its own token from the one Account Token.
    const results = await Promise.all([
      tool(a, "poppy_message", { domain: c.domain, text: "hello" }),
      tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /orders" }),
      tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } })
    ]);
    for (const result of results) expect(result.isError, result.text).toBe(false);
    const refreshes = (await requests(c)).filter((request) => request.grant === "refresh_token");
    expect(refreshes.length).toBeGreaterThanOrEqual(2);
    expect(refreshes.every((request) => request.status === 200)).toBe(true);
    // A reuse would have revoked the whole family and signed the User out.
    expect((await c.stub.state()).accountTokens).toBe(1);
    expect((await cards(a)).some((card) => card.kind === "notice" && card.text.includes("ended this agent's access"))).toBe(false);
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
    const browsed = (await requests(c)).filter(
      (request) => request.url.startsWith(`https://${c.domain}/`) && !request.url.includes("/.well-known/")
    );
    expect(browsed.map((request) => `${request.method} ${new URL(request.url).pathname} ${request.status}`)).toEqual([
      "POST /poppy/browser-session 303",
      "GET /orders 200",
      "GET /orders 200"
    ]);
  });

  it("browses only the Company's own domain", async () => {
    const c = await company();
    const result = await tool(await agent(), "poppy_browse", { domain: c.domain, action: "open", url: "https://elsewhere.test/" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`limited to ${c.domain}`);
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
    expect(result.text).toContain("never types credentials");
  });

  it("waits out Retry-After on a website page, then loads it again (4.3)", async () => {
    const c = await company({ rateLimit: { tokenRequests429: 0, requests429: 0, pages429: 1, retryAfterSeconds: 2 } });
    const a = await agent();
    const page = await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: "/" });
    expect(page.isError).toBe(false);
    expect(page.text).toContain(`Mock Shop ${c.id}`);
    expect((await a.stub.poppyClock()).sleeps).toContain(2000);
    const loads = (await requests(c)).filter((request) => request.method === "GET" && request.url === `https://${c.domain}/`);
    expect(loads.map((request) => request.status)).toEqual([429, 200]);
    expect(loads[1]!.at - loads[0]!.at).toBeGreaterThanOrEqual(2000);
  });

  it("gives up on a website page whose Retry-After is too long to wait inline", async () => {
    const c = await company({ rateLimit: { tokenRequests429: 0, requests429: 0, pages429: 1, retryAfterSeconds: 30 } });
    const a = await agent();
    const page = await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: "/" });
    expect(page.isError).toBe(true);
    expect(page.text).toContain("[rate_limited]");
    // Nor does the next page go before the 30 seconds are up.
    expect((await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: "/orders" })).text).toContain("[rate_limited]");
    const loads = (await requests(c)).filter((request) => request.method === "GET" && request.url.startsWith(`https://${c.domain}/`) && !request.url.includes("/.well-known/"));
    expect(loads.map((request) => request.status)).toEqual([429]);
  });
});

describe("6 APIs", () => {
  it("lists and calls OpenAPI operations with DPoP", async () => {
    const c = await company();
    const a = await agent();
    const described = JSON.parse((await tool(a, "poppy_api_describe", { domain: c.domain })).text);
    expect(described.operations.map((operation: { method: string; path: string }) => `${operation.method} ${operation.path}`)).toEqual([
      "GET /products",
      "GET /orders",
      "GET /addresses",
      "GET /orders/{order_id}",
      "GET /orders/{order_id}/items/{item_id}",
      "POST /orders/{order_id}/exchanges"
    ]);
    const products = await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "insulated" } });
    expect(products.isError).toBe(false);
    expect(products.text).toContain("stormline-insulated-m");
    expect(products.text).not.toContain('"stormline-m"');
    const call = (await requests(c)).find((request) => request.url.startsWith(`${c.hosts.api}/products`))!;
    expect(call.url).toBe(`${c.hosts.api}/products?q=insulated`);
    expect(call.headers.authorization).toBe("DPoP <redacted>");
    expect(call.headers.dpop).toBe("<present>");
  });

  it("fills a path template the description doesn't declare as a parameter, by name", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "getOrderItem", params: { order_id: "ord_7Hk2", item_id: "itm_4Qa" } });
    expect(result.isError, result.text).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ status: 200, body: { item_id: "itm_4Qa" } });
    const sent = (await requests(c)).filter((request) => request.url.startsWith(`${c.hosts.api}/orders/`)).map((request) => request.url);
    expect(sent).toEqual([`${c.hosts.api}/orders/ord_7Hk2/items/itm_4Qa`]);
  });

  it("refuses a path it can't fill before any request, not sending the template", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const before = (await requests(c)).length;
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /orders/{order_id}/items/{item_id}", params: { order_id: "ord_7Hk2" } });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("GET /orders/{order_id}/items/{item_id} needs the path parameter item_id, which the call doesn't give [invalid_request]");
    // Only the description was fetched: no token request, and nothing sent to the operation's path.
    const after = (await requests(c)).slice(before);
    expect(after.filter((request) => request.grant !== null || request.url.startsWith(`${c.hosts.api}/orders`))).toEqual([]);
    expect(after.some((request) => request.url.includes("%7B"))).toBe(false);
    // A write at a Company without operations isn't proposed to the User either.
    const plain = await company({ operations: false });
    await signInDirect(a, plain);
    const write = await tool(a, "poppy_api_call", { domain: plain.domain, operation: "exchangeItem", body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    expect(write.text).toContain("Missing parameter order_id [invalid_request]");
    expect((await cards(a)).filter((card) => card.kind === "approval")).toEqual([]);
  });

  it("starts a new Session when the Company says the old one ended", async () => {
    for (const endedSessionError of ["invalid_token", "invalid_session"] as const) {
      const c = await company({ endedSessionError });
      const a = await agent();
      const call = () => tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } });
      expect((await call()).isError).toBe(false);
      expect(await c.stub.endAllSessions()).toBe(1);
      expect((await call()).isError).toBe(false);
      const state = await c.stub.state();
      expect(state.sessions.filter((session) => !session.ended)).toHaveLength(1);
    }
  });

  it("asks for sign-in when an API needs the account", async () => {
    const c = await company();
    const a = await agent();
    const orders = await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /orders" });
    expect(orders.text).toMatch(/sign_in_required/);
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
  });

  it("says which error refused an approved write", async () => {
    const c = await company({ operations: false });
    const a = await agent();
    await signInDirect(a, c, ["poppy:read"]);
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    expect(result.text).toContain("Waiting for the User's approval");
    const card = (await cards(a)).find((item) => item.kind === "approval")!;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    const after = (await cards(a)).find((item) => item.kind === "approval")!;
    expect(after).toMatchObject({ status: "failed" });
    expect(after.result).toMatch(/insufficient_scope \[insufficient_scope\]$/);
    expect((await c.stub.state()).performs).toBe(0);
  });

  it("calls MCP tools with a Bearer token issued for that server only", async () => {
    const c = await company();
    const a = await agent();
    const tools = JSON.parse((await tool(a, "poppy_mcp_list", { domain: c.domain })).text);
    expect(tools.tools.map((t: { name: string }) => t.name)).toContain("search_products");
    const result = await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Stormline Jacket (M), Stormline Insulated Jacket (M)");
    const seen = await requests(c);
    // A Bearer token asked for the MCP server by name, without DPoP...
    const tokenRequests = seen.filter((request) => request.url === c.hosts.tokenEndpoint && request.bodyKeys.includes("resource"));
    expect(tokenRequests.length).toBeGreaterThan(0);
    for (const request of tokenRequests) expect(request.headers.dpop).toBeUndefined();
    // ...and used only there.
    const mcp = seen.filter((request) => request.url === c.hosts.mcpUrl);
    expect(mcp.length).toBeGreaterThan(0);
    for (const request of mcp) expect(request.headers.authorization).toBe("Bearer <redacted>");
    for (const request of seen.filter((request) => request.url.startsWith(c.hosts.api))) {
      expect(request.headers.authorization ?? "DPoP").toMatch(/^DPoP/);
    }
  });

  it("refuses an MCP server whose metadata doesn't name the issuer", async () => {
    const c = await company({ mcpPrmOmitIssuer: true });
    const result = await tool(await agent(), "poppy_mcp_list", { domain: c.domain });
    expect(result.isError).toBe(true);
    expect((await requests(c)).filter((request) => request.url === c.hosts.mcpUrl && request.headers.authorization)).toHaveLength(0);
  });

  it("never sends a Session Token to a server on another host that an OpenAPI description names (N10)", async () => {
    const elsewhere = await company();
    const c = await company({ openapiServerOverride: elsewhere.hosts.api });
    const a = await agent();
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`names the server ${elsewhere.hosts.api}, which isn't one of Mock Shop ${c.id}'s hosts`);
    expect(result.text).toContain("[untrusted_server]");
    expect(await requests(elsewhere)).toEqual([]);
    expect((await requests(c)).filter((request) => request.url === c.hosts.tokenEndpoint)).toEqual([]);
  });

  it("calls a server on a domain the issuer lists in poppy_domains", async () => {
    const c = await company();
    const server = `https://api.${c.hosts.altDomain}`;
    await c.stub.configure({ openapiServerOverride: server });
    const a = await agent();
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } });
    expect(result.isError).toBe(false);
    const call = (await requests(c)).find((request) => request.url.startsWith(`${server}/products`))!;
    expect(call.headers.authorization).toBe("DPoP <redacted>");
  });

  it("decides which hosts may get Session Tokens from poppy.json alone", () => {
    const company = {
      domain: "shop.example",
      poppyDomains: ["shop.example", "shop-uk.example"],
      apis: [{ type: "openapi", url: "https://apis.partner.example/openapi.json", description: "" }],
      signIn: {},
      extensions: {}
    } as unknown as Parameters<typeof tokenHostAllowed>[0];
    const allowed = (url: string) => tokenHostAllowed(company, new URL(url));
    expect(allowed("https://shop.example/x")).toBe(true);
    expect(allowed("https://api.shop.example/x")).toBe(true);
    expect(allowed("https://api.shop-uk.example/x")).toBe(true);
    expect(allowed("https://apis.partner.example/orders")).toBe(true);
    expect(allowed("https://partner.example/orders")).toBe(false);
    expect(allowed("https://evilshop.example/x")).toBe(false);
    expect(allowed("https://shop.example.evil.test/x")).toBe(false);
  });

  it("keeps the custom scope a read-only lookup needs when it narrows the token", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c, ["poppy:read", "addresses"]);
    const result = await tool(a, "poppy_api_call", { domain: c.domain, operation: "listAddresses" });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain("Portland");
    const narrowed = (await requests(c)).filter((request) => request.grant === "refresh_token" && request.bodyKeys.includes("scope"));
    expect(narrowed.map((request) => request.status)).toEqual([200]);
    // The token was narrowed for the lookup; the Session wasn't.
    expect(JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text).sessions[0].scope).toBe("poppy:read addresses");
  });

  it("narrows read-only lookups at a Company that has only custom scopes", async () => {
    const c = await company({ customScopesOnly: true });
    const a = await agent();
    await signInDirect(a, c, ["orders:read", "orders:write"]);
    const orders = await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
    expect(orders.isError, orders.text).toBe(false);
    expect(orders.text).toContain("ord_7Hk2");
    const narrowed = (await requests(c)).filter((request) => request.grant === "refresh_token" && request.bodyKeys.includes("scope"));
    expect(narrowed.map((request) => request.status)).toEqual([200]);
    // A write still gets the whole Session's scope.
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } })).text).toContain("proposed");
  });

  it("asks for tokens for an API entry's resource, and sends them there (RFC 8707)", async () => {
    const c = await company({ apiResource: true });
    const a = await agent();
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } })).isError).toBe(false);
    await signInDirect(a, c);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "GET /orders" })).text).toContain("ord_7Hk2");
    // Conversations name no resource, so theirs is a token for the Company in general.
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
    const forResource = (await requests(c)).filter((request) => request.url === c.hosts.tokenEndpoint && request.bodyKeys.includes("resource"));
    expect(forResource.map((request) => request.grant)).toEqual(expect.arrayContaining(["urn:ietf:params:oauth:grant-type:jwt-bearer", "refresh_token"]));
    for (const request of forResource) expect(request.headers.dpop).toBe("<present>");
  });

  it("tells the model which extension a Company requires (extension_required)", async () => {
    const c = await company({ requiredExtension: "mock.test/gift-wrap" });
    const a = await agent();
    await signInDirect(a, c);
    const result = await tool(a, "poppy_api_call", {
      domain: c.domain,
      operation: "POST /orders/{order_id}/exchanges",
      params: { order_id: "ord_7Hk2" },
      body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("requires the extension mock.test/gift-wrap, which this agent doesn't support [extension_required]");
    // The extension is a field of its own, not only words in the message.
    expect(JSON.parse(result.details)).toEqual({ error: "extension_required", extension: "mock.test/gift-wrap" });
    expect((await c.stub.state()).performs).toBe(0);
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
  });

  it("refuses JSON in text", async () => {
    const c = await company();
    const result = await tool(await agent(), "poppy_message", { domain: c.domain, text: '{"order": 1042}' });
    expect(result.isError).toBe(true);
    expect((await c.stub.state()).conversations).toHaveLength(0);
  });

  it("resends the same message id when a tool call is replayed", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_message", { domain: c.domain, text: "hello" }, "call-1");
    await tool(a, "poppy_message", { domain: c.domain, text: "hello" }, "call-1");
    const state = await c.stub.state();
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0]!.sent).toEqual(["agent:hello"]);
  });

  it("reads later events in the background, streaming, and tells the model", async () => {
    const c = await company({ streaming: true, textDeltas: true });
    const a = await agent();
    const result = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.say(result.conversationId, "One more thing: we have a sale on.");
    await a.stub.poppyWaitForNotice("we have a sale on");
  });

  it("handles an authorization event, then continues signed in", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "I'd like to return order ord_7Hk2" })).text);
    await a.stub.poppyWaitForNotice("needs the User signed in");
    await signInDirect(a, c);
    await tool(a, "poppy_message", { domain: c.domain, conversation: first.conversationId, text: "I'm signed in now; please exchange it for the insulated one." });
    await until(async () => (await cards(a)).find((card) => card.kind === "operation" && card.open));
  });

  it("hands off to a person after a summary", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    const handed = JSON.parse((await tool(a, "poppy_handoff", { conversation: first.conversationId, summary: "The jacket isn't warm enough; the user wants an exchange." })).text);
    expect(handed.status).toBe("queued");
    await c.stub.humanJoin(first.conversationId, "Hi, I'm Sam. I can help with that.");
    await a.stub.poppyWaitForNotice("A person at");
    const sent = (await c.stub.state()).conversations[0]!.sent;
    expect(sent.at(-1)).toContain("isn't warm enough");
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
  });

  it("keeps the model's own words out of the User's Direct Conversation (7.10)", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.pushEvent(first.conversationId, { type: "user_requested", reason: "A specialist needs to confirm the exchange." });
    await until(async () => (await cards(a)).find((card) => card.kind === "direct_invite"));
    await a.stub.poppyFrame({ type: "poppy.direct.start", conversationId: first.conversationId, text: "Hi, it's me." });
    const direct = (await c.stub.state()).conversations.find((conv) => conv.direct)!;
    const said = await tool(a, "poppy_message", { domain: c.domain, conversation: direct.id, text: "The user means the medium." });
    expect(said.isError).toBe(true);
    expect(said.text).toContain("Direct Conversation");
    const handed = await tool(a, "poppy_handoff", { conversation: direct.id, summary: "The user wants the medium." });
    expect(handed.isError).toBe(true);
    await a.stub.poppyFrame({ type: "poppy.direct.say", conversationId: direct.id, text: "Medium, please." });
    expect((await c.stub.state()).conversations.find((conv) => conv.direct)!.sent).toEqual(["human:Hi, it's me.", "human:Medium, please."]);
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
  });

  it("skips event types it doesn't know", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.pushEvent(first.conversationId, { type: "example.test/confetti", colour: "gold" });
    await c.stub.say(first.conversationId, "After the confetti.");
    await a.stub.poppyWaitForNotice("After the confetti.");
    expect((await a.stub.poppyNotices()).join("\n")).not.toContain("confetti\"");
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
  });

  it("gets the reply by background read from a Company that ignores wait", async () => {
    const c = await company({ ignoreWait: true });
    const a = await agent();
    const result = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    expect(result.replies).toEqual([]);
    await a.stub.poppyWaitForNotice("Hi! How can I help?");
  });

  it("hands off to a Company that never says queued", async () => {
    const c = await company({ neverQueued: true });
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    const handed = JSON.parse((await tool(a, "poppy_handoff", { conversation: first.conversationId, summary: "The jacket isn't warm enough; the user wants an exchange." })).text);
    expect(handed.status).toBe("working");
    await c.stub.humanJoin(first.conversationId, "Hi, I'm Sam. I can help with that.");
    await a.stub.poppyWaitForNotice("A person at");
  });

  it("skips SSE keep-alive comments and saves the cursor after each event", async () => {
    const c = await company({ streaming: true, textDeltas: true, sseKeepAlive: true });
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.say(first.conversationId, "The sale ends on Friday.");
    await a.stub.poppyWaitForNotice("The sale ends on Friday.");
    const [row] = JSON.parse(await a.stub.poppySql("SELECT cursor FROM poppy_conversations WHERE id = ?", first.conversationId)) as { cursor: string }[];
    const [last] = JSON.parse(await a.stub.poppySql("SELECT event_id FROM poppy_events WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1", first.conversationId)) as { event_id: string }[];
    expect(row!.cursor).toBe(last!.event_id);
  });
});

describe("Operations extension", () => {
  const exchangeCall = (c: Company) => ({
    domain: c.domain,
    operation: "POST /orders/{order_id}/exchanges",
    params: { order_id: "ord_7Hk2" },
    body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
  });

  async function proposal(config: Partial<MockConfig> = {}) {
    const c = await company(config);
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_api_call", exchangeCall(c));
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
  });

  it("needs a new approval when the terms change", async () => {
    const { c, a, card } = await proposal();
    await c.stub.reviseOperation(card.operationId, "Exchange for size L instead, for $70.00 more.", { size: "L", price_difference: { amount: "70.00", currency: "USD" } });
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    const updated = (await cards(a)).find((item) => item.kind === "operation" && item.revision === 2)!;
    expect(updated.open).toBe(true);
    expect(updated.previousSummary).toBe(card.summary);
    expect((await c.stub.state()).performs).toBe(0);
  });

  it("confirms under a standing permission within its limits", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange", maxAmount: "100", currency: "USD", maxUses: 1 });
    await tool(a, "poppy_api_call", exchangeCall(c));
    const state = await c.stub.state();
    expect(state.operations[0]).toMatchObject({ state: "succeeded", approvedBy: "standing_permission" });
  });

  it("asks the User once a standing permission's uses are spent", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange", maxAmount: "100", currency: "USD", maxUses: 1 });
    await tool(a, "poppy_api_call", exchangeCall(c));
    expect((await c.stub.state()).operations[0]).toMatchObject({ state: "succeeded", approvedBy: "standing_permission" });
    // A second exchange: the one use is spent, so the User decides.
    await tool(a, "poppy_api_call", exchangeCall(c));
    const state = await c.stub.state();
    expect(state.operations).toHaveLength(2);
    expect(state.operations[1]).toMatchObject({ state: "proposed", confirms: 0 });
    expect(state.performs).toBe(1);
    expect((await cards(a)).find((item) => item.kind === "operation" && item.operationId === state.operations[1]!.id)!.open).toBe(true);
  });

  it("asks the User when a standing permission's limit is exceeded", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange", maxAmount: "10", currency: "USD" });
    await tool(a, "poppy_api_call", exchangeCall(c));
    expect((await cards(a)).find((item) => item.kind === "operation")!.open).toBe(true);
    expect((await c.stub.state()).performs).toBe(0);
  });

  it("asks the User when a standing permission's currency differs", async () => {
    const c = await company({ exchangePrice: { amount: "70.00", currency: "EUR" } });
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange", maxAmount: "100", currency: "USD" });
    await tool(a, "poppy_api_call", exchangeCall(c));
    expect((await cards(a)).find((item) => item.kind === "operation")!.open).toBe(true);
    const state = await c.stub.state();
    expect(state.operations[0]).toMatchObject({ state: "proposed", confirms: 0 });
    expect(state.performs).toBe(0);
  });

  it("never uses a standing permission when the Company requires the User's approval", async () => {
    const c = await company({ userApprovalRequired: true });
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange" });
    await tool(a, "poppy_api_call", exchangeCall(c));
    const state = await c.stub.state();
    expect(state.performs).toBe(0);
    expect(state.operations[0]).toMatchObject({ state: "proposed", confirms: 0 });
  });

  it("tracks a slow operation to its final state", async () => {
    const { c, a, card } = await proposal({ slowConfirm: true });
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    expect((await c.stub.state()).operations[0]?.state).toBe("in_progress");
    // The Company said Retry-After: 1; nothing is read before then.
    await a.stub.poppyAdvance(999);
    expect((await c.stub.state()).operations[0]?.state).toBe("in_progress");
    await a.stub.poppyAdvance(1);
    await a.stub.poppyWaitForNotice("is succeeded");
    const state = await c.stub.state();
    expect(state.operations[0]?.state).toBe("succeeded");
    expect(state.performs).toBe(1);
    const operationUrl = `${c.hosts.operationsEndpoint}/${card.operationId}`;
    const confirmed = state.requests.find((request) => request.url === `${operationUrl}/confirm`)!;
    const read = state.requests.find((request) => request.method === "GET" && request.url === operationUrl)!;
    expect(read.at - confirmed.at).toBeGreaterThanOrEqual(1000);
  });

  it("doesn't ask for a new proposal while a confirmed operation isn't final (Ops 6)", async () => {
    const { c, a, card } = await proposal({ slowConfirm: true });
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    expect((await c.stub.state()).operations[0]?.state).toBe("in_progress");
    const requests = (await c.stub.state()).requests.length;
    const again = await tool(a, "poppy_api_call", exchangeCall(c));
    expect(again.isError).toBe(true);
    expect(again.text).toContain(card.operationId);
    expect((await c.stub.state()).requests.length).toBe(requests);
    // Once it is final, the same request may propose again.
    await a.stub.poppyAdvance(1000);
    await a.stub.poppyWaitForNotice("is succeeded");
    expect((await tool(a, "poppy_api_call", exchangeCall(c))).isError).toBe(false);
    expect((await c.stub.state()).operations).toHaveLength(2);
  });

  it("doesn't ask an MCP tool for a new proposal while a confirmed operation isn't final (Ops 6)", async () => {
    const c = await company({ slowConfirm: true });
    const a = await agent();
    await signInDirect(a, c);
    const call = { domain: c.domain, tool: "exchange_item", args: { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } };
    expect((await tool(a, "poppy_mcp_call", call)).isError).toBe(false);
    const card = (await cards(a)).find((item) => item.kind === "operation")!;
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    expect((await c.stub.state()).operations[0]?.state).toBe("in_progress");
    const again = await tool(a, "poppy_mcp_call", call);
    expect(again.isError).toBe(true);
    expect(again.text).toContain(card.operationId);
  });

  it("declines a proposal by cancelling it", async () => {
    const { c, a, card } = await proposal();
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "decline" });
    expect((await c.stub.state()).operations[0]!.state).toBe("cancelled");
    expect((await c.stub.state()).performs).toBe(0);
  });

  it("treats an operation confirmed on the website as the same operation, made once (Ops 4.4)", async () => {
    const { c, a, card } = await proposal();
    expect(card.url).toBe(`https://${c.domain}/orders/ord_7Hk2/exchanges/${card.operationId}`);
    // Its url shows it on the website, in the Session's own browser.
    const open = () => tool(a, "poppy_browse", { domain: c.domain, action: "open", url: card.url });
    const before = await open();
    expect(before.text).toContain(card.summary);
    expect(before.text).toContain("Status: proposed");
    // The User confirms it there instead.
    await c.stub.confirmOnWebsite(card.operationId);
    expect((await open()).text).toContain("Status: succeeded");
    // Approving the card later confirms the same operation, which the Company doesn't make again.
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.operations[0]).toMatchObject({ state: "succeeded", confirms: 1 });
    const closed = (await cards(a)).find((item) => item.kind === "operation")!;
    expect(closed).toMatchObject({ open: false, state: "succeeded" });
    expect(closed.result).toContain("Exchange placed");
    await a.stub.poppyWaitForNotice("is succeeded");
  });
});

/**
 * A step that fails partway, without a restart: a fetcher wrapper lets the
 * Company handle a request and then loses its answer (or a notice to the
 * model fails), and the test calls the same entry points again, as the next
 * alarm or step would. `hold` keeps an answer back while the test forgets
 * the client's memory, which is what a restart leaves behind.
 */
describe("Ops 6 a confirm whose answer never arrives", () => {
  const exchangeCall = (c: Company) => ({
    domain: c.domain,
    operation: "POST /orders/{order_id}/exchanges",
    params: { order_id: "ord_7Hk2" },
    body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
  });

  async function proposal() {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_api_call", exchangeCall(c));
    const card = (await cards(a)).find((item) => item.kind === "operation")!;
    return { c, a, card };
  }

  const approve = (a: Agent, c: Company, card: Record<string, any>) =>
    a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: card.operationId, revision: card.revision, decision: "approve" });
  const reads = async (c: Company, id: string) =>
    (await requests(c)).filter((request) => request.method === "GET" && request.url === `${c.hosts.operationsEndpoint}/${id}`).length;

  it.each(["throw", "gateway"] as const)("reads an operation whose confirm answer was lost (%s), and never confirms it again once final", async (mode) => {
    const { c, a, card } = await proposal();
    await a.stub.poppyFault({ method: "POST", url: "/confirm", mode });
    await approve(a, c, card);
    expect(await a.stub.poppyFaultsLeft()).toBe(0);
    // The Company made the exchange; the agent never heard.
    expect((await c.stub.state()).performs).toBe(1);
    await a.stub.poppyAdvance(5_000);
    await a.stub.poppyWaitForNotice("is succeeded");
    expect((await cards(a)).find((item) => item.kind === "operation")).toMatchObject({ open: false, state: "succeeded" });
    // A later sign-in retries approved operations waiting on one: this one is final, so it isn't confirmed again.
    await signInDirect(a, c, ["poppy:read"], { account: "acct_bob" }, { account: "second", session: "second" });
    // Nor is it read again: the check scheduled before the confirm finds it final.
    await a.stub.poppyAdvance(60_000);
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.operations[0]).toMatchObject({ state: "succeeded", confirms: 1 });
    expect(await reads(c, card.operationId)).toBe(1);
  });

  it("checks on a confirm that a restart interrupted, then confirms nothing more", async () => {
    const { c, a, card } = await proposal();
    await a.stub.poppyFault({ method: "POST", url: "/confirm", mode: "hold" });
    const approving = approve(a, c, card);
    await until(async () => (await c.stub.state()).performs === 1);
    // A restart: the client's memory is gone, and the interrupted step never hears back.
    await a.stub.poppyForgetMemory();
    await a.stub.poppyAdvance(60_000);
    await a.stub.poppyWaitForNotice("is succeeded");
    // The old connection finally fails; what it schedules finds the operation final.
    expect(await a.stub.poppyReleaseHeld()).toBe(1);
    await approving;
    await a.stub.poppyAdvance(60_000);
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.operations[0]).toMatchObject({ state: "succeeded", confirms: 1 });
    expect(await reads(c, card.operationId)).toBe(1);
  });

  it("confirms the same revision again when the confirm never reached the Company", async () => {
    const { c, a, card } = await proposal();
    await a.stub.poppyFault({ method: "POST", url: "/confirm", mode: "lose" });
    await approve(a, c, card);
    expect((await c.stub.state()).operations[0]).toMatchObject({ state: "proposed", confirms: 0 });
    // Read first: still proposed, so the approved revision is confirmed, under the same id.
    await a.stub.poppyAdvance(5_000);
    await a.stub.poppyWaitForNotice("is succeeded");
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.operations[0]).toMatchObject({ state: "succeeded", confirms: 1, approvedBy: "user" });
    expect(await reads(c, card.operationId)).toBe(1);
  });
});

describe("7.5 an event whose handling fails", () => {
  const inboxFor = async (a: Agent, conversationId: string) =>
    JSON.parse(
      await a.stub.poppySql(
        "SELECT json_extract(event, '$.id') AS id, json_extract(event, '$.message.text') AS text FROM poppy_inbox WHERE conversation_id = ? ORDER BY seq",
        conversationId
      )
    ) as { id: string; text: string }[];

  it("handles an event again after its handling failed, then the events after it, in order", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await a.stub.poppyFailNoticeOnce("First of two.");
    await c.stub.say(first.conversationId, "First of two.");
    await c.stub.say(first.conversationId, "Second of two.");
    // Whichever read meets the failure stops there; a later read handles both.
    const notices = await until(async () => {
      await a.stub.poppyReadNow(first.conversationId).catch(() => undefined);
      const told = await a.stub.poppyNotices();
      return told.some((text) => text.includes("Second of two.")) && told;
    });
    expect(await a.stub.poppyFaultsLeft()).toBe(0);
    const at = (fragment: string) => notices.findIndex((text) => text.includes(fragment));
    expect(at("First of two.")).toBeGreaterThan(-1);
    expect(at("First of two.")).toBeLessThan(at("Second of two."));
    const texts = (await inboxFor(a, first.conversationId)).map((entry) => entry.text);
    expect(texts.filter((text) => text === "First of two.")).toHaveLength(1);
    expect(texts.filter((text) => text === "Second of two.")).toHaveLength(1);
  });

  it("tells the model a person joined even when the first try failed", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await tool(a, "poppy_handoff", { conversation: first.conversationId, summary: "The jacket isn't warm enough; the user wants an exchange." });
    await a.stub.poppyFailNoticeOnce("has joined");
    await c.stub.humanJoin(first.conversationId, "Hi, I'm Sam.");
    await until(async () => {
      await a.stub.poppyReadNow(first.conversationId).catch(() => undefined);
      return (await a.stub.poppyNotices()).some((text) => text.includes("has joined"));
    });
    expect(await a.stub.poppyFaultsLeft()).toBe(0);
  });

  it("doesn't repeat an event's effects when it is handled again before being recorded", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "I'd like to return order ord_7Hk2" })).text);
    await a.stub.poppyWaitForNotice("needs the User signed in");
    await signInDirect(a, c);
    await tool(a, "poppy_message", { domain: c.domain, conversation: first.conversationId, text: "I'm signed in now; please exchange it for the insulated one." });
    const card = await until(async () => (await cards(a)).find((item) => item.kind === "operation" && item.open));
    const [proposing] = JSON.parse(
      await a.stub.poppySql("SELECT json_extract(event, '$.id') AS id FROM poppy_inbox WHERE conversation_id = ? AND instr(event, '\"operation\"') > 0", first.conversationId)
    ) as { id: string }[];
    // As if the agent had handled it but not yet recorded it, nor saved the cursor past it.
    await a.stub.poppySql("DELETE FROM poppy_events WHERE conversation_id = ? AND event_id = ?", first.conversationId, proposing!.id);
    await a.stub.poppySql("UPDATE poppy_conversations SET cursor = NULL WHERE id = ?", first.conversationId);
    await a.stub.poppyReadNow(first.conversationId);
    expect(JSON.parse(await a.stub.poppySql("SELECT 1 FROM poppy_events WHERE conversation_id = ? AND event_id = ?", first.conversationId, proposing!.id))).toHaveLength(1);
    expect((await inboxFor(a, first.conversationId)).filter((entry) => entry.id === proposing!.id)).toHaveLength(1);
    expect(JSON.parse(await a.stub.poppySql("SELECT operation_id FROM poppy_operations"))).toHaveLength(1);
    expect((await cards(a)).filter((item) => item.kind === "operation")).toEqual([expect.objectContaining({ operationId: card.operationId, open: true })]);
    expect((await c.stub.state()).operations).toHaveLength(1);
  });
});

describe("4.5 a Direct Sign-In interrupted mid-exchange", () => {
  const exchange = { method: "POST", url: "/oauth/token", grant: "authorization_code" } as const;
  const signInRows = async (a: Agent) =>
    JSON.parse(await a.stub.poppySql("SELECT id, issuer, status, secret FROM poppy_signins")) as { id: string; issuer: string; status: string; secret: string }[];
  const ourSession = async (a: Agent) =>
    (JSON.parse(await a.stub.poppySql("SELECT session_id, signed_in FROM poppy_sessions WHERE label = 'main'")) as { session_id: string; signed_in: number }[])[0];

  it.each(["throw", "gateway"] as const)("starts a new Session when a code exchange's answer is lost (%s), and the User can sign in again", async (mode) => {
    const c = await company();
    const a = await agent();
    await a.stub.poppyFault({ ...exchange, mode });
    const result = await signInDirect(a, c);
    expect(await a.stub.poppyFaultsLeft()).toBe(0);
    expect(result!.callback.status).toBe(400);
    expect(result!.text).toContain("interrupted");
    // The Company signed the Session in; the agent never got its tokens, so it leaves that Session.
    const signedIn = (await c.stub.state()).sessions.find((session) => session.signedIn)!;
    expect(signedIn).toBeDefined();
    expect(await ourSession(a)).toBeUndefined();
    expect((await signInRows(a))[0]!.status).toBe("failed");
    expect((await cards(a)).find((item) => item.id.startsWith("signin-"))).toMatchObject({ kind: "notice", open: false });
    await a.stub.poppyWaitForNotice("was interrupted");
    // The next use starts a new Session, signed out, instead of renewing that one with the assertion.
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
    expect(await ourSession(a)).toMatchObject({ signed_in: 0 });
    expect((await ourSession(a))!.session_id).not.toBe(signedIn.id);
    // Signing in again works.
    expect((await signInDirect(a, c))!.callback.status).toBe(200);
    expect(await ourSession(a)).toMatchObject({ signed_in: 1 });
  });

  it("resolves a code exchange a restart interrupted, on the next use", async () => {
    const c = await company();
    const a = await agent();
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["poppy:read"], reason: "test" });
    const card = (await cards(a)).find((item) => item.kind === "signin_link")!;
    const location = await c.stub.approveAuthorization(card.url, { approve: true, account: "acct_ada" });
    await a.stub.poppyFault({ ...exchange, mode: "hold" });
    const callback = worker.fetch(new Request(location, { headers: { Cookie: a.cookie } }), env);
    await until(async () => (await requests(c)).some((request) => request.grant === "authorization_code"));
    // A restart: memory is gone, and the exchange never hears back.
    await a.stub.poppyForgetMemory();
    expect((await signInRows(a))[0]!.status).toBe("exchanging");
    // The next use of the Company finds it and starts a new Session.
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
    expect((await signInRows(a))[0]!.status).toBe("failed");
    expect(await ourSession(a)).toMatchObject({ signed_in: 0 });
    expect((await cards(a)).find((item) => item.id === card.id)).toMatchObject({ kind: "notice", open: false });
    await a.stub.poppyWaitForNotice("was interrupted");
    // The old connection finally fails; the sign-in is already resolved.
    expect(await a.stub.poppyReleaseHeld()).toBe(1);
    expect((await callback).status).toBe(400);
    expect((await signInRows(a))[0]!.status).toBe("failed");
  });

  it("finishes a Direct Sign-In on the next use when its last step failed, keeping no token in the sign-in", async () => {
    const c = await company();
    const a = await agent();
    await a.stub.poppyFailNoticeOnce("Signed in to");
    const result = await signInDirect(a, c);
    expect(await a.stub.poppyFaultsLeft()).toBe(0);
    expect(result!.callback.status).toBe(400);
    expect(result!.text).toContain("finish here");
    // The tokens are stored; the next use finishes the rest, renewing with the Account Token.
    expect((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).isError).toBe(false);
    await a.stub.poppyWaitForNotice("Signed in to");
    expect(await ourSession(a)).toMatchObject({ signed_in: 1 });
    const [row] = await signInRows(a);
    expect(row!.status).toBe("done");
    expect(JSON.parse((await a.stub.poppyOpenSealed(row!.secret, `signin|${row!.id}|${row!.issuer}`))!)).toEqual({ scope: "poppy:read poppy:write" });
    expect((await cards(a)).find((item) => item.id === `signin-${row!.id}`)).toMatchObject({ kind: "notice", open: false });
  });
});
