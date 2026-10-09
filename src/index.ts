import { ConfigError, readAccessConfig, readConfig } from "./config";
import { agentNameFor, AuthError, verifyAccess } from "./identity";

export { PersonalAgent } from "./agent";

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

/** Verify Access, upgrade, and forward to the person's own agent. */
async function handleWs(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return text(405, "Method not allowed");
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return text(426, "Expected a WebSocket upgrade");
  }
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) {
    return text(403, "Cross-origin WebSocket refused");
  }
  const config = readConfig(env);
  const identity = await verifyAccess(request, config);
  const name = await agentNameFor(identity);
  // Drop the query string so the client cannot pick a pi session.
  const forwarded = new Request(`${url.origin}/ws`, request);
  return env.PersonalAgent.getByName(name).fetch(forwarded);
}

/** The signed-in email, for the page header. Not stored. */
async function handleMe(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return text(405, "Method not allowed");
  const identity = await verifyAccess(request, readAccessConfig(env));
  return Response.json(
    { email: identity.email ?? null },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/ws") return await handleWs(request, env);
      if (pathname === "/api/me") return await handleMe(request, env);
      // Static assets serve everything outside `run_worker_first`, so this
      // is only reached by unknown `/api/*` paths, including the SDK's own
      // `/agents/<class>/<name>` URLs, which are deliberately not routed.
      return text(404, "Not found");
    } catch (error) {
      if (error instanceof AuthError) {
        console.warn("access denied", error.message);
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
