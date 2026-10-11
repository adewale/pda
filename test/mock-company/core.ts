import {
  base64url,
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload
} from "jose";
import worker from "../../src/index";
import {
  DEFAULT_CONFIG,
  hostsFor,
  type Hosts,
  type MockConfig,
  type MockRequest
} from "./types";
import type { JwtKind, SignedKind, ViolationId } from "./violations";

export const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
export const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

const SIGNING_ALGS = ["ES256", "RS256"];
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "k"];
/** DPoP acceptance window plus clock skew, seconds. */
const DPOP_WINDOW = 60;
const SKEW = 30;
/** Longest assertion lifetime accepted, seconds; strict Companies allow 60. */
const MAX_ASSERTION_LIFETIME = 300;
const STRICT_ASSERTION_LIFETIME = 60;

/** A Response to send instead of continuing. */
export class HttpError extends Error {
  constructor(readonly response: Response) {
    super(`HTTP ${response.status}`);
  }
}

export type ClientInfo = {
  readonly clientId: string;
  readonly name: string;
  readonly jwks: JSONWebKeySet;
  readonly redirectUris: readonly string[];
  readonly listsOperations: boolean;
};

export type Session = {
  readonly id: string;
  readonly clientId: string;
  readonly userId: string;
  /** The account the Session is signed in to now, if any. */
  account: string | null;
  /** The account it was ever signed in to; it can't switch (4.4). */
  boundAccount: string | null;
  scope: string[];
  ended: boolean;
};

export type AccessToken = {
  readonly value: string;
  readonly kind: "dpop" | "bearer";
  readonly jkt: string | null;
  readonly resource: string | null;
  readonly sessionId: string;
  readonly scope: readonly string[];
  readonly signedIn: boolean;
  readonly account: string | null;
  readonly expiresAt: number;
  readonly issuedAt: number;
};

export type AccountToken = {
  readonly value: string;
  readonly clientId: string;
  readonly userId: string;
  readonly account: string;
  readonly scope: readonly string[];
  readonly expiresAt: number | null;
  revoked: boolean;
  rotated: boolean;
};

/** One parsed inbound request. */
export type Inbound = {
  readonly request: Request;
  readonly url: URL;
  readonly bodyText: string;
};

/**
 * The header the test agent's fetcher stamps on every request: the time on
 * its fake clock, in epoch ms. Once a request carries it, the mock's clock
 * reads the latest such time (it stands still between them, as the agent's
 * does), so a Retry-After the agent waited out on the fake clock has elapsed
 * here too, and nothing else has.
 */
export const CLOCK_HEADER = "x-test-clock";

/** A client metadata document or JWKS a test serves at a URL instead of our Worker. */
export type ServedDocument = { readonly status: number; readonly body: string };

/** Who is calling a resource, after the Session Token checked out. */
export type ResourceContext = {
  readonly token: AccessToken;
  readonly session: Session;
  readonly client: ClientInfo;
  /** Signed in now, to the account the token was issued for. */
  readonly signedIn: boolean;
  readonly account: string | null;
  readonly scope: readonly string[];
};

export function randomId(prefix: string, bytes = 16): string {
  return `${prefix}${base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)))}`;
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

/** OAuth error response (RFC 6749 5.2). */
export function oauthError(
  status: number,
  error: string,
  description?: string,
  headers: Record<string, string> = {}
): HttpError {
  return new HttpError(
    json(
      { error, ...(description ? { error_description: description } : {}) },
      status,
      { "Cache-Control": "no-store", ...headers }
    )
  );
}

/** Resource error in `WWW-Authenticate` (RFC 9449 / RFC 6750). */
export function resourceError(
  scheme: "DPoP" | "Bearer",
  status: number,
  error: string,
  extra: { scope?: string; headers?: Record<string, string> } = {}
): HttpError {
  const challenge = `${scheme} error="${error}"${extra.scope ? `, scope="${extra.scope}"` : ""}`;
  return new HttpError(
    json({ error, ...(extra.scope ? { scope: extra.scope } : {}) }, status, {
      "WWW-Authenticate": challenge,
      ...(extra.headers ?? {})
    })
  );
}

export function parseScope(value: string | null | undefined): string[] {
  return (value ?? "").split(" ").filter((part) => part !== "");
}

function isPrivateJwk(jwk: Record<string, unknown>): boolean {
  return PRIVATE_JWK_FIELDS.some((field) => field in jwk);
}

async function sha256b64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return base64url.encode(new Uint8Array(digest));
}

export { sha256b64 };

/** All the Company's state, and the checks a strict Company makes. */
export class Company {
  #config: MockConfig = DEFAULT_CONFIG;
  hosts: Hosts;
  readonly violations: string[] = [];
  readonly requests: { -readonly [K in keyof MockRequest]: MockRequest[K] }[] = [];
  readonly revocationHints: (string | null)[] = [];
  /** Documents tests serve in place of a client's metadata or JWKS, by URL. */
  readonly served = new Map<string, ServedDocument>();
  /** Exchanges actually made, by account, order and item, to catch one made twice. */
  readonly exchanged = new Set<string>();
  /** The latest time a request carried in `CLOCK_HEADER`, if any did. */
  #stampedNow: number | null = null;
  readonly clients = new Map<string, ClientInfo>();
  readonly userIds = new Set<string>();
  readonly sessions = new Map<string, Session>();
  readonly accessTokens = new Map<string, AccessToken>();
  /** Latest token issued per Session and kind/resource, with when. */
  readonly latestToken = new Map<string, { value: string; at: number }>();
  readonly accountTokens = new Map<string, AccountToken>();
  readonly seenJtis = new Map<string, Set<string>>();
  /**
   * When each DPoP key, at each server origin, first sent the nonce: that
   * proof's `iat`. From then on it holds the nonce and must keep using it.
   */
  readonly nonceHeldSince = new Map<string, number>();
  /** DPoP nonces, one for the Company or one per origin (`nonceScope`). */
  readonly #nonces = new Map<string, string>();
  /** One-time codes we've "sent" to Users, for the secret scan. */
  readonly oneTimeCodes = new Set<string>();
  lastOneTimeCode: string | null = null;
  performs = 0;
  browserJoins = 0;
  tokenRequestCount = 0;
  otherRequestCount = 0;
  retryAfterUntil = 0;

  constructor(
    readonly id: string,
    readonly env: Env
  ) {
    this.hosts = hostsFor(id);
  }

  get config(): MockConfig {
    return this.#config;
  }

  set config(config: MockConfig) {
    this.#config = config;
    this.hosts = hostsFor(this.id, { issuerTrailingSlash: config.issuerTrailingSlash });
  }

  /**
   * Now, for comparing when requests arrive (rate limits, device polling,
   * token age): the test agent's fake clock once it has stamped a request,
   * the real clock until then. JWT times are always checked on the real
   * clock, since the agent signs with it.
   */
  now(): number {
    return this.#stampedNow ?? Date.now();
  }

  /** Record a violation; `id` names the check (see `violations.ts`). */
  violation(id: ViolationId, detail: string): void {
    this.violations.push(`[${id}] ${detail}`);
  }

  /** Log a request as it arrives; the response fills in `status` and `error`. */
  log(inbound: Inbound, bodyKeys: string[]): { -readonly [K in keyof MockRequest]: MockRequest[K] } {
    const stamped = Number(inbound.request.headers.get(CLOCK_HEADER) ?? "");
    if (inbound.request.headers.has(CLOCK_HEADER) && Number.isFinite(stamped)) {
      this.#stampedNow = Math.max(stamped, this.#stampedNow ?? 0);
    }
    const headers: Record<string, string> = {};
    inbound.request.headers.forEach((value, name) => {
      if (name === "authorization") headers[name] = `${value.split(" ")[0]} <redacted>`;
      else headers[name] = name === "dpop" || name === "cookie" ? "<present>" : value;
    });
    let proofNonce: string | null = null;
    try {
      const proof = inbound.request.headers.get("DPoP");
      const nonce = proof ? decodeJwt(proof).nonce : undefined;
      if (typeof nonce === "string") proofNonce = nonce;
    } catch {
      // Not a JWT; verifyDpop records that.
    }
    const type = inbound.request.headers.get("Content-Type") ?? "";
    const grant = type.startsWith("application/x-www-form-urlencoded")
      ? new URLSearchParams(inbound.bodyText).get("grant_type")
      : null;
    const entry = {
      method: inbound.request.method,
      url: inbound.url.href,
      headers,
      bodyKeys,
      grant,
      proofNonce,
      at: this.now(),
      status: 0,
      error: null as string | null
    };
    this.requests.push(entry);
    return entry;
  }

  /** JTIs are single-use within each kind of JWT. */
  freshJti(kind: JwtKind, jti: unknown): boolean {
    if (typeof jti !== "string" || jti === "") {
      this.violation(`${kind}.jti-missing`, `${kind}: missing jti`);
      return false;
    }
    if (!/^[A-Za-z0-9_-]{22,}$/.test(jti)) {
      this.violation(`${kind}.jti-weak`, `${kind}: jti ${JSON.stringify(jti)} is not 128 random bits of base64url`);
    }
    let seen = this.seenJtis.get(kind);
    if (!seen) {
      seen = new Set();
      this.seenJtis.set(kind, seen);
    }
    if (seen.has(jti)) {
      this.violation(`${kind}.jti-reused`, `${kind}: reused jti ${jti}`);
      return false;
    }
    seen.add(jti);
    return true;
  }

  /** The DPoP nonce the server at `origin` expects. */
  nonceFor(origin: string): string {
    const key = this.config.nonceScope === "origin" ? origin : "company";
    let nonce = this.#nonces.get(key);
    if (!nonce) {
      nonce = randomId("n_");
      this.#nonces.set(key, nonce);
    }
    return nonce;
  }

  /**
   * Make the jacket exchange. An item can be exchanged once, so a second time
   * for the same account means the agent retried a write without its
   * Idempotency-Key or confirmed the same thing twice.
   */
  performExchange(account: string | null, how: string): void {
    this.performs += 1;
    const key = `${account ?? ""}|ord_7Hk2|itm_4Qa`;
    if (this.exchanged.has(key)) {
      this.violation("exchange.performed-twice", `itm_4Qa on ord_7Hk2 exchanged again for ${account} (${how})`);
    }
    this.exchanged.add(key);
  }

  // ---- Rate limits (4.3) ----

  /** 429 when configured; a request before an earlier Retry-After is a violation. */
  rateLimit(kind: "token" | "other", inbound: Inbound): void {
    const now = this.now();
    if (now < this.retryAfterUntil) {
      this.violation(
        "rate-limit.retry-after-ignored",
        `sent ${inbound.request.method} ${inbound.url.pathname} ${this.retryAfterUntil - now} ms before Retry-After elapsed`
      );
      throw this.tooMany(Math.ceil((this.retryAfterUntil - now) / 1000));
    }
    const limit =
      kind === "token"
        ? this.config.rateLimit.tokenRequests429
        : this.config.rateLimit.requests429;
    const count = kind === "token" ? ++this.tokenRequestCount : ++this.otherRequestCount;
    if (count <= limit) {
      this.retryAfterUntil = now + this.config.rateLimit.retryAfterSeconds * 1000;
      throw this.tooMany(this.config.rateLimit.retryAfterSeconds);
    }
  }

  tooMany(seconds: number): HttpError {
    return new HttpError(
      json({ error: "rate_limited" }, 429, {
        "Retry-After": String(Math.max(1, seconds)),
        "Cache-Control": "no-store"
      })
    );
  }

  // ---- Secrets never sent to the wrong place (4.7, 4.8, Guides) ----

  /**
   * Passwords may appear only in the mediated sign-in body, one-time codes
   * only in the code submission, Account Tokens only at the token and
   * revocation endpoints. Anything else is a violation.
   */
  scanSecrets(inbound: Inbound, allowed: "credentials" | "code" | "account-token" | null): void {
    const headerText: string[] = [];
    inbound.request.headers.forEach((value, name) => headerText.push(`${name}: ${value}`));
    const places: [string, string][] = [
      ["URL", inbound.url.href],
      ["headers", headerText.join("\n")],
      ["body", inbound.bodyText]
    ];
    const check = (
      id: "secret.password" | "secret.one-time-code" | "secret.account-token",
      kind: string,
      secret: string,
      allowedHere: boolean
    ) => {
      for (const [where, text] of places) {
        if (!text.includes(secret)) continue;
        if (allowedHere && where === "body") continue;
        this.violation(id, `${kind} sent in ${where} of ${inbound.request.method} ${inbound.url.href}`);
      }
    };
    for (const account of this.config.accounts) {
      check("secret.password", "password", account.password, allowed === "credentials");
    }
    for (const code of this.oneTimeCodes) check("secret.one-time-code", "one-time code", code, allowed === "code");
    for (const token of this.accountTokens.values()) {
      check("secret.account-token", "Account Token", token.value, allowed === "account-token");
    }
    // Session Tokens never belong in a URL (4.3).
    for (const [name, value] of inbound.url.searchParams) {
      if (
        name === "access_token" ||
        name === "token" ||
        this.accessTokens.has(value) ||
        this.accountTokens.has(value)
      ) {
        this.violation("secret.token-in-url", `token sent in URL ${inbound.url.href}`);
        throw resourceError("DPoP", 401, "invalid_token");
      }
    }
  }

  // ---- Fetching the Personal Agent's metadata (4.1) ----

  async #fetchAgent(url: string): Promise<Response> {
    const served = this.served.get(url);
    if (served) {
      return new Response(served.body, { status: served.status, headers: { "Content-Type": "application/json" } });
    }
    const agentHost = new URL(this.env.PUBLIC_ORIGIN).host;
    const request = new Request(url, { redirect: "manual" });
    // Guides: never send credentials on metadata fetches; fetch without redirects.
    if (new URL(url).host === agentHost) return worker.fetch(request, this.env);
    return fetch(request);
  }

  async client(clientId: string): Promise<ClientInfo> {
    const cached = this.clients.get(clientId);
    if (cached) return cached;
    const fail = (id: ViolationId, message: string): HttpError => {
      this.violation(id, `client metadata: ${message}`);
      return oauthError(401, "invalid_client", message);
    };
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw fail("client-metadata.not-url", `client_id ${JSON.stringify(clientId)} is not a URL`);
    }
    if (url.protocol !== "https:") throw fail("client-metadata.not-https", "client_id must be an https URL");
    const response = await this.#fetchAgent(clientId);
    if (response.status !== 200) {
      throw fail("client-metadata.fetch-status", `fetching client_id returned ${response.status}; it must not redirect`);
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = (await response.json()) as Record<string, unknown>;
    } catch {
      throw fail("client-metadata.not-json", "client metadata is not JSON");
    }
    if (metadata.client_id !== clientId) {
      throw fail("client-metadata.client-id-mismatch", "client_id in the document doesn't equal the URL it was fetched from");
    }
    const sameDomain = (value: unknown): value is string => {
      if (typeof value !== "string") return false;
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.hostname === url.hostname;
      } catch {
        return false;
      }
    };
    if (!sameDomain(metadata.jwks_uri)) {
      throw fail("client-metadata.jwks-uri", "jwks_uri must be https on the client_id domain");
    }
    const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
    if (!redirectUris.every(sameDomain)) {
      throw fail("client-metadata.redirect-uris", "redirect_uris must be https on the client_id domain");
    }
    if (metadata.token_endpoint_auth_method !== "private_key_jwt") {
      this.violation("client-metadata.auth-method", "client metadata: token_endpoint_auth_method should be private_key_jwt");
    }
    const jwksResponse = await this.#fetchAgent(metadata.jwks_uri as string);
    if (jwksResponse.status !== 200) throw fail("client-metadata.jwks-status", `jwks_uri returned ${jwksResponse.status}`);
    const jwks = (await jwksResponse.json().catch(() => ({}))) as JSONWebKeySet;
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw fail("client-metadata.jwks-empty", "JWKS has no keys");
    for (const key of jwks.keys) {
      if (isPrivateJwk(key as unknown as Record<string, unknown>)) {
        throw fail("client-metadata.jwks-private", "JWKS publishes a private key");
      }
      if (!key.kid) {
        this.violation("client-metadata.key-without-kid", "client metadata: JWKS key without kid (Guides: give every key a kid)");
      }
    }
    const extensions = (metadata.extensions ?? {}) as Record<string, { version?: unknown }>;
    const info: ClientInfo = {
      clientId,
      name: typeof metadata.client_name === "string" ? metadata.client_name : clientId,
      jwks,
      redirectUris: redirectUris as string[],
      listsOperations: extensions.operations?.version === "1"
    };
    this.clients.set(clientId, info);
    return info;
  }

  /** Verify a JWT signed by the client's keys; returns its payload. */
  /** Verify a JWT signed by the client's keys, its header already decoded; returns its payload. */
  async #verifyClientJwt(
    client: ClientInfo,
    token: string,
    header: ReturnType<typeof decodeProtectedHeader>,
    kind: SignedKind,
    error: () => HttpError
  ): Promise<JWTPayload> {
    const label = kind === "client-assertion" ? "client assertion" : "Session assertion";
    if (!header.alg || !SIGNING_ALGS.includes(header.alg)) {
      this.violation(`${kind}.alg`, `${label}: alg ${header.alg} is not allowed`);
      throw error();
    }
    if (header.jku || header.x5u || header.jwk) {
      this.violation(`${kind}.embedded-key`, `${label}: embeds or points to a key (jku/x5u/jwk)`);
    }
    if (this.config.strictAssertions) {
      if (header.typ !== "JWT") {
        this.violation(`${kind}.typ`, `${label}: strict Company: header typ must be "JWT", got ${JSON.stringify(header.typ)}`);
        throw error();
      }
      if (!header.kid || !client.jwks.keys.some((key) => key.kid === header.kid)) {
        this.violation(`${kind}.kid`, `${label}: strict Company: kid ${JSON.stringify(header.kid)} names no published key`);
        throw error();
      }
    }
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(client.jwks), {
        algorithms: SIGNING_ALGS,
        clockTolerance: SKEW
      });
      return payload;
    } catch (cause) {
      this.violation(`${kind}.signature`, `${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
      throw error();
    }
  }

  #checkLifetime(kind: SignedKind, payload: JWTPayload): boolean {
    const label = kind === "client-assertion" ? "client assertion" : "Session assertion";
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
      this.violation(`${kind}.iat-exp-missing`, `${label}: iat and exp are required`);
      return false;
    }
    const longest = this.config.strictAssertions ? STRICT_ASSERTION_LIFETIME : MAX_ASSERTION_LIFETIME;
    if (payload.exp - payload.iat > longest) {
      this.violation(`${kind}.lifetime`, `${label}: lifetime ${payload.exp - payload.iat}s is too long (at most ${longest}s)`);
      return false;
    }
    return true;
  }

  /**
   * Client authentication at the token, device and revocation endpoints:
   * `private_key_jwt` (RFC 7523) against the client's `jwks_uri`.
   */
  async authenticateClient(form: URLSearchParams, endpoint: string): Promise<ClientInfo> {
    const clientId = form.get("client_id");
    const assertion = form.get("client_assertion");
    if (!clientId) throw oauthError(401, "invalid_client", "client_id is required");
    if (form.get("client_assertion_type") !== CLIENT_ASSERTION_TYPE || !assertion) {
      this.violation("client-assertion.missing", `no client assertion at ${endpoint}`);
      throw oauthError(401, "invalid_client", "client assertion is required");
    }
    const registered = this.config.requireRegistration;
    if (registered && !registered.includes(clientId)) {
      throw oauthError(401, "invalid_client", "this Personal Agent is not registered");
    }
    const client = await this.client(clientId);
    let header;
    try {
      header = decodeProtectedHeader(assertion);
      decodeJwt(assertion);
    } catch {
      this.violation("client-assertion.not-jwt", "client assertion: not a JWT");
      throw oauthError(401, "invalid_client", "client assertion is not a JWT");
    }
    if (header.typ === "poppy-browser+jwt" || header.typ === "dpop+jwt") {
      this.violation("client-assertion.wrong-typ", `client assertion has typ ${header.typ}`);
      throw oauthError(401, "invalid_client");
    }
    const payload = await this.#verifyClientJwt(client, assertion, header, "client-assertion", () =>
      oauthError(401, "invalid_client", "client assertion did not verify")
    );
    if (Array.isArray(payload.aud)) {
      this.violation("client-assertion.aud-array", "client assertion: aud is an array");
      throw oauthError(401, "invalid_client");
    }
    // The draft never says what aud is (S1); exact Companies want the endpoint called.
    const exact = this.config.clientAssertionAud === "exact";
    const audiences = exact ? [endpoint] : [endpoint, this.hosts.tokenEndpoint, this.hosts.issuer];
    if (typeof payload.aud !== "string" || !audiences.includes(payload.aud)) {
      this.violation(
        "client-assertion.aud",
        `client assertion: aud ${JSON.stringify(payload.aud)} is not ${exact ? `exactly ${endpoint}` : "this Company"}`
      );
      throw oauthError(401, "invalid_client");
    }
    if (payload.iss !== clientId || payload.sub !== clientId) {
      this.violation("client-assertion.iss-sub", "client assertion: iss and sub must both be the client_id");
      throw oauthError(401, "invalid_client");
    }
    if (!this.#checkLifetime("client-assertion", payload)) {
      throw oauthError(401, "invalid_client");
    }
    if (!this.freshJti("client-assertion", payload.jti)) {
      throw oauthError(401, "invalid_client", "assertion jti already used");
    }
    return client;
  }

  /** The Session assertion of the JWT bearer grant (4.2). Returns the User ID. */
  async verifySessionAssertion(client: ClientInfo, assertion: string | null): Promise<string> {
    if (!assertion) {
      this.violation("session-assertion.missing", "JWT bearer grant without an assertion");
      throw oauthError(400, "invalid_grant", "assertion is required");
    }
    let header;
    try {
      header = decodeProtectedHeader(assertion);
      decodeJwt(assertion);
    } catch {
      this.violation("session-assertion.not-jwt", "Session assertion: not a JWT");
      throw oauthError(400, "invalid_grant");
    }
    if (header.typ === "poppy-browser+jwt") {
      this.violation("session-assertion.browser-typ", "browser assertion sent to the token endpoint");
      throw oauthError(400, "invalid_grant");
    }
    const payload = await this.#verifyClientJwt(client, assertion, header, "session-assertion", () =>
      oauthError(400, "invalid_grant", "assertion did not verify")
    );
    if (Array.isArray(payload.aud) || payload.aud !== this.hosts.tokenEndpoint) {
      this.violation(
        "session-assertion.aud",
        `Session assertion: aud must be the token_endpoint as a single string, got ${JSON.stringify(payload.aud)}`
      );
      throw oauthError(400, "invalid_grant");
    }
    if (payload.iss !== client.clientId) {
      this.violation("session-assertion.iss", "Session assertion: iss must be the client_id");
      throw oauthError(400, "invalid_grant");
    }
    if (typeof payload.sub !== "string" || payload.sub === "") {
      this.violation("session-assertion.sub", "Session assertion: sub (User ID) is missing");
      throw oauthError(400, "invalid_grant");
    }
    if (!this.#checkLifetime("session-assertion", payload)) throw oauthError(400, "invalid_grant");
    if (!this.freshJti("session-assertion", payload.jti)) {
      throw oauthError(400, "invalid_grant", "assertion jti already used");
    }
    this.checkUserId(payload.sub);
    return payload.sub;
  }

  /** User IDs MUST NOT contain or be derived from personal information (4.2). */
  checkUserId(userId: string): void {
    if (!this.userIds.has(userId)) {
      const lower = userId.toLowerCase();
      // The local part counts only as a whole word ("usr_ada", "ada_lovelace"):
      // 22 random base64url characters contain "ada" in about 1 ID in 1,600,
      // which made tests fail at random.
      const words = lower.split(/[^a-z0-9]+/);
      const personal = this.config.accounts.some(
        (account) =>
          lower.includes(account.email.toLowerCase()) ||
          words.includes(account.email.split("@")[0]!.toLowerCase())
      );
      if (userId.includes("@") || personal) {
        this.violation("user-id.personal", `User ID ${JSON.stringify(userId)} contains personal information`);
      }
    }
    this.userIds.add(userId);
  }

  // ---- DPoP (4.3) ----

  /**
   * Check a DPoP proof. At the token endpoint `accessToken` is undefined and
   * the proof must not carry `ath`. Returns the key's thumbprint.
   */
  async verifyDpop(
    inbound: Inbound,
    accessToken: string | undefined
  ): Promise<string> {
    const atTokenEndpoint = accessToken === undefined;
    const origin = inbound.url.origin;
    const fail = (error: string, why: string, id: ViolationId | null): HttpError => {
      if (id) this.violation(id, `DPoP: ${why} (${inbound.request.method} ${inbound.url.pathname})`);
      const headers: Record<string, string> = { "WWW-Authenticate": `DPoP error="${error}"` };
      if (error === "use_dpop_nonce") headers["DPoP-Nonce"] = this.nonceFor(origin);
      return atTokenEndpoint
        ? oauthError(400, error, why, headers)
        : resourceError("DPoP", 401, error, {
            headers: error === "use_dpop_nonce" ? { "DPoP-Nonce": this.nonceFor(origin) } : {}
          });
    };
    const proofs = inbound.request.headers.get("DPoP");
    if (!proofs) throw fail("invalid_dpop_proof", "missing DPoP header", "dpop.missing");
    if (proofs.includes(",")) throw fail("invalid_dpop_proof", "more than one DPoP proof", "dpop.multiple");
    let header;
    let claims: JWTPayload;
    try {
      header = decodeProtectedHeader(proofs);
      claims = decodeJwt(proofs);
    } catch {
      throw fail("invalid_dpop_proof", "proof is not a JWT", "dpop.not-jwt");
    }
    if (header.typ !== "dpop+jwt") throw fail("invalid_dpop_proof", `typ is ${header.typ}`, "dpop.typ");
    if (!header.alg || !SIGNING_ALGS.includes(header.alg)) {
      throw fail("invalid_dpop_proof", `alg ${header.alg} not allowed`, "dpop.alg");
    }
    const jwk = header.jwk as JWK | undefined;
    if (!jwk) throw fail("invalid_dpop_proof", "no jwk in header", "dpop.no-jwk");
    if (isPrivateJwk(jwk as unknown as Record<string, unknown>)) {
      throw fail("invalid_dpop_proof", "jwk contains a private key", "dpop.private-jwk");
    }
    try {
      const key = await importJWK(jwk, header.alg);
      await jwtVerify(proofs, key, { typ: "dpop+jwt", algorithms: SIGNING_ALGS });
    } catch (cause) {
      throw fail("invalid_dpop_proof", `signature: ${cause instanceof Error ? cause.message : String(cause)}`, "dpop.signature");
    }
    const htu = `${inbound.url.origin}${inbound.url.pathname}`;
    if (claims.htm !== inbound.request.method) {
      throw fail("invalid_dpop_proof", `htm ${String(claims.htm)} != ${inbound.request.method}`, "dpop.htm");
    }
    if (claims.htu !== htu) {
      throw fail("invalid_dpop_proof", `htu ${String(claims.htu)} != ${htu}`, "dpop.htu");
    }
    // Proofs carry the agent's real time; the fake clock moves only request timing.
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.iat !== "number" || Math.abs(now - claims.iat) > DPOP_WINDOW + SKEW) {
      throw fail("invalid_dpop_proof", "iat outside the acceptance window", "dpop.iat");
    }
    if (!this.freshJti("dpop", claims.jti)) {
      throw fail("invalid_dpop_proof", "jti reused", null);
    }
    if (atTokenEndpoint) {
      if ("ath" in claims) throw fail("invalid_dpop_proof", "ath on a token request", "dpop.ath-at-token-endpoint");
    } else if (claims.ath !== (await sha256b64(accessToken))) {
      throw fail("invalid_dpop_proof", "ath doesn't match the token", "dpop.ath");
    }
    const jkt = await calculateJwkThumbprint(jwk);
    if (this.config.requireNonce) {
      // Nonces belong to a server (RFC 9449; Guides: "keep it for that server").
      const holder = `${jkt}|${origin}`;
      const since = this.nonceHeldSince.get(holder);
      if (claims.nonce === this.nonceFor(origin)) {
        if (since === undefined) this.nonceHeldSince.set(holder, claims.iat);
      } else {
        // Dropping a nonce this key already used here is a violation. A proof
        // made in the same second may have been in flight before the nonce
        // arrived (two requests racing to a server new to this key), so only
        // a later one counts.
        if (claims.nonce === undefined && since !== undefined && claims.iat > since) {
          this.violation(
            "dpop.nonce-ignored",
            `DPoP: proof without the nonce this key already used at ${origin} (must keep using nonces)`
          );
        }
        throw fail("use_dpop_nonce", "nonce required", null);
      }
    }
    return jkt;
  }

  // ---- Tokens ----

  newSession(clientId: string, userId: string): Session {
    const session: Session = {
      id: randomId("ses_", 8),
      clientId,
      userId,
      account: null,
      boundAccount: null,
      scope: [],
      ended: false
    };
    this.sessions.set(session.id, session);
    return session;
  }

  issueAccess(
    session: Session,
    binding: { jkt: string | null; resource: string | null },
    scope: readonly string[]
  ): AccessToken {
    const now = Date.now();
    const token: AccessToken = {
      value: randomId("at_", 24),
      kind: binding.jkt ? "dpop" : "bearer",
      jkt: binding.jkt,
      resource: binding.resource,
      sessionId: session.id,
      scope: session.account ? scope : [],
      signedIn: session.account !== null,
      account: session.account,
      expiresAt: now + this.config.sessionTokenTtl * 1000,
      issuedAt: now
    };
    this.accessTokens.set(token.value, token);
    this.latestToken.set(`${session.id}|${token.kind}|${token.resource ?? ""}`, {
      value: token.value,
      at: this.now()
    });
    return token;
  }

  issueAccountToken(session: Session, scope: readonly string[]): AccountToken {
    const token: AccountToken = {
      value: randomId("pat_", 24),
      clientId: session.clientId,
      userId: session.userId,
      account: session.account!,
      scope,
      expiresAt: this.config.refreshTokenTtl
        ? Date.now() + this.config.refreshTokenTtl * 1000
        : null,
      revoked: false,
      rotated: false
    };
    this.accountTokens.set(token.value, token);
    return token;
  }

  tokenResponse(access: AccessToken, refresh?: AccountToken, extra: Record<string, unknown> = {}): Response {
    const body: Record<string, unknown> = {
      ...extra,
      access_token: access.value,
      token_type: access.kind === "dpop" ? "DPoP" : "Bearer",
      expires_in: this.config.sessionTokenTtl,
      scope: access.scope.join(" "),
      session_id: access.sessionId,
      signed_in: access.signedIn
    };
    if (refresh) {
      body.refresh_token = refresh.value;
      if (refresh.expiresAt) {
        body.refresh_token_expires_in = Math.round((refresh.expiresAt - Date.now()) / 1000);
      }
    }
    return json(body, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
  }

  /** Signs a Session in to an account, enforcing one account per Session (4.4). */
  signIn(session: Session, account: string, scope: readonly string[]): void {
    if (session.boundAccount && session.boundAccount !== account) {
      throw oauthError(400, "account_mismatch", "Session is signed in to a different account");
    }
    session.account = account;
    session.boundAccount = account;
    session.scope = [...scope];
  }

  // ---- Resource requests (4.3, 6) ----

  /** The Session Token on an API, conversation, operations or mediated request. */
  async authorizeResource(inbound: Inbound, mcp = false): Promise<ResourceContext> {
    const scheme = mcp ? "Bearer" : "DPoP";
    const header = inbound.request.headers.get("Authorization");
    if (!header) {
      this.violation("resource.no-token", `request without a Session Token: ${inbound.request.method} ${inbound.url.href}`);
      throw resourceError(scheme, 401, "invalid_token");
    }
    const [given, value] = header.split(" ", 2) as [string, string | undefined];
    if (!value) throw resourceError(scheme, 401, "invalid_token");
    const token = this.accessTokens.get(value);
    if (mcp) {
      if (given !== "Bearer") {
        this.violation("mcp.not-bearer", `MCP request with ${given} scheme; MCP uses Bearer`);
        throw resourceError("Bearer", 401, "invalid_token");
      }
      if (token && (token.kind !== "bearer" || token.resource !== this.hosts.mcpUrl)) {
        this.violation("mcp.wrong-token", "MCP request with a token not issued for this MCP server");
        throw resourceError("Bearer", 401, "invalid_token");
      }
    } else {
      if (given !== "DPoP") {
        this.violation("resource.bearer-scheme", `${given} token on ${inbound.url.pathname}; Bearer is only for MCP`);
        throw resourceError("DPoP", 401, "invalid_token");
      }
      if (token && token.kind !== "dpop") {
        this.violation("resource.bearer-token-as-dpop", "Bearer Session Token sent with the DPoP scheme");
        throw resourceError("DPoP", 401, "invalid_token");
      }
    }
    if (!token) throw resourceError(scheme, 401, "invalid_token");
    if (token.expiresAt <= Date.now()) throw resourceError(scheme, 401, "invalid_token");
    const session = this.sessions.get(token.sessionId);
    if (!session || session.ended) {
      if (session && this.config.endedSessionError === "invalid_session") {
        throw new HttpError(json({ error: "invalid_session" }, 400));
      }
      throw resourceError(scheme, 401, "invalid_token");
    }
    if (!mcp) {
      const jkt = await this.verifyDpop(inbound, value);
      if (jkt !== token.jkt) {
        this.violation("dpop.key-mismatch", "DPoP proof key isn't the key the token is bound to");
        throw resourceError("DPoP", 401, "invalid_dpop_proof");
      }
    }
    const latest = this.latestToken.get(`${session.id}|${token.kind}|${token.resource ?? ""}`);
    if (latest && latest.value !== token.value && this.now() - latest.at > 2000) {
      this.violation("resource.stale-token", "used an older Session Token after a newer one was issued for the Session");
    }
    const client = await this.client(session.clientId);
    // Sign-out takes effect right away (4.9): check the Session, not just the token.
    const signedIn =
      token.signedIn && session.account !== null && session.account === token.account;
    return {
      token,
      session,
      client,
      signedIn,
      account: signedIn ? token.account : null,
      scope: signedIn ? token.scope : []
    };
  }

  /** `sign_in_required` or `insufficient_scope` unless the token covers `needed`. */
  requireScopes(context: ResourceContext, needed: readonly string[], mcp = false): void {
    const scheme = mcp ? "Bearer" : "DPoP";
    if (!context.signedIn) throw resourceError(scheme, 403, "sign_in_required");
    if (!needed.every((scope) => context.scope.includes(scope))) {
      throw resourceError(scheme, 403, "insufficient_scope", { scope: needed.join(" ") });
    }
  }
}
