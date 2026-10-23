/**
 * Who pays for model calls: a person's own key (sealed in their agent, sent
 * straight to the vendor), the operator's demo lane (capped per person and per
 * Workspace domain, before each call), or nobody. The vendors are the fakes
 * in `fake-models.ts`; the demo lane is pi-ai's faux provider, counted.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Entitlement } from "../src/model-router";
import { demoCatalogModel, gatewayDemoLane, nativeProviders, refusalText } from "../src/model-router";
import { calculateCost } from "@earendil-works/pi-ai";
import { keyContext } from "../src/model-keys";
import { Sealer } from "../src/poppy/store";
import { agentNameFor, type Identity } from "../src/session";
import { keyState } from "./fake-models";
import { chat, connect, fetchWorker, ORIGIN, sessionCookie, until } from "./agent-helpers";
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

async function saveKey(identity: Identity, provider: string, key: string, workspace?: unknown) {
  return api(identity, "/api/model-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, key, ...(workspace === undefined ? {} : { workspace }) })
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
    await chat(connection.socket, connection.client, "hello with a key", "fake Anthropic (claude-sonnet-5-5) answers: hello with a key");
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

  it("quotes the vendor's own reason when it answers a key check with something other than a refusal, with the key redacted", async () => {
    const identity = someone("nokey.example");
    const key = "sk-ant-test-broke-0123456789abcdef";
    const answer = await saveKey(identity, "anthropic", key);
    expect(answer.status).toBe(400);
    const body = await answer.text();
    expect(body).toContain("Anthropic answered 400 (invalid_request_error: Your credit balance is too low to access the Anthropic API (key [key]).); the key wasn't saved.");
    expect(body).not.toContain("Try again");
    expect(body).not.toContain("sk-ant-test-broke");
    expect((await entitlement(identity)).key).toBeNull();
  });

  it("takes an Anthropic workspace ID for an organization-wide key, and sends it on the check and every model call", async () => {
    const identity = someone("nokey.example");
    const key = `sk-ant-test-unscoped-workspace_wrkspc_01TestWorkspace-${crypto.randomUUID()}`;

    const without = await saveKey(identity, "anthropic", key);
    expect(without.status).toBe(400);
    const said = await without.text();
    expect(said).toContain("must include the anthropic-workspace-id header");
    expect(said).toContain("Add the key's workspace ID from the Anthropic Console, or use a key created inside a workspace.");
    expect((await entitlement(identity)).key).toBeNull();

    expect((await saveKey(identity, "anthropic", key, "wrkspc 01")).status).toBe(400);
    expect(await (await saveKey(identity, "openai", "sk-test-good-0123456789abcdef", "wrkspc_01")).text()).toContain("Only Anthropic keys take a workspace ID.");
    expect((await saveKey(identity, "anthropic", key, 42)).status).toBe(400);

    const saved = await saveKey(identity, "anthropic", key, " wrkspc_01TestWorkspace ");
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ lane: "own_key", key: { provider: "anthropic", status: "valid", workspace: "wrkspc_01TestWorkspace" } });

    // This fake key requires exactly wrkspc_01TestWorkspace on checks and model calls.
    const connection = await connect(identity);
    await chat(connection.socket, connection.client, "hello from a workspace", "fake Anthropic (claude-sonnet-5-5) answers: hello from a workspace");
    connection.socket.close();
  });

  it("fake vendors: `bad` and `revoked` are whole key segments, so a random key never spells them by chance", () => {
    // A random UUID suffix contains `bad` in about 0.7% of keys; such a key is an ordinary one.
    expect(keyState("sk-ant-test-good-3fbad1e2-revoked7", "sk-ant-test-")).toBe("ok");
    expect(keyState("sk-test-good-0abadc", "sk-test-")).toBe("ok");
    expect(keyState("sk-ant-test-bad-0123", "sk-ant-test-")).toBe("refused");
    expect(keyState("sk-ant-test-revoked-0123", "sk-ant-test-")).toBe("revoked");
    expect(keyState("sk-test-0123", "sk-ant-test-")).toBe("refused");
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
    expect(await entitlement(identity)).toMatchObject({ lane: "own_key", model: { provider: "anthropic", id: "claude-sonnet-5-5" } });
    const connection = await connect(identity);
    await chat(connection.socket, connection.client, "who answers?", "fake Anthropic (claude-sonnet-5-5) answers: who answers?");
    expect(await (await stubFor(identity)).demoCallCount()).toBe(0);
    connection.socket.close();
  });

  it("sends own-key calls only to pi-ai's vendor providers, never the AI binding", () => {
    expect(nativeProviders().map((provider) => provider.id)).toEqual(["anthropic", "openai"]);
  });

  it("tags demo calls with the agent and its budget domain, on the demo gateway, and prices them by pi-ai's catalog", async () => {
    const calls: Array<{ id: string; options: unknown }> = [];
    // The demo model speaks Anthropic Messages through the gateway; its stream reports usage.
    const usage = { input_tokens: 1_234, output_tokens: 567 };
    const sse = [
      ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-sonnet-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }],
      ["message_stop", { type: "message_stop" }]
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    const binding = {
      gateway: (id: string) => ({
        run: async (_request: unknown, options: unknown) => {
          calls.push({ id, options });
          return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
        }
      })
    } as unknown as Ai;
    const { provider, model } = gatewayDemoLane({ ...env, AI: binding }, { u: "agent-hash", d: "corp.example" });
    const stream = provider.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never);
    const message = await stream.result();
    expect(calls[0]?.id).toBe("demo");
    expect(JSON.stringify(calls[0]?.options)).toContain('"metadata":{"u":"agent-hash","d":"corp.example"}');
    expect(message.stopReason).toBe("stop");
    expect(message.usage).toMatchObject({ input: usage.input_tokens, output: usage.output_tokens });
    // What the ledger will be charged: the catalog's price for that usage, never zero.
    const priced = calculateCost(demoCatalogModel(env), { ...message.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
    expect(message.usage.cost.total).toBe(priced.total);
    expect(priced.total).toBeGreaterThan(0);
  });
});

describe("demo caps", () => {
  it("charges production's demo lane pi-ai's price for the usage it reports, and trips the cap on that, until the next UTC day", async () => {
    const identity = someone("metered.example");
    const stub = await stubFor(identity);
    // 50k tokens in and 70k out: under the $1 cap once, over it twice, at the catalog's prices (and well under the compaction threshold).
    const usage = { input_tokens: 50_000, output_tokens: 70_000 };
    await stub.useGatewayDemo(usage);
    const perCall = calculateCost(demoCatalogModel(testEnv), {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input_tokens + usage.output_tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }).total;
    expect(perCall).toBeGreaterThan(0.5);
    expect(perCall).toBeLessThan(1);

    const connection = await connect(identity);
    await send(connection, "first");
    expect((await stub.lastAssistant()).text).toBe("metered answer");
    expect(await entitlement(identity)).toMatchObject({ lane: "demo", demo: { spentUsd: perCall, capUsd: 1 } });
    await send(connection, "second");
    expect(await entitlement(identity)).toMatchObject({ lane: "none", reason: "user_cap", demo: { spentUsd: 2 * perCall } });
    await send(connection, "third");
    expect(await stub.demoCallCount()).toBe(2);
    expect((await stub.lastAssistant()).error).toContain("you've used today's demo allowance");

    // The next UTC day starts afresh.
    await stub.demoAdvance(24 * 60 * 60 * 1000);
    expect(await entitlement(identity)).toMatchObject({ lane: "demo", demo: { spentUsd: 0 } });
    connection.socket.close();
  });

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
    expect(await entitlement(first)).toMatchObject({ lane: "none", reason: "domain_cap", demo: { domainCapped: true, domain: "capped-domain.example" } });
    expect(await entitlement(second)).toMatchObject({ lane: "none", reason: "domain_cap" });

    await send(a, "again from the first");
    expect(await (await stubFor(first)).demoCallCount()).toBe(1);
    expect((await (await stubFor(first)).lastAssistant()).error).toContain("your organisation (capped-domain.example) has used today's demo allowance");
    // Someone in another domain is unaffected.
    expect(await entitlement(someone("workspace.example"))).toMatchObject({ lane: "demo" });
    a.socket.close();
    b.socket.close();
  });

  it("says the personal accounts' shared allowance ran out, never an organisation, for a personal Google or GitHub account", async () => {
    // octo, on the demo by GitHub id: the personal pool, so the entitlement names no domain.
    const demo = (await entitlement({ provider: "github", sub: "4242", email: null, domain: null })).demo;
    expect(demo).toMatchObject({ domain: null });
    const capped: Entitlement = { lane: "none", reason: "domain_cap", key: null, model: null, demo: { ...demo!, domainCapped: true } };
    expect(refusalText(capped)).toBe(
      "Model calls are paused: today's shared demo allowance for personal accounts is used up. It resets at midnight UTC, or add your own key in Settings."
    );
    expect(refusalText(capped)).not.toMatch(/organisation/);
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

describe("someone taken off the lists", () => {
  const NOBODY = { emails: [], domains: [], github: {} };

  it("makes no model call for a Company message's background turn, on the demo or their own key, and holds it until they're back", async () => {
    const onDemoOnly = someone("workspace.example");
    const withKey = someone("nokey.example");
    expect((await saveKey(withKey, "anthropic", ANTHROPIC_KEY())).status).toBe(200);
    for (const identity of [onDemoOnly, withKey]) {
      const stub = await stubFor(identity);
      expect((await api(identity, "/api/entitlement")).status).toBe(200);
      const calls = await stub.demoCallCount();
      await stub.deploymentOverride({ SIGNIN_ALLOWLIST: NOBODY });
      expect(await stub.entitlement(identity)).toMatchObject({ lane: "none", reason: "signed_out" });

      await stub.backgroundTurn("[company message] Acme: your order shipped", "op-removed-1");
      expect(await stub.demoCallCount()).toBe(calls);
      expect(await stub.poppyTranscript()).not.toContain("Acme: your order shipped");
      expect(JSON.parse(await stub.poppySql("SELECT operation_id FROM model_paused"))).toEqual([{ operation_id: "op-removed-1" }]);

      // Back on the list: their next signed-in request lets it through.
      await stub.deploymentOverride({});
      expect((await api(identity, "/api/entitlement")).status).toBe(200);
      expect(JSON.parse(await stub.poppySql("SELECT COUNT(*) AS n FROM model_paused"))).toEqual([{ n: 0 }]);
      await until(async () => (await stub.poppyTranscript()).includes("Acme: your order shipped") || undefined);
    }
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
      connection.client.texts().includes("assistant: fake Anthropic (claude-sonnet-5-5) answers: [company message] Acme: a reply arrived")
    );
    const card = (JSON.parse(await stub.poppyCards()) as Array<{ id: string; open: boolean }>).find((item) => item.id === "model-access");
    expect(card?.open).toBe(false);
    // Closed and kept out of the chat, as a dismissed card is: the warning going away says it.
    expect(JSON.parse(await stub.poppySql("SELECT updated_at FROM poppy_cards WHERE id = 'model-access'"))).toEqual([{ updated_at: 0 }]);
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

describe("only Anthropic and OpenAI keys", () => {
  it("has no OpenRouter sign-in, and refuses a pasted key for any other provider", async () => {
    const identity = someone("nokey.example");
    expect((await api(identity, "/auth/openrouter/start")).status).toBe(404);
    expect((await api(identity, "/auth/openrouter/callback?code=x&state=y")).status).toBe(404);
    const refused = await saveKey(identity, "openrouter", `sk-or-v1-${crypto.randomUUID()}`);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Choose Anthropic or OpenAI.");
    expect((await entitlement(identity)).key).toBeNull();
  });

  it("deletes an OpenRouter key stored before that lane was removed, unopened, and falls back as if there were none", async () => {
    const stored = async (identity: Identity) => {
      const stub = await stubFor(identity);
      await entitlement(identity); // creates the table
      await stub.poppySql(
        "INSERT INTO model_keys (slot, provider, sealed, status, source, added_at) VALUES (1, 'openrouter', 'v1.not-a-real-seal', 'valid', 'openrouter', ?)",
        Date.now()
      );
      return stub;
    };

    const nokey = someone("nokey.example");
    const stub = await stored(nokey);
    expect(await entitlement(nokey)).toMatchObject({ lane: "none", reason: "no_key", key: null });
    expect(JSON.parse(await stub.poppySql("SELECT COUNT(*) AS n FROM model_keys"))).toEqual([{ n: 0 }]);
    const connection = await connect(nokey);
    await send(connection, "still answering?");
    expect((await stub.lastAssistant()).error).toContain("this agent has no model key");
    connection.socket.close();

    const onDemo = someone("workspace.example");
    await stored(onDemo);
    expect(await entitlement(onDemo)).toMatchObject({ lane: "demo", reason: null, key: null });
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
    // The Worker and the agent read the same vars in production; here each is given them.
    await (await stubFor(stranger)).deploymentOverride({ SIGNUP: "open" });
    expect((await api(stranger, "/api/me", {}, open)).status).toBe(200);
    const response = await api(stranger, "/api/entitlement", {}, open);
    expect(await response.json()).toMatchObject({ lane: "none", reason: "no_key", demo: null });
  });
});
