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
  return key.split("-").includes("unscoped") && !request.headers.get("anthropic-workspace-id");
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
    const body = (await request.json().catch(() => ({}))) as { model?: string; input?: unknown };
    const text = `fake OpenAI (${body.model}) answers: ${lastUserText(body.input)}`;
    const item = { type: "message", id: "msg_fake", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    return sse([
      ["response.created", { type: "response.created", response: { id: "resp_fake", status: "in_progress", output: [] } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
      ["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_fake", delta: text }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
      ["response.completed", { type: "response.completed", response: { id: "resp_fake", status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } }]
    ]);
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
