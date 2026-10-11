import { readSessionSecret } from "./config";
import { base64url, cookie, readCookie, sign, unsign } from "./session";

/**
 * Connecting OpenRouter with its OAuth PKCE flow instead of pasting a key:
 * OpenRouter shows the person a consent page and sends back a code that only
 * our verifier can swap for a key they control (and can cap and revoke in
 * OpenRouter's settings). https://openrouter.ai/docs/guides/overview/auth/oauth
 *
 * `state` and the verifier wait in a signed, 10-minute cookie, bound to the
 * agent that started the flow, so a code started by one person can't land in
 * another's agent, and a code minted for someone else's challenge fails the
 * exchange.
 */

const FLOW_COOKIE = "__Host-openrouter";
const FLOW_TTL_SECONDS = 10 * 60;
export const OPENROUTER_AUTHORIZE = "https://openrouter.ai/auth";
export const OPENROUTER_KEYS = "https://openrouter.ai/api/v1/auth/keys";

type Flow = { readonly agent: string; readonly state: string; readonly verifier: string; readonly exp: number };

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers });
}

/** `GET /auth/openrouter/start`: off to OpenRouter's consent page, with `state` and an S256 challenge. */
export async function startOpenRouter(request: Request, env: Env, agent: string, keyLabel: string): Promise<Response> {
  const flow: Flow = { agent, state: randomToken(), verifier: randomToken(), exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS };
  const params = new URLSearchParams({
    callback_url: `${new URL(request.url).origin}/auth/openrouter/callback`,
    code_challenge: await challengeFor(flow.verifier),
    code_challenge_method: "S256",
    state: flow.state,
    key_label: keyLabel
  });
  return redirect(`${OPENROUTER_AUTHORIZE}?${params}`, [
    cookie(FLOW_COOKIE, await sign(flow, readSessionSecret(env)), { maxAge: FLOW_TTL_SECONDS })
  ]);
}

export type OpenRouterCallback =
  | { readonly ok: true; readonly code: string; readonly verifier: string }
  | { readonly ok: false; readonly error: "denied" | "state" | "code" };

/** `GET /auth/openrouter/callback`: the code and verifier, if `state` matches a live flow this agent started. */
export async function readOpenRouterCallback(request: Request, env: Env, agent: string): Promise<OpenRouterCallback> {
  const url = new URL(request.url);
  if (url.searchParams.get("error")) return { ok: false, error: "denied" };
  const token = readCookie(request, FLOW_COOKIE);
  const flow = token ? await unsign<Flow>(token, readSessionSecret(env)) : null;
  if (!flow || flow.agent !== agent || flow.exp * 1000 <= Date.now() || url.searchParams.get("state") !== flow.state) {
    return { ok: false, error: "state" };
  }
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, error: "code" };
  return { ok: true, code, verifier: flow.verifier };
}

/** The `Set-Cookie` that ends a flow, whatever its outcome. */
export function clearOpenRouterFlow(): string {
  return cookie(FLOW_COOKIE, "", { maxAge: 0 });
}

export type Exchanged = { ok: true; key: string } | { ok: false; status: 400 | 502; error: string };

/** Swap the code and verifier for the person's key. The key is returned to the caller only, to be sealed. */
export async function exchangeOpenRouterCode(
  code: string,
  verifier: string,
  fetcher: (request: Request) => Promise<Response>
): Promise<Exchanged> {
  let response: Response;
  try {
    response = await fetcher(
      new Request(OPENROUTER_KEYS, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" })
      })
    );
  } catch {
    return { ok: false, status: 502, error: "Couldn't reach OpenRouter. Try again." };
  }
  const body = (await response.json().catch(() => ({}))) as { key?: unknown };
  if (!response.ok || typeof body.key !== "string" || body.key === "") {
    return { ok: false, status: 400, error: "OpenRouter didn't issue a key. Try connecting again." };
  }
  return { ok: true, key: body.key };
}
