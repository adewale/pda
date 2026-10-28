import {
  base64url,
  calculateJwkThumbprint,
  compactVerify,
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
  type CompanyFlaw,
  type Hosts,
  type MockConfig,
  type MockRequest
} from "./types";
import { isViolation, type JwtKind, type SignedKind, type ViolationId } from "./violations";

export const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
/** The Mediated Sign-In extension's grant (Mediated Sign-In 2). */
export const MEDIATED_GRANT = "https://personalagentprotocol.org/grant/mediated-sign-in";
export const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** DPoP proofs (RFC 9449; the metadata lists ES256). */
const SIGNING_ALGS = ["ES256", "RS256"];
/** Client assertions: Companies MUST accept ES256 and PS384 (4.1), and the Guides add RS256 ("Signing and verifying JWTs"). */
const CLIENT_ASSERTION_ALGS = ["ES256", "PS384", "RS256"];
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "k"];
/** DPoP acceptance window plus clock skew, seconds. */
const DPOP_WINDOW = 60;
/** The Session JWT's `iat` window (5.3: "such as one minute"), and the longest delegation (5.2). */
const SESSION_JWT_WINDOW = 60;
const DELEGATION_LIFETIME = 24 * 60 * 60;
/** Delegations may be signed with either (5.2: "Companies MUST accept both"). */
const DELEGATION_ALGS = ["ES256", "PS384"];
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
  /** It lists the Operations extension at version "2" (Ops 2). */
  readonly listsOperations: boolean;
};

export type Session = {
  readonly id: string;
  readonly clientId: string;
  readonly userId: string;
  /** The account the Session is signed in to now, if any. */
  account: string | null;
  /** The account it was ever signed in to; another is refused (5.4). */
  boundAccount: string | null;
  /** The sign-in whose refresh token it is signed in with, if any: revoking that token signs it out (4.6, 5.5). */
  grant: string | null;
  scope: string[];
  ended: boolean;
  /** The Agent ID its Session JWTs carry, if any (5.1). */
  readonly agentId: string | null;
};

export type AccessToken = {
  readonly value: string;
  readonly kind: "dpop" | "bearer";
  readonly jkt: string | null;
  readonly resource: string | null;
  readonly scope: readonly string[];
  readonly account: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  /** Who it was issued to, and the sign-in it descends from, so revoking its refresh token ends it (RFC 7009 2.1). Access tokens belong to no Session (5.4). */
  readonly clientId: string;
  readonly grant: string;
};

/** A refresh token (4.4). The type keeps its old name, as do the violation ids that mention it. */
export type AccountToken = {
  readonly value: string;
  readonly clientId: string;
  readonly account: string;
  /** The sign-in it descends from; a rotated token keeps its predecessor's. */
  readonly grant: string;
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
  /** The body as sent, for a multipart upload's file. */
  readonly bodyBytes: Uint8Array;
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

/** Who is calling a resource, after the Session header and any access token checked out. */
export type ResourceContext = {
  /** The access token; null for a request with only the Session header (5). */
  readonly token: AccessToken | null;
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

/** A loopback redirect URI for an app on the User's computer (RFC 8252 7.3), which 4.1 allows beside HTTPS ones. */
export function isLoopbackRedirect(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** Whether `given` is the registered `redirect_uri` exactly, or it but for a loopback URI's port (4.2, RFC 8252 7.3). */
export function redirectUriMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  if (!isLoopbackRedirect(registered) || !isLoopbackRedirect(given)) return false;
  const a = new URL(registered);
  const b = new URL(given);
  a.port = "";
  b.port = "";
  return a.href === b.href;
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
  /** Every check the Company recorded, `[id] detail`, in order: violations and warnings (violations.ts). */
  readonly recorded: string[] = [];
  readonly requests: { -readonly [K in keyof MockRequest]: MockRequest[K] }[] = [];
  readonly revocationHints: (string | null)[] = [];
  /** Revocation requests refused so far under `refuseRevocations`. */
  revocationsRefused = 0;
  /** Documents tests serve in place of a client's metadata or JWKS, by URL. */
  readonly served = new Map<string, ServedDocument>();
  /** Exchanges actually made, by account, order and item, to catch one made twice. */
  readonly exchanged = new Set<string>();
  /** The latest time a request carried in `CLOCK_HEADER`, if any did. */
  #stampedNow: number | null = null;
  readonly clients = new Map<string, ClientInfo>();
  readonly userIds = new Set<string>();
  /** The User each DPoP key was first bound for, by thumbprint: a key pair for each User (4.3). */
  readonly dpopKeyUsers = new Map<string, { clientId: string; userId: string }>();
  readonly sessions = new Map<string, Session>();
  readonly accessTokens = new Map<string, AccessToken>();
  /** Latest token issued per Session and kind/resource, with when. */
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
  /** Forms the website received: the signed-in account and every field, in order. */
  readonly formPosts: { account: string | null; fields: [string, string][] }[] = [];
  readonly feedback: { task: string; signedIn: boolean }[] = [];
  tokenRequestCount = 0;
  otherRequestCount = 0;
  pageRequestCount = 0;
  retryAfterUntil = 0;
  /** When each request (method and URL without the query) that got 429 may be sent again. */
  readonly retryAfterByRequest = new Map<string, number>();

  constructor(
    readonly id: string,
    readonly env: Env
  ) {
    this.hosts = hostsFor(id);
  }

  get config(): MockConfig {
    return this.#config;
  }

  /** The Company has this flaw (`COMPANY_FLAWS`): one of its protections is off. */
  flawed(flaw: CompanyFlaw): boolean {
    return this.#config.flaws.includes(flaw);
  }

  set config(config: MockConfig) {
    this.#config = config;
    this.hosts = hostsFor(this.id, { issuerTrailingSlash: config.issuerTrailingSlash, issuerPath: config.issuerPath });
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

  /**
   * Record a check; `id` names it (see `violations.ts`). Its basis decides
   * whether it's a violation or a warning; whether the request is also
   * refused is up to the caller.
   */
  violation(id: ViolationId, detail: string): void {
    this.recorded.push(`[${id}] ${detail}`);
  }

  /** The recorded checks that are failures: a MUST, an RFC's MUST or a keyword-less rule broken. */
  get violations(): string[] {
    return this.recorded.filter(isViolation);
  }

  /** The recorded checks that are warnings: a SHOULD, the Guides or our reading. */
  get warnings(): string[] {
    return this.recorded.filter((entry) => !isViolation(entry));
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
      return kind === "dpop" ? this.flawed("accept-replayed-proof") : kind === "client-assertion" && this.flawed("accept-replayed-assertion");
    }
    seen.add(jti);
    return true;
  }

  /** The DPoP nonce the server at `origin` expects. */
  nonceFor(origin: string): string {
    // Interop XN: a fresh nonce on every call, so a retrying agent's proof
    // never carries the one the server now wants. nonceLoop also makes the
    // check below always challenge, so this value is only ever handed out.
    if (this.config.nonceLoop) return randomId("n_");
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

  /** What the Company calls reading and changing orders: its own scopes, since the protocol defines none (4.7). */
  get orderScopes(): { readonly read: string; readonly write: string } {
    return { read: "orders:read", write: "orders:write" };
  }

  /** Scopes a sign-in type can grant, or null when it isn't offered. */
  offeredScopes(type: "direct" | "device" | "mediated"): readonly string[] | null {
    return this.config.signIn[type];
  }

  // ---- Rate limits (4.3) ----

  /**
   * 429 when configured. Until the `Retry-After` passes, every request gets
   * 429 too, since the Company's limit covers them all. Only the same
   * request (method and URL) sent again before its own `Retry-After` breaks
   * 4.3's MUST ("before sending the request again"); a different request
   * breaks the Guides' advice to share a Company's limits across tasks.
   */
  rateLimit(kind: "token" | "other" | "page", inbound: Inbound): void {
    const now = this.now();
    const request = `${inbound.request.method} ${inbound.url.origin}${inbound.url.pathname}`;
    if (now < this.retryAfterUntil) {
      const own = this.retryAfterByRequest.get(request);
      if (own !== undefined && now < own) {
        this.violation(
          "rate-limit.retry-after-ignored",
          `sent ${inbound.request.method} ${inbound.url.pathname} ${own - now} ms before Retry-After elapsed`
        );
      } else {
        this.violation(
          "rate-limit.shared-limit-ignored",
          `sent ${inbound.request.method} ${inbound.url.pathname} ${this.retryAfterUntil - now} ms before another request's Retry-After elapsed`
        );
      }
      this.retryAfterByRequest.set(request, this.retryAfterUntil);
      throw this.tooMany(Math.ceil((this.retryAfterUntil - now) / 1000));
    }
    const limits = this.config.rateLimit;
    const limit = kind === "token" ? limits.tokenRequests429 : kind === "page" ? (limits.pages429 ?? 0) : limits.requests429;
    const count =
      kind === "token" ? ++this.tokenRequestCount : kind === "page" ? ++this.pageRequestCount : ++this.otherRequestCount;
    if (count <= limit) {
      this.retryAfterUntil = now + this.config.rateLimit.retryAfterSeconds * 1000;
      this.retryAfterByRequest.set(request, this.retryAfterUntil);
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
  scanSecrets(inbound: Inbound, allowed: "account-token" | "token-endpoint" | null): void {
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
      check("secret.password", "password", account.password, allowed === "token-endpoint");
    }
    for (const code of this.oneTimeCodes) check("secret.one-time-code", "one-time code", code, allowed === "token-endpoint");
    for (const token of this.accountTokens.values()) {
      check("secret.account-token", "refresh token", token.value, (allowed === "account-token" || allowed === "token-endpoint"));
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
        if (!this.flawed("accept-query-token")) throw resourceError("DPoP", 401, "invalid_token");
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
    if (!redirectUris.every((uri) => sameDomain(uri) || isLoopbackRedirect(uri))) {
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
      listsOperations: extensions.operations?.version === "2"
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
    const label = "client assertion";
    if (!header.alg || !CLIENT_ASSERTION_ALGS.includes(header.alg)) {
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
        algorithms: CLIENT_ASSERTION_ALGS,
        clockTolerance: SKEW
      });
      return payload;
    } catch (cause) {
      this.violation(`${kind}.signature`, `${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
      throw error();
    }
  }

  #checkLifetime(kind: SignedKind, payload: JWTPayload): boolean {
    const label = "client assertion";
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
   *
   * `client_id` is optional beside a client assertion (RFC 7521 4.2: the
   * assertion's subject names the client), and the draft doesn't require it, so
   * a request without one is the client its assertion's `iss` and `sub` both
   * name (RFC 7523 3). One that sends it must name that same client.
   */
  async authenticateClient(form: URLSearchParams, endpoint: string): Promise<ClientInfo> {
    const assertion = form.get("client_assertion");
    if (form.get("client_assertion_type") !== CLIENT_ASSERTION_TYPE || !assertion) {
      this.violation("client-assertion.missing", `no client assertion at ${endpoint}`);
      throw oauthError(401, "invalid_client", "client assertion is required");
    }
    const clientId = form.get("client_id") ?? this.#assertedClient(assertion);
    if (!clientId) throw oauthError(401, "invalid_client", "no client_id, and the client assertion's iss and sub don't name one client");
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
    // Explicit typing (RFC 8725 3.11, 5.2): a DPoP proof, Session JWT or delegation is never a client assertion.
    if (header.typ === "dpop+jwt" || header.typ === "poppy-session+jwt" || header.typ === "pap-delegation+jwt") {
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
    // 4.1: the issuer, as a single string, compared character for character; never an endpoint.
    const audiences = [this.hosts.issuer, ...(this.flawed("accept-token-endpoint-aud") ? [this.hosts.tokenEndpoint] : [])];
    if (typeof payload.aud !== "string" || !audiences.includes(payload.aud)) {
      this.violation("client-assertion.aud", `client assertion: aud ${JSON.stringify(payload.aud)} is not the issuer ${this.hosts.issuer}`);
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

  /** The client an unverified client assertion names: its `iss`, when `sub` is the same (RFC 7523 3). */
  #assertedClient(assertion: string): string | null {
    try {
      const { iss, sub } = decodeJwt(assertion);
      return typeof iss === "string" && iss !== "" && iss === sub ? iss : null;
    } catch {
      return null;
    }
  }

  /** User IDs MUST NOT contain or be derived from personal information (5.1). */
  checkUserId(userId: string): void {
    if (!this.userIds.has(userId)) {
      const lower = userId.toLowerCase();
      // The local part counts only as a whole word ("usr_ada", "ada_lovelace"):
      // 22 random base64url characters contain "ada" in about 1 ID in 1,600.
      // And not at all in an ID shaped like 128 random bits after a prefix,
      // whose `-` and `_` can make "ada" a word by chance (about 10 in a
      // million, as in "usr_hB1U-xQz3FnJ1q7J8u_adA"): both made tests fail at random.
      const random = /^[a-z]+_[A-Za-z0-9_-]{22,}$/.test(userId);
      const words = lower.split(/[^a-z0-9]+/);
      const personal = this.config.accounts.some(
        (account) =>
          lower.includes(account.email.toLowerCase()) ||
          (!random && words.includes(account.email.split("@")[0]!.toLowerCase()))
      );
      if (userId.includes("@") || personal) {
        this.violation("user-id.personal", `User ID ${JSON.stringify(userId)} contains personal information`);
      }
    }
    this.userIds.add(userId);
  }

  // ---- DPoP (4.5, RFC 9449) ----

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
      const error = fail("invalid_dpop_proof", `htu ${String(claims.htu)} != ${htu}`, "dpop.htu");
      if (!this.flawed("accept-wrong-htu")) throw error;
    }
    // Proofs carry the agent's real time; the fake clock moves only request timing.
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.iat !== "number" || Math.abs(now - claims.iat) > DPOP_WINDOW + SKEW) {
      throw fail("invalid_dpop_proof", "iat outside the acceptance window", "dpop.iat");
    }
    if (!this.freshJti("dpop", claims.jti)) {
      throw fail("invalid_dpop_proof", "jti reused", null);
    }
    // At the token endpoint there's no access token, so ath isn't checked (RFC 9449 4.3).
    if (!atTokenEndpoint && claims.ath !== (await sha256b64(accessToken))) {
      throw fail("invalid_dpop_proof", "ath doesn't match the token", "dpop.ath");
    }
    const jkt = await calculateJwkThumbprint(jwk);
    if (this.config.nonceLoop) {
      // Interop XN: never accept the nonce it issued, so every reply is a
      // fresh `use_dpop_nonce` challenge. An agent that retries without bound
      // would loop; a correct one gives up after a bounded number of tries.
      throw fail("use_dpop_nonce", "nonce required (loop)", null);
    }
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

  /**
   * An access token from a sign-in or refresh (4.5). It belongs to the
   * client and the account, not to a Session (5.4); `grant` is the sign-in
   * its refresh token descends from.
   */
  issueAccess(holder: { clientId: string; account: string; grant: string }, binding: { jkt: string | null; resource: string | null }, scope: readonly string[]): AccessToken {
    const now = Date.now();
    const token: AccessToken = {
      value: randomId("at_", 24),
      kind: binding.jkt ? "dpop" : "bearer",
      jkt: binding.jkt,
      resource: binding.resource,
      scope,
      account: holder.account,
      expiresAt: now + this.config.accessTokenTtl * 1000,
      issuedAt: now,
      clientId: holder.clientId,
      grant: holder.grant
    };
    this.accessTokens.set(token.value, token);
    return token;
  }

  /** A refresh token for a sign-in (4.4): its client, account and grant; it names no Session or User ID. */
  issueAccountToken(holder: { readonly clientId: string; readonly account: string; readonly grant: string }, scope: readonly string[]): AccountToken {
    const token: AccountToken = {
      value: randomId("pat_", 24),
      clientId: holder.clientId,
      account: holder.account,
      grant: holder.grant,
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
      expires_in: this.config.accessTokenTtl,
      // Plain OAuth token responses (4.7); Sessions are the Session header's.
      ...(this.config.omitTokenScope ? {} : { scope: access.scope.join(" ") })
    };
    if (refresh) {
      body.refresh_token = refresh.value;
      if (refresh.expiresAt) {
        body.refresh_token_expires_in = Math.round((refresh.expiresAt - Date.now()) / 1000);
      }
    }
    return json(body, 200, this.flawed("token-cacheable") ? {} : { "Cache-Control": "no-store", Pragma: "no-cache" });
  }

  // ---- The Session header (5.2, 5.3) ----

  /** Verified delegations by their compact form, until they expire (5.2: a resource "MAY cache a verified delegation"). */
  readonly #delegations = new Map<string, { readonly clientId: string; readonly jwk: JWK; readonly exp: number }>();
  /** The User each delegated key signed for, by thumbprint: one User ID per key (5.2). */
  readonly delegatedKeyUsers = new Map<string, string>();
  /** Sessions by `client_id` and `sid` (5.3, step 4). */
  readonly sessionsBySid = new Map<string, Session>();

  /** 400 `invalid_session` (5.3). */
  invalidSession(description?: string): HttpError {
    return new HttpError(json({ error: "invalid_session", ...(description ? { error_description: description } : {}) }, 400, { "Cache-Control": "no-store" }));
  }

  /**
   * A delegation (5.2, steps 1 and 2): signed by a key in the client's
   * `jwks_uri` that its `kid` names, typed, issued by the client, unexpired
   * and at most a day long, naming a public key and nothing about a User or
   * a Company. Returns the delegated public key.
   */
  async #verifyDelegation(client: ClientInfo, delegation: string): Promise<JWK> {
    const cached = this.#delegations.get(delegation);
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.clientId === client.clientId && cached.exp > now) return cached.jwk;
    const fail = (id: ViolationId, why: string): HttpError => {
      this.violation(id, `delegation: ${why}`);
      return this.invalidSession(why);
    };
    let header;
    let claims: JWTPayload;
    try {
      header = decodeProtectedHeader(delegation);
      claims = decodeJwt(delegation);
    } catch {
      throw fail("delegation.not-jwt", "pap_dlg is not a JWT");
    }
    if (header.typ !== "pap-delegation+jwt") throw fail("delegation.typ", `typ is ${JSON.stringify(header.typ)}, not pap-delegation+jwt`);
    if (!header.alg || !DELEGATION_ALGS.includes(header.alg)) throw fail("delegation.alg", `alg ${String(header.alg)} is not ES256 or PS384`);
    const signer = client.jwks.keys.find((key) => key.kid === header.kid);
    if (!signer) throw fail("delegation.kid", `kid ${JSON.stringify(header.kid)} names no key in jwks_uri`);
    try {
      // The signature alone: its times are checked below, each with its own finding.
      await compactVerify(delegation, await importJWK(signer, header.alg), { algorithms: DELEGATION_ALGS });
    } catch (cause) {
      throw fail("delegation.signature", `signature: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (claims.iss !== client.clientId) throw fail("delegation.iss", "iss isn't the Session JWT's iss");
    if (typeof claims.iat !== "number" || typeof claims.exp !== "number") throw fail("delegation.lifetime", "iat and exp are required");
    if (claims.exp - claims.iat > DELEGATION_LIFETIME) throw fail("delegation.lifetime", `exp is ${claims.exp - claims.iat} s after iat, more than 24 hours`);
    if (claims.exp <= now - SKEW) throw fail("delegation.expired", "the delegation has expired");
    if (typeof claims.jti !== "string" || claims.jti.length < 22) throw fail("delegation.jti", "jti is missing or guessable");
    const cnf = claims.cnf as { jwk?: unknown } | undefined;
    const jwk = cnf && typeof cnf.jwk === "object" && cnf.jwk !== null ? (cnf.jwk as JWK) : null;
    if (!jwk) throw fail("delegation.cnf", "cnf.jwk is missing");
    if (isPrivateJwk(jwk as unknown as Record<string, unknown>)) throw fail("delegation.private-key", "cnf.jwk contains private key members");
    const extra = Object.keys(claims).filter((name) => !["iss", "cnf", "iat", "exp", "jti", "nbf"].includes(name));
    if (extra.length > 0) {
      // 5.2: "MUST NOT put a User ID, an Agent ID, a Company's issuer, or anything else about the User or the Companies they use in a delegation."
      throw fail("delegation.names-user", `carries ${extra.join(", ")}, which can name the User or a Company`);
    }
    this.#delegations.set(delegation, { clientId: client.clientId, jwk, exp: claims.exp });
    return jwk;
  }

  /**
   * 5.3: the Session header on a request to a resource, verified in order:
   * the client metadata, the delegation, the JWT's signature and claims,
   * `ath` against the access token, then the Session by `client_id` and
   * `sid`, started when new. Every failure is 400 `invalid_session`.
   */
  async verifySessionHeader(inbound: Inbound, accessToken: string | null): Promise<{ readonly client: ClientInfo; readonly session: Session }> {
    const where = `${inbound.request.method} ${inbound.url.pathname}`;
    const fail = (id: ViolationId, why: string): HttpError => {
      this.violation(id, `Session JWT: ${why} (${where})`);
      return this.invalidSession(why);
    };
    const value = inbound.request.headers.get("Poppy-Session");
    if (!value) {
      throw accessToken !== null
        ? fail("session-jwt.missing-with-token", "an access token without the Session header")
        : fail("session-jwt.missing", "no Poppy-Session header");
    }
    let header;
    let claims: JWTPayload;
    try {
      header = decodeProtectedHeader(value);
      claims = decodeJwt(value);
    } catch {
      throw fail("session-jwt.not-jwt", "Poppy-Session is not a JWT");
    }
    if (header.typ !== "poppy-session+jwt") throw fail("session-jwt.typ", `typ is ${JSON.stringify(header.typ)}, not poppy-session+jwt`);
    if (header.alg !== "ES256") throw fail("session-jwt.alg", `alg ${String(header.alg)} is not ES256`);
    if (typeof header.pap_dlg !== "string") throw fail("session-jwt.no-delegation", "no pap_dlg delegation in the header");
    if (typeof claims.iss !== "string") throw fail("session-jwt.iss", "iss is missing");
    let client: ClientInfo;
    try {
      client = await this.client(claims.iss);
    } catch (error) {
      if (error instanceof HttpError) throw this.invalidSession("the client metadata couldn't be used");
      throw error;
    }
    const jwk = await this.#verifyDelegation(client, header.pap_dlg);
    if (header.kid !== (await calculateJwkThumbprint(jwk))) throw fail("session-jwt.kid", "kid isn't the delegated key's JWK thumbprint");
    try {
      await jwtVerify(value, await importJWK(jwk, "ES256"), { algorithms: ["ES256"], typ: "poppy-session+jwt" });
    } catch (cause) {
      throw fail("session-jwt.signature", `signature: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const delegation = this.#delegations.get(header.pap_dlg)!;
    if (typeof claims.iat !== "number") throw fail("session-jwt.iat", "iat is missing");
    if (claims.iat > delegation.exp) throw fail("session-jwt.after-delegation", "signed after its delegation expired");
    if (Array.isArray(claims.aud) || claims.aud !== this.hosts.issuer) throw fail("session-jwt.aud", `aud ${JSON.stringify(claims.aud)} isn't the issuer as a single string`);
    if (claims.htm !== inbound.request.method) throw fail("session-jwt.htm", `htm ${String(claims.htm)} isn't ${inbound.request.method}`);
    if (claims.htu !== `${inbound.url.origin}${inbound.url.pathname}`) throw fail("session-jwt.htu", `htu ${String(claims.htu)} isn't this URL without its query`);
    // Session JWTs carry the agent's real time; the fake clock moves only request timing.
    if (Math.abs(Math.floor(Date.now() / 1000) - claims.iat) > SESSION_JWT_WINDOW + SKEW) throw fail("session-jwt.iat", "iat is outside the acceptance window");
    if (!this.freshJti("session-jwt", claims.jti)) throw this.invalidSession("jti missing or reused");
    if (typeof claims.sid !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(claims.sid)) throw fail("session-jwt.sid", "sid isn't 1 to 256 URL-safe characters");
    if (typeof claims.sub !== "string" || claims.sub === "") throw fail("session-jwt.sub", "sub (the User ID) is missing");
    if ("agent_id" in claims && (typeof claims.agent_id !== "string" || claims.agent_id === "")) throw fail("session-jwt.sub", "agent_id isn't a string");
    if (accessToken !== null) {
      if (claims.ath !== (await sha256b64(accessToken))) throw fail("session-jwt.ath", "ath doesn't match the access token");
    } else if ("ath" in claims) {
      throw fail("session-jwt.ath-without-token", "ath without an access token");
    }
    const thumbprint = header.kid;
    const first = this.delegatedKeyUsers.get(thumbprint);
    if (first === undefined) this.delegatedKeyUsers.set(thumbprint, `${client.clientId}|${claims.sub}`);
    else if (first !== `${client.clientId}|${claims.sub}`) {
      // 5.2: "MUST use each delegated key, and its delegation, for one User ID only."
      this.violation("delegation.key-shared", `delegated key ${thumbprint} signed for another User ID`);
    }
    this.checkUserId(claims.sub);
    const agentId = typeof claims.agent_id === "string" ? claims.agent_id : null;
    const key = `${client.clientId}|${claims.sid}`;
    let session = this.sessionsBySid.get(key);
    if (!session) {
      session = { id: randomId("ses_", 8), clientId: client.clientId, userId: claims.sub, agentId, account: null, boundAccount: null, grant: null, scope: [], ended: false };
      this.sessions.set(session.id, session);
      this.sessionsBySid.set(key, session);
    } else if (session.userId !== claims.sub || (session.agentId ?? null) !== agentId) {
      throw fail("session-jwt.sub-changed", "a known sid with another User ID or Agent ID");
    }
    if (session.ended) throw this.invalidSession("the Session has ended");
    return { client, session };
  }

  /**
   * A resource request (5.3, 7). The Session header always; an access
   * token when signed in, with its DPoP proof when it is DPoP-bound. The
   * Session is signed in on this request when it carries a token for an
   * account, which it then keeps: a second account is refused (5.4).
   */
  async authorizeResource(inbound: Inbound, mcp = false): Promise<ResourceContext> {
    const queried = inbound.url.searchParams.get("access_token");
    // 5.6: tokens never come in a URL. A flawed Company takes one anyway, Session header or not.
    if (queried && this.flawed("accept-query-token")) {
      const token = this.accessTokens.get(queried);
      if (!token || token.expiresAt <= Date.now()) throw resourceError("Bearer", 401, "invalid_token");
      const { client, session } = await this.verifySessionHeader(inbound, null);
      return { token, session, client, signedIn: true, account: token.account, scope: token.scope };
    }
    const header = inbound.request.headers.get("Authorization");
    let token: AccessToken | null = null;
    let value: string | null = null;
    let scheme: "DPoP" | "Bearer" = this.config.dpopTokens ? "DPoP" : "Bearer";
    let given: string | null = null;
    if (header) {
      const [named, presented] = header.split(" ", 2) as [string, string | undefined];
      given = named;
      if (!presented || (given !== "Bearer" && given !== "DPoP")) throw resourceError(scheme, 401, "invalid_token");
      value = presented;
      token = this.accessTokens.get(presented) ?? null;
      scheme = token?.kind === "bearer" ? "Bearer" : "DPoP";
      if (!token || token.expiresAt <= Date.now() || (token.grant && this.#grantRevoked(token.grant))) {
        // Verify the Session header still, so a bad one is reported first (5.3).
        await this.verifySessionHeader(inbound, presented);
        throw resourceError(scheme, 401, "invalid_token");
      }
      if ((given === "DPoP") !== (token.kind === "dpop")) {
        this.violation("resource.bearer-scheme", `${given} scheme for a ${token.kind === "dpop" ? "DPoP-bound" : "Bearer"} token on ${inbound.url.pathname}`);
        // A flawed Company takes a DPoP-bound token as Bearer, with no proof (RFC 9449 7.1 forbids it).
        if (!(given === "Bearer" && this.flawed("accept-bearer-scheme"))) throw resourceError(scheme, 401, "invalid_token");
      }
      // 4.5, 7: a token for one service only there, and an MCP server only takes its own.
      const resource = mcp ? this.hosts.mcpUrl : this.config.apiResource && inbound.url.origin === this.hosts.api ? this.hosts.api : null;
      if (token.resource !== resource) {
        if (mcp) this.violation("mcp.wrong-token", "MCP request with a token not issued for this MCP server");
        throw resourceError(scheme, 401, "invalid_token", { headers: mcp ? { "WWW-Authenticate": `${scheme} error="invalid_token", resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", this.hosts.mcpUrl).href}"` } : {} });
      }
    }
    const { client, session } = await this.verifySessionHeader(inbound, value);
    if (token && value) {
      if (token.clientId !== client.clientId) {
        // 5.3, step 3: the token was issued to the same client_id as iss. Sign-in names no User ID, so the token can't.
        this.violation("session-jwt.token-other-client", "the access token was issued to another client");
        throw this.invalidSession("the access token isn't this client's");
      }
      if (token.kind === "dpop" && given === "DPoP") {
        const jkt = await this.verifyDpop(inbound, value);
        if (jkt !== token.jkt) {
          this.violation("dpop.key-mismatch", "DPoP proof key isn't the key the token is bound to");
          if (!this.flawed("accept-other-key")) throw resourceError("DPoP", 401, "invalid_dpop_proof");
        }
      }
      if (session.boundAccount && session.boundAccount !== token.account) {
        // 5.4: "SHOULD start a new Session rather than use a second account in one Session"; the Company MAY refuse.
        this.violation("session.second-account", `Session ${session.id} used with a second account`);
        throw this.invalidSession("this Session is for another account");
      }
      session.account = token.account;
      session.boundAccount = token.account;
      session.grant = token.grant;
      session.scope = [...token.scope];
    } else {
      session.account = null;
    }
    return { token, session, client, signedIn: token !== null, account: token?.account ?? null, scope: token?.scope ?? [] };
  }

  /** Whether the refresh token family `grant` was revoked: its access tokens are refused (RFC 7009 2.1). */
  #grantRevoked(grant: string): boolean {
    let any = false;
    for (const token of this.accountTokens.values()) {
      if (token.grant !== grant) continue;
      any = true;
      if (!token.revoked && !token.rotated) return false;
    }
    return any;
  }

  /** A challenge for the account (7: "No error code", 401, with the scopes needed), or `insufficient_scope`. */
  requireScopes(context: ResourceContext, needed: readonly string[], mcp = false): void {
    const schemes = mcp ? ["Bearer"] : this.config.dpopTokens ? ["DPoP", "Bearer"] : ["Bearer"];
    const scope = needed.join(" ");
    const metadata = mcp ? `, resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", this.hosts.mcpUrl).href}"` : "";
    if (!context.signedIn) {
      throw new HttpError(json({}, 401, { "WWW-Authenticate": schemes.map((s) => `${s} scope="${scope}"${metadata}${s === "DPoP" ? ', algs="ES256"' : ""}`).join(", ") }));
    }
    if (!needed.every((entry) => context.scope.includes(entry))) {
      const scheme = context.token?.kind === "dpop" ? "DPoP" : "Bearer";
      throw new HttpError(json({ error: "insufficient_scope" }, 403, { "WWW-Authenticate": `${scheme} error="insufficient_scope", scope="${scope}"${metadata}` }));
    }
  }
}
