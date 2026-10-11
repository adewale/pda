import {
  discover,
  isCompany,
  tokenHostAllowed,
  DiscoveryError,
  type Company,
  type WebsiteOnly
} from "./discovery";
import { readLimited, type Fetcher } from "./fetch";
import { isObject, parseStrictJson, type Json } from "./json";
import {
  clientAssertion,
  dpopProof,
  newDpopKey,
  randomId,
  sessionAssertion,
  type DpopKey
} from "./jwt";
import { currentKey, readIdentity, type AgentIdentity } from "./keys";
import { one, rows, Sealer, type Sql } from "./store";
import type { Card } from "./wire";

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
  /** Push live updates for an open Direct Conversation to the page. */
  readonly pushDirect: (update: Json) => void;
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
};

export type JobName = "poppy-read" | "poppy-device" | "poppy-operation";

/** An OAuth or Poppy error from a Company, with its code (spec 4.2, 6, 7.13). */
export class PoppyError extends Error {
  override name = "PoppyError";
  constructor(
    readonly code: string,
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
let signInRecovery: ((client: PoppyClient, issuer: string) => Promise<void>) | undefined;

export function registerSignInRecovery(recover: (client: PoppyClient, issuer: string) => Promise<void>): void {
  signInRecovery = recover;
}

/** Longest `Retry-After` we wait out inline; longer ones fail the call. */
const INLINE_WAIT_MS = 5_000;
/** Renew a Session Token this long before it expires. */
const RENEW_EARLY_MS = 30_000;

type TokenResponse = {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope?: string;
  readonly session_id: string;
  readonly signed_in: boolean;
  readonly refresh_token?: string;
  readonly refresh_token_expires_in?: number;
};

type SessionRow = {
  issuer: string;
  label: string;
  session_id: string;
  account: string | null;
  signed_in: number;
  scope: string;
};

type AccountRow = {
  issuer: string;
  account: string;
  token: string;
  scope: string;
  expires_at: number | null;
};

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
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) params[match[1]!] = match[2]!;
  return {
    ...(params.error ? { error: params.error } : {}),
    ...(params.scope ? { scope: params.scope } : {})
  };
}

function retryAfterMs(response: Response, now: number): number | null {
  const header = response.headers.get("Retry-After");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** `RateLimit` (IETF draft): both `remaining=, reset=` and `r=;t=` forms. */
function parseRateLimit(header: string | null): { remaining: number; reset: number } | null {
  if (!header) return null;
  const remaining = /(?:remaining=|\br=)(\d+)/.exec(header);
  const reset = /(?:reset=|\bt=)(\d+)/.exec(header);
  return remaining && reset ? { remaining: Number(remaining[1]), reset: Number(reset[1]) } : null;
}

async function readJson(response: Response): Promise<Json> {
  const text = await readLimited(response, 2_000_000);
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

  #serial<T>(issuer: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(issuer) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.#locks.set(issuer, next.catch(() => undefined));
    return next;
  }

  constructor(host: PoppyHost) {
    this.host = host;
    this.identity = readIdentity(host.env);
    this.sealer = new Sealer(host.env);
  }

  get sql(): Sql {
    return this.host.sql;
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

  async lookup(domain: string): Promise<Company | WebsiteOnly> {
    const key = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    const cached = one<{ company: string; expires_at: number }>(
      this.sql,
      "SELECT company, expires_at FROM poppy_domains WHERE domain = ?",
      key
    );
    if (cached && cached.expires_at > Date.now()) {
      return JSON.parse(cached.company) as Company | WebsiteOnly;
    }
    const { result, cacheSeconds } = await discover(this.host.fetcher, domain);
    this.sql.exec(
      "INSERT OR REPLACE INTO poppy_domains (domain, issuer, company, expires_at) VALUES (?, ?, ?, ?)",
      key,
      isCompany(result) ? result.issuer : null,
      JSON.stringify(result),
      Date.now() + cacheSeconds * 1000
    );
    return result;
  }

  /** The most recently discovered document for an issuer. */
  companyByIssuer(issuer: string): Company {
    const row = one<{ company: string }>(
      this.sql,
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
  userId(issuer: string): string {
    const row = one<{ user_id: string }>(
      this.sql,
      "SELECT user_id FROM poppy_user_ids WHERE issuer = ?",
      issuer
    );
    if (row) return row.user_id;
    const userId = randomId("usr_");
    this.sql.exec("INSERT INTO poppy_user_ids (issuer, user_id) VALUES (?, ?)", issuer, userId);
    return userId;
  }

  // ---------------------------------------------------------------- Keys

  dpopKey(issuer: string): Promise<DpopKey> {
    let key = this.#dpopKeys.get(issuer);
    if (!key) {
      key = newDpopKey();
      this.#dpopKeys.set(issuer, key);
    }
    return key;
  }

  // ---------------------------------------------------------------- Rate limits

  #limiter(issuer: string) {
    return this.host.env.CompanyLimiter.getByName(issuer);
  }

  /** Wait for the Company's shared limit, inline if short, else fail (spec 4.3). */
  async #respectLimit(issuer: string): Promise<void> {
    const delay = await this.#limiter(issuer).delay(this.host.now());
    if (delay <= 0) return;
    if (delay > INLINE_WAIT_MS) throw new RateLimitedError(delay);
    await this.host.sleep(delay);
  }

  /** Record what a response says about limits; returns ms to wait before retrying, if any. */
  async #observeLimits(issuer: string, response: Response): Promise<number | null> {
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
   * handled here.
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
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.#respectLimit(company.issuer);
      // Each attempt gets new assertions and a new proof: Companies reject a reused jti.
      const form = new URLSearchParams({
        ...(await params()),
        client_id: this.identity.clientId,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: await clientAssertion(signing, this.identity.clientId, endpoint)
      });
      const headers = new Headers({
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      });
      const origin = new URL(endpoint).origin;
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
      const response = await this.host.fetcher(
        new Request(endpoint, { method: "POST", headers, body: form, redirect: "manual" })
      );
      const nonce = response.headers.get("DPoP-Nonce");
      if (nonce) this.#nonces.set(origin, nonce);
      const wait = await this.#observeLimits(company.issuer, response);
      const body = await readJson(response);
      const error = isObject(body) && typeof body.error === "string" ? body.error : undefined;
      if (error === "use_dpop_nonce" && nonce && !nonceRetried) {
        nonceRetried = true;
        continue;
      }
      if (wait !== null) {
        if (wait > INLINE_WAIT_MS || attempt === 2) throw new RateLimitedError(wait);
        await this.host.sleep(wait);
        continue;
      }
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
      const response = body as unknown as TokenResponse;
      if (!(response.expires_in > 0) || typeof response.session_id !== "string") {
        throw new PoppyError("invalid_response", "The company's token response is malformed", status);
      }
      return response;
    }
    const code = isObject(body) && typeof body.error === "string" ? body.error : "server_error";
    const description =
      isObject(body) && typeof body.error_description === "string" ? `: ${body.error_description}` : "";
    throw new PoppyError(code, `${company.name} refused the token request (${code})${description}`, status, {
      ...(body !== null ? { body } : {})
    });
  }

  // ---------------------------------------------------------------- Sessions

  session(issuer: string, label: string): SessionRow | undefined {
    return one<SessionRow>(
      this.sql,
      "SELECT issuer, label, session_id, account, signed_in, scope FROM poppy_sessions WHERE issuer = ? AND label = ?",
      issuer,
      label
    );
  }

  sessions(issuer?: string): SessionRow[] {
    return issuer
      ? rows<SessionRow>(this.sql, "SELECT * FROM poppy_sessions WHERE issuer = ?", issuer)
      : rows<SessionRow>(this.sql, "SELECT * FROM poppy_sessions");
  }

  #saveSession(issuer: string, label: string, response: TokenResponse, account: string | null): void {
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
   * which must never be renewed with the Session assertion (4.2).
   */
  abandonSession(issuer: string, label: string): void {
    this.#forgetSession(issuer, label);
  }

  /**
   * Before any token for a Company: resolve a Direct Sign-In whose code
   * exchange was interrupted (4.5), so a Session it may have signed in is
   * never renewed with the assertion. Cheap when there is none.
   */
  async #recoverSignIns(issuer: string): Promise<void> {
    if (!signInRecovery) return;
    const found = one(
      this.sql,
      "SELECT 1 AS found FROM poppy_signins WHERE issuer = ? AND status IN ('exchanging', 'exchanged', 'stored') LIMIT 1",
      issuer
    );
    if (found) await signInRecovery(this, issuer);
  }

  #forgetSession(issuer: string, label: string): void {
    this.sql.exec("DELETE FROM poppy_sessions WHERE issuer = ? AND label = ?", issuer, label);
    for (const key of [...this.#tokens.keys()]) {
      if (key.startsWith(`${issuer}|${label}|`)) this.#tokens.delete(key);
    }
  }

  // ---------------------------------------------------------------- Account Tokens

  account(issuer: string, account: string): AccountRow | undefined {
    const row = one<AccountRow>(
      this.sql,
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

  accounts(issuer?: string): AccountRow[] {
    return issuer
      ? rows<AccountRow>(this.sql, "SELECT * FROM poppy_accounts WHERE issuer = ?", issuer)
      : rows<AccountRow>(this.sql, "SELECT * FROM poppy_accounts");
  }

  /** The Account Token itself, decrypted only for a token-endpoint request. */
  async #accountToken(row: AccountRow): Promise<string> {
    return this.sealer.open(row.token, `account|${row.issuer}|${this.userId(row.issuer)}|${row.account}`);
  }

  /** Store a new or rotated Account Token at once, encrypted (spec 4.8). */
  async storeAccountToken(
    issuer: string,
    account: string,
    token: string,
    scope: string,
    expiresInSeconds: number | undefined
  ): Promise<void> {
    const sealed = await this.sealer.seal(token, `account|${issuer}|${this.userId(issuer)}|${account}`);
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

  deleteAccount(issuer: string, account: string): void {
    this.sql.exec("DELETE FROM poppy_accounts WHERE issuer = ? AND account = ?", issuer, account);
    // Sessions signed in to it continue signed out on their next renewal.
    for (const session of this.sessions(issuer)) {
      if (session.account === account) this.#forgetTokens(issuer, session.label);
    }
  }

  #forgetTokens(issuer: string, label: string): void {
    for (const key of [...this.#tokens.keys()]) {
      if (key.startsWith(`${issuer}|${label}|`)) this.#tokens.delete(key);
    }
  }

  /** Revoke an Account Token at the Company (spec 4.9); local state goes regardless. */
  async revokeAccount(company: Company, account: string): Promise<void> {
    const row = this.account(company.issuer, account);
    if (!row) return;
    const token = await this.#accountToken(row);
    this.deleteAccount(company.issuer, account);
    await this.oauthRequest(
      company,
      company.endpoints.revocation,
      async () => ({ token, token_type_hint: "refresh_token" }),
      { dpop: false }
    );
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
      signedIn: response.signed_in,
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
        if (error.code === "invalid_grant") {
          await this.#accountGone(company, account.account);
        } else if (error.code === "invalid_session" || error.code === "account_mismatch") {
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
        (error.code === "invalid_session" || error.code === "account_mismatch")
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
      if (error.code === "invalid_grant") {
        await this.#accountGone(company, account.account);
        return false;
      }
      if (error.code === "invalid_session" || error.code === "account_mismatch") {
        this.#forgetSession(company.issuer, label);
        return this.#signInWithAccount(company, label, scopes, account.account);
      }
      throw error;
    }
  }

  /** Record a completed sign-in: Account Token, signed-in Session (spec 4.4). */
  async completeSignIn(
    company: Company,
    label: string,
    account: string,
    response: TokenResponse
  ): Promise<void> {
    const previous = this.account(company.issuer, account);
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
    // After a step-up the old Account Token is replaced; revoke it (4.4).
    if (previous && response.refresh_token) {
      const oldToken = await this.sealer.open(
        previous.token,
        `account|${company.issuer}|${this.userId(company.issuer)}|${account}`
      );
      if (oldToken !== response.refresh_token) {
        await this.oauthRequest(
          company,
          company.endpoints.revocation,
          async () => ({ token: oldToken, token_type_hint: "refresh_token" }),
          { dpop: false }
        ).catch(() => undefined);
      }
    }
  }

  // ---------------------------------------------------------------- Resources

  /**
   * One request to a Company API, conversation or operations endpoint, with
   * the Session Token in `Authorization: DPoP` and a fresh proof (spec 4.3).
   * Nonces, `invalid_token` renewals and short `Retry-After` waits are
   * handled; other auth errors come back as `PoppyError`s.
   */
  async resource(
    company: Company,
    request: {
      method: string;
      url: string;
      body?: Json;
      headers?: Record<string, string>;
      accept?: string;
    },
    options: TokenOptions = {}
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:") throw new PoppyError("invalid_request", "Refusing a non-HTTPS URL", 0);
    // Session Tokens go only to the Company's own hosts (N10), whatever a description names.
    if (!tokenHostAllowed(company, url)) {
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
        throw new PoppyError("invalid_request", "Refusing a URL that contains a token", 0);
      }
      const headers = new Headers(request.headers);
      headers.set("Accept", request.accept ?? "application/json");
      if (request.body !== undefined) headers.set("Content-Type", "application/json");
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
      const response = await this.host.fetcher(
        new Request(url.href, {
          method: request.method,
          headers,
          // Never follow a redirect with this proof or token (Guides).
          redirect: "manual",
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {})
        })
      );
      const nonce = response.headers.get("DPoP-Nonce");
      if (nonce) this.#nonces.set(url.origin, nonce);
      const wait = await this.#observeLimits(company.issuer, response);
      if (wait !== null) {
        await response.body?.cancel();
        if (wait > INLINE_WAIT_MS || attempt === 3) throw new RateLimitedError(wait);
        await this.host.sleep(wait);
        continue;
      }
      const challenge = parseWwwAuthenticate(response.headers.get("WWW-Authenticate"));
      if (response.status === 401 && challenge.error === "use_dpop_nonce" && nonce) {
        await response.body?.cancel();
        continue;
      }
      if (response.status === 401 && challenge.error === "invalid_token" && !renewed) {
        // Expired or revoked: get a new token and retry once (spec 6).
        await response.body?.cancel();
        this.dropToken(company, options);
        renewed = true;
        continue;
      }
      // Some Companies end a Session with `invalid_session` in the body rather
      // than 401 invalid_token (spec 6): start a new Session and retry once.
      if ((response.status === 400 || response.status === 401) && !restarted) {
        const peek = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
        if (peek?.error === "invalid_session") {
          await response.body?.cancel();
          this.#forgetSession(company.issuer, options.label ?? "main");
          restarted = true;
          continue;
        }
      }
      if (challenge.error && (response.status === 401 || response.status === 403)) {
        await response.body?.cancel();
        throw new PoppyError(challenge.error, `${company.name}: ${challenge.error}`, response.status, {
          ...(challenge.scope ? { scope: challenge.scope } : {})
        });
      }
      return response;
    }
    throw new PoppyError("server_error", `${company.name} kept refusing the request`, 0);
  }

  /** `resource()` for JSON endpoints: non-2xx bodies with an `error` become `PoppyError`s. */
  async resourceJson(
    company: Company,
    request: Parameters<PoppyClient["resource"]>[1],
    options: TokenOptions = {}
  ): Promise<{ status: number; body: Json; headers: Headers }> {
    const response = await this.resource(company, request, options);
    const body = await readJson(response);
    if (response.status >= 400) {
      const code = isObject(body) && typeof body.error === "string" ? body.error : `http_${response.status}`;
      throw new PoppyError(code, `${company.name} returned ${code}`, response.status, {
        ...(body !== null ? { body } : {})
      });
    }
    return { status: response.status, body, headers: response.headers };
  }
}
