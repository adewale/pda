import type { CompanyReport } from "../validator/index.ts";
import type { Company } from "./discovery";
import { PROTOCOL_LOG_LIMIT, type PoppyServerFrame, type ProtocolCompany, type ProtocolEntry, type ProtocolOutcome } from "./wire";

/**
 * The protocol view: every Poppy exchange the agent made with each Company,
 * in order, with the spec section it follows, for the people who write the
 * spec and other implementations. Rows are written by the one Poppy HTTP
 * client (`client.ts`) and discovery, and by triggers on the sign-in,
 * conversation and operation tables for state changes no request makes.
 *
 * Every value is built here, from an allowlist: a step, a method, a URL's
 * origin and path, a status, an error code, and one-line summaries put
 * together from fields named below. Headers, bodies, tokens, assertions,
 * DPoP proofs, keys, codes, `state`, PKCE verifiers, device codes, sign-in
 * field values, cursors and query strings never reach a row. The log is
 * bounded: the newest `PROTOCOL_LOG_LIMIT` rows per Company.
 */

type Sql = SqlStorage;

export { PROTOCOL_LOG_LIMIT };

/** Each step's section of Draft 0.1 ("§") or the Operations extension ("Ops §"), and its subject. */
export const PROTOCOL_STEPS = {
  "discovery.poppy": { section: "§3", title: "Discovery" },
  "discovery.metadata": { section: "§3.2", title: "OAuth server" },
  "discovery.verdict": { section: "§3", title: "Validator" },
  "session.start": { section: "§4.2", title: "Session" },
  "session.renew": { section: "§4.2", title: "Session" },
  "token.other": { section: "§4.2", title: "Token endpoint" },
  "ratelimit.wait": { section: "§4.3", title: "Rate limits" },
  "signin.direct.state": { section: "§4.5", title: "Direct Sign-In" },
  "signin.direct.exchange": { section: "§4.5", title: "Direct Sign-In" },
  "signin.device.state": { section: "§4.6", title: "Device Sign-In" },
  "signin.device.start": { section: "§4.6", title: "Device Sign-In" },
  "signin.device.poll": { section: "§4.6", title: "Device Sign-In" },
  "signin.mediated.state": { section: "§4.7", title: "Mediated Sign-In" },
  "signin.mediated.credentials": { section: "§4.7", title: "Mediated Sign-In" },
  "signin.mediated.code": { section: "§4.7", title: "Mediated Sign-In" },
  "account.renew": { section: "§4.8", title: "Account Token" },
  "account.signin": { section: "§4.8", title: "Account Token" },
  "account.revoke": { section: "§4.9", title: "Signing out" },
  "website.ratelimit": { section: "§5", title: "Web browsing" },
  "api.call": { section: "§6", title: "API" },
  "mcp.call": { section: "§6", title: "MCP" },
  "conversation.request": { section: "§7.2", title: "Conversation" },
  "conversation.start": { section: "§7.3", title: "Conversation" },
  "conversation.opened": { section: "§7.3", title: "Conversation" },
  "conversation.send": { section: "§7.3", title: "Conversation" },
  "conversation.read": { section: "§7.5", title: "Reading events" },
  "conversation.status": { section: "§7.7", title: "Status and responder" },
  "conversation.handoff": { section: "§7.9", title: "Handoff" },
  "conversation.direct": { section: "§7.10", title: "Direct Conversation" },
  "conversation.close": { section: "§7.12", title: "Closing" },
  "operation.proposed": { section: "Ops §4", title: "Proposal" },
  "operation.revision": { section: "Ops §3.1", title: "Revision" },
  "operation.approved": { section: "Ops §5.1", title: "Approval" },
  "operation.confirm": { section: "Ops §5.2", title: "Confirming" },
  "operation.read": { section: "Ops §6", title: "Tracking" },
  "operation.state": { section: "Ops §6", title: "Tracking" },
  "operation.cancel": { section: "Ops §7", title: "Cancelling" },
  "operation.request": { section: "Ops §3", title: "Operations" }
} as const satisfies Record<string, { section: string; title: string }>;

export type ProtocolStep = keyof typeof PROTOCOL_STEPS;

/** Now, in epoch ms, as SQLite reads the clock: for rows the triggers write. */
const SQL_NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/**
 * The table, its pruning, and the triggers that record state changes. Run by
 * `migrate` in store.ts; the triggers are dropped and made again each time, so
 * a change here reaches existing agents.
 */
export function migrateProtocolLog(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS poppy_protocol_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    issuer TEXT,
    at INTEGER NOT NULL,
    step TEXT NOT NULL,
    method TEXT,
    url TEXT,
    status INTEGER,
    error TEXT,
    outcome TEXT NOT NULL,
    summary TEXT NOT NULL,
    result TEXT NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS poppy_protocol_log_key ON poppy_protocol_log (key, seq)");
  const triggers: Record<string, string> = {
    // Keep the newest PROTOCOL_LOG_LIMIT rows of each Company.
    poppy_protocol_prune: `AFTER INSERT ON poppy_protocol_log BEGIN
      DELETE FROM poppy_protocol_log WHERE key = new.key AND seq <= (
        SELECT seq FROM poppy_protocol_log WHERE key = new.key ORDER BY seq DESC LIMIT 1 OFFSET ${PROTOCOL_LOG_LIMIT}
      );
    END`,
    // Sign-ins: their type, requested scopes and each status, never their secrets or state hash.
    poppy_protocol_signin_new: `AFTER INSERT ON poppy_signins BEGIN
      INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result)
      VALUES (new.issuer, new.issuer, ${SQL_NOW}, 'signin.' || new.type || '.state', 'info',
        CASE new.type
          WHEN 'direct' THEN 'Sent the User to the authorization endpoint in their own browser, with state and a PKCE S256 challenge'
          WHEN 'device' THEN 'Showed the User the code and link on their page'
          ELSE 'Asked the User for the sign-in fields on their page'
        END || ', scope ' || substr(new.scopes, 1, 200),
        'Sign-in ' || substr(new.status, 1, 32));
    END`,
    poppy_protocol_signin_status: `AFTER UPDATE OF status ON poppy_signins WHEN old.status IS NOT new.status BEGIN
      INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result)
      VALUES (new.issuer, new.issuer, ${SQL_NOW}, 'signin.' || new.type || '.state', 'info',
        'Sign-in state', substr(old.status, 1, 32) || ' → ' || substr(new.status, 1, 32));
    END`,
    // Conversations: opened, and each change of status or responder (7.7).
    poppy_protocol_conversation_new: `AFTER INSERT ON poppy_conversations BEGIN
      INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result)
      VALUES (new.issuer, new.issuer, ${SQL_NOW}, CASE WHEN new.direct THEN 'conversation.direct' ELSE 'conversation.opened' END, 'info',
        CASE WHEN new.direct THEN 'Direct Conversation ' ELSE 'Conversation ' END || substr(new.id, 1, 64) || ' opened'
          || CASE WHEN new.parent IS NOT NULL THEN ' under ' || substr(new.parent, 1, 64) ELSE '' END,
        'status ' || substr(new.status, 1, 32) || ', responder ' || substr(new.responder, 1, 32));
    END`,
    poppy_protocol_conversation_status: `AFTER UPDATE OF status, responder ON poppy_conversations
      WHEN old.status IS NOT new.status OR old.responder IS NOT new.responder BEGIN
      INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result)
      VALUES (new.issuer, new.issuer, ${SQL_NOW}, 'conversation.status', 'info',
        'Conversation ' || substr(new.id, 1, 64),
        'status ' || substr(old.status, 1, 32) || ' → ' || substr(new.status, 1, 32)
          || ', responder ' || substr(old.responder, 1, 32) || ' → ' || substr(new.responder, 1, 32));
    END`,
    // Operations, wherever they were proposed (Ops 4): revision and state, never the summary or terms.
    poppy_protocol_operation_new: `AFTER INSERT ON poppy_operations BEGIN
      INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result)
      VALUES (new.issuer, new.issuer, ${SQL_NOW}, 'operation.proposed', 'info',
        'Operation ' || substr(new.operation_id, 1, 64) || ' revision ' || CAST(json_extract(new.operation, '$.revision') AS TEXT),
        'state ' || substr(CAST(json_extract(new.operation, '$.state') AS TEXT), 1, 32));
    END`,
    poppy_protocol_operation_change: `AFTER UPDATE OF operation ON poppy_operations
      WHEN json_extract(old.operation, '$.revision') IS NOT json_extract(new.operation, '$.revision')
        OR json_extract(old.operation, '$.state') IS NOT json_extract(new.operation, '$.state') BEGIN
      INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result)
      VALUES (new.issuer, new.issuer, ${SQL_NOW},
        CASE WHEN json_extract(old.operation, '$.revision') IS NOT json_extract(new.operation, '$.revision') THEN 'operation.revision' ELSE 'operation.state' END,
        'info',
        'Operation ' || substr(new.operation_id, 1, 64) || ' revision ' || CAST(json_extract(new.operation, '$.revision') AS TEXT),
        'state ' || substr(CAST(json_extract(old.operation, '$.state') AS TEXT), 1, 32) || ' → ' || substr(CAST(json_extract(new.operation, '$.state') AS TEXT), 1, 32));
    END`,
    poppy_protocol_operation_approved: `AFTER UPDATE OF approved_revision ON poppy_operations
      WHEN new.approved_revision IS NOT NULL AND old.approved_revision IS NOT new.approved_revision BEGIN
      INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result)
      VALUES (new.issuer, new.issuer, ${SQL_NOW}, 'operation.approved', 'info',
        'Operation ' || substr(new.operation_id, 1, 64) || ' revision ' || CAST(new.approved_revision AS TEXT),
        'Approved by ' || CASE new.approved_by WHEN 'user' THEN 'the User, on their card' WHEN 'standing_permission' THEN 'a standing permission the User set' ELSE 'someone else' END);
    END`
  };
  for (const [name, body] of Object.entries(triggers)) {
    sql.exec(`DROP TRIGGER IF EXISTS ${name}`);
    sql.exec(`CREATE TRIGGER ${name} ${body}`);
  }
}

// ---------------------------------------------------------------- Allowlisted values

/** A URL as origin and path: no credentials, query or fragment. Null if it isn't one. */
export function bareUrl(value: string | URL | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  return `${url.origin}${url.pathname}`;
}

/** An OAuth or Poppy error code, a grant name or a state: a short token, or null. */
function token(value: unknown, max = 64): string | null {
  return typeof value === "string" && value.length <= max && /^[A-Za-z0-9_.:\-]+$/.test(value) ? value : null;
}

/** A scope string: its scope tokens (RFC 6749 §3.3), at most ten. */
function scopeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const scopes = value.split(" ").filter((scope) => /^[\x21\x23-\x5B\x5D-\x7E]{1,64}$/.test(scope));
  return scopes.length ? scopes.slice(0, 10).join(" ") : null;
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** A Company's id or name for something (a conversation, an operation, a tool): printable, short. */
function label(value: unknown, max = 64): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7E]+$/.test(value) ? value : null;
}

function line(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 399)}…` : flat;
}

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------- Writing

type Row = {
  readonly key: string;
  readonly issuer: string | null;
  readonly step: ProtocolStep;
  readonly method?: string | null;
  readonly url?: string | null;
  readonly status?: number | null;
  readonly error?: string | null;
  readonly outcome: ProtocolOutcome;
  readonly summary: string;
  readonly result: string;
};

function insert(sql: Sql, row: Row): void {
  sql.exec(
    "INSERT INTO poppy_protocol_log (key, issuer, at, step, method, url, status, error, outcome, summary, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.key,
    row.issuer,
    Date.now(),
    row.step,
    row.method && /^[A-Z]{1,10}$/.test(row.method) ? row.method : null,
    row.url ?? null,
    row.status ?? null,
    token(row.error),
    row.outcome,
    line(row.summary),
    line(row.result)
  );
}

/**
 * Write a row without ever failing the exchange it describes: the log is a
 * view, and a request must not fail because its record couldn't be kept.
 */
function safely(write: () => void): void {
  try {
    write();
  } catch (error) {
    console.warn("poppy protocol log failed", error instanceof Error ? error.name : "error");
  }
}

/** What a status and error code say, in a few words. */
function answered(status: number, error: string | null): string {
  return error ? `${status} ${error}` : String(status);
}

// ---------------------------------------------------------------- Discovery (§3)

const VERDICT: Record<string, string> = { valid: "valid", invalid: "invalid", indeterminate: "indeterminate (not checked)" };

/**
 * Discovery for one domain, from the validator's report: each document it
 * fetched, then the verdict. Keyed by the issuer once discovery accepted the
 * Company, else by the domain, so a document claiming another Company's
 * issuer can't write into that Company's log.
 */
export function recordDiscovery(sql: Sql, domain: string, report: CompanyReport | undefined, company: { readonly issuer?: string } | null): void {
  safely(() => {
    const issuer = company?.issuer ?? null;
    const key = issuer ?? domain.trim().toLowerCase();
    if (!report) {
      insert(sql, { key, issuer, step: "discovery.verdict", outcome: "failed", summary: `Discovery of ${label(key, 253) ?? "the domain"}`, result: "No report: discovery stopped before the validator ran" });
      return;
    }
    for (const document of report.documents) {
      const metadata = document.kind === "oauth-metadata";
      const url = bareUrl(document.url);
      const final = bareUrl(document.finalUrl);
      const status = typeof document.status === "number" ? document.status : null;
      insert(sql, {
        key,
        issuer,
        step: metadata ? "discovery.metadata" : "discovery.poppy",
        method: "GET",
        url,
        status,
        outcome: status === null ? "failed" : status >= 200 && status < 300 ? "ok" : "error",
        summary: metadata ? "Fetch the issuer's OAuth server metadata (RFC 8414)" : "Fetch poppy.json, without credentials",
        result: [
          status === null ? "No answer" : String(status),
          final && final !== url ? `from ${final}` : null,
          typeof document.contentType === "string" ? label(document.contentType.split(";")[0]!.trim(), 80) : null
        ]
          .filter(Boolean)
          .join(" · ")
      });
    }
    const ids = (keep: (message: CompanyReport["messages"][number]) => boolean) => [
      ...new Set(report.messages.filter(keep).map((message) => token(message.id)).filter(Boolean))
    ];
    const refusing = ids((message) => message.refuses);
    const tolerated = ids((message) => message.severity === "error" && !message.refuses);
    const { error, warning, info } = report.counts;
    insert(sql, {
      key,
      issuer,
      step: "discovery.verdict",
      outcome: report.refused ? "refused" : "ok",
      // `checkedAgainst` is the validator's own name for the profile, such as "Draft 0.1".
      summary: `Validated against ${report.checkedAgainst}`,
      result: [
        `${VERDICT[report.outcome] ?? "unknown"}: ${error} error${error === 1 ? "" : "s"}, ${warning} warning${warning === 1 ? "" : "s"}, ${info} info`,
        report.refused
          ? `refused by our client${refusing.length ? ` (${refusing.slice(0, 5).join(", ")})` : ""}`
          : `used by our client${tolerated.length ? `, which tolerates ${tolerated.slice(0, 5).join(", ")}` : ""}`
      ].join(" · ")
    });
  });
}

// ---------------------------------------------------------------- Token, device and revocation endpoints (§4)

const GRANTS: Record<string, string> = {
  "urn:ietf:params:oauth:grant-type:jwt-bearer": "jwt-bearer",
  refresh_token: "refresh_token",
  authorization_code: "authorization_code",
  "urn:ietf:params:oauth:grant-type:device_code": "device_code"
};

export type OauthAttempt = {
  readonly endpoint: string;
  /** The form we sent, read only for the fields named here: never a token, code, verifier or assertion. */
  readonly form: Readonly<Record<string, string>>;
  readonly dpop: boolean;
  /** Whether the proof carried the server's nonce. */
  readonly nonce: boolean;
};

/** What happened after the answer: the client tried again, or will wait. */
export type Followup =
  | { readonly kind: "nonce" }
  | { readonly kind: "wait"; readonly ms: number; readonly retrying: boolean }
  | { readonly kind: "renew" }
  | { readonly kind: "restart" };

function followup(next: Followup | undefined): string | null {
  if (!next) return null;
  switch (next.kind) {
    case "nonce":
      return "sending again with the Company's DPoP-Nonce and a new proof";
    case "wait": {
      const wait = `Retry-After ${Math.ceil(next.ms / 1000)} s`;
      return next.retrying ? `${wait}: waiting, then sending again with a new proof` : `${wait}: too long to wait inline; the job tries again later`;
    }
    case "renew":
      return "getting a new Session Token, then sending again once";
    case "restart":
      return "starting a new Session, then sending again once";
  }
}

function oauthStep(company: Company, attempt: OauthAttempt): { step: ProtocolStep; summary: string } {
  const form = attempt.form;
  const session = "session_id" in form ? "session_id sent" : null;
  const scope = scopeText(form.scope);
  const resource = bareUrl(form.resource);
  const proof = attempt.dpop ? `DPoP proof${attempt.nonce ? " with nonce" : ""}` : "no DPoP (Bearer)";
  const extras = [scope ? `scope ${scope}` : null, resource ? `resource ${resource}` : null];
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(", ");
  if (attempt.endpoint === company.endpoints.deviceAuthorization) {
    return { step: "signin.device.start", summary: join("Device authorization request", ...extras, "client assertion") };
  }
  if (attempt.endpoint === company.endpoints.revocation) {
    return { step: "account.revoke", summary: join("Revoke the Account Token", token(form.token_type_hint) ? `token_type_hint ${form.token_type_hint}` : null, "client assertion") };
  }
  const grant = GRANTS[form.grant_type ?? ""] ?? null;
  switch (grant) {
    case "jwt-bearer":
      return session
        ? { step: "session.renew", summary: join("Renew the Session: jwt-bearer grant with a Session assertion", session, ...extras, "client assertion", proof) }
        : { step: "session.start", summary: join("Start a Session: jwt-bearer grant with a Session assertion, no session_id", ...extras, "client assertion", proof) };
    case "refresh_token":
      return session
        ? { step: "account.renew", summary: join("Renew a signed-in Session: refresh_token grant with the Account Token", session, ...extras, "client assertion", proof) }
        : { step: "account.signin", summary: join("Sign a new Session in: refresh_token grant with a stored Account Token", ...extras, "client assertion", proof) };
    case "authorization_code":
      return { step: "signin.direct.exchange", summary: join("Exchange the authorization code: authorization_code grant with the PKCE verifier and redirect_uri", session, "client assertion", proof) };
    case "device_code":
      return { step: "signin.device.poll", summary: join("Poll: device_code grant", session, "client assertion", proof) };
    default:
      return { step: "token.other", summary: join(`Token request${token(form.grant_type, 100) ? `: ${form.grant_type}` : ""}`, session, "client assertion", proof) };
  }
}

/** A token, device or revocation answer, from the fields named here only. */
function oauthAnswer(step: ProtocolStep, status: number, body: unknown, error: string | null): string {
  if (error || status >= 300 || !isObj(body)) return answered(status, error);
  if (step === "signin.device.start") {
    const interval = seconds(body.interval);
    const expires = seconds(body.expires_in);
    return [String(status), "device_code and user_code issued (never recorded)", interval !== null ? `interval ${interval} s` : null, expires !== null ? `expires in ${expires} s` : null].filter(Boolean).join(", ");
  }
  if (step === "account.revoke") return `${status}: revoked`;
  const parts = [String(status)];
  if (typeof body.session_id === "string") parts.push("session_id returned");
  if (body.signed_in === true) parts.push("signed in");
  else if (body.signed_in === false) parts.push("signed out");
  const type = token(body.token_type);
  if (type) parts.push(`${type} token`);
  const expires = seconds(body.expires_in);
  if (expires !== null) parts.push(`expires in ${expires} s`);
  // RFC 6749 §5.1: a missing `scope` means the scope requested (N6).
  parts.push(typeof body.scope !== "string" ? "no scope in the answer" : scopeText(body.scope) ? `scope ${scopeText(body.scope)}` : "no scopes");
  if (typeof body.refresh_token === "string") parts.push(step === "account.renew" || step === "account.signin" ? "Account Token rotated" : "Account Token issued");
  return parts.join(", ");
}

/** One request to the token, device authorization or revocation endpoint, and its answer. */
export function recordOauth(
  sql: Sql,
  company: Company,
  attempt: OauthAttempt,
  answer: { readonly status: number; readonly body: unknown } | { readonly failed: string },
  next?: Followup
): void {
  safely(() => {
    const { step, summary } = oauthStep(company, attempt);
    const url = bareUrl(attempt.endpoint);
    if ("failed" in answer) {
      insert(sql, { key: company.issuer, issuer: company.issuer, step, method: "POST", url, outcome: "failed", error: token(answer.failed), summary, result: `No answer (${token(answer.failed) ?? "network"})` });
      return;
    }
    const error = isObj(answer.body) ? token(answer.body.error) : null;
    const after = followup(next);
    insert(sql, {
      key: company.issuer,
      issuer: company.issuer,
      step,
      method: "POST",
      url,
      status: answer.status,
      error,
      outcome: after ? "retry" : answer.status >= 200 && answer.status < 300 ? "ok" : "error",
      summary,
      result: [oauthAnswer(step, answer.status, answer.body, error), after].filter(Boolean).join(": ")
    });
  });
}

// ---------------------------------------------------------------- APIs, conversations, operations, Mediated Sign-In

/**
 * How an OpenAPI call is named in the log: its operation and path template,
 * from the description `apis.ts` already holds. `apis.ts` registers it, so
 * this module needn't import that one.
 */
type ApiNamer = (method: string, url: URL) => { readonly operation: string; readonly path: string; readonly base: string } | null;
let apiNamer: ApiNamer | undefined;

export function registerApiNamer(namer: ApiNamer): void {
  apiNamer = namer;
}

export type ResourceRequest = {
  readonly method: string;
  readonly url: string;
  /** Our own JSON body, read only for the fields named here. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly accept?: string;
};

/** The path below an endpoint, as segments; null if `url` isn't at or under it. */
function below(endpoint: string | undefined, url: URL): string[] | null {
  if (!endpoint || !URL.canParse(endpoint)) return null;
  const base = new URL(endpoint);
  const basePath = base.pathname.replace(/\/+$/, "");
  if (base.origin !== url.origin) return null;
  if (url.pathname.replace(/\/+$/, "") === basePath) return [];
  if (!url.pathname.startsWith(`${basePath}/`)) return null;
  return url.pathname.slice(basePath.length + 1).split("/");
}

function waitOf(url: URL): string | null {
  const wait = url.searchParams.get("wait");
  return wait && /^\d{1,4}$/.test(wait) ? `wait ${wait} s` : null;
}

/** A message we send: its id, sender and which fields it has, never their contents. */
function messageFields(body: unknown): string | null {
  if (!isObj(body) || !isObj(body.message)) return null;
  const message = body.message;
  const fields = ["text", "data", "context"].filter((field) => message[field] !== undefined);
  const id = label(message.id);
  const sender = message.sender === "human" || message.sender === "agent" ? message.sender : null;
  return [id ? `message ${id}` : "message", sender ? `sender ${sender}` : null, fields.length ? `with ${fields.join(", ")}` : null].filter(Boolean).join(" ");
}

function classify(company: Company, request: ResourceRequest, url: URL, bearer: boolean): { step: ProtocolStep; summary: string; url: string | null } {
  const at = bareUrl(url);
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(", ");
  const mediated = company.signIn.mediated?.endpoint;
  const signIn = below(mediated, url);
  if (signIn) {
    if (signIn.length === 0) {
      const count = isObj(request.body) && isObj(request.body.credentials) ? Object.keys(request.body.credentials).length : 0;
      return { step: "signin.mediated.credentials", summary: `Send the sign-in form: ${count} field${count === 1 ? "" : "s"}, values never recorded`, url: at };
    }
    // The path holds sign_in_id, a secret we keep sealed.
    return { step: "signin.mediated.code", summary: "Send the one-time code, never recorded, from the same Session", url: `${bareUrl(mediated)!.replace(/\/+$/, "")}/{sign_in_id}` };
  }
  const conversation = below(company.conversations?.endpoint, url);
  if (conversation) {
    const id = label(conversation[0] ?? "");
    const [, action] = conversation;
    if (conversation.length === 0 && request.method === "POST") {
      const parent = isObj(request.body) ? label(request.body.parent_conversation_id) : null;
      return parent
        ? { step: "conversation.direct", summary: join(`Open a Direct Conversation under ${parent}`, messageFields(request.body), waitOf(url)), url: at }
        : { step: "conversation.start", summary: join("Start a conversation", messageFields(request.body), waitOf(url)), url: at };
    }
    if (conversation.length === 2 && action === "messages") return { step: "conversation.send", summary: join(`Send to ${id ?? "a conversation"}`, messageFields(request.body), waitOf(url), url.searchParams.has("cursor") ? "from the saved cursor" : null), url: at };
    if (conversation.length === 2 && action === "events") {
      const stream = (request.accept ?? "").includes("text/event-stream");
      return { step: "conversation.read", summary: join(`Read events of ${id ?? "a conversation"}`, url.searchParams.has("cursor") ? "from the saved cursor" : "from the start", waitOf(url), stream ? "stream or JSON" : null), url: at };
    }
    if (conversation.length === 2 && action === "handoff") return { step: "conversation.handoff", summary: `Hand ${id ?? "the conversation"} off to a person, with {}`, url: at };
    if (conversation.length === 2 && action === "close") return { step: "conversation.close", summary: `Close ${id ?? "the conversation"}, with {}`, url: at };
    return { step: "conversation.request", summary: `${request.method} a conversation endpoint`, url: at };
  }
  const operation = below(company.extensions.operations?.endpoint, url);
  if (operation) {
    const id = label(operation[0] ?? "") ?? "an operation";
    if (operation.length === 1 && request.method === "GET") return { step: "operation.read", summary: `Read ${id}`, url: at };
    if (operation.length === 2 && operation[1] === "confirm") {
      const body = isObj(request.body) ? request.body : {};
      const revision = typeof body.revision === "number" ? body.revision : null;
      const by = token(body.approved_by);
      return { step: "operation.confirm", summary: join(`Confirm ${id}`, revision !== null ? `revision ${revision}` : null, by ? `approved_by ${by}` : null), url: at };
    }
    if (operation.length === 2 && operation[1] === "cancel") return { step: "operation.cancel", summary: `Cancel ${id}`, url: at };
    return { step: "operation.request", summary: `${request.method} an operations endpoint`, url: at };
  }
  if (bearer) {
    const body = isObj(request.body) ? request.body : {};
    const method = label(body.method, 100);
    const tool = method === "tools/call" && isObj(body.params) ? label(body.params.name, 100) : null;
    return { step: "mcp.call", summary: join(`JSON-RPC ${method ?? "request"}${tool ? ` ${tool}` : ""}`, "Bearer token for this server"), url: at };
  }
  const named = apiNamer?.(request.method, url) ?? null;
  const operationId = named ? label(named.operation, 100) : null;
  const path = named ? label(named.path, 200) : null;
  const template = named && path && bareUrl(named.base) ? `${bareUrl(named.base)!.replace(/\/+$/, "")}${path}` : at;
  const idempotent = Object.keys(request.headers ?? {}).some((name) => name.toLowerCase() === "idempotency-key");
  return {
    step: "api.call",
    summary: join(operationId && path && operationId !== `${request.method} ${path}` ? `${operationId} (${request.method} ${path})` : `${request.method} ${path ?? url.pathname}`, idempotent ? "Idempotency-Key" : null),
    url: template
  };
}

/** One request to a Company resource (API, MCP, conversation, operations, Mediated Sign-In) and its answer. */
export function recordResource(
  sql: Sql,
  company: Company,
  request: ResourceRequest,
  auth: { readonly bearer: boolean; readonly nonce: boolean },
  answer: { readonly status: number; readonly error: string | null } | { readonly failed: string } | { readonly refused: string },
  next?: Followup
): void {
  safely(() => {
    const url = URL.canParse(request.url) ? new URL(request.url) : null;
    if (!url) return;
    const { step, summary, url: shown } = classify(company, request, url, auth.bearer);
    const how = auth.bearer ? "Bearer" : `DPoP${auth.nonce ? " with nonce" : ""}`;
    const base = { key: company.issuer, issuer: company.issuer, step, method: request.method.toUpperCase(), summary: `${summary} · ${how}` };
    if ("refused" in answer) {
      // Not sent. The URL is left out: it may be the one that held a token.
      insert(sql, { ...base, url: null, outcome: "refused", error: token(answer.refused), summary, result: `Not sent: ${token(answer.refused) ?? "refused"}` });
      return;
    }
    if ("failed" in answer) {
      insert(sql, { ...base, url: shown, outcome: "failed", error: token(answer.failed), result: `No answer (${token(answer.failed) ?? "network"})` });
      return;
    }
    const after = followup(next);
    const error = token(answer.error);
    insert(sql, {
      ...base,
      url: shown,
      status: answer.status,
      error,
      outcome: after ? "retry" : answer.status >= 200 && answer.status < 400 ? "ok" : "error",
      result: [answered(answer.status, error), after].filter(Boolean).join(": ")
    });
  });
}

/** A wait on the Company's shared limit before a request (4.3): every agent's `Retry-After`, through `CompanyLimiter`. */
export function recordLimitWait(sql: Sql, issuer: string, ms: number, waited: boolean): void {
  safely(() =>
    insert(sql, {
      key: issuer,
      issuer,
      step: "ratelimit.wait",
      outcome: waited ? "info" : "retry",
      summary: "The Company's Retry-After, shared by every agent through CompanyLimiter",
      result: waited ? `Waited ${Math.ceil(ms / 1000)} s before sending` : `${Math.ceil(ms / 1000)} s left: too long to wait inline; the job tries again later`
    })
  );
}

/** A website page answered 429 or 503 (5, 4.3). */
export function recordPageLimit(sql: Sql, issuer: string, status: number, ms: number | null, retrying: boolean): void {
  safely(() =>
    insert(sql, {
      key: issuer,
      issuer,
      step: "website.ratelimit",
      status,
      outcome: "retry",
      summary: "A page of the Company's website",
      result: [String(status), ms === null ? "no Retry-After" : followup({ kind: "wait", ms, retrying })].filter(Boolean).join(": ")
    })
  );
}

// ---------------------------------------------------------------- Reading

type LogRow = {
  seq: number;
  key: string;
  issuer: string | null;
  at: number;
  step: string;
  method: string | null;
  url: string | null;
  status: number | null;
  error: string | null;
  outcome: string;
  summary: string;
  result: string;
};

const OUTCOMES = new Set<ProtocolOutcome>(["ok", "error", "retry", "failed", "refused", "info"]);

function entry(row: LogRow): ProtocolEntry {
  const known = (PROTOCOL_STEPS as Record<string, { section: string; title: string }>)[row.step];
  return {
    seq: row.seq,
    at: row.at,
    section: known?.section ?? "§?",
    title: known?.title ?? row.step,
    step: row.step,
    method: row.method,
    url: row.url,
    status: row.status,
    error: row.error,
    outcome: OUTCOMES.has(row.outcome as ProtocolOutcome) ? (row.outcome as ProtocolOutcome) : "info",
    summary: row.summary,
    result: row.result
  };
}

type Names = (issuer: string) => { readonly name: string; readonly domain: string | null };

/** The Companies with a log, the most recently active first. */
export function protocolIndex(sql: Sql, names: Names): Extract<PoppyServerFrame, { type: "poppy.protocol.index" }> {
  const companies: ProtocolCompany[] = (
    sql
      .exec(
        "SELECT key, MAX(issuer) AS issuer, COUNT(*) AS count, MAX(seq) AS last_seq, MAX(at) AS last_at FROM poppy_protocol_log GROUP BY key ORDER BY last_seq DESC"
      )
      .toArray() as unknown as { key: string; issuer: string | null; count: number; last_seq: number; last_at: number }[]
  ).map((row) => {
    const known = row.issuer ? names(row.issuer) : { name: row.key, domain: row.key };
    return { key: row.key, company: known.name, domain: known.domain, issuer: row.issuer, count: row.count, lastSeq: row.last_seq, lastAt: row.last_at };
  });
  return { type: "poppy.protocol.index", companies };
}

/** One Company's log, oldest first. */
export function protocolLog(sql: Sql, key: string, names: Names): Extract<PoppyServerFrame, { type: "poppy.protocol" }> {
  const rows = sql
    .exec("SELECT seq, key, issuer, at, step, method, url, status, error, outcome, summary, result FROM poppy_protocol_log WHERE key = ? ORDER BY seq", key)
    .toArray() as unknown as LogRow[];
  const issuer = rows.find((row) => row.issuer)?.issuer ?? null;
  const known = issuer ? names(issuer) : { name: key, domain: key };
  return { type: "poppy.protocol", key, company: known.name, domain: known.domain, issuer, entries: rows.map(entry) };
}
