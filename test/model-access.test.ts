/**
 * Who pays for model calls: a person's own key (sealed in their agent, sent
 * straight to the vendor), the operator's demo lane (capped per person and per
 * Workspace domain, before each call), or nobody. The vendors are the fakes
 * in `fake-models.ts`; the demo lane is pi-ai's faux provider, counted.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Entitlement } from "../src/model-router";
import { gatewayDemoLane, nativeProviders } from "../src/model-router";
import { keyContext } from "../src/model-keys";
import { Sealer } from "../src/poppy/store";
import { agentNameFor, type Identity } from "../src/session";
import { openRouterCode, openRouterKeyFor } from "./fake-models";
import { chat, connect, cookiePair, fetchWorker, ORIGIN, sessionCookie } from "./agent-helpers";
import type { PersonalAgent } from "./worker";

const testEnv = env as Env;

function someone(domain: string, provider: Identity["provider"] = "google"): Identity {
  const sub = `${provider === "github" ? Math.floor(Math.random() * 1e9) + 1e9 : `m${crypto.randomUUID()}`}`;
  return { provider, sub, email: `${sub}@${domain}`, domain };
}

async function stubFor(identity: Identity) {
  return testEnv.PersonalAgent.getByName(await agentNameFor(identity)) as unknown as DurableObjectStub<PersonalAgent>;
}

async function api(identity: Identity, path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", await sessionCookie(identity));
  if (!headers.has("Origin")) headers.set("Origin", ORIGIN);
  return fetchWorker(new Request(`${ORIGIN}${path}`, { ...init, headers }), overrides);
}

async function entitlement(identity: Identity): Promise<Entitlement> {
  const response = await api(identity, "/api/entitlement");
  expect(response.status).toBe(200);
  return response.json();
}

async function saveKey(identity: Identity, provider: string, key: string) {
  return api(identity, "/api/model-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, key })
  });
}

/** Send a message and wait for pi to finish with it, answered or not. */
async function send(connection: Awaited<ReturnType<typeof connect>>, text: string) {
  const { socket, client } = connection;
  const before = client.frames.length;
  socket.send(JSON.stringify({ type: "submit", id: crypto.randomUUID(), input: text }));
  await client.until(() => client.frames.length > before && !client.view().running && client.texts().some((t) => t === `user: ${text}`));
  await client.until(() => !client.view().running);
}

const ANTHROPIC_KEY = () => `sk-ant-test-good-${crypto.randomUUID()}`;

describe("own keys: the key never leaves the agent", () => {
  it("is never in a response, a frame, the transcript, the Activity log, storage in the clear, or a log", async () => {
    const identity = someone("nokey.example");
    const key = ANTHROPIC_KEY();
    const stub = await stubFor(identity);
    const mark = await stub.poppyLogMark();

    const saved = await saveKey(identity, "anthropic", key);
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(savedText).not.toContain(key);
    expect(JSON.parse(savedText)).toMatchObject({ lane: "own_key", reason: null, key: { provider: "anthropic", status: "valid", source: "pasted" } });

    const connection = await connect(identity);
    await chat(connection.socket, connection.client, "hello with a key", "fake Anthropic (claude-opus-5-5) answers: hello with a key");
    connection.socket.send(JSON.stringify({ type: "poppy.context", locale: "en-GB", time_zone: "Europe/London" }));
    await connection.client.until(() => connection.client.frames.some((frame) => frame.type === "poppy.activity"));

    const entitled = await api(identity, "/api/entitlement");
    expect(await entitled.text()).not.toContain(key);
    expect(JSON.stringify(connection.client.frames)).not.toContain(key);
    const storage = await stub.poppyDumpStorage();
    expect(storage).not.toContain(key);
    expect(storage).toContain('"sealed":"v1.');
    expect((await stub.poppyLogsSince(mark)).join("\n")).not.toContain(key);
    expect(await stub.demoCallCount()).toBe(0);
    connection.socket.close();
  });

  it("checks a key with the vendor before sealing it, and refuses one the vendor refuses", async () => {
    const identity = someone("nokey.example");
    const refused = await saveKey(identity, "anthropic", "sk-ant-test-bad-0123456789abcdef");
    expect(refused.status).toBe(400);
    const body = await refused.text();
    expect(body).toContain("Anthropic refused that key.");
    expect(body).not.toContain("sk-ant-test-bad");
    expect((await entitlement(identity)).key).toBeNull();

    const malformed = await saveKey(identity, "anthropic", "sk-openai-shaped-0123456789");
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toContain("start with sk-ant-");
  });

  it("only takes keys from this origin, from a signed-in person", async () => {
    const identity = someone("nokey.example");
    const crossSite = await api(identity, "/api/model-key", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ provider: "anthropic", key: ANTHROPIC_KEY() })
    });
    expect(crossSite.status).toBe(403);
    const anonymous = await fetchWorker(
      new Request(`${ORIGIN}/api/model-key`, { method: "POST", headers: { Origin: ORIGIN }, body: "{}" })
    );
    expect(anonymous.status).toBe(401);
    expect((await fetchWorker(new Request(`${ORIGIN}/api/entitlement`))).status).toBe(401);
  });

  it("uses an OpenAI key through OpenAI's own API, and forgets a removed key", async () => {
    const identity = someone("nokey.example");
    expect((await saveKey(identity, "openai", `sk-test-good-${crypto.randomUUID()}`)).status).toBe(200);
    const connection = await connect(identity);
    await chat(connection.socket, connection.client, "hi OpenAI", "fake OpenAI (gpt-6.1-sol) answers: hi OpenAI");
    connection.socket.close();

    const removed = await api(identity, "/api/model-key", { method: "DELETE" });
    expect(await removed.json()).toMatchObject({ lane: "none", reason: "no_key", key: null });
  });
});

describe("own keys: sealing", () => {
  it("binds a sealed key to its agent and provider: another context doesn't open it", async () => {
    const identity = someone("nokey.example");
    const key = ANTHROPIC_KEY();
    expect((await saveKey(identity, "anthropic", key)).status).toBe(200);
    const stub = await stubFor(identity);
    const [row] = JSON.parse(await stub.poppySql("SELECT sealed FROM model_keys")) as Array<{ sealed: string }>;
    const agent = testEnv.PersonalAgent.idFromName(await agentNameFor(identity)).toString();
    const other = testEnv.PersonalAgent.idFromName("someone-else").toString();
    expect(await stub.poppyOpenSealed(row!.sealed, keyContext("anthropic", agent))).toBe(key);
    expect(await stub.poppyOpenSealed(row!.sealed, keyContext("anthropic", other))).toBeNull();
    expect(await stub.poppyOpenSealed(row!.sealed, keyContext("openai", agent))).toBeNull();
  });

  it("versions sealed values, and opens ones sealed under TOKEN_ENC_KEY_PREVIOUS as stale", async () => {
    const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const oldKey = random();
    const newKey = random();
    const sealed = await new Sealer({ TOKEN_ENC_KEY: oldKey }).seal("secret", "ctx");
    expect(sealed.startsWith("v1.")).toBe(true);
    await expect(new Sealer({ TOKEN_ENC_KEY: newKey }).open(sealed, "ctx")).rejects.toThrow();
    const rotating = new Sealer({ TOKEN_ENC_KEY: newKey, TOKEN_ENC_KEY_PREVIOUS: oldKey });
    expect(await rotating.openChecked(sealed, "ctx")).toEqual({ plaintext: "secret", current: false });
    const resealed = await rotating.seal("secret", "ctx");
    expect(await rotating.openChecked(resealed, "ctx")).toEqual({ plaintext: "secret", current: true });
    // Values sealed before the prefix existed still open, and count as stale.
    expect(await new Sealer({ TOKEN_ENC_KEY: oldKey }).openChecked(sealed.slice(3), "ctx")).toEqual({ plaintext: "secret", current: false });
    await expect(rotating.open(sealed, "another ctx")).rejects.toThrow();
  });
});

describe("precedence and who pays", () => {
  it("uses a person's own key even when they are on the demo, and never calls the demo lane", async () => {
    const identity = someone("workspace.example");
    expect(await entitlement(identity)).toMatchObject({ lane: "demo", reason: null, key: null });
    expect((await saveKey(identity, "anthropic", ANTHROPIC_KEY())).status).toBe(200);
    expect(await entitlement(identity)).toMatchObject({ lane: "own_key", model: { provider: "anthropic", id: "claude-opus-5-5" } });
    const connection = await connect(identity);
    await chat(connection.socket, connection.client, "who answers?", "fake Anthropic (claude-opus-5-5) answers: who answers?");
    expect(await (await stubFor(identity)).demoCallCount()).toBe(0);
    connection.socket.close();
  });

  it("sends own-key calls only to pi-ai's vendor providers, never the AI binding", () => {
    expect(nativeProviders().map((provider) => provider.id)).toEqual(["anthropic", "openai", "openrouter"]);
  });

  it("tags demo calls with the agent and its budget domain, on the demo gateway", async () => {
    const calls: Array<{ id: string; options: unknown }> = [];
    const binding = {
      gateway: (id: string) => ({
        run: async (_request: unknown, options: unknown) => {
          calls.push({ id, options });
          throw new Error("not a real gateway");
        }
      })
    } as unknown as Ai;
    const { provider, model } = gatewayDemoLane({ ...env, AI: binding }, { u: "agent-hash", d: "corp.example" });
    const stream = provider.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never);
    await stream.result();
    expect(calls[0]?.id).toBe("demo");
    expect(JSON.stringify(calls[0]?.options)).toContain('"metadata":{"u":"agent-hash","d":"corp.example"}');
  });
});

describe("demo caps", () => {
  it("refuses a call once the person has spent today's cap, before calling", async () => {
    const identity = someone("capped-user.example");
    const stub = await stubFor(identity);
    const connection = await connect(identity);
    await chat(connection.socket, connection.client, "[cost 0.6] one");
    await chat(connection.socket, connection.client, "[cost 0.6] two");
    expect(await stub.demoCallCount()).toBe(2);
    expect(await entitlement(identity)).toMatchObject({ lane: "none", reason: "user_cap", demo: { capUsd: 1, domainCapped: false } });
    expect((await entitlement(identity)).demo?.spentUsd).toBeCloseTo(1.2);

    await send(connection, "three");
    expect(await stub.demoCallCount()).toBe(2);
    expect((await stub.lastAssistant()).error).toContain("you've used today's demo allowance");
    const cards = JSON.parse(await stub.poppyCards()) as Array<{ id: string; open: boolean; text: string }>;
    expect(cards.find((card) => card.id === "model-access")).toMatchObject({ open: true });
    connection.socket.close();
  });

  it("refuses everyone in a Workspace domain once the domain has spent its cap", async () => {
    const first = someone("capped-domain.example");
    const second = someone("capped-domain.example");
    const a = await connect(first);
    const b = await connect(second);
    await chat(a.socket, a.client, "[cost 0.9] from the first");
    await chat(b.socket, b.client, "[cost 0.9] from the second");
    expect(await entitlement(first)).toMatchObject({ lane: "none", reason: "domain_cap", demo: { domainCapped: true } });
    expect(await entitlement(second)).toMatchObject({ lane: "none", reason: "domain_cap" });

    await send(a, "again from the first");
    expect(await (await stubFor(first)).demoCallCount()).toBe(1);
    expect((await (await stubFor(first)).lastAssistant()).error).toContain("your organisation has used today's demo allowance");
    // Someone in another domain is unaffected.
    expect(await entitlement(someone("workspace.example"))).toMatchObject({ lane: "demo" });
    a.socket.close();
    b.socket.close();
  });

  it("holds a background turn past the cap, with a notice, and never calls the model for it", async () => {
    const identity = someone("capped-background.example");
    const stub = await stubFor(identity);
    const connection = await connect(identity);
    await chat(connection.socket, connection.client, "[cost 1.1] spend it all");
    expect(await stub.demoCallCount()).toBe(1);

    await stub.backgroundTurn("[company message] Acme: your order shipped", "op-background-1");
    expect(await stub.demoCallCount()).toBe(1);
    expect(JSON.parse(await stub.poppySql("SELECT operation_id FROM model_paused"))).toEqual([{ operation_id: "op-background-1" }]);
    const card = (JSON.parse(await stub.poppyCards()) as Array<{ id: string; open: boolean; text: string }>).find((item) => item.id === "model-access");
    expect(card?.open).toBe(true);
    expect(card?.text).toContain("1 update from a Company is waiting for it.");
    connection.socket.close();
  });
});

describe("no key", () => {
  it("makes no model calls, says so, and runs held background turns once a key is added", async () => {
    const identity = someone("nokey.example");
    const stub = await stubFor(identity);
    expect(await entitlement(identity)).toMatchObject({ lane: "none", reason: "no_key", demo: null, key: null });

    const connection = await connect(identity);
    await send(connection, "anyone there?");
    expect((await stub.lastAssistant()).error).toContain("this agent has no model key");
    expect(await stub.demoCallCount()).toBe(0);

    await stub.backgroundTurn("[company message] Acme: a reply arrived", "op-held-1");
    expect(JSON.parse(await stub.poppySql("SELECT COUNT(*) AS n FROM model_paused"))).toEqual([{ n: 1 }]);

    expect((await saveKey(identity, "anthropic", ANTHROPIC_KEY())).status).toBe(200);
    expect(JSON.parse(await stub.poppySql("SELECT COUNT(*) AS n FROM model_paused"))).toEqual([{ n: 0 }]);
    await connection.client.until(() =>
      connection.client.texts().includes("assistant: fake Anthropic (claude-opus-5-5) answers: [company message] Acme: a reply arrived")
    );
    const card = (JSON.parse(await stub.poppyCards()) as Array<{ id: string; open: boolean }>).find((item) => item.id === "model-access");
    expect(card?.open).toBe(false);
    connection.socket.close();
  });
});

describe("a key the vendor stops accepting", () => {
  it("marks the key invalid on a 401, stops model calls, and never falls back to the demo", async () => {
    const identity = someone("workspace.example");
    const stub = await stubFor(identity);
    const key = `sk-ant-test-revoked-${crypto.randomUUID()}`;
    expect((await saveKey(identity, "anthropic", key)).status).toBe(200);

    const connection = await connect(identity);
    await send(connection, "are you there?");
    expect((await stub.lastAssistant()).error).toContain("Anthropic refused your key (401)");
    expect(await entitlement(identity)).toMatchObject({ lane: "none", reason: "key_invalid", key: { provider: "anthropic", status: "invalid" } });
    const card = (JSON.parse(await stub.poppyCards()) as Array<{ id: string; open: boolean; text: string }>).find((item) => item.id === "model-access");
    expect(card).toMatchObject({ open: true });
    expect(card?.text).toContain("It won't use the demo instead.");

    await send(connection, "still there?");
    expect((await stub.lastAssistant()).error).toContain("refused your key");
    expect(await stub.demoCallCount()).toBe(0);
    expect(await stub.poppyDumpStorage()).not.toContain(key);
    connection.socket.close();
  });
});

describe("connecting OpenRouter (PKCE)", () => {
  async function start(identity: Identity) {
    const response = await api(identity, "/auth/openrouter/start");
    expect(response.status).toBe(303);
    const authorize = new URL(response.headers.get("Location")!);
    return { authorize, cookie: cookiePair(response.headers.get("Set-Cookie")!) };
  }

  function consent(authorize: URL, refuse = false) {
    return openRouterCode({
      challenge: authorize.searchParams.get("code_challenge")!,
      challengeMethod: authorize.searchParams.get("code_challenge_method")!,
      callbackUrl: authorize.searchParams.get("callback_url")!,
      refuse
    });
  }

  async function callback(identity: Identity, flowCookie: string, params: Record<string, string>) {
    const headers = new Headers({ Cookie: `${await sessionCookie(identity)}; ${flowCookie}` });
    return fetchWorker(new Request(`${ORIGIN}/auth/openrouter/callback?${new URLSearchParams(params)}`, { headers }));
  }

  it("sends the browser to OpenRouter with state and an S256 challenge, then stores the key it issues", async () => {
    const identity = someone("nokey.example");
    const { authorize, cookie } = await start(identity);
    expect(authorize.origin + authorize.pathname).toBe("https://openrouter.ai/auth");
    expect(authorize.searchParams.get("callback_url")).toBe(`${ORIGIN}/auth/openrouter/callback`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(authorize.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(cookie).toMatch(/^__Host-openrouter=/);

    const done = await callback(identity, cookie, { code: consent(authorize), state: authorize.searchParams.get("state")! });
    expect(done.headers.get("Location")).toBe("/settings?model_key=connected");
    expect(await entitlement(identity)).toMatchObject({ lane: "own_key", key: { provider: "openrouter", source: "openrouter" } });

    const key = openRouterKeyFor({ challenge: authorize.searchParams.get("code_challenge")! });
    const connection = await connect(identity);
    await chat(connection.socket, connection.client, "via OpenRouter", "fake OpenRouter (anthropic/claude-opus-5.5) answers: via OpenRouter");
    expect(JSON.stringify(connection.client.frames)).not.toContain(key);
    expect(await (await stubFor(identity)).poppyDumpStorage()).not.toContain(key);
    connection.socket.close();
  });

  it("refuses a callback whose state doesn't match, or that another person's browser started", async () => {
    const identity = someone("nokey.example");
    const { authorize, cookie } = await start(identity);
    const forged = await callback(identity, cookie, { code: consent(authorize), state: "forged" });
    expect(forged.headers.get("Location")).toBe("/settings?model_key_error=state");

    const intruder = someone("nokey.example");
    const stolen = await callback(intruder, cookie, { code: consent(authorize), state: authorize.searchParams.get("state")! });
    expect(stolen.headers.get("Location")).toBe("/settings?model_key_error=state");
    expect((await entitlement(identity)).key).toBeNull();
    expect((await entitlement(intruder)).key).toBeNull();
  });

  it("refuses a code minted for another flow's challenge: the verifier doesn't match", async () => {
    const identity = someone("nokey.example");
    const attacker = await start(someone("nokey.example"));
    const victim = await start(identity);
    const response = await callback(identity, victim.cookie, {
      code: consent(attacker.authorize),
      state: victim.authorize.searchParams.get("state")!
    });
    expect(response.headers.get("Location")).toBe("/settings?model_key_error=exchange");
    expect((await entitlement(identity)).key).toBeNull();
  });

  it("reports a refusal at OpenRouter, and a person who declined", async () => {
    const identity = someone("nokey.example");
    const flow = await start(identity);
    const refused = await callback(identity, flow.cookie, { code: consent(flow.authorize, true), state: flow.authorize.searchParams.get("state")! });
    expect(refused.headers.get("Location")).toBe("/settings?model_key_error=exchange");
    const declined = await callback(identity, flow.cookie, { error: "access_denied", state: flow.authorize.searchParams.get("state")! });
    expect(declined.headers.get("Location")).toBe("/settings?model_key_error=denied");
    expect((await entitlement(identity)).key).toBeNull();
  });
});

describe("SIGNUP", () => {
  it("allowlist: lets in owners and the sign-in allowlist only, as before", async () => {
    const me = (identity: Identity, overrides: Partial<Env> = {}) => api(identity, "/api/me", {}, overrides);
    expect((await me(someone("workspace.example"))).status).toBe(200);
    expect((await me(someone("stranger.example"))).status).toBe(401);
    expect((await me({ provider: "google", sub: "owner-sub", email: "owner@example.com", domain: null })).status).toBe(200);
    expect((await me({ provider: "github", sub: "4141", email: null, domain: null })).status).toBe(200);
  });

  it("open: lets anyone in, who then needs a key unless they are on the demo", async () => {
    const stranger = someone("stranger.example");
    const open = { SIGNUP: "open" } as unknown as Partial<Env>;
    expect((await api(stranger, "/api/me", {}, open)).status).toBe(200);
    const response = await api(stranger, "/api/entitlement", {}, open);
    expect(await response.json()).toMatchObject({ lane: "none", reason: "no_key", demo: null });
  });
});
