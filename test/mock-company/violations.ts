/**
 * Every protocol violation the mock Company can record, by a stable id. Each
 * check in the mock records exactly one of these, and
 * `test/mock-company.test.ts` has a row that breaks one thing in an
 * otherwise correct request and expects that id, so a check that stops
 * firing fails a named row. The catalog test there also checks that every id
 * here is used in the mock's source and every id has a row.
 *
 * A recorded violation reads `[id] detail`.
 */

/** The JWTs the mock checks a `jti` on, each with its own replay set. */
export type JwtKind = "client-assertion" | "session-assertion" | "dpop" | "browser-assertion";

/** The two JWTs signed with the client's published keys. */
export type SignedKind = "client-assertion" | "session-assertion";

export const VIOLATIONS = {
  // ---- jti: 128 random bits, single use (4.2, 4.3, 5; Guides) ----
  "client-assertion.jti-missing": "Client assertion without a jti",
  "client-assertion.jti-weak": "Client assertion jti is not 128 random bits of base64url",
  "client-assertion.jti-reused": "Client assertion jti used twice",
  "session-assertion.jti-missing": "Session assertion without a jti",
  "session-assertion.jti-weak": "Session assertion jti is not 128 random bits of base64url",
  "session-assertion.jti-reused": "Session assertion jti used twice",
  "dpop.jti-missing": "DPoP proof without a jti",
  "dpop.jti-weak": "DPoP proof jti is not 128 random bits of base64url",
  "dpop.jti-reused": "DPoP proof jti used twice",
  "browser-assertion.jti-missing": "Browser assertion without a jti",
  "browser-assertion.jti-weak": "Browser assertion jti is not 128 random bits of base64url",
  "browser-assertion.jti-reused": "Browser assertion jti used twice",

  // ---- Client and Session assertions: signed with published keys (4.1, 4.2) ----
  "client-assertion.alg": "Client assertion alg isn't ES256 or RS256",
  "client-assertion.embedded-key": "Client assertion embeds or points to a key (jku, x5u, jwk)",
  "client-assertion.typ": "Strict Company: client assertion header typ isn't \"JWT\"",
  "client-assertion.kid": "Strict Company: client assertion kid names no published key",
  "client-assertion.signature": "Client assertion doesn't verify against the client's JWKS, or has expired",
  "client-assertion.iat-exp-missing": "Client assertion without iat or exp",
  "client-assertion.lifetime": "Client assertion lifetime is too long",
  "session-assertion.alg": "Session assertion alg isn't ES256 or RS256",
  "session-assertion.embedded-key": "Session assertion embeds or points to a key (jku, x5u, jwk)",
  "session-assertion.typ": "Strict Company: Session assertion header typ isn't \"JWT\"",
  "session-assertion.kid": "Strict Company: Session assertion kid names no published key",
  "session-assertion.signature": "Session assertion doesn't verify against the client's JWKS, or has expired",
  "session-assertion.iat-exp-missing": "Session assertion without iat or exp",
  "session-assertion.lifetime": "Session assertion lifetime is too long",

  // ---- Client authentication: private_key_jwt (4.1, RFC 7523) ----
  "client-assertion.missing": "Token, device or revocation request without a client assertion",
  "client-assertion.not-jwt": "Client assertion is not a JWT",
  "client-assertion.wrong-typ": "A browser assertion or DPoP proof used as the client assertion",
  "client-assertion.aud-array": "Client assertion aud is an array",
  "client-assertion.aud": "Client assertion aud doesn't name this Company (exactAud: the endpoint called)",
  "client-assertion.iss-sub": "Client assertion iss and sub aren't both the client_id",

  // ---- Session assertion: the JWT bearer grant (4.2) ----
  "session-assertion.missing": "JWT bearer grant without an assertion",
  "session-assertion.not-jwt": "Session assertion is not a JWT",
  "session-assertion.browser-typ": "Browser assertion sent to the token endpoint",
  "session-assertion.aud": "Session assertion aud isn't the token endpoint as a single string",
  "session-assertion.iss": "Session assertion iss isn't the client_id",
  "session-assertion.sub": "Session assertion has no sub (User ID)",
  "user-id.personal": "User ID contains personal information",

  // ---- The client metadata document and JWKS (4.1) ----
  "client-metadata.not-url": "client_id is not a URL",
  "client-metadata.not-https": "client_id is not an https URL",
  "client-metadata.fetch-status": "Fetching client_id didn't return 200 (redirects aren't followed)",
  "client-metadata.not-json": "Client metadata is not JSON",
  "client-metadata.client-id-mismatch": "client_id in the document isn't the URL it was fetched from",
  "client-metadata.jwks-uri": "jwks_uri isn't https on the client_id domain",
  "client-metadata.redirect-uris": "A redirect_uri isn't https on the client_id domain",
  "client-metadata.auth-method": "token_endpoint_auth_method isn't private_key_jwt",
  "client-metadata.jwks-status": "jwks_uri didn't return 200",
  "client-metadata.jwks-empty": "The JWKS has no keys",
  "client-metadata.jwks-private": "The JWKS publishes a private key",
  "client-metadata.key-without-kid": "A JWKS key has no kid (Guides)",

  // ---- DPoP proofs (4.3, RFC 9449) ----
  "dpop.missing": "Resource request without a DPoP proof",
  "dpop.multiple": "More than one DPoP proof in the header",
  "dpop.not-jwt": "DPoP proof is not a JWT",
  "dpop.typ": "DPoP proof typ isn't dpop+jwt",
  "dpop.alg": "DPoP proof alg isn't ES256 or RS256",
  "dpop.no-jwk": "DPoP proof has no jwk in its header",
  "dpop.private-jwk": "DPoP proof header carries a private key",
  "dpop.signature": "DPoP proof signature doesn't verify",
  "dpop.htm": "DPoP proof htm isn't the request method",
  "dpop.htu": "DPoP proof htu isn't the request URL without query or fragment",
  "dpop.iat": "DPoP proof iat is outside the acceptance window",
  "dpop.ath-at-token-endpoint": "DPoP proof at the token endpoint carries ath",
  "dpop.ath": "DPoP proof ath isn't the hash of the token sent",
  "dpop.nonce-ignored": "DPoP proof without the nonce this server already sent this key",
  "dpop.key-mismatch": "DPoP proof key isn't the key the token is bound to",

  // ---- Session Tokens on resources (4.3, 6) ----
  "resource.no-token": "API, conversation or operations request without a Session Token",
  "resource.bearer-scheme": "Bearer scheme outside MCP",
  "resource.bearer-token-as-dpop": "A Bearer Session Token sent with the DPoP scheme",
  "resource.stale-token": "An older Session Token used after a newer one was issued for the Session",
  "mcp.not-bearer": "MCP request without the Bearer scheme",
  "mcp.wrong-token": "MCP request with a token not issued for this MCP server",
  "mcp.accept": "MCP request doesn't Accept application/json and text/event-stream",

  // ---- Rate limits and secrets (4.3, 4.7, 4.8, Guides) ----
  "rate-limit.retry-after-ignored": "Request sent before an earlier Retry-After elapsed",
  "secret.password": "A password sent anywhere but the Mediated Sign-In body",
  "secret.one-time-code": "A one-time code sent anywhere but the code submission body",
  "secret.account-token": "An Account Token sent anywhere but the token and revocation bodies",
  "secret.token-in-url": "A token sent in a URL",

  // ---- Token endpoint (4.2–4.8) ----
  "form.not-form": "OAuth request body isn't application/x-www-form-urlencoded",
  "token.no-dpop": "Token request without a DPoP proof (only MCP Bearer requests may omit it)",
  "token.mcp-dpop": "DPoP-bound token requested for the MCP server",
  "token.signed-in-renewed-with-assertion": "A signed-in Session renewed with the Session assertion, not the Account Token",
  "account-token.other-client": "Account Token used by a different client_id",
  "account-token.rotated-reused": "Account Token used after the Company rotated it (4.8)",

  // ---- Sign-in (4.4–4.7) ----
  "signin.no-scope": "Sign-in request without scope (4.4)",
  "authorize.redirect-uri": "redirect_uri isn't exactly a registered redirect_uri",
  "authorize.no-state": "Authorization request without state",
  "authorize.no-pkce": "Authorization request without PKCE S256",
  "authorize.secret-in-url": "A token or assertion in the authorization URL",
  "code.reused": "Authorization code exchanged twice",
  "code.redirect-uri": "redirect_uri at the token endpoint differs from the authorization request",
  "code.pkce": "PKCE code_verifier doesn't match the code_challenge",
  "code.no-session-id": "Authorization code exchanged without session_id (4.5)",
  "device.polled-after-final": "Device polling continued after completion or access_denied",
  "device.polled-after-expiry": "Device polling continued after expired_token",
  "device.too-fast": "Device polling faster than the interval after slow_down",
  "device.no-session-id": "Device code exchanged without session_id",
  "mediated.missing-field": "Mediated Sign-In without a field the Company asked for",
  "mediated.credentials-with-code": "Credentials resent with the one-time code (4.7)",

  // ---- Browser join (5) ----
  "browser-assertion.in-url": "Browser assertion sent in the URL",
  "browser-assertion.not-post": "Browser join isn't a POST",
  "browser-assertion.content-type": "Browser join isn't a form POST",
  "browser-assertion.missing": "Browser join without an assertion",
  "browser-assertion.not-jwt": "Browser assertion is not a JWT",
  "browser-assertion.typ": "Browser assertion typ isn't poppy-browser+jwt",
  "browser-assertion.no-iss": "Browser assertion without iss",
  "browser-assertion.unknown-agent": "Browser assertion iss isn't a client_id the Company can load",
  "browser-assertion.signature": "Browser assertion doesn't verify, or has expired",
  "browser-assertion.aud": "Browser assertion aud isn't the browser_session_endpoint",
  "browser-assertion.lifetime": "Browser assertion exp is more than 60 seconds after iat",
  "browser-assertion.session": "Browser assertion session_id isn't this agent and User's active Session",
  "browser-assertion.return-to-not-url": "Browser assertion return_to isn't a URL",
  "browser-assertion.return-to-off-domain": "Browser assertion return_to isn't HTTPS on the Company's domain",

  // ---- APIs (6) ----
  "idempotency.key-reused": "Idempotency-Key reused with a different body",
  "exchange.performed-twice": "The same exchange made twice (a write retried without its key, or confirmed twice)",

  // ---- Conversations (7) ----
  "message.missing": "Conversation request without a message",
  "message.id": "Message id isn't 1-256 base64url characters",
  "message.sender": "Message sender isn't agent or human",
  "message.empty": "Message has none of text, data or context",
  "message.text-type": "Message text isn't a string",
  "message.json-in-text": "JSON in a message's text; it belongs in data (7.4)",
  "message.data-type": "Message data isn't a JSON object",
  "message.context-type": "Message context isn't an object",
  "message.id-reused": "Message id reused with different content (7.3)",
  "context.locale": "context.locale isn't an RFC 5646 tag",
  "context.time-zone": "context.time_zone isn't an IANA name",
  "context.user-available": "context.user_available isn't a boolean",
  "direct.agent-words": "Direct Conversation opened with words not marked as the User's",
  "handoff.body": "Handoff body isn't {}",
  "close.body": "Close body isn't {}",

  // ---- Operations extension ----
  "confirm.approved-by": "Confirm without approved_by user or standing_permission",
  "confirm.standing-permission-overrides-user": "Confirmed under a standing permission when user_approval_required is true"
} as const;

export type ViolationId = keyof typeof VIOLATIONS;

/** Every id, for the catalog test. */
export const VIOLATION_IDS = Object.keys(VIOLATIONS) as ViolationId[];

/** The id of a recorded violation, `[id] detail`. */
export function violationId(recorded: string): string {
  return /^\[([^\]]+)\]/.exec(recorded)?.[1] ?? "";
}
