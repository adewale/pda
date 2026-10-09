import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject } from "cloudflare:test";
import { createAI } from "agents/models/pi-ai";
import { generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { agentNameFor } from "../src/identity";
import type { PiServerMessage } from "../src/protocol";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../src/view";
import worker from "./worker";

const ORIGIN = "https://agent.example.com";

type Claims = {
  sub?: string;
  email?: string;
  iss?: string;
  aud?: string;
  /** Seconds from now; negative is already expired. */
  expiresIn?: number;
};

async function accessJwt(claims: Claims = {}, key?: CryptoKey): Promise<string> {
  const jwk = JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK;
  const signingKey = key ?? ((await importJWK(jwk, "RS256")) as CryptoKey);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email ?? "person@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid ?? "test-key" })
    .setSubject(claims.sub ?? "user-1")
    .setIssuer(claims.iss ?? env.TEAM_DOMAIN)
    .setAudience(claims.aud ?? env.POLICY_AUD)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + (claims.expiresIn ?? 300))
    .sign(signingKey);
}

function wsRequest(
  init: { jwt?: string; origin?: string; upgrade?: boolean; query?: string } = {}
): Request {
  const headers = new Headers();
  if (init.upgrade !== false) headers.set("Upgrade", "websocket");
  headers.set("Origin", init.origin ?? ORIGIN);
  if (init.jwt) headers.set("Cf-Access-Jwt-Assertion", init.jwt);
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

async function connect(sub: string, query = "") {
  const response = await fetchWorker(
    wsRequest({ jwt: await accessJwt({ sub }), query })
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

describe("the /ws route", () => {
  it("refuses a request without a WebSocket upgrade", async () => {
    const response = await fetchWorker(
      wsRequest({ jwt: await accessJwt(), upgrade: false })
    );
    expect(response.status).toBe(426);
  });

  it("refuses an upgrade from another origin", async () => {
    const response = await fetchWorker(
      wsRequest({ jwt: await accessJwt(), origin: "https://evil.example" })
    );
    expect(response.status).toBe(403);
  });

  it("refuses a missing Access JWT", async () => {
    expect((await fetchWorker(wsRequest())).status).toBe(401);
  });

  it("refuses a JWT for the wrong audience", async () => {
    const jwt = await accessJwt({ aud: "someone-elses-app" });
    expect((await fetchWorker(wsRequest({ jwt }))).status).toBe(401);
  });

  it("refuses a JWT from the wrong issuer", async () => {
    const jwt = await accessJwt({ iss: "https://other.cloudflareaccess.com" });
    expect((await fetchWorker(wsRequest({ jwt }))).status).toBe(401);
  });

  it("refuses an expired JWT", async () => {
    const jwt = await accessJwt({ expiresIn: -60 });
    expect((await fetchWorker(wsRequest({ jwt }))).status).toBe(401);
  });

  it("refuses a JWT signed by an unknown key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const jwt = await accessJwt({}, privateKey);
    expect((await fetchWorker(wsRequest({ jwt }))).status).toBe(401);
  });

  it("does not route the SDK's /agents/<class>/<name> path", async () => {
    const request = new Request(`${ORIGIN}/agents/personal-agent/anyone`, {
      headers: { Upgrade: "websocket", Origin: ORIGIN }
    });
    expect((await fetchWorker(request)).status).toBe(404);
  });

  it("connects a valid JWT to the person's agent, named by a hash", async () => {
    const sub = `user-${crypto.randomUUID()}`;
    const { socket, client } = await connect(sub);
    const identity = client.frames.find((f) => f.type === "cf_agent_identity");
    const name = await agentNameFor({ sub, email: undefined });
    expect(identity).toMatchObject({ name });
    expect(JSON.stringify(identity)).not.toContain(sub);
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
    const sub = `user-${crypto.randomUUID()}`;
    const { socket, client } = await connect(sub, "?session=2&name=someone-else");
    expect(client.frames.find((f) => f.type === "hello")).toMatchObject({
      session: "1"
    });
    expect(client.frames.find((f) => f.type === "cf_agent_identity")).toMatchObject({
      name: await agentNameFor({ sub, email: undefined })
    });
    socket.close();
  });
});

describe("the conversation", () => {
  it("runs a chat turn that folds into user and assistant bubbles", async () => {
    const { socket, client } = await connect(`user-${crypto.randomUUID()}`);
    await chat(socket, client, "hello", "echo: hello (turn 1)");
    expect(client.texts()).toEqual(["user: hello", "assistant: echo: hello (turn 1)"]);
    socket.close();
  });

  it("keeps two people's conversations apart", async () => {
    const a = await connect(`user-a-${crypto.randomUUID()}`);
    const b = await connect(`user-b-${crypto.randomUUID()}`);
    await chat(a.socket, a.client, "secret of A", "echo: secret of A (turn 1)");
    await chat(b.socket, b.client, "hi from B", "echo: hi from B (turn 1)");
    expect(b.client.texts().join("\n")).not.toContain("secret of A");
    expect(a.client.texts().join("\n")).not.toContain("hi from B");
    a.socket.close();
    b.socket.close();
  });

  it("brings the whole history back after a reconnect and a crash", async () => {
    const sub = `user-${crypto.randomUUID()}`;
    const first = await connect(sub);
    await chat(first.socket, first.client, "one", "echo: one (turn 1)");
    first.socket.close();

    const second = await connect(sub);
    expect(second.client.texts()).toEqual(["user: one", "assistant: echo: one (turn 1)"]);
    second.socket.close();

    await abortAllDurableObjects();

    const third = await connect(sub);
    expect(third.client.texts()).toEqual(["user: one", "assistant: echo: one (turn 1)"]);
    await chat(third.socket, third.client, "two", "echo: two (turn 2)");
    third.socket.close();
  });

  it("answers on an open socket after the object is evicted", async () => {
    const sub = `user-${crypto.randomUUID()}`;
    const { socket, client } = await connect(sub);
    const stub = env.PersonalAgent.getByName(
      await agentNameFor({ sub, email: undefined })
    );
    await evictDurableObject(stub);
    await chat(socket, client, "after eviction", "echo: after eviction (turn 1)");
    socket.close();
  });
});

describe("configuration", () => {
  it("fails with an error naming a missing var", async () => {
    const response = await fetchWorker(wsRequest({ jwt: await accessJwt() }), {
      MODEL_ID: "" as Env["MODEL_ID"]
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("MODEL_ID");
  });

  it("rejects a misspelt thinking level, naming the var", async () => {
    const response = await fetchWorker(wsRequest({ jwt: await accessJwt() }), {
      THINKING_LEVEL: "meduim" as Env["THINKING_LEVEL"]
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("THINKING_LEVEL");
  });

  it("resolves the configured MODEL_ID in the gateway catalog as Claude Opus 5.5", () => {
    const ai = createAI({ binding: {} as Ai, id: env.AI_GATEWAY_ID });
    const model = ai(env.MODEL_ID) as { name?: string; id: string };
    expect(model.name).toBe("Claude Opus 5.5");
  });
});

describe("/api/me", () => {
  it("returns the verified email", async () => {
    const request = new Request(`${ORIGIN}/api/me`, {
      headers: {
        "Cf-Access-Jwt-Assertion": await accessJwt({ email: "me@example.com" })
      }
    });
    const response = await fetchWorker(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "me@example.com" });
  });

  it("refuses a request without an Access JWT", async () => {
    const response = await fetchWorker(new Request(`${ORIGIN}/api/me`));
    expect(response.status).toBe(401);
  });
});
