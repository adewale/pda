import type { AttachResult, Caller, KeyResult, PersonalAgent } from "./agent";
import { isAllowed, maySignIn, readOwners } from "./allowlist";
import { humanSize, MAX_ATTACHMENT_BYTES, MAX_PREVIEW_BYTES } from "./attachments";
import { ConfigError, readSessionSecret, readSignInProviders } from "./config";
import { checkDeployment } from "./deployment.ts";
import { withPagePolicy } from "./csp";
import { agentId, code, configureLog, currentEvent, id, inScope, literal, wideEvent, type Safe } from "./log";
import { privacyPage } from "./privacy";
import { parseSubscription, readVapidKey } from "./web-push";
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
 * request. What the agent is handed: who they are, and this request's id,
 * for the events of any turn the call starts.
 */
async function signedIn(request: Request, env: Env): Promise<Caller> {
  const identity = await verifySession(request, readSessionSecret(env));
  const event = currentEvent();
  event?.set({ sign_in_provider: literal(identity.provider) });
  if (!maySignIn(identity, env)) throw new AuthError("Not allowed to sign in");
  // Pseudonymous: the agent's Durable Object id, as its events and the demo gateway's metadata carry it. Never the email or provider id.
  event?.set({ signed_in: true, agent_id: agentId(env.PersonalAgent.idFromName(await agentNameFor(identity))), is_owner: isAllowed(identity, readOwners(env)) });
  const requestId = id(event?.fields.request_id);
  return requestId ? { ...identity, requestId } : identity;
}

/** The person's own agent, named by a hash of who they are. */
async function agentFor(identity: Identity, env: Env): Promise<DurableObjectStub<PersonalAgent>> {
  return env.PersonalAgent.getByName(await agentNameFor({ provider: identity.provider, sub: identity.sub }));
}

/** This request's id: Cloudflare's `cf-ray`, or a new one where there is none (local dev, tests). */
function requestIdOf(request: Request): Safe<"id"> {
  return id(request.headers.get("cf-ray")) ?? id(crypto.randomUUID())!;
}

/** The route a path takes, as a template written here: never an id, and never a query. */
export function routeOf(pathname: string): Safe<"literal"> {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  const exact = EXACT_ROUTES.find((route) => route === path);
  if (exact) return literal(exact);
  const collection = /^\/api\/(attachments|memories|schedules)\/[^/]+$/.exec(path)?.[1] as keyof typeof ITEM_ROUTES | undefined;
  if (collection) return literal(ITEM_ROUTES[collection]);
  if (path.startsWith("/auth/")) return literal("/auth/{other}");
  if (path.startsWith("/api/")) return literal("/api/{other}");
  if (path.startsWith("/poppy/")) return literal("/poppy/{other}");
  if (path.startsWith("/validator/")) return literal("/validator/{other}");
  return literal("{other}");
}

const ITEM_ROUTES = {
  attachments: "/api/attachments/{id}",
  memories: "/api/memories/{id}",
  schedules: "/api/schedules/{id}"
} as const;

const EXACT_ROUTES = [
  "/auth/google",
  "/auth/google/callback",
  "/auth/github",
  "/auth/github/callback",
  "/",
  "/ws",
  "/api/me",
  "/api/sign-in-options",
  "/api/entitlement",
  "/api/model-key",
  "/api/attachments",
  "/api/memories",
  "/api/schedules",
  "/api/push/key",
  "/api/push/subscription",
  "/privacy",
  "/logout",
  "/poppy/callback",
  "/poppy/client.json",
  "/poppy/jwks.json",
  "/validator",
  "/validator/api",
  "/validator/messages"
] as const;

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
  // Drop the query string so the client cannot pick a pi session; name this request, for the turns its messages start.
  const url = new URL(request.url);
  const forwarded = new Request(`${url.origin}/ws${identity.requestId ? `?request_id=${encodeURIComponent(identity.requestId)}` : ""}`, request);
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

/** `GET /api/sign-in-options`: which sign-in buttons the signed-out page shows. Public: it names providers, nobody's identity. */
function handleSignInOptions(request: Request, env: Env): Response {
  if (request.method !== "GET") return text(405, "Method not allowed");
  return Response.json({ providers: readSignInProviders(env) }, { headers: { "Cache-Control": "no-store" } });
}

/** `GET /api/entitlement`: the model lane, today's demo spend, the key's provider and state. Never the key. */
async function handleEntitlement(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return text(405, "Method not allowed");
  const identity = await signedIn(request, env);
  const entitlement = await (await agentFor(identity, env)).entitlement(identity);
  currentEvent()?.set({ lane: literal(entitlement.lane) });
  return json(200, entitlement);
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
  if (result.ok) currentEvent()?.set({ lane: literal(result.entitlement.lane) });
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

/**
 * The agent's notes about its User (src/tools/memory-store.ts), for
 * Settings. `GET /api/memories` lists them; `DELETE /api/memories/<id>`
 * forgets one and `DELETE /api/memories` every one, same origin only. Each
 * person reaches only their own agent's.
 */
async function handleMemories(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const rest = pathname.slice("/api/memories".length).replace(/^\//, "");
  if (rest !== "" && !/^[1-9]\d{0,15}$/.test(rest)) return text(404, "Not found");
  if (request.method === "GET" && rest === "") {
    const identity = await signedIn(request, env);
    return json(200, await (await agentFor(identity, env)).listMemories(identity));
  }
  if (request.method !== "DELETE") return text(405, "Method not allowed");
  if (!sameOrigin(request)) return text(403, "Cross-origin request refused");
  const identity = await signedIn(request, env);
  const agent = await agentFor(identity, env);
  if (rest === "") return json(200, { forgotten: await agent.forgetAllMemories(identity) });
  return (await agent.forgetMemory(identity, Number(rest))) ? new Response(null, { status: 204 }) : text(404, "Not found");
}

/**
 * Reminders and scheduled tasks (src/schedules.ts), for Settings.
 * `GET /api/schedules` lists those waiting or paused; `DELETE
 * /api/schedules/<id>` cancels one, same origin only. Each person reaches
 * only their own agent's.
 */
async function handleSchedules(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const rest = pathname.slice("/api/schedules".length).replace(/^\//, "");
  if (rest !== "" && !/^sch_[a-z0-9]{10}$/.test(rest)) return text(404, "Not found");
  if (request.method === "GET" && rest === "") {
    const identity = await signedIn(request, env);
    return json(200, await (await agentFor(identity, env)).listSchedules(identity));
  }
  if (request.method !== "DELETE" || rest === "") return text(405, "Method not allowed");
  if (!sameOrigin(request)) return text(403, "Cross-origin request refused");
  const identity = await signedIn(request, env);
  return (await (await agentFor(identity, env)).cancelSchedule(identity, rest)) ? new Response(null, { status: 204 }) : text(404, "Not found");
}

/**
 * Web Push (src/web-push.ts). `GET /api/push/key` gives the page the VAPID
 * public key to subscribe with, or null when this deployment has none (the
 * page then hides the option). `POST /api/push/subscription` keeps this
 * browser's subscription in the person's agent, only for a known push
 * service; `DELETE` with `{endpoint}` forgets it. Same origin only for both.
 */
async function handlePush(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/push/key") {
    if (request.method !== "GET") return text(405, "Method not allowed");
    await signedIn(request, env);
    return json(200, { publicKey: (await readVapidKey(env))?.publicKey ?? null });
  }
  if (pathname !== "/api/push/subscription") return text(404, "Not found");
  if (request.method !== "POST" && request.method !== "DELETE") return text(405, "Method not allowed");
  if (!sameOrigin(request)) return text(403, "Cross-origin request refused");
  const identity = await signedIn(request, env);
  const raw = await request.text();
  if (raw.length > 4096) return json(413, { error: "That's too long to be a push subscription." });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Send JSON." });
  }
  const agent = await agentFor(identity, env);
  if (request.method === "DELETE") {
    const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint !== "string") return json(400, { error: "Send the subscription's endpoint." });
    return (await agent.removePushSubscription(identity, endpoint)) ? new Response(null, { status: 204 }) : text(404, "Not found");
  }
  if (!(await readVapidKey(env))) return json(404, { error: "Notifications aren't available on this deployment." });
  const subscription = parseSubscription(body);
  if (typeof subscription === "string") return json(400, { error: subscription });
  await agent.addPushSubscription(identity, subscription);
  return new Response(null, { status: 201 });
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
  return agent.fetch(new Request(url.toString(), { method: "GET", headers: identity.requestId ? { "x-request-id": identity.requestId } : {} }));
}

/** `/auth/<provider>` and `/auth/<provider>/callback`. */
async function handleAuth(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return text(405, "Method not allowed");
  const match = /^\/auth\/([a-z]+)(\/callback)?$/.exec(new URL(request.url).pathname);
  if (!match || !isProvider(match[1]!)) return text(404, "Not found");
  if (!readSignInProviders(env).includes(match[1])) return text(404, "This deployment doesn't offer that sign-in.");
  return match[2]
    ? finishSignIn(request, env, match[1])
    : startSignIn(request, env, match[1]);
}

export default {
  /**
   * Every page the Worker writes gets the app's Content-Security-Policy, and
   * every request one wide event (src/log.ts), written when it ends: the
   * method, the route's template, the status, who (pseudonymously) and how
   * it went. Handlers add to it through `currentEvent()`.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    configureLog(env);
    const cf = (request as { cf?: { colo?: unknown; country?: unknown } }).cf;
    const event = wideEvent("http", {
      method: code(request.method) ?? literal("other"),
      route: routeOf(new URL(request.url).pathname),
      request_id: requestIdOf(request),
      signed_in: false,
      ...(code(cf?.colo) ? { colo: code(cf?.colo) } : {}),
      ...(code(cf?.country) ? { country: code(cf?.country) } : {})
    });
    try {
      const response = await inScope(event, () => route(request, env));
      event.set({ status: response.status });
      if (event.fields.outcome === undefined) event.set({ outcome: literal(outcomeOf(response.status)) });
      if (response.status >= 500) event.level = "error";
      return withPagePolicy(response);
    } catch (error) {
      event.set({ status: 500 }).fail(error);
      throw error;
    } finally {
      event.emit();
    }
  }
} satisfies ExportedHandler<Env>;

/** How a status reads in the event: refused for 401 and 403, rejected for other 4xx, error for 5xx. */
function outcomeOf(status: number): "error" | "refused" | "rejected" | "success" {
  if (status >= 500) return "error";
  if (status === 401 || status === 403) return "refused";
  if (status >= 400) return "rejected";
  return "success";
}

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
    if (pathname === "/api/sign-in-options") return handleSignInOptions(request, env);
    if (pathname === "/privacy") return request.method === "GET" ? privacyPage(env) : text(405, "Method not allowed");
    if (pathname === "/api/entitlement") return await handleEntitlement(request, env);
    if (pathname === "/api/model-key") return await handleModelKey(request, env);
    if (pathname === "/api/attachments" || pathname.startsWith("/api/attachments/")) return await handleAttachments(request, env);
    if (pathname === "/api/memories" || pathname.startsWith("/api/memories/")) return await handleMemories(request, env);
    if (pathname === "/api/schedules" || pathname.startsWith("/api/schedules/")) return await handleSchedules(request, env);
    if (pathname.startsWith("/api/push/")) return await handlePush(request, env);
    if (pathname === "/logout") return handleLogout(request);
    if (pathname.startsWith("/auth/")) return await handleAuth(request, env);
    if (pathname.startsWith("/poppy/")) {
      return (await handleIdentityRoute(request, env)) ?? (await handlePoppy(request, env));
    }
    // Only paths `run_worker_first` sends here reach this line: an unknown
    // `/api/*`, `/auth/*`, `/poppy/*` or `/validator/*` path. Every other
    // path that matches no file gets the page (`single-page-application`),
    // including the SDK's own `/agents/<class>/<name>` URLs, which are
    // deliberately not routed to the agent.
    return text(404, "Not found");
  } catch (error) {
    if (error instanceof AuthError) {
      return text(401, "Unauthorized");
    }
    // On the request's event: its class, and its message redacted.
    currentEvent()?.fail(error, error instanceof ConfigError ? { code: literal("config") } : {});
    if (error instanceof ConfigError) return text(500, error.message);
    return text(500, "Internal error");
  }
}
