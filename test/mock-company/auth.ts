import {
  Company,
  DEVICE_CODE,
  HttpError,
  JWT_BEARER,
  json,
  oauthError,
  parseScope,
  randomId,
  sha256b64,
  type ClientInfo,
  type Inbound,
  type Session
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
  readonly sessionId: string;
  readonly account: string;
  readonly scope: readonly string[];
  readonly code: string;
  readonly expiresAt: number;
  attempts: number;
  finished: boolean;
};

/** The Company's OAuth server and Mediated Sign-In (spec 4.2–4.9). */
export class AuthServer {
  readonly #requests = new Map<string, AuthorizationRequest>();
  readonly #codes = new Map<string, AuthorizationCode>();
  readonly #devices = new Map<string, DeviceRequest>();
  readonly #mediated = new Map<string, MediatedSignIn>();
  #mediatedAttempts = 0;

  constructor(readonly company: Company) {}

  #form(inbound: Inbound): URLSearchParams {
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

  /** Each sign-in MUST include `scope`; unknown or unavailable scopes are refused (4.4). */
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
    const grant = form.get("grant_type");
    const resource = form.get("resource");
    // Without a DPoP header, only a Bearer token for the MCP server (4.3).
    let jkt: string | null = null;
    if (inbound.request.headers.get("DPoP")) {
      jkt = await co.verifyDpop(inbound, undefined);
    } else if (resource !== co.hosts.mcpUrl || (grant !== JWT_BEARER && grant !== "refresh_token")) {
      co.violation("token.no-dpop", `token request (${grant}) without a DPoP proof`);
      throw oauthError(400, "invalid_dpop_proof", "DPoP proof required", {
        "WWW-Authenticate": 'DPoP error="invalid_dpop_proof"'
      });
    }
    if (resource !== null && resource !== co.hosts.mcpUrl && !(co.config.apiResource && resource === co.hosts.api)) {
      throw oauthError(400, "invalid_target", "unknown resource");
    }
    if (jkt === null && resource === co.hosts.mcpUrl) {
      // Bearer is fine; DPoP plus the MCP resource would make a token MCP can't use.
    } else if (jkt !== null && resource === co.hosts.mcpUrl) {
      co.violation("token.mcp-dpop", "asked for a DPoP-bound token for the MCP server; MCP uses Bearer");
    }
    const binding = { jkt, resource };
    switch (grant) {
      case JWT_BEARER:
        return this.#jwtBearer(client, form, binding);
      case "refresh_token":
        return this.#refresh(client, form, binding);
      case "authorization_code":
        return this.#authorizationCode(client, form, binding);
      case DEVICE_CODE:
        return this.#deviceCode(client, form, binding);
      default:
        throw oauthError(400, "unsupported_grant_type");
    }
  }

  #session(client: ClientInfo, sessionId: string | null, userId: string): Session | null {
    if (sessionId === null) return null;
    const session = this.company.sessions.get(sessionId);
    if (!session || session.ended || session.clientId !== client.clientId || session.userId !== userId) {
      throw oauthError(400, "invalid_session", "Session ended or belongs to someone else");
    }
    return session;
  }

  async #jwtBearer(
    client: ClientInfo,
    form: URLSearchParams,
    binding: { jkt: string | null; resource: string | null }
  ): Promise<Response> {
    const co = this.company;
    const userId = await co.verifySessionAssertion(client, form.get("assertion"));
    const session =
      this.#session(client, form.get("session_id"), userId) ?? co.newSession(client.clientId, userId);
    if (session.account) {
      // A signed-in Session is renewed with the Account Token (4.2).
      co.violation(
        "token.signed-in-renewed-with-assertion",
        "renewed a signed-in Session with the assertion instead of the Account Token"
      );
    }
    const access = co.issueAccess(
      { ...session, account: null } as Session,
      binding,
      []
    );
    return co.tokenResponse(access);
  }

  #accountToken(client: ClientInfo, value: string | null) {
    const co = this.company;
    const token = value ? co.accountTokens.get(value) : undefined;
    if (!token) throw oauthError(400, "invalid_grant", "unknown Account Token");
    if (token.clientId !== client.clientId) {
      co.violation("account-token.other-client", "Account Token used by a different client_id");
      throw oauthError(400, "invalid_grant");
    }
    if (token.rotated) {
      co.violation("account-token.rotated-reused", "used an Account Token after the Company rotated it (4.8)");
      if (co.config.reuseDetection) {
        // Reuse means the token leaked: revoke every token descended from the sign-in (RFC 9700 4.14.2).
        for (const other of co.accountTokens.values()) {
          if (other.clientId === token.clientId && other.userId === token.userId && other.grant === token.grant) {
            this.revokeToken(other.value);
          }
        }
      }
      throw oauthError(400, "invalid_grant", "Account Token was rotated");
    }
    if (token.revoked || (token.expiresAt !== null && token.expiresAt <= Date.now())) {
      throw oauthError(400, "invalid_grant", "Account Token expired or revoked");
    }
    return token;
  }

  async #refresh(
    client: ClientInfo,
    form: URLSearchParams,
    binding: { jkt: string | null; resource: string | null }
  ): Promise<Response> {
    const co = this.company;
    const token = this.#accountToken(client, form.get("refresh_token"));
    let scope = [...token.scope];
    const asked = form.get("scope");
    if (asked !== null) {
      const narrower = parseScope(asked);
      if (!narrower.every((entry) => token.scope.includes(entry))) {
        throw oauthError(400, "invalid_scope", "can't ask for more scope than the Account Token has");
      }
      scope = narrower;
    }
    const session =
      this.#session(client, form.get("session_id"), token.userId) ??
      co.newSession(client.clientId, token.userId);
    co.signIn(session, token.account, token.scope, token.grant);
    let rotated;
    if (co.config.rotateRefreshTokens) {
      token.rotated = true;
      rotated = co.issueAccountToken(session, token.scope);
    }
    const access = co.issueAccess(session, binding, scope);
    return co.tokenResponse(access, rotated);
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
    const sessionId = form.get("session_id");
    if (!sessionId) {
      co.violation("code.no-session-id", "authorization code exchanged without session_id (4.5)");
      throw oauthError(400, "invalid_request", "session_id is required");
    }
    const session = co.sessions.get(sessionId);
    if (!session || session.ended || session.clientId !== client.clientId) {
      throw oauthError(400, "invalid_session");
    }
    co.signIn(session, code.account, code.scope);
    const refresh = co.issueAccountToken(session, code.scope);
    return co.tokenResponse(co.issueAccess(session, binding, code.scope), refresh);
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
    const sessionId = form.get("session_id");
    if (!sessionId) {
      co.violation("device.no-session-id", "device code exchanged without session_id");
      throw oauthError(400, "invalid_request", "session_id is required");
    }
    const session = co.sessions.get(sessionId);
    if (!session || session.ended || session.clientId !== client.clientId) {
      throw oauthError(400, "invalid_session");
    }
    co.signIn(session, device.account!, device.granted);
    device.status = "done";
    const refresh = co.issueAccountToken(session, device.granted);
    return co.tokenResponse(co.issueAccess(session, binding, device.granted), refresh);
  }

  // ---- Revocation (4.9) ----

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
   * Revoke an Account Token and sign out every Session signed in with it
   * (4.9): with it or a token it was rotated from, not every Session signed
   * in to the same account by another sign-in (spec-issues N4).
   */
  revokeToken(value: string): void {
    const co = this.company;
    const token = co.accountTokens.get(value);
    if (!token) return;
    token.revoked = true;
    for (const session of co.sessions.values()) {
      if (
        session.clientId === token.clientId &&
        session.userId === token.userId &&
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

  // ---- Direct Sign-In (4.5) ----

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
    if (!client.redirectUris.includes(redirectUri)) {
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

  // ---- Device Sign-In (4.6) ----

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

  /** The device verification page; opening it MUST NOT approve anything (4.6). */
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

  // ---- Mediated Sign-In (4.7) ----

  async mediated(inbound: Inbound): Promise<Response> {
    const co = this.company;
    co.rateLimit("other", inbound);
    if (!co.config.signIn.mediated) return json({ error: "not_found" }, 404);
    const context = await co.authorizeResource(inbound);
    const body = JSON.parse(inbound.bodyText || "{}") as {
      scope?: string;
      credentials?: Record<string, unknown>;
    };
    const scope = this.#checkScopes("mediated", body.scope ?? null);
    const credentials = body.credentials ?? {};
    for (const field of ["email", "password"]) {
      if (typeof credentials[field] !== "string") {
        co.violation("mediated.missing-field", `mediated sign-in missing field ${field}`);
      }
    }
    if (++this.#mediatedAttempts > 20) {
      return json({ status: "failed" });
    }
    const account = co.config.accounts.find(
      (entry) => entry.email === credentials.email && entry.password === credentials.password
    );
    // The same answer for an unknown account and a wrong password.
    if (!account) return json({ status: "failed" }, 200, { "Cache-Control": "no-store" });
    if (account.otp) {
      const code = randomId("", 6).replace(/[^A-Za-z0-9]/g, "X").toUpperCase();
      co.oneTimeCodes.add(code);
      co.lastOneTimeCode = code;
      const signIn: MediatedSignIn = {
        id: randomId("sgn_", 8),
        sessionId: context.session.id,
        account: account.account,
        scope,
        code,
        // Timed by the test agent's fake clock, so a test can let the code expire.
        expiresAt: co.now() + 5 * 60_000,
        attempts: 0,
        finished: false
      };
      this.#mediated.set(signIn.id, signIn);
      return json(
        {
          status: "code_required",
          sign_in_id: signIn.id,
          code: { sent_to: "Text to the phone number ending in 71" },
          expires_at: new Date(signIn.expiresAt).toISOString().replace("Z", "+00:00")
        },
        200,
        { "Cache-Control": "no-store" }
      );
    }
    return this.#completeMediated(context.session, context.token.jkt, account.account, scope);
  }

  #completeMediated(
    session: Session,
    jkt: string | null,
    account: string,
    scope: readonly string[]
  ): Response {
    const co = this.company;
    try {
      co.signIn(session, account, scope);
    } catch (error) {
      if (error instanceof HttpError) return error.response;
      throw error;
    }
    const refresh = co.issueAccountToken(session, scope);
    const access = co.issueAccess(session, { jkt, resource: null }, scope);
    return co.tokenResponse(access, refresh, { status: "complete" });
  }

  async mediatedCode(inbound: Inbound, signInId: string): Promise<Response> {
    const co = this.company;
    co.rateLimit("other", inbound);
    const context = await co.authorizeResource(inbound);
    const signIn = this.#mediated.get(signInId);
    // "Only the Session that started a sign-in can finish it" (4.7).
    if (signIn && !signIn.finished && signIn.sessionId !== context.session.id) {
      co.violation("mediated.code-other-session", `one-time code for ${signIn.id} submitted from another Session`);
    }
    if (!signIn || signIn.sessionId !== context.session.id || signIn.finished) {
      return json({ error: "not_found" }, 404);
    }
    const body = JSON.parse(inbound.bodyText || "{}") as Record<string, unknown>;
    if ("credentials" in body || "password" in body || "email" in body) {
      co.violation("mediated.credentials-with-code", "credentials resent with the one-time code (4.7: submit only the code)");
    }
    if (signIn.expiresAt <= co.now()) {
      signIn.finished = true;
      return json({ status: "expired" });
    }
    if (body.code !== signIn.code) {
      signIn.attempts += 1;
      if (signIn.attempts >= 3) {
        signIn.finished = true;
        return json({ status: "failed" });
      }
      return json({
        status: "code_required",
        sign_in_id: signIn.id,
        code: { sent_to: "Text to the phone number ending in 71" },
        expires_at: new Date(signIn.expiresAt).toISOString().replace("Z", "+00:00")
      });
    }
    signIn.finished = true;
    return this.#completeMediated(context.session, context.token.jkt, signIn.account, signIn.scope);
  }
}
