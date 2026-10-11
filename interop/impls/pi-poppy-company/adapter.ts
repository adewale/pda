// Interop adapter for pi-poppy's Company (github.com/richardanaya/pi-poppy, src/company.ts,
// `CompanyServer`): the Company its conformance tests run against.
//
// Spec: docs/interop-spec.md, sections 3, 4, 5.1 and 5.3.
// - Port 8080 (behind the proxy, as https://<name>.company.interop.test): CompanyServer's
//   own request dispatcher, on plain HTTP. `start()` would listen on 127.0.0.1 over HTTPS
//   and name itself https://127.0.0.1:<port>; here `baseUrl` is set to the configured
//   origin instead, so the issuer, every endpoint and the DPoP `htu` check use it.
// - Port 8081: the hooks API. Consent and device approval go through the Company's own
//   pages over loopback HTTP (the User's browser); staff, operations and session hooks
//   call CompanyServer's methods and records directly.
//
// Runs under `node --experimental-strip-types`; pi-poppy's src/ has no npm dependencies.
import http from "node:http";

const NAME = process.env.INTEROP_NAME || "pi-poppy";
const DOMAIN = process.env.INTEROP_DOMAIN || `${NAME}.company.interop.test`;
const ORIGIN = (process.env.INTEROP_ORIGIN || `https://${DOMAIN}`).replace(/\/+$/, "");
const SECRET = process.env.INTEROP_SECRET || "";
const COMMIT = process.env.PI_POPPY_COMMIT || process.env.INTEROP_COMMIT || "unknown";
const DIR = process.env.PI_POPPY_DIR || "/opt/pi-poppy";
// Off by default, as CompanyServer's own default; the require_nonce hook (scenario N) or
// PI_POPPY_REQUIRE_NONCE=1 turns on CompanyServer's `requireNonce` option.
const REQUIRE_NONCE = process.env.PI_POPPY_REQUIRE_NONCE === "1";
const DEFER_PERFORM = process.env.PI_POPPY_DEFER_PERFORM === "1";

const { CompanyServer } = await import(`${DIR}/src/company.ts`);

// The users pi-poppy's own tests sign in with (tests/harness.ts). bea needs a one-time
// code in Mediated Sign-In.
const USERS = [
	{ accountId: "acct_ada", email: "ada@example.com", password: "correct-horse" },
	{ accountId: "acct_bea", email: "bea@example.com", password: "battery-staple", unusual: true, otp: "445566" },
];

function newCompany(): any {
	const company = new CompanyServer({
		cert: "",
		key: "",
		// No `ca`: Node's default store plus NODE_EXTRA_CA_CERTS (the interop CA) when it
		// fetches a Personal Agent's client metadata.
		allowLoopback: false,
		domain: new URL(ORIGIN).hostname,
		users: USERS,
		requireNonce: REQUIRE_NONCE,
		deferPerform: DEFER_PERFORM,
	});
	company.baseUrl = ORIGIN;
	return company;
}

let company = newCompany();

const front = http.createServer((req, res) => {
	void company.dispatch(req, res);
});

// ---------------------------------------------------------------------------
// The User's browser, on loopback: the consent and device pages.
// ---------------------------------------------------------------------------
function local(method: string, path: string, form?: URLSearchParams): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const body = form?.toString();
		const req = http.request(
			{
				host: "127.0.0.1",
				port: 8080,
				method,
				path,
				headers: {
					host: new URL(ORIGIN).host,
					"x-forwarded-proto": "https",
					...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) } : {}),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

class HookError extends Error {
	status: number;
	code: string;
	constructor(status: number, code: string, detail: string) {
		super(detail);
		this.status = status;
		this.code = code;
	}
}

function user(account: unknown) {
	const found = USERS.find((item) => item.email === account || item.accountId === account);
	if (!found) throw new HookError(400, "unknown_account", `no fixture account ${String(account)}`);
	return found;
}

async function consentPage(url: string): Promise<{ formToken: string; scopes: string[] }> {
	const target = new URL(url);
	if (target.origin !== ORIGIN) throw new HookError(400, "foreign_url", `${url} is not on ${ORIGIN}`);
	const page = await local("GET", `${target.pathname}${target.search}`);
	if (page.status !== 200) throw new HookError(409, "consent_refused", `consent page answered ${page.status}: ${page.body}`);
	const formToken = /name="form_token" value="([^"]+)"/.exec(page.body)?.[1];
	if (!formToken) throw new HookError(409, "consent_refused", "consent page had no form_token");
	return { formToken, scopes: (target.searchParams.get("scope") ?? "").split(" ").filter(Boolean) };
}

function conversation(id: unknown): any {
	const conv = company.conversations.get(String(id));
	if (!conv) throw new HookError(404, "conversation_not_found", `no conversation ${String(id)}`);
	return conv;
}

type Params = Record<string, any>;

const hooks: Record<string, (params: Params) => Promise<unknown>> = {
	async approve_authorization(params) {
		const account = user(params.account);
		const page = await consentPage(String(params.url));
		const form = new URLSearchParams({ form_token: page.formToken, email: account.email, password: account.password, decision: "approve" });
		for (const scope of Array.isArray(params.scopes) ? params.scopes : page.scopes) form.append("scope", scope);
		const posted = await local("POST", "/oauth/authorize", form);
		const redirect = posted.headers.location;
		if (posted.status !== 302 || !redirect) throw new HookError(409, "consent_refused", `consent answered ${posted.status}: ${posted.body}`);
		return { redirect };
	},

	async deny_authorization(params) {
		const page = await consentPage(String(params.url));
		const posted = await local("POST", "/oauth/authorize", new URLSearchParams({ form_token: page.formToken, decision: "deny" }));
		const redirect = posted.headers.location;
		if (!redirect) throw new HookError(409, "consent_refused", `consent answered ${posted.status}: ${posted.body}`);
		return { redirect };
	},

	async approve_device(params) {
		const account = user(params.account);
		// The Company approves the scopes the agent asked for; `scopes` can't narrow them.
		const posted = await local("POST", "/device", new URLSearchParams({ user_code: String(params.user_code), email: account.email, password: account.password, decision: "approve" }));
		if (posted.status !== 200 || !posted.body.includes("approved")) throw new HookError(409, "device_refused", `device page answered ${posted.status}: ${posted.body}`);
		return {};
	},

	async deny_device(params) {
		const posted = await local("POST", "/device", new URLSearchParams({ user_code: String(params.user_code), decision: "deny" }));
		if (posted.status !== 200) throw new HookError(409, "device_refused", `device page answered ${posted.status}: ${posted.body}`);
		return {};
	},

	async mediated_answers(params) {
		const account = user(params.account);
		return { fields: { email: account.email, password: account.password } };
	},

	async last_one_time_code() {
		const attempts = [...company.mediated.values()];
		const last = attempts.at(-1);
		if (!last) throw new HookError(404, "no_code", "no one-time code has been sent");
		return { code: last.otp };
	},

	async end_sessions() {
		let ended = 0;
		for (const session of company.sessions.values()) {
			if (!session.ended) {
				session.ended = true;
				ended += 1;
			}
		}
		return { ended };
	},

	async staff_join(params) {
		const conv = conversation(params.conversation);
		company.joinHuman(conv.id);
		if (typeof params.text === "string" && params.text) company.addCompanyMessage(conv, "human", params.text);
		return {};
	},

	async staff_reply(params) {
		const conv = conversation(params.conversation);
		company.addCompanyMessage(conv, "human", String(params.text ?? ""));
		return {};
	},

	async propose_operation(params) {
		const conv = conversation(params.conversation);
		// The Company's agent proposes an exchange when asked for one (fixture.prompts.operation);
		// return that proposal if it is still open.
		const already = [...conv.events]
			.reverse()
			.map((event: any) => event.message?.operation)
			.find((operation: any) => operation && company.operations.get(operation.operation_id)?.operation.state === "proposed");
		if (already) return { operation: already.operation_id };
		// The proposal the Company's own auto-reply makes for "exchange", in that conversation.
		const sessions = [...company.sessions.values()].filter((s: any) => !s.ended && s.clientId === conv.clientId && s.userId === conv.userId);
		const session = sessions.reverse().find((s: any) => conv.accountId ? s.accountId === conv.accountId : true) ?? sessions[0];
		if (!session) throw new HookError(409, "no_session", "no live Session for this conversation's agent and user");
		const effective = session.accountId ? { signedIn: true, scope: "poppy:read poppy:write", accountId: session.accountId } : { signedIn: false, scope: "" };
		const operation = company.propose({
			auth: { session, token: { typ: "dpop" }, effective, access: "" },
			summary: "Exchange the Stormline Jacket (M) on order ord_7Hk2 for the insulated jacket, for $70.00 more.",
			terms: { action: "exchange", order_id: "ord_7Hk2", price_difference: { amount: "70.00", currency: "USD" } },
		});
		company.addCompanyMessage(conv, "agent", "I can exchange it. Confirm whenever you're ready.", operation);
		if (session.accountId) conv.accountId = session.accountId;
		company.setStatus(conv, "idle", conv.responder);
		return { operation: operation.operation_id };
	},

	async settle_operation(params) {
		const outcome = params.outcome === "unknown" ? { unknown: true } : { ok: params.outcome !== "failed" };
		const operation = company.finishOperation(String(params.operation), outcome);
		return { state: operation.state };
	},

	async require_nonce() {
		// CompanyServer's own option: every DPoP proof (token endpoint and resources) must
		// carry its current nonce, or it answers use_dpop_nonce with a DPoP-Nonce header.
		company.options.requireNonce = true;
		return {};
	},

	// CompanyServer has no way to expire Session Tokens it has issued (they are sealed
	// with their own `exp`), and its rate limiter is a sliding window over every request,
	// not "the next n requests". Rather than fake either in the adapter, both answer 501.

	async fixture() {
		// CompanyServer's OpenAPI document has one operation, createExchange, which needs a
		// signed-in Session with poppy:write. There is no read-only or signed-out operation,
		// so `openapi` and `openapi_public` are absent and AO, N, R and RL aren't claimed.
		return {
			accounts: USERS.map((item) => item.email),
			scopes: ["poppy:read", "poppy:write"],
			openapi_write: { api: "openapi", operation: "createExchange", args: { params: { order_id: "ord_7Hk2" }, body: { item: "insulated" } } },
			mcp: { api: "mcp", tool: "search_products", args: { query: "jacket" } },
			prompts: {
				hello: "Hello",
				sign_in: "Where is my order?",
				operation: "I'd like to exchange the jacket on my order",
			},
			otp_account: "bea@example.com",
		};
	},
};

const manifest = {
	interop: 1,
	name: NAME,
	role: "company",
	commit: COMMIT,
	poppy: ["0.1"],
	extensions: ["operations"],
	scenarios: ["D", "S0", "SD", "SV", "SVN", "SM", "SMC", "SX", "SXV", "SO", "SE", "C", "CI", "CS", "CA", "AM", "AS", "O", "OX"],
	readings: { S1: "endpoint", S2: "any", S3: "either", S4: "either", S23: "per-company" },
	relaxations: [
		"PI_POPPY_INTEROP_PRIVATE_SUFFIX=.interop.test (patches/0001): client_id and jwks_uri under .interop.test may resolve to private addresses; unset by default, loopback still refused",
		"CompanyServer's request handler is served on plain HTTP behind the proxy with baseUrl set to the interop origin, instead of its own 127.0.0.1 HTTPS listener",
		"The interop CA is trusted through NODE_EXTRA_CA_CERTS (CompanyServer's `ca` option is left unset)",
	],
	settings: { requireNonce: REQUIRE_NONCE, deferPerform: DEFER_PERFORM },
	notes: [
		"No read-only or signed-out OpenAPI operation exists in CompanyServer, so the fixture has no openapi or openapi_public, and AO, N, R and RL are not claimed.",
		"expire_tokens and rate_limit answer 501: CompanyServer can't expire issued tokens, and its limiter is a sliding window, not 'the next n requests'.",
		"Nonces are off until require_nonce (or PI_POPPY_REQUIRE_NONCE=1).",
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
	return text ? JSON.parse(text) : {};
}

const control = http.createServer(async (req, res) => {
	try {
		const path = (req.url ?? "/").split("?")[0];
		if (req.method === "GET" && path === "/manifest") return json(res, 200, manifest);
		if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
		if (SECRET && req.headers.authorization !== `Bearer ${SECRET}`) return json(res, 401, { error: "unauthorized", detail: "Bearer INTEROP_SECRET required" });
		if (req.method === "POST" && path === "/reset") {
			company = newCompany();
			return json(res, 200, { ok: true });
		}
		if (req.method === "GET" && path === "/hooks") return json(res, 200, { hooks: Object.keys(hooks) });
		const match = /^\/hooks\/([a-z_]+)$/.exec(path);
		if (req.method === "POST" && match) {
			const hook = hooks[match[1]!];
			if (!hook) return json(res, 501, { error: "unsupported", detail: `hook ${match[1]} is not supported` });
			const body = await readBody(req);
			const params = body && typeof body.params === "object" && body.params !== null ? body.params : body;
			try {
				// A hook answers its result object as is (spec 5.3; the runner saves the body).
				return json(res, 200, await hook(params));
			} catch (error: any) {
				if (error instanceof HookError) return json(res, error.status, { error: error.code, detail: error.message });
				return json(res, 500, { error: "adapter_error", detail: String(error?.stack ?? error) });
			}
		}
		json(res, 404, { error: "not_found", detail: path });
	} catch (error: any) {
		json(res, 500, { error: "adapter_error", detail: String(error?.stack ?? error) });
	}
});

front.listen(8080, "0.0.0.0", () => console.log(`pi-poppy Company on :8080 as ${ORIGIN}`));
control.listen(8081, "0.0.0.0", () => console.log("pi-poppy Company hooks on :8081"));
