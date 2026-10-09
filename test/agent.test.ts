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
import worker from "./worker";

const ORIGIN = "https://agent.example.com";

function person(sub = `user-${crypto.randomUUID()}`, provider: Provider = "github"): Identity {
  return { provider, sub, email: `${sub}@example.com` };
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

async function connect(identity: Identity, query = "") {
  const response = await fetchWorker(
    wsRequest({ cookie: await sessionCookie(identity), query })
  );
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
  expected: string
) {
  socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: text }));
  await client.until(() => client.texts().includes(`assistant: ${expected}`));
  await client.until(() => !client.view().running);
}

/** Runs a whole OAuth round trip; returns the callback's response. */
async function signIn(
  provider: Provider,
  code: string | ((state: string) => URLSearchParams)
) {
  const start = await fetchWorker(new Request(`${ORIGIN}/auth/${provider}`));
  expect(start.status).toBe(303);
  const authorize = new URL(start.headers.get("Location")!);
  const state = authorize.searchParams.get("state")!;
  const flowCookie = cookiePair(start.headers.get("Set-Cookie")!);
  const params =
    typeof code === "string" ? new URLSearchParams({ code, state }) : code(state);
  return fetchWorker(
    new Request(`${ORIGIN}/auth/${provider}/callback?${params}`, {
      headers: { Cookie: flowCookie }
    })
  );
}

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

  it("gives the same id on Google and GitHub separate agents", async () => {
    const google = person("same-id", "google");
    const github = person("same-id", "github");
    expect(await agentNameFor(google)).not.toBe(await agentNameFor(github));
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
    expect(location.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    const flow = response.headers.get("Set-Cookie")!;
    expect(flow).toMatch(/^__Host-oauth=.+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  });

  it("signs in with GitHub and opens the same agent on every sign-in", async () => {
    const id = String(Math.floor(Math.random() * 1e9));
    const response = await signIn("github", `ok:${id}:octo@example.com`);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    const session = sessionFrom(response)!;
    expect(session).toContain("HttpOnly; Secure; SameSite=Lax");

    const me = await fetchWorker(
      new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookiePair(session) } })
    );
    expect(await me.json()).toEqual({ email: "octo@example.com", provider: "github" });

    const again = sessionFrom(await signIn("github", `ok:${id}:octo@example.com`))!;
    const first = await connect(person(id, "github"));
    const socket = await fetchWorker(wsRequest({ cookie: cookiePair(again) }));
    expect(socket.status).toBe(101);
    first.socket.close();
  });

  it("signs in with Google", async () => {
    const response = await signIn("google", "ok:google-sub-1:g@example.com");
    expect(response.status).toBe(303);
    const session = sessionFrom(response)!;
    const me = await fetchWorker(
      new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookiePair(session) } })
    );
    expect(await me.json()).toEqual({ email: "g@example.com", provider: "google" });
  });

  it("rejects a callback whose state does not match", async () => {
    const response = await signIn(
      "github",
      () => new URLSearchParams({ code: "ok:1:a@example.com", state: "forged" })
    );
    expect(response.headers.get("Location")).toBe("/?signin_error=state");
    expect(sessionFrom(response)).toBeUndefined();
  });

  it("rejects a callback without the flow cookie", async () => {
    const response = await fetchWorker(
      new Request(`${ORIGIN}/auth/github/callback?code=ok:1:a@example.com&state=x`)
    );
    expect(response.headers.get("Location")).toBe("/?signin_error=state");
    expect(sessionFrom(response)).toBeUndefined();
  });

  it("reports a cancelled consent", async () => {
    const response = await signIn(
      "google",
      (state) => new URLSearchParams({ error: "access_denied", state })
    );
    expect(response.headers.get("Location")).toBe("/?signin_error=denied");
    expect(sessionFrom(response)).toBeUndefined();
  });

  it("reports a code the provider rejects", async () => {
    for (const provider of ["google", "github"] as const) {
      const response = await signIn(provider, "not-a-valid-code");
      expect(response.headers.get("Location")).toBe("/?signin_error=token");
      expect(sessionFrom(response)).toBeUndefined();
    }
  });

  it("does not accept one provider's flow at another's callback", async () => {
    const start = await fetchWorker(new Request(`${ORIGIN}/auth/google`));
    const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
    const response = await fetchWorker(
      new Request(`${ORIGIN}/auth/github/callback?code=ok:1:a@example.com&state=${state}`, {
        headers: { Cookie: cookiePair(start.headers.get("Set-Cookie")!) }
      })
    );
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
