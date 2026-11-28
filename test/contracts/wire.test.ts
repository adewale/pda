/**
 * Contracts for the fakes (`test/fake-models.ts`, the AI binding in
 * `test/worker.ts`): each wire PDA speaks, as the real pi-ai and `agents`
 * build it and as the fake answers it, recorded as shapes in
 * `test/contracts/fixtures/` and compared on every run.
 *
 * - **What we send.** A dependency that changes a request (an endpoint, a
 *   header, the body's structure, how it calls the AI binding) fails here,
 *   with the paths that changed, instead of passing against a fake that took
 *   the new request as readily as the old, or failing somewhere obscure.
 * - **What the fake answers.** Recorded from the fake (`"source": "fake"`)
 *   until `scripts/record-wire.mjs` replaces it with a recording of the real
 *   API (`"source": "live"`); then the fake may leave things out of its
 *   stream, but mustn't send what the real API never does.
 *
 * After reviewing a change: `UPDATE_CONTRACTS=1 npx vitest run --config
 * test/properties/vitest.config.ts test/contracts` rewrites what we send and,
 * for fixtures not yet recorded live, what the fake answers.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeContext, type Api, type AssistantMessage, type Context, type Model, type Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAI } from "agents/models/pi-ai";
import { withVendorCompat } from "../../src/model-catalog";
import { fakeModels } from "../fake-models";
import { inventedBy, paths, shapeOf, streamShape } from "./shape";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const UPDATE = process.env.UPDATE_CONTRACTS === "1";

/** One wire as a fixture holds it. */
type Fixture = {
  readonly wire: string;
  readonly request: { readonly method?: string; readonly path?: string; readonly headers?: readonly string[]; readonly body: readonly string[]; readonly call?: readonly string[] };
  readonly response: { readonly source: "fake" | "live"; readonly recorded?: string; readonly stream: Record<string, string[]> };
};

/** Request headers whose names say something about the wire: not transport noise. */
const NOISE = new Set(["content-length", "accept-encoding", "connection", "user-agent", "x-stainless-retry-count", "x-stainless-timeout"]);

function load(wire: string): Fixture | undefined {
  const file = path.join(FIXTURES, `${wire}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Fixture) : undefined;
}

/**
 * Compare a capture with its fixture, or (with `UPDATE_CONTRACTS=1`, or for
 * a wire with none yet) write it: the request always, the response only
 * while it is the fake's own.
 */
function check(captured: Fixture): void {
  const file = path.join(FIXTURES, `${captured.wire}.json`);
  const recorded = load(captured.wire);
  if (UPDATE || !recorded) {
    const response = recorded?.response.source === "live" ? recorded.response : captured.response;
    writeFileSync(file, `${JSON.stringify({ ...captured, response }, null, 2)}\n`);
    if (recorded?.response.source === "live") expect(inventedBy(captured.response.stream, recorded.response.stream), "what the fake sends that the real API doesn't").toEqual([]);
    return;
  }
  expect(captured.request, `${captured.wire}: what we send changed; review it, then UPDATE_CONTRACTS=1`).toEqual(recorded.request);
  if (recorded.response.source === "live") {
    expect(inventedBy(captured.response.stream, recorded.response.stream), `${captured.wire}: what the fake sends that the real API doesn't`).toEqual([]);
  } else {
    expect(captured.response.stream, `${captured.wire}: what the fake answers changed; review it, then UPDATE_CONTRACTS=1`).toEqual(recorded.response.stream);
  }
}

/** Every request pi-ai makes, through `fetch`, answered by the fakes and recorded. */
function capture(): Array<{ request: Request; body: string; response: string }> {
  const seen: Array<{ request: Request; body: string; response: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    const response = await fakeModels(request);
    if (!response) throw new Error(`no fake for ${request.url}`);
    seen.push({ request, body, response: await response.clone().text() });
    return response;
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * A turn that replays an earlier tool call and its result, so the request
 * carries every kind of block the agent sends. OpenAI's reasoning replays
 * only as its own encrypted item, which a hand-made history can't carry, so
 * its turn is the first, with tools offered.
 */
function conversation(model: Model<Api>): Context {
  if (model.api !== "anthropic-messages") {
    return {
      systemPrompt: "You are a test.",
      tools: [{ name: "calculate", description: "Exact arithmetic.", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } }],
      messages: [{ role: "user", content: "What is 6 times 7?", timestamp: 1 }]
    };
  }
  const earlier: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Use the calculator.", thinkingSignature: "c2lnLWtlcHQ=" },
      { type: "text", text: "Working it out." },
      { type: "toolCall", id: "call_1", name: "calculate", arguments: { expression: "6 * 7" } }
    ],
    api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 2
  };
  return {
    systemPrompt: "You are a test.",
    tools: [{ name: "calculate", description: "Exact arithmetic.", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } }],
    messages: [
      { role: "user", content: "What is 6 times 7?", timestamp: 1 },
      earlier,
      { role: "toolResult", toolCallId: "call_1", toolName: "calculate", content: [{ type: "text", text: "42" }], isError: false, timestamp: 3 },
      { role: "user", content: "Thanks", timestamp: 4 }
    ]
  };
}

/** One own-key turn through pi-ai's provider, against the fake. */
async function ownKeyTurn(wire: string, provider: Provider, modelId: string, apiKey: string): Promise<Fixture> {
  const model = provider.getModels().find((candidate) => candidate.id === modelId)!;
  expect(model, `${modelId} in pi-ai's ${provider.id} catalog`).toBeDefined();
  const seen = capture();
  const message = await provider.streamSimple(model, normalizeContext(conversation(model)), { apiKey, reasoning: "medium" }).result();
  expect(message.stopReason, `${wire}: the fake's answer, parsed by pi-ai (${message.errorMessage ?? ""})`).toBe("stop");
  expect(seen).toHaveLength(1);
  const { request, body, response } = seen[0]!;
  const url = new URL(request.url);
  return {
    wire,
    request: {
      method: request.method,
      path: `${url.origin}${url.pathname}`,
      headers: [...request.headers.keys()].filter((name) => !NOISE.has(name)).sort(),
      body: paths(shapeOf(JSON.parse(body)))
    },
    response: { source: "fake", stream: streamShape(response) }
  };
}

describe("the wires the fakes stand in for", () => {
  it("Anthropic Messages, on a person's own key", async () => {
    check(await ownKeyTurn("anthropic-messages", anthropicProvider(), "claude-sonnet-5-5", "sk-ant-test-good-contract"));
  });

  it("OpenAI Responses, on a person's own key", async () => {
    check(await ownKeyTurn("openai-responses", openaiProvider(), "gpt-6.1-sol", "sk-test-good-contract"));
  });

  it("the AI binding, for the demo lane's gateway model, and nothing else of it", async () => {
    const calls: Array<{ model: string; input: unknown; options: Record<string, unknown> }> = [];
    let anthropicStream = "";
    // Strict: `agents` may call `run` and read `aiGatewayLogId`; touching anything else of the binding fails here, by name.
    const binding = new Proxy({}, {
      get(_target, name) {
        if (name === "run") {
          return async (model: string, input: unknown, options: Record<string, unknown> = {}) => {
            calls.push({ model, input, options });
            // The gateway relays Anthropic's own stream; the fake Anthropic answers it.
            const relayed = await fakeModels(new Request("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "x-api-key": "sk-ant-test-good-gateway", "content-type": "application/json", ...(options.extraHeaders as Record<string, string> | undefined) },
              body: JSON.stringify({ model: "claude-sonnet-5-5", ...(input as object) })
            }));
            anthropicStream = await relayed!.clone().text();
            return relayed;
          };
        }
        // The gateway's log id for the call just made: none here.
        if (name === "aiGatewayLogId") return undefined;
        if (typeof name === "symbol" || name === "then" || name === "toJSON") return undefined;
        throw new Error(`agents touched AI binding member ${JSON.stringify(name)}, which the fake doesn't have`);
      }
    });
    const ai = createAI({ binding: binding as never, id: "demo", metadata: { u: "agent", d: "contract.example" } });
    const specifier = "anthropic/claude-sonnet-5.5";
    const model = withVendorCompat(ai(specifier) as Model<Api>, specifier);
    const message = await ai.provider.streamSimple(model, normalizeContext(conversation(model)), { reasoning: "medium" }).result();
    expect(message.stopReason, message.errorMessage ?? "").toBe("stop");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    const { signal: _signal, ...options } = call!.options;
    check({
      wire: "ai-binding-run",
      request: {
        call: [`model: ${call!.model}`, ...paths(shapeOf(options)).map((line) => `options.${line}`)],
        body: paths(shapeOf(call!.input))
      },
      response: { source: "fake", stream: streamShape(anthropicStream) }
    });
  });
});
