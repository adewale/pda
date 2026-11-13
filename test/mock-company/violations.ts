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
 * `Mediated Sign-In n` for that extension, and a Guides heading by name.
 * A MUST, SHOULD, Rule or Guides basis quotes the sentence it rests on,
 * verbatim in every runtime pin and with its key word, or in the 1.0 pin
 * alone when its location starts `1.0`; `npm run check:spec` checks each
 * quote (scripts/check-requirements.mjs):
 *
 * - `MUST (5.2: …):` or `MUST NOT (…):` a MUST, MUST NOT or required field
 *   in the spec or one of its extensions.
 * - `RFC (RFC 9449 4.3; 4.5):` a requirement of a standard the spec builds
 *   on, such as DPoP, which the spec leaves to RFC 9449.
 * - `Rule (8.9: …):` the spec states it as how the protocol works, with no
 *   RFC 2119 keyword ("asks for a person at the Company with a request
 *   ID").
 * - `SHOULD (…):` or `SHOULD NOT (…):` a SHOULD in the spec.
 * - `Guides (heading: …):` only a recommendation in the Guides.
 * - `Reading (S2; 4.1):` our answer to an open question in
 *   docs/history/spec-issues.md, recorded in docs/readings.md.
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
  "client-assertion.jti-weak": "Guides (Signing and verifying JWTs: a jti of at least 128 random bits; 4.1 asks only that it be unguessable; \"Make the jti of each client assertion, delegation, Session JWT, and DPoP proof at least 128 random bits\"): Client assertion jti is not 128 random bits of base64url",
  "client-assertion.jti-reused": "MUST (4.1: a unique jti; the Company MAY reject a reused one, as RFC 7523 3 allows; \"MUST include iat and a unique, unguessable jti\"): Client assertion jti used twice",
  "dpop.jti-missing": "RFC (RFC 9449 4.2; 4.5): DPoP proof without a jti",
  "dpop.jti-weak": "Guides (Signing and verifying JWTs: at least 128 random bits; RFC 9449 4.2 asks for a negligible chance of reuse; \"Make the jti of each client assertion, delegation, Session JWT, and DPoP proof at least 128 random bits\"): DPoP proof jti is not 128 random bits of base64url",
  "dpop.jti-reused": "RFC (RFC 9449 4.2: a jti not used by any other proof; 11.1): DPoP proof jti used twice",

  // ---- Client assertions: private_key_jwt, addressed to the issuer (4.1) ----
  "client-assertion.alg": "Guides (Signing and verifying JWTs: sign client assertions with ES256, or PS384 when signing blindly; reject symmetric algorithms; \"Sign client assertions and delegations with ES256, or with PS384 if you sign them blindly\"): Client assertion alg isn't ES256 or PS384",
  "client-assertion.embedded-key": "Guides (Signing and verifying JWTs: verify only with keys from the verified jwks_uri; ignore jku, x5u and any embedded key; \"Ignore jku, x5u, and any other key embedded in a JWT\"): Client assertion embeds or points to a key (jku, x5u, jwk)",
  "client-assertion.typ": "Reading (S2; 4.1 names no typ), strict Company only: Client assertion header typ isn't \"JWT\"",
  "client-assertion.kid": "Reading (S2; Guides, Rotating keys: give every key a kid), strict Company only: Client assertion kid names no published key",
  "client-assertion.signature": "RFC (RFC 7523 3; 4.1: signed by a key from jwks_uri): Client assertion doesn't verify against the client's JWKS, or has expired",
  "client-assertion.iat-exp-missing": "MUST (4.1: \"MUST include iat\"; RFC 7523 3 requires exp): Client assertion without iat or exp",
  "client-assertion.lifetime": "Reading (S2: strict 60 s; 4.1: \"MUST make them short-lived\", and the Guides' five minutes is the lenient 300 s): Client assertion lifetime is too long",
  "client-assertion.missing": "Rule (4.1, 4.2, 4.3, 4.4, 4.6: each token, device authorization and revocation request carries the client assertion; \"The Personal Agent authenticates at the token endpoint with a client assertion signed by a key from jwks_uri\"): Token, device or revocation request without a client assertion",
  "client-assertion.not-jwt": "RFC (RFC 7523 3; 4.1): Client assertion is not a JWT",
  "client-assertion.wrong-typ": "RFC (RFC 8725 3.11, which 5.2 cites: explicit typing keeps a Session JWT, delegation or DPoP proof from being taken for another JWT): A DPoP proof, Session JWT or delegation used as the client assertion",
  "client-assertion.aud-array": "MUST (4.1: \"aud MUST be the Company's issuer, as a single string\"): Client assertion aud is an array",
  "client-assertion.aud": "MUST (4.1: aud MUST be the issuer; Companies MUST reject any other, including their token endpoint URL; \"The client assertion's aud MUST be the Company's issuer\"): Client assertion aud isn't this Company's issuer",
  "client-assertion.iss-sub": "RFC (RFC 7523 3, RFC 7521 5.2; 4.1: client assertions follow RFC 7523 3): Client assertion iss and sub aren't both the client_id",

  // ---- User IDs (5.1) ----
  "user-id.personal": "MUST NOT (5.1: \"MUST NOT contain or be derived from personal information\"): User ID contains personal information",

  // ---- The client metadata document and JWKS (4.1, 5.3) ----
  "client-metadata.not-url": "MUST (4.1: \"client_id MUST be an HTTPS URL\"): client_id is not a URL",
  "client-metadata.not-https": "MUST (4.1: \"client_id MUST be an HTTPS URL\"): client_id is not an https URL",
  "client-metadata.fetch-status": "MUST (4.1: an HTTPS URL that returns its metadata document; 5.3, step 1: fetched without following redirects, as the CIMD draft requires; \"client_id MUST be an HTTPS URL that returns its metadata document\"): Fetching client_id didn't return 200 (redirects aren't followed)",
  "client-metadata.not-json": "MUST (4.1: the URL returns its metadata document; \"client_id MUST be an HTTPS URL that returns its metadata document\"): Client metadata is not JSON",
  "client-metadata.client-id-mismatch": "MUST (4.1: \"client_id MUST equal the URL the document was fetched from\"): client_id in the document isn't the URL it was fetched from",
  "client-metadata.jwks-uri": "MUST (4.1: jwks_uri MUST be HTTPS on the same domain as client_id, read as the same host; \"jwks_uri MUST be an HTTPS URL on the same domain as client_id\"): jwks_uri isn't https on the client_id domain",
  "client-metadata.redirect-uris": "MUST (4.1: each redirect_uri HTTPS on the same domain as client_id, read as the same host, or a loopback redirect URI; \"Each entry MUST be an HTTPS URL on the same domain as client_id, or a loopback redirect URI\"): A redirect_uri isn't https on the client_id domain or loopback",
  "client-metadata.auth-method": "Rule (4.1: the Personal Agent authenticates with private_key_jwt; \"The Personal Agent authenticates at the token endpoint with a client assertion signed by a key from jwks_uri (private_key_jwt, RFC 7523)\"): token_endpoint_auth_method isn't private_key_jwt",
  "client-metadata.jwks-status": "Rule (4.1: jwks_uri holds the keys; 5.3, step 1 fetches them; \"Fetches the client metadata from iss … and the public keys from its jwks_uri\"): jwks_uri didn't return 200",
  "client-metadata.jwks-empty": "Rule (4.1: the keys that sign client assertions and delegations; \"They sign client assertions, and the delegations that vouch for the keys that sign Session JWTs\"): The JWKS has no keys",
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
  "dpop.nonce-ignored": "Guides (The Session header: support nonces as RFC 9449 8 describes; which server a nonce is for is S23; \"support nonces as RFC 9449 §8 describes\"): DPoP proof without the nonce this key already used at this server",
  "dpop.key-mismatch": "RFC (RFC 9449 4.3, 7.1: the proof's key is the one the token is bound to; 4.5): DPoP proof key isn't the key the token is bound to",

  // ---- Access tokens at resources (4.5, 7) ----
  "resource.bearer-scheme": "Rule (4.5: the scheme the token response's token_type names; RFC 9449 7.1; \"A signed-in request carries an access token in the Authorization header, with the scheme the token response's token_type names\"): An access token sent with another scheme than its token_type",
  "resource.unverified-target": "MUST (RFC 9728 3.3, which 4.5 names: metadata whose resource isn't the identifier its URL was derived from \"MUST NOT be used\"): A token request for a resource that no protected resource metadata at its own derived URL names",
  "mcp.wrong-token": "MUST (7: \"MUST request a token with resource set to the MCP server's url\"; 4.5): MCP request with a token not issued for this MCP server",
  "mcp.accept": "RFC (MCP 2025-06-18 Streamable HTTP, which 7 names): MCP request doesn't Accept application/json and text/event-stream",
  // MCP 2025-06-18's lifecycle: initialize, then its session and version on every later request.
  "mcp.legacy-session": "RFC (MCP 2025-06-18 Streamable HTTP, which 7 names: \"MUST include it in the Mcp-Session-Id header on all of their subsequent HTTP requests\"): An MCP request after initialize without the server's Mcp-Session-Id",
  "mcp.legacy-version-header": "RFC (MCP 2025-06-18 Streamable HTTP, which 7 names: \"MUST include the MCP-Protocol-Version: <protocol-version> HTTP header on all subsequent requests\"): An MCP request in a session without the negotiated MCP-Protocol-Version",
  "mcp.legacy-initialized": "RFC (MCP 2025-06-18 Lifecycle, which 7 names: \"the client MUST send an initialized notification\"): An MCP request in a session before notifications/initialized",
  // MCP 2026-07-28: no session; the version and client metadata on every request, mirrored in headers.
  "mcp.modern-meta": "RFC (MCP 2026-07-28 Base Protocol, which 7 names: protocolVersion and clientCapabilities \"MUST be included on every request\"): A 2026-07-28 request without its _meta protocol fields",
  "mcp.modern-client-info": "SHOULD (MCP 2026-07-28 Base Protocol, which 7 names: \"Clients SHOULD include io.modelcontextprotocol/clientInfo on every request\"): A 2026-07-28 request without clientInfo",
  "mcp.modern-version-header": "RFC (MCP 2026-07-28 Streamable HTTP, which 7 names: every POST \"MUST include an MCP-Protocol-Version header\" that \"MUST match\" the _meta protocolVersion): A 2026-07-28 request whose MCP-Protocol-Version is missing or differs from its _meta",
  "mcp.modern-method-header": "RFC (MCP 2026-07-28 Streamable HTTP, which 7 names: Mcp-Method is required on all requests): A 2026-07-28 request whose Mcp-Method is missing or differs from its method",
  "mcp.modern-name-header": "RFC (MCP 2026-07-28 Streamable HTTP, which 7 names: Mcp-Name is required on tools/call): A 2026-07-28 tools/call whose Mcp-Name is missing or differs from its tool",
  "mcp.modern-param-header": "RFC (MCP 2026-07-28 Streamable HTTP, which 7 names: \"conforming clients MUST mirror the designated parameter values into HTTP headers\"): A 2026-07-28 tools/call whose Mcp-Param header is missing or differs from an x-mcp-header argument",
  "mcp.modern-session-id": "Rule (7: \"MCP 2026-07-28 uses per-request metadata instead of an initialization handshake or Mcp-Session-Id\"): A 2026-07-28 request with Mcp-Session-Id",

  // ---- Rate limits and secrets (5.6, 10.2; Mediated Sign-In 6; Guides) ----
  "rate-limit.retry-after-ignored": "MUST (5.6: \"MUST wait at least that long before sending the request again\"): Request sent again before its Retry-After elapsed",
  "rate-limit.shared-limit-ignored": "Guides (Rate limits: keep track of limits for each company and share them across your tasks and users; 5.6's MUST covers only the request sent again; \"keep track of limits for each company and share them across your tasks and users\"): A different request sent to the Company before an earlier Retry-After elapsed",
  "secret.password": "MUST NOT (Mediated Sign-In 6: \"MUST NOT send credentials anywhere other than the token_endpoint of the Company's issuer\"): A password sent anywhere but the token endpoint's body",
  "secret.one-time-code": "Guides (Handling secrets: keep one-time sign-in codes out of messages and URLs; Mediated Sign-In 4 sends the code to the token endpoint; \"Keep them out of logs, telemetry, error reports, model context, conversation messages, and URLs\"): A one-time code sent anywhere but the token endpoint's body",
  "secret.account-token": "Guides (Handling secrets: keep tokens out of messages, logs and URLs; 4.4 and 4.6 send a refresh token only to the token and revocation endpoints; \"Keep them out of logs, telemetry, error reports, model context, conversation messages, and URLs\"): A refresh token sent anywhere but the token and revocation bodies",
  "secret.token-in-url": "MUST NOT (5.6: \"MUST NOT send tokens or Session JWTs in a URL\"): A token sent in a URL",

  // ---- Token endpoint and refresh tokens (4.4, 4.6) ----
  "form.not-form": "RFC (RFC 6749 4.1.3, RFC 7009 2.1, RFC 8628 3.1): OAuth request body isn't application/x-www-form-urlencoded",
  "account-token.other-client": "RFC (RFC 6749 6: a refresh token is bound to the client it was issued to; 4.4): Refresh token used by a different client_id",
  "account-token.rotated-reused": "RFC (RFC 6749 6; 4.4: \"Refresh token rotation follows RFC 6749 §6\", which says the client MUST discard the old one): Refresh token used after the Company rotated it",

  // ---- Sign-in (4.2, 4.3, 4.7; Mediated Sign-In 3, 4) ----
  "signin.no-scope": "MUST (4.7: \"Each sign-in request MUST include scope\"): Sign-in request without scope",
  "authorize.redirect-uri": "MUST (4.2: \"redirect_uri MUST exactly match an entry\" in redirect_uris, but a loopback port): redirect_uri isn't exactly a registered redirect_uri",
  "authorize.no-state": "Guides (Direct and device sign-in: make state random and single-use, and record which company it belongs to; 4.2 relies on PKCE; \"Make state random and single-use\"): Authorization request without state",
  "authorize.no-pkce": "Rule (4.2: the authorization code grant with PKCE; Guides: S256; \"Direct Sign-In is the OAuth 2.0 authorization code grant with PKCE\"): Authorization request without PKCE S256",
  "authorize.secret-in-url": "MUST NOT (5.6 for tokens; Guides, Handling secrets, for assertions; \"Personal Agents MUST NOT send tokens or Session JWTs in a URL\"): A token or assertion in the authorization URL",
  "code.reused": "RFC (RFC 6749 4.1.2; 4.2): Authorization code exchanged twice",
  "code.redirect-uri": "RFC (RFC 6749 4.1.3; 4.2): redirect_uri at the token endpoint differs from the authorization request",
  "code.pkce": "RFC (RFC 7636 4.5, 4.6; 4.2): PKCE code_verifier doesn't match the code_challenge",
  "authorize.prompt-consent": "MUST (1.0 4.2: \"Unless the Personal Agent receives the redirect only on the device that opened the authorization URL, as below, the authorization request MUST include prompt=consent\"; read as a loopback redirect URI): A 1.x Direct Sign-In request without prompt=consent",
  "par.not-pushed": "MUST (1.0 4.2: with require_pushed_authorization_requests, \"The Personal Agent then MUST send the authorization request's parameters to the pushed_authorization_request_endpoint\"; RFC 9126 5 under 0.4): An authorization request sent in the URL to a Company that accepts only pushed ones",
  "par.extra-parameters": "MUST (1.0 4.2: with require_pushed_authorization_requests, \"The Personal Agent then MUST send the authorization request's parameters to the pushed_authorization_request_endpoint with its client assertion, and open the authorization_endpoint with only client_id and the request_uri it gets back\"): The authorization URL for a pushed request carries other parameters",
  "par.code-key": "RFC (RFC 9449 10.1; 1.0 4.2: a proof sent with the pushed request binds the code to its key): A code from a request pushed with a DPoP proof, exchanged with no proof or one from another key",
  "dpop.refresh-key-changed": "MUST (1.0 4.4: \"MUST send a proof from the same key with every refresh of that refresh token, and of the refresh tokens that replace it\"): A refresh with no DPoP proof, or one from another key than the refresh token was issued with",
  "device.polled-after-final": "Rule (4.3: polls until the User approves or declines, as RFC 8628 3.4 and 3.5 describe; \"polls the token_endpoint every interval seconds until the User approves or declines\"): Device polling continued after completion or access_denied",
  "device.polled-after-expiry": "Rule (4.3: polls until the request expires, as RFC 8628 3.5 describes; \"the Personal Agent polls the token_endpoint every interval seconds until the User approves or declines, or the request expires\"): Device polling continued after expired_token",
  "device.too-fast": "RFC (RFC 8628 3.5: add 5 seconds to the interval on slow_down; 4.3): Device polling faster than the interval after slow_down",
  "mediated.missing-field": "Rule (Mediated Sign-In 3: \"every field in fields as a parameter\"): Mediated Sign-In without a field the Company asked for",
  "mediated.credentials-with-code": "Rule (Mediated Sign-In 4: the code goes with sign_in_id, \"but not the credentials or scope\"): Credentials resent with the one-time code",
  "mediated.scope-with-code": "Rule (Mediated Sign-In 4: \"but not the credentials or scope\"; the sign-in keeps its first scopes): scope resent with the one-time code",
  "mediated.code-other-client": "Rule (Mediated Sign-In 4: \"Only the client_id that started a sign-in can finish it\"): A one-time code sent by another client",

  // ---- Writes and retries (Guides; Ops 7) ----
  "idempotency.key-reused": "Guides (Retries: reuse an Idempotency-Key only to retry the same request; companies reject a repeated key with a different body; \"reuse the same key when you retry the same request … reject a repeated key with a different body\"): Idempotency-Key reused with a different body",
  "idempotency.key-missing": "Guides (Retries: \"Send an Idempotency-Key … on API writes that accept one\"): An API write whose description takes an Idempotency-Key sent without one",
  "upload.boundary": "RFC (RFC 7578 4.1; RFC 2046 5.1.1): A multipart/form-data body without a boundary parameter",
  "upload.part-name": "RFC (RFC 7578 4.2): A multipart/form-data part without a Content-Disposition of form-data with a name",
  "exchange.performed-twice": "Guides (Retries: reuse the Idempotency-Key when retrying; Ops 7: at most once; \"reuse the same key when you retry the same request\"): The same exchange made twice (a write retried without its key, or approved again as a new operation)",

  // ---- Conversations (8) ----
  "message.missing": "Rule (8.3: a request carries its message; \"A new conversation starts with its first message, except when accepting a user_requested event without a message\"): Conversation request without a message",
  "message.empty": "MUST (8.4: \"MUST have at least one of text, data, context, or extensions\"): Message has none of text, data, context or extensions",
  "message.extension-unlisted": "MUST NOT (8.4: \"A side MUST NOT send an extension's content unless the other side uses that extension with the same version\"): Extension content for an extension the Company doesn't list",
  "message.text-type": "Rule (8.4: text is the message in natural language; \"text | No | The message in natural language.\"): Message text isn't a string",
  "message.json-in-text": "Guides (Conversations: put structured details in data, not JSON or other markup in text; 8.4 says the same without a keyword; \"Put structured details in data, not JSON or other markup in text\"): JSON in a message's text",
  "message.data-type": "Rule (8.4: data is a JSON object; \"A JSON object for structured details that would need markup, like a list or a table, to fit in a sentence.\"): Message data isn't a JSON object",
  "message.context-type": "Rule (8.4: context holds facts about the User's situation, as fields; \"context holds facts about the User's situation that affect how the Company replies\"): Message context isn't an object",
  "request.id": "MUST (8.3: \"Every POST body has an id, chosen by the Personal Agent, which MUST make it unique for the User across all its requests\"; 8.2: 1 to 256 URL-safe base64 characters): A conversation request without a valid request id",
  "message.as-of-human": "MUST NOT (8.4: a message \"with author.type human, MUST NOT include either field\"): as_of_cursor on a message the User wrote",
  "message.as-of-cursor": "Rule (8.4: as_of_cursor is \"the cursor of the last read it had handled\"): as_of_cursor that isn't a cursor of the conversation",
  "request.id-reused": "MUST (8.3: the Personal Agent \"MUST make it unique for the User across all its requests\"; a retry repeats the path and body): A request id reused with a different path or body",
  "context.locale": "MUST (8.4: \"it MUST use the field and format defined here\", an RFC 5646 tag): context.locale isn't an RFC 5646 tag",
  "context.time-zone": "MUST (8.4: the field and format defined here, an IANA time zone name; \"When a Personal Agent shares one of these facts, it MUST use the field and format defined here\"): context.time_zone isn't an IANA name",
  "context.user-available": "MUST (8.4: the field and format defined here, true or false; \"When a Personal Agent shares one of these facts, it MUST use the field and format defined here\"): context.user_available isn't a boolean",
  "direct.agent-words": "Reading (S12; 8.10: the User's messages, as written, with author.type human): Direct Conversation opened with words not marked as the User's",
  "direct.agent-words-later": "Reading (S12; 8.10): The agent's own words sent into an open Direct Conversation",
  "conversation.cross-user": "Rule (8.2: a conversation belongs to the client_id and User ID that started it; 8.13; S17; \"A conversation belongs to the Personal Agent's client_id and the User ID that started it\"): A conversation of one User reached by another User of the same agent",
  "handoff.body": "Rule (8.9: \"The Personal Agent asks for a person at the Company with a request ID\"): A handoff or cancel body with more than its request id",
  "close.body": "Rule (8.12: \"The Personal Agent closes a conversation it's done with by sending a request ID to its close URL\"): A close body with more than its request id",
  "message.author": "MUST (8.4: author is required, with type agent or human, and only Company messages have id, name or image; 8.8; \"the Personal Agent MUST set each message's author.type: agent when the Personal Agent wrote it, and human only when it carries the User's own words\"): A message without a valid author",
  "message.sender-field": "Reading (8.4 has author where 0.2 had sender; docs/readings.md): A message that still carries sender",

  // ---- The Session header (5.2, 5.3) ----
  "version.missing": "Rule (3.4: \"On every request with the Session header (5.2), the Personal Agent sends the protocol version it implements, compatible with the chosen one, in Poppy-Version\"): A Session request without Poppy-Version",
  "version.unlisted": "MUST (3.4: the Personal Agent \"chooses the newest version, among protocol_version and the versions in supported_versions\", and \"If none is, it MUST NOT use any of them\"): Poppy-Version naming a version the Company never listed",
  "version.changed-in-session": "MUST (3.4: \"MUST send the same values on every request in a Session, and starts a new Session to change them\"): A Session whose Poppy-Version or Poppy-Extensions changed",
  "session-jwt.missing": "MUST (5.2: \"MUST send a Poppy-Session header on every request\" to APIs, conversations and protocol endpoints): A request to a resource without the Session header",
  "session-jwt.missing-with-token": "MUST (5.2; 5.3: the Company MUST reject an access token without the Session header; \"The Personal Agent MUST send a Poppy-Session header on every request to a Company's APIs, conversations, and other resource endpoints this protocol or an extension defines\"): An access token sent without the Session header",
  "session-jwt.not-jwt": "Rule (5.2: the header holds a JWT; \"The header holds a JWT that the Personal Agent signs for that one request\"): The Session header isn't a JWT",
  "session-jwt.typ": "MUST (5.2: \"typ MUST be poppy-session+jwt\"): A Session JWT of another typ",
  "session-jwt.alg": "MUST (5.2: \"alg MUST be ES256\"): A Session JWT not signed with ES256",
  "operator-signature.invalid": "RFC (RFC 9421 3.2; Web Bot Auth 5.2; 5.3): An operator signature that is malformed, outside its validity, not in the operator's directory, or doesn't verify",
  "operator-signature.components": "MUST (5.3: \"The Personal Agent's operator signature MUST cover poppy-session, and authorization when present\"): An operator signature that leaves out the Session header or the access token",
  "session-jwt.no-delegation": "MUST (5.2 Delegated keys: the Company MUST reject a Session JWT without a delegation; \"the Company MUST reject, with invalid_session, a Session JWT without a delegation\"): A Session JWT without poppy_dlg",
  "session-jwt.iss": "MUST (5.2: \"MUST include every claim except agent_id\", and ath without a token): A Session JWT without iss",
  "session-jwt.kid": "MUST (5.2 Delegated keys, step 3: kid is the delegated key's RFC 7638 thumbprint; 5.3: the Company MUST complete these checks; \"The Company MUST complete the following checks before relying on Session claims\"): A Session JWT whose kid isn't its key's thumbprint",
  "session-jwt.signature": "MUST (5.2 Delegated keys, step 3: verified with the key in cnf.jwk; 5.3; \"The Company MUST complete the following checks before relying on Session claims\"): A Session JWT that doesn't verify with the delegated key",
  "session-jwt.iat": "MUST (5.2: iat is required; 5.3: within the Company's acceptance window; \"The Personal Agent MUST include every claim except agent_id\"): A Session JWT without iat, or outside the acceptance window",
  "session-jwt.after-delegation": "MUST NOT (5.2 Delegated keys: \"MUST NOT sign a Session JWT after its delegation's exp\"): A Session JWT signed after its delegation expired",
  "session-jwt.aud": "MUST (5.2: aud is the issuer as a single string; 5.3: compared character for character; \"The Company MUST complete the following checks before relying on Session claims\"): A Session JWT for another audience",
  "session-jwt.htm": "MUST (5.2, 5.3: htm matches the request as RFC 9449 4.3 describes; \"The Company MUST complete the following checks before relying on Session claims\"): A Session JWT whose htm isn't the request's method",
  "session-jwt.htu": "MUST (5.2, 5.3: htu is the URL without query or fragment, as RFC 9449 4.3 describes; \"The Company MUST complete the following checks before relying on Session claims\"): A Session JWT whose htu isn't the request's URL without its query",
  "session-jwt.sid": "MUST (5.2: sid is required, with the characters of Conversation IDs; \"The Personal Agent MUST include every claim except agent_id\"): A Session JWT without a valid sid",
  "session-jwt.sub": "MUST (5.2: sub is the User ID and required; agent_id a string when present; \"The Personal Agent MUST include every claim except agent_id\"): A Session JWT without sub, or with a malformed agent_id",
  "session-jwt.ath": "MUST (5.2: ath is the access token's hash; 5.3, step 3; \"The Company MUST complete the following checks before relying on Session claims\"): A Session JWT whose ath doesn't match the access token",
  "session-jwt.oauth-endpoint": "Rule (5.2: \"Discovery and description documents and OAuth endpoints don't carry this header\"): A Poppy-Session header sent to the token, device or revocation endpoint",
  "session-jwt.ath-without-token": "MUST (5.3, step 3: \"Without an access token, ath MUST be absent\"): A Session JWT with ath and no access token",
  "session-jwt.sub-changed": "MUST (5.2: sid \"MUST NOT use it for any other Session\"; \"It MUST send the same sub and agent_id, or no agent_id, in every Session JWT for a Session\"): A Session's sid sent with another User ID or Agent ID",
  "session-jwt.token-other-client": "MUST (5.3, step 3: the token was issued to the same client_id as iss; \"The Company MUST complete the following checks before relying on Session claims\"): An access token sent by another client",
  "session-jwt.jti-missing": "MUST (5.2: \"MUST include every claim except agent_id\"): A Session JWT without a jti",
  "session-jwt.jti-weak": "Guides (Signing and verifying JWTs: a jti of at least 128 random bits; 5.2 asks only that it be unguessable; \"Make the jti of each client assertion, delegation, Session JWT, and DPoP proof at least 128 random bits\"): A Session JWT jti that isn't 128 random bits of base64url",
  "session-jwt.jti-reused": "Rule (5.2: \"jti is unique and unguessable\"; 5.3: a Company MAY reject a reused jti): A Session JWT jti used twice",

  // ---- Delegations (5.2 Delegated keys) ----
  "delegation.not-jwt": "MUST (5.2 Delegated keys: poppy_dlg is the delegation in compact form, and the Company MUST reject one that fails its checks; \"the Company MUST reject, with invalid_session, … a Session JWT whose delegation fails any of these checks\"): poppy_dlg isn't a JWT",
  "delegation.typ": "MUST (5.2 Delegated keys: \"typ MUST be poppy-delegation+jwt\"): A delegation of another typ",
  "delegation.alg": "Rule (5.2 Delegated keys: \"alg is ES256 or PS384\"): A delegation signed with another algorithm",
  "delegation.kid": "MUST (5.2 Delegated keys, step 1: kid names the key in jwks_uri; the Company MUST reject a delegation that fails a check; \"the Company MUST reject, with invalid_session, … a Session JWT whose delegation fails any of these checks\"): A delegation whose kid names no published key",
  "delegation.signature": "MUST (5.2 Delegated keys, step 1; \"the Company MUST reject, with invalid_session, … a Session JWT whose delegation fails any of these checks\"): A delegation that doesn't verify with the key its kid names",
  "delegation.iss": "MUST (5.2 Delegated keys, step 2: its iss is the token's iss; \"the Company MUST reject, with invalid_session, … a Session JWT whose delegation fails any of these checks\"): A delegation from another client",
  "delegation.lifetime": "MUST (5.2 Delegated keys: \"exp MUST be at most 24 hours after iat\"; step 2): A delegation without iat and exp, or longer than a day",
  "delegation.expired": "MUST (5.2 Delegated keys, step 2: it hasn't expired; \"the Company MUST reject, with invalid_session, … a Session JWT whose delegation fails any of these checks\"): A Session JWT carrying an expired delegation",
  "delegation.jti": "Rule (5.2 Delegated keys: \"jti is a unique, unguessable ID\"; Guides: 128 random bits): A delegation without a jti of 128 random bits",
  "delegation.cnf": "MUST (5.2 Delegated keys, step 3: the Session JWT is verified with the key in cnf.jwk; \"the Company MUST reject, with invalid_session, … a Session JWT whose delegation fails any of these checks\"): A delegation without cnf.jwk",
  "delegation.private-key": "MUST NOT (5.2 Delegated keys: \"It MUST NOT contain private key members\"): A delegation that carries a private key",
  "delegation.names-user": "MUST NOT (5.2 Delegated keys: \"MUST NOT put a User ID, an Agent ID, a Company's issuer, or anything else about the User\"): A delegation with claims beyond iss, cnf, iat, exp and jti",
  "delegation.key-shared": "MUST (5.2: \"MUST use each delegated key, and its delegation, for one User ID only\"): A delegated key that signed for two User IDs",

  // ---- Accounts and sign-in in Sessions (4.5, 5.4) ----
  "session.second-account": "SHOULD (5.4: \"SHOULD start a new Session rather than use a second account in one Session\"): A Session used with a second account",
  "token.dpop-not-sent": "SHOULD (4.5: \"Personal Agents SHOULD support DPoP\", and one that does sends a proof when the metadata lists dpop_signing_alg_values_supported): A token request without a DPoP proof at an issuer that asks for one",

  // ---- Browser join (6) ----
  "browser-join.form": "Rule (6, step 3: the browser submits the form, whose one field is code; \"The Personal Agent has its browser submit the form\"): The join form not submitted as a form, or with other fields",
  "browser-join.code-reused": "MUST (6, step 1: \"The Company MUST make the code unguessable and short-lived, and each code works once\"; steps 2 and 3: not authorized or submitted before): A join code authorized or submitted twice",
  "browser-join.cookie": "MUST (6, step 3: \"The Company MUST check that:\" \"The request has the cookie from step 1, and it matches code\"): A join form submitted without the cookie set with its code",
  "browser-join.not-authorized": "MUST (6, step 3: \"The Company MUST check that:\" \"The code was authorized in step 2\"): A join form submitted before the agent authorized its code",
  "browser-join.authorize-body": "Rule (6, step 2: a JSON body with the code; \"The Personal Agent reads the code from the page in its browser and sends it to {browser_session_endpoint}/authorize\"): An authorize request without the code as JSON",
  "page.session-off-host": "Rule (5.2: the header \"covers only HTTPS URLs whose host is exactly organization.domain\", and a redirect is signed again \"only if its host is still organization.domain\"): A Session header on a page on another host",
  "page.token": "MUST NOT (5.2: \"MUST NOT send an access token with these requests\"): An access token with a website page",
  "browser-sign-in.no-endpoint": "Rule (6: \"A Personal Agent requests poppy:browser-sign-in only from a Company that lists browser_session_endpoint\"): A sign-in asking for poppy:browser-sign-in from a Company without browser join",
  "web.disabled-form": "SHOULD NOT (6: \"SHOULD NOT use a browser on the website of a Company that sets\" web.disabled; docs/readings.md#v04-web-disabled counts a form as a browser's work): A form sent to a website that sets web.disabled",
  "browser-control.marked-step": "SHOULD NOT (Browser Control 5: a Personal Agent that declares the extension \"SHOULD NOT take a marked step\"): A marked form submitted while the page read a controller other than \"user\"",

  // ---- Operations extension, version 3 (Ops 6) ----
  "approval.header": "RFC (Ops 6: a Dictionary Structured Field, RFC 9651, with operation_id and revision as Strings): A malformed Poppy-Approval",
  "approval.idempotency-key-reused": "Rule (Ops 6: an Idempotency-Key \"sent with the first request doesn't carry over: the request with the approval has its own, or none\"): The approved request reused the first request's Idempotency-Key",
  "approval.mcp-meta": "Rule (Ops 6: the approval as a JSON object in _meta under personalagentprotocol.org/approval; \"The Personal Agent calls the same tool again, with the same arguments, and the approval as a JSON object in _meta under personalagentprotocol.org/approval\"): A malformed MCP approval",
  "approval.message": "Rule (Ops 6: the approval as a JSON object in the message's approval; \"The Personal Agent sends a message with the approval as a JSON object in extensions.operations.approval\"): A malformed approval in a message",
  "approval.approver": "MUST (Ops 6: \"The Personal Agent MUST include approver\", user or agent): An Operations 3 approval without a valid approver",
  "approval.approved-at": "Rule (Ops 6: \"approved_at, in Unix seconds\", an Integer in Poppy-Approval): approved_at that isn't an Integer",
  "approval.input-type-with-agent": "MUST NOT (Ops 6: \"The Personal Agent MUST NOT include it with agent\"): input_type in an agent approval",
  "approval.input-type": "Rule (Ops 6: input_type \"as a short string\"): input_type that isn't a String",
  "approval.reference": "Rule (Ops 6: reference \"has the same characters as the IDs in spec 8.2\"): A malformed reference",
  "approval.reference-reused": "Rule (Ops 6: reference \"is unique among the User's approvals at least\"): One reference sent for two approvals",
  "approval.declined-resent": "MUST NOT (Ops 6: \"the Personal Agent MUST NOT send that approval again\"): A declined approval sent again",
  "approval.agent-after-decline": "MUST NOT (Ops 6: it \"MUST NOT approve a new revision for the same action without asking the User\"): An agent approval after a decline",
  "web-operation.unknown-ref": "MUST (Ops 4: \"MUST take a reference only from the Poppy-Operation header of a response that its own browser received\"): A reference at endpoint that the website never returned",
  "web-operation.approval-in-browser": "Rule (Ops 6: \"The approval never passes through the browser\"): A browser request to the website carrying Poppy-Approval",
  "web-operation.approved-elsewhere": "Rule (Ops 6: \"an operation returned on a website is approved only at endpoint\"): An approval of a website's operation sent to an API, MCP server or conversation",
  "approval.agent-after-revision": "MUST NOT (Ops 5: \"the Personal Agent MUST NOT approve the new one on the same instruction\"): An agent approval of a revision that answered an agent approval",

  // ---- Feedback (9.3) ----
  "skills.credentials": "Rule (9.4: listing an artifact on another domain \"does not make that domain an API endpoint or authorize sending it credentials or Session headers\"): A skill artifact fetched with a token or Session header",
  "tasks.token": "Rule (9: \"the request carries no access token, even in a signed-in Session\"): GET {tasks.endpoint} with an access token",
  "feedback.fields": "Rule (9.3: task and description are required, at most 200 and 2,000 characters; \"invalid_request (400) for a report that is malformed or too long\"): A malformed feedback report",
  "feedback.kind": "Reading (9.3 has no kind; the changelog: \"kind removed from feedback\"): A feedback report that still carries kind",
  "feedback.excluded-task": "SHOULD NOT (9.3: \"SHOULD NOT report a task the Company lists as excluded\"): A report about an excluded task",
  "feedback.repeated": "SHOULD (9.3: \"A Personal Agent SHOULD send one report for each task it couldn't do, not one for each attempt\"): A second report about the same task"
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
