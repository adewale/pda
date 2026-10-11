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
  type MockConfig
} from "./types";

export const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
export const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

const SIGNING_ALGS = ["ES256", "RS256"];
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "k"];
/** DPoP acceptance window plus clock skew, seconds. */
const DPOP_WINDOW = 60;
const SKEW = 30;
/** Longest assertion lifetime accepted, seconds. */
const MAX_ASSERTION_LIFETIME = 300;

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
  config: MockConfig = DEFAULT_CONFIG;
  readonly hosts: Hosts;
  readonly violations: string[] = [];
  readonly requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
    bodyKeys: string[];
  }[] = [];
  readonly clients = new Map<string, ClientInfo>();
  readonly userIds = new Set<string>();
  readonly sessions = new Map<string, Session>();
  readonly accessTokens = new Map<string, AccessToken>();
  /** Latest token issued per Session and kind/resource, with when. */
  readonly latestToken = new Map<string, { value: string; at: number }>();
  readonly accountTokens = new Map<string, AccountToken>();
  readonly seenJtis = new Map<string, Set<string>>();
  /** DPoP keys we've sent a nonce to, by thumbprint and server origin. */
  readonly nonceSentTo = new Set<string>();
  readonly nonce = randomId("n_");
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

  violation(message: string): void {
    this.violations.push(message);
  }

  log(inbound: Inbound, bodyKeys: string[]): void {
    const headers: Record<string, string> = {};
    inbound.request.headers.forEach((value, name) => {
      headers[name] = ["authorization", "dpop", "cookie"].includes(name)
        ? "<present>"
        : value;
    });
    this.requests.push({
      method: inbound.request.method,
      url: inbound.url.href,
      headers,
      bodyKeys
    });
  }

  /** JTIs are single-use within each kind of JWT. */
  freshJti(kind: string, jti: unknown): boolean {
    if (typeof jti !== "string" || jti === "") {
      this.violation(`${kind}: missing jti`);
      return false;
    }
    if (!/^[A-Za-z0-9_-]{22,}$/.test(jti)) {
      this.violation(`${kind}: jti ${JSON.stringify(jti)} is not 128 random bits of base64url`);
    }
    let seen = this.seenJtis.get(kind);
    if (!seen) {
      seen = new Set();
      this.seenJtis.set(kind, seen);
    }
    if (seen.has(jti)) {
      this.violation(`${kind}: reused jti ${jti}`);
      return false;
    }
    seen.add(jti);
    return true;
  }

  // ---- Rate limits (4.3) ----

  /** 429 when configured; a request before an earlier Retry-After is a violation. */
  rateLimit(kind: "token" | "other", inbound: Inbound): void {
    const now = Date.now();
    if (now < this.retryAfterUntil) {
      this.violation(
        `sent ${inbound.request.method} ${inbound.url.pathname} before Retry-After elapsed`
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
      kind: string,
      secret: string,
      allowedHere: boolean
    ) => {
      for (const [where, text] of places) {
        if (!text.includes(secret)) continue;
        if (allowedHere && where === "body") continue;
        this.violation(`${kind} sent in ${where} of ${inbound.request.method} ${inbound.url.href}`);
      }
    };
    for (const account of this.config.accounts) {
      check("password", account.password, allowed === "credentials");
    }
    for (const code of this.oneTimeCodes) check("one-time code", code, allowed === "code");
    for (const token of this.accountTokens.values()) {
      check("Account Token", token.value, allowed === "account-token");
    }
    // Session Tokens never belong in a URL (4.3).
    for (const [name, value] of inbound.url.searchParams) {
      if (
        name === "access_token" ||
        name === "token" ||
        this.accessTokens.has(value) ||
        this.accountTokens.has(value)
      ) {
        this.violation(`token sent in URL ${inbound.url.href}`);
        throw resourceError("DPoP", 401, "invalid_token");
      }
    }
  }

  // ---- Fetching the Personal Agent's metadata (4.1) ----

  async #fetchAgent(url: string): Promise<Response> {
    const agentHost = new URL(this.env.PUBLIC_ORIGIN).host;
    const request = new Request(url, { redirect: "manual" });
    // Guides: never send credentials on metadata fetches; fetch without redirects.
    if (new URL(url).host === agentHost) return worker.fetch(request, this.env);
    return fetch(request);
  }

  async client(clientId: string): Promise<ClientInfo> {
    const cached = this.clients.get(clientId);
    if (cached) return cached;
    const fail = (message: string): HttpError => {
      this.violation(`client metadata: ${message}`);
      return oauthError(401, "invalid_client", message);
    };
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw fail(`client_id ${JSON.stringify(clientId)} is not a URL`);
    }
    if (url.protocol !== "https:") throw fail("client_id must be an https URL");
    const response = await this.#fetchAgent(clientId);
    if (response.status !== 200) {
      throw fail(`fetching client_id returned ${response.status}; it must not redirect`);
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = (await response.json()) as Record<string, unknown>;
    } catch {
      throw fail("client metadata is not JSON");
    }
    if (metadata.client_id !== clientId) {
      throw fail("client_id in the document doesn't equal the URL it was fetched from");
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
      throw fail("jwks_uri must be https on the client_id domain");
    }
    const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
    if (!redirectUris.every(sameDomain)) {
      throw fail("redirect_uris must be https on the client_id domain");
    }
    if (metadata.token_endpoint_auth_method !== "private_key_jwt") {
      this.violation("client metadata: token_endpoint_auth_method should be private_key_jwt");
    }
    const jwksResponse = await this.#fetchAgent(metadata.jwks_uri as string);
    if (jwksResponse.status !== 200) throw fail(`jwks_uri returned ${jwksResponse.status}`);
    const jwks = (await jwksResponse.json()) as JSONWebKeySet;
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw fail("JWKS has no keys");
    for (const key of jwks.keys) {
      if (isPrivateJwk(key as unknown as Record<string, unknown>)) {
        throw fail("JWKS publishes a private key");
      }
      if (!key.kid) this.violation("JWKS key without kid (Guides: give every key a kid)");
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
  async #verifyClientJwt(
    client: ClientInfo,
    token: string,
    kind: string,
    error: () => HttpError
  ): Promise<JWTPayload> {
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      this.violation(`${kind}: not a JWT`);
      throw error();
    }
    if (!header.alg || !SIGNING_ALGS.includes(header.alg)) {
      this.violation(`${kind}: alg ${header.alg} is not allowed`);
      throw error();
    }
    if (header.jku || header.x5u || header.jwk) {
      this.violation(`${kind}: embeds or points to a key (jku/x5u/jwk)`);
    }
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(client.jwks), {
        algorithms: SIGNING_ALGS,
        clockTolerance: SKEW
      });
      return payload;
    } catch (cause) {
      this.violation(`${kind}: ${cause instanceof Error ? cause.message : String(cause)}`);
      throw error();
    }
  }

  #checkLifetime(kind: string, payload: JWTPayload): boolean {
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
      this.violation(`${kind}: iat and exp are required`);
      return false;
    }
    if (payload.exp - payload.iat > MAX_ASSERTION_LIFETIME) {
      this.violation(`${kind}: lifetime ${payload.exp - payload.iat}s is too long`);
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
      this.violation(`no client assertion at ${endpoint}`);
      throw oauthError(401, "invalid_client", "client assertion is required");
    }
    const registered = this.config.requireRegistration;
    if (registered && !registered.includes(clientId)) {
      throw oauthError(401, "invalid_client", "this Personal Agent is not registered");
    }
    const client = await this.client(clientId);
    const header = decodeProtectedHeader(assertion);
    if (header.typ === "poppy-browser+jwt" || header.typ === "dpop+jwt") {
      this.violation(`client assertion has typ ${header.typ}`);
      throw oauthError(401, "invalid_client");
    }
    const payload = await this.#verifyClientJwt(client, assertion, "client assertion", () =>
      oauthError(401, "invalid_client", "client assertion did not verify")
    );
    if (Array.isArray(payload.aud)) {
      this.violation("client assertion: aud is an array");
      throw oauthError(401, "invalid_client");
    }
    const audiences = [endpoint, this.hosts.tokenEndpoint, this.hosts.issuer];
    if (typeof payload.aud !== "string" || !audiences.includes(payload.aud)) {
      this.violation(`client assertion: aud ${JSON.stringify(payload.aud)} is not this Company`);
      throw oauthError(401, "invalid_client");
    }
    if (payload.iss !== clientId || payload.sub !== clientId) {
      this.violation("client assertion: iss and sub must both be the client_id");
      throw oauthError(401, "invalid_client");
    }
    if (!this.#checkLifetime("client assertion", payload)) {
      throw oauthError(401, "invalid_client");
    }
    if (!this.freshJti("client assertion", payload.jti)) {
      throw oauthError(401, "invalid_client", "assertion jti already used");
    }
    return client;
  }

  /** The Session assertion of the JWT bearer grant (4.2). Returns the User ID. */
  async verifySessionAssertion(client: ClientInfo, assertion: string | null): Promise<string> {
    if (!assertion) {
      this.violation("JWT bearer grant without an assertion");
      throw oauthError(400, "invalid_grant", "assertion is required");
    }
    let header;
    try {
      header = decodeProtectedHeader(assertion);
    } catch {
      this.violation("Session assertion: not a JWT");
      throw oauthError(400, "invalid_grant");
    }
    if (header.typ === "poppy-browser+jwt") {
      this.violation("browser assertion sent to the token endpoint");
      throw oauthError(400, "invalid_grant");
    }
    const payload = await this.#verifyClientJwt(client, assertion, "Session assertion", () =>
      oauthError(400, "invalid_grant", "assertion did not verify")
    );
    if (Array.isArray(payload.aud) || payload.aud !== this.hosts.tokenEndpoint) {
      this.violation(
        `Session assertion: aud must be the token_endpoint as a single string, got ${JSON.stringify(payload.aud)}`
      );
      throw oauthError(400, "invalid_grant");
    }
    if (payload.iss !== client.clientId) {
      this.violation("Session assertion: iss must be the client_id");
      throw oauthError(400, "invalid_grant");
    }
    if (typeof payload.sub !== "string" || payload.sub === "") {
      this.violation("Session assertion: sub (User ID) is missing");
      throw oauthError(400, "invalid_grant");
    }
    if (!this.#checkLifetime("Session assertion", payload)) throw oauthError(400, "invalid_grant");
    if (!this.freshJti("Session assertion", payload.jti)) {
      throw oauthError(400, "invalid_grant", "assertion jti already used");
    }
    this.checkUserId(payload.sub);
    return payload.sub;
  }

  /** User IDs MUST NOT contain or be derived from personal information (4.2). */
  checkUserId(userId: string): void {
    if (!this.userIds.has(userId)) {
      const lower = userId.toLowerCase();
      const personal = this.config.accounts.some(
        (account) =>
          lower.includes(account.email.toLowerCase()) ||
          lower.includes(account.email.split("@")[0]!.toLowerCase())
      );
      if (userId.includes("@") || personal) {
        this.violation(`User ID ${JSON.stringify(userId)} contains personal information`);
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
    const fail = (error: string, why: string, isViolation = true): HttpError => {
      if (isViolation) this.violation(`DPoP: ${why} (${inbound.request.method} ${inbound.url.pathname})`);
      const headers: Record<string, string> = { "WWW-Authenticate": `DPoP error="${error}"` };
      if (error === "use_dpop_nonce") headers["DPoP-Nonce"] = this.nonce;
      return atTokenEndpoint
        ? oauthError(400, error, why, headers)
        : resourceError("DPoP", 401, error, {
            headers: error === "use_dpop_nonce" ? { "DPoP-Nonce": this.nonce } : {}
          });
    };
    const proofs = inbound.request.headers.get("DPoP");
    if (!proofs) throw fail("invalid_dpop_proof", "missing DPoP header");
    if (proofs.includes(",")) throw fail("invalid_dpop_proof", "more than one DPoP proof");
    let header;
    let claims: JWTPayload;
    try {
      header = decodeProtectedHeader(proofs);
      claims = decodeJwt(proofs);
    } catch {
      throw fail("invalid_dpop_proof", "proof is not a JWT");
    }
    if (header.typ !== "dpop+jwt") throw fail("invalid_dpop_proof", `typ is ${header.typ}`);
    if (!header.alg || !SIGNING_ALGS.includes(header.alg)) {
      throw fail("invalid_dpop_proof", `alg ${header.alg} not allowed`);
    }
    const jwk = header.jwk as JWK | undefined;
    if (!jwk) throw fail("invalid_dpop_proof", "no jwk in header");
    if (isPrivateJwk(jwk as unknown as Record<string, unknown>)) {
      throw fail("invalid_dpop_proof", "jwk contains a private key");
    }
    try {
      const key = await importJWK(jwk, header.alg);
      await jwtVerify(proofs, key, { typ: "dpop+jwt", algorithms: SIGNING_ALGS });
    } catch (cause) {
      throw fail("invalid_dpop_proof", `signature: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const htu = `${inbound.url.origin}${inbound.url.pathname}`;
    if (claims.htm !== inbound.request.method) {
      throw fail("invalid_dpop_proof", `htm ${String(claims.htm)} != ${inbound.request.method}`);
    }
    if (claims.htu !== htu) {
      throw fail("invalid_dpop_proof", `htu ${String(claims.htu)} != ${htu}`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.iat !== "number" || Math.abs(now - claims.iat) > DPOP_WINDOW + SKEW) {
      throw fail("invalid_dpop_proof", "iat outside the acceptance window");
    }
    if (!this.freshJti("DPoP proof", claims.jti)) {
      throw fail("invalid_dpop_proof", "jti reused", false);
    }
    if (atTokenEndpoint) {
      if ("ath" in claims) throw fail("invalid_dpop_proof", "ath on a token request");
    } else if (claims.ath !== (await sha256b64(accessToken))) {
      throw fail("invalid_dpop_proof", "ath doesn't match the token");
    }
    const jkt = await calculateJwkThumbprint(jwk);
    if (this.config.requireNonce && claims.nonce !== this.nonce) {
      // Nonces belong to a server (RFC 9449; Guides: "keep it for that server"),
      // so only a server that already sent this key a nonce can expect it back.
      const sentTo = `${jkt}|${inbound.url.origin}`;
      if (claims.nonce === undefined && this.nonceSentTo.has(sentTo)) {
        this.violation("DPoP: proof without the nonce the Company already sent (must support nonces)");
      }
      this.nonceSentTo.add(sentTo);
      throw fail("use_dpop_nonce", "nonce required", false);
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
      at: now
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
      this.violation(`request without a Session Token: ${inbound.request.method} ${inbound.url.href}`);
      throw resourceError(scheme, 401, "invalid_token");
    }
    const [given, value] = header.split(" ", 2) as [string, string | undefined];
    if (!value) throw resourceError(scheme, 401, "invalid_token");
    const token = this.accessTokens.get(value);
    if (mcp) {
      if (given !== "Bearer") {
        this.violation(`MCP request with ${given} scheme; MCP uses Bearer`);
        throw resourceError("Bearer", 401, "invalid_token");
      }
      if (token && (token.kind !== "bearer" || token.resource !== this.hosts.mcpUrl)) {
        this.violation("MCP request with a token not issued for this MCP server");
        throw resourceError("Bearer", 401, "invalid_token");
      }
    } else {
      if (given !== "DPoP") {
        this.violation(`${given} token on ${inbound.url.pathname}; Bearer is only for MCP`);
        throw resourceError("DPoP", 401, "invalid_token");
      }
      if (token && token.kind !== "dpop") {
        this.violation("Bearer Session Token sent with the DPoP scheme");
        throw resourceError("DPoP", 401, "invalid_token");
      }
    }
    if (!token) throw resourceError(scheme, 401, "invalid_token");
    if (token.expiresAt <= Date.now()) throw resourceError(scheme, 401, "invalid_token");
    const session = this.sessions.get(token.sessionId);
    if (!session || session.ended) throw resourceError(scheme, 401, "invalid_token");
    if (!mcp) {
      const jkt = await this.verifyDpop(inbound, value);
      if (jkt !== token.jkt) {
        this.violation("DPoP proof key isn't the key the token is bound to");
        throw resourceError("DPoP", 401, "invalid_dpop_proof");
      }
    }
    const latest = this.latestToken.get(`${session.id}|${token.kind}|${token.resource ?? ""}`);
    if (latest && latest.value !== token.value && Date.now() - latest.at > 2000) {
      this.violation("used an older Session Token after a newer one was issued for the Session");
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
