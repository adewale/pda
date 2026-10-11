/**
 * Fake Anthropic, OpenAI and OpenRouter, for the outbound service beside the
 * fake Google and GitHub (`fake-providers.ts`). Web APIs only, like it.
 *
 * Which keys work is in the key itself, so the fakes need no shared state:
 *
 * - Anthropic `sk-ant-test-…` and OpenAI `sk-test-…` keys work, unless they
 *   contain `bad` (refused everywhere, so they can't be saved) or `revoked`
 *   (they pass the key check, then every model call is refused with a 401,
 *   as a key revoked after it was saved would be).
 * - OpenRouter keys are the ones its fake PKCE exchange issues.
 *
 * Model calls stream a real answer in the vendor's own wire format, saying
 * who answered and echoing the last user message. A request carrying AI
 * Gateway's `cf-aig-authorization` header is refused: own-key traffic must go
 * straight to the vendor.
 *
 * OpenRouter's consent page is played by the test: `openRouterCode()` is the
 * code it would send back, bound to the challenge in the authorize URL.
 */

const OPENROUTER_PREFIX = "orcode.";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (char) => char.charCodeAt(0));
}

async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** What OpenRouter's consent page sends back: a code bound to the authorize URL's challenge. */
export type OpenRouterGrant = {
  readonly challenge: string;
  readonly challengeMethod: string;
  readonly callbackUrl: string;
  /** The person refused, or OpenRouter won't issue a key for this code. */
  readonly refuse?: boolean;
};

export function openRouterCode(grant: OpenRouterGrant): string {
  return OPENROUTER_PREFIX + base64url(new TextEncoder().encode(JSON.stringify(grant)));
}

/** The key the fake exchange issues for a grant; tests compute it to look for leaks. */
export function openRouterKeyFor(grant: Pick<OpenRouterGrant, "challenge">): string {
  // Digits only, so the key can never spell `bad` or `revoked` by chance.
  return `sk-or-v1-fake-${[...grant.challenge.slice(0, 32)].map((char) => char.charCodeAt(0) % 10).join("")}`;
}

function readGrant(code: unknown): OpenRouterGrant | null {
  if (typeof code !== "string" || !code.startsWith(OPENROUTER_PREFIX)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(code.slice(OPENROUTER_PREFIX.length)))) as OpenRouterGrant;
  } catch {
    return null;
  }
}

type KeyState = "ok" | "revoked" | "refused";

function keyState(key: string | null, prefix: string): KeyState {
  if (!key || !key.startsWith(prefix) || key.includes("bad")) return "refused";
  return key.includes("revoked") ? "revoked" : "ok";
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

const UNAUTHORIZED_ANTHROPIC = () =>
  Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });

/** An Anthropic Messages stream: the format Anthropic and OpenRouter's Anthropic endpoint both speak. */
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

async function anthropic(request: Request, url: URL, vendor: "anthropic" | "openrouter"): Promise<Response> {
  const key = vendor === "anthropic" ? request.headers.get("x-api-key") : (request.headers.get("x-api-key") ?? bearer(request));
  const state = keyState(key, vendor === "anthropic" ? "sk-ant-test-" : "sk-or-v1-fake-");
  if (state !== "ok") return UNAUTHORIZED_ANTHROPIC();
  const body = (await request.json().catch(() => ({}))) as { model?: string; messages?: unknown };
  const name = vendor === "anthropic" ? "fake Anthropic" : "fake OpenRouter";
  return anthropicStream(body.model ?? "?", `${name} (${body.model}) answers: ${lastUserText(body.messages)}`);
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

async function openrouter(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/v1/auth/keys" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { code?: unknown; code_verifier?: unknown; code_challenge_method?: unknown };
    const grant = readGrant(body.code);
    if (
      !grant ||
      grant.refuse ||
      grant.challengeMethod !== "S256" ||
      body.code_challenge_method !== "S256" ||
      typeof body.code_verifier !== "string" ||
      (await s256(body.code_verifier)) !== grant.challenge
    ) {
      return Response.json({ error: { message: "Invalid code" } }, { status: 403 });
    }
    return Response.json({ key: openRouterKeyFor(grant), user_id: "user_fake" });
  }
  if (url.pathname === "/api/v1/key" && request.method === "GET") {
    return keyState(bearer(request), "sk-or-v1-fake-") === "refused"
      ? Response.json({ error: { message: "No auth credentials found", code: 401 } }, { status: 401 })
      : Response.json({ data: { label: "fake", limit: 5, usage: 0 } });
  }
  if (url.pathname === "/api/v1/messages" && request.method === "POST") return anthropic(request, url, "openrouter");
  return Response.json({ error: { message: "Not found" } }, { status: 404 });
}

/** The fake vendors, or null for a request that isn't theirs. */
export async function fakeModels(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const vendor =
    url.origin === "https://api.anthropic.com" ? "anthropic" : url.origin === "https://api.openai.com" ? "openai" : url.origin === "https://openrouter.ai" ? "openrouter" : null;
  if (!vendor) return null;
  if (request.headers.has("cf-aig-authorization")) {
    return Response.json({ error: "own-key traffic must not carry AI Gateway credentials" }, { status: 400 });
  }
  if (vendor === "anthropic") {
    if (url.pathname === "/v1/models" && request.method === "GET") {
      return keyState(request.headers.get("x-api-key"), "sk-ant-test-") === "refused"
        ? UNAUTHORIZED_ANTHROPIC()
        : Response.json({ data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false });
    }
    if (url.pathname === "/v1/messages" && request.method === "POST") return anthropic(request, url, "anthropic");
    return Response.json({ type: "error", error: { type: "not_found_error" } }, { status: 404 });
  }
  return vendor === "openai" ? openai(request, url) : openrouter(request, url);
}
