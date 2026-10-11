import { isAllowed, readAllowlist } from "./allowlist";
import { ConfigError, readModelConfig, readSessionSecret } from "./config";
import { finishSignIn, isProvider, startSignIn } from "./oauth";
import { handleIdentityRoute } from "./poppy/routes";
import { handleValidator } from "./validator/http.ts";
import {
  agentNameFor,
  AuthError,
  clearSession,
  verifySession,
  type Identity
} from "./session";

export { PersonalAgent } from "./agent";
export { CompanyLimiter } from "./poppy/limiter";

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

function sameOrigin(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

/**
 * The signed-in person, if they are still on the allowlist: removing someone
 * and redeploying locks them out on their next request.
 */
async function signedIn(request: Request, env: Env): Promise<Identity> {
  const identity = await verifySession(request, readSessionSecret(env));
  if (!isAllowed(identity, readAllowlist(env))) throw new AuthError("Not on the allowlist");
  return identity;
}

/** Verify the session, upgrade, and forward to the person's own agent. */
async function handleWs(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return text(405, "Method not allowed");
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return text(426, "Expected a WebSocket upgrade");
  }
  if (!sameOrigin(request)) {
    return text(403, "Cross-origin WebSocket refused");
  }
  // Fail here, naming the var, rather than inside the agent's constructor.
  readModelConfig(env);
  const identity = await signedIn(request, env);
  const name = await agentNameFor(identity);
  // Drop the query string so the client cannot pick a pi session.
  const url = new URL(request.url);
  const forwarded = new Request(`${url.origin}/ws`, request);
  return env.PersonalAgent.getByName(name).fetch(forwarded);
}

/** Who is signed in, for the page header. */
async function handleMe(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return text(405, "Method not allowed");
  const identity = await signedIn(request, env);
  return Response.json(
    { email: identity.email, provider: identity.provider },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** `POST /logout` from this origin only, so another site cannot sign you out. */
function handleLogout(request: Request): Response {
  if (request.method !== "POST") return text(405, "Method not allowed");
  if (!sameOrigin(request)) return text(403, "Cross-origin logout refused");
  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": clearSession(), "Cache-Control": "no-store" }
  });
}

/**
 * Poppy routes that belong to one person's agent: the Direct Sign-In
 * callback arrives in that person's browser, so their app session picks the
 * agent. Without a session there is no agent to give the code to.
 */
async function handlePoppy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/poppy/callback") return text(404, "Not found");
  if (request.method !== "GET") return text(405, "Method not allowed");
  let identity;
  try {
    identity = await signedIn(request, env);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    return new Response(
      "Sign in to your personal agent in this browser, then start the company sign-in again.",
      { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }
  const agent = env.PersonalAgent.getByName(await agentNameFor(identity));
  return agent.fetch(new Request(url.toString(), { method: "GET" }));
}

/** `/auth/<provider>` and `/auth/<provider>/callback`. */
async function handleAuth(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return text(405, "Method not allowed");
  const match = /^\/auth\/([a-z]+)(\/callback)?$/.exec(new URL(request.url).pathname);
  if (!match || !isProvider(match[1]!)) return text(404, "Not found");
  return match[2]
    ? finishSignIn(request, env, match[1])
    : startSignIn(request, env, match[1]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/validator" || pathname.startsWith("/validator/")) {
        const response = await handleValidator(request, {
          fetcher: (outbound) => fetch(outbound),
          // URL checks fetch from the network: a few a minute per address.
          allowFetch: async (inbound) =>
            (await env.VALIDATOR_LIMITER.limit({ key: inbound.headers.get("CF-Connecting-IP") ?? "unknown" })).success
        });
        if (response) return response;
      }
      if (pathname === "/ws") return await handleWs(request, env);
      if (pathname === "/api/me") return await handleMe(request, env);
      if (pathname === "/logout") return handleLogout(request);
      if (pathname.startsWith("/auth/")) return await handleAuth(request, env);
      if (pathname.startsWith("/poppy/")) {
        return (await handleIdentityRoute(request, env)) ?? (await handlePoppy(request, env));
      }
      // Static assets serve everything outside `run_worker_first`, so this
      // is only reached by unknown `/api/*` paths, including the SDK's own
      // `/agents/<class>/<name>` URLs, which are deliberately not routed.
      return text(404, "Not found");
    } catch (error) {
      if (error instanceof AuthError) {
        return text(401, "Unauthorized");
      }
      if (error instanceof ConfigError) {
        console.error("config error", error.message);
        return text(500, error.message);
      }
      console.error("request failed", error);
      return text(500, "Internal error");
    }
  }
} satisfies ExportedHandler<Env>;
