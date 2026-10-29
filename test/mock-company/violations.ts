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
 * Each description starts with what the check rests on, then where: spec
 * sections bare (`5.2`), `Ops n` for the Operations extension,
 * `Mediated Sign-In n` for that extension, and a Guides heading by name,
 * checked against the 0.3 text of 28 October 2026 in
 * `spec/draft-0.3-retrieved-2026-10-28/pages/`:
 *
 * - `MUST (5.2: …):` or `MUST NOT (…):` a MUST, MUST NOT or required field
 *   in the spec or one of its extensions.
 * - `RFC (RFC 9449 4.3; 4.5):` a requirement of a standard the spec builds
 *   on, such as DPoP, which 0.3 leaves to RFC 9449.
 * - `Rule (8.9: …):` the spec states it as how the protocol works, with no
 *   RFC 2119 keyword ("asks for a person at the Company with an empty JSON
 *   object").
 * - `SHOULD (…):` or `SHOULD NOT (…):` a SHOULD in the spec.
 * - `Guides (heading: …):` only a recommendation in the Guides.
 * - `Reading (S2; 4.1):` our answer to an open question in
 *   docs/spec-issues.md, recorded in docs/readings.md.
 *
 * Ids are stable names, so a few keep 0.2's words: `account-token` is the
 * refresh token (4.4).
 *
 * The basis decides the level (src/validator/levels.ts,
 * docs/conformance-levels.md): MUST, RFC and Rule are failures, which the
 * mock records as violations; SHOULD and Guides are warnings, and Reading is
 * tentative, which it records as warnings. Nothing rests on a MAY: an option
 * is never held against the side that takes it. Whether a check also refuses
 * the request is the mock's behaviour, not its verdict: it refuses where the
 * spec gives it an error to send, and where a Guides recommendation or one
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
export type JwtKind = "client-assertion" | "dpop" | "session-jwt";

/** The JWT signed with the client's published keys at the token, device and revocation endpoints (4.1); delegations are checked on their own (5.2). */
export type SignedKind = "client-assertion";

export const VIOLATIONS = {
  // ---- jti: unique and unguessable (4.1, 5.2; RFC 9449 4.2), 128 random bits (Guides) ----
  "client-assertion.jti-missing": "MUST (4.1: \"MUST include iat and a unique, unguessable jti\"): Client assertion without a jti",
  "client-assertion.jti-weak": "Guides (Signing and verifying JWTs: a jti of at least 128 random bits; 4.1 asks only that it be unguessable): Client assertion jti is not 128 random bits of base64url",
  "client-assertion.jti-reused": "MUST (4.1: a unique jti; the Company MAY reject a reused one, as RFC 7523 3 allows): Client assertion jti used twice",
  "dpop.jti-missing": "RFC (RFC 9449 4.2; 4.5): DPoP proof without a jti",
  "dpop.jti-weak": "Guides (Signing and verifying JWTs: at least 128 random bits; RFC 9449 4.2 asks for a negligible chance of reuse): DPoP proof jti is not 128 random bits of base64url",
  "dpop.jti-reused": "RFC (RFC 9449 4.2: a jti not used by any other proof; 11.1): DPoP proof jti used twice",

  // ---- Client assertions: private_key_jwt, addressed to the issuer (4.1) ----
  "client-assertion.alg": "Guides (Signing and verifying JWTs: sign client assertions with ES256, or PS384 when signing blindly; reject symmetric algorithms): Client assertion alg isn't ES256 or PS384",
  "client-assertion.embedded-key": "Guides (Signing and verifying JWTs: verify only with keys from the verified jwks_uri; ignore jku, x5u and any embedded key): Client assertion embeds or points to a key (jku, x5u, jwk)",
  "client-assertion.typ": "Reading (S2; 4.1 names no typ), strict Company only: Client assertion header typ isn't \"JWT\"",
  "client-assertion.kid": "Reading (S2; Guides, Rotating keys: give every key a kid), strict Company only: Client assertion kid names no published key",
  "client-assertion.signature": "RFC (RFC 7523 3; 4.1: signed by a key from jwks_uri): Client assertion doesn't verify against the client's JWKS, or has expired",
  "client-assertion.iat-exp-missing": "MUST (4.1: \"MUST include iat\"; RFC 7523 3 requires exp): Client assertion without iat or exp",
  "client-assertion.lifetime": "Reading (S2: strict 60 s; 4.1: \"MUST make them short-lived\", and the Guides' five minutes is the lenient 300 s): Client assertion lifetime is too long",
  "client-assertion.missing": "Rule (4.1, 4.2, 4.3, 4.4, 4.6: each token, device authorization and revocation request carries the client assertion): Token, device or revocation request without a client assertion",
  "client-assertion.not-jwt": "RFC (RFC 7523 3; 4.1): Client assertion is not a JWT",
  "client-assertion.wrong-typ": "RFC (RFC 8725 3.11, which 5.2 cites: explicit typing keeps a Session JWT, delegation or DPoP proof from being taken for another JWT): A DPoP proof, Session JWT or delegation used as the client assertion",
  "client-assertion.aud-array": "MUST (4.1: \"aud MUST be the Company's issuer, as a single string\"): Client assertion aud is an array",
  "client-assertion.aud": "MUST (4.1: aud MUST be the issuer; Companies MUST reject any other, including their token endpoint URL): Client assertion aud isn't this Company's issuer",
  "client-assertion.iss-sub": "RFC (RFC 7523 3, RFC 7521 5.2; 4.1: client assertions follow RFC 7523 3): Client assertion iss and sub aren't both the client_id",

  // ---- User IDs (5.1) ----
  "user-id.personal": "MUST NOT (5.1: \"MUST NOT contain or be derived from personal information\"): User ID contains personal information",

  // ---- The client metadata document and JWKS (4.1, 5.3) ----
  "client-metadata.not-url": "MUST (4.1: client_id MUST be an HTTPS URL): client_id is not a URL",
  "client-metadata.not-https": "MUST (4.1: client_id MUST be an HTTPS URL): client_id is not an https URL",
  "client-metadata.fetch-status": "MUST (4.1: an HTTPS URL that returns its metadata document; 5.3, step 1: fetched without following redirects, as the CIMD draft requires): Fetching client_id didn't return 200 (redirects aren't followed)",
  "client-metadata.not-json": "MUST (4.1: the URL returns its metadata document): Client metadata is not JSON",
  "client-metadata.client-id-mismatch": "MUST (4.1: \"client_id MUST equal the URL the document was fetched from\"): client_id in the document isn't the URL it was fetched from",
  "client-metadata.jwks-uri": "MUST (4.1: jwks_uri MUST be HTTPS on the same domain as client_id, read as the same host): jwks_uri isn't https on the client_id domain",
  "client-metadata.redirect-uris": "MUST (4.1: each redirect_uri HTTPS on the same domain as client_id, read as the same host, or a loopback redirect URI): A redirect_uri isn't https on the client_id domain or loopback",
  "client-metadata.auth-method": "Rule (4.1: the Personal Agent authenticates with private_key_jwt): token_endpoint_auth_method isn't private_key_jwt",
  "client-metadata.jwks-status": "Rule (4.1: jwks_uri holds the keys; 5.3, step 1 fetches them): jwks_uri didn't return 200",
  "client-metadata.jwks-empty": "Rule (4.1: the keys that sign client assertions and delegations): The JWKS has no keys",
  "client-metadata.jwks-private": "Rule (4.1: \"The key set contains only public keys\"): The JWKS publishes a private key",
  "client-metadata.key-without-kid": "Guides (Rotating keys: \"Give every key in jwks_uri a kid\"): A JWKS key has no kid",

  // ---- DPoP proofs, for DPoP-bound access tokens (4.5, RFC 9449) ----
  "dpop.missing": "RFC (RFC 9449 7: a DPoP-bound access token is sent with a proof; 4.5): Resource request with a DPoP-bound token and no DPoP proof",
  "dpop.multiple": "RFC (RFC 9449 4.3; 4.5): More than one DPoP proof in the header",
  "dpop.not-jwt": "RFC (RFC 9449 4.2; 4.5): DPoP proof is not a JWT",
  "dpop.typ": "RFC (RFC 9449 4.2; 4.5): DPoP proof typ isn't dpop+jwt",
  "dpop.alg": "RFC (RFC 9449 4.3: an asymmetric algorithm the server supports, which 5.1's dpop_signing_alg_values_supported lists; 4.5): DPoP proof alg isn't ES256 or RS256",
  "dpop.no-jwk": "RFC (RFC 9449 4.2; 4.5): DPoP proof has no jwk in its header",
  "dpop.private-jwk": "RFC (RFC 9449 4.2: jwk MUST NOT contain a private key; 4.5): DPoP proof header carries a private key",
  "dpop.signature": "RFC (RFC 9449 4.3; 4.5): DPoP proof signature doesn't verify",
  "dpop.htm": "RFC (RFC 9449 4.2, 4.3; 4.5): DPoP proof htm isn't the request method",
  "dpop.htu": "RFC (RFC 9449 4.2, 4.3; 4.5): DPoP proof htu isn't the request URL without query or fragment",
  "dpop.iat": "RFC (RFC 9449 4.3: iat within an acceptable window; 4.5): DPoP proof iat is outside the acceptance window",
  "dpop.ath": "RFC (RFC 9449 4.2, 4.3: ath is the hash of the access token; 4.5): DPoP proof ath isn't the hash of the token sent",
  "dpop.nonce-ignored": "Guides (The Session header: support nonces as RFC 9449 8 describes; which server a nonce is for is S23): DPoP proof without the nonce this key already used at this server",
  "dpop.key-mismatch": "RFC (RFC 9449 4.3, 7.1: the proof's key is the one the token is bound to; 4.5): DPoP proof key isn't the key the token is bound to",

  // ---- Access tokens at resources (4.5, 7) ----
  "resource.bearer-scheme": "Rule (4.5: the scheme the token response's token_type names; RFC 9449 7.1): An access token sent with another scheme than its token_type",
  "mcp.wrong-token": "MUST (7: \"MUST request a token with resource set to the MCP server's url\"; 4.5): MCP request with a token not issued for this MCP server",
  "mcp.accept": "RFC (MCP 2025-06-18 Streamable HTTP, which 7 names): MCP request doesn't Accept application/json and text/event-stream",

  // ---- Rate limits and secrets (5.6, 10.2; Mediated Sign-In 6; Guides) ----
  "rate-limit.retry-after-ignored": "MUST (5.6: \"MUST wait at least that long before sending the request again\"): Request sent again before its Retry-After elapsed",
  "rate-limit.shared-limit-ignored": "Guides (Rate limits: keep track of limits for each company and share them across your tasks and users; 5.6's MUST covers only the request sent again): A different request sent to the Company before an earlier Retry-After elapsed",
  "secret.password": "MUST NOT (Mediated Sign-In 6: \"MUST NOT send credentials anywhere other than the token_endpoint of the Company's issuer\"): A password sent anywhere but the token endpoint's body",
  "secret.one-time-code": "Guides (Handling secrets: keep one-time sign-in codes out of messages and URLs; Mediated Sign-In 4 sends the code to the token endpoint): A one-time code sent anywhere but the token endpoint's body",
  "secret.account-token": "Guides (Handling secrets: keep tokens out of messages, logs and URLs; 4.4 and 4.6 send a refresh token only to the token and revocation endpoints): A refresh token sent anywhere but the token and revocation bodies",
  "secret.token-in-url": "MUST NOT (5.6: \"MUST NOT send tokens or Session JWTs in a URL\"): A token sent in a URL",

  // ---- Token endpoint and refresh tokens (4.4, 4.6) ----
  "form.not-form": "RFC (RFC 6749 4.1.3, RFC 7009 2.1, RFC 8628 3.1): OAuth request body isn't application/x-www-form-urlencoded",
  "account-token.other-client": "RFC (RFC 6749 6: a refresh token is bound to the client it was issued to; 4.4): Refresh token used by a different client_id",
  "account-token.rotated-reused": "MUST (4.4: \"The Personal Agent then MUST use the new one from then on\"): Refresh token used after the Company rotated it",

  // ---- Sign-in (4.2, 4.3, 4.7; Mediated Sign-In 3, 4) ----
  "signin.no-scope": "MUST (4.7: \"Each sign-in request MUST include scope\"): Sign-in request without scope",
  "authorize.redirect-uri": "MUST (4.2: \"redirect_uri MUST exactly match an entry\" in redirect_uris, but a loopback port): redirect_uri isn't exactly a registered redirect_uri",
  "authorize.no-state": "Guides (Direct and device sign-in: make state random and single-use, and record which company it belongs to; 4.2 relies on PKCE): Authorization request without state",
  "authorize.no-pkce": "Rule (4.2: the authorization code grant with PKCE; Guides: S256): Authorization request without PKCE S256",
  "authorize.secret-in-url": "MUST NOT (5.6 for tokens; Guides, Handling secrets, for assertions): A token or assertion in the authorization URL",
  "code.reused": "RFC (RFC 6749 4.1.2; 4.2): Authorization code exchanged twice",
  "code.redirect-uri": "RFC (RFC 6749 4.1.3; 4.2): redirect_uri at the token endpoint differs from the authorization request",
  "code.pkce": "RFC (RFC 7636 4.5, 4.6; 4.2): PKCE code_verifier doesn't match the code_challenge",
  "device.polled-after-final": "Rule (4.3: polls until the User approves or declines, as RFC 8628 3.4 and 3.5 describe): Device polling continued after completion or access_denied",
  "device.polled-after-expiry": "Rule (4.3: polls until the request expires, as RFC 8628 3.5 describes): Device polling continued after expired_token",
  "device.too-fast": "RFC (RFC 8628 3.5: add 5 seconds to the interval on slow_down; 4.3): Device polling faster than the interval after slow_down",
  "mediated.missing-field": "Rule (Mediated Sign-In 3: \"every field in fields as a parameter\"): Mediated Sign-In without a field the Company asked for",
  "mediated.credentials-with-code": "Rule (Mediated Sign-In 4: the code goes with sign_in_id, \"but not the credentials or scope\"): Credentials resent with the one-time code",
  "mediated.scope-with-code": "Rule (Mediated Sign-In 4: \"but not the credentials or scope\"; the sign-in keeps its first scopes): scope resent with the one-time code",
  "mediated.code-other-client": "Rule (Mediated Sign-In 4: \"Only the client_id that started a sign-in can finish it\"): A one-time code sent by another client",

  // ---- Writes and retries (Guides; Ops 7) ----
  "idempotency.key-reused": "Guides (Retries: reuse an Idempotency-Key only to retry the same request; companies reject a repeated key with a different body): Idempotency-Key reused with a different body",
  "idempotency.key-missing": "Guides (Retries: \"Send an Idempotency-Key on API writes that accept one\"): An API write whose description takes an Idempotency-Key sent without one",
  "upload.boundary": "RFC (RFC 7578 4.1; RFC 2046 5.1.1): A multipart/form-data body without a boundary parameter",
  "upload.part-name": "RFC (RFC 7578 4.2): A multipart/form-data part without a Content-Disposition of form-data with a name",
  "exchange.performed-twice": "Guides (Retries: reuse the Idempotency-Key when retrying; Ops 7: at most once): The same exchange made twice (a write retried without its key, or approved again as a new operation)",

  // ---- Conversations (8) ----
  "message.missing": "Rule (8.3: a request carries its message): Conversation request without a message",
  "message.id": "MUST (8.4: id is required; 8.2: 1 to 256 URL-safe base64 characters): Message id isn't 1-256 base64url characters",
  "message.empty": "MUST (8.4: \"MUST have at least one of text, data, or context\"): Message has none of text, data or context",
  "message.text-type": "Rule (8.4: text is the message in natural language): Message text isn't a string",
  "message.json-in-text": "Guides (Conversations: put structured details in data, not JSON or other markup in text; 8.4 says the same without a keyword): JSON in a message's text",
  "message.data-type": "Rule (8.4: data is a JSON object): Message data isn't a JSON object",
  "message.context-type": "Rule (8.4: context holds facts about the User's situation, as fields): Message context isn't an object",
  "message.id-reused": "MUST (8.3: \"MUST make it unique for the User\"): Message id reused with different content",
  "context.locale": "MUST (8.4: \"it MUST use the field and format defined here\", an RFC 5646 tag): context.locale isn't an RFC 5646 tag",
  "context.time-zone": "MUST (8.4: the field and format defined here, an IANA time zone name): context.time_zone isn't an IANA name",
  "context.user-available": "MUST (8.4: the field and format defined here, true or false): context.user_available isn't a boolean",
  "direct.agent-words": "Reading (S12; 8.10: the User's messages, as written, with author.type human): Direct Conversation opened with words not marked as the User's",
  "direct.agent-words-later": "Reading (S12; 8.10): The agent's own words sent into an open Direct Conversation",
  "conversation.cross-user": "Rule (8.2: a conversation belongs to the client_id and User ID that started it; 8.13; S17): A conversation of one User reached by another User of the same agent",
  "handoff.body": "Rule (8.9: \"with an empty JSON object\"): Handoff body isn't {}",
  "close.body": "Rule (8.12: \"by sending an empty JSON object\"): Close body isn't {}",
  "message.author": "MUST (8.4: author is required, with type agent or human, and only Company messages have id, name or image; 8.8): A message without a valid author",
  "message.sender-field": "Reading (8.4 has author where 0.2 had sender; docs/readings.md): A message that still carries sender",

  // ---- The Session header (5.2, 5.3) ----
  "session-jwt.missing": "MUST (5.2: \"MUST send a Poppy-Session header on every request\" to APIs, conversations and protocol endpoints): A request to a resource without the Session header",
  "session-jwt.missing-with-token": "MUST (5.2; 5.3: the Company MUST reject an access token without the Session header): An access token sent without the Session header",
  "session-jwt.not-jwt": "MUST (5.2: the header holds a JWT): The Session header isn't a JWT",
  "session-jwt.typ": "MUST (5.2: \"typ MUST be poppy-session+jwt\"): A Session JWT of another typ",
  "session-jwt.alg": "MUST (5.2: \"alg MUST be ES256\"): A Session JWT not signed with ES256",
  "session-jwt.no-delegation": "MUST (5.2 Delegated keys: the Company MUST reject a Session JWT without a delegation): A Session JWT without pap_dlg",
  "session-jwt.iss": "MUST (5.2: \"MUST include every claim except agent_id\", and ath without a token): A Session JWT without iss",
  "session-jwt.kid": "MUST (5.2 Delegated keys, step 3: kid is the delegated key's RFC 7638 thumbprint; 5.3: the Company MUST complete these checks): A Session JWT whose kid isn't its key's thumbprint",
  "session-jwt.signature": "MUST (5.2 Delegated keys, step 3: verified with the key in cnf.jwk; 5.3): A Session JWT that doesn't verify with the delegated key",
  "session-jwt.iat": "MUST (5.2: iat is required; 5.3: within the Company's acceptance window): A Session JWT without iat, or outside the acceptance window",
  "session-jwt.after-delegation": "MUST NOT (5.2 Delegated keys: \"MUST NOT sign a Session JWT after its delegation's exp\"): A Session JWT signed after its delegation expired",
  "session-jwt.aud": "MUST (5.2: aud is the issuer as a single string; 5.3: compared character for character): A Session JWT for another audience",
  "session-jwt.htm": "MUST (5.2, 5.3: htm matches the request as RFC 9449 4.3 describes): A Session JWT whose htm isn't the request's method",
  "session-jwt.htu": "MUST (5.2, 5.3: htu is the URL without query or fragment, as RFC 9449 4.3 describes): A Session JWT whose htu isn't the request's URL without its query",
  "session-jwt.sid": "MUST (5.2: sid is required, with the characters of Conversation IDs): A Session JWT without a valid sid",
  "session-jwt.sub": "MUST (5.2: sub is the User ID and required; agent_id a string when present): A Session JWT without sub, or with a malformed agent_id",
  "session-jwt.ath": "MUST (5.2: ath is the access token's hash; 5.3, step 3): A Session JWT whose ath doesn't match the access token",
  "session-jwt.oauth-endpoint": "Rule (5.2: the Session header \"isn't sent to the Company's OAuth endpoints or website pages\"): A Poppy-Session header sent to the token, device or revocation endpoint",
  "session-jwt.ath-without-token": "MUST (5.3, step 3: \"Without an access token, ath MUST be absent\"): A Session JWT with ath and no access token",
  "session-jwt.sub-changed": "MUST (5.2: \"MUST send the same sub and agent_id in every Session JWT for a Session\"; 5.3, step 4): A Session's sid sent with another User ID or Agent ID",
  "session-jwt.token-other-client": "MUST (5.3, step 3: the token was issued to the same client_id as iss): An access token sent by another client",
  "session-jwt.jti-missing": "MUST (5.2: \"MUST include every claim except agent_id\"): A Session JWT without a jti",
  "session-jwt.jti-weak": "Guides (Signing and verifying JWTs: a jti of at least 128 random bits; 5.2 asks only that it be unguessable): A Session JWT jti that isn't 128 random bits of base64url",
  "session-jwt.jti-reused": "Rule (5.2: \"jti is unique and unguessable\"; 5.3: a Company MAY reject a reused jti): A Session JWT jti used twice",

  // ---- Delegations (5.2 Delegated keys) ----
  "delegation.not-jwt": "MUST (5.2 Delegated keys: pap_dlg is the delegation in compact form, and the Company MUST reject one that fails its checks): pap_dlg isn't a JWT",
  "delegation.typ": "MUST (5.2 Delegated keys: \"typ MUST be pap-delegation+jwt\"): A delegation of another typ",
  "delegation.alg": "Rule (5.2 Delegated keys: \"alg is ES256 or PS384\"): A delegation signed with another algorithm",
  "delegation.kid": "MUST (5.2 Delegated keys, step 1: kid names the key in jwks_uri; the Company MUST reject a delegation that fails a check): A delegation whose kid names no published key",
  "delegation.signature": "MUST (5.2 Delegated keys, step 1): A delegation that doesn't verify with the key its kid names",
  "delegation.iss": "MUST (5.2 Delegated keys, step 2: its iss is the token's iss): A delegation from another client",
  "delegation.lifetime": "MUST (5.2 Delegated keys: \"exp MUST be at most 24 hours after iat\"; step 2): A delegation without iat and exp, or longer than a day",
  "delegation.expired": "MUST (5.2 Delegated keys, step 2: it hasn't expired): A Session JWT carrying an expired delegation",
  "delegation.jti": "Rule (5.2 Delegated keys: \"jti is a unique, unguessable ID\"; Guides: 128 random bits): A delegation without a jti of 128 random bits",
  "delegation.cnf": "MUST (5.2 Delegated keys, step 3: the Session JWT is verified with the key in cnf.jwk): A delegation without cnf.jwk",
  "delegation.private-key": "MUST NOT (5.2 Delegated keys: \"It MUST NOT contain private key members\"): A delegation that carries a private key",
  "delegation.names-user": "MUST NOT (5.2 Delegated keys: \"MUST NOT put a User ID, an Agent ID, a Company's issuer, or anything else about the User\"): A delegation with claims beyond iss, cnf, iat, exp and jti",
  "delegation.key-shared": "MUST (5.2: \"MUST use each delegated key, and its delegation, for one User ID only\"): A delegated key that signed for two User IDs",

  // ---- Accounts and sign-in in Sessions (4.5, 5.4) ----
  "session.second-account": "SHOULD (5.4: \"SHOULD start a new Session rather than use a second account in one Session\"): A Session used with a second account",
  "token.dpop-not-sent": "SHOULD (4.5: \"Personal Agents SHOULD support DPoP\", and one that does sends a proof when the metadata lists dpop_signing_alg_values_supported): A token request without a DPoP proof at an issuer that asks for one",

  // ---- Browser join (6) ----
  "browser-join.form": "Rule (6, step 3: the browser submits the form, whose one field is code): The join form not submitted as a form, or with other fields",
  "browser-join.code-reused": "MUST (6, step 1: \"each code works once\"; steps 2 and 3: not authorized or submitted before): A join code authorized or submitted twice",
  "browser-join.cookie": "MUST (6, step 3: the Company MUST check \"The request has the cookie from step 1\"): A join form submitted without the cookie set with its code",
  "browser-join.not-authorized": "MUST (6, step 3: the Company MUST check \"The code was authorized in step 2\"): A join form submitted before the agent authorized its code",
  "browser-join.authorize-body": "Rule (6, step 2: a JSON body with the code): An authorize request without the code as JSON",

  // ---- Operations extension, version 2 (Ops 6) ----
  "approval.header": "RFC (Ops 6: a Dictionary Structured Field, RFC 9651, with operation_id and revision as Strings): A malformed Poppy-Approval",
  "approval.idempotency-key-reused": "Rule (Ops 6: \"An Idempotency-Key sent with the first request doesn't carry over\"): The approved request reused the first request's Idempotency-Key",
  "approval.mcp-meta": "Rule (Ops 6: the approval as a JSON object in _meta under personalagentprotocol.org/approval): A malformed MCP approval",
  "approval.message": "Rule (Ops 6: the approval as a JSON object in the message's approval): A malformed approval in a message",

  // ---- Feedback (9.3) ----
  "feedback.fields": "MUST (9.3: task and description are required, at most 200 and 2,000 characters): A malformed feedback report",
  "feedback.kind": "Reading (9.3 has no kind; the changelog: \"kind removed from feedback\"): A feedback report that still carries kind",
  "feedback.excluded-task": "SHOULD NOT (9.3: \"SHOULD NOT report a task the Company lists as excluded\"): A report about an excluded task",
  "feedback.repeated": "SHOULD (9.3: \"one report for each task it couldn't do, not one for each attempt\"): A second report about the same task"
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
