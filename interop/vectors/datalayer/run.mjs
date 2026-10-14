#!/usr/bin/env node
/**
 * Run Datalayer's shared Poppy conformance cases against this repo's
 * Personal Agent code: src/validator (discovery documents, fetching, strict
 * JSON) and src/poppy (the client), under Node.
 *
 *   node interop/vectors/datalayer/run.mjs [--cases <dir>] [--json <file>] [--verbose]
 *
 * The cases are fetched at a pinned commit of datalayer/personal-agent-protocol
 * (BSD-3-Clause) into node_modules/.cache, not vendored. `--cases` reads them
 * from a local clone's protocol/fixtures/conformance instead.
 *
 * Each case is pass, fail (with a category: our-bug, reading, harness) or n/a
 * (with why). Exit status: 0 if nothing failed as our-bug, 1 otherwise.
 * See README.md for how each Datalayer `check` maps onto our code.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

export const COMMIT = "00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65";
const SUITES = ["protocol", "security", "lifecycle", "conversations", "operations"];
// The number of cases at COMMIT.
const EXPECTED_CASES = 124;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// ------------------------------------------------------------ Loading our TypeScript under Node
// src/ is written for workerd and Vite: extensionless relative imports, TypeScript
// parameter properties, `cloudflare:workers`. Transpile with the repo's own
// TypeScript (a devDependency) and resolve the way Vite does. Nothing in src/ changes.
const require = createRequire(join(ROOT, "package.json"));
let ts;
try {
  ts = require("typescript");
} catch {
  process.stderr.write("Run `npm ci` first: this script uses the repo's TypeScript and jose.\n");
  process.exit(2);
}
const WORKERS_STUB =
  "data:text/javascript," +
  encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: WORKERS_STUB, shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (error) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts") && !url.includes("/node_modules/")) {
      const fileName = fileURLToPath(url);
      const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
        fileName,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          useDefineForClassFields: true,
          verbatimModuleSyntax: false
        }
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return next(url, context);
  }
});
const src = (path) => import(pathToFileURL(join(ROOT, "src", path)).href);

// ------------------------------------------------------------ Cases
async function loadCases(dir) {
  const cache = dir ?? join(ROOT, "node_modules/.cache/datalayer-conformance", COMMIT);
  mkdirSync(cache, { recursive: true });
  const cases = [];
  for (const suite of SUITES) {
    const file = join(cache, `${suite}.json`);
    if (!existsSync(file)) {
      if (dir) throw new Error(`${file} is missing`);
      const url = `https://raw.githubusercontent.com/datalayer/personal-agent-protocol/${COMMIT}/protocol/fixtures/conformance/${suite}.json`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      writeFileSync(file, await response.text());
    }
    for (const item of JSON.parse(readFileSync(file, "utf8")).cases) cases.push({ ...item, suite });
  }
  if (cases.length !== EXPECTED_CASES) process.stderr.write(`warning: ${cases.length} cases, expected ${EXPECTED_CASES}\n`);
  return cases;
}

// ------------------------------------------------------------ Outcomes
class Fail extends Error {
  constructor(category, reason) {
    super(reason);
    this.category = category;
  }
}
const ourBug = (reason) => new Fail("our-bug", reason);
const reading = (reason) => new Fail("reading", reason);
const harness = (reason) => new Fail("harness", reason);
class NotApplicable extends Error {}
const notApplicable = (reason) => new NotApplicable(reason);

function check(condition, failure) {
  if (!condition) throw failure;
}

// ------------------------------------------------------------ A network of fixed responses
/**
 * Datalayer's mockNetwork, as a Fetcher (Request in, Response out). Unlike theirs it
 * honours the request's AbortSignal while streaming a body, as real fetch does: our
 * code relies on fetch's signal for its total time limit.
 */
function fixedNetwork(responses, log = []) {
  return async (request) => {
    const url = request.url;
    log.push({ method: request.method, url, headers: Object.fromEntries(request.headers) , request });
    const answer = typeof responses === "function" ? await responses(request) : responses[url];
    if (answer instanceof Response) return answer;
    if (answer === undefined) {
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    const headers = new Headers(answer.headers ?? {});
    let body = null;
    if ("json" in answer) {
      body = JSON.stringify(answer.json) + " ".repeat(answer.padding_bytes ?? 0);
      if (!headers.has("content-type")) headers.set("content-type", answer.content_type ?? "application/json");
    } else if ("text" in answer) {
      body = String(answer.text);
      if (!headers.has("content-type")) headers.set("content-type", answer.content_type ?? "text/plain");
    }
    if ([301, 302, 303, 307, 308].includes(answer.status)) return new Response(null, { status: answer.status, headers });
    if (answer.trickle && body !== null) {
      const bytes = new TextEncoder().encode(body);
      const { chunk_bytes: size, interval_seconds: interval } = answer.trickle;
      const signal = request.signal;
      let offset = 0;
      const stream = new ReadableStream({
        async pull(controller) {
          await new Promise((done) => setTimeout(done, interval * 1000));
          if (signal?.aborted) {
            controller.error(signal.reason);
            return;
          }
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + size));
          offset += size;
        }
      });
      return new Response(stream, { status: answer.status, headers });
    }
    return new Response(body, { status: answer.status, headers });
  };
}

/** OAuth metadata our validator accepts for a signed-out Company: added where a case gives only poppy.json. */
function metadataFor(issuer, domains) {
  return {
    issuer,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    poppy_domains: domains,
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["ES256"],
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
    dpop_signing_alg_values_supported: ["ES256"]
  };
}

/** Serve a poppy.json at its organization's domain, plus synthesized metadata for its issuer. */
function companyResponses(doc) {
  const domain = doc.organization.domain;
  const responses = {
    [`https://${domain}/.well-known/poppy.json`]: { status: 200, json: doc, headers: { "cache-control": "max-age=300" } }
  };
  if (doc.auth?.issuer) {
    const issuer = doc.auth.issuer;
    const url = new URL(issuer);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    responses[`${url.origin}/.well-known/oauth-authorization-server${path}`] = {
      status: 200,
      json: metadataFor(issuer, [domain]),
      headers: { "cache-control": "max-age=300" }
    };
  }
  return responses;
}

// Two separate things a report says (docs/conformance-levels.md): a message's severity is the
// validator's verdict on the draft; `refuses` (and the report's `refused`) is whether our
// client won't use the document. A case about what an agent does is judged by the second.
const errorIds = (report) => report.messages.filter((m) => m.severity === "error").map((m) => m.id);
const refusingIds = (report) => report.messages.filter((m) => m.refuses).map((m) => m.id);
const listed = (messages, none) => messages.map((m) => `${m.id}${m.at ? ` at ${m.at}` : ""}`).join(", ") || none;
const describe = (report) => listed(report.messages.filter((m) => m.severity === "error"), "no errors");
const describeRefusals = (report) => listed(report.messages.filter((m) => m.refuses), "nothing our client refuses");

// ------------------------------------------------------------ A whole client, in memory
/** Cloudflare's SqlStorage over node:sqlite: just what src/poppy uses (exec → toArray). */
class NodeSql {
  #db = new DatabaseSync(":memory:");
  exec(query, ...bindings) {
    const statement = this.#db.prepare(query);
    const values = bindings.map((value) => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value));
    const rows = statement.all(...values).map((row) => ({ ...row }));
    return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  }
}

const SHOP = "shop.example";
const SHOP_ISSUER = `https://${SHOP}`;
const SHOP_DOC = {
  protocol_version: "0.1",
  organization: { name: "Shop", domain: SHOP },
  auth: { issuer: SHOP_ISSUER },
  agent: { protocols: [{ type: "poppy", endpoint: `${SHOP_ISSUER}/poppy/conversations` }] },
  apis: [{ type: "openapi", url: `${SHOP_ISSUER}/openapi.json`, description: "Orders" }],
  extensions: { operations: { version: "1", endpoint: `${SHOP_ISSUER}/poppy/operations` } }
};
const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Orders", version: "1" },
  servers: [{ url: `${SHOP_ISSUER}/api` }],
  paths: { "/orders": { get: { operationId: "listOrders", summary: "List orders" } } }
};
const TOKEN = { access_token: "sat_vectors", token_type: "DPoP", expires_in: 300, session_id: "ses_vectors", signed_in: false };

/**
 * A PoppyClient with an in-memory host and a fake Company at shop.example whose
 * routes the case overrides. The token endpoint issues a token without checking
 * anything: these cases test the client's handling of answers, not the Company.
 */
async function clientWith(routes = {}) {
  const [{ PoppyClient }, { migrate }, { CompanyLimiter }, jose] = await Promise.all([
    src("poppy/client.ts"),
    src("poppy/store.ts"),
    src("poppy/limiter.ts"),
    import(pathToFileURL(require.resolve("jose")).href)
  ]);
  const { privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await jose.exportJWK(privateKey)), kid: "vectors-1" };
  const limiters = new Map();
  const env = {
    PUBLIC_ORIGIN: "https://agent.vectors.example",
    POPPY_CLIENT_NAME: "pda vectors",
    POPPY_LOGO_URI: "https://agent.vectors.example/logo.png",
    POPPY_SIGNING_JWKS: JSON.stringify([jwk]),
    TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
    CompanyLimiter: {
      getByName(name) {
        if (!limiters.has(name)) {
          const store = new Map();
          const ctx = { storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v) } };
          limiters.set(name, new CompanyLimiter(ctx, env));
        }
        return limiters.get(name);
      }
    }
  };
  const sql = new NodeSql();
  migrate(sql);
  const log = [];
  const base = {
    ...companyResponses(SHOP_DOC),
    [`${SHOP_ISSUER}/openapi.json`]: { status: 200, json: OPENAPI, headers: { "cache-control": "max-age=300" } },
    [`${SHOP_ISSUER}/oauth/token`]: { status: 200, json: TOKEN }
  };
  const network = fixedNetwork((request) => {
    const plain = request.url.split("?")[0];
    const route = routes[plain] ?? routes[request.url];
    if (typeof route === "function") return route(request);
    return route ?? base[plain];
  }, log);
  const cards = [];
  const notes = [];
  const client = new PoppyClient({
    env,
    sql,
    fetcher: network,
    showCard: async (card) => void cards.push(card),
    notifyModel: async (text) => void notes.push(text),
    schedule: async () => {},
    hasJob: () => false,
    pushDirect: () => {},
    userContext: () => ({ user_available: true }),
    sleep: async () => {},
    now: Date.now
  });
  const company = await client.company(SHOP);
  return { client, company, sql, log, cards, notes };
}

const hits = (log, url) => log.filter((entry) => entry.url.split("?")[0] === url).length;

// ------------------------------------------------------------ The checks
/** Datalayer error codes for discovery, and the validator messages that mean the same. */
const DISCOVERY_ERRORS = {
  domain_not_authorized: ["metadata-domain-missing"],
  issuer_mismatch: ["metadata-issuer-mismatch"],
  organization_domain_mismatch: ["organization-domain-mismatch"],
  unsafe_url: ["http-redirect-not-https", "http-not-https"],
  too_many_redirects: ["http-too-many-redirects"],
  response_too_large: ["http-too-large"],
  metadata_timeout: ["http-failed"],
  invalid_content_type: ["http-content-type"]
};

const CHECKS = {
  async discovery_document(input, expect) {
    const { validateText } = await src("validator/index.ts");
    const report = validateText("poppy", JSON.stringify(input), { domain: input.organization?.domain });
    // Datalayer's `valid` is whether its agent parses and uses the document: our client's
    // refusal, not the validator's severity, is the comparable answer.
    if (!expect.valid) {
      check(report.refused, ourBug(`our client would use it (validator: ${report.outcome}, ${describe(report)}); expected a refusal`));
      return `refused: ${describeRefusals(report)}`;
    }
    check(!report.refused, reading(`our client refuses it: ${describeRefusals(report)}`));
    const notes = [];
    if (report.outcome !== "valid") {
      notes.push(`used by our client; the validator calls it ${report.outcome} (${describe(report)}), a verdict on the draft`);
    }
    if (expect.extra) {
      // We ignore unknown fields (3.3) rather than carrying them: accepted is what we can check.
      notes.push(`unknown ${Object.keys(expect.extra).join(", ")} accepted (ignored, not preserved)`);
    }
    if ("known_api_types" in expect || "conversation_endpoint" in expect) {
      const { discover } = await src("poppy/discovery.ts");
      const { result } = await discover(fixedNetwork(companyResponses(input)), input.organization.domain);
      if ("known_api_types" in expect) {
        const types = (result.apis ?? []).map((api) => api.type);
        check(JSON.stringify(types) === JSON.stringify(expect.known_api_types), ourBug(`kept APIs ${JSON.stringify(types)}`));
        notes.push(`kept APIs ${JSON.stringify(types)}`);
      }
      if ("conversation_endpoint" in expect) {
        const endpoint = result.conversations?.endpoint;
        check(endpoint === expect.conversation_endpoint, ourBug(`conversation endpoint ${endpoint}`));
        notes.push(`conversation endpoint ${endpoint}`);
      }
    }
    return notes.join("; ") || "valid";
  },

  async extension_negotiation(input, expect) {
    const { SUPPORTED_EXTENSIONS, discover } = await src("poppy/discovery.ts");
    const agent = Object.fromEntries(Object.entries(input.agent).map(([name, entry]) => [name, entry.version]));
    if (JSON.stringify(agent) !== JSON.stringify(SUPPORTED_EXTENSIONS)) {
      throw notApplicable(`the case's agent supports ${JSON.stringify(agent)}; ours is fixed at ${JSON.stringify(SUPPORTED_EXTENSIONS)}`);
    }
    const doc = { protocol_version: "0.1", organization: { name: "E", domain: "example.com" }, auth: { issuer: "https://example.com" }, web: {}, extensions: input.company };
    const { result } = await discover(fixedNetwork(companyResponses(doc)), "example.com");
    const negotiated = Object.fromEntries(Object.keys(result.extensions).map((name) => [name, SUPPORTED_EXTENSIONS[name]]));
    check(JSON.stringify(negotiated) === JSON.stringify(expect.negotiated), ourBug(`negotiated ${JSON.stringify(negotiated)}`));
    return `negotiated ${JSON.stringify(negotiated)}`;
  },

  async extension_names(input, expect) {
    const { validateText } = await src("validator/index.ts");
    const kinds = { plain: [], third_party: [], invalid: [] };
    for (const [name, entry] of Object.entries(input)) {
      const doc = { protocol_version: "0.1", organization: { name: "E", domain: "example.com" }, web: {}, extensions: { [name]: entry } };
      const report = validateText("poppy", JSON.stringify(doc), { domain: "example.com" });
      if (errorIds(report).includes("extension-name")) kinds.invalid.push(name);
      else if (name.includes("/")) kinds.third_party.push(name);
      else kinds.plain.push(name);
    }
    for (const list of Object.values(kinds)) list.sort();
    const want = { plain: [...expect.plain].sort(), third_party: [...expect.third_party].sort(), invalid: [...expect.invalid].sort() };
    const got = JSON.stringify(kinds);
    if (got !== JSON.stringify(want)) {
      const differs = Object.keys(want).filter((k) => JSON.stringify(kinds[k]) !== JSON.stringify(want[k]));
      throw reading(
        `ours ${got}, Datalayer's ${JSON.stringify(want)} (differs in ${differs.join(", ")}). ` +
          `Our validator flags a plain name the protocol doesn't define (extension-plain-unknown) as a warning, ` +
          `whatever its characters; the draft defines no syntax for plain names (3.3).`
      );
    }
    return got;
  },

  async extension_required(input, expect) {
    const { callOpenApi } = await src("poppy/apis.ts");
    const { client, company } = await clientWith({
      [`${SHOP_ISSUER}/api/orders`]: { status: input.status, json: input.body }
    });
    try {
      await callOpenApi(client, company, "main", { operation: "listOrders", callKey: "k1" });
    } catch (error) {
      check(error.code === "extension_required", ourBug(`threw ${error.code}: ${error.message}`));
      check(error.detail?.extension === expect.extension, ourBug(`error.detail.extension is ${error.detail?.extension}, not ${expect.extension}`));
      check(error.message.includes(expect.extension), ourBug(`error doesn't name ${expect.extension}: ${error.message}`));
      return `PoppyError extension_required, detail.extension ${JSON.stringify(error.detail.extension)}`;
    }
    throw ourBug("the API call succeeded");
  },

  async conversation_page(input, expect) {
    const { readConversation, recentMessages } = await src("poppy/conversations.ts");
    const id = input.conversation_id;
    const { client, sql, log } = await clientWith({
      [`${SHOP_ISSUER}/poppy/conversations/${id}/events`]: { status: 200, json: input }
    });
    sql.exec(
      `INSERT INTO poppy_conversations (id, issuer, label, parent, direct, status, responder, cursor, context, last_event_at, created_at)
       VALUES (?, ?, 'main', NULL, 0, 'working', 'agent', NULL, NULL, ?, ?)`,
      id, SHOP_ISSUER, Date.now(), Date.now()
    );
    await readConversation(client, id, 0);
    check(hits(log, `${SHOP_ISSUER}/poppy/conversations/${id}/events`) === 1, harness("the events endpoint wasn't read once"));
    const messages = recentMessages(client, id);
    const texts = JSON.stringify(messages);
    const known = expect.known_types.includes("message");
    check(!known || texts.includes("Hi."), ourBug(`the message event wasn't kept: ${texts}`));
    const cursor = sql.exec("SELECT cursor, status FROM poppy_conversations WHERE id = ?", id).toArray()[0];
    check(cursor.cursor === input.cursor, ourBug(`cursor saved as ${cursor.cursor}`));
    return `unknown ${expect.unknown_types.join(", ")} skipped; message kept; cursor ${cursor.cursor}, status ${cursor.status} (unknown top-level "region" ignored, not preserved)`;
  },

  async message_context(input) {
    // Our agent never parses a received context: it sends its own. The User's locale and time
    // zone come from the page as a poppy.context frame and are filtered by two regular
    // expressions inline in src/poppy/capability.ts before they can reach a message;
    // user_available is a boolean we compute. Apply those exact expressions.
    const source = readFileSync(join(ROOT, "src/poppy/capability.ts"), "utf8");
    const locale = /frame\.locale === "string" && \/(.+?)\/\.test\(frame\.locale\)/.exec(source);
    const zone = /frame\.time_zone === "string" && \/(.+?)\/\.test\(frame\.time_zone\)/.exec(source);
    if (!locale || !zone) throw harness("couldn't find the locale and time_zone filters in src/poppy/capability.ts");
    const LOCALE = new RegExp(locale[1]);
    const ZONE = new RegExp(zone[1]);
    const kept = (context) =>
      Object.entries(context).every(([key, value]) =>
        key === "locale" ? LOCALE.test(value) : key === "time_zone" ? ZONE.test(value) : key === "user_available" ? typeof value === "boolean" : true
      );
    const wronglyDropped = input.valid.filter((context) => !kept(context));
    const wronglyKept = input.invalid.filter((context) => kept(context));
    check(wronglyDropped.length === 0, ourBug(`valid context refused: ${JSON.stringify(wronglyDropped)}`));
    check(wronglyKept.length === 0, ourBug(`invalid context would be sent: ${JSON.stringify(wronglyKept)}`));
    return `filters ${LOCALE} and ${ZONE} (from capability.ts, not importable) keep the ${input.valid.length} valid and drop the ${input.invalid.length} invalid; "units" is never sent`;
  },

  async operation(input, expect) {
    const { handleProposal } = await src("poppy/operations.ts");
    const { client, company } = await clientWith();
    const operation = await handleProposal(client, company, "main", input);
    check(operation !== null, ourBug("the proposal was rejected"));
    // The draft has both sides "ignore ... fields they don't recognize" (3.3). Since the
    // operation is parsed at the edge (src/poppy/operation-value.ts) ours drops them, as
    // discovery does, so `extra` is checked as accepted, not as carried.
    const extra = Object.keys(expect.extra ?? {});
    const kept = extra.filter((key) => JSON.stringify(operation[key]) === JSON.stringify(expect.extra[key]));
    return extra.length
      ? `accepted; unknown ${extra.join(", ")} ${kept.length === extra.length ? "kept" : "ignored, not preserved"}`
      : "accepted";
  },

  async discovery(input, expect) {
    const { validateCompany } = await src("validator/index.ts");
    const { discover } = await src("poppy/discovery.ts");
    let responses = input.responses;
    let note = "";
    if (input.timeout_seconds !== undefined) {
      // Our limit is fixed (validator LIMITS.timeoutMs, 10 s), not configurable. Stretch the
      // trickle so the whole body takes as many multiples of our limit as of theirs.
      const { LIMITS } = await src("validator/fetch.ts");
      const factor = LIMITS.timeoutMs / 1000 / input.timeout_seconds;
      responses = structuredClone(responses);
      for (const answer of Object.values(responses)) {
        if (answer.trickle) answer.trickle.interval_seconds *= factor;
      }
      note = ` (trickle stretched ×${factor.toFixed(1)} for our fixed ${LIMITS.timeoutMs / 1000} s limit)`;
    }
    let report;
    try {
      report = await validateCompany(fixedNetwork(responses), input.domain);
    } catch (error) {
      throw ourBug(`validateCompany threw ${error?.name}: ${error?.message}`);
    }
    let discovered;
    let refusal;
    try {
      discovered = await discover(fixedNetwork(responses), input.domain);
    } catch (error) {
      refusal = error;
    }
    if ("error" in expect) {
      // Agent behaviour: discover() refuses, the validator agrees our client refuses it, and
      // for the case's reason. That reason's severity (its basis) doesn't enter into it.
      check(refusal !== undefined, ourBug(`discovery succeeded; expected ${expect.error}`));
      check(report.refused, ourBug(`discover() refused, but the validator says our client wouldn't: ${describe(report)}`));
      const refusing = refusingIds(report);
      const wanted = DISCOVERY_ERRORS[expect.error] ?? [];
      const allMessages = report.messages.map((m) => m.id);
      if (wanted.some((id) => refusing.includes(id))) return `refused: ${describeRefusals(report)}${note}`;
      if (wanted.some((id) => allMessages.includes(id))) {
        throw reading(`refused, but not for ${wanted.join("/")}, which our client doesn't refuse over; refused for: ${describeRefusals(report)}`);
      }
      throw ourBug(`refused, but not for ${expect.error}: ${describeRefusals(report)}`);
    }
    if (refusal) {
      throw reading(`refused: ${refusal.message}`);
    }
    const result = discovered.result;
    const notes = [];
    if ("issuer" in expect) {
      check(result.issuer === expect.issuer, ourBug(`issuer ${result.issuer}`));
      notes.push(`issuer ${result.issuer}`);
    }
    if ("organization_domain" in expect) {
      check(result.domain === expect.organization_domain, ourBug(`organization domain ${result.domain}`));
      notes.push(`organization.domain ${result.domain}`);
    }
    if ("discovery_url" in expect) {
      const finalUrl = report.documents[0]?.finalUrl;
      check(finalUrl === expect.discovery_url, ourBug(`served from ${finalUrl}`));
      notes.push(`served from ${finalUrl}`);
    }
    return notes.join("; ");
  },

  async url_safety(input, expect) {
    // A Worker never sees DNS answers: fetch() resolves inside Cloudflare, which refuses
    // private and reserved addresses itself. Our code checks host names only
    // (src/poppy/fetch.ts assertPublicHost, src/validator/fetch.ts isPublicHost).
    const { assertPublicHost } = await src("poppy/fetch.ts");
    const { isPublicHost } = await src("validator/fetch.ts");
    const url = new URL(input.url);
    if (expect.safe) {
      assertPublicHost(url);
      check(isPublicHost(url), ourBug(`${url.hostname} refused`));
      return `${url.hostname} accepted by name (addresses aren't visible to a Worker)`;
    }
    // Supplementary: the same addresses as IP-literal URLs, which we do see.
    const literals = input.addresses.map((address) => new URL(`https://${address.includes(":") ? `[${address}]` : address}/`));
    const accepted = literals.filter((literal) => isPublicHost(literal));
    throw notApplicable(
      `DNS resolution happens in the Workers runtime, not our code; ` +
        (accepted.length
          ? `as IP literals, ${accepted.map((u) => u.hostname).join(", ")} would be ACCEPTED`
          : `as IP literals, all of ${input.addresses.join(", ")} are refused`)
    );
  },

  async pinned_connect() {
    throw notApplicable("Datalayer marks it Python-only; a Worker can't pin a connection to a resolved address");
  },

  async strict_json(input, expect) {
    const { parseStrictJson } = await src("poppy/json.ts");
    const { parseJson } = await src("validator/json.ts");
    const missed = [];
    for (const text of input) {
      let clientRefused = false;
      try {
        parseStrictJson(text);
      } catch {
        clientRefused = true;
      }
      const parsed = parseJson(text);
      const validatorFlagged = parsed.ok && parsed.duplicates.length > 0;
      if (!clientRefused) missed.push(`src/poppy/json.ts accepted ${text}`);
      if (!validatorFlagged) missed.push(`src/validator/json.ts found no duplicate in ${text}`);
    }
    check(missed.length === 0, ourBug(missed.join("; ")));
    return `all ${input.length} refused by src/poppy/json.ts and flagged (${expect.error}) by src/validator/json.ts`;
  },

  async rate_limited(input, expect) {
    const { readConversation } = await src("poppy/conversations.ts");
    const answer = { status: input.status, headers: input.headers, json: input.body };
    const notes = [];
    // A Session request answered 429: reported with Retry-After, not retried early.
    {
      const { client, company, log } = await clientWith({ [`${SHOP_ISSUER}/oauth/token`]: answer });
      let error;
      try {
        await client.token(company, { label: "main" });
      } catch (caught) {
        error = caught;
      }
      check(error?.code === expect.error, ourBug(`Session request: ${error ? `${error.code}: ${error.message}` : "succeeded"}`));
      check(String(error.detail?.retryAfter) === expect.retry_after, ourBug(`retryAfter ${error.detail?.retryAfter}`));
      const attempts = hits(log, `${SHOP_ISSUER}/oauth/token`);
      check(attempts === 1, ourBug(`token endpoint called ${attempts} times`));
      notes.push(`Session request: rate_limited, retryAfter ${error.detail.retryAfter}, 1 attempt`);
    }
    // A conversation read answered 429: the read job is rescheduled after Retry-After.
    {
      const id = "cnv_rate_limited";
      const events = `${SHOP_ISSUER}/poppy/conversations/${id}/events`;
      const { client, sql, log } = await clientWith({ [events]: answer });
      sql.exec(
        `INSERT INTO poppy_conversations (id, issuer, label, parent, direct, status, responder, cursor, context, last_event_at, created_at)
         VALUES (?, ?, 'main', NULL, 0, 'working', 'agent', NULL, NULL, ?, ?)`,
        id, SHOP_ISSUER, Date.now(), Date.now()
      );
      const before = Date.now();
      const next = await readConversation(client, id, 0);
      const waited = Math.round((next - before) / 1000);
      const attempts = hits(log, events);
      check(attempts === 1, ourBug(`events endpoint called ${attempts} times`));
      check(Math.abs(waited - Number(expect.retry_after)) <= 1, ourBug(`next read in ${waited} s`));
      notes.push(`conversation read: 1 attempt, next read in ${waited} s`);
    }
    return notes.join("; ");
  }
};

// ------------------------------------------------------------ Company-role cases
function companyCase(item) {
  const kind = item.mutation ? "a mutated request (assertion or DPoP) the Company must refuse" : "a Company behaviour, driven by Datalayer's agent";
  return `Company-role case: ${kind}. It tests a Company, not a Personal Agent; run it against a Company with Datalayer's runner (pap company verify)`;
}

// ------------------------------------------------------------ Main
async function main() {
  const { values } = parseArgs({ options: { cases: { type: "string" }, json: { type: "string" }, verbose: { type: "boolean" } } });
  const cases = await loadCases(values.cases ? resolve(values.cases) : undefined);
  const results = [];
  for (const item of cases) {
    const base = { id: item.id, suite: item.suite, role: item.role, check: item.check ?? null, requirements: item.requirements };
    if (item.check === undefined) {
      results.push({ ...base, status: "n/a", category: "company-role", reason: companyCase(item) });
      continue;
    }
    if (item.sdk && !item.sdk.includes("typescript") && item.check !== "pinned_connect") {
      results.push({ ...base, status: "n/a", category: "sdk-specific", reason: `Datalayer runs it for ${item.sdk.join(", ")} only` });
      continue;
    }
    const run = CHECKS[item.check];
    if (!run) {
      results.push({ ...base, status: "n/a", category: "unknown-check", reason: `no mapping for check ${item.check}` });
      continue;
    }
    try {
      const detail = await run(item.input, item.expect ?? {});
      results.push({ ...base, status: "pass", reason: detail });
    } catch (error) {
      if (error instanceof NotApplicable) results.push({ ...base, status: "n/a", category: "architecture", reason: error.message });
      else if (error instanceof Fail) results.push({ ...base, status: "fail", category: error.category, reason: error.message });
      else results.push({ ...base, status: "fail", category: "harness", reason: `threw ${error?.name}: ${error?.message}` });
    }
  }

  const count = (predicate) => results.filter(predicate).length;
  const lines = [];
  lines.push(`Datalayer conformance cases @ ${COMMIT.slice(0, 7)}: ${results.length}`);
  lines.push(
    `  pass ${count((r) => r.status === "pass")}, fail ${count((r) => r.status === "fail")}, n/a ${count((r) => r.status === "n/a")}`
  );
  for (const category of ["our-bug", "reading", "harness"]) {
    const n = count((r) => r.status === "fail" && r.category === category);
    if (n) lines.push(`    fail/${category}: ${n}`);
  }
  for (const category of ["company-role", "architecture", "sdk-specific", "unknown-check"]) {
    const n = count((r) => r.status === "n/a" && r.category === category);
    if (n) lines.push(`    n/a/${category}: ${n}`);
  }
  lines.push("");
  for (const result of results) {
    if (result.status === "n/a" && result.category === "company-role" && !values.verbose) continue;
    const tag = result.status === "fail" ? `FAIL ${result.category}` : result.status === "n/a" ? "n/a " : "pass";
    lines.push(`${tag.padEnd(13)} ${result.id} (${result.check}): ${result.reason}`);
  }
  if (!values.verbose) lines.push(`\n(${count((r) => r.category === "company-role")} Company-role cases not listed; --verbose lists them)`);
  process.stdout.write(`${lines.join("\n")}\n`);
  if (values.json) {
    writeFileSync(values.json, `${JSON.stringify({ source: `datalayer/personal-agent-protocol@${COMMIT}`, results }, null, 2)}\n`);
  }
  process.exit(count((r) => r.status === "fail" && r.category === "our-bug") ? 1 : 0);
}

await main();
