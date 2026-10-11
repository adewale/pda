import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
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
import { grantCode, type Grant } from "./fake-providers";
import worker from "./worker";

const ORIGIN = "https://agent.example.com";

/** Test GitHub accounts on the allowlist in test/wrangler.jsonc. */
const OCTO = "4242";
const HUBOT = "4343";

/** A Google Workspace account at an allowlisted domain, or an allowlisted GitHub id. */
function person(sub = `user-${crypto.randomUUID()}`, provider: Provider = "google"): Identity {
  return provider === "google"
    ? { provider, sub, email: `${sub}@workspace.example`, domain: "workspace.example" }
    : { provider, sub, email: `${sub}@example.com`, domain: null };
}

/** `name=value` from a `Set-Cookie` header, ready for a `Cookie` header. */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

async function sessionCookie(identity: Identity, now?: number): Promise<string> {
  return cookiePair(await createSession(identity, env.SESSION_SECRET, now));
}

function wsRequest(
  init: { cookie?: string; origin?: string; upgrade?: boolean; query?: string } = {}
): Request {
  const headers = new Headers();
  if (init.upgrade !== false) headers.set("Upgrade", "websocket");
  headers.set("Origin", init.origin ?? ORIGIN);
  if (init.cookie) headers.set("Cookie", init.cookie);
  return new Request(`${ORIGIN}/ws${init.query ?? ""}`, { headers });
}

async function fetchWorker(request: Request, overrides: Partial<Env> = {}) {
  return worker.fetch(request, { ...env, ...overrides });
}

/** Folds every `events` frame into a view, as the browser hook does. */
function follow(socket: WebSocket) {
  let view: PiSessionView = EMPTY_VIEW;
  const frames: Array<PiServerMessage | { type: string; name?: string }> = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as PiServerMessage | { type: string };
    frames.push(message);
    if (message.type === "events") {
      view = reduceEvents(
        view,
        (message as Extract<PiServerMessage, { type: "events" }>).events
      );
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    if (!check()) throw new Error("Condition never held");
  };
  const texts = () =>
    view.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "text" ? [`${message.role}: ${part.text}`] : []
      )
    );
  return { view: () => view, frames, until, texts };
}

async function connect(identity: Identity | string, query = "") {
  const cookie = typeof identity === "string" ? identity : await sessionCookie(identity);
  const response = await fetchWorker(wsRequest({ cookie, query }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const client = follow(socket);
  await client.until(() => client.frames.some((f) => f.type === "events"));
  return { socket, client };
}

async function chat(
  socket: WebSocket,
  client: ReturnType<typeof follow>,
  text: string,
  expected?: string
) {
  socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: text }));
  // Without an expected answer, any turn number will do: the agent may have history.
  await client.until(() =>
    expected === undefined
      ? client.texts().some((t) => t.startsWith(`assistant: echo: ${text} (turn `))
      : client.texts().includes(`assistant: ${expected}`)
  );
  await client.until(() => !client.view().running);
}

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

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

  it("brings the whole history back after a reconnect and a crash", async () => {
    const identity = person();
    const first = await connect(identity);
    await chat(first.socket, first.client, "one", "echo: one (turn 1)");
    first.socket.close();

    const second = await connect(identity);
    expect(second.client.texts()).toEqual(["user: one", "assistant: echo: one (turn 1)"]);
    second.socket.close();

    await abortAllDurableObjects();

    const third = await connect(identity);
    expect(third.client.texts()).toEqual(["user: one", "assistant: echo: one (turn 1)"]);
    await chat(third.socket, third.client, "two", "echo: two (turn 2)");
    third.socket.close();
  });

  it("answers on an open socket after the object is evicted", async () => {
    const identity = person();
    const { socket, client } = await connect(identity);
    await evictDurableObject(env.PersonalAgent.getByName(await agentNameFor(identity)));
    await chat(socket, client, "after eviction", "echo: after eviction (turn 1)");
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
    expect(await me(response)).toEqual({ email: "octo@example.com", provider: "github" });

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
    expect(await me(response)).toEqual({ email: "g@example.com", provider: "google" });
  });

  it("lets in a Google Workspace account at an allowlisted domain", async () => {
    const response = await signIn("google", {
      sub: "ws-sub",
      email: "anyone@workspace.example",
      hd: "workspace.example"
    });
    expect(response.headers.get("Location")).toBe("/");
    expect(await me(response)).toEqual({ email: "anyone@workspace.example", provider: "google" });
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
    const removed = { ALLOWLIST: { emails: [], domains: [], github: {} } } as unknown as Partial<Env>;
    const me = () => new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } });
    expect((await fetchWorker(me())).status).toBe(200);
    expect((await fetchWorker(me(), removed)).status).toBe(401);
    expect((await fetchWorker(wsRequest({ cookie }), removed)).status).toBe(401);
    const callback = new Request(`${ORIGIN}/poppy/callback?code=x&state=y`, { headers: { Cookie: cookie } });
    expect((await fetchWorker(callback, removed)).status).toBe(401);
  });

  it("fails sign-in with a config error when ALLOWLIST is missing", async () => {
    const response = await fetchWorker(
      new Request(`${ORIGIN}/auth/github/callback?code=x&state=y`),
      { ALLOWLIST: undefined } as unknown as Partial<Env>
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/^ALLOWLIST/);
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
      expect(await me(response)).toEqual({ email: "g@example.com", provider: "google" });
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
      expect(await me(response)).toEqual({ email: null, provider: "github" });
    });
  }
});


describe("configuration", () => {
  it("fails with an error naming a missing model var", async () => {
    const identity = person();
    const response = await fetchWorker(wsRequest({ cookie: await sessionCookie(identity) }), {
      MODEL_ID: "" as Env["MODEL_ID"]
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("MODEL_ID");
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

  it("resolves the configured MODEL_ID in the gateway catalog as Claude Opus 5.5", () => {
    const ai = createAI({ binding: {} as Ai, id: env.AI_GATEWAY_ID });
    const model = ai(env.MODEL_ID) as { name?: string; id: string };
    expect(model.name).toBe("Claude Opus 5.5");
  });
});

describe("/api/me", () => {
  it("refuses a request without a session", async () => {
    const response = await fetchWorker(new Request(`${ORIGIN}/api/me`));
    expect(response.status).toBe(401);
  });
});
