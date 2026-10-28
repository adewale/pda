import { writtenBy } from "./message-author";
import { code, literal, recordPoppyExchange, reportError } from "../log";
import type { CompanyReport } from "../validator/index.ts";
import type { Company } from "./discovery";
import { PROTOCOL_LOG_LIMIT, type PoppyServerFrame, type ProtocolCompany, type ProtocolEntry, type ProtocolOutcome } from "./wire";
import { domainOrigin, issuerDecoder, type Issuer, type Origin } from "./issuer";
import { object } from "../decode";
import { integer, nullable, rows, table, text, textOf, type RowOf } from "../rows";

/**
 * The protocol view: every Poppy exchange the agent made with each Company,
 * in order, with the spec section it follows, for the people who write the
 * spec and other implementations. Rows are written by the one Poppy HTTP
 * client (`client.ts`) and discovery, and by triggers on the sign-in,
 * conversation and approval tables for state changes no request makes.
 *
 * Every value is built here, from an allowlist: a step, a method, a URL's
 * origin and path, a status, an error code, and one-line summaries put
 * together from fields named below. Headers, bodies, tokens, Session JWTs,
 * delegations, DPoP proofs, keys, codes, `state`, PKCE verifiers, device codes, sign-in
 * field values, cursors and query strings never reach a row. The log is
 * bounded: the newest `PROTOCOL_LOG_LIMIT` rows per Company.
 */

type Sql = SqlStorage;

export { PROTOCOL_LOG_LIMIT };

/** Each step's section of 0.3 ("§"), the Operations extension ("Ops §") or the Mediated Sign-In extension ("MSI §"), and its subject. */
export const PROTOCOL_STEPS = {
  "discovery.poppy": { section: "§3", title: "Discovery" },
  "discovery.metadata": { section: "§3.2", title: "OAuth server" },
  "discovery.verdict": { section: "§3", title: "Validator" },
  "token.other": { section: "§4.7", title: "Token endpoint" },
  "token.refresh": { section: "§4.4", title: "Refresh tokens" },
  "ratelimit.wait": { section: "§5.6", title: "Rate limits" },
  "signin.direct.state": { section: "§4.2", title: "Direct Sign-In" },
  "signin.direct.exchange": { section: "§4.2", title: "Direct Sign-In" },
  "signin.device.state": { section: "§4.3", title: "Device Sign-In" },
  "signin.device.start": { section: "§4.3", title: "Device Sign-In" },
  "signin.device.poll": { section: "§4.3", title: "Device Sign-In" },
  "signin.mediated.state": { section: "MSI §3", title: "Mediated Sign-In" },
  "signin.mediated.credentials": { section: "MSI §3", title: "Mediated Sign-In" },
  "signin.mediated.code": { section: "MSI §4", title: "Mediated Sign-In" },
  "account.revoke": { section: "§4.6", title: "Revocation" },
  "website.ratelimit": { section: "§6", title: "Web browsing" },
  "website.join": { section: "§6", title: "Joining a browser" },
  "api.call": { section: "§7", title: "API" },
  "mcp.call": { section: "§7", title: "MCP" },
  "conversation.request": { section: "§8.2", title: "Conversation" },
  "conversation.start": { section: "§8.3", title: "Conversation" },
  "conversation.opened": { section: "§8.3", title: "Conversation" },
  "conversation.send": { section: "§8.3", title: "Conversation" },
  "conversation.read": { section: "§8.5", title: "Reading events" },
  "conversation.status": { section: "§8.7", title: "Status and responder" },
  "conversation.handoff": { section: "§8.9", title: "Handoff" },
  "conversation.direct": { section: "§8.10", title: "Direct Conversation" },
  "conversation.close": { section: "§8.12", title: "Closing" },
  "feedback.send": { section: "§9.3", title: "Feedback" },
  "operation.approval_required": { section: "Ops §4", title: "Asking for approval" },
  "operation.decided": { section: "Ops §5", title: "The User's approval" },
  "operation.sent": { section: "Ops §6", title: "Sending the approval" }
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
    // Operations a Company returned, wherever (Ops 4), and the User's answer (Ops 5): ids and revision, never the summary or terms.
    poppy_protocol_operation_new: `AFTER INSERT ON poppy_approvals WHEN new.terms IS NOT NULL BEGIN
      INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result)
      VALUES (new.issuer, new.issuer, ${SQL_NOW}, 'operation.approval_required', 'info',
        'Operation ' || substr(CAST(coalesce(json_extract(new.request, '$.call.approval.operation_id'), json_extract(new.request, '$.approval.operation_id')) AS TEXT), 1, 64)
          || ' revision ' || substr(CAST(coalesce(json_extract(new.request, '$.call.approval.revision'), json_extract(new.request, '$.approval.revision')) AS TEXT), 1, 64),
        'Shown to the User on an approval card');
    END`,
    poppy_protocol_operation_decided: `AFTER UPDATE OF status ON poppy_approvals
      WHEN new.terms IS NOT NULL AND old.status = 'pending' AND new.status IN ('declined', 'executing') BEGIN
      INSERT INTO poppy_protocol_log (key, issuer, at, step, outcome, summary, result)
      VALUES (new.issuer, new.issuer, ${SQL_NOW}, 'operation.decided', 'info',
        'Operation ' || substr(CAST(coalesce(json_extract(new.request, '$.call.approval.operation_id'), json_extract(new.request, '$.approval.operation_id')) AS TEXT), 1, 64),
        CASE new.status WHEN 'declined' THEN 'Declined by the User, on their card: never sent' ELSE 'Approved by the User, on their card: sending the approval' END);
    END`
  };
  // Operations 1's (0.1, 0.2), on tables store.ts drops: gone with them, and by name.
  for (const name of ["poppy_protocol_operation_change", "poppy_protocol_operation_approved"]) sql.exec(`DROP TRIGGER IF EXISTS ${name}`);
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

/**
 * What a Company's log is kept under: its issuer once discovery accepted it,
 * else the https origin of the domain discovery refused, which joins the log
 * of an issuer at that origin. Never a bare domain.
 */
type LogKey = Issuer | Origin;

type Row = {
  readonly key: LogKey;
  readonly issuer: Issuer | null;
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
  // The same allowlisted fields, counted on the wide event of the work that made the request (src/log.ts).
  recordPoppyExchange({ issuer: row.issuer, step: literal(row.step), status: row.status ?? null, error: code(row.error) ?? null, outcome: literal(row.outcome) });
}

/**
 * Write a row without ever failing the exchange it describes: the log is a
 * view, and a request must not fail because its record couldn't be kept.
 */
function safely(write: () => void): void {
  try {
    write();
  } catch (error) {
    reportError(error, { source: literal("poppy.protocol_log"), severe: false });
  }
}

/** What a status and error code say, in a few words. */
function answered(status: number, error: string | null): string {
  return error ? `${status} ${error}` : String(status);
}

// ---------------------------------------------------------------- Discovery (§3)

const VERDICT: Record<string, string> = { valid: "valid", invalid: "invalid", indeterminate: "indeterminate (not checked)" };

/** The host a key names, for a log with no issuer: `https://shop.example` is shop.example. */
function keyHost(key: string): string {
  return key.replace(/^https:\/\//, "");
}

/**
 * Why a document got no answer, as the other unanswered lines say it:
 * `No answer (timeout after 10 s)`, `No answer (network)`, or the
 * validator's reason it wasn't fetched.
 */
function unanswered(report: CompanyReport, kind: CompanyReport["documents"][number]["kind"]): string {
  const message = report.messages.find((item) => item.document === kind && item.id.startsWith("http-"));
  if (!message) return "No answer";
  const timedOut = /timed out after (\d+) seconds/.exec(message.text);
  if (timedOut) return `No answer (timeout after ${timedOut[1]} s)`;
  return `No answer (${message.id === "http-failed" ? "network" : (token(message.id) ?? "refused")})`;
}

/**
 * Discovery for one domain, from the validator's report: each document it
 * fetched, then the verdict. Keyed by the issuer once discovery accepted the
 * Company, else by the domain's https origin (which joins the log of an
 * issuer at that origin), never by an issuer a document claims, so a
 * document claiming another Company's issuer can't write into that
 * Company's log.
 */
export function recordDiscovery(sql: Sql, domain: string, report: CompanyReport | undefined, company: { readonly issuer?: Issuer } | null): void {
  safely(() => {
    const issuer = company?.issuer ?? null;
    // A "domain" that isn't a host name has no Company to show it under.
    const key: LogKey | null = issuer ?? domainOrigin(domain);
    if (!key) return;
    if (!report) {
      insert(sql, { key, issuer, step: "discovery.verdict", outcome: "failed", summary: `Discovery of ${label(keyHost(key), 253) ?? "the domain"}`, result: "No report: discovery stopped before the validator ran" });
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
          status === null ? unanswered(report, document.kind) : String(status),
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
      // `checkedAgainst` is the validator's own name for the profile, such as "Poppy 0.3".
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
  refresh_token: "refresh_token",
  authorization_code: "authorization_code",
  "urn:ietf:params:oauth:grant-type:device_code": "device_code",
  "https://personalagentprotocol.org/grant/mediated-sign-in": "mediated"
};

export type OauthAttempt = {
  readonly endpoint: string;
  /** The form we sent, read only for the fields named here: never a token, code, verifier, credential or assertion. */
  readonly form: Readonly<Record<string, string>>;
  readonly dpop: boolean;
  /** Whether the proof carried the server's nonce. */
  readonly nonce: boolean;
};

/** What happened after the answer: the client tried again, or will wait. */
export type Followup =
  | { readonly kind: "nonce" }
  | { readonly kind: "wait"; readonly ms: number; readonly retrying: boolean }
  | { readonly kind: "refresh" }
  | { readonly kind: "restart" };

function followup(next: Followup | undefined): string | null {
  if (!next) return null;
  switch (next.kind) {
    case "nonce":
      return "sending again with the Company's DPoP-Nonce and a new proof";
    case "wait": {
      const wait = `Retry-After ${Math.ceil(next.ms / 1000)} s`;
      return next.retrying ? `${wait}: waiting, then sending again with a new Session JWT` : `${wait}: too long to wait inline; the job tries again later`;
    }
    case "refresh":
      return "getting a new access token with the refresh token, then sending again once";
    case "restart":
      return "starting a new Session, then sending again once";
  }
}

function oauthStep(company: Company, attempt: OauthAttempt): { step: ProtocolStep; summary: string } {
  const form = attempt.form;
  const scope = scopeText(form.scope);
  const resource = bareUrl(form.resource);
  const proof = attempt.dpop ? `DPoP proof${attempt.nonce ? " with nonce" : ""}` : null;
  const extras = [scope ? `scope ${scope}` : null, resource ? `resource ${resource}` : null];
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(", ");
  // Every request to the issuer carries the Session header (5.2), which names the client (4.1).
  const session = "Session header";
  if (attempt.endpoint === company.endpoints.deviceAuthorization) {
    return { step: "signin.device.start", summary: join("Device authorization request", ...extras, session) };
  }
  if (attempt.endpoint === company.endpoints.revocation) {
    return { step: "account.revoke", summary: join("Revoke the refresh token", token(form.token_type_hint) ? `token_type_hint ${form.token_type_hint}` : null, session) };
  }
  const grant = GRANTS[form.grant_type ?? ""] ?? null;
  switch (grant) {
    case "refresh_token":
      return { step: "token.refresh", summary: join("Get an access token: refresh_token grant", ...extras, session, proof) };
    case "authorization_code":
      return { step: "signin.direct.exchange", summary: join("Exchange the authorization code: authorization_code grant with the PKCE verifier and redirect_uri", session, proof) };
    case "device_code":
      return { step: "signin.device.poll", summary: join("Poll: device_code grant", session, proof) };
    case "mediated": {
      if ("one_time_code" in form) return { step: "signin.mediated.code", summary: join("Send the one-time code, never recorded, with its sign_in_id", session, proof) };
      // The credential fields are the Company's; their names are counted, their values never read.
      const fields = Object.keys(form).filter((name) => !["grant_type", "client_id", "scope", "resource", "sign_in_id", "one_time_code"].includes(name)).length;
      return { step: "signin.mediated.credentials", summary: join(`Send the sign-in form: ${fields} field${fields === 1 ? "" : "s"}, values never recorded`, ...extras, session, proof) };
    }
    default:
      return { step: "token.other", summary: join(`Token request${token(form.grant_type, 100) ? `: ${form.grant_type}` : ""}`, session, proof) };
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
  const type = token(body.token_type);
  if (type) parts.push(`${type} token`);
  const expires = seconds(body.expires_in);
  if (expires !== null) parts.push(`expires in ${expires} s`);
  // RFC 6749 §5.1: a missing `scope` means the scope requested (N6).
  parts.push(typeof body.scope !== "string" ? "no scope in the answer" : scopeText(body.scope) ? `scope ${scopeText(body.scope)}` : "no scopes");
  if (typeof body.refresh_token === "string") parts.push(step === "token.refresh" ? "refresh token rotated" : "refresh token issued");
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

// ---------------------------------------------------------------- APIs, MCP, conversations, the browser join, feedback

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

/** A message we send: its id, author and which fields it has, never their contents. */
function messageFields(body: unknown): string | null {
  if (!isObj(body) || !isObj(body.message)) return null;
  const message = body.message;
  const fields = ["text", "data", "context", "approval"].filter((field) => message[field] !== undefined);
  const id = label(message.id);
  const author = writtenBy(message);
  return [id ? `message ${id}` : "message", author ? `author ${author}` : null, fields.length ? `with ${fields.join(", ")}` : null].filter(Boolean).join(" ");
}

/** The approval a request carries (Ops 6): `Poppy-Approval`, MCP's `_meta`, or a message's `approval`; ids only. */
function approvalOf(request: ResourceRequest): string | null {
  const header = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === "poppy-approval")?.[1];
  const fromHeader = header ? { operation: /operation_id="([^"]*)"/.exec(header)?.[1], revision: /revision="([^"]*)"/.exec(header)?.[1] } : null;
  const body = isObj(request.body) ? request.body : {};
  const meta = isObj(body.params) && isObj(body.params._meta) ? body.params._meta["personalagentprotocol.org/approval"] : undefined;
  const message = isObj(body.message) ? body.message.approval : undefined;
  const json = isObj(meta) ? meta : isObj(message) ? message : null;
  const found = fromHeader ?? (json ? { operation: json.operation_id, revision: json.revision } : null);
  if (!found) return null;
  const operation = label(found.operation);
  const revision = label(found.revision);
  return operation ? `approval of ${operation}${revision ? ` revision ${revision}` : ""}` : "an approval";
}

function classify(company: Company, request: ResourceRequest, url: URL): { step: ProtocolStep; summary: string; url: string | null } {
  const at = bareUrl(url);
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(", ");
  const approval = approvalOf(request);
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
    if (conversation.length === 2 && action === "messages") {
      return { step: approval ? "operation.sent" : "conversation.send", summary: join(`Send to ${id ?? "a conversation"}`, messageFields(request.body), waitOf(url), url.searchParams.has("cursor") ? "from the saved cursor" : null), url: at };
    }
    if (conversation.length === 2 && action === "events") {
      const stream = (request.accept ?? "").includes("text/event-stream");
      return { step: "conversation.read", summary: join(`Read events of ${id ?? "a conversation"}`, url.searchParams.has("cursor") ? "from the saved cursor" : "from the start", waitOf(url), stream ? "stream or JSON" : null), url: at };
    }
    if (conversation.length === 2 && action === "handoff") return { step: "conversation.handoff", summary: `Hand ${id ?? "the conversation"} off to a person, with {}`, url: at };
    if (conversation.length === 2 && action === "close") return { step: "conversation.close", summary: `Close ${id ?? "the conversation"}, with {}`, url: at };
    return { step: "conversation.request", summary: `${request.method} a conversation endpoint`, url: at };
  }
  const join_ = below(company.web?.browserSessionEndpoint, url);
  if (join_ && join_.length === 1 && join_[0] === "authorize") {
    return { step: "website.join", summary: "Authorize the browser's one-time code, never recorded, for this Session", url: at };
  }
  if (below(company.feedback?.endpoint, url)?.length === 0) {
    const kind = isObj(request.body) ? token(request.body.type) : null;
    return { step: "feedback.send", summary: join("Send feedback", kind ? `type ${kind}` : null), url: at };
  }
  const mcp = company.apis.find((api) => api.type === "mcp" && bareUrl(api.url) === at);
  if (mcp) {
    const body = isObj(request.body) ? request.body : {};
    const method = label(body.method, 100);
    const tool = method === "tools/call" && isObj(body.params) ? label(body.params.name, 100) : null;
    return { step: approval ? "operation.sent" : "mcp.call", summary: join(`JSON-RPC ${method ?? "request"}${tool ? ` ${tool}` : ""}`, approval), url: at };
  }
  const named = apiNamer?.(request.method, url) ?? null;
  const operationId = named ? label(named.operation, 100) : null;
  const path = named ? label(named.path, 200) : null;
  const template = named && path && bareUrl(named.base) ? `${bareUrl(named.base)!.replace(/\/+$/, "")}${path}` : at;
  const idempotent = Object.keys(request.headers ?? {}).some((name) => name.toLowerCase() === "idempotency-key");
  return {
    step: approval ? "operation.sent" : "api.call",
    summary: join(operationId && path && operationId !== `${request.method} ${path}` ? `${operationId} (${request.method} ${path})` : `${request.method} ${path ?? url.pathname}`, idempotent ? "Idempotency-Key" : null, approval),
    url: template
  };
}

/** How a request was authorized: the Session header alone, or with a Bearer or DPoP access token (5.2, 4.5). */
export type ResourceAuth = { readonly token: "none" | "Bearer" | "DPoP"; readonly nonce: boolean };

/** One request to a Company resource (API, MCP, conversation, browser join, feedback) and its answer. */
export function recordResource(
  sql: Sql,
  company: Company,
  request: ResourceRequest,
  auth: ResourceAuth,
  answer: { readonly status: number; readonly error: string | null } | { readonly failed: string } | { readonly refused: string },
  next?: Followup
): void {
  safely(() => {
    const url = URL.canParse(request.url) ? new URL(request.url) : null;
    if (!url) return;
    const { step, summary, url: shown } = classify(company, request, url);
    const how = auth.token === "none" ? "Session header, signed out" : auth.token === "Bearer" ? "Session header and Bearer token" : `Session header and DPoP token${auth.nonce ? ", nonce" : ""}`;
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

/** A wait on the Company's shared limit before a request (5.6): every agent's `Retry-After`, through `CompanyLimiter`. */
export function recordLimitWait(sql: Sql, issuer: Issuer, ms: number, waited: boolean): void {
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
export function recordPageLimit(sql: Sql, issuer: Issuer, status: number, ms: number | null, retrying: boolean): void {
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

/** `poppy_protocol_log`'s columns, as `migrateProtocolLog` declares them. */
export const protocolLogTable = table("poppy_protocol_log", {
  seq: integer,
  key: text,
  issuer: nullable(textOf(issuerDecoder)),
  at: integer,
  step: text,
  method: nullable(text),
  url: nullable(text),
  status: nullable(integer),
  error: nullable(text),
  outcome: text,
  summary: text,
  result: text
});
const logRow = protocolLogTable.row;
type LogRow = RowOf<typeof logRow>;

/** A Company in the index: `issuer` is `MAX(issuer)` over its rows, the counts are aggregates. */
const indexRow = object({ key: text, issuer: nullable(textOf(issuerDecoder)), count: integer, last_seq: integer, last_at: integer });

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

type Names = (issuer: Issuer) => { readonly name: string; readonly domain: string | null };

/** The Companies with a log, the most recently active first. */
export function protocolIndex(sql: Sql, names: Names): Extract<PoppyServerFrame, { type: "poppy.protocol.index" }> {
  const companies: ProtocolCompany[] = rows(
    sql,
    indexRow,
    "SELECT key, MAX(issuer) AS issuer, COUNT(*) AS count, MAX(seq) AS last_seq, MAX(at) AS last_at FROM poppy_protocol_log GROUP BY key ORDER BY last_seq DESC"
  ).map((row) => {
    const known = row.issuer ? names(row.issuer) : { name: keyHost(row.key), domain: keyHost(row.key) };
    return { key: row.key, company: known.name, domain: known.domain, issuer: row.issuer, count: row.count, lastSeq: row.last_seq, lastAt: row.last_at };
  });
  return { type: "poppy.protocol.index", companies };
}

/** One Company's log, oldest first. */
export function protocolLog(sql: Sql, key: string, names: Names): Extract<PoppyServerFrame, { type: "poppy.protocol" }> {
  const logged = rows(sql, logRow, "SELECT seq, key, issuer, at, step, method, url, status, error, outcome, summary, result FROM poppy_protocol_log WHERE key = ? ORDER BY seq", key);
  const issuer = logged.find((row) => row.issuer)?.issuer ?? null;
  const known = issuer ? names(issuer) : { name: keyHost(key), domain: keyHost(key) };
  return { type: "poppy.protocol", key, company: known.name, domain: known.domain, issuer, entries: logged.map(entry) };
}
