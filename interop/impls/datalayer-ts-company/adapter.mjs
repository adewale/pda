// Interop adapter (docs/interop-spec.md 5.3) for Datalayer's TypeScript Company: the
// Manzanita reference Company, served by the SDK's own node:http listener.
//
// Port 8080: the Company, at INTEROP_ORIGIN (https://<name>.company.interop.test behind
// the proxy). Every URL it publishes and every DPoP htu it checks is built from that
// origin (CompanyConfig.base), never from the inner request.
// Port 8081: the hooks API. Hooks call the CompanyService in this process directly.
import { createServer } from "node:http";

import {
  CompanyAccounts,
  CompanyAgents,
  CompanyApis,
  CompanyConfig,
  CompanyStores,
  MemoryCompanyStore,
  OperationExecutors,
  RecordKinds,
  buildCompany,
  companyRequestListener,
} from "../lib/server.js";
import {
  ADA,
  ADA_CODE,
  CONFIG_OPTIONS,
  ManzanitaAccounts,
  ManzanitaAgent,
  ManzanitaApi,
  ManzanitaPlugin,
} from "../lib/demo/manzanita.js";

const UPSTREAM_COMMIT = "12d71877d477b93f3ee68ebdc542560ba85997b9";
const NAME = process.env.INTEROP_NAME || "datalayer-ts";
const ORIGIN = (process.env.INTEROP_ORIGIN || `https://${NAME}.company.interop.test`).replace(/\/$/, "");
const DOMAIN = new URL(ORIGIN).hostname;
const SECRET = process.env.INTEROP_SECRET || "";
const ACCOUNT = "acct_ada";
// Interop-only, off unless set: the scenarios ask for Poppy's poppy:read and poppy:write,
// which Manzanita doesn't define. With this on, Manzanita also offers them, as synonyms
// for orders:read and orders:write.
const POPPY_SCOPES = process.env.INTEROP_POPPY_SCOPES === "1";
const SYNONYMS = { "poppy:read": "orders:read", "poppy:write": "orders:write" };

const MANIFEST = {
  interop: 1,
  name: NAME,
  role: "company",
  commit: UPSTREAM_COMMIT,
  poppy: ["0.1"],
  extensions: ["operations"],
  scenarios: ["D", "S0", "SD", "SV", "SXV", "SMC", "SX", "SE", "SO", "R", "C", "CI", "CS", "CA", "AO", "AS", "O", "OX"],
  readings: { S1: "token-endpoint", S3: "insertion", S4: "omit" },
  relaxations: [
    `organization.domain and auth.issuer set to ${DOMAIN} (Manzanita's config.domain; upstream default manzanita.example)`,
    ...(POPPY_SCOPES
      ? ["INTEROP_POPPY_SCOPES=1: Manzanita also offers poppy:read and poppy:write, as synonyms for orders:read and orders:write (adapter wrappers around its agent and API; no patch)"]
      : []),
  ],
};

/** The memory store, remembering which Sessions exist so `end_sessions` can end them. */
class TrackingStore {
  constructor() {
    this.inner = new MemoryCompanyStore();
    this.keys = { [RecordKinds.session]: new Set(), [RecordKinds.sessionToken]: new Set() };
  }
  #track(kind, key) { this.keys[kind]?.add(key); }
  get(kind, key) { return this.inner.get(kind, key); }
  async put(kind, key, value, options) { this.#track(kind, key); return this.inner.put(kind, key, value, options); }
  async create(kind, key, value, options) {
    const created = await this.inner.create(kind, key, value, options);
    if (created) this.#track(kind, key);
    return created;
  }
  replace(kind, key, version, value, options) { return this.inner.replace(kind, key, version, value, options); }
  take(kind, key) { return this.inner.take(kind, key); }
  delete(kind, key) { return this.inner.delete(kind, key); }
}

let company;

const widen = (scopes) => [...new Set([...scopes, ...scopes.map((scope) => SYNONYMS[scope]).filter(Boolean)])];

/** Manzanita's agent, seeing poppy:* scopes as the orders:* ones they stand for. */
class SynonymAgent {
  constructor(inner) { this.inner = inner; }
  respond(turn) { return this.inner.respond({ ...turn, scopes: widen(turn.scopes ?? []) }); }
}

/** Manzanita's API, the same way. */
class SynonymApi {
  constructor(inner) { this.inner = inner; this.description = inner.description; }
  openapi() { return this.inner.openapi(); }
  handle(call) { return this.inner.handle({ ...call, scopes: widen(call.scopes ?? []) }); }
}

/** Manzanita, assembled as `manzanita()` does, with its store given and its scopes optionally widened. */
function build() {
  const store = new TrackingStore();
  const plugin = new ManzanitaPlugin();
  const agent = new ManzanitaAgent();
  const api = new ManzanitaApi();
  const contributes = [
    { point: CompanyAccounts, value: new ManzanitaAccounts(), options: { id: "accounts" } },
    { point: CompanyAgents, value: POPPY_SCOPES ? new SynonymAgent(agent) : agent, options: { id: "agent" } },
    { point: OperationExecutors, value: plugin.executor, options: { id: "exchange" } },
    { point: OperationExecutors, value: plugin.giftWrap, options: { id: "gift-wrap" } },
    { point: OperationExecutors, value: plugin.returns, options: { id: "returns" } },
    { point: OperationExecutors, value: plugin.repairs, options: { id: "repairs" } },
    { point: CompanyApis, value: POPPY_SCOPES ? new SynonymApi(api) : api, options: { id: "api" } },
    { point: CompanyStores, value: store, options: { id: "given-store", order: 0 } },
  ];
  const options = { ...CONFIG_OPTIONS, domain: DOMAIN };
  if (POPPY_SCOPES) {
    options.scopes = [...CONFIG_OPTIONS.scopes, "poppy:read", "poppy:write"];
    // The service confirms operations only for a Session holding every write scope, so
    // with synonyms on, the write scope is poppy:write (orders:write alone no longer confirms).
    options.writeScopes = ["poppy:write"];
  }
  const service = buildCompany(new CompanyConfig(options), {
    plugins: [{ name: "manzanita-interop", version: "1", contributes }],
  });
  company = { service, plugin, store, listener: companyRequestListener(service, { onError: (e) => console.error("[company]", e) }) };
}

class HookError extends Error {
  constructor(status, code, detail) {
    super(detail ?? code);
    this.status = status;
    this.code = code;
  }
}

/** Open the consent page for the agent's authorization URL, as the user's browser would. */
async function requestIdFor(url) {
  if (typeof url !== "string" || new URL(url).hostname !== DOMAIN) {
    throw new HookError(400, "bad_request", `url must be an authorization URL at ${DOMAIN}`);
  }
  const answer = await company.service.handle({ method: "GET", url, headers: {} });
  if (answer.status === 303) return { redirect: answer.headers.Location };
  const page = typeof answer.body === "string" ? answer.body : "";
  const marker = 'name="request_id" value="';
  if (answer.status !== 200 || !page.includes(marker)) {
    throw new HookError(422, "consent_page_refused", `${answer.status}: ${page.replace(/<[^>]+>/g, " ").trim()}`);
  }
  return { requestId: page.split(marker, 2)[1].split('"', 1)[0] };
}

const hooks = {
  async approve_authorization(params) {
    const found = await requestIdFor(params.url);
    if (found.redirect) return { redirect: found.redirect };
    const redirect = await company.service.approveAuthorization(found.requestId, {
      accountId: params.account ?? ACCOUNT,
      ...(params.scopes ? { scopes: params.scopes } : {}),
    });
    return { redirect };
  },
  async deny_authorization(params) {
    const found = await requestIdFor(params.url);
    if (found.redirect) return { redirect: found.redirect };
    return { redirect: await company.service.denyAuthorization(found.requestId) };
  },
  async approve_device(params) {
    const granted = await company.service.approveDevice(params.user_code, {
      accountId: params.account ?? ACCOUNT,
      ...(params.scopes ? { scopes: params.scopes } : {}),
    });
    return { granted };
  },
  async deny_device(params) {
    await company.service.denyDevice(params.user_code);
    return {};
  },
  async mediated_answers(params) {
    if ((params.account ?? ACCOUNT) !== ACCOUNT) throw new HookError(404, "unknown_account", "Manzanita has one account");
    return { fields: { email: ADA.email, password: ADA.password } };
  },
  async last_one_time_code() {
    // Manzanita's one-time code is fixed.
    return { code: ADA_CODE };
  },
  async end_sessions() {
    const { store } = company;
    const sessions = [...store.keys[RecordKinds.session]];
    for (const key of store.keys[RecordKinds.sessionToken]) await store.delete(RecordKinds.sessionToken, key);
    for (const key of sessions) await store.delete(RecordKinds.session, key);
    store.keys[RecordKinds.session].clear();
    store.keys[RecordKinds.sessionToken].clear();
    return { ended: sessions.length };
  },
  async settle_operation(params) {
    const succeeded = params.outcome === "succeeded";
    const operation = await company.service.settle(
      params.operation,
      { summary: `Settled by the interop runner as ${params.outcome}.` },
      { succeeded },
    );
    return { state: operation.state };
  },
  async fixture() {
    const read = POPPY_SCOPES ? "poppy:read" : "orders:read";
    return {
      accounts: [ACCOUNT],
      scopes: POPPY_SCOPES ? ["poppy:read", "poppy:write", ...CONFIG_OPTIONS.scopes] : [...CONFIG_OPTIONS.scopes],
      openapi: { api: "openapi", operation: "GET /api/orders", args: {} },
      openapi_write: { api: "openapi", operation: "POST /api/orders/{order_id}/exchanges", args: { params: { order_id: "ord_7Hk2" }, body: {} } },
      prompts: {
        hello: "Hello",
        sign_in: "Where is my jacket order?",
        operation: "I'd like to exchange it for a warmer one",
      },
      otp_account: ACCOUNT,
      read_scope: read,
    };
  },
  async propose_operation(params) {
    // Manzanita's agent proposes the exchange when a signed-in user asks for it
    // (fixture prompts.operation); this returns the proposal it made in the conversation.
    const record = await company.store.get(RecordKinds.conversation, String(params.conversation ?? ""));
    if (!record) throw new HookError(404, "unknown_conversation", "no such conversation");
    const operations = record.value.events
      .map((event) => event.payload?.message?.operation?.operation_id)
      .filter(Boolean);
    for (const id of operations.reverse()) {
      const stored = await company.service.operationRecord(id).catch(() => undefined);
      if (stored?.operation.state === "proposed") return { operation: id };
    }
    throw new HookError(409, "no_operation", "Nothing proposed: send fixture.prompts.operation in a signed-in conversation first");
  },
  async expire_tokens() {
    // Every Session Token issued so far now carries an expiry in the past.
    const { store } = company;
    const past = new Date(Date.now() - 1000).toISOString();
    let expired = 0;
    for (const key of store.keys[RecordKinds.session]) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const entry = await store.get(RecordKinds.session, key);
        if (!entry) break;
        const tokens = Object.fromEntries(
          Object.entries(entry.value.tokens).map(([digest, token]) => [digest, { ...token, expiresAt: past }]),
        );
        if (await store.replace(RecordKinds.session, key, entry.version, { ...entry.value, tokens })) {
          expired += Object.keys(tokens).length;
          break;
        }
      }
    }
    return { expired };
  },
};

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const control = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://control").pathname;
  try {
    if (request.method === "GET" && path === "/manifest") return send(response, 200, MANIFEST);
    if (request.method === "GET" && path === "/healthz") return send(response, 200, { ok: true });
    if (SECRET === "" || request.headers.authorization !== `Bearer ${SECRET}`) {
      return send(response, 401, { error: "unauthorized", detail: "Bearer INTEROP_SECRET required" });
    }
    if (request.method === "POST" && path === "/reset") {
      build();
      return send(response, 200, { ok: true, result: {} });
    }
    if (request.method === "GET" && path === "/hooks") return send(response, 200, { interop: 1, hooks: Object.keys(hooks) });
    if (request.method === "POST" && path.startsWith("/hooks/")) {
      const hook = hooks[path.slice("/hooks/".length)];
      if (!hook) return send(response, 501, { error: "unsupported", detail: path });
      const body = await readJson(request);
      const params = body && typeof body.params === "object" && body.params !== null ? body.params : body;
      return send(response, 200, await hook(params ?? {}));
    }
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    console.error(`[adapter] ${path}:`, error?.message ?? error);
    if (error instanceof HookError) return send(response, error.status, { error: error.code, detail: error.message });
    return send(response, 422, { error: "hook_failed", detail: String(error?.message ?? error) });
  }
});

build();
createServer((request, response) => company.listener(request, response)).listen(8080, "0.0.0.0");
control.listen(8081, "0.0.0.0", () => console.log(`[adapter] ${NAME} Company at ${ORIGIN}; hooks on 8081`));
