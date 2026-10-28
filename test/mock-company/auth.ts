import {
  Company,
  DEVICE_CODE,
  HttpError,
  MEDIATED_GRANT,
  json,
  oauthError,
  parseScope,
  randomId,
  redirectUriMatches,
  sha256b64,
  type ClientInfo,
  type Inbound
} from "./core";

type AuthorizationRequest = {
  readonly id: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: readonly string[];
  readonly state: string;
  readonly challenge: string;
};

type AuthorizationCode = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly account: string;
  readonly scope: readonly string[];
  readonly expiresAt: number;
  used: boolean;
};

type DeviceRequest = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly clientId: string;
  readonly scope: readonly string[];
  readonly expiresAt: number;
  interval: number;
  lastPoll: number;
  status: "pending" | "approved" | "denied" | "done";
  account: string | null;
  granted: readonly string[];
  slowedDown: boolean;
};

type MediatedSignIn = {
  readonly id: string;
  /** The client that started it, which alone can finish it (Mediated Sign-In 4). */
  readonly clientId: string;
  readonly account: string;
  readonly scope: readonly string[];
  readonly code: string;
  readonly expiresAt: number;
  attempts: number;
  finished: boolean;
};

/** The Company's OAuth server and Mediated Sign-In's grant (spec 4.2–4.7, Mediated Sign-In 3–5). */
export class AuthServer {
  readonly #requests = new Map<string, AuthorizationRequest>();
  readonly #codes = new Map<string, AuthorizationCode>();
  readonly #devices = new Map<string, DeviceRequest>();
  readonly #mediated = new Map<string, MediatedSignIn>();
  #mediatedAttempts = 0;

  constructor(readonly company: Company) {}

  /** A form at one of the issuer's OAuth endpoints, which never carries the Session header (5.2). */
  #form(inbound: Inbound): URLSearchParams {
    if (inbound.request.headers.has("Poppy-Session")) {
      this.company.violation("session-jwt.oauth-endpoint", `${inbound.url.pathname} got a Poppy-Session header`);
    }
    const type = inbound.request.headers.get("Content-Type") ?? "";
    if (!type.startsWith("application/x-www-form-urlencoded")) {
      this.company.violation("form.not-form", `${inbound.url.pathname} sent as ${JSON.stringify(type)}, not a form`);
      throw oauthError(400, "invalid_request", "expected a form body");
    }
    return new URLSearchParams(inbound.bodyText);
  }

  #allowedScopes(type: "direct" | "device" | "mediated"): readonly string[] | null {
    return this.company.offeredScopes(type);
  }

  /** Each sign-in MUST include `scope`; unknown or unavailable scopes are refused (4.7). */
  #checkScopes(type: "direct" | "device" | "mediated", raw: string | null): string[] {
    if (raw === null || raw.trim() === "") {
      this.company.violation("signin.no-scope", `${type} sign-in without scope`);
      throw oauthError(400, "invalid_scope", "scope is required");
    }
    const scope = parseScope(raw);
    const allowed = this.#allowedScopes(type) ?? [];
    if (!scope.every((entry) => allowed.includes(entry))) {
      throw oauthError(400, "invalid_scope", `${type} sign-in can grant only ${allowed.join(" ")}`);
    }
    return scope;
  }

  // ---- Token endpoint ----

  async token(inbound: Inbound): Promise<Response> {
    const co = this.company;
    co.rateLimit("token", inbound);
    const form = this.#form(inbound);
    const client = await co.authenticateClient(form, co.hosts.tokenEndpoint);
    return this.#tokenGrant(inbound, form, client);
  }

  /**
   * The token endpoint (4.4, 4.5, 4.7): refresh, the code, the device code and
   * Mediated Sign-In's grant, each returning an access token and, from a
   * sign-in, a refresh token. Nothing names a Session. A DPoP proof is sent
   * when the metadata lists `dpop_signing_alg_values_supported` (4.5); with
   * one, the access token is bound to it, except an MCP server's, which
   * takes Bearer tokens unless `mcpDpop`.
   */
  async #tokenGrant(inbound: Inbound, form: URLSearchParams, client: ClientInfo): Promise<Response> {
    const co = this.company;
    const grant = form.get("grant_type");
    const resource = form.get("resource");
    const isMcp = resource === co.hosts.mcpUrl;
    if (resource !== null && !isMcp && !(co.config.apiResource && resource === co.hosts.api)) throw oauthError(400, "invalid_target", "unknown resource");
    const proof = inbound.request.headers.get("DPoP");
    if (co.config.dpopTokens && !proof) {
      co.violation("token.dpop-not-sent", `token request (${grant}) without a DPoP proof, though the metadata lists dpop_signing_alg_values_supported`);
      throw oauthError(400, "invalid_dpop_proof", "a DPoP proof is required");
    }
    const jkt = proof ? await co.verifyDpop(inbound, undefined) : null;
    const binding = { jkt: isMcp && !co.config.mcpDpop ? null : jkt, resource };
    switch (grant) {
      case "refresh_token":
        return this.#refresh(client, form, binding);
      case "authorization_code":
        return this.#authorizationCode(client, form, binding);
      case DEVICE_CODE:
        return this.#deviceCode(client, form, binding);
      case MEDIATED_GRANT:
        return this.#mediatedGrant(client, form, binding);
      default:
        throw oauthError(400, "unsupported_grant_type");
    }
  }

  async #refresh(client: ClientInfo, form: URLSearchParams, binding: { jkt: string | null; resource: string | null }): Promise<Response> {
    const co = this.company;
    const token = this.#accountToken(client, form.get("refresh_token"));
    let scope = [...token.scope];
    const asked = form.get("scope");
    if (asked !== null) {
      const narrower = parseScope(asked);
      if (!narrower.every((entry) => token.scope.includes(entry))) throw oauthError(400, "invalid_scope", "can't ask for more scope than the refresh token has");
      scope = narrower;
    }
    let rotated;
    if (co.config.rotateRefreshTokens) {
      token.rotated = true;
      rotated = co.issueAccountToken(token, token.scope);
    }
    return co.tokenResponse(co.issueAccess(token, binding, scope), rotated);
  }

  /** A completed sign-in: a refresh token for a new grant, and an access token from it. */
  #signedIn(client: ClientInfo, account: string, scope: readonly string[], binding: { jkt: string | null; resource: string | null }): Response {
    const co = this.company;
    const refresh = co.issueAccountToken({ clientId: client.clientId, account, grant: randomId("grt_", 8) }, scope);
    return co.tokenResponse(co.issueAccess(refresh, binding, scope), refresh);
  }

  /**
   * Mediated Sign-In's grant (Mediated Sign-In 3, 4): the credentials and
   * `scope`, or, after `code_required`, `sign_in_id` and `one_time_code`
   * alone. Only the client that started a sign-in can finish it.
   */
  async #mediatedGrant(client: ClientInfo, form: URLSearchParams, binding: { jkt: string | null; resource: string | null }): Promise<Response> {
    const co = this.company;
    if (!co.config.signIn.mediated) throw oauthError(400, "unsupported_grant_type");
    const signInId = form.get("sign_in_id");
    if (signInId !== null) {
      if (form.has("email") || form.has("password")) co.violation("mediated.credentials-with-code", "credentials resent with the one-time code (Mediated Sign-In 4: not the credentials or scope)");
      if (form.has("scope")) co.violation("mediated.scope-with-code", "scope resent with the one-time code (Mediated Sign-In 4: the sign-in keeps its first scopes)");
      const signIn = this.#mediated.get(signInId);
      if (signIn && signIn.clientId !== client.clientId) co.violation("mediated.code-other-client", `one-time code for ${signIn.id} sent by another client`);
      if (!signIn || signIn.clientId !== client.clientId || signIn.finished) throw oauthError(400, "invalid_grant", "unknown sign_in_id");
      if (signIn.expiresAt <= co.now()) {
        signIn.finished = true;
        throw oauthError(400, "expired_token");
      }
      if (form.get("one_time_code") !== signIn.code) {
        signIn.attempts += 1;
        if (signIn.attempts >= 3) {
          signIn.finished = true;
          throw oauthError(400, "invalid_grant", "too many wrong codes");
        }
        return this.#codeRequired(signIn);
      }
      signIn.finished = true;
      return this.#signedIn(client, signIn.account, signIn.scope, binding);
    }
    const scope = this.#checkScopes("mediated", form.get("scope"));
    for (const field of ["email", "password"]) {
      if (!form.has(field)) co.violation("mediated.missing-field", `mediated sign-in missing field ${field}`);
    }
    if (++this.#mediatedAttempts > 20) throw oauthError(400, "invalid_grant");
    const account = co.config.accounts.find((entry) => entry.email === form.get("email") && entry.password === form.get("password"));
    if (!account) throw oauthError(400, "invalid_grant", "sign-in didn't succeed");
    if (!account.otp) return this.#signedIn(client, account.account, scope, binding);
    const code = randomId("", 6).replace(/[^A-Za-z0-9]/g, "X").toUpperCase();
    co.oneTimeCodes.add(code);
    co.lastOneTimeCode = code;
    const signIn: MediatedSignIn = { id: randomId("sgn_", 8), clientId: client.clientId, account: account.account, scope, code, expiresAt: co.now() + 5 * 60_000, attempts: 0, finished: false };
    this.#mediated.set(signIn.id, signIn);
    return this.#codeRequired(signIn);
  }

  #codeRequired(signIn: MediatedSignIn): Response {
    const co = this.company;
    return json(
      { error: "code_required", sign_in_id: signIn.id, sent_to: "Text to the phone number ending in 71", expires_in: Math.max(1, Math.round((signIn.expiresAt - co.now()) / 1000)) },
      400,
      { "Cache-Control": "no-store" }
    );
  }

  #accountToken(client: ClientInfo, value: string | null) {
    const co = this.company;
    const token = value ? co.accountTokens.get(value) : undefined;
    if (!token) throw oauthError(400, "invalid_grant", "unknown refresh token");
    if (token.clientId !== client.clientId) {
      co.violation("account-token.other-client", "refresh token used by a different client_id");
      throw oauthError(400, "invalid_grant");
    }
    if (token.rotated) {
      co.violation("account-token.rotated-reused", "used a refresh token after the Company rotated it (4.4)");
    }
    if (token.rotated && !co.flawed("accept-rotated-account-token")) {
      if (co.config.reuseDetection) {
        // Reuse means the token leaked: revoke every token descended from the sign-in (RFC 9700 4.14.2).
        for (const other of co.accountTokens.values()) {
          if (other.clientId === token.clientId && other.grant === token.grant) {
            this.revokeToken(other.value);
          }
        }
      }
      throw oauthError(400, "invalid_grant", "refresh token was rotated");
    }
    if (token.revoked || (token.expiresAt !== null && token.expiresAt <= Date.now())) {
      throw oauthError(400, "invalid_grant", "refresh token expired or revoked");
    }
    return token;
  }

  async #authorizationCode(
    client: ClientInfo,
    form: URLSearchParams,
    binding: { jkt: string | null; resource: string | null }
  ): Promise<Response> {
    const co = this.company;
    const value = form.get("code") ?? "";
    const code = this.#codes.get(value);
    if (!code || code.expiresAt <= Date.now()) {
      throw oauthError(400, "invalid_grant", "code expired or unknown");
    }
    if (code.used) {
      co.violation("code.reused", "authorization code used twice");
      throw oauthError(400, "invalid_grant", "code already used");
    }
    code.used = true;
    if (code.clientId !== client.clientId) throw oauthError(400, "invalid_grant");
    if (form.get("redirect_uri") !== code.redirectUri) {
      co.violation("code.redirect-uri", "redirect_uri at the token endpoint differs from the authorization request");
      throw oauthError(400, "invalid_grant");
    }
    const verifier = form.get("code_verifier");
    if (!verifier || (await sha256b64(verifier)) !== code.challenge) {
      co.violation("code.pkce", "PKCE code_verifier doesn't match the challenge");
      throw oauthError(400, "invalid_grant");
    }
    return this.#signedIn(client, code.account, code.scope, binding);
  }

  async #deviceCode(
    client: ClientInfo,
    form: URLSearchParams,
    binding: { jkt: string | null; resource: string | null }
  ): Promise<Response> {
    const co = this.company;
    const device = this.#devices.get(form.get("device_code") ?? "");
    if (!device || device.clientId !== client.clientId) {
      throw oauthError(400, "invalid_grant", "unknown device_code");
    }
    // Polling is timed by the test agent's fake clock.
    const now = co.now();
    if (device.status === "denied" || device.status === "done") {
      if (device.status === "done" || device.lastPoll < 0) {
        co.violation(
          "device.polled-after-final",
          `kept polling after ${device.status === "done" ? "completion" : "access_denied"}`
        );
      }
      device.lastPoll = -1;
      throw oauthError(400, device.status === "done" ? "invalid_grant" : "access_denied");
    }
    if (device.expiresAt <= now) {
      if (device.lastPoll < 0) co.violation("device.polled-after-expiry", "kept polling after expired_token");
      device.lastPoll = -1;
      throw oauthError(400, "expired_token");
    }
    if (device.lastPoll > 0 && now - device.lastPoll < device.interval * 1000 - 250) {
      if (device.slowedDown) {
        co.violation(
          "device.too-fast",
          `polled ${now - device.lastPoll} ms after the last poll, under the ${device.interval} s interval after slow_down`
        );
      }
      device.slowedDown = true;
      device.interval += 5;
      device.lastPoll = now;
      throw oauthError(400, "slow_down");
    }
    device.lastPoll = now;
    if (device.status === "pending") throw oauthError(400, "authorization_pending");
    device.status = "done";
    return this.#signedIn(client, device.account!, device.granted, binding);
  }

  // ---- Revocation (4.6) ----

  async revoke(inbound: Inbound): Promise<Response> {
    const co = this.company;
    co.rateLimit("token", inbound);
    const form = this.#form(inbound);
    const client = await co.authenticateClient(form, co.hosts.revocationEndpoint);
    // RFC 7009 makes the hint optional: recorded, never required.
    co.revocationHints.push(form.get("token_type_hint"));
    // A Company that won't accept it yet: the token stays live (a test sets how many times).
    if (co.revocationsRefused < co.config.refuseRevocations) {
      co.revocationsRefused += 1;
      throw oauthError(401, "invalid_client", "Client authentication failed");
    }
    const token = co.accountTokens.get(form.get("token") ?? "");
    // RFC 7009: unknown tokens still get 200.
    if (token && token.clientId === client.clientId) this.revokeToken(token.value);
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  }

  /**
   * Revoke a refresh token and sign out every Session signed in with it
   * (4.6, 5.5): with it or a token it was rotated from, not every Session signed
   * in to the same account by another sign-in (spec-issues N4).
   */
  revokeToken(value: string): void {
    const co = this.company;
    const token = co.accountTokens.get(value);
    if (!token) return;
    token.revoked = true;
    for (const session of co.sessions.values()) {
      // 0.3: refresh tokens name no User ID; the Sessions that used its sign-in continue signed out (5.5).
      if (
        session.clientId === token.clientId &&
        session.account === token.account &&
        session.grant === token.grant
      ) {
        session.account = null;
        session.grant = null;
        session.scope = [];
        if (co.config.endSessionsOnSignOut) session.ended = true;
      }
    }
  }

  // ---- Direct Sign-In (4.2) ----

  /** Validates an authorization request; returns it or the error redirect/page. */
  async #authorizationRequest(url: URL): Promise<AuthorizationRequest | Response> {
    const co = this.company;
    const page = (status: number, message: string) =>
      new Response(`<!doctype html><title>Sign-in error</title><p>${message}</p>`, {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    if (!co.config.signIn.direct) return page(404, "Direct Sign-In is not offered");
    const params = url.searchParams;
    const clientId = params.get("client_id");
    if (!clientId) return page(400, "client_id is required");
    let client: ClientInfo;
    try {
      client = await co.client(clientId);
    } catch (error) {
      if (error instanceof HttpError) return page(400, "unknown Personal Agent");
      throw error;
    }
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri))) {
      co.violation("authorize.redirect-uri", `redirect_uri ${redirectUri} isn't an exact registered redirect_uri`);
      return page(400, "redirect_uri doesn't match");
    }
    const state = params.get("state");
    const redirectError = (error: string) => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      if (state) target.searchParams.set("state", state);
      target.searchParams.set("iss", co.hosts.issuer);
      return Response.redirect(target.toString(), 302);
    };
    if (params.get("response_type") !== "code") return redirectError("unsupported_response_type");
    if (!state) {
      co.violation("authorize.no-state", "authorization request without state");
      return redirectError("invalid_request");
    }
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
      co.violation("authorize.no-pkce", "authorization request without PKCE S256");
      return redirectError("invalid_request");
    }
    for (const name of ["access_token", "refresh_token", "assertion", "client_assertion"]) {
      if (params.has(name)) co.violation("authorize.secret-in-url", `${name} in the authorization URL`);
    }
    let scope: string[];
    try {
      scope = this.#checkScopes("direct", params.get("scope"));
    } catch {
      return redirectError("invalid_scope");
    }
    const request: AuthorizationRequest = {
      id: randomId("req_", 8),
      clientId: client.clientId,
      redirectUri,
      scope,
      state,
      challenge: params.get("code_challenge")!
    };
    this.#requests.set(request.id, request);
    return request;
  }

  /** `GET /oauth/authorize`: the consent page the User sees in their own browser. */
  async authorize(inbound: Inbound): Promise<Response> {
    const co = this.company;
    const result = await this.#authorizationRequest(inbound.url);
    if (result instanceof Response) return result;
    const client = await co.client(result.clientId);
    const domain = new URL(client.clientId).hostname;
    const scopes = result.scope.map((scope) => `<li>${scope}</li>`).join("");
    return new Response(
      `<!doctype html><title>Sign in to ${co.hosts.domain}</title>` +
        `<main data-request-id="${result.id}"><h1>${client.name}</h1>` +
        `<p>${domain} wants access to your account:</p><ul>${scopes}</ul>` +
        `<form method="post"><button name="decision" value="approve">Approve</button>` +
        `<button name="decision" value="deny">Decline</button></form></main>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }

  /** The User's decision on the consent page; returns where their browser goes next. */
  async decide(
    authorizeUrl: string,
    decision: { account?: string; scopes?: string[]; approve: boolean }
  ): Promise<string> {
    const co = this.company;
    const result = await this.#authorizationRequest(new URL(authorizeUrl));
    if (result instanceof Response) {
      const location = result.headers.get("Location");
      if (location) return location;
      throw new Error(`authorization request refused: ${await result.text()}`);
    }
    const target = new URL(result.redirectUri);
    target.searchParams.set("state", result.state);
    target.searchParams.set("iss", co.hosts.issuer);
    if (!decision.approve) {
      target.searchParams.set("error", "access_denied");
      return target.toString();
    }
    const granted = decision.scopes ?? result.scope;
    if (!granted.every((scope) => result.scope.includes(scope))) {
      throw new Error("the User can only approve scopes that were requested");
    }
    const code = randomId("cod_", 16);
    this.#codes.set(code, {
      clientId: result.clientId,
      redirectUri: result.redirectUri,
      challenge: result.challenge,
      account: decision.account ?? co.config.accounts[0]!.account,
      scope: granted,
      expiresAt: Date.now() + 60_000,
      used: false
    });
    target.searchParams.set("code", code);
    return target.toString();
  }

  // ---- Device Sign-In (4.3) ----

  async device(inbound: Inbound): Promise<Response> {
    const co = this.company;
    co.rateLimit("token", inbound);
    if (!co.config.signIn.device) throw oauthError(400, "unsupported_grant_type");
    const form = this.#form(inbound);
    const client = await co.authenticateClient(form, co.hosts.deviceEndpoint);
    const scope = this.#checkScopes("device", form.get("scope"));
    const letters = "BCDFGHJKLMNPQRSTVWXZ";
    const pick = () =>
      Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => letters[byte % letters.length]).join("");
    const device: DeviceRequest = {
      deviceCode: randomId("dev_", 24),
      userCode: `${pick()}-${pick()}`,
      clientId: client.clientId,
      scope,
      expiresAt: co.now() + co.config.deviceExpiresIn * 1000,
      interval: co.config.deviceInterval,
      lastPoll: 0,
      status: "pending",
      account: null,
      granted: [],
      slowedDown: false
    };
    this.#devices.set(device.deviceCode, device);
    const verification = new URL("/device", co.hosts.tokenEndpoint).href;
    return json(
      {
        device_code: device.deviceCode,
        user_code: device.userCode,
        verification_uri: verification,
        verification_uri_complete: `${verification}?user_code=${device.userCode}`,
        expires_in: co.config.deviceExpiresIn,
        interval: co.config.deviceInterval
      },
      200,
      { "Cache-Control": "no-store" }
    );
  }

  /** The device verification page; opening it MUST NOT approve anything (4.3). */
  devicePage(inbound: Inbound): Response {
    const code = inbound.url.searchParams.get("user_code") ?? "";
    return new Response(
      `<!doctype html><title>Connect a device</title><p>Enter or confirm the code ${code}, sign in, then approve.</p>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  #deviceByUserCode(userCode: string): DeviceRequest {
    for (const device of this.#devices.values()) {
      if (device.userCode === userCode) return device;
    }
    throw new Error(`no device request with user_code ${userCode}`);
  }

  approveDevice(userCode: string, decision: { account?: string; scopes?: string[] }): void {
    const device = this.#deviceByUserCode(userCode);
    const granted = decision.scopes ?? device.scope;
    if (!granted.every((scope) => device.scope.includes(scope))) {
      throw new Error("the User can only approve scopes that were requested");
    }
    device.status = "approved";
    device.account = decision.account ?? this.company.config.accounts[0]!.account;
    device.granted = granted;
  }

  denyDevice(userCode: string): void {
    this.#deviceByUserCode(userCode).status = "denied";
  }
}
