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
  requestAt,
  sha256b64,
  type ClientInfo,
  type Inbound
} from "./core";
import { departure, ours, show, shown } from "../../src/diagnostic";

/** The one scope 0.4 defines: a joined browser signed in (6). */
const BROWSER_SIGN_IN = "poppy:browser-sign-in";

/** What a token request's DPoP proof binds: its key for the access token (none for an MCP server's Bearer token), and the proof's key itself. */
type Binding = { readonly jkt: string | null; readonly resource: string | null; readonly proofKey: string | null };

type AuthorizationRequest = {
  readonly id: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /** What the request asked for, and what of it this sign-in can grant. */
  readonly requested: readonly string[];
  readonly scope: readonly string[];
  readonly state: string;
  readonly challenge: string;
  /** Pushed with a DPoP proof, whose key the code is bound to (RFC 9449 §10.1). */
  readonly jkt?: string | null;
};

/** A pushed authorization request (RFC 9126), by its `request_uri`. */
type Pushed = { readonly request: AuthorizationRequest; readonly expiresAt: number };

type AuthorizationCode = {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly account: string;
  readonly requested: readonly string[];
  readonly scope: readonly string[];
  readonly expiresAt: number;
  readonly jkt?: string | null;
  used: boolean;
};

type DeviceRequest = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly clientId: string;
  readonly requested: readonly string[];
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
  readonly requested: readonly string[];
  readonly scope: readonly string[];
  readonly code: string;
  readonly expiresAt: number;
  attempts: number;
  finished: boolean;
};

/** The Company's OAuth server and Mediated Sign-In's grant (spec 4.2–4.7, Mediated Sign-In 3–5). */
export class AuthServer {
  readonly #requests = new Map<string, AuthorizationRequest>();
  readonly #pushed = new Map<string, Pushed>();
  readonly #codes = new Map<string, AuthorizationCode>();
  readonly #devices = new Map<string, DeviceRequest>();
  readonly #mediated = new Map<string, MediatedSignIn>();
  #mediatedAttempts = 0;

  constructor(readonly company: Company) {}

  /** A form at one of the issuer's OAuth endpoints, which never carries the Session header (5.2). */
  #form(inbound: Inbound): URLSearchParams {
    if (inbound.request.headers.has("Poppy-Session")) {
      this.company.violation("session-jwt.oauth-endpoint", departure(shown`${requestAt(inbound)}, at an OAuth endpoint`, ours("no Poppy-Session header"), ours("one")));
    }
    const type = inbound.request.headers.get("Content-Type") ?? "";
    if (!type.startsWith("application/x-www-form-urlencoded")) {
      this.company.violation("form.not-form", departure(shown`the body of ${requestAt(inbound)}`, ours("a form, application/x-www-form-urlencoded"), show.type(type)));
      throw oauthError(400, "invalid_request", "expected a form body");
    }
    return new URLSearchParams(inbound.bodyText);
  }

  #allowedScopes(type: "direct" | "device" | "mediated"): readonly string[] | null {
    return this.company.offeredScopes(type);
  }

  /**
   * Each sign-in MUST include `scope` (4.7). A scope the issuer doesn't list
   * in `scopes_supported` is `invalid_scope`. One it lists but this type of
   * sign-in doesn't grant is left out, as RFC 6749 3.3 lets it, and the
   * token response says what was granted; Mediated Sign-In's own list is the
   * most it grants (Mediated Sign-In 2). Nothing left to grant is `invalid_scope`.
   */
  #checkScopes(type: "direct" | "device" | "mediated", raw: string | null): { readonly requested: string[]; readonly scope: string[] } {
    if (raw === null || raw.trim() === "") {
      this.company.violation("signin.no-scope", departure(shown`the ${ours(type)} sign-in's scope`, ours("at least one scope"), raw === null ? ours("none") : ours("only white space")));
      throw oauthError(400, "invalid_scope", "scope is required");
    }
    const requested = parseScope(raw);
    if (requested.includes(BROWSER_SIGN_IN) && !this.company.browserJoin) {
      this.company.violation("browser-sign-in.no-endpoint", departure(shown`the ${ours(type)} sign-in's scope`, ours("no poppy:browser-sign-in from a Company that lists no browser_session_endpoint"), ours("poppy:browser-sign-in")));
    }
    const supported = Object.keys(this.company.scopeDescriptions());
    const unknown = requested.filter((entry) => !supported.includes(entry));
    if (unknown.length > 0) throw oauthError(400, "invalid_scope", `unknown scope ${unknown.join(" ")}`);
    const allowed = this.#allowedScopes(type) ?? [];
    const scope = requested.filter((entry) => allowed.includes(entry));
    if (scope.length === 0) throw oauthError(400, "invalid_scope", `${type} sign-in can grant only ${allowed.join(" ")}`);
    return { requested, scope };
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
    // A resource is a target only where its own metadata, at the URL derived from it, names it (RFC 9728 3.3).
    const isMcp = resource === co.hosts.mcpUrl && !co.config.mcpPrmAtRootOnly;
    if (resource !== null && !isMcp && !(co.config.apiResource && resource === co.hosts.api)) {
      co.violation("resource.unverified-target", departure(ours("the token request's resource"), ours("one that protected resource metadata at its own derived URL names"), show.url(resource)));
      throw oauthError(400, "invalid_target", "unknown resource");
    }
    const proof = inbound.request.headers.get("DPoP");
    if (co.config.dpopTokens && !proof) {
      co.violation("token.dpop-not-sent", departure(shown`the token request (${show.code(grant ?? undefined)})`, ours("a DPoP proof, since the metadata lists dpop_signing_alg_values_supported"), ours("none")));
      throw oauthError(400, "invalid_dpop_proof", "a DPoP proof is required");
    }
    const jkt = proof ? await co.verifyDpop(inbound, undefined) : null;
    const binding: Binding = { jkt: isMcp && !co.config.mcpDpop ? null : jkt, resource, proofKey: jkt };
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

  async #refresh(client: ClientInfo, form: URLSearchParams, binding: Binding): Promise<Response> {
    const co = this.company;
    const token = this.#accountToken(client, form.get("refresh_token"));
    // 1.0 (4.4): every refresh carries a proof from the key the refresh token was issued with.
    if (token.jkt !== null && binding.proofKey !== token.jkt) {
      if (!co.config.protocolVersion.startsWith("0.")) {
        co.violation("dpop.refresh-key-changed", departure(ours("the refresh request's DPoP proof"), ours("one by the key the refresh token was issued with"), binding.proofKey === null ? ours("none") : ours("one by another key")));
      }
      if (co.config.bindRefreshTokens) throw oauthError(400, "invalid_grant", "the refresh token is bound to another DPoP key");
    }
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
    return co.tokenResponse(co.issueAccess(token, binding, scope), scope, rotated);
  }

  /** A completed sign-in: a refresh token for a new grant, and an access token from it. */
  #signedIn(client: ClientInfo, account: string, granted: { readonly requested: readonly string[]; readonly scope: readonly string[] }, binding: Binding): Response {
    const co = this.company;
    const refresh = co.issueAccountToken({ clientId: client.clientId, account, grant: randomId("grt_", 8), jkt: binding.proofKey }, granted.scope);
    return co.tokenResponse(co.issueAccess(refresh, binding, granted.scope), granted.requested, refresh);
  }

  /**
   * Mediated Sign-In's grant (Mediated Sign-In 3, 4): the credentials and
   * `scope`, or, after `code_required`, `sign_in_id` and `one_time_code`
   * alone. Only the client that started a sign-in can finish it.
   */
  async #mediatedGrant(client: ClientInfo, form: URLSearchParams, binding: Binding): Promise<Response> {
    const co = this.company;
    if (!co.config.signIn.mediated) throw oauthError(400, "unsupported_grant_type");
    const signInId = form.get("sign_in_id");
    if (signInId !== null) {
      const sent = (["email", "password"] as const).filter((field) => form.has(field)).map((field) => ours(field));
      if (sent.length > 0) co.violation("mediated.credentials-with-code", departure(ours("the one-time code's request"), ours("sign_in_id and one_time_code, without the credentials"), shown`${show.list(sent)} as well`));
      if (form.has("scope")) co.violation("mediated.scope-with-code", departure(ours("the one-time code's request"), ours("no scope: the sign-in keeps its first scopes"), ours("scope again")));
      const signIn = this.#mediated.get(signInId);
      if (signIn && signIn.clientId !== client.clientId) {
        co.violation("mediated.code-other-client", departure(shown`the one-time code for ${show.value(signIn.id)}`, shown`the client that started it, ${show.url(signIn.clientId)}`, show.url(client.clientId)));
      }
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
      return this.#signedIn(client, signIn.account, signIn, binding);
    }
    const { requested, scope } = this.#checkScopes("mediated", form.get("scope"));
    for (const field of ["email", "password"] as const) {
      if (!form.has(field)) co.violation("mediated.missing-field", departure(ours("the mediated sign-in"), shown`a field ${ours(field)}`, ours("none")));
    }
    if (++this.#mediatedAttempts > 20) throw oauthError(400, "invalid_grant");
    const account = co.config.accounts.find((entry) => entry.email === form.get("email") && entry.password === form.get("password"));
    if (!account) throw oauthError(400, "invalid_grant", "sign-in didn't succeed");
    if (!account.otp) return this.#signedIn(client, account.account, { requested, scope }, binding);
    const code = randomId("", 6).replace(/[^A-Za-z0-9]/g, "X").toUpperCase();
    co.oneTimeCodes.add(code);
    co.lastOneTimeCode = code;
    const signIn: MediatedSignIn = { id: randomId("sgn_", 8), clientId: client.clientId, account: account.account, requested, scope, code, expiresAt: co.now() + 5 * 60_000, attempts: 0, finished: false };
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
      co.violation("account-token.other-client", departure(ours("the refresh token's client"), shown`the client it was issued to, ${show.url(token.clientId)}`, show.url(client.clientId)));
      throw oauthError(400, "invalid_grant");
    }
    if (token.rotated) {
      co.violation("account-token.rotated-reused", departure(ours("the refresh token"), ours("the one the Company issued last"), ours("one it had replaced")));
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
    binding: Binding
  ): Promise<Response> {
    const co = this.company;
    const value = form.get("code") ?? "";
    const code = this.#codes.get(value);
    if (!code || code.expiresAt <= Date.now()) {
      throw oauthError(400, "invalid_grant", "code expired or unknown");
    }
    if (code.used) {
      co.violation("code.reused", departure(ours("the authorization code"), ours("a code used once"), ours("one used before")));
      throw oauthError(400, "invalid_grant", "code already used");
    }
    code.used = true;
    if (code.clientId !== client.clientId) throw oauthError(400, "invalid_grant");
    if (form.get("redirect_uri") !== code.redirectUri) {
      co.violation("code.redirect-uri", departure(ours("the token request's redirect_uri"), shown`the authorization request's, ${show.url(code.redirectUri)}`, form.has("redirect_uri") ? show.url(form.get("redirect_uri")!) : ours("none")));
      throw oauthError(400, "invalid_grant");
    }
    const verifier = form.get("code_verifier");
    if (!verifier || (await sha256b64(verifier)) !== code.challenge) {
      co.violation("code.pkce", departure(ours("the token request's code_verifier"), ours("the verifier of the authorization request's code_challenge"), verifier ? ours("another verifier") : ours("none")));
      throw oauthError(400, "invalid_grant");
    }
    // RFC 9449 §10.1: a code from a request pushed with a DPoP proof is exchanged with that key.
    if (code.jkt && binding.proofKey !== code.jkt) {
      co.violation("par.code-key", departure(ours("the code exchange's DPoP proof"), ours("one by the key the code was pushed with"), binding.proofKey === null ? ours("none") : ours("one by another key")));
      throw oauthError(400, "invalid_dpop_proof", "the code is bound to another DPoP key");
    }
    return this.#signedIn(client, code.account, code, binding);
  }

  async #deviceCode(
    client: ClientInfo,
    form: URLSearchParams,
    binding: Binding
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
          departure(ours("the device code"), shown`no poll after ${device.status === "done" ? ours("its tokens were issued") : ours("access_denied")}`, ours("another poll"))
        );
      }
      device.lastPoll = -1;
      throw oauthError(400, device.status === "done" ? "invalid_grant" : "access_denied");
    }
    if (device.expiresAt <= now) {
      if (device.lastPoll < 0) co.violation("device.polled-after-expiry", departure(ours("the device code"), ours("no poll after expired_token"), ours("another poll")));
      device.lastPoll = -1;
      throw oauthError(400, "expired_token");
    }
    if (device.lastPoll > 0 && now - device.lastPoll < device.interval * 1000 - 250) {
      if (device.slowedDown) {
        co.violation(
          "device.too-fast",
          departure(ours("the device code's polls, after slow_down"), shown`at least ${device.interval} s apart`, shown`one ${now - device.lastPoll} ms after the last`)
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
    return this.#signedIn(client, device.account!, { requested: device.requested, scope: device.granted }, binding);
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
  async #authorizationRequest(url: URL, pushedParameters?: { readonly jkt: string | null }): Promise<AuthorizationRequest | Response> {
    const co = this.company;
    const page = (status: number, message: string) =>
      new Response(`<!doctype html><title>Sign-in error</title><p>${message}</p>`, {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    if (!co.config.signIn.direct) return page(404, "Direct Sign-In is not offered");
    // A pushed request (RFC 9126 §4): the URL carries only client_id and its request_uri (1.0: 4.2).
    const requestUri = url.searchParams.get("request_uri");
    if (requestUri !== null && !pushedParameters) {
      const pushed = this.#pushed.get(requestUri);
      if (!pushed || pushed.expiresAt <= Date.now()) return page(400, "request_uri expired or unknown");
      if (url.searchParams.get("client_id") !== pushed.request.clientId) return page(400, "client_id doesn't match the pushed request");
      const extra = [...url.searchParams.keys()].filter((name) => name !== "client_id" && name !== "request_uri");
      if (extra.length > 0 && !co.config.protocolVersion.startsWith("0.")) {
        co.violation("par.extra-parameters", departure(ours("the authorization URL for a pushed request"), ours("client_id and request_uri only"), shown`also ${show.list(extra.map((name) => show.code(name)))}`));
      }
      return pushed.request;
    }
    if (co.config.pushedAuthorization === "required" && !pushedParameters) {
      co.violation("par.not-pushed", departure(ours("the authorization request"), ours("a pushed one, since the metadata sets require_pushed_authorization_requests"), ours("one in the URL")));
      return page(400, "This Company accepts only pushed authorization requests");
    }
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
      co.violation("authorize.redirect-uri", departure(ours("the authorization request's redirect_uri"), shown`one of the client's registered redirect_uris, exactly: ${show.list(client.redirectUris.map((uri) => show.url(uri)), "or")}`, redirectUri ? show.url(redirectUri) : ours("none")));
      return page(400, "redirect_uri doesn't match");
    }
    // 1.0 (4.2): prompt=consent, unless the redirect comes back only to the device that opened the URL,
    // as at a loopback redirect URI. The mock shows its consent page for every request either way.
    if (!co.config.protocolVersion.startsWith("0.") && !(params.get("prompt") ?? "").split(" ").includes("consent") && !isLoopback(redirectUri)) {
      co.violation("authorize.prompt-consent", departure(shown`the 1.x authorization request to ${show.url(redirectUri)}`, ours("prompt=consent, since its redirect URI isn't loopback"), params.has("prompt") ? shown`prompt ${show.value(params.get("prompt"))}` : ours("no prompt")));
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
      co.violation("authorize.no-state", departure(ours("the authorization request"), ours("a state"), ours("none")));
      return redirectError("invalid_request");
    }
    if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
      const method = params.get("code_challenge_method");
      co.violation("authorize.no-pkce", departure(ours("the authorization request"), ours("a code_challenge with code_challenge_method S256"), !params.get("code_challenge") ? ours("no code_challenge") : shown`code_challenge_method ${show.value(method ?? undefined)}`));
      return redirectError("invalid_request");
    }
    for (const name of ["access_token", "refresh_token", "assertion", "client_assertion"] as const) {
      if (params.has(name)) co.violation("authorize.secret-in-url", departure(ours("the authorization URL"), ours("no token or assertion"), shown`${ours(name)} in its query`));
    }
    let requested: string[];
    let scope: string[];
    try {
      ({ requested, scope } = this.#checkScopes("direct", params.get("scope")));
    } catch {
      return redirectError("invalid_scope");
    }
    const request: AuthorizationRequest = {
      id: randomId("req_", 8),
      clientId: client.clientId,
      redirectUri,
      requested,
      scope,
      state,
      challenge: params.get("code_challenge")!,
      ...(pushedParameters ? { jkt: pushedParameters.jkt } : {})
    };
    this.#requests.set(request.id, request);
    return request;
  }

  /**
   * `POST /oauth/par` (RFC 9126 §2): the authorization request's parameters,
   * with the client authenticated as at the token endpoint and, from a
   * Personal Agent that uses DPoP, a proof whose key the code is bound to
   * (RFC 9449 §10.1). Answers 201 with a `request_uri` that expires in a minute.
   */
  async pushAuthorization(inbound: Inbound): Promise<Response> {
    const co = this.company;
    co.rateLimit("token", inbound);
    const form = this.#form(inbound);
    const client = await co.authenticateClient(form, co.hosts.pushedAuthorizationEndpoint);
    if (form.has("request_uri")) throw oauthError(400, "invalid_request", "request_uri isn't allowed in a pushed request");
    const proof = inbound.request.headers.get("DPoP");
    const jkt = proof ? await co.verifyDpop(inbound, undefined) : null;
    const url = new URL(co.hosts.authorizationEndpoint);
    for (const [name, value] of form) if (name !== "client_assertion" && name !== "client_assertion_type") url.searchParams.append(name, value);
    url.searchParams.set("client_id", client.clientId);
    const result = await this.#authorizationRequest(url, { jkt });
    if (result instanceof Response) {
      const location = result.headers.get("Location");
      const error = location ? new URL(location).searchParams.get("error") : null;
      throw oauthError(400, error ?? "invalid_request", "the pushed authorization request is invalid");
    }
    const requestUri = `urn:ietf:params:oauth:request_uri:${randomId("", 16)}`;
    this.#pushed.set(requestUri, { request: result, expiresAt: Date.now() + 60_000 });
    return json({ request_uri: requestUri, expires_in: 60 }, 201, { "Cache-Control": "no-store" });
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
        // 0.4 Guides, "Consent pages": name the agent, worded as connecting, and warn about sign-ins someone else started (10.8).
        `<main data-request-id="${result.id}"><h1>${client.name} wants to connect to your ${co.config.organizationName ?? `Mock Shop ${co.id}`} account</h1>` +
        `<p>Only continue if you asked ${client.name} to do this just now.</p>` +
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
      requested: result.requested,
      scope: granted,
      expiresAt: Date.now() + 60_000,
      ...(result.jkt ? { jkt: result.jkt } : {}),
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
    // 4.1: a Company can refuse one sign-in type to a Personal Agent it accepts for signed-out Sessions.
    if (co.config.refuseSignInTypes.includes("device")) throw oauthError(400, "unauthorized_client");
    const { requested, scope } = this.#checkScopes("device", form.get("scope"));
    const letters = "BCDFGHJKLMNPQRSTVWXZ";
    const pick = () =>
      Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => letters[byte % letters.length]).join("");
    const device: DeviceRequest = {
      deviceCode: randomId("dev_", 24),
      userCode: `${pick()}-${pick()}`,
      clientId: client.clientId,
      requested,
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

/** A loopback redirect URI (RFC 8252 §7.3), which only the device that opened the authorization URL receives. */
function isLoopback(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}
