// Interop adapter for pi-poppy's Personal Agent (github.com/richardanaya/pi-poppy).
//
// Spec: docs/interop-spec.md, sections 3, 4, 5.1 and 5.2.
// - Port 8080 (behind the proxy, as https://<name>.agent.interop.test): pi-poppy's own
//   IdentityServer request handler, which serves the client metadata (/agent.json),
//   the JWKS (/jwks.json) and the Direct Sign-In redirect target (/oauth/callback).
// - Port 8081: the control API. Every step calls pi-poppy's PersonalAgent directly,
//   in the order pi-poppy's own extension (index.ts) calls it. No model is involved.
//
// Runs under `node --experimental-strip-types`; pi-poppy's src/ has no npm dependencies.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const NAME = process.env.INTEROP_NAME || "pi-poppy";
const DOMAIN = process.env.INTEROP_DOMAIN || `${NAME}.agent.interop.test`;
const ORIGIN = (process.env.INTEROP_ORIGIN || `https://${DOMAIN}`).replace(/\/+$/, "");
const SECRET = process.env.INTEROP_SECRET || "";
const COMMIT = process.env.PI_POPPY_COMMIT || process.env.INTEROP_COMMIT || "unknown";
const DIR = process.env.PI_POPPY_DIR || "/opt/pi-poppy";

// ---------------------------------------------------------------------------
// Request log. pi-poppy calls https.request by name (src/net.ts), so the builtin is
// wrapped and its ESM export synced before pi-poppy is imported. The wrapper only
// records method, URL and status, so a Poppy error code can be reported with the
// HTTP status the Company returned (spec 5.2), and GET /log can list the calls.
// ---------------------------------------------------------------------------
interface Exchange {
	at: string;
	method: string;
	url: string;
	status?: number;
	error?: string;
}
let exchanges: Exchange[] = [];
let lastExchange: Exchange | undefined;
const originalRequest = https.request;
(https as unknown as { request: unknown }).request = function (this: unknown, options: any, ...rest: any[]) {
	const port = options?.port && String(options.port) !== "443" ? `:${options.port}` : "";
	const entry: Exchange = {
		at: new Date().toISOString(),
		method: String(options?.method ?? "GET"),
		url: `https://${options?.hostname ?? options?.host ?? "?"}${port}${String(options?.path ?? "/").split("?")[0]}`,
	};
	exchanges.push(entry);
	if (exchanges.length > 500) exchanges = exchanges.slice(-500);
	lastExchange = entry;
	const req = (originalRequest as any).call(this, options, ...rest);
	req.on("response", (res: http.IncomingMessage) => {
		entry.status = res.statusCode;
	});
	req.on("error", (error: Error) => {
		entry.error = error.message;
	});
	return req;
};
syncBuiltinESMExports();

const { PersonalAgent } = await import(`${DIR}/src/agent.ts`);
const { IdentityServer } = await import(`${DIR}/src/identity.ts`);
const { generateEs256, publicOnly } = await import(`${DIR}/src/jwt.ts`);
const { MemoryStore } = await import(`${DIR}/src/store.ts`);
const { randomId } = await import(`${DIR}/src/codec.ts`);
const { userApproval } = await import(`${DIR}/src/approval.ts`);
const { httpRequest, headerOne } = await import(`${DIR}/src/net.ts`);

// ---------------------------------------------------------------------------
// World: one PersonalAgent, its identity documents, and the adapter's bookkeeping.
// ---------------------------------------------------------------------------
interface Pending {
	method: "direct" | "device" | "mediated";
	scope: string;
	account?: string;
	login?: any;
	signInId?: string;
}

interface World {
	agent: any;
	identity: any;
	sessions: Map<string, any>;
	discoveries: Map<string, any>;
	pending: Map<string, Pending>;
	accounts: Map<string, string | undefined>;
}

function newWorld(): World {
	const keys = generateEs256();
	// A new kid on every reset: the keys the client metadata lists rotate (spec 5.1).
	const kid = `pi-poppy-${randomId(4)}`;
	const identity = new IdentityServer({
		cert: "",
		key: "",
		clientName: "pi-poppy",
		signingPublicJwk: publicOnly(keys.publicJwk),
		kid,
		extensions: { operations: { version: "1" } },
	});
	// IdentityServer.start() would listen on 127.0.0.1 over HTTPS and name itself after
	// that loopback port. Here its handler is served behind the interop proxy instead,
	// so it is given the public origin it is reached at.
	Object.assign(identity, {
		base: ORIGIN,
		clientId: `${ORIGIN}/agent.json`,
		redirectUri: `${ORIGIN}/oauth/callback`,
		jwksUri: `${ORIGIN}/jwks.json`,
	});
	const agent = new PersonalAgent({
		clientId: identity.clientId,
		clientName: "pi-poppy",
		redirectUris: [identity.redirectUri],
		signingPrivateJwk: keys.privateJwk,
		signingKid: kid,
		store: new MemoryStore(),
		// No `ca`: Node's default store plus NODE_EXTRA_CA_CERTS (the interop CA).
		allowLoopback: false,
	});
	return { agent, identity, sessions: new Map(), discoveries: new Map(), pending: new Map(), accounts: new Map() };
}

let world = newWorld();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
class StepError extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string, detail: string) {
		super(detail);
		this.status = status;
		this.code = code;
	}
}
const unsupported = (detail: string) => new StepError(501, "unsupported", detail);

/**
 * `{"ok": false, "poppy_error", "status"}` (spec 5.2): an error the Company returned
 * (with its HTTP status), or pi-poppy's own refusal of something the Company did
 * (status 0).
 */
class PoppyError extends Error {
	status: number;
	code: string;
	constructor(code: string, status: number, detail?: string) {
		super(detail ?? code);
		this.code = code;
		this.status = status;
	}
}
const refusal = (code: string, detail: string) => new PoppyError(code, 0, detail);

/** An HTTP error response from the Company, as its Poppy or OAuth error code. */
function companyError(status: number, body: unknown): PoppyError {
	const object = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const code = typeof object.error === "string" ? object.error : `http_${status}`;
	return new PoppyError(code, status, typeof object.error_description === "string" ? object.error_description : undefined);
}

function key(company: string, label?: string): string {
	return `${company}#${label ?? "default"}`;
}

async function discovery(company: string): Promise<any> {
	const cached = world.discoveries.get(company);
	if (cached) return cached;
	const found = await world.agent.discover(company);
	world.discoveries.set(company, found);
	return found;
}

/** The Session for this Company and label, started (as poppy_session_start does) if there is none. */
async function ensureSession(company: string, label?: string): Promise<any> {
	const k = key(company, label);
	const existing = world.sessions.get(k);
	if (existing) return existing;
	const found = await discovery(company);
	const live = await world.agent.startSession(found);
	world.sessions.set(k, live);
	return live;
}

function messagesOf(events: any[] | undefined): Array<{ role: string; text: string; sender?: string; operation?: string }> {
	return (events ?? [])
		.filter((event) => event.type === "message" && event.message)
		.map((event) => ({
			role: event.message.role,
			sender: event.message.sender,
			text: event.message.text ?? "",
			...(event.message.operation?.operation_id ? { operation: event.message.operation.operation_id } : {}),
		}));
}

function useConversation(live: any, conversation: string | undefined): void {
	if (live.conversationId !== conversation) {
		// pi-poppy keeps one cursor per Session; a different conversation starts afresh.
		live.cursor = "";
		live.seenEvents = new Set();
	}
	live.conversationId = conversation;
}

async function hasAccount(issuer: string): Promise<boolean> {
	// accountCovers(issuer, []) is true exactly when an Account Token is stored.
	return world.agent.accountCovers(issuer, []);
}

function signedInResult(live: any, account: string | undefined) {
	return { signed_in: Boolean(live.signedIn), account: account ?? null, scope: live.scope, session_id: live.sessionId };
}

// ---------------------------------------------------------------------------
// Steps (spec 5.2)
// ---------------------------------------------------------------------------
type Params = Record<string, any>;

const steps: Record<string, (company: string, params: Params) => Promise<unknown>> = {
	async discover(company) {
		world.discoveries.delete(company);
		let found: any;
		try {
			found = await discovery(company);
		} catch (error: any) {
			throw new PoppyError("discovery_failed", 0, String(error?.message ?? error));
		}
		const doc = found.document;
		return {
			issuer: doc.auth?.issuer ?? null,
			poppy_version: doc.protocol_version,
			conversations: Boolean(world.agent.conversationEndpoint(doc)),
			apis: (doc.apis ?? []).map((api: any) => api.type),
			api_urls: (doc.apis ?? []).map((api: any) => api.url),
			organization: doc.organization,
		};
	},

	async session(company, params) {
		const live = await ensureSession(company, params.label);
		return { session_id: live.sessionId, signed_in: Boolean(live.signedIn), scope: live.scope };
	},

	async signin(company, params) {
		const live = await ensureSession(company, params.label);
		const auth = live.discovery.document.auth;
		if (!auth) throw refusal("agent_refused", "company has no sign-in");
		const scope = (Array.isArray(params.scopes) && params.scopes.length ? params.scopes : ["poppy:read"]).join(" ");
		const k = key(company, params.label);
		// As pi-poppy's extension does: a stored Account Token that covers the scope is used first.
		if (await world.agent.accountCovers(auth.issuer, scope.split(" "))) {
			const renewed = await world.agent.useAccount(live, scope, live.sessionId);
			world.sessions.set(k, renewed);
			return signedInResult(renewed, world.accounts.get(auth.issuer) ?? params.account);
		}
		const method = params.method;
		if (method === "direct") {
			if (!auth.direct) throw refusal("agent_refused", "company does not offer direct sign-in");
			const started = await world.agent.beginDirectSignIn(live, scope);
			world.pending.set(k, { method, scope, account: params.account });
			return { pending: { url: started.url } };
		}
		if (method === "device") {
			if (!auth.device) throw refusal("agent_refused", "company does not offer device sign-in");
			const login = await world.agent.beginDeviceSignIn(live, scope);
			world.pending.set(k, { method, scope, account: params.account, login });
			return { pending: { url: login.verificationUriComplete ?? login.verificationUri, user_code: login.userCode } };
		}
		if (method === "mediated") {
			if (!auth.mediated) throw refusal("agent_refused", "company does not offer mediated sign-in");
			world.pending.set(k, { method, scope, account: params.account });
			return { pending: { fields: auth.mediated.fields ?? [] } };
		}
		throw new StepError(400, "bad_request", `unknown sign-in method ${String(method)}`);
	},

	async signin_continue(company, params) {
		const k = key(company, params.label);
		const live = await ensureSession(company, params.label);
		const pending = world.pending.get(k);
		if (!pending) throw new StepError(409, "no_pending_signin", "no sign-in is pending for this Session");
		const issuer = live.discovery.document.auth?.issuer;
		const done = (next: any) => {
			world.pending.delete(k);
			world.sessions.set(k, next);
			if (pending.account) world.accounts.set(issuer, pending.account);
			return signedInResult(next, pending.account);
		};
		if (pending.method === "direct") {
			if (typeof params.callback_url !== "string") throw new StepError(400, "bad_request", "callback_url is required");
			const error = new URL(params.callback_url).searchParams.get("error");
			if (error) {
				// pi-poppy checks the state and throws the redirect's `error`; report it as the
				// Company's answer, carried by the authorization response redirect.
				try {
					await world.agent.completeDirectSignIn(params.callback_url);
				} catch {
					world.pending.delete(k);
					throw new PoppyError(error, 0, `the authorization response carried error=${error}`);
				}
			}
			return done(await world.agent.completeDirectSignIn(params.callback_url));
		}
		if (pending.method === "device") {
			// pi-poppy's extension polls for up to 60 s, waiting `interval` between polls.
			const deadline = Date.now() + 60_000;
			let current = pending.login;
			let first = true;
			while (Date.now() < deadline) {
				const polled = await world.agent.pollDeviceSignIn(current, { wait: !first });
				first = false;
				if (!polled.pending) return done(polled.session);
				current = polled.login;
			}
			throw new StepError(504, "timeout", "device sign-in still pending after 60 s");
		}
		const fields = (params.fields ?? {}) as Record<string, string>;
		const code = typeof params.code === "string" ? params.code : fields.code;
		if (pending.signInId && typeof code !== "string") throw new StepError(400, "bad_request", "code is required: the Company asked for a one-time code");
		const result = pending.signInId
			? await world.agent.submitMediatedCode(live, pending.signInId, String(code))
			: await world.agent.mediatedSignIn(live, fields, pending.scope);
		if (result.status === "code_required" && (result.signInId || pending.signInId)) {
			pending.signInId = result.signInId ?? pending.signInId;
			return { pending: { code_required: true, sent_to: result.sentTo ?? null } };
		}
		if (result.session) return done(result.session);
		world.pending.delete(k);
		// Mediated Sign-In answers 200 with status failed or expired (pi-poppy's reading).
		throw new PoppyError(result.status === "expired" ? "expired_token" : "access_denied", 0, `Mediated Sign-In ended with status ${result.status}`);
	},

	async send(company, params) {
		const live = await ensureSession(company, params.label);
		useConversation(live, params.conversation);
		const messageId = params.message_id ?? `msg_${randomId(8)}`;
		const message: Record<string, unknown> = { id: messageId, sender: params.sender ?? "agent" };
		if (typeof params.text === "string") message.text = params.text;
		if (params.data && typeof params.data === "object") message.data = params.data;
		if (params.context && typeof params.context === "object") message.context = params.context;
		// pi-poppy's extension sends with wait=2 and no cursor.
		const sent = await world.agent.sendMessage(live, message, { wait: params.wait ?? 2 });
		return {
			conversation: sent.conversationId,
			message_id: messageId,
			status: sent.status,
			responder: sent.responder,
			messages: messagesOf(sent.events?.events),
			cursor: sent.events?.cursor ?? null,
		};
	},

	async read(company, params) {
		const live = await ensureSession(company, params.label);
		if (typeof params.conversation !== "string") throw new StepError(400, "bad_request", "conversation is required");
		useConversation(live, params.conversation);
		// No cursor reads from the start (pi-poppy would otherwise resume from its last cursor).
		const events = await world.agent.readEvents(live, { cursor: params.cursor ?? "", wait: params.wait });
		return {
			messages: messagesOf(events.events),
			cursor: events.cursor,
			has_more: Boolean(events.has_more),
			status: events.status,
			responder: events.responder,
			gap: Boolean(events.gap),
		};
	},

	async sse(company, params) {
		const live = await ensureSession(company, params.label);
		if (typeof params.conversation !== "string") throw new StepError(400, "bad_request", "conversation is required");
		useConversation(live, params.conversation);
		// pi-poppy reads one short burst: it stops at the first complete SSE frame or after
		// 300 ms, so max_events is an upper bound it rarely reaches.
		// No cursor streams from the start, as `read` does.
		const burst = await world.agent.readEventStream(live, { cursor: params.cursor ?? "" });
		const max = typeof params.max_events === "number" ? params.max_events : Infinity;
		const events = burst.events.slice(0, max).map((event: any) => ({ id: event.id, type: event.type, data: event }));
		return { events, last_id: events.at(-1)?.id ?? null, deltas: burst.deltas };
	},

	async api(company, params) {
		const live = await ensureSession(company, params.label);
		const apis: any[] = live.discovery.document.apis ?? [];
		// `api` is a URL the Company listed, or a type ("openapi", "mcp"): the first API of that type.
		const api = apis.find((item) => item.url === params.api) ?? apis.find((item) => item.type === params.api);
		if (!api) throw refusal("unknown_api", `company lists no API ${String(params.api)}`);
		const args = (params.args ?? {}) as { params?: Record<string, unknown>; body?: unknown };
		if (api.type === "openapi") {
			if (typeof params.operation !== "string") throw new StepError(400, "bad_request", "operation is required for an OpenAPI API");
			// pi-poppy's poppy_api_call takes a path and an optional body; the model reads the
			// OpenAPI document to choose them. The adapter does that reading instead.
			const doc = await world.agent.callApi(live, api.url);
			if (doc.status >= 400) throw companyError(doc.status, doc.body);
			// `operation` is an operationId, or "METHOD /path".
			const literal = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i.exec(params.operation);
			let found: { path: string; method: string; absolute?: boolean } | undefined;
			for (const [path, item] of Object.entries((doc.body as any)?.paths ?? {})) {
				for (const [method, op] of Object.entries(item as Record<string, any>)) {
					if (!op || typeof op !== "object") continue;
					if (op.operationId === params.operation) found = { path, method: method.toUpperCase() };
					if (literal && method.toUpperCase() === literal[1]!.toUpperCase() && path === literal[2]) found = { path, method: method.toUpperCase() };
				}
			}
			if (!found && literal) found = { path: literal[2]!, method: literal[1]!.toUpperCase(), absolute: true };
			if (!found) throw refusal("unknown_operation", `no operation ${params.operation} in ${api.url}`);
			if (found.method !== "GET" && found.method !== "POST") throw unsupported(`pi-poppy's callApi sends only GET and POST, not ${found.method}`);
			// args.params fill the path template; the rest go in the query.
			const values = { ...(args.params ?? {}) };
			const path = found.path.replace(/\{([^}]+)\}/g, (_m, name) => {
				const value = values[name];
				delete values[name];
				return encodeURIComponent(String(value ?? ""));
			});
			// OpenAPI's default server is "/", resolved against the document's URL.
			const server = found.absolute ? "/" : ((doc.body as any)?.servers?.[0]?.url ?? "/");
			const base = new URL(server, api.url);
			const target = new URL(base.pathname.replace(/\/$/, "") + path, base.origin);
			for (const [name, value] of Object.entries(values)) target.searchParams.set(name, String(value));
			const body = found.method === "POST" ? (args.body ?? {}) : undefined;
			const result = await world.agent.callApi(live, target.toString(), body);
			if (result.status >= 400) throw companyError(result.status, result.body);
			return { status: result.status, body: result.body, operation: result.operation?.operation_id ?? null };
		}
		if (api.type === "mcp") {
			if (typeof params.tool !== "string") throw new StepError(400, "bad_request", "tool is required for an MCP API");
			const toolArgs = (params.args ?? {}) as Record<string, unknown>;
			// pi-poppy mints the Bearer token (mcpBearer) and hands it to pi's built-in MCP
			// client. The adapter stands in for that client with three JSON-RPC calls.
			const bearer = await world.agent.mcpBearer(live, api.url);
			const rpc = async (body: Record<string, unknown>, sessionId?: string) => {
				const headers: Record<string, string> = {
					authorization: `Bearer ${bearer}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				};
				if (sessionId) headers["mcp-session-id"] = sessionId;
				return httpRequest(api.url, { method: "POST", headers, body: JSON.stringify(body), timeoutMs: 15_000, maxBytes: 1_000_000 });
			};
			const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-poppy-interop", version: "0.1.0" } } });
			if (init.status >= 400) throw companyError(init.status, parseMaybe(init.body.toString("utf8")));
			const sid = headerOne(init.headers, "mcp-session-id");
			await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
			const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: params.tool, arguments: toolArgs } }, sid);
			const parsed = parseMaybe(call.body.toString("utf8"));
			if (call.status >= 400) throw companyError(call.status, parsed);
			return { status: call.status, body: parsed };
		}
		throw unsupported(`pi-poppy does not implement API type ${api.type}`);
	},
	async web_join(company, params) {
		const live = await ensureSession(company, params.label);
		if (!live.discovery.document.web?.browser_session_endpoint) return { joined: false };
		await world.agent.joinBrowser(live, params.url);
		return { joined: Boolean(live.browserJoined) };
	},

	async approve_op(company, params) {
		const live = await ensureSession(company, params.label);
		const operation = await world.agent.readOperation(live, params.operation);
		if (params.decision === "decline") {
			// The extension does nothing on a "no"; its poppy_operation_cancel tool tells the Company.
			const cancelled = await world.agent.cancelOperation(live, params.operation);
			return { status: cancelled.state };
		}
		const companyName = live.discovery.document.organization.name;
		const approval = userApproval({ accepted: true, companyName, summary: operation.summary, operation });
		const confirmed = await world.agent.confirmOperation(live, operation, approval);
		return { status: confirmed.state, revision: confirmed.revision };
	},

	async signout(company, params) {
		const live = await ensureSession(company, params.label);
		const issuer = live.discovery.document.auth?.issuer;
		const had = issuer ? await hasAccount(issuer) : false;
		await world.agent.revoke(live);
		if (issuer) world.accounts.delete(issuer);
		return { revoked: had };
	},

	async state() {
		const sessions = [...world.sessions.entries()].map(([k, live]) => ({ key: k, ...world.agent.describe(live) }));
		const accounts: Array<{ issuer: string; account: string | null }> = [];
		for (const found of world.discoveries.values()) {
			const issuer = found.document.auth?.issuer;
			if (issuer && (await hasAccount(issuer))) accounts.push({ issuer, account: world.accounts.get(issuer) ?? null });
		}
		return { sessions, accounts };
	},
};

function parseMaybe(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

// ---------------------------------------------------------------------------
// Manifest (spec 4)
// ---------------------------------------------------------------------------
const manifest = {
	interop: 1,
	name: NAME,
	role: "agent",
	commit: COMMIT,
	poppy: ["0.1"],
	extensions: ["operations"],
	scenarios: ["D", "S0", "N", "SD", "SV", "SM", "SMC", "SX", "SXV", "SO", "SE", "R", "C", "CI", "CA", "AO", "AM", "AS", "RL", "O", "OX"],
	readings: { S1: "token-endpoint", S2: "any", S3: "append", S4: "omit", S23: "per-origin" },
	relaxations: [
		"PI_POPPY_INTEROP_PRIVATE_SUFFIX=.interop.test (patches/0001): host names under .interop.test may resolve to private addresses; unset by default, loopback still refused",
		"Client metadata and JWKS are served by pi-poppy's IdentityServer handler on plain HTTP at the interop origin behind the proxy, instead of its own loopback HTTPS listener",
		"The interop CA is trusted through NODE_EXTRA_CA_CERTS (pi-poppy's `ca` option is left unset)",
	],
	notes: [
		"Session assertions carry no typ header (client assertions carry typ JWT); both live 60 s.",
		"api: the adapter resolves an OpenAPI operationId to a path and stands in for pi's MCP client.",
		"sse: pi-poppy reads one short burst (it stops at the first chunk holding a complete frame, or after 300 ms), and its extension has no SSE tool, so CS is not claimed.",
	],
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) return {};
	return JSON.parse(text);
}

function authorized(req: http.IncomingMessage): boolean {
	if (!SECRET) return true;
	return req.headers.authorization === `Bearer ${SECRET}`;
}

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const next = queue.then(fn, fn);
	queue = next.catch(() => undefined);
	return next;
}

async function runStep(body: any): Promise<{ status: number; body: unknown }> {
	const op = String(body?.op ?? "");
	const handler = steps[op];
	if (!handler) return { status: 501, body: { error: "unsupported", detail: `op ${op} is not supported by pi-poppy's adapter` } };
	const company = String(body?.company ?? "");
	if (op !== "state" && !company) return { status: 400, body: { error: "bad_request", detail: "company is required" } };
	lastExchange = undefined;
	try {
		const result = await handler(company, (body?.params ?? {}) as Params);
		return { status: 200, body: { ok: true, result } };
	} catch (error: any) {
		if (error instanceof StepError) return { status: error.status, body: { error: error.code, detail: error.message } };
		if (error instanceof PoppyError) {
			return { status: 200, body: { ok: false, poppy_error: error.code, status: error.status, detail: error.message } };
		}
		const message = String(error?.message ?? error);
		const httpStatus = lastExchange?.status;
		// pi-poppy throws the Company's `error` member as the message for refused requests.
		if (httpStatus && httpStatus >= 400 && /^[a-z][a-z0-9_]*$/.test(message)) {
			return { status: 200, body: { ok: false, poppy_error: message, status: httpStatus, detail: `${lastExchange?.method} ${lastExchange?.url}` } };
		}
		if (error instanceof TypeError || error instanceof ReferenceError) {
			return { status: 500, body: { error: "adapter_error", detail: error.stack ?? message } };
		}
		// pi-poppy's own refusal (a document it won't parse, a check that failed, a network
		// error such as a timeout): status 0, with pi-poppy's message (spec 5.2).
		const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]*$/.test(error.code) ? error.code : /^[a-z][a-z0-9_]*$/.test(message) ? message : "agent_refused";
		const last = lastExchange ? ` (last request: ${lastExchange.method} ${lastExchange.url} -> ${lastExchange.status ?? lastExchange.error ?? "no answer"})` : "";
		return { status: 200, body: { ok: false, poppy_error: code, status: 0, detail: `${message}${last}` } };
	}
}

const control = http.createServer(async (req, res) => {
	try {
		const path = (req.url ?? "/").split("?")[0];
		if (req.method === "GET" && path === "/manifest") return json(res, 200, manifest);
		if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
		if (!authorized(req)) return json(res, 401, { error: "unauthorized", detail: "Bearer INTEROP_SECRET required" });
		if (req.method === "POST" && path === "/reset") {
			await serialized(async () => {
				world = newWorld();
				exchanges = [];
			});
			return json(res, 200, { ok: true, client_id: world.identity.clientId });
		}
		if (req.method === "GET" && path === "/log") return json(res, 200, { exchanges });
		if (req.method === "POST" && path === "/step") {
			const body = await readBody(req);
			const out = await serialized(() => runStep(body));
			return json(res, out.status, out.body);
		}
		json(res, 404, { error: "not_found", detail: path });
	} catch (error: any) {
		json(res, 500, { error: "adapter_error", detail: String(error?.stack ?? error) });
	}
});

const identity = http.createServer((req, res) => {
	void world.identity.handle(req, res);
});

identity.listen(8080, "0.0.0.0", () => console.log(`pi-poppy identity on :8080 as ${ORIGIN}/agent.json`));
control.listen(8081, "0.0.0.0", () => console.log("pi-poppy interop adapter on :8081"));
