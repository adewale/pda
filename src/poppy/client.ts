import {
  discover,
  isCompany,
  tokenHostAllowed,
  DiscoveryError,
  type Company,
  type WebsiteOnly
} from "./discovery";
import { POPPY_TIMEOUTS, raceAbort, readLimited, timeoutError, withDeadline, type Fetcher, type PoppyTimeouts } from "./fetch";
import { isObject, parseStrictJson, type Json } from "./json";
import { boolean, number, object, optional, string, tryDecode, type Decoded } from "../decode";
import {
  clientAssertion,
  dpopProof,
  newDpopKey,
  randomId,
  sessionAssertion,
  type DpopKey
} from "./jwt";
import { currentKey, readIdentity, type AgentIdentity } from "./keys";
import { recordDiscovery, recordLimitWait, recordOauth, recordPageLimit, recordResource, type Followup } from "./protocol-log";
import { found, one, rows, type RowOf } from "../rows";
import { accountsTable, domainsTable, Sealer, sessionsTable, userIdsTable, type Sql } from "./store";
import type { Card, DirectUpdate } from "./wire";
import type { CheckedApiRequest } from "./apis";
import { companyErrorCode, type KnownErrorCode, type PoppyErrorCode } from "./error-codes";
import type { EndpointRequest } from "./outgoing";
import type { Issuer } from "./issuer";
import { FOREIGN_TEXT, type ForeignText } from "../log";

/** What the Poppy client needs from the Durable Object it runs in. */
export type PoppyHost = {
  readonly env: Env;
  readonly sql: Sql;
  readonly fetcher: Fetcher;
  /** Show or update a card in the person's chat page. */
  readonly showCard: (card: Card) => Promise<void>;
  /** Tell the model something happened, at most once per `operationId`. */
  readonly notifyModel: (text: string, operationId: string) => Promise<void>;
  /** Run a durable job later; the same `id` replaces an earlier one. */
  readonly schedule: (fn: JobName, at: number, payload: Json, id: string) => Promise<void>;
  /** Whether a durable job with this `id` is waiting or running. */
  readonly hasJob: (id: string) => boolean;
  /** Push live updates for an open Direct Conversation to the page. */
  readonly pushDirect: (update: DirectUpdate) => void;
  /** The person's situation, for conversation `context` (spec 7.4). */
  readonly userContext: () => {
    locale?: string;
    time_zone?: string;
    user_available: boolean;
  };
  /** Wait, in ms; tests make it instant. */
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Now, in epoch ms, for waits and schedules: rate limits, polling and
   * operation tracking. Tests run it on a fake clock that `sleep` advances.
   */
  readonly now: () => number;
  /** How long to wait on a Company; `POPPY_TIMEOUTS` unless a test shortens them. */
  readonly timeouts?: PoppyTimeouts;
};

export type JobName = "poppy-read" | "poppy-device" | "poppy-operation" | "poppy-revoke" | "poppy-signin-expiry";

/**
 * An OAuth or Poppy error from a Company, with its code (spec 4.2, 6, 7.13).
 * Its message is for the model and the User, and is often built from what
 * the Company sent (its `error_description`, its body), so a wide event
 * records only its class and code (`ForeignText`, src/log.ts).
 */
export class PoppyError extends Error implements ForeignText {
  override name = "PoppyError";
  readonly [FOREIGN_TEXT] = true as const;
  constructor(
    readonly code: PoppyErrorCode,
    message: string,
    readonly status: number,
    readonly detail: {
      readonly scope?: string;
      readonly retryAfter?: number;
      readonly body?: Json;
      /** The extension an `extension_required` error names (spec 3.3). */
      readonly extension?: string;
    } = {}
  ) {
    super(message);
  }

  /** Whether the code is one of these. Only codes we or the draft define can be named, so a misspelt one is a type error. */
  is(...codes: readonly KnownErrorCode[]): boolean {
    return (codes as readonly string[]).includes(this.code);
  }
}

/** Whether `error` is a `PoppyError` with one of these codes. */
export function hasCode(error: unknown, ...codes: readonly KnownErrorCode[]): error is PoppyError {
  return error instanceof PoppyError && error.is(...codes);
}

/**
 * What a request to a Company's API that ended in an error got back: `none`,
 * no answer at all (a timeout, or the network failed), so it may or may not
 * have reached the Company; or the HTTP status the API answered with. An
 * error with no mark never reached the API: the agent refused it, or a token
 * couldn't be had. An approved write's receipt says which (operations.ts).
 */
export type RequestAnswer = number | "none";
const answers = new WeakMap<object, RequestAnswer>();

/** Mark `error` with what its request got back, and return it. */
export function withAnswer<T>(error: T, answer: RequestAnswer): T {
  if (typeof error === "object" && error !== null) answers.set(error, answer);
  return error;
}

/** What the request that threw `error` got back, if it reached a Company's API. */
export function answerOf(error: unknown): RequestAnswer | undefined {
  return typeof error === "object" && error !== null ? answers.get(error) : undefined;
}

/** The Company asked us to wait longer than we hold a request open for. */
export class RateLimitedError extends PoppyError {
  constructor(readonly waitMs: number) {
    super("rate_limited", `The company asked us to wait ${Math.ceil(waitMs / 1000)} s`, 429, {
      retryAfter: Math.ceil(waitMs / 1000)
    });
  }
}

/**
 * Resolves Direct Sign-Ins whose code exchange was interrupted (4.5).
 * `signin.ts` registers it, so this module needn't import that one.
 */
let signInRecovery: ((client: PoppyClient, issuer: Issuer) => Promise<void>) | undefined;

export function registerSignInRecovery(recover: (client: PoppyClient, issuer: Issuer) => Promise<void>): void {
  signInRecovery = recover;
}

/** Longest `Retry-After` we wait out inline; longer ones fail the call. */
const INLINE_WAIT_MS = 5_000;
/** Renew a Session Token this long before it expires. */
const RENEW_EARLY_MS = 30_000;

/**
 * A token response (spec 4.2, RFC 6749 5.1), decoded whole: a member of the
 * wrong type is a malformed response, not a value to coerce. `signed_in`
 * and `scope` may be absent (the draft doesn't mark them required, N6):
 * absent `signed_in` is a signed-out Session.
 */
export const tokenResponse = object({
  access_token: string,
  token_type: optional(string),
  expires_in: number,
  scope: optional(string),
  session_id: string,
  signed_in: optional(boolean),
  refresh_token: optional(string),
  refresh_token_expires_in: optional(number)
});
type TokenResponse = Decoded<typeof tokenResponse>;

const sessionRow = sessionsTable.pick("issuer", "label", "session_id", "account", "signed_in", "scope");
type SessionRow = RowOf<typeof sessionRow>;

const accountRow = accountsTable.pick("issuer", "account", "token", "scope", "expires_at");
export type AccountRow = RowOf<typeof accountRow>;

/** A Session Token in memory, bound to the DPoP key that was current when issued. */
type HeldToken = {
  readonly value: string;
  readonly type: "DPoP" | "Bearer";
  readonly expiresAt: number;
  readonly scope: string;
  readonly signedIn: boolean;
  readonly keyThumbprint: string | null;
};

/** How a request authenticates at a Company resource. */
export type TokenOptions = {
  /** Which Session: tasks running in parallel use different labels. */
  readonly label?: string;
  /** RFC 8707 `resource`, for an entry that names one (spec 4.3). */
  readonly resource?: string;
  /** Ask for fewer scopes than the Session has, e.g. read-only lookups. */
  readonly scope?: string;
  /** A Bearer token for one MCP server; `resource` is its URL (spec 4.3). */
  readonly bearer?: boolean;
};

export function scopeSet(scope: string | undefined | null): Set<string> {
  return new Set((scope ?? "").split(" ").filter(Boolean));
}

export function covers(granted: string | null | undefined, needed: Iterable<string>): boolean {
  const have = scopeSet(granted);
  for (const scope of needed) if (!have.has(scope)) return false;
  return true;
}

/**
 * The scope a token response granted. Stock OAuth servers leave `scope` out
 * when it is what was asked for, which RFC 6749 §5.1 allows, so an omitted
 * `scope` means `requested` (docs/spec-issues.md, N6). A grant that asked for
 * none passes what the Session or Account Token already held; a signed-out
 * token has no scopes (4.2).
 */
export function grantedScope(response: { readonly scope?: unknown; readonly signed_in?: unknown }, requested: string): string {
  if (typeof response.scope === "string") return response.scope;
  return response.signed_in === false ? "" : requested;
}

function withScope<T extends TokenResponse>(response: T, requested: string): T {
  return { ...response, scope: grantedScope(response, requested) };
}

/** `WWW-Authenticate: DPoP error="…", scope="…"` (RFC 6750, RFC 9449). */
export function parseWwwAuthenticate(header: string | null): { error?: string; scope?: string } {
  if (!header) return {};
  const params: Record<string, string> = {};
  // A quoted-string may hold quoted-pairs (RFC 9110 §5.6.4), such as `\"` in a description.
  for (const match of header.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) params[match[1]!] = match[2]!.replace(/\\(.)/g, "$1");
  return {
    ...(params.error ? { error: params.error } : {}),
    ...(params.scope ? { scope: params.scope } : {})
  };
}

/** RFC 9110 §5.6.7 HTTP-date: IMF-fixdate, and the obsolete RFC 850 and asctime forms recipients must also read. */
const HTTP_DATE = [
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/
];

/**
 * `Retry-After` (RFC 9110 §10.2.3) in ms from `now`: delay-seconds, or an
 * HTTP-date (zero once it has passed). Anything else is no `Retry-After` at
 * all; `Date.parse` alone would read junk such as `:0` as a date long past,
 * and so retry at once.
 */
export function retryAfterMs(response: Response, now: number): number | null {
  const header = response.headers.get("Retry-After")?.trim();
  if (!header) return null;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  if (!HTTP_DATE.some((form) => form.test(header))) return null;
  // asctime has no zone; it is GMT.
  const at = Date.parse(HTTP_DATE[2]!.test(header) ? `${header} GMT` : header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** `RateLimit` (IETF draft): both `remaining=, reset=` and `r=;t=` forms. */
export function parseRateLimit(header: string | null): { remaining: number; reset: number } | null {
  if (!header) return null;
  const remaining = /(?:remaining=|\br=)(\d+)/.exec(header);
  const reset = /(?:reset=|\bt=)(\d+)/.exec(header);
  return remaining && reset ? { remaining: Number(remaining[1]), reset: Number(reset[1]) } : null;
}

/** Why a request got no answer, for the protocol log: our deadline, or the network. */
function noAnswer(error: unknown): string {
  return error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
}

async function readJson(response: Response, signal: AbortSignal): Promise<Json> {
  const text = await readLimited(response, 2_000_000, signal);
  if (!text) return null;
  try {
    return parseStrictJson(text);
  } catch {
    return null;
  }
}

/**
 * The Poppy Personal Agent client for one person. Everything a Company sees
 * from this person goes through here: their User IDs, Sessions, DPoP keys and
 * tokens. Model-facing tools and the chat page call into it; they never see
 * tokens, keys, codes or credentials.
 */
export class PoppyClient {
  readonly host: PoppyHost;
  readonly identity: AgentIdentity;
  readonly sealer: Sealer;
  /** Per-Company DPoP keys, generated on first use and never stored. */
  readonly #dpopKeys = new Map<string, Promise<DpopKey>>();
  /** Session Tokens by issuer, label, resource, scope and kind. */
  readonly #tokens = new Map<string, HeldToken>();
  /** The latest `DPoP-Nonce` from each server origin. */
  readonly #nonces = new Map<string, string>();
  /**
   * One token-endpoint exchange at a time per Company. Account Tokens can
   * rotate on use, so two parallel renewals (say, a send and a background
   * read) would use one twice (spec 4.8).
   */
  readonly #locks = new Map<string, Promise<unknown>>();
  /**
   * Steps this object has started and not finished: a confirm, a code
   * exchange. Memory only, so after a restart the stored state of such a
   * step, with no entry here, means it was interrupted and is recovered.
   */
  readonly inFlight = new Set<string>();

  #serial<T>(issuer: Issuer, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(issuer) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.#locks.set(issuer, next.catch(() => undefined));
    return next;
  }

  /**
   * Run `work` with no other token-endpoint exchange for this Company beside
   * it: renewals and sign-ins with an Account Token wait until it is done.
   * Signing out (signout.ts) runs so, so no renewal uses the account, or
   * renews its Sessions, while the revocation is under way. `work` must not
   * itself ask for a token.
   */
  exclusive<T>(issuer: Issuer, work: () => Promise<T>): Promise<T> {
    return this.#serial(issuer, work);
  }

  constructor(host: PoppyHost) {
    this.host = host;
    this.identity = readIdentity(host.env);
    this.sealer = new Sealer(host.env);
  }

  get sql(): Sql {
    return this.host.sql;
  }

  get timeouts(): PoppyTimeouts {
    return this.host.timeouts ?? POPPY_TIMEOUTS;
  }

  /**
   * A Company's response body, up to `maxBytes`, within `timeouts.bodyMs`:
   * a body that stalls fails as a `PoppyFetchError` rather than hanging.
   */
  async readBody(response: Response, maxBytes = 2_000_000): Promise<string> {
    return withDeadline(this.timeouts.bodyMs, (signal) => readLimited(response, maxBytes, signal)).catch((error: unknown) => {
      throw timeoutError(error, `Reading ${response.url || "the response"}`);
    });
  }

  /** `readBody`, as JSON: null for an empty or unreadable one. */
  async readJson(response: Response): Promise<Json> {
    return withDeadline(this.timeouts.bodyMs, (signal) => readJson(response, signal)).catch((error: unknown) => {
      throw timeoutError(error, `Reading ${response.url || "the response"}`);
    });
  }

  // ---------------------------------------------------------------- Companies

  /** A Company by any of its domains, from cache or discovery (spec 3). */
  async company(domain: string): Promise<Company> {
    const found = await this.lookup(domain);
    if (!isCompany(found)) {
      throw new DiscoveryError(
        `${found.name} publishes poppy.json without auth, so it can only be browsed as a website`
      );
    }
    return found;
  }

  /**
   * A Company by domain: the documents discovery kept, until their HTTP cache
   * lifetime (bounded to between a minute and a day) is up, then discovery
   * again (spec 3 and 3.2: SHOULD cache by HTTP caching headers; the bounds
   * are the Guides'). Timed by the host's clock, like the client's waits.
   */
  async lookup(domain: string): Promise<Company | WebsiteOnly> {
    const key = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    const cached = one(
      this.sql,
      domainsTable.pick("company", "expires_at"),
      "SELECT company, expires_at FROM poppy_domains WHERE domain = ?",
      key
    );
    if (cached && cached.expires_at > this.host.now()) {
      return JSON.parse(cached.company) as Company | WebsiteOnly;
    }
    let discovered: Awaited<ReturnType<typeof discover>>;
    try {
      discovered = await discover(this.host.fetcher, domain);
    } catch (error) {
      // The protocol view shows a refused Company too, under its domain.
      if (error instanceof DiscoveryError) recordDiscovery(this.sql, key, error.report, null);
      throw error;
    }
    const { result, cacheSeconds } = discovered;
    recordDiscovery(this.sql, key, discovered.report, isCompany(result) ? result : null);
    this.sql.exec(
      "INSERT OR REPLACE INTO poppy_domains (domain, issuer, company, expires_at) VALUES (?, ?, ?, ?)",
      key,
      isCompany(result) ? result.issuer : null,
      JSON.stringify(result),
      this.host.now() + cacheSeconds * 1000
    );
    return result;
  }

  /** The most recently discovered document for an issuer. */
  companyByIssuer(issuer: Issuer): Company {
    const row = one(
      this.sql,
      domainsTable.pick("company"),
      "SELECT company FROM poppy_domains WHERE issuer = ? ORDER BY expires_at DESC LIMIT 1",
      issuer
    );
    if (!row) throw new DiscoveryError(`No company known for issuer ${issuer}`);
    return JSON.parse(row.company) as Company;
  }

  /**
   * The User ID for this person at one Company (spec 4.2): random, stored,
   * never derived from who they are. Domains that share an issuer share it.
   */
  userId(issuer: Issuer): string {
    const row = one(
      this.sql,
      userIdsTable.pick("user_id"),
      "SELECT user_id FROM poppy_user_ids WHERE issuer = ?",
      issuer
    );
    if (row) return row.user_id;
    const userId = randomId("usr_");
    this.sql.exec("INSERT INTO poppy_user_ids (issuer, user_id) VALUES (?, ?)", issuer, userId);
    return userId;
  }

  // ---------------------------------------------------------------- Keys

  dpopKey(issuer: Issuer): Promise<DpopKey> {
    let key = this.#dpopKeys.get(issuer);
    if (!key) {
      key = newDpopKey();
      this.#dpopKeys.set(issuer, key);
    }
    return key;
  }

  // ---------------------------------------------------------------- Rate limits

  #limiter(issuer: Issuer) {
    return this.host.env.CompanyLimiter.getByName(issuer);
  }

  /** Wait for the Company's shared limit, inline if short, else fail (spec 4.3). */
  async #respectLimit(issuer: Issuer): Promise<void> {
    const delay = await this.#limiter(issuer).delay(this.host.now());
    if (delay <= 0) return;
    recordLimitWait(this.sql, issuer, delay, delay <= INLINE_WAIT_MS);
    if (delay > INLINE_WAIT_MS) throw new RateLimitedError(delay);
    await this.host.sleep(delay);
  }

  /** Record what a response says about limits; returns ms to wait before retrying, if any. */
  async #observeLimits(issuer: Issuer, response: Response): Promise<number | null> {
    const limit = parseRateLimit(response.headers.get("RateLimit"));
    const now = this.host.now();
    if (limit) await this.#limiter(issuer).observe(limit.remaining, now + limit.reset * 1000);
    if (response.status !== 429 && response.status !== 503) return null;
    const wait = retryAfterMs(response, now);
    if (wait === null) return response.status === 429 ? 1_000 : null;
    await this.#limiter(issuer).blockUntil(now + wait);
    return wait;
  }

  /** The Company's shared limit, before a request that doesn't go through `resource()`: a website page. */
  async beforeRequest(company: Company): Promise<void> {
    await this.#respectLimit(company.issuer);
  }

  /**
   * A website page answered (spec 4.3): on 429 or 503, record its
   * `Retry-After` for every User's agent and wait it out inline when short,
   * returning true so the caller loads the page again. A longer wait throws
   * `RateLimitedError`; any other status returns false.
   */
  async pageLimited(company: Company, status: number, retryAfter: string | undefined): Promise<boolean> {
    if (status !== 429 && status !== 503) return false;
    const response = new Response(null, { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
    const wait = await this.#observeLimits(company.issuer, response);
    recordPageLimit(this.sql, company.issuer, status, wait, wait !== null && wait <= INLINE_WAIT_MS);
    if (wait === null) return false;
    if (wait > INLINE_WAIT_MS) throw new RateLimitedError(wait);
    await this.host.sleep(wait);
    return true;
  }

  // ---------------------------------------------------------------- Token endpoint

  /**
   * One request to the Company's token, device or revocation endpoint, with
   * our client assertion and (unless `dpop` is false) a DPoP proof. Nonces,
   * short `Retry-After` waits and fresh assertions on every attempt are
   * handled here. The client assertion's `aud` is the endpoint called; the
   * draft doesn't say (S1), and Companies differ, so at the device or
   * revocation endpoint an `invalid_client` gets one more try with the token
   * endpoint as `aud`, as RFC 7523 3 allows. Both name this Company, so
   * neither can be replayed at another.
   */
  async oauthRequest(
    company: Company,
    endpoint: string,
    params: () => Promise<Record<string, string>>,
    options: { dpop: boolean }
  ): Promise<{ status: number; body: Json; headers: Headers }> {
    const signing = await currentKey(this.host.env);
    // One retry for a new DPoP nonce, whenever it comes: after a 429 too.
    let nonceRetried = false;
    let audience = endpoint;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.#respectLimit(company.issuer);
      // Each attempt gets new assertions and a new proof: Companies reject a reused jti.
      const fields = await params();
      const form = new URLSearchParams({
        ...fields,
        client_id: this.identity.clientId,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await clientAssertion(signing, this.identity.clientId, audience)
      });
      const headers = new Headers({
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      });
      const origin = new URL(endpoint).origin;
      // For the protocol log, which reads only the fields it names (never a token, code, verifier or assertion).
      const logged = { endpoint, form: fields, dpop: options.dpop, nonce: options.dpop && this.#nonces.has(origin) };
      if (options.dpop) {
        const nonce = this.#nonces.get(origin);
        headers.set(
          "DPoP",
          await dpopProof(await this.dpopKey(company.issuer), {
            method: "POST",
            url: endpoint,
            ...(nonce ? { nonce } : {})
          })
        );
      }
      // One deadline for the answer and its body.
      const { response, body } = await withDeadline(this.timeouts.oauthMs, async (signal) => {
        const response = await raceAbort(
          this.host.fetcher(new Request(endpoint, { method: "POST", headers, body: form, redirect: "manual", signal })),
          signal
        );
        return { response, body: await readJson(response, signal) };
      }).catch((error: unknown) => {
        recordOauth(this.sql, company, logged, { failed: noAnswer(error) });
        throw timeoutError(error, endpoint);
      });
      const nonce = response.headers.get("DPoP-Nonce");
      if (nonce) this.#nonces.set(origin, nonce);
      const wait = await this.#observeLimits(company.issuer, response);
      const error = isObject(body) && typeof body.error === "string" ? body.error : undefined;
      const answer = { status: response.status, body };
      if (error === "use_dpop_nonce" && nonce && !nonceRetried) {
        recordOauth(this.sql, company, logged, answer, { kind: "nonce" });
        nonceRetried = true;
        continue;
      }
      if (error === "invalid_client" && response.status === 401 && audience !== company.endpoints.token) {
        recordOauth(this.sql, company, logged, answer);
        audience = company.endpoints.token;
        continue;
      }
      if (wait !== null) {
        const retrying = wait <= INLINE_WAIT_MS && attempt < 2;
        recordOauth(this.sql, company, logged, answer, { kind: "wait", ms: wait, retrying });
        if (!retrying) throw new RateLimitedError(wait);
        await this.host.sleep(wait);
        continue;
      }
      recordOauth(this.sql, company, logged, answer);
      return { status: response.status, body, headers: response.headers };
    }
    throw new PoppyError("rate_limited", "The company kept refusing the request", 429);
  }

  /** A token request that must succeed; OAuth errors become `PoppyError`s. */
  async tokenRequest(
    company: Company,
    params: () => Promise<Record<string, string>>,
    options: { dpop: boolean } = { dpop: true }
  ): Promise<TokenResponse> {
    const { status, body } = await this.oauthRequest(company, company.endpoints.token, params, options);
    if (status === 200 && isObject(body) && typeof body.access_token === "string") {
      const decoded = tryDecode(tokenResponse, body, "token response");
      if (!decoded.ok || !(decoded.value.expires_in > 0)) {
        throw new PoppyError("invalid_response", `The company's token response is malformed${decoded.ok ? ": expires_in isn't positive" : ` (${decoded.problem})`}`, status);
      }
      return decoded.value;
    }
    const code = isObject(body) && body.error !== undefined ? companyErrorCode(body.error, status) : "server_error";
    const description =
      isObject(body) && typeof body.error_description === "string" ? `: ${body.error_description}` : "";
    throw new PoppyError(code, `${company.name} refused the token request (${code})${description}`, status, {
      ...(body !== null ? { body } : {})
    });
  }

  // ---------------------------------------------------------------- Sessions

  session(issuer: Issuer, label: string): SessionRow | undefined {
    return one(
      this.sql,
      sessionRow,
      "SELECT issuer, label, session_id, account, signed_in, scope FROM poppy_sessions WHERE issuer = ? AND label = ?",
      issuer,
      label
    );
  }

  sessions(issuer?: Issuer): SessionRow[] {
    return issuer
      ? rows(this.sql, sessionRow, "SELECT * FROM poppy_sessions WHERE issuer = ?", issuer)
      : rows(this.sql, sessionRow, "SELECT * FROM poppy_sessions");
  }

  #saveSession(issuer: Issuer, label: string, response: TokenResponse, account: string | null): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO poppy_sessions (issuer, label, session_id, account, signed_in, scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      issuer,
      label,
      response.session_id,
      response.signed_in ? account : null,
      response.signed_in ? 1 : 0,
      response.scope ?? "",
      Date.now()
    );
  }

  /**
   * Stop using a Session, and drop its tokens: the next request starts a new
   * one. For a Session the Company may have signed in without our knowing,
   * which we never renew with the Session assertion: 4.2 renews a signed-in
   * Session with the Account Token, and an assertion's answer there is
   * undefined (spec-issues S5).
   */
  abandonSession(issuer: Issuer, label: string): void {
    this.#forgetSession(issuer, label);
  }

  /**
   * Before any token for a Company: resolve a Direct Sign-In whose code
   * exchange was interrupted (4.5), so a Session it may have signed in is
   * never renewed with the assertion. Cheap when there is none.
   */
  async #recoverSignIns(issuer: Issuer): Promise<void> {
    if (!signInRecovery) return;
    const pending = one(
      this.sql,
      found,
      "SELECT 1 AS found FROM poppy_signins WHERE issuer = ? AND status IN ('exchanging', 'exchanged', 'stored') LIMIT 1",
      issuer
    );
    if (pending) await signInRecovery(this, issuer);
  }

  #forgetSession(issuer: Issuer, label: string): void {
    this.sql.exec("DELETE FROM poppy_sessions WHERE issuer = ? AND label = ?", issuer, label);
    for (const key of [...this.#tokens.keys()]) {
      if (key.startsWith(`${issuer}|${label}|`)) this.#tokens.delete(key);
    }
  }

  // ---------------------------------------------------------------- Account Tokens

  account(issuer: Issuer, account: string): AccountRow | undefined {
    const row = one(
      this.sql,
      accountRow,
      "SELECT issuer, account, token, scope, expires_at FROM poppy_accounts WHERE issuer = ? AND account = ?",
      issuer,
      account
    );
    if (row && row.expires_at !== null && row.expires_at <= Date.now()) {
      this.deleteAccount(issuer, account);
      return undefined;
    }
    return row;
  }

  accounts(issuer?: Issuer): AccountRow[] {
    return issuer
      ? rows(this.sql, accountRow, "SELECT * FROM poppy_accounts WHERE issuer = ?", issuer)
      : rows(this.sql, accountRow, "SELECT * FROM poppy_accounts");
  }

  /**
   * The additional data an Account Token is sealed with: its issuer, the
   * User ID there and its account, so it opens only for its own account. A
   * token waiting to be revoked (signout.ts) keeps it.
   */
  accountContext(issuer: Issuer, account: string): string {
    return `account|${issuer}|${this.userId(issuer)}|${account}`;
  }

  /** The Account Token itself, decrypted only for a token-endpoint request. */
  async #accountToken(row: AccountRow): Promise<string> {
    const context = this.accountContext(row.issuer, row.account);
    const { plaintext, current } = await this.sealer.openChecked(row.token, context);
    // Sealed under TOKEN_ENC_KEY_PREVIOUS, or before values were versioned: seal it again under the current key.
    if (!current) {
      this.sql.exec(
        "UPDATE poppy_accounts SET token = ? WHERE issuer = ? AND account = ? AND token = ?",
        await this.sealer.seal(plaintext, context),
        row.issuer,
        row.account,
        row.token
      );
    }
    return plaintext;
  }

  /** Store a new or rotated Account Token at once, encrypted (spec 4.8). */
  async storeAccountToken(
    issuer: Issuer,
    account: string,
    token: string,
    scope: string,
    expiresInSeconds: number | undefined
  ): Promise<void> {
    const sealed = await this.sealer.seal(token, this.accountContext(issuer, account));
    this.sql.exec(
      `INSERT OR REPLACE INTO poppy_accounts (issuer, account, token, scope, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      issuer,
      account,
      sealed,
      scope,
      expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : null,
      Date.now()
    );
  }

  deleteAccount(issuer: Issuer, account: string): void {
    this.sql.exec("DELETE FROM poppy_accounts WHERE issuer = ? AND account = ?", issuer, account);
    // Sessions signed in to it continue signed out on their next renewal.
    for (const session of this.sessions(issuer)) {
      if (session.account === account) this.#forgetTokens(issuer, session.label);
    }
  }

  #forgetTokens(issuer: Issuer, label: string): void {
    for (const key of [...this.#tokens.keys()]) {
      if (key.startsWith(`${issuer}|${label}|`)) this.#tokens.delete(key);
    }
  }

  // ---------------------------------------------------------------- Session Tokens

  /**
   * A Session Token for one Session, from memory, by renewal, or by starting
   * a Session (spec 4.2, 4.8). After an eviction the DPoP key is new, so the
   * next token request binds a new token to it.
   */
  async token(company: Company, options: TokenOptions = {}): Promise<HeldToken> {
    await this.#recoverSignIns(company.issuer);
    const label = options.label ?? "main";
    const key = `${company.issuer}|${label}|${options.resource ?? ""}|${options.scope ?? ""}|${options.bearer ? "bearer" : "dpop"}`;
    const dpop = options.bearer ? null : await this.dpopKey(company.issuer);
    const usable = () => {
      const held = this.#tokens.get(key);
      return held &&
        held.expiresAt - RENEW_EARLY_MS > Date.now() &&
        (dpop === null || held.keyThumbprint === dpop.thumbprint)
        ? held
        : undefined;
    };
    const held = usable();
    if (held) return held;
    return this.#serial(company.issuer, async () => {
      // Another caller may have renewed it while this one waited.
      const renewed = usable();
      if (renewed) return renewed;
      return this.#renew(company, label, key, options, dpop);
    });
  }

  async #renew(
    company: Company,
    label: string,
    key: string,
    options: TokenOptions,
    dpop: DpopKey | null
  ): Promise<HeldToken> {
    const response = await this.#obtainToken(company, label, options);
    const token: HeldToken = {
      value: response.access_token,
      type: options.bearer ? "Bearer" : "DPoP",
      expiresAt: Date.now() + response.expires_in * 1000,
      scope: response.scope ?? "",
      signedIn: response.signed_in === true,
      keyThumbprint: dpop?.thumbprint ?? null
    };
    // The newest token for a Session replaces every older one (spec 4.3).
    this.#tokens.set(key, token);
    return token;
  }

  /** Drop a token the Company rejected, so the next call gets a new one. */
  dropToken(company: Company, options: TokenOptions = {}): void {
    this.#forgetTokens(company.issuer, options.label ?? "main");
  }

  async #obtainToken(company: Company, label: string, options: TokenOptions): Promise<TokenResponse> {
    const signing = await currentKey(this.host.env);
    const userId = this.userId(company.issuer);
    const extra = {
      ...(options.resource ? { resource: options.resource } : {}),
      ...(options.scope ? { scope: options.scope } : {})
    };
    const dpop = { dpop: !options.bearer };
    const session = this.session(company.issuer, label);
    const account = session?.account ? this.account(company.issuer, session.account) : undefined;

    // A signed-in Session renews with its Account Token.
    if (session && session.signed_in && account) {
      try {
        const response = withScope(
          await this.tokenRequest(
            company,
            async () => ({
              grant_type: "refresh_token",
              refresh_token: await this.#accountToken(account),
              session_id: session.session_id,
              ...extra
            }),
            dpop
          ),
          options.scope ?? account.scope
        );
        await this.#afterAccountUse(company, account.account, response);
        // A token narrowed for one lookup doesn't narrow the Session.
        this.#saveSession(company.issuer, label, options.scope ? { ...response, scope: session.scope } : response, account.account);
        return response;
      } catch (error) {
        if (!(error instanceof PoppyError)) throw error;
        if (error.is("invalid_grant")) {
          await this.#accountGone(company, account.account);
        } else if (error.is("invalid_session", "account_mismatch")) {
          this.#forgetSession(company.issuer, label);
          return this.#obtainToken(company, label, options);
        } else {
          throw error;
        }
      }
    }

    // A signed-out Session renews with our assertion; `invalid_session` starts a new one.
    const current = this.session(company.issuer, label);
    try {
      const response = withScope(
        await this.tokenRequest(
          company,
          async () => ({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: await sessionAssertion(
              signing,
              this.identity.clientId,
              userId,
              company.endpoints.token
            ),
            ...(current ? { session_id: current.session_id } : {}),
            // A signed-out token has no scopes (4.2), and some Companies reject
            // `scope` on this grant, so only `resource` narrows it.
            ...(options.resource ? { resource: options.resource } : {})
          }),
          dpop
        ),
        current?.scope ?? ""
      );
      this.#saveSession(company.issuer, label, response, null);
      return response;
    } catch (error) {
      if (
        current &&
        error instanceof PoppyError &&
        (error.is("invalid_session", "account_mismatch"))
      ) {
        this.#forgetSession(company.issuer, label);
        return this.#obtainToken(company, label, options);
      }
      throw error;
    }
  }

  /** After any use of an Account Token: a rotated one replaces it at once (spec 4.8). */
  async #afterAccountUse(company: Company, account: string, response: TokenResponse): Promise<void> {
    if (response.refresh_token) {
      const existing = this.account(company.issuer, account);
      await this.storeAccountToken(
        company.issuer,
        account,
        response.refresh_token,
        existing?.scope ?? response.scope ?? "",
        response.refresh_token_expires_in
      );
    }
  }

  /** `invalid_grant` for an Account Token: delete it, continue signed out, tell the User. */
  async #accountGone(company: Company, account: string): Promise<void> {
    this.deleteAccount(company.issuer, account);
    await this.host.showCard({
      id: `account-gone-${company.issuer}-${account}`,
      kind: "notice",
      company: company.name,
      domain: company.domain,
      open: true,
      text: `${company.name} has ended this agent's access to your account. Sign in again when a task needs it.`
    });
  }

  /**
   * Sign a Session in with an Account Token we already hold (spec 4.8), so
   * the User isn't asked again. Returns false when there is none that covers
   * `scopes`.
   */
  async signInWithAccount(
    company: Company,
    label: string,
    scopes: readonly string[],
    accountLabel?: string
  ): Promise<boolean> {
    await this.#recoverSignIns(company.issuer);
    return this.#serial(company.issuer, () => this.#signInWithAccount(company, label, scopes, accountLabel));
  }

  async #signInWithAccount(
    company: Company,
    label: string,
    scopes: readonly string[],
    accountLabel?: string
  ): Promise<boolean> {
    const candidates = accountLabel
      ? [this.account(company.issuer, accountLabel)].filter((row): row is AccountRow => !!row)
      : this.accounts(company.issuer);
    const account = candidates.find((row) => covers(row.scope, scopes));
    if (!account) return false;
    const session = this.session(company.issuer, label);
    // A Session signed in to another account can't switch: start a new one (4.4).
    const sessionId = session && (!session.signed_in || session.account === account.account) ? session.session_id : undefined;
    try {
      const response = withScope(
        await this.tokenRequest(company, async () => ({
          grant_type: "refresh_token",
          refresh_token: await this.#accountToken(account),
          ...(sessionId ? { session_id: sessionId } : {})
        })),
        account.scope
      );
      await this.#afterAccountUse(company, account.account, response);
      this.#forgetTokens(company.issuer, label);
      this.#saveSession(company.issuer, label, response, account.account);
      return true;
    } catch (error) {
      if (!(error instanceof PoppyError)) throw error;
      if (error.is("invalid_grant")) {
        await this.#accountGone(company, account.account);
        return false;
      }
      if (error.is("invalid_session", "account_mismatch")) {
        this.#forgetSession(company.issuer, label);
        return this.#signInWithAccount(company, label, scopes, account.account);
      }
      throw error;
    }
  }

  /**
   * Record a completed sign-in: Account Token, signed-in Session (spec 4.4).
   * Returns the account as it was when a step-up replaced its Account Token
   * with another, still holding the old token sealed, for the caller to
   * revoke (signout.ts); null when nothing was replaced.
   */
  async completeSignIn(
    company: Company,
    label: string,
    account: string,
    response: TokenResponse
  ): Promise<AccountRow | null> {
    const previous = this.account(company.issuer, account);
    // Compared before the new token is stored, so nothing awaits between storing it and the caller recording the old one.
    // One that won't open is taken as replaced: its revocation then says it can't be sent.
    const same = async (sealed: string, token: string) =>
      (await this.sealer.open(sealed, this.accountContext(company.issuer, account)).catch(() => null)) === token;
    const replaced = previous && response.refresh_token && !(await same(previous.token, response.refresh_token)) ? previous : null;
    if (response.refresh_token) {
      await this.storeAccountToken(
        company.issuer,
        account,
        response.refresh_token,
        response.scope ?? "",
        response.refresh_token_expires_in
      );
    }
    this.#forgetTokens(company.issuer, label);
    this.#saveSession(company.issuer, label, response, account);
    return replaced;
  }

  // ---------------------------------------------------------------- Resources

  /**
   * One request to a Company API, conversation or operations endpoint, with
   * the Session Token in `Authorization: DPoP` and a fresh proof (spec 4.3).
   * Nonces, `invalid_token` renewals and short `Retry-After` waits are
   * handled; other auth errors come back as `PoppyError`s. It takes only a
   * request one of the checking constructors made: an `EndpointRequest` to
   * an endpoint `poppy.json` names, or a `CheckedApiRequest` (apis.ts).
   */
  async resource(company: Company, outgoing: EndpointRequest | CheckedApiRequest, options: TokenOptions = {}): Promise<Response> {
    const request = outgoing.init();
    const url = new URL(request.url);
    const bearer = options.bearer === true;
    if (url.protocol !== "https:") {
      recordResource(this.sql, company, request, { bearer, nonce: false }, { refused: "not_https" });
      throw new PoppyError("invalid_request", "Refusing a non-HTTPS URL", 0);
    }
    // Session Tokens go only to the Company's own hosts (N10), whatever a description names.
    if (!tokenHostAllowed(company, url)) {
      recordResource(this.sql, company, request, { bearer, nonce: false }, { refused: "untrusted_host" });
      throw new PoppyError(
        "untrusted_host",
        `${url.hostname} isn't one of ${company.name}'s hosts (not listed in its poppy.json, nor under ${company.domain} or its poppy_domains), so it never gets a Session Token`,
        0
      );
    }
    let renewed = false;
    let restarted = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.#respectLimit(company.issuer);
      const token = await this.token(company, options);
      // Tokens never travel in a URL (spec 4.3), whatever a description or a model supplies.
      if (url.href.includes(token.value)) {
        recordResource(this.sql, company, request, { bearer, nonce: false }, { refused: "token_in_url" });
        throw new PoppyError("invalid_request", "Refusing a URL that contains a token", 0);
      }
      const auth = { bearer: token.type === "Bearer", nonce: token.type !== "Bearer" && this.#nonces.has(url.origin) };
      const log = (answer: Parameters<typeof recordResource>[4], next?: Followup) => recordResource(this.sql, company, request, auth, answer, next);
      const headers = new Headers(request.headers);
      headers.set("Accept", request.accept ?? "application/json");
      if (request.body !== undefined && !request.form) headers.set("Content-Type", "application/json");
      if (token.type === "Bearer") {
        headers.set("Authorization", `Bearer ${token.value}`);
      } else {
        const nonce = this.#nonces.get(url.origin);
        headers.set("Authorization", `DPoP ${token.value}`);
        headers.set(
          "DPoP",
          await dpopProof(await this.dpopKey(company.issuer), {
            method: request.method,
            url: url.href,
            accessToken: token.value,
            ...(nonce ? { nonce } : {})
          })
        );
      }
      // A deadline for the answer to start; the caller reads the body with `readBody`.
      const response = await withDeadline(this.timeouts.requestMs + (request.waitMs ?? 0), (signal) =>
        raceAbort(
          this.host.fetcher(
            new Request(url.href, {
              method: request.method,
              headers,
              // Never follow a redirect with this proof or token (Guides).
              redirect: "manual",
              ...(request.form ? { body: request.form } : request.body !== undefined ? { body: JSON.stringify(request.body) } : {})
            })
          ),
          signal
        )
      ).catch((error: unknown) => {
        log({ failed: noAnswer(error) });
        throw withAnswer(timeoutError(error, `${url.origin}${url.pathname}`), "none");
      });
      const nonce = response.headers.get("DPoP-Nonce");
      if (nonce) this.#nonces.set(url.origin, nonce);
      const wait = await this.#observeLimits(company.issuer, response);
      const challenge = parseWwwAuthenticate(response.headers.get("WWW-Authenticate"));
      if (wait !== null) {
        await response.body?.cancel();
        const retrying = wait <= INLINE_WAIT_MS && attempt < 3;
        log({ status: response.status, error: challenge.error ?? null }, { kind: "wait", ms: wait, retrying });
        if (!retrying) throw withAnswer(new RateLimitedError(wait), response.status);
        await this.host.sleep(wait);
        continue;
      }
      if (response.status === 401 && challenge.error === "use_dpop_nonce" && nonce) {
        await response.body?.cancel();
        log({ status: 401, error: challenge.error }, { kind: "nonce" });
        continue;
      }
      if (response.status === 401 && challenge.error === "invalid_token" && !renewed) {
        // Expired or revoked: get a new token and retry once (spec 6).
        await response.body?.cancel();
        log({ status: 401, error: challenge.error }, { kind: "renew" });
        this.dropToken(company, options);
        renewed = true;
        continue;
      }
      // An error's code from its body, for the log and the check below; never a stream, which may not end.
      const peek =
        response.status >= 400 && !(response.headers.get("Content-Type") ?? "").includes("text/event-stream")
          ? ((await this.readJson(response.clone()).catch(() => null)) as { error?: unknown } | null)
          : null;
      // Some Companies end a Session with `invalid_session` in the body rather
      // than 401 invalid_token, the only token error spec 6 lists for this
      // (spec-issues S13, N39): start a new Session and retry once.
      if ((response.status === 400 || response.status === 401) && !restarted && peek?.error === "invalid_session") {
        await response.body?.cancel();
        log({ status: response.status, error: "invalid_session" }, { kind: "restart" });
        this.#forgetSession(company.issuer, options.label ?? "main");
        restarted = true;
        continue;
      }
      log({ status: response.status, error: challenge.error ?? (typeof peek?.error === "string" ? peek.error : null) });
      if (challenge.error && (response.status === 401 || response.status === 403)) {
        await response.body?.cancel();
        throw withAnswer(
          new PoppyError(companyErrorCode(challenge.error, response.status), `${company.name}: ${challenge.error}`, response.status, {
            ...(challenge.scope ? { scope: challenge.scope } : {})
          }),
          response.status
        );
      }
      return response;
    }
    throw new PoppyError("server_error", `${company.name} kept refusing the request`, 0);
  }

  /** `resource()` for JSON endpoints: non-2xx bodies with an `error` become `PoppyError`s. */
  async resourceJson(
    company: Company,
    request: EndpointRequest | CheckedApiRequest,
    options: TokenOptions = {}
  ): Promise<{ status: number; body: Json; headers: Headers }> {
    const response = await this.resource(company, request, options);
    const body = await this.readJson(response);
    if (response.status >= 400) {
      const code = companyErrorCode(isObject(body) ? body.error : undefined, response.status);
      throw new PoppyError(code, `${company.name} returned ${code}`, response.status, {
        ...(body !== null ? { body } : {})
      });
    }
    return { status: response.status, body, headers: response.headers };
  }
}
