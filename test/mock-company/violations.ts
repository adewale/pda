/**
 * Every protocol violation the mock Company can record, by a stable id. Each
 * check in the mock records exactly one of these, and
 * `test/mock-company.test.ts` has a row that breaks one thing in an
 * otherwise correct request and expects that id, so a check that stops
 * firing fails a named row. The catalog test there also checks that every id
 * here is used in the mock's source and every id has a row.
 *
 * A recorded check reads `[id] detail`.
 *
 * Each description starts with what the check rests on, then the section
 * (spec sections bare, `Ops n` for the Operations extension, a Guides
 * heading by name), checked against the Draft 0.1 snapshot in `spec/`:
 *
 * - `MUST (4.3):` or `MUST NOT (…):` a MUST, MUST NOT or required field in
 *   the draft or the Operations extension.
 * - `RFC (RFC 9449 4.2):` a requirement of a standard the draft builds on.
 * - `Rule (4.5):` the draft states it as how the protocol works, with no
 *   RFC 2119 keyword ("the Personal Agent sends `session_id` when it
 *   exchanges the code").
 * - `SHOULD (…):` or `SHOULD NOT (…):` a SHOULD in the draft.
 * - `Guides (heading):` only a recommendation in the Guides.
 * - `Reading (S2):` our answer to an open question in
 *   docs/spec-issues.md, recorded in docs/readings.md.
 *
 * The basis decides the level (src/validator/levels.ts,
 * docs/conformance-levels.md): MUST, RFC and Rule are failures, which the
 * mock records as violations; SHOULD and Guides are warnings, and Reading is
 * tentative, which it records as warnings. Nothing rests on a MAY: an option
 * is never held against the side that takes it. Whether a check also refuses
 * the request is the mock's behaviour, not its verdict: it refuses where the
 * draft gives it an error to send, and where a Guides recommendation or one
 * of our readings guards against replay, forgery or a repeated write.
 *
 * Every check runs in the conformance tests, which hold our own client to all
 * of them, warnings included (the strict run, as h2spec's `--strict`). Both
 * Companies in the interop grid report every check with its basis and level;
 * there a warning never fails a cell (docs/interop-spec.md section 9). The S2
 * checks (`.typ`, `.kid`, the 60-second lifetime) are made only by the strict
 * Company (`strictAssertions`), which applies that reading.
 */
import { levelOf, type Basis, type Level } from "../../src/validator/levels.ts";

export type { Basis, Level };

/** The JWTs the mock checks a `jti` on, each with its own replay set. */
export type JwtKind = "client-assertion" | "session-assertion" | "dpop" | "browser-assertion";

/** The two JWTs signed with the client's published keys. */
export type SignedKind = "client-assertion" | "session-assertion";

export const VIOLATIONS = {
  // ---- jti: 128 random bits, single use (4.2, 4.3, 5; Guides) ----
  "client-assertion.jti-missing": "Guides (Signing and verifying JWTs): Client assertion without a jti (RFC 7523 3 makes jti optional; OIDC Core 9, which defines private_key_jwt, requires it)",
  "client-assertion.jti-weak": "Guides (Signing and verifying JWTs): Client assertion jti is not 128 random bits of base64url",
  "client-assertion.jti-reused": "Rule (4.2: the Company \"rejects a reused jti\"; RFC 7523 3 lets a server refuse replays): Client assertion jti used twice",
  "session-assertion.jti-missing": "Rule (4.2): Session assertion without a jti",
  "session-assertion.jti-weak": "Rule (4.2): Session assertion jti is not 128 random bits of base64url",
  "session-assertion.jti-reused": "Rule (4.2): Session assertion jti used twice",
  "dpop.jti-missing": "RFC (RFC 9449 4.2): DPoP proof without a jti",
  "dpop.jti-weak": "Guides (Signing and verifying JWTs; RFC 9449 4.2 suggests 96 bits or more): DPoP proof jti is not 128 random bits of base64url",
  "dpop.jti-reused": "MUST (4.3): DPoP proof jti used twice",
  "browser-assertion.jti-missing": "Rule (5, jti as in 4.2): Browser assertion without a jti",
  "browser-assertion.jti-weak": "Rule (5, jti as in 4.2): Browser assertion jti is not 128 random bits of base64url",
  "browser-assertion.jti-reused": "MUST (5): Browser assertion jti used twice",

  // ---- Client and Session assertions: signed with published keys (4.1, 4.2) ----
  "client-assertion.alg": "Guides (Signing and verifying JWTs; S19): Client assertion alg isn't ES256 or RS256",
  "client-assertion.embedded-key": "Guides (Signing and verifying JWTs, addressed to Companies: ignore such keys): Client assertion embeds or points to a key (jku, x5u, jwk)",
  "client-assertion.typ": "Reading (S2), strict Company only: Client assertion header typ isn't \"JWT\"",
  "client-assertion.kid": "Reading (S2), strict Company only: Client assertion kid names no published key",
  "client-assertion.signature": "RFC (RFC 7523 3): Client assertion doesn't verify against the client's JWKS, or has expired",
  "client-assertion.iat-exp-missing": "RFC (RFC 7523 3 for exp; iat is ours): Client assertion without iat or exp",
  "client-assertion.lifetime": "Reading (S2; Guides: reject a long lifetime): Client assertion lifetime is too long (strict 60 s, lenient 300 s)",
  "session-assertion.alg": "Guides (Signing and verifying JWTs; S19): Session assertion alg isn't ES256 or RS256",
  "session-assertion.embedded-key": "Guides (Signing and verifying JWTs, addressed to Companies: ignore such keys): Session assertion embeds or points to a key (jku, x5u, jwk)",
  "session-assertion.typ": "Reading (S2), strict Company only: Session assertion header typ isn't \"JWT\"",
  "session-assertion.kid": "Reading (S2), strict Company only: Session assertion kid names no published key",
  "session-assertion.signature": "Rule (4.2; RFC 7523 3): Session assertion doesn't verify against the client's JWKS, or has expired",
  "session-assertion.iat-exp-missing": "Rule (4.2; RFC 7523 3 for exp): Session assertion without iat or exp",
  "session-assertion.lifetime": "Reading (S2; 4.2: \"short-lived\"): Session assertion lifetime is too long (strict 60 s, lenient 300 s)",

  // ---- Client authentication: private_key_jwt (4.1, RFC 7523) ----
  "client-assertion.missing": "Rule (4.1, 4.2, 4.6, 4.9): Token, device or revocation request without a client assertion",
  "client-assertion.not-jwt": "RFC (RFC 7523 3): Client assertion is not a JWT",
  "client-assertion.wrong-typ": "Rule (5: a browser assertion isn't accepted at the token endpoint; N25 for DPoP proofs): A browser assertion or DPoP proof used as the client assertion",
  "client-assertion.aud-array": "Reading (S1; 4.2 asks a single string only of the Session assertion): Client assertion aud is an array",
  "client-assertion.aud": "RFC (RFC 7523 3; which value is S1): Client assertion aud doesn't name this Company (exactAud: the endpoint called)",
  "client-assertion.iss-sub": "RFC (RFC 7523 3, RFC 7521 5.2): Client assertion iss and sub aren't both the client_id",

  // ---- Session assertion: the JWT bearer grant (4.2) ----
  "session-assertion.missing": "RFC (RFC 7523 2.1): JWT bearer grant without an assertion",
  "session-assertion.not-jwt": "RFC (RFC 7523 2.1): Session assertion is not a JWT",
  "session-assertion.browser-typ": "Rule (5): Browser assertion sent to the token endpoint",
  "session-assertion.aud": "Rule (4.2): Session assertion aud isn't the token endpoint as a single string",
  "session-assertion.iss": "Rule (4.2): Session assertion iss isn't the client_id",
  "session-assertion.sub": "Rule (4.2; RFC 7523 3): Session assertion has no sub (User ID)",
  "user-id.personal": "MUST NOT (4.2): User ID contains personal information",

  // ---- The client metadata document and JWKS (4.1) ----
  "client-metadata.not-url": "MUST (4.1): client_id is not a URL",
  "client-metadata.not-https": "MUST (4.1): client_id is not an https URL",
  "client-metadata.fetch-status": "MUST (4.1; Guides: fetch it without following redirects): Fetching client_id didn't return 200 (redirects aren't followed)",
  "client-metadata.not-json": "MUST (4.1): Client metadata is not JSON",
  "client-metadata.client-id-mismatch": "MUST (4.1): client_id in the document isn't the URL it was fetched from",
  "client-metadata.jwks-uri": "MUST (4.1; \"same domain\" read as the same host, S6): jwks_uri isn't https on the client_id domain",
  "client-metadata.redirect-uris": "MUST (4.1; \"same domain\" read as the same host, S6): A redirect_uri isn't https on the client_id domain",
  "client-metadata.auth-method": "Rule (4.1): token_endpoint_auth_method isn't private_key_jwt",
  "client-metadata.jwks-status": "Rule (4.1): jwks_uri didn't return 200",
  "client-metadata.jwks-empty": "Rule (4.1): The JWKS has no keys",
  "client-metadata.jwks-private": "Rule (4.1: \"The key set contains only public keys\"): The JWKS publishes a private key",
  "client-metadata.key-without-kid": "Guides (Rotating keys): A JWKS key has no kid",

  // ---- DPoP proofs (4.3, RFC 9449) ----
  "dpop.missing": "MUST (4.3): Resource request without a DPoP proof",
  "dpop.multiple": "RFC (RFC 9449 4.3): More than one DPoP proof in the header",
  "dpop.not-jwt": "RFC (RFC 9449 4.2): DPoP proof is not a JWT",
  "dpop.typ": "RFC (RFC 9449 4.2): DPoP proof typ isn't dpop+jwt",
  "dpop.alg": "Guides (Signing and verifying JWTs; S19): DPoP proof alg isn't ES256 or RS256",
  "dpop.no-jwk": "RFC (RFC 9449 4.2): DPoP proof has no jwk in its header",
  "dpop.private-jwk": "RFC (RFC 9449 4.2): DPoP proof header carries a private key",
  "dpop.signature": "MUST (4.3): DPoP proof signature doesn't verify",
  "dpop.htm": "MUST (4.3): DPoP proof htm isn't the request method",
  "dpop.htu": "MUST (4.3): DPoP proof htu isn't the request URL without query or fragment",
  "dpop.iat": "MUST (4.3): DPoP proof iat is outside the acceptance window",
  "dpop.ath-at-token-endpoint": "Rule (4.3): DPoP proof at the token endpoint carries ath",
  "dpop.ath": "MUST (4.3): DPoP proof ath isn't the hash of the token sent",
  "dpop.nonce-ignored": "Guides (DPoP keys and proofs: keep the nonce for that server; 4.3 only says MUST support nonces; S23): DPoP proof without the nonce this key already used at this server",
  "dpop.key-mismatch": "MUST (4.3): DPoP proof key isn't the key the token is bound to",
  "dpop.key-shared": "Rule (4.3: a key pair for each User at each Company; N35): One DPoP key used for two User IDs",

  // ---- Session Tokens on resources (4.3, 6) ----
  "resource.no-token": "MUST (4.3): API, conversation or operations request without a Session Token",
  "resource.bearer-scheme": "MUST (4.3, 6): Bearer scheme outside MCP",
  "resource.bearer-token-as-dpop": "MUST (4.3): A Bearer Session Token sent with the DPoP scheme",
  "resource.stale-token": "MUST (4.3): An older Session Token used after a newer one was issued for the Session",
  "mcp.not-bearer": "MUST (4.3, 6): MCP request without the Bearer scheme",
  "mcp.wrong-token": "MUST (4.3, 6): MCP request with a token not issued for this MCP server",
  "mcp.accept": "RFC (MCP 2025-06-18 Streamable HTTP, which spec 6 names): MCP request doesn't Accept application/json and text/event-stream",

  // ---- Rate limits and secrets (4.3, 4.7, 4.8; Guides) ----
  "rate-limit.retry-after-ignored": "MUST (4.3): Request sent before an earlier Retry-After elapsed",
  "secret.password": "MUST NOT (4.7): A password sent anywhere but the Mediated Sign-In body",
  "secret.one-time-code": "Guides (Handling secrets; 4.7: submit only the code): A one-time code sent anywhere but the code submission body",
  "secret.account-token": "MUST (4.8): An Account Token sent anywhere but the token and revocation bodies",
  "secret.token-in-url": "MUST NOT (4.3): A token sent in a URL",

  // ---- Token endpoint (4.2–4.8) ----
  "form.not-form": "RFC (RFC 6749 4.1.3, RFC 7009 2.1, RFC 8628 3.1): OAuth request body isn't application/x-www-form-urlencoded",
  "token.no-dpop": "Rule (4.2, 4.3): Token request without a DPoP proof (only MCP Bearer requests may omit it)",
  "token.mcp-dpop": "Rule (4.3): DPoP-bound token requested for the MCP server",
  "token.signed-in-renewed-with-assertion": "Rule (4.2; S5): A signed-in Session renewed with the Session assertion, not the Account Token",
  "account-token.other-client": "MUST (4.8): Account Token used by a different client_id",
  "account-token.rotated-reused": "MUST (4.8): Account Token used after the Company rotated it",
  "session.account-mismatch-reused": "Rule (4.4: \"the Personal Agent starts a new Session\", no keyword): A Session the Company refused with account_mismatch asked again to sign in to another account, instead of a new Session",

  // ---- Sign-in (4.4–4.7) ----
  "signin.no-scope": "MUST (4.4): Sign-in request without scope",
  "authorize.redirect-uri": "MUST (4.5): redirect_uri isn't exactly a registered redirect_uri",
  "authorize.no-state": "Rule (4.5; RFC 6749 recommends state): Authorization request without state",
  "authorize.no-pkce": "Rule (4.5; RFC 7636 4.2 for S256): Authorization request without PKCE S256",
  "authorize.secret-in-url": "MUST NOT (4.3 for tokens; Guides for assertions): A token or assertion in the authorization URL",
  "code.reused": "RFC (RFC 6749 4.1.2): Authorization code exchanged twice",
  "code.redirect-uri": "RFC (RFC 6749 4.1.3): redirect_uri at the token endpoint differs from the authorization request",
  "code.pkce": "RFC (RFC 7636 4.5, 4.6): PKCE code_verifier doesn't match the code_challenge",
  "code.no-session-id": "Rule (4.5): Authorization code exchanged without session_id",
  "device.polled-after-final": "Rule (4.6): Device polling continued after completion or access_denied",
  "device.polled-after-expiry": "Rule (4.6): Device polling continued after expired_token",
  "device.too-fast": "RFC (RFC 8628 3.5): Device polling faster than the interval after slow_down",
  "device.no-session-id": "Rule (4.6): Device code exchanged without session_id",
  "mediated.missing-field": "Rule (4.7): Mediated Sign-In without a field the Company asked for",
  "mediated.credentials-with-code": "Rule (4.7): Credentials resent with the one-time code",
  "mediated.code-other-session": "Rule (4.7): One-time code submitted from a Session other than the one that started the sign-in",

  // ---- Browser join (5) ----
  "browser-assertion.in-url": "MUST (5): Browser assertion sent in the URL",
  "browser-assertion.not-post": "Rule (5): Browser join isn't a POST",
  "browser-assertion.content-type": "Rule (5): Browser join isn't a form POST",
  "browser-assertion.missing": "Rule (5): Browser join without an assertion",
  "browser-assertion.not-jwt": "Rule (5): Browser assertion is not a JWT",
  "browser-assertion.typ": "MUST (5): Browser assertion typ isn't poppy-browser+jwt",
  "browser-assertion.alg": "Guides (Signing and verifying JWTs; S19): Browser assertion alg isn't ES256 or RS256",
  "browser-assertion.embedded-key": "Guides (Signing and verifying JWTs, addressed to Companies: ignore such keys): Browser assertion embeds or points to a key (jku, x5u, x5c, jwk)",
  "browser-assertion.kid": "Reading (S2), strict Company only: Browser assertion kid names no published key",
  "browser-assertion.iat-exp-missing": "MUST (5): Browser assertion without iat or exp",
  "browser-assertion.iat-future": "Guides (Signing and verifying JWTs: a small clock skew): Browser assertion iat is in the future, beyond clock skew",
  "browser-assertion.no-iss": "MUST (5): Browser assertion without iss",
  "browser-assertion.unknown-agent": "MUST (5): Browser assertion iss isn't a client_id the Company can load",
  "browser-assertion.signature": "MUST (5): Browser assertion doesn't verify, or has expired",
  "browser-assertion.aud": "MUST (5): Browser assertion aud isn't the browser_session_endpoint",
  "browser-assertion.lifetime": "MUST (5): Browser assertion exp is more than 60 seconds after iat",
  "browser-assertion.session": "MUST (5): Browser assertion session_id isn't this agent and User's active Session",
  "browser-assertion.return-to-not-url": "MUST (5): Browser assertion return_to isn't a URL",
  "browser-assertion.return-to-off-domain": "MUST (5): Browser assertion return_to isn't HTTPS on the Company's domain",

  // ---- Writes and retries (Guides; Ops 6) ----
  "idempotency.key-reused": "Guides (Retries): Idempotency-Key reused with a different body",
  "exchange.performed-twice": "Guides (Retries; Ops 1 and 6: at most once): The same exchange made twice (a write retried without its key, or confirmed twice)",

  // ---- Conversations (7) ----
  "message.missing": "Rule (7.3): Conversation request without a message",
  "message.id": "MUST (7.4: required; 7.2: 1 to 256 base64url characters): Message id isn't 1-256 base64url characters",
  "message.sender": "MUST (7.4, 7.8): Message sender isn't agent or human",
  "message.empty": "MUST (7.4): Message has none of text, data or context",
  "message.text-type": "Rule (7.4): Message text isn't a string",
  "message.json-in-text": "SHOULD NOT (7.4): JSON in a message's text; it belongs in data",
  "message.data-type": "Rule (7.4): Message data isn't a JSON object",
  "message.context-type": "Rule (7.4): Message context isn't an object",
  "message.id-reused": "MUST (7.3: unique for the User): Message id reused with different content",
  "context.locale": "MUST (7.4): context.locale isn't an RFC 5646 tag",
  "context.time-zone": "MUST (7.4): context.time_zone isn't an IANA name",
  "context.user-available": "MUST (7.4): context.user_available isn't a boolean",
  "direct.agent-words": "Reading (S12; 7.10: the User's messages, as written, as human): Direct Conversation opened with words not marked as the User's",
  "direct.agent-words-later": "Reading (S12; 7.10): The agent's own words sent into an open Direct Conversation",
  "conversation.cross-user": "Rule (7.2: a conversation belongs to the User that started it; 7.13; S17): A conversation of one User reached by another User of the same agent",
  "handoff.body": "Rule (7.9): Handoff body isn't {}",
  "close.body": "Rule (7.12): Close body isn't {}",

  // ---- Operations extension (Ops 3, 5, 6) ----
  "confirm.approved-by": "Rule (Ops 5.1, 5.2): Confirm without approved_by user or standing_permission",
  "confirm.revision": "Rule (Ops 5.1, 5.2): Confirm without the revision number the User approved",
  "proposal.while-open": "MUST NOT (Ops 6; recorded only after a confirm, N34): A new proposal asked for while the confirmed operation for the same action isn't final",
  "confirm.standing-permission-overrides-user": "Rule (Ops 3, 5.1: \"Not allowed when user_approval_required is true\"): Confirmed under a standing permission when user_approval_required is true"
} as const;

export type ViolationId = keyof typeof VIOLATIONS;

/** Every id, for the catalog test. */
export const VIOLATION_IDS = Object.keys(VIOLATIONS) as ViolationId[];

/** The basis of a check, from the word its description starts with; MUST NOT counts as MUST and SHOULD NOT as SHOULD. */
export function basisOf(id: ViolationId): Basis {
  const word = /^(MUST|RFC|Rule|SHOULD|Guides|Reading|MAY)\b/.exec(VIOLATIONS[id])?.[1];
  if (!word) throw new Error(`${id}: description doesn't start with its basis`);
  return word as Basis;
}

/** A check's level, from its basis: `failure` is recorded as a violation, the rest as warnings. */
export function levelOfCheck(id: ViolationId): Level {
  return levelOf(basisOf(id));
}

/** Whether a recorded `[id] detail` is a violation (a failure) rather than a warning. Unknown ids count as violations. */
export function isViolation(recorded: string): boolean {
  const id = violationId(recorded);
  return !(id in VIOLATIONS) || levelOfCheck(id as ViolationId) === "failure";
}

/** The id of a recorded violation, `[id] detail`. */
export function violationId(recorded: string): string {
  return /^\[([^\]]+)\]/.exec(recorded)?.[1] ?? "";
}
