/**
 * Fake Anthropic and OpenAI, for the outbound service beside the fake Google
 * and GitHub (`fake-providers.ts`). Web APIs only, like it.
 *
 * Which keys work is in the key itself, so the fakes need no shared state:
 * Anthropic `sk-ant-test-…` and OpenAI `sk-test-…` keys work, unless one of
 * their `-`-separated segments is `bad` (refused everywhere, so they can't be
 * saved) or `revoked` (they pass the key check, then every model call is
 * refused with a 401, as a key revoked after it was saved would be). Whole
 * segments, so a random suffix can't spell either by chance.
 *
 * Model calls stream a real answer in the vendor's own wire format, saying
 * who answered and echoing the last user message. A request carrying AI
 * Gateway's `cf-aig-authorization` header is refused: own-key traffic must go
 * straight to the vendor.
 */

type KeyState = "ok" | "revoked" | "refused";

/** A key's state from its `-`-separated segments: `bad` is refused, `revoked` passes the key check only. */
export function keyState(key: string | null, prefix: string): KeyState {
  if (!key || !key.startsWith(prefix)) return "refused";
  const segments = key.split("-");
  if (segments.includes("bad")) return "refused";
  return segments.includes("revoked") ? "revoked" : "ok";
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

/** The last user message's text, from an Anthropic `messages` or OpenAI `input` array. */
function lastUserText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  const user = [...items].reverse().find((item) => item && typeof item === "object" && (item as { role?: unknown }).role === "user") as
    | { content?: unknown }
    | undefined;
  const content = user?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("");
}

function sse(events: ReadonlyArray<readonly [string, unknown]>): Response {
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/** Anthropic's answer to a request with an organization-wide (`unscoped`) key and no workspace header. */
const NO_WORKSPACE = () =>
  Response.json(
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace."
      }
    },
    { status: 400 }
  );

/** An `unscoped` key's request without its workspace: what Anthropic refuses. */
function missingWorkspace(request: Request): boolean {
  const key = request.headers.get("x-api-key") ?? "";
  const expected = /(?:^|-)workspace_([A-Za-z0-9_]+)(?:-|$)/.exec(key)?.[1];
  const actual = request.headers.get("anthropic-workspace-id");
  return (expected !== undefined && actual !== expected) || (key.split("-").includes("unscoped") && !actual);
}

const UNAUTHORIZED_ANTHROPIC = () =>
  Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });

/** An Anthropic Messages stream. */
function anthropicStream(model: string, text: string): Response {
  return sse([
    ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }],
    ["message_stop", { type: "message_stop" }]
  ]);
}

async function anthropic(request: Request): Promise<Response> {
  if (missingWorkspace(request)) return NO_WORKSPACE();
  if (keyState(request.headers.get("x-api-key"), "sk-ant-test-") !== "ok") return UNAUTHORIZED_ANTHROPIC();
  const body = (await request.json().catch(() => ({}))) as { model?: string; messages?: unknown };
  return anthropicStream(body.model ?? "?", `fake Anthropic (${body.model}) answers: ${lastUserText(body.messages)}`);
}

// ---------------------------------------------------------------- OpenAI

/*
 * The fake OpenAI is a model of its own, as the demo lane's faux provider is
 * (test/worker.ts), speaking the Responses API: it obeys any `@@obey <tool>
 * <arguments>` line it has just read by calling that tool, if it was offered;
 * answers our summarizer (a `<conversation>` fence) with a short summary;
 * and otherwise echoes the latest user message. Every answer starts with a
 * reasoning item, as a reasoning model's does, and `[context N]` makes it
 * report N input tokens.
 *
 * It holds the request to OpenAI's rules and refuses one that breaks them,
 * as OpenAI does (400): a tool's output needs its call earlier in the input;
 * a call it made beside a reasoning item comes back after that item, whose
 * encrypted content it can verify; a strict tool lists every property as
 * required. It keeps no state: the ids carry what it checks.
 */

type ResponsesItem = { readonly [key: string]: unknown };

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
}

function itemText(item: ResponsesItem): string {
  if (item.type === "function_call_output") return partsText(item.output);
  return partsText(item.content);
}

/** Whether the model produced this item: an answer, a call, or its reasoning. */
function produced(item: ResponsesItem): boolean {
  return item.type === "reasoning" || item.type === "function_call" || (item.type === "message" && item.role === "assistant");
}

/** What OpenAI would refuse about this request, or null. */
function openaiRefusal(input: readonly ResponsesItem[], tools: readonly ResponsesItem[]): string | null {
  const calls = new Set<string>();
  const reasoning = new Set<string>();
  for (const item of input) {
    if (item.type === "reasoning") {
      const id = String(item.id ?? "");
      if (id.startsWith("rs_fake_") && item.encrypted_content !== `enc_${id.slice(3)}`) return `The encrypted content for item ${id} could not be verified.`;
      reasoning.add(id);
    } else if (item.type === "function_call") {
      const id = String(item.id ?? "");
      const pair = /^fc_(fake_[a-z0-9]+)_\d+$/.exec(id)?.[1];
      if (pair && !reasoning.has(`rs_${pair}`)) return `Item '${id}' of type 'function_call' was provided without its required 'reasoning' item: 'rs_${pair}'.`;
      calls.add(String(item.call_id));
    } else if (item.type === "function_call_output" && !calls.has(String(item.call_id))) {
      return `No tool call found for function call output with call_id ${String(item.call_id)}.`;
    }
  }
  for (const tool of tools) {
    if (tool.strict !== true) continue;
    const schema = (tool.parameters ?? {}) as { properties?: Record<string, unknown>; required?: unknown[]; additionalProperties?: unknown };
    const required = new Set(schema.required ?? []);
    const missing = Object.keys(schema.properties ?? {}).filter((name) => !required.has(name));
    if (missing.length || schema.additionalProperties !== false) return `Invalid schema for function '${String(tool.name)}': In context=(), 'required' is required to be supplied and to be an array including every key in properties. Missing '${missing[0] ?? "additionalProperties"}'.`;
  }
  return null;
}

/** The tools the request offers: its `tools`, and any an `additional_tools` item adds. */
function offeredTools(body: { tools?: unknown }, input: readonly ResponsesItem[]): ResponsesItem[] {
  const listed = Array.isArray(body.tools) ? (body.tools as ResponsesItem[]) : [];
  const added = input.flatMap((item) => (item.type === "additional_tools" && Array.isArray(item.tools) ? (item.tools as ResponsesItem[]) : []));
  return [...listed, ...added].filter((tool) => tool.type === "function");
}

/** Calls for the `@@obey` lines in everything since the model last produced something, each made once per input, to offered tools only. */
function openaiObeyed(input: readonly ResponsesItem[], offered: ReadonlySet<string>): { name: string; arguments: string }[] {
  let last = input.length - 1;
  while (last >= 0 && !produced(input[last]!)) last--;
  const fresh = input.slice(last + 1).map(itemText).join("\n");
  const made = new Set(input.filter((item) => item.type === "function_call").map((item) => `${String(item.name)} ${String(item.arguments)}`));
  const calls = [];
  for (const [, name, encoded] of fresh.matchAll(/@@obey (\w+) ([A-Za-z0-9_-]+)/g)) {
    if (!offered.has(name!)) continue;
    const args = JSON.stringify(JSON.parse(atob(encoded!.replace(/-/g, "+").replace(/_/g, "/"))));
    if (made.has(`${name} ${args}`)) continue;
    made.add(`${name} ${args}`);
    calls.push({ name: name!, arguments: args });
  }
  return calls;
}

/** What the fake OpenAI says: calls to make, or text. */
function openaiAnswer(body: { model?: string; tools?: unknown }, input: readonly ResponsesItem[]): { calls: { name: string; arguments: string }[] } | { text: string } {
  const offered = offeredTools(body, input);
  const calls = openaiObeyed(input, new Set(offered.map((tool) => String(tool.name))));
  if (calls.length) return { calls };
  const prompt = lastUserText(input);
  const conversation = /<conversation>\n([\s\S]*)\n<\/conversation>/.exec(prompt)?.[1];
  if (conversation !== undefined) {
    const lines = conversation.split("\n").filter(Boolean);
    return { text: `Faux summary of ${lines.length} lines.` };
  }
  const echoed = prompt.length > 2000 ? `${prompt.slice(0, 200)}… (${prompt.length} characters)` : prompt;
  return { text: `fake OpenAI (${body.model}) answers: ${echoed}` };
}

/** A Responses stream: a reasoning item, then the calls or the message. */
function openaiStream(answer: ReturnType<typeof openaiAnswer>, inputTokens: number): Response {
  const token = `fake_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const reasoning = { type: "reasoning", id: `rs_${token}`, summary: [], encrypted_content: `enc_${token}` };
  const items: ResponsesItem[] = [reasoning];
  const events: [string, unknown][] = [["response.created", { type: "response.created", response: { id: `resp_${token}`, status: "in_progress", output: [] } }]];
  events.push(["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: undefined } }]);
  events.push(["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: reasoning }]);
  if ("calls" in answer) {
    answer.calls.forEach((call, i) => {
      const item = { type: "function_call", id: `fc_${token}_${i}`, call_id: `call_${token}_${i}`, name: call.name, arguments: call.arguments, status: "completed" };
      const index = i + 1;
      items.push(item);
      events.push(["response.output_item.added", { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "", status: "in_progress" } }]);
      events.push(["response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta: call.arguments }]);
      events.push(["response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: index, item_id: item.id, arguments: call.arguments }]);
      events.push(["response.output_item.done", { type: "response.output_item.done", output_index: index, item }]);
    });
  } else {
    const item = { type: "message", id: `msg_${token}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: answer.text, annotations: [] }] };
    items.push(item);
    events.push(["response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { ...item, status: "in_progress", content: [] } }]);
    events.push(["response.output_text.delta", { type: "response.output_text.delta", output_index: 1, content_index: 0, item_id: item.id, delta: answer.text }]);
    events.push(["response.output_item.done", { type: "response.output_item.done", output_index: 1, item }]);
  }
  const usage = { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: inputTokens + 8 };
  events.push(["response.completed", { type: "response.completed", response: { id: `resp_${token}`, status: "completed", output: items, usage } }]);
  return sse(events);
}

async function openai(request: Request, url: URL): Promise<Response> {
  const state = keyState(bearer(request), "sk-test-");
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return state === "refused"
      ? Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 })
      : Response.json({ object: "list", data: [{ id: "gpt-6.1-sol", object: "model" }] });
  }
  if (url.pathname === "/v1/responses" && request.method === "POST") {
    if (state !== "ok") {
      return Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as { model?: string; input?: unknown; tools?: unknown };
    const input = Array.isArray(body.input) ? (body.input as ResponsesItem[]) : [];
    const refusal = openaiRefusal(input, offeredTools(body, input));
    if (refusal) return Response.json({ error: { message: refusal, type: "invalid_request_error", param: "input", code: null } }, { status: 400 });
    const context = Number(/\[context (\d+)\]/.exec(lastUserText(input))?.[1] ?? 12);
    return openaiStream(openaiAnswer(body, input), context);
  }
  return Response.json({ error: { message: "Not found" } }, { status: 404 });
}

/** The fake vendors, or null for a request that isn't theirs. */
export async function fakeModels(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const vendor = url.origin === "https://api.anthropic.com" ? "anthropic" : url.origin === "https://api.openai.com" ? "openai" : null;
  if (!vendor) return null;
  if (request.headers.has("cf-aig-authorization")) {
    return Response.json({ error: "own-key traffic must not carry AI Gateway credentials" }, { status: 400 });
  }
  if (vendor === "anthropic") {
    if (url.pathname === "/v1/models" && request.method === "GET") {
      const key = request.headers.get("x-api-key") ?? "";
      if (missingWorkspace(request)) return NO_WORKSPACE();
      // `broke`: an account Anthropic won't serve, answering 400 with its reason (and the key, to test redaction).
      if (key.split("-").includes("broke")) {
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: `Your credit balance is too low to access the Anthropic API (key ${key}).` } },
          { status: 400 }
        );
      }
      return keyState(key, "sk-ant-test-") === "refused"
        ? UNAUTHORIZED_ANTHROPIC()
        : Response.json({ data: [{ id: "claude-sonnet-5-5", type: "model" }], has_more: false });
    }
    if (url.pathname === "/v1/messages" && request.method === "POST") return anthropic(request);
    return Response.json({ type: "error", error: { type: "not_found_error" } }, { status: 404 });
  }
  return openai(request, url);
}
