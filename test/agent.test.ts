import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { createAI } from "agents/models/pi-ai";
import { describe, expect, it } from "vitest";
import type { Provider } from "../src/config";
import type { PiServerMessage } from "../src/protocol";
import {
  agentNameFor,
  createSession,
  sign,
  SESSION_COOKIE,
  type Identity
} from "../src/session";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../src/view";
import { CONTENT_SECURITY_POLICY } from "../src/csp";
import indexHtml from "../index.html?raw";
import assetHeaders from "../public/_headers?raw";
import wranglerConfig from "../wrangler.jsonc?raw";
import { PAGE_PATHS } from "../src/index";
import { s256 } from "./encoding";
import { grantCode, type Grant } from "./fake-providers";
import {
  chat,
  connect,
  cookiePair,
  fetchWorker,
  follow,
  ORIGIN,
  person,
  sessionCookie,
  wsRequest
} from "./agent-helpers";

/** Test GitHub accounts on the allowlist in test/wrangler.jsonc. */
const OCTO = "4242";
const HUBOT = "4343";

/** Who agrees on the provider's consent page, and how the provider answers for them. */
type Consent = Omit<Grant, "clientId" | "redirectUri" | "challenge" | "challengeMethod">;

type Flow = { readonly authorize: URL; readonly state: string; readonly cookie: string };

/** `GET /auth/<provider>`, as the browser does: where it is sent, and the flow cookie. */
async function startFlow(provider: Provider): Promise<Flow> {
  const start = await fetchWorker(new Request(`${ORIGIN}/auth/${provider}`));
  expect(start.status).toBe(303);
  const authorize = new URL(start.headers.get("Location")!);
  return {
    authorize,
    state: authorize.searchParams.get("state")!,
    cookie: cookiePair(start.headers.get("Set-Cookie")!)
  };
}

/**
 * The provider's consent page: the code it sends back when this person
 * agrees, bound to the authorize URL's client, redirect URI and PKCE challenge.
 */
function consent(authorize: URL, who: Consent): string {
  const params = authorize.searchParams;
  return grantCode({
    clientId: params.get("client_id")!,
    redirectUri: params.get("redirect_uri")!,
    challenge: params.get("code_challenge")!,
    challengeMethod: params.get("code_challenge_method")!,
    ...who
  });
}

/** The browser arriving back at the callback with the flow cookie. */
function callback(provider: Provider, cookie: string, params: Record<string, string>) {
  return fetchWorker(
    new Request(`${ORIGIN}/auth/${provider}/callback?${new URLSearchParams(params)}`, {
      headers: { Cookie: cookie }
    })
  );
}

/** Runs a whole OAuth round trip; returns the callback's response. */
async function signIn(
  provider: Provider,
  who: Consent | ((flow: Flow) => Record<string, string>)
) {
  const flow = await startFlow(provider);
  const params =
    typeof who === "function"
      ? who(flow)
      : { code: consent(flow.authorize, who), state: flow.state };
  return callback(provider, flow.cookie, params);
}

/** The signed-in person's `/api/me`. */
async function me(response: Response) {
  const session = sessionFrom(response);
  expect(session, "no session cookie").toBeDefined();
  const answer = await fetchWorker(
    new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookiePair(session!) } })
  );
  expect(answer.status).toBe(200);
  return answer.json();
}

/** A verified Google account whose email is on the allowlist in test/wrangler.jsonc. */
const GOOGLE_ALLOWED: Consent = { sub: "google-sub-1", email: "g@example.com" };
const GITHUB_ALLOWED: Consent = { sub: OCTO, email: "octo@example.com" };

function sessionFrom(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.includes("Max-Age=0"));
}

describe("the /ws route", () => {
  it("refuses a request without a WebSocket upgrade", async () => {
    const response = await fetchWorker(
      wsRequest({ cookie: await sessionCookie(person()), upgrade: false })
    );
    expect(response.status).toBe(426);
  });

  it("refuses an upgrade from another origin", async () => {
    const response = await fetchWorker(
      wsRequest({ cookie: await sessionCookie(person()), origin: "https://evil.example" })
    );
    expect(response.status).toBe(403);
  });

  it("refuses a missing session", async () => {
    expect((await fetchWorker(wsRequest())).status).toBe(401);
  });

  it("refuses a tampered session", async () => {
    const [name, value] = (await sessionCookie(person())).split("=") as [string, string];
    const [body, signature] = value.split(".") as [string, string];
    const forged = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    forged.sub = "someone-else";
    const forgedBody = btoa(JSON.stringify(forged))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const cookie = `${name}=${forgedBody}.${signature}`;
    expect((await fetchWorker(wsRequest({ cookie }))).status).toBe(401);
  });

  it("refuses a session signed with another secret", async () => {
    const token = await sign(
      { ...person(), exp: Math.floor(Date.now() / 1000) + 3600 },
      "some-other-secret-that-is-also-long-enough"
    );
    const cookie = `${SESSION_COOKIE}=${token}`;
    expect((await fetchWorker(wsRequest({ cookie }))).status).toBe(401);
  });

  it("requires a fresh sign-in for a legacy cookie without a revocable login id", async () => {
    const token = await sign({ ...person(), exp: Math.floor(Date.now() / 1000) + 3600 }, env.SESSION_SECRET);
    const cookie = `${SESSION_COOKIE}=${token}`;
    expect((await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } }))).status).toBe(401);
  });

  it("refuses an expired session", async () => {
    const longAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const cookie = await sessionCookie(person(), longAgo);
    expect((await fetchWorker(wsRequest({ cookie }))).status).toBe(401);
  });

  it("does not route the SDK's /agents/<class>/<name> path", async () => {
    const request = new Request(`${ORIGIN}/agents/personal-agent/anyone`, {
      headers: { Upgrade: "websocket", Origin: ORIGIN }
    });
    expect((await fetchWorker(request)).status).toBe(404);
  });

  it("connects a session to the person's agent, named by a hash", async () => {
    const identity = person();
    const { socket, client } = await connect(identity);
    const frame = client.frames.find((f) => f.type === "cf_agent_identity");
    expect(frame).toMatchObject({ name: await agentNameFor(identity) });
    expect(JSON.stringify(frame)).not.toContain(identity.sub);
    expect(client.frames.find((f) => f.type === "hello")).toMatchObject({
      session: "1"
    });
    const events = client.frames.find((f) => f.type === "events") as Extract<
      PiServerMessage,
      { type: "events" }
    >;
    expect(events.events[0]?.type).toBe("snapshot");
    socket.close();
  });

  it("ignores a client-chosen session and agent name", async () => {
    const identity = person();
    const { socket, client } = await connect(identity, "?session=2&name=someone-else");
    expect(client.frames.find((f) => f.type === "hello")).toMatchObject({
      session: "1"
    });
    expect(client.frames.find((f) => f.type === "cf_agent_identity")).toMatchObject({
      name: await agentNameFor(identity)
    });
    socket.close();
  });
});

describe("the conversation", () => {
  it("runs a chat turn that folds into user and assistant bubbles", async () => {
    const { socket, client } = await connect(person());
    await chat(socket, client, "hello", "echo: hello (turn 1)");
    expect(client.texts()).toEqual(["user: hello", "assistant: echo: hello (turn 1)"]);
    socket.close();
  });

  it("keeps two people's conversations apart", async () => {
    const a = await connect(person());
    const b = await connect(person());
    await chat(a.socket, a.client, "secret of A", "echo: secret of A (turn 1)");
    await chat(b.socket, b.client, "hi from B", "echo: hi from B (turn 1)");
    expect(b.client.texts().join("\n")).not.toContain("secret of A");
    expect(a.client.texts().join("\n")).not.toContain("hi from B");
    a.socket.close();
    b.socket.close();
  });

  it("gives a Google and a GitHub account with the same id separate agents", async () => {
    const google = await connect(person(HUBOT, "google"));
    const github = await connect(person(HUBOT, "github"));
    const name = (client: ReturnType<typeof follow>) =>
      (client.frames.find((f) => f.type === "cf_agent_identity") as { name?: string }).name;
    expect(name(google.client)).toBe(await agentNameFor({ provider: "google", sub: HUBOT }));
    expect(name(github.client)).toBe(await agentNameFor({ provider: "github", sub: HUBOT }));
    expect(name(google.client)).not.toBe(name(github.client));
    const marker = `only on Google ${crypto.randomUUID()}`;
    await chat(google.socket, google.client, marker);
    expect(github.client.texts().join("\n")).not.toContain(marker);
    google.socket.close();
    github.socket.close();
  });

  it("runs a message the page sends again after a reconnect once, by its operation id", async () => {
    const identity = person();
    const first = await connect(identity);
    const operationId = crypto.randomUUID();
    const submit = JSON.stringify({ type: "submit", id: operationId, input: "only once", operationId });
    first.socket.send(submit);
    await first.client.until(() => first.client.texts().includes("assistant: echo: only once (turn 1)"));
    await first.client.until(() => !first.client.view().running);
    first.socket.close();

    // The page didn't hear the answer, so it sends the same frame on its next socket.
    const second = await connect(identity);
    second.socket.send(submit);
    await second.client.until(() => second.client.frames.some((frame) => frame.type === "result" && (frame as { id?: string }).id === operationId));
    await chat(second.socket, second.client, "next", "echo: next (turn 2)");
    expect(second.client.texts().filter((text) => text === "user: only once")).toHaveLength(1);
    second.socket.close();
  });

  it("answers on an open socket after the object is evicted", async () => {
    const identity = person();
    const { socket, client } = await connect(identity);
    await evictDurableObject(env.PersonalAgent.getByName(await agentNameFor(identity)));
    await chat(socket, client, "after eviction", "echo: after eviction (turn 1)");
    socket.close();
  });

  // A pending timer keeps a Durable Object from being evicted, and in production
  // from hibernating with the socket open. Under nodejs_compat a timer has an
  // unref(), which makes pi keep its caches' expiry timers (ten minutes each):
  // the agent sets both retentions to 0 (src/agent.ts).
  it("can be evicted right after a turn, and answers on the open socket after", async () => {
    const identity = person();
    const { socket, client } = await connect(identity);
    await chat(socket, client, "before", "echo: before (turn 1)");
    await evictDurableObject(env.PersonalAgent.getByName(await agentNameFor(identity)));
    await chat(socket, client, "after eviction", "echo: after eviction (turn 2)");
    socket.close();
  });
});

describe("sign-in", () => {
  it("sends the browser to GitHub with state and a PKCE challenge", async () => {
    const response = await fetchWorker(new Request(`${ORIGIN}/auth/github`));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(env.GITHUB_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(location.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    const flow = response.headers.get("Set-Cookie")!;
    expect(flow).toMatch(/^__Host-oauth=.+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  });

  it("signs the flow cookie to expire ten minutes after the sign-in starts", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { cookie } = await startFlow("google");
    const after = Math.floor(Date.now() / 1000);
    const body = cookie.slice(cookie.indexOf("=") + 1).split(".")[0]!;
    const flow = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as { exp: number };
    expect(flow.exp).toBeGreaterThanOrEqual(before + 600);
    expect(flow.exp).toBeLessThanOrEqual(after + 600);
  });

  it("signs in with GitHub and opens the same agent on every sign-in", async () => {
    const response = await signIn("github", GITHUB_ALLOWED);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    const session = sessionFrom(response)!;
    expect(session).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(await me(response)).toEqual({ email: "octo@example.com", provider: "github", workspaceId: expect.any(String) });

    const again = sessionFrom(await signIn("github", GITHUB_ALLOWED))!;
    const first = await connect(cookiePair(session));
    const marker = `said before signing in again ${crypto.randomUUID()}`;
    await chat(first.socket, first.client, marker);
    first.socket.close();

    const second = await connect(cookiePair(again));
    const identity = (client: ReturnType<typeof follow>) =>
      client.frames.find((f) => f.type === "cf_agent_identity");
    expect(identity(second.client)).toMatchObject({
      name: await agentNameFor({ provider: "github", sub: OCTO })
    });
    expect(identity(second.client)).toEqual(identity(first.client));
    expect(second.client.texts()).toContain(`user: ${marker}`);
    second.socket.close();
  });

  it("signs in with Google", async () => {
    const response = await signIn("google", GOOGLE_ALLOWED);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    expect(await me(response)).toEqual({ email: "g@example.com", provider: "google", workspaceId: expect.any(String) });
  });

  it("lets in a Google Workspace account at an allowlisted domain", async () => {
    const response = await signIn("google", {
      sub: "ws-sub",
      email: "anyone@workspace.example",
      hd: "workspace.example"
    });
    expect(response.headers.get("Location")).toBe("/");
    expect(await me(response)).toEqual({ email: "anyone@workspace.example", provider: "google", workspaceId: expect.any(String) });
  });

  it("refuses accounts that are not on the allowlist", async () => {
    for (const [provider, who] of [
      ["google", { sub: "stranger", email: "stranger@example.com" }],
      // A personal Google account using a work address is not the Workspace account.
      ["google", { sub: "personal", email: "someone@workspace.example" }],
      ["google", { sub: "other-ws", email: "someone@other.example", hd: "other.example" }],
      ["github", { sub: "999", email: "octo@example.com" }]
    ] as const) {
      const response = await signIn(provider, who);
      expect(response.headers.get("Location")).toBe("/?signin_error=not_allowed");
      expect(sessionFrom(response)).toBeUndefined();
    }
  });

  it("locks out a signed-in person once they are off the allowlist", async () => {
    const cookie = await sessionCookie(person());
    const removed = { SIGNIN_ALLOWLIST: { emails: [], domains: [], github: {} } } as unknown as Partial<Env>;
    const me = () => new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } });
    expect((await fetchWorker(me())).status).toBe(200);
    expect((await fetchWorker(me(), removed)).status).toBe(401);
    expect((await fetchWorker(wsRequest({ cookie }), removed)).status).toBe(401);
    const callback = new Request(`${ORIGIN}/poppy/callback?code=x&state=y`, { headers: { Cookie: cookie } });
    expect((await fetchWorker(callback, removed)).status).toBe(401);
  });

  it("fails sign-in with a config error when SIGNIN_ALLOWLIST is missing", async () => {
    const response = await fetchWorker(
      new Request(`${ORIGIN}/auth/github/callback?code=x&state=y`),
      { SIGNIN_ALLOWLIST: undefined } as unknown as Partial<Env>
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/^SIGNIN_ALLOWLIST/);
  });

  it("rejects a callback whose state does not match", async () => {
    const response = await signIn("github", (flow) => ({
      code: consent(flow.authorize, GITHUB_ALLOWED),
      state: "forged"
    }));
    expect(response.headers.get("Location")).toBe("/?signin_error=state");
    expect(sessionFrom(response)).toBeUndefined();
  });

  it("rejects a callback without the flow cookie", async () => {
    const flow = await startFlow("github");
    const response = await callback("github", "", {
      code: consent(flow.authorize, GITHUB_ALLOWED),
      state: flow.state
    });
    expect(response.headers.get("Location")).toBe("/?signin_error=state");
    expect(sessionFrom(response)).toBeUndefined();
  });

  it("reports a cancelled consent", async () => {
    const response = await signIn("google", (flow) => ({ error: "access_denied", state: flow.state }));
    expect(response.headers.get("Location")).toBe("/?signin_error=denied");
    expect(sessionFrom(response)).toBeUndefined();
  });

  it("reports a code the provider rejects", async () => {
    for (const provider of ["google", "github"] as const) {
      const response = await signIn(provider, (flow) => ({ code: "not-a-valid-code", state: flow.state }));
      expect(response.headers.get("Location")).toBe("/?signin_error=token");
      expect(sessionFrom(response)).toBeUndefined();
    }
  });

  it("does not accept one provider's flow at another's callback", async () => {
    const flow = await startFlow("google");
    const response = await callback("github", flow.cookie, {
      code: consent(flow.authorize, GITHUB_ALLOWED),
      state: flow.state
    });
    expect(response.headers.get("Location")).toBe("/?signin_error=state");
  });

  it("has no route for an unknown provider", async () => {
    expect((await fetchWorker(new Request(`${ORIGIN}/auth/myspace`))).status).toBe(404);
  });

  it("signs out with a same-origin POST only", async () => {
    const post = (origin: string) =>
      fetchWorker(new Request(`${ORIGIN}/logout`, { method: "POST", headers: { Origin: origin } }));
    const ok = await post(ORIGIN);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Set-Cookie")).toMatch(/^__Host-session=; Path=\/; Max-Age=0/);
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await fetchWorker(new Request(`${ORIGIN}/logout`))).status).toBe(405);
  });
});

/**
 * The fakes in test/fake-providers.ts answer as a real provider would, so
 * each check the Worker makes on that answer has a test that fails without it.
 */
describe("sign-in: PKCE and the flow cookie", () => {
  it.each(["google", "github"] as const)(
    "gets no second session from a replayed %s callback: a code works once",
    async (provider) => {
      const flow = await startFlow(provider);
      const params = { code: consent(flow.authorize, provider === "google" ? GOOGLE_ALLOWED : GITHUB_ALLOWED), state: flow.state };
      const first = await callback(provider, flow.cookie, params);
      expect(sessionFrom(first)).toBeDefined();
      // The browser history replayed: same code, same state, same flow cookie.
      const replay = await callback(provider, flow.cookie, params);
      expect(sessionFrom(replay)).toBeUndefined();
      expect(replay.headers.get("Location")).toMatch(/^\/\?signin_error=/);
    }
  );

  it.each(["google", "github"] as const)(
    "sends %s the verifier for the challenge in its own authorize URL",
    async (provider) => {
      // The fake provider redeems a code only for the verifier that hashes to its challenge.
      const response = await signIn(provider, provider === "google" ? GOOGLE_ALLOWED : GITHUB_ALLOWED);
      expect(response.headers.get("Location")).toBe("/");
      expect(sessionFrom(response)).toBeDefined();
    }
  );

  it.each(["google", "github"] as const)(
    "refuses a %s code issued for another sign-in's PKCE challenge",
    async (provider) => {
      // An attacker's code, from a flow they started, injected into this browser's callback.
      const attacker = await startFlow(provider);
      const victim = await startFlow(provider);
      const response = await callback(provider, victim.cookie, {
        code: consent(attacker.authorize, provider === "google" ? GOOGLE_ALLOWED : GITHUB_ALLOWED),
        state: victim.state
      });
      expect(response.headers.get("Location")).toBe("/?signin_error=token");
      expect(sessionFrom(response)).toBeUndefined();
    }
  );

  /** A flow cookie as the Worker signs it, with a chosen expiry. */
  async function forgedFlow(exp: number) {
    const verifier = `verifier-${crypto.randomUUID()}`;
    const state = `state-${crypto.randomUUID()}`;
    const cookie = `__Host-oauth=${await sign({ provider: "google", state, verifier, exp }, env.SESSION_SECRET)}`;
    const code = grantCode({
      clientId: env.GOOGLE_CLIENT_ID,
      redirectUri: `${ORIGIN}/auth/google/callback`,
      challenge: await s256(verifier),
      challengeMethod: "S256",
      ...GOOGLE_ALLOWED
    });
    return callback("google", cookie, { code, state });
  }

  // Tables are run with plain loops, so each title is plain text (`it.each`'s
  // `$name` quotes and truncates it).
  for (const { name, offset, location } of [
    { name: "a flow that expired a second ago", offset: -1, location: "/?signin_error=state" },
    { name: "a flow that expired a day ago", offset: -86_400, location: "/?signin_error=state" },
    { name: "a flow with a minute left", offset: 60, location: "/" }
  ]) {
    it(`checks the flow cookie's expiry: ${name}`, async () => {
      const response = await forgedFlow(Math.floor(Date.now() / 1000) + offset);
      expect(response.headers.get("Location")).toBe(location);
      expect(sessionFrom(response) !== undefined).toBe(location === "/");
    });
  }
});

describe("sign-in: Google's ID token", () => {
  const now = () => Math.floor(Date.now() / 1000);

  for (const { name, who } of [
    { name: "aud names another client", who: () => ({ ...GOOGLE_ALLOWED, claims: { aud: "someone-elses-client" } }) },
    { name: "aud is a list without this client", who: () => ({ ...GOOGLE_ALLOWED, claims: { aud: ["someone-elses-client"] } }) },
    { name: "aud is missing", who: () => ({ ...GOOGLE_ALLOWED, omit: ["aud"] }) },
    { name: "iss is not Google", who: () => ({ ...GOOGLE_ALLOWED, claims: { iss: "https://accounts.evil.example" } }) },
    { name: "iss is missing", who: () => ({ ...GOOGLE_ALLOWED, omit: ["iss"] }) },
    { name: "exp has passed", who: () => ({ ...GOOGLE_ALLOWED, claims: { exp: now() - 60 } }) },
    { name: "exp is missing", who: () => ({ ...GOOGLE_ALLOWED, omit: ["exp"] }) },
    { name: "exp is not a number", who: () => ({ ...GOOGLE_ALLOWED, claims: { exp: String(now() + 3600) } }) },
    { name: "sub is missing", who: () => ({ ...GOOGLE_ALLOWED, omit: ["sub"] }) },
    { name: "sub is empty", who: () => ({ ...GOOGLE_ALLOWED, claims: { sub: "" } }) }
  ] satisfies Array<{ name: string; who: () => Consent }>) {
    it(`refuses an ID token whose ${name}`, async () => {
      const response = await signIn("google", who());
      expect(response.headers.get("Location")).toBe("/?signin_error=token");
      expect(sessionFrom(response)).toBeUndefined();
    });
  }

  for (const { name, who } of [
    { name: "aud is a list that includes this client", who: { ...GOOGLE_ALLOWED, claims: { aud: ["other", "google-test-client"] } } },
    { name: "iss has no scheme, as Google sometimes sends", who: { ...GOOGLE_ALLOWED, claims: { iss: "accounts.google.com" } } }
  ] satisfies Array<{ name: string; who: Consent }>) {
    it(`accepts an ID token whose ${name}`, async () => {
      const response = await signIn("google", who);
      expect(response.headers.get("Location")).toBe("/");
      expect(await me(response)).toEqual({ email: "g@example.com", provider: "google", workspaceId: expect.any(String) });
    });
  }

  for (const { name, who } of [
    // g@example.com is on the allowlist, but only a verified address counts.
    { name: "email_verified is false", who: { ...GOOGLE_ALLOWED, claims: { email_verified: false } } },
    { name: "email_verified is the string \"true\"", who: { ...GOOGLE_ALLOWED, claims: { email_verified: "true" } } },
    { name: "email_verified is missing", who: { ...GOOGLE_ALLOWED, omit: ["email_verified"] } },
    // A workspace.example address without `hd` is a personal account; an empty `hd` is not a domain.
    { name: "hd is empty", who: { sub: "empty-hd", email: "someone@workspace.example", hd: "" } },
    { name: "hd names another domain", who: { sub: "other-hd", email: "someone@workspace.example", claims: { hd: "other.example" } } }
  ] satisfies Array<{ name: string; who: Consent }>) {
    it(`does not let an account in when ${name}`, async () => {
      const response = await signIn("google", who);
      expect(response.headers.get("Location")).toBe("/?signin_error=not_allowed");
      expect(sessionFrom(response)).toBeUndefined();
    });
  }
});

describe("sign-in: GitHub's API", () => {
  type GitHubMode = NonNullable<Grant["github"]>;

  for (const { name, user } of [
    { name: "a user without an id", user: "no-id" },
    { name: "a user whose id is not a number", user: "string-id" },
    { name: "an error for the user", user: "fails" }
  ] satisfies Array<{ name: string; user: GitHubMode["user"] }>) {
    it(`refuses sign-in when GitHub returns ${name}`, async () => {
      const response = await signIn("github", { ...GITHUB_ALLOWED, github: { user } });
      expect(response.headers.get("Location")).toBe("/?signin_error=profile");
      expect(sessionFrom(response)).toBeUndefined();
    });
  }

  for (const { name, emails } of [
    { name: "the email list fails", emails: "fails" },
    { name: "the primary email is unverified", emails: "primary-unverified" },
    { name: "no email is primary", emails: "no-primary" }
  ] satisfies Array<{ name: string; emails: GitHubMode["emails"] }>) {
    it(`signs in by id, with no email, when ${name}`, async () => {
      // GitHub accounts are allowed by id, so only the email shown is affected.
      const response = await signIn("github", { ...GITHUB_ALLOWED, github: { emails } });
      expect(response.headers.get("Location")).toBe("/");
      expect(await me(response)).toEqual({ email: null, provider: "github", workspaceId: expect.any(String) });
    });
  }
});


describe("configuration", () => {
  it("fails with an error naming a missing model var", async () => {
    const identity = person();
    const response = await fetchWorker(wsRequest({ cookie: await sessionCookie(identity) }), {
      DEMO_MODEL_ID: "" as Env["DEMO_MODEL_ID"]
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("DEMO_MODEL_ID");
  });

  it("rejects a misspelt thinking level, naming the var", async () => {
    const response = await fetchWorker(wsRequest({ cookie: await sessionCookie(person()) }), {
      THINKING_LEVEL: "meduim" as Env["THINKING_LEVEL"]
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("THINKING_LEVEL");
  });

  it("fails with an error naming a missing SESSION_SECRET", async () => {
    const response = await fetchWorker(wsRequest(), { SESSION_SECRET: "" });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("SESSION_SECRET");
  });

  it("fails with an error naming a missing OAuth client", async () => {
    const response = await fetchWorker(new Request(`${ORIGIN}/auth/google`), {
      GOOGLE_CLIENT_ID: ""
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("GOOGLE_CLIENT_ID");
  });

  it("serves the privacy policy at /privacy, with the deployment's contact and Google's Limited Use statement", async () => {
    const page = await fetchWorker(new Request(`${ORIGIN}/privacy`));
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    expect(page.headers.get("Content-Security-Policy")).toBeTruthy();
    const html = await page.text();
    expect(html).toContain('href="mailto:privacy@example.com"');
    expect(html).toContain("only for the <code>openid</code> and <code>email</code> scopes");
    expect(html).toContain("Google API Services User Data Policy</a>, including the Limited Use requirements");
    expect(html).toContain("Attached photos are deleted after 30 days");
    expect(html).toContain("notes about you are kept in its storage until you delete them");
    expect(html).toContain("The address itself can contain private information in its hostname, path or query");
    expect(html).toContain("General page reads send no cookies or account credentials");
    expect(html).toContain("in Cloudflare's Browser Run, which runs the page's own scripts, allows only public requests that read, and is closed afterwards");
    expect(html).toContain("Those scripts can contact other public websites");
    expect(html).toContain("receive messages and requests your model generates");
    expect(html).toContain("Notes marked as something you said can only be deleted in Settings");
    expect(html).toContain("and your agent and everything it stores will be deleted within 30 days");
    // The operator's logs (src/log.ts): how the agent worked, never what anyone said, for Workers Logs' retention.
    expect(html).toContain("They don't record what you, your agent or anyone else said, and hold no tokens, keys, codes or your email");
    expect(html).toContain("kept for Cloudflare Workers Logs' retention period: 7 days on Workers Paid, 3 days on Workers Free");
    expect((await fetchWorker(new Request(`${ORIGIN}/privacy`, { method: "POST" }))).status).toBe(405);
    const unset = await fetchWorker(new Request(`${ORIGIN}/privacy`), { PRIVACY_CONTACT: "" } as unknown as Partial<Env>);
    expect(unset.status).toBe(500);
    expect(await unset.text()).toContain("PRIVACY_CONTACT");
    const tricky = await fetchWorker(new Request(`${ORIGIN}/privacy`), { PRIVACY_CONTACT: "https://example.com/a?b=<script>" } as unknown as Partial<Env>);
    expect(tricky.status).toBe(500);
    expect(await tricky.text()).not.toContain("<script>");
    const rendered = await fetchWorker(new Request(`${ORIGIN}/privacy`), {
      PRIVACY_CONTACT: "privacy@example.com", POPPY_CLIENT_NAME: "Agent <script>alert(1)</script>"
    } as unknown as Partial<Env>);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("Content-Type")).toContain("text/html");
    const escaped = await rendered.text();
    expect(escaped).toContain("Agent &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escaped).not.toContain("<script>alert(1)</script>");
  });

  it("offers only the sign-in providers SIGNIN_PROVIDERS lists, and says which", async () => {
    const githubOnly = { SIGNIN_PROVIDERS: ["github"] } as unknown as Partial<Env>;
    const options = await fetchWorker(new Request(`${ORIGIN}/api/sign-in-options`), githubOnly);
    expect(options.status).toBe(200);
    expect(await options.json()).toEqual({ providers: ["github"] });
    for (const path of ["/auth/google", "/auth/google/callback?code=x&state=y"]) {
      const refused = await fetchWorker(new Request(`${ORIGIN}${path}`), githubOnly);
      expect(refused.status).toBe(404);
      expect(await refused.text()).toBe("This deployment doesn't offer that sign-in.");
    }
    expect((await fetchWorker(new Request(`${ORIGIN}/auth/github`), githubOnly)).status).toBe(303);
    expect(await (await fetchWorker(new Request(`${ORIGIN}/api/sign-in-options`))).json()).toEqual({ providers: ["google", "github"] });
  });

  it.each([[[]], [["github", "github"]], [["microsoft"]], ["github"]])("fails with an error naming SIGNIN_PROVIDERS when it is %j", async (value) => {
    const response = await fetchWorker(new Request(`${ORIGIN}/auth/github`), { SIGNIN_PROVIDERS: value } as unknown as Partial<Env>);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("SIGNIN_PROVIDERS");
  });

  it("resolves the configured DEMO_MODEL_ID in the gateway catalog as Claude Sonnet 5.5", () => {
    const ai = createAI({ binding: {} as Ai, id: env.DEMO_GATEWAY_ID });
    const model = ai(env.DEMO_MODEL_ID) as { name?: string; id: string };
    expect(model.name).toBe("Claude Sonnet 5.5");
  });
});

describe("the workers.dev host, once PUBLIC_ORIGIN is a domain of its own", () => {
  /** `Env` types each var as the committed template's value, so an origin goes in as a plain string. */
  const origin = (value: string) => ({ PUBLIC_ORIGIN: value as Env["PUBLIC_ORIGIN"] });
  const DOMAIN = origin("https://agent.test");
  const OLD = "https://personal-agent.your-subdomain.workers.dev";

  it("sends a page, with its query, to the same path on PUBLIC_ORIGIN", async () => {
    const response = await fetchWorker(new Request(`${OLD}/settings?tab=model`), DOMAIN);
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://agent.test/settings?tab=model");
  });

  it.each(["/about", "/about/ecosystem"])("redirects the public page %s on the old host", async (path) => {
    const response = await fetchWorker(new Request(`${OLD}${path}`), DOMAIN);
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(`https://agent.test${path}`);
  });

  it("sends an API call there too, as a 308 so a POST stays a POST", async () => {
    const response = await fetchWorker(new Request(`${OLD}/logout`, { method: "POST" }), DOMAIN);
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://agent.test/logout");
  });

  it("never redirects the identity documents: the old client_id answers 404", async () => {
    for (const path of ["/poppy/client.json", "/poppy/jwks.json"]) {
      const response = await fetchWorker(new Request(`${OLD}${path}`), DOMAIN);
      expect(response.status).toBe(404);
      expect(response.headers.get("Location")).toBeNull();
    }
  });

  it("leaves a deployment whose PUBLIC_ORIGIN is its workers.dev host alone", async () => {
    const response = await fetchWorker(new Request(`${OLD}/privacy`), origin(OLD));
    expect(response.status).toBe(200);
  });

  it("leaves any host that isn't workers.dev alone", async () => {
    const response = await fetchWorker(new Request("https://elsewhere.example/privacy"), DOMAIN);
    expect(response.status).toBe(200);
  });

  it("runs the Worker first for every page path, or the old host's pages couldn't be redirected", () => {
    const first = /"run_worker_first":\s*(\[[^\]]*\])/.exec(wranglerConfig)?.[1];
    const paths: unknown = JSON.parse(first ?? "[]");
    for (const path of PAGE_PATHS) expect(paths).toContain(path);
  });
});

describe("/api/me", () => {
  it("refuses a request without a session", async () => {
    const response = await fetchWorker(new Request(`${ORIGIN}/api/me`));
    expect(response.status).toBe(401);
  });
});

describe("the pages' Content-Security-Policy", () => {
  /** The `/*` rule's policy in public/_headers, which static assets serve with the app's page. */
  function assetPolicy(): string | undefined {
    const lines = assetHeaders.split("\n");
    const rule = lines.indexOf("/*");
    return lines.slice(rule + 1).find((line) => /^\s+Content-Security-Policy:/.test(line))?.replace(/^\s+Content-Security-Policy:\s*/, "");
  }

  it("loads images only from this origin or data:, and scripts only from this origin", () => {
    const directives = new Map(CONTENT_SECURITY_POLICY.split(/;\s*/).map((directive) => [directive.split(" ")[0], directive.split(" ").slice(1)]));
    expect(directives.get("img-src")).toEqual(["'self'", "data:"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("default-src")).toEqual(["'self'"]);
    // The app's page needs no inline script, so script-src 'self' doesn't break it.
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it("is sent with the app's page (static assets) and with every page the Worker writes", async () => {
    expect(assetPolicy()).toBe(CONTENT_SECURITY_POLICY);
    const validator = await fetchWorker(new Request(`${ORIGIN}/validator`));
    expect(validator.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(validator.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    const callback = await fetchWorker(new Request(`${ORIGIN}/poppy/callback?state=x&code=y`, { headers: { Cookie: await sessionCookie(person()) } }));
    expect(callback.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(callback.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    // Not a page: no policy needed, and none added.
    expect((await fetchWorker(new Request(`${ORIGIN}/poppy/client.json`))).headers.get("Content-Security-Policy")).toBeNull();
  });
});
