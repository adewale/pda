import type { AttachResult, KeyResult, PersonalAgent } from "./agent";
import { maySignIn } from "./allowlist";
import { humanSize, MAX_ATTACHMENT_BYTES, MAX_PREVIEW_BYTES } from "./attachments";
import { ConfigError, readSessionSecret } from "./config";
import { checkDeployment } from "./deployment.ts";
import { withPagePolicy } from "./csp";
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
export { DomainBudget } from "./budget";
export { CompanyLimiter } from "./poppy/limiter";

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function sameOrigin(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

/**
 * The signed-in person, if they may still use the app: removing someone from
 * the allowlist (or `OWNERS`) and redeploying locks them out on their next
 * request.
 */
async function signedIn(request: Request, env: Env): Promise<Identity> {
  const identity = await verifySession(request, readSessionSecret(env));
  if (!maySignIn(identity, env)) throw new AuthError("Not allowed to sign in");
  return identity;
}

/** The person's own agent, named by a hash of who they are. */
async function agentFor(identity: Identity, env: Env): Promise<DurableObjectStub<PersonalAgent>> {
  return env.PersonalAgent.getByName(await agentNameFor(identity));
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
  const identity = await signedIn(request, env);
  const agent = await agentFor(identity, env);
  // Who this agent belongs to, for the demo check on its model calls.
  await agent.recordIdentity(identity);
  // Drop the query string so the client cannot pick a pi session.
  const url = new URL(request.url);
  const forwarded = new Request(`${url.origin}/ws`, request);
  return agent.fetch(forwarded);
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

/** `GET /api/entitlement`: the model lane, today's demo spend, the key's provider and state. Never the key. */
async function handleEntitlement(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return text(405, "Method not allowed");
  const identity = await signedIn(request, env);
  return json(200, await (await agentFor(identity, env)).entitlement(identity));
}

/**
 * `POST /api/model-key` `{provider, key}` saves a key once the provider
 * accepts it; `DELETE` removes it. Same origin only. The answer is the new
 * entitlement or an error, never the key.
 */
async function handleModelKey(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST" && request.method !== "DELETE") return text(405, "Method not allowed");
  if (!sameOrigin(request)) return text(403, "Cross-origin request refused");
  const identity = await signedIn(request, env);
  const agent = await agentFor(identity, env);
  if (request.method === "DELETE") return json(200, await agent.removeModelKey(identity));
  const raw = await request.text();
  if (raw.length > 4096) return json(413, { error: "That's too long to be a key." });
  let body: { provider?: unknown; key?: unknown; workspace?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return json(400, { error: "Send JSON with provider and key." });
  }
  const result: KeyResult = await agent.setModelKey(identity, body?.provider, body?.key, body?.workspace);
  return result.ok ? json(200, result.entitlement) : json(result.status, { error: result.error });
}

/** The most a `POST /api/attachments` body may be: the file, the model's preview, and the form around them. */
const MAX_ATTACH_BODY = MAX_ATTACHMENT_BYTES + MAX_PREVIEW_BYTES + 64 * 1024;
const ATTACHMENT_ID = /^att_[A-Za-z0-9_-]{22}$/;

/**
 * The User's photos (src/attachments.ts). `POST /api/attachments`, same
 * origin only: a `multipart/form-data` body with `file` and, optionally, the
 * smaller `preview` the page made for the model; the answer is the
 * attachment's id, name, type and size. `GET /api/attachments/<id>` serves
 * one back to its owner's page; `DELETE` removes one. Each person reaches
 * only their own agent's.
 */
async function handleAttachments(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const id = pathname.slice("/api/attachments".length).replace(/^\//, "");
  if (id === "") {
    if (request.method !== "POST") return text(405, "Method not allowed");
    if (!sameOrigin(request)) return text(403, "Cross-origin request refused");
    const identity = await signedIn(request, env);
    const length = Number(request.headers.get("Content-Length") ?? "NaN");
    if (!Number.isFinite(length)) return json(411, { error: "Send the photo with a Content-Length." });
    if (length > MAX_ATTACH_BODY) return json(413, { error: `The most your agent takes is ${humanSize(MAX_ATTACHMENT_BYTES)} a photo.` });
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return json(400, { error: "Send the photo as multipart/form-data, in a field named file." });
    }
    const file = form.get("file");
    const preview = form.get("preview");
    if (typeof file === "string" || file === null) return json(400, { error: "Send the photo in a field named file." });
    const result: AttachResult = await (await agentFor(identity, env)).attach(
      identity,
      file.name || null,
      await file.arrayBuffer(),
      preview && typeof preview !== "string" ? await preview.arrayBuffer() : null
    );
    return result.ok ? json(201, result.attachment) : json(result.status, { error: result.error });
  }
  if (!ATTACHMENT_ID.test(id)) return text(404, "Not found");
  if (request.method === "GET") {
    const identity = await signedIn(request, env);
    const found = await (await agentFor(identity, env)).attachment(identity, id);
    if (!found) return text(404, "Not found");
    return new Response(found.bytes, {
      headers: {
        "Content-Type": found.info.type,
        "Content-Length": String(found.info.size),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline"
      }
    });
  }
  if (request.method === "DELETE") {
    if (!sameOrigin(request)) return text(403, "Cross-origin request refused");
    const identity = await signedIn(request, env);
    return (await (await agentFor(identity, env)).removeAttachment(identity, id)) ? new Response(null, { status: 204 }) : text(404, "Not found");
  }
  return text(405, "Method not allowed");
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
  const agent = await agentFor(identity, env);
  await agent.recordIdentity(identity);
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
  /** Every page the Worker writes gets the app's Content-Security-Policy. */
  async fetch(request: Request, env: Env): Promise<Response> {
    return withPagePolicy(await route(request, env));
  }
} satisfies ExportedHandler<Env>;

/** The Worker's own routes; static assets serve everything else. */
async function route(request: Request, env: Env): Promise<Response> {
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
    // Fail closed, naming the setting, until the deployer has said who
    // this deployment is for and where it lives.
    checkDeployment(env);
    if (pathname === "/ws") return await handleWs(request, env);
    if (pathname === "/api/me") return await handleMe(request, env);
    if (pathname === "/api/entitlement") return await handleEntitlement(request, env);
    if (pathname === "/api/model-key") return await handleModelKey(request, env);
    if (pathname === "/api/attachments" || pathname.startsWith("/api/attachments/")) return await handleAttachments(request, env);
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
    console.error("request failed", error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
    return text(500, "Internal error");
  }
}
