/**
 * Fake Anthropic, OpenAI and Google Gemini, for the outbound service beside
 * the fake Google OAuth and GitHub (`fake-providers.ts`). Web APIs only, like
 * it.
 *
 * Which keys work is in the key itself, so the fakes need no shared state:
 * Anthropic `sk-ant-test-…`, OpenAI `sk-test-…` and Gemini `AIza-test-…` keys
 * work, unless one of their `-`-separated segments is `bad` (refused
 * everywhere, so they can't be saved) or `revoked` (they pass the key check,
 * then every model call is refused, as a key revoked after it was saved would
 * be). Whole segments, so a random suffix can't spell either by chance.
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

// ---------------------------------------------------------------- Directives

type DirectiveCall = { readonly name: string; readonly argumentsJson: string };
type DirectiveReply = { readonly calls: DirectiveCall[] } | { readonly text: string };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Provider-agnostic prompt-directive interpreter shared by `openai` and
 * `fakeGemini`: obeys `@@obey <tool> <base64url-args>` lines in `freshText`
 * (once per canonical call, for offered tools only), answers `<conversation>`
 * compaction prompts and toolless `<untrusted-page>` reader prompts, and
 * otherwise echoes `lastUserPrompt`.
 */
function planDirectiveReply(options: {
  readonly speaker: string;
  readonly model: string;
  readonly offeredTools: ReadonlySet<string>;
  readonly freshText: string;
  readonly alreadyMade: ReadonlySet<string>;
  readonly lastUserPrompt: string;
}): DirectiveReply {
  const made = new Set(options.alreadyMade);
  const calls: DirectiveCall[] = [];
  for (const [, name, encoded] of options.freshText.matchAll(/@@obey (\w+) ([A-Za-z0-9_-]+)/g)) {
    if (!options.offeredTools.has(name!)) continue;
    const parsed: unknown = JSON.parse(atob(encoded!.replace(/-/g, "+").replace(/_/g, "/")));
    const canonical = `${name} ${canonicalJson(parsed)}`;
    if (made.has(canonical)) continue;
    made.add(canonical);
    calls.push({ name: name!, argumentsJson: JSON.stringify(parsed) });
  }
  if (calls.length) return { calls };
  const prompt = options.lastUserPrompt;
  const conversation = /<conversation>\n([\s\S]*)\n<\/conversation>/.exec(prompt)?.[1];
  if (conversation !== undefined) {
    const lines = conversation.split("\n").filter(Boolean);
    return { text: `Faux summary of ${lines.length} lines.` };
  }
  const page = /<untrusted-page>\n([\s\S]*?)\n<\/untrusted-page>/.exec(prompt)?.[1];
  if (options.offeredTools.size === 0 && page !== undefined) {
    return { text: `reader: ${page.slice(0, 1_500)}` };
  }
  const echoed = prompt.length > 2000 ? `${prompt.slice(0, 200)}… (${prompt.length} characters)` : prompt;
  return { text: `${options.speaker} (${options.model}) answers: ${echoed}` };
}

function extractContextTokens(lastUserPrompt: string): number {
  return Number(/\[context (\d+)\]/.exec(lastUserPrompt)?.[1] ?? 12);
}

// ---------------------------------------------------------------- OpenAI

/*
 * The fake OpenAI is a model of its own, as the demo lane's faux provider is
 * (test/worker.ts), speaking the Responses API: it obeys any `@@obey <tool>
 * <arguments>` line it has just read by calling that tool, if it was offered;
 * answers read_url's reader (a request with no tools that carries a fenced
 * page) with `reader: ` and the page's text, and our summarizer (a
 * `<conversation>` fence) with a short summary; and otherwise echoes the
 * latest user message. Every answer starts with a reasoning item, as a
 * reasoning model's does, and `[context N]` makes it report N input tokens.
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

/** What the fake OpenAI says: calls to make, or text. */
function openaiAnswer(body: { model?: string; tools?: unknown }, input: readonly ResponsesItem[]): DirectiveReply {
  const offered = offeredTools(body, input);
  let last = input.length - 1;
  while (last >= 0 && !produced(input[last]!)) last--;
  const freshText = input.slice(last + 1).map(itemText).join("\n");
  const alreadyMade = new Set(
    input
      .filter((item) => item.type === "function_call")
      .map((item) => {
        try {
          return `${String(item.name)} ${canonicalJson(JSON.parse(String(item.arguments ?? "{}")))}`;
        } catch {
          return `${String(item.name)} ${String(item.arguments)}`;
        }
      })
  );
  return planDirectiveReply({
    speaker: "fake OpenAI",
    model: body.model ?? "?",
    offeredTools: new Set(offered.map((tool) => String(tool.name))),
    freshText,
    alreadyMade,
    lastUserPrompt: lastUserText(input)
  });
}

/** A Responses stream: a reasoning item, then the calls or the message. */
function openaiStream(answer: DirectiveReply, inputTokens: number): Response {
  const token = `fake_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const reasoning = { type: "reasoning", id: `rs_${token}`, summary: [], encrypted_content: `enc_${token}` };
  const items: ResponsesItem[] = [reasoning];
  const events: [string, unknown][] = [["response.created", { type: "response.created", response: { id: `resp_${token}`, status: "in_progress", output: [] } }]];
  events.push(["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...reasoning, encrypted_content: undefined } }]);
  events.push(["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: reasoning }]);
  if ("calls" in answer) {
    answer.calls.forEach((call, i) => {
      const item = { type: "function_call", id: `fc_${token}_${i}`, call_id: `call_${token}_${i}`, name: call.name, arguments: call.argumentsJson, status: "completed" };
      const index = i + 1;
      items.push(item);
      events.push(["response.output_item.added", { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "", status: "in_progress" } }]);
      events.push(["response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta: call.argumentsJson }]);
      events.push(["response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: index, item_id: item.id, arguments: call.argumentsJson }]);
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
    const context = extractContextTokens(lastUserText(input));
    return openaiStream(openaiAnswer(body, input), context);
  }
  return Response.json({ error: { message: "Not found" } }, { status: 404 });
}

// ---------------------------------------------------------------- Google Gemini

/*
 * The fake Gemini speaks Google's Generative Language v1beta SSE API
 * (`:streamGenerateContent?alt=sse`), sharing `planDirectiveReply` with OpenAI.
 * Every streamed answer starts with a `thought: true` part carrying a base64
 * `thoughtSignature`, followed by `functionCall` or text parts and
 * `usageMetadata`. It refuses (400) requests that pass `?key=` in the URL,
 * omit or alter an earlier turn's `thoughtSignature`, send a `functionResponse`
 * without a matching `functionCall`, or send malformed `inlineData` parts.
 */

type GeminiPart = {
  readonly text?: unknown;
  readonly thought?: unknown;
  readonly thoughtSignature?: unknown;
  readonly functionCall?: { readonly id?: unknown; readonly name?: unknown; readonly args?: unknown };
  readonly functionResponse?: { readonly id?: unknown; readonly name?: unknown; readonly response?: unknown; readonly parts?: unknown };
  readonly inlineData?: { readonly mimeType?: unknown; readonly data?: unknown };
};

type GeminiContent = {
  readonly role?: unknown;
  readonly parts?: unknown;
};

type GeminiBody = {
  readonly contents?: unknown;
  readonly tools?: unknown;
  readonly systemInstruction?: unknown;
  readonly generationConfig?: unknown;
};

const INVALID_KEY_GOOGLE = () =>
  Response.json(
    {
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }]
      }
    },
    { status: 400 }
  );

const geminiError = (code: number, status: string, message: string) =>
  Response.json({ error: { code, message, status } }, { status: code });

function isValidBase64(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function inlineDataRefusal(inlineData: unknown): string | null {
  if (!inlineData || typeof inlineData !== "object") return "Invalid inlineData part: expected object.";
  const { mimeType, data } = inlineData as { mimeType?: unknown; data?: unknown };
  if (typeof mimeType !== "string" || mimeType.trim() === "") return "Invalid inlineData part: mimeType is required.";
  if (!isValidBase64(data)) return "Invalid inlineData part: data must be non-empty base64.";
  return null;
}

/** What Google Gemini would refuse about `contents`, or null. */
function geminiRefusal(contents: readonly GeminiContent[]): string | null {
  const callsById = new Map<string, string>();
  const calledNames = new Set<string>();
  for (const item of contents) {
    if (!item || typeof item !== "object" || !Array.isArray(item.parts)) {
      return "Each entry in contents must have a parts array.";
    }
    const parts = item.parts as GeminiPart[];
    let turnThoughtVerified = false;
    for (const part of parts) {
      if (!part || typeof part !== "object") return "Invalid content part.";
      if (part.inlineData !== undefined) {
        const problem = inlineDataRefusal(part.inlineData);
        if (problem) return problem;
      }
      if (Array.isArray(part.functionResponse?.parts)) {
        for (const nested of part.functionResponse.parts as GeminiPart[]) {
          if (nested?.inlineData !== undefined) {
            const problem = inlineDataRefusal(nested.inlineData);
            if (problem) return problem;
          }
        }
      }
      if (item.role === "model") {
        if (part.thought === true) {
          if (!isValidBase64(part.thoughtSignature)) {
            return "Model thinking part is missing a valid base64 thoughtSignature.";
          }
          let decoded = "";
          try {
            decoded = atob(part.thoughtSignature);
          } catch {
            return "Model thinking part has an unreadable thoughtSignature.";
          }
          const text = typeof part.text === "string" ? part.text : "";
          if (!decoded.startsWith("gemini-sig:") || (text.startsWith("thinking ") && decoded !== `gemini-sig:${text.slice("thinking ".length)}`)) {
            return "Model thinking part thoughtSignature could not be verified.";
          }
          turnThoughtVerified = true;
        }
        if (part.functionCall) {
          const callName = typeof part.functionCall.name === "string" ? part.functionCall.name : "";
          if (!callName) return "Model functionCall part is missing its name.";
          if (!turnThoughtVerified) {
            return `Function call '${callName}' in model turn is missing its preceding thought part and thoughtSignature.`;
          }
          const callId = typeof part.functionCall.id === "string" ? part.functionCall.id : "";
          if (callId) callsById.set(callId, callName);
          calledNames.add(callName);
        }
      } else if (item.role === "user" && part.functionResponse) {
        const respName = typeof part.functionResponse.name === "string" ? part.functionResponse.name : "";
        const respId = typeof part.functionResponse.id === "string" ? part.functionResponse.id : "";
        const matched = respId ? callsById.get(respId) === respName : Boolean(respName) && calledNames.has(respName);
        if (!matched) {
          return `Function response for '${respName}' (${respId || "no id"}) has no matching prior functionCall.`;
        }
      }
    }
  }
  return null;
}

function geminiOfferedTools(body: GeminiBody): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(body.tools)) return names;
  for (const group of body.tools) {
    if (!group || typeof group !== "object") continue;
    const decls = (group as { functionDeclarations?: unknown }).functionDeclarations;
    if (!Array.isArray(decls)) continue;
    for (const decl of decls) {
      if (decl && typeof decl === "object" && typeof (decl as { name?: unknown }).name === "string") {
        names.add((decl as { name: string }).name);
      }
    }
  }
  return names;
}

function geminiPartText(part: GeminiPart): string {
  if (typeof part.text === "string" && part.thought !== true) return part.text;
  const resp = part.functionResponse?.response;
  if (resp && typeof resp === "object") {
    const out = (resp as { output?: unknown; error?: unknown }).output ?? (resp as { error?: unknown }).error;
    if (typeof out === "string") return out;
  }
  return "";
}

/** The latest true user message's text (skipping user-role `functionResponse` turns). */
function geminiLastUserText(contents: readonly GeminiContent[]): string {
  for (let i = contents.length - 1; i >= 0; i--) {
    const item = contents[i]!;
    if (item.role !== "user" || !Array.isArray(item.parts)) continue;
    const parts = item.parts as GeminiPart[];
    if (parts.length > 0 && parts.every((part) => Boolean(part?.functionResponse))) continue;
    return parts.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function geminiStream(model: string, answer: DirectiveReply, inputTokens: number): Response {
  const token = `fake_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const signature = btoa(`gemini-sig:${token}`);
  const chunks: unknown[] = [
    {
      responseId: `resp_${token}`,
      modelVersion: model,
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [{ thought: true, text: `thinking ${token}`, thoughtSignature: signature }]
          }
        }
      ]
    }
  ];
  const usageMetadata = {
    promptTokenCount: inputTokens,
    candidatesTokenCount: 8,
    thoughtsTokenCount: 4,
    totalTokenCount: inputTokens + 12
  };
  if ("calls" in answer) {
    chunks.push({
      responseId: `resp_${token}`,
      modelVersion: model,
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: answer.calls.map((call, index) => ({
              functionCall: {
                id: `call_${token}_${index}`,
                name: call.name,
                args: JSON.parse(call.argumentsJson) as Record<string, unknown>
              },
              thoughtSignature: signature
            }))
          },
          finishReason: "STOP"
        }
      ],
      usageMetadata
    });
  } else {
    chunks.push({
      responseId: `resp_${token}`,
      modelVersion: model,
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [{ text: answer.text, thoughtSignature: signature }]
          },
          finishReason: "STOP"
        }
      ],
      usageMetadata
    });
  }
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function fakeGemini(url: URL, method: string, headers: Headers, rawBody: string): Response {
  if (url.searchParams.has("key")) {
    return geminiError(400, "INVALID_ARGUMENT", "Pass the API key in the x-goog-api-key header, not the URL query string.");
  }
  const key = headers.get("x-goog-api-key") ?? "";
  const state = keyState(key, "AIza-test-");
  if (url.pathname === "/v1beta/models" && method === "GET") {
    if (key.split("-").includes("broke")) {
      return geminiError(400, "FAILED_PRECONDITION", `Billing not enabled for key ${key}`);
    }
    return state === "refused" ? INVALID_KEY_GOOGLE() : Response.json({ models: [{ name: "models/gemini-4-hydrogen" }] });
  }
  const streamMatch = /^\/v1beta\/models\/([^/:]+):streamGenerateContent$/.exec(url.pathname);
  if (streamMatch && method === "POST") {
    if (url.searchParams.get("alt") !== "sse") {
      return geminiError(400, "INVALID_ARGUMENT", "streamGenerateContent requires alt=sse.");
    }
    if (state !== "ok") return INVALID_KEY_GOOGLE();
    let body: GeminiBody;
    try {
      body = JSON.parse(rawBody || "{}") as GeminiBody;
    } catch {
      return geminiError(400, "INVALID_ARGUMENT", "Malformed JSON request body.");
    }
    const contents = Array.isArray(body.contents) ? (body.contents as GeminiContent[]) : [];
    const refusal = geminiRefusal(contents);
    if (refusal) return geminiError(400, "INVALID_ARGUMENT", refusal);

    let lastModel = contents.length - 1;
    while (lastModel >= 0 && contents[lastModel]?.role !== "model") lastModel--;
    const freshText = contents
      .slice(lastModel + 1)
      .flatMap((item) => (Array.isArray(item.parts) ? (item.parts as GeminiPart[]).map(geminiPartText) : []))
      .join("\n");
    if (freshText.includes("[bad-request]")) {
      return geminiError(400, "INVALID_ARGUMENT", "Request contains an invalid argument.");
    }
    const alreadyMade = new Set(
      contents.flatMap((item) =>
        item.role === "model" && Array.isArray(item.parts)
          ? (item.parts as GeminiPart[]).flatMap((part) =>
              part.functionCall && typeof part.functionCall.name === "string"
                ? [`${part.functionCall.name} ${canonicalJson(part.functionCall.args ?? {})}`]
                : []
            )
          : []
      )
    );
    const prompt = geminiLastUserText(contents);
    const model = decodeURIComponent(streamMatch[1]!);
    const answer = planDirectiveReply({
      speaker: "fake Gemini",
      model,
      offeredTools: geminiOfferedTools(body),
      freshText,
      alreadyMade,
      lastUserPrompt: prompt
    });
    return geminiStream(model, answer, extractContextTokens(prompt));
  }
  return geminiError(404, "NOT_FOUND", "Not found");
}

/** The fake vendors, or null for a request that isn't theirs. */
export async function fakeModels(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const vendor =
    url.origin === "https://api.anthropic.com"
      ? "anthropic"
      : url.origin === "https://api.openai.com"
        ? "openai"
        : url.origin === "https://generativelanguage.googleapis.com"
          ? "google"
          : null;
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
  if (vendor === "google") {
    return fakeGemini(url, request.method, request.headers, await request.text());
  }
  return openai(request, url);
}
