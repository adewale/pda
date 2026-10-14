# Issues found in Poppy implementations and the specification

This file lists what we found by reading other implementations of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) Draft 0.1 (updated 9 October 2026), and the gaps in the specification that their differences expose. It also lists what the comparison found in our own client.

- **Date.** Everything here was checked on 11 October 2026, two days after the draft was published, when every implementation was days old. The notes on Datalayer 0.10.0 are from 12 October; the Tipping Co section, and the rows marked 13 Oct, from the pin moves and full grid of 13 October.
- **Method.** We read the code and compared it with the text of the specification, the Guides and the Operations extension. Later the same day we ran seven of the projects against each other in our [interop grid](interop-spec.md) ([summary of the results](interop-results/README.md)); rows marked "Grid:" come from those runs. Live documents were fetched from public URLs. File and line references are to each repository's default branch on that date.
- **Severity** is how much an issue matters to interoperability or security, not a judgement of the project. Many of these are demos, and several were built in a day.

The implementations themselves are surveyed in [implementations.md](implementations.md).

## Contents

- [The specification](spec-issues.md)
- [poppy-demo](#poppy-demo-irvinebroquepoppy-demo)
- [Datalayer SDK](#datalayer-sdk-datalayerpersonal-agent-protocol)
- [poppyseed](#poppyseed-akshay5995poppyseed)
- [adonis-agora authkit and agent](#adonis-agora-authkit-and-agent-davidecarvalho)
- [everruns](#everruns-everrunseverruns)
- [Ilmer.org](#ilmerorg-rbirkbyilmerorg)
- [pi-poppy](#pi-poppy-richardanayapi-poppy)
- [print-with-poppy](#print-with-poppy-spenciefyprint-with-poppy)
- [Tipping Co](#tipping-co-timothyoharepersonal-agent-protocol)
- [Alpine Retail](#alpine-retail-wwwalpine-retailcom)
- [This project](#this-project)

## The specification

The spec problems, including those the differences below expose, are in [spec-issues.md](spec-issues.md), by area, with suggested fixes. The S-numbers cited below refer to it.

## poppy-demo (irvinebroque/poppy-demo)

A two-Worker demo: a Company ("Northstar") and a Personal Agent, wired to each other. Commit `02a9b30`, 9 October 2026. Its Company is careful; its Personal Agent has recovery gaps.

| Issue | Where | Section | Severity |
| --- | --- | --- | --- |
| Personal Agent never handles `invalid_session`. Company Sessions end 24 h after creation, so after a day every visitor is stuck until the 30-day cookie expires. | `workers/caller/src/session.ts:141-146,177`; `workers/receiver/src/state.ts:123,129` | 4.2 | High |
| `invalid_grant` on the Account Token isn't handled; the token is never dropped. | `session.ts:143` | 4.8, 4.9 | Medium |
| A retried message is answered from the idempotency store before the account check, so after sign-out a replay returns the original response, including account data if `wait` was used. | `state.ts:154` before `:157`/`:160` | 7.11, 7.2 | Medium |
| 401 `invalid_token` isn't retried with a renewed token; only local expiry triggers renewal. | `session.ts:147-156` | 6 | Low |
| `has_more` is never followed. | `session.ts:158-163,207-211` | 7.5 | Low |
| `jti` values are `crypto.randomUUID()`: 122 random bits, under the 128 the Guides ask for. | `shared/protocol.ts:7,21` | 4.2, Guides | Low |
| Every message carries hard-coded context (`America/Chicago`, `user_available: true`). | `session.ts:203` | 7.4 | Low |
| Discovery crashes if `apis` or `agent` is absent, and documents are never re-fetched despite `max-age=300`. | `session.ts:173-174` | 3, 3.1 | Low |
| Model messages can be sent into a Direct Conversation as `agent`, which its own Company rejects. | `session.ts:162,200-203` | 7.8, 7.10 | Low |
| Ended Sessions get 400 `invalid_session` at APIs, with no `WWW-Authenticate`. | `state.ts:54,68` | 6, 7.13 | Low |
| Sign-in request errors show JSON in the User's browser instead of redirecting with `error` and `iss`. | `workers/receiver/src/index.ts:83-84` | RFC 6749 §4.1.2.1 | Low |
| An empty events read returns `cursor: ""`. | `state.ts:87` | 7.5 | Low |
| Only ES256; `htu` is checked against `request.url` rather than a configured origin; metadata fetches follow redirects. | `shared/protocol.ts:69,80,82`; `index.ts:13,19` | Guides | Low |
| The consent page shows only `client_name`: no `client_id` domain, logo or duration. | `ui.ts:24` | 4.5, Guides | Low |
| By design, the Company accepts only its sibling agent's `client_id`, so other agents get `invalid_client`. | `index.ts:8,12-13,16,19` | 4.1 (allowed) | Note |
| Grid: the agent requires the issuer to equal the Company's origin, so it fails every scenario at a Company whose issuer is on another host or has a path (our mock, adonis-agora). The draft's own examples put the issuer on another host (3, 3.2). | caller | 3.2 | High |
| Grid: the agent parses the revocation response as JSON. RFC 7009 allows an empty 200, so sign-out throws at poppyseed. | caller | 4.9, RFC 7009 | Medium |
| Grid: the agent throws (`new URL(undefined)`) at a signed-out Company with no `authorization_endpoint`, such as Ilmer. | caller | 3.1 | Medium |
| Grid: the agent always asks for the hard-coded `poppy:read poppy:write`, whatever `auth.direct.scopes` offers, so it can't sign in at a Company with its own scopes (Datalayer's Manzanita offers `orders:read` and `orders:write` and answers `invalid_scope`). | `shared/protocol.ts:5`; `workers/caller/src/session.ts:190` | 4.4, 4.5 | Medium |
| Grid: Northstar answers 500 instead of `invalid_client` for client metadata that isn't JSON, and instead of `invalid_token` for a well-formed token naming no Session. | receiver | 4.1, 6 | Low |
| Grid: agent keys keep `kid: agent-key-1` when rotated, so a Company that caches by `kid` uses a stale key; the Guides say "Give every key a `kid`". | caller | Guides | Low |

Its live documents pass our validator with no errors or warnings, and are fixtures in `test/validator.test.ts`.

## Datalayer SDK (datalayer/personal-agent-protocol)

The most complete SDK: Python and TypeScript, both sides, reference Companies, a requirements ledger and 124 shared conformance cases.

| Issue | Where | Section | Severity |
| --- | --- | --- | --- |
| The TypeScript Company keeps a Session signed in when it's renewed with an assertion. (The Python Company is correct.) | `src/company/service.ts:517-521` | 4.2 | High |
| An Account Token request without `session_id` is refused with `invalid_session`; the draft says it starts a new signed-in Session. Grid: adonis-agora's agent recovers from an ended Session exactly this way, so its `SE` fails at both Datalayer Companies (and passes at the others). | `service.ts:542-549`; `service.py:504-509` | 4.8 | Medium |
| Mediated Sign-In silently drops unknown or missing scopes instead of returning `invalid_scope`. | `service.ts:983`; `service.py:900` | 4.4 | Medium |
| The client strips a trailing `/` from the issuer before comparing, and uses that value for the `iss` check. | `models.ts:393,506`; `discovery.ts:154` | 3.2, 4.5 | Medium |
| DPoP `jti` replay gap: `iat` up to +60 s is accepted, but `jti` is remembered only until now + 60 s. | `crypto.ts:229-254` | 4.3 | Medium |
| No `WWW-Authenticate` on 400 `invalid_dpop_proof`. | `service.ts:212` | 4.3 | Low |
| SSE ignores `?cursor`. | `service.ts:1160` | 7.6 | Low |
| Handoff with no one available adds no message. | | 7.9 | Low |
| Grid: the TypeScript `ConversationClient.stream` reconnects at once, ignoring `retry:`, and throws `stream_unavailable` after five reconnects that bring nothing, so resuming a stream fails at any Company that closes idle streams. | TS `ConversationClient.stream` | 7.6 | Medium |
| Grid: Device Sign-In polling never retries on `use_dpop_nonce`, in both SDKs. | `DeviceSignInClient.poll` | 4.3, Guides | Medium |
| Grid: the Python Company checks DPoP `htu` against the decoded path, not the raw one, so a percent-encoded path gets `invalid_dpop_proof`. | Python ASGI layer | 4.3, RFC 9449 | Medium |
| Grid: the client checks a callback's `error` before its `state`. | client | 4.5, RFC 6749 §10.12 | Low |
| Grid: both Companies close an SSE stream after sending the backlog, and answer an ended Session with `invalid_token`, never `invalid_session` ([N39](spec-issues.md#n39)). | Company | 7.6, 4.2 | Low |
| Grid: optional Operation members are sent as `null` (`expires_at`, `result.data`) rather than omitted ([N41](spec-issues.md#n41)). At 0.10.0 a confirmed operation omits `expires_at`; a cancelled one's `result.data` is still `null`. | Company | Ops | Low |
| Grid: Manzanita's OpenAPI paths use templates with no declared `parameters`. | reference Company | OpenAPI 3 | Low |
| Grid (H, DC): both clients refuse the answer to a handoff or a close as `invalid_response` unless it carries `conversation_id`; the draft has the Company return only "`status` and `responder`" (7.9, 7.12), as our mocks do. Datalayer's own Companies add `conversation_id`, so the clients pass there. | TS `parseConversationResponse` (`src/conversations.ts:650-663`); Py `ConversationReceipt` (`conversations.py:29-33`) | 7.9, 7.12 | Low |
| Grid: an API's 403 `insufficient_scope` (and `sign_in_required`) from `ApiResults` carries the error in the body only, with no `WWW-Authenticate` challenge, though the Company's own `jsonError` adds one (RFC 6750 §3, RFC 9449). A client that reads the challenge, such as adonis-agora's `callOpenApi`, sees a plain 403. | `src/company/points.ts:183-188`; `company/points.py:230-231` | 6 | Low |

**Worth copying:** `protocol/requirements.yaml` maps 160 requirements to code and tests, with a test that the references exist. Its blind spot: it only holds sentences with RFC 2119 keywords, and three of the bugs above sit in sentences without one.

## poppyseed (akshay5995/poppyseed)

A Company library for Next.js with a conformance suite, live at withpoppyseed.dev.

| Issue | Where | Section | Severity |
| --- | --- | --- | --- |
| `redirect_uris` are checked for the same host, not for HTTPS, and the authorization code is then sent there. | `packages/core/src/clients.ts:210-217` | 4.1 | High |
| withpoppyseed.dev 308-redirects every path from the apex to `www.`, including `POST /oauth/token`, while `auth.issuer` and every endpoint name the apex. Discovery works; every token request fails for a client that, correctly, never follows redirects with credentials. Its demo agent's `client_id` redirects too, so no Company can load it. | Deployment | 3, Guides | High (deployment) |
| Direct Sign-In always requires `session_id` and `private_key_jwt`, so a plain MCP client can't use MCP's own flow. | `oauth.ts:130` | 6 | Medium |
| Any `resource` parameter is treated as an MCP Bearer request. | `oauth.ts:77-83` | 4.3 | Low (possible) |
| Grid: `wait` is honoured only on `GET …/events`, not on sending a message ([N40](spec-issues.md#n40)). | | 7.3 | Low |
| Grid: withpoppyseed.dev still redirected the apex to `www.` at the end of 11 October. | Deployment | 3 | (see above) |

**Worth copying:** 124 mutants that each break one rule, with the named check required to fail; a CI check that the spec text hasn't changed upstream.

## adonis-agora authkit and agent (DavideCarvalho)

A Company OAuth server (`@adonis-agora/authkit-server`), and Company conversations plus a Personal Agent library (`@adonis-agora/agent`), for AdonisJS.

| Issue | Where | Section | Severity |
| --- | --- | --- | --- |
| Tokens and assertions are accepted from the query string: grants are read with `ctx.request.all()`, which merges the query into the body. | authkit `host/controllers/poppy_controller.ts:34-36` | 4.3 ("MUST NOT accept them from one") | High |
| Renewing a signed-in Session with an assertion silently returns `signed_in: false`. | authkit `service.ts:700` | 4.2 | Medium |
| Mediated credentials can be posted again after an automatic 401 renewal, possibly into a different Session. | agent `signin.ts:230` with `company.ts:324-337` | 4.7 | Medium |
| Handoff without hooks never reaches `queued`. | agent `conversations.ts:755` | 7.9 | Low |
| The client restarts silently on `cursor_expired`; the draft says the agent SHOULD tell the User. | agent `collect()` | 7.5 | Low |
| Grid: the agent's assertions carry no `typ`, so strict Companies refuse every request ([S2](spec-issues.md#s2)). | agent `poppy-client` | 4.2 | Medium |
| Grid: the agent's assertion `aud` is the token endpoint at the device and revocation endpoints too, which poppyseed and pi-poppy's Company refuse, as both Datalayer Companies did until 0.10.0 ([S1](spec-issues.md#s1)). | agent `poppy-client` | 4.6, 4.9 | Medium |
| Grid: the Company sends no headers on an idle resumed SSE stream until an event arrives ([N30](spec-issues.md#n30)). | agent (Company conversations) | 7.6 | Low |
| Grid: `allowInsecureClientIds`, needed to test against private addresses, also accepts `http` `client_id`s ([N42](spec-issues.md#n42)). | authkit | 4.1 | Low |

## everruns (everruns/everruns)

Rust, both sides, signed-out only (PRs #4479, #4531, #4549, #4558; the client moved to `crates/capabilities/src/capabilities/poppy_client/` in #4577). Line numbers are at `b09c922` unless they say otherwise; the grid runs `f470ad7` (12 October), where the agent rows below still hold (`protocol.rs` lines 298 and 416 to 424 there).

| Issue | Where | Section | Severity |
| --- | --- | --- | --- |
| A nonce retry reuses the Session assertion, signed once outside the retry loop. Companies reject the repeated `jti`. | `domains/poppy_agent/protocol.rs:395-401` | Guides (Retries) | High |
| Metadata URL uses the append form rather than RFC 8414 insertion. | `protocol.rs:274` | 3.2 | Medium |
| The Company builds the issuer, endpoints and `htu` from the `Host` and `X-Forwarded-Proto` headers. | `channels/poppy/mod.rs:199-229` | Guides | Medium |
| The client assertion's `sub` isn't checked against `client_id`. | Company | RFC 7523 | Medium |
| The assertion `jti` replay window (300 s) is shorter than the acceptance window. | Company | Guides | Medium |
| `jti` is a UUIDv4 (122 random bits). | `protocol.rs:122` | 4.2 | Low |
| Message ids come from model tool-call ids. | `poppy_client.rs:261` | 7.3, Guides | Low |
| 429 `Retry-After` isn't enforced; `cursor: null`; any `evt_N` cursor accepted. | | 4.3, 7.5 | Low |
| Grid: two migrations share the number 218, which breaks any fresh database. *Fixed upstream* in #4560 (11 Oct), then every migration squashed into one baseline (#4581). | migrations | | High (deployment) |
| Grid, 12 Oct: the Session assertion has no `typ`, so pda-mock-strict, Northstar and Ilmer refuse it ([S2](spec-issues.md#s2)); the S3 append location fails DP at our mocks. Both are known failures. | `protocol.rs:416`, `:298` at `f470ad7` | 4.2, 3.2 | Medium |

**Worth copying:** cross-implementation interop in CI against a pinned pi-poppy, in both directions, with nonces required.

## Ilmer.org (rbirkby/Ilmer.org)

A signed-out Company on Workers and Pi, live at poppy.ilmer.org. Its documents pass our validator, with info messages for its extra fields.

| Issue | Where | Section | Severity |
| --- | --- | --- | --- |
| Signed-out tokens get `poppy:read poppy:write`, and conversations are gated on them. | `agent/src/protocol.ts:135`; `state.ts:145-172` | 4.2 | Medium |
| Context-only messages are rejected. | `state.ts:182` | 7.4 | Low |
| A trimmed cursor gets `invalid_cursor` rather than `cursor_expired`. | `state.ts:114` | 7.5 | Low |
| 429s have no `Retry-After`; `insufficient_scope` has no `WWW-Authenticate`. | `agent.ts:112`; `state.ts:195`; `protocol.ts:61` | 4.3, 6 | Low |
| `wait` is ignored, so a POST can hold for up to 25 s; handoff never reaches `queued`. | | 7.3, 7.9 | Low |
| Since `de0d1ec` (12 Oct) the Company Agent's web search and fetch tools are built from `env.AI` directly, not the `offline` stand-in the model call falls back to, and `webFetchTool` throws at construction when the binding is undefined, so with `ILMER_POPPY_OFFLINE=true` every conversation fails before the model is asked. Our adapter gives it a stand-in binding. | `agent/src/agent.ts:94` | n/a (dev mode) | Low |

## pi-poppy (richardanaya/pi-poppy)

A Personal Agent extension for the pi coding agent, with its own mock Company, reviewed on 10 October 2026.

| Issue | Section | Severity |
| --- | --- | --- |
| API responses and operation ids go in tool `details`, which the model can't see, so the agent can't act on them. | 6, Ops | High |
| A loopback `client_id` can't be fetched by any real Company. | 4.1 | High |
| Account Tokens and secrets are stored in plain text. | Guides (Storing tokens) | High |
| Message ids are 64-bit and regenerated on retry, so a retry can post twice. | 7.3, Guides | Medium |
| Each send re-reads the whole conversation instead of resuming from a cursor. | 7.5 | Low |
| Grid: Session assertions have no `typ`, so strict Companies refuse every request ([S2](spec-issues.md#s2)). | 4.2 | Medium |
| Grid: after `invalid_session` from the token endpoint it gives up instead of starting a new Session ([N39](spec-issues.md#n39)). | 4.2 | Medium |
| Grid: `null` optional Operation members are rejected, so an operation Datalayer performed is reported as failed ([N41](spec-issues.md#n41)). | Ops | Medium |
| Grid (13 Oct, at Tipping Co): a token request answered 400 `use_dpop_nonce` with a `DPoP-Nonce` header is retried only when `WWW-Authenticate` names the error (`src/agent.ts:829-833`); RFC 9449 8 has an authorization server put it in the JSON body, as Tipping Co does, so pi-poppy gives up. Our mocks and Datalayer add `WWW-Authenticate` at the token endpoint too, which hid it. | 4.3, RFC 9449 8 | Medium |
| Grid: its Company answers an unknown `kid` with `invalid_client` and doesn't refetch the JWKS for 60 s, though the Guides say "Companies refetch `jwks_uri` when they see an unknown `kid`". | Guides | Low |

## print-with-poppy (spenciefy/print-with-poppy)

An agent-first photo-printing store: guest (signed-out) Sessions, an OpenAPI API, and Operations v1 for every order; since 12 October, optional accounts. Our grid runs it in demo mode at commit `260dbb4` (12 October; it was `7ef69be`) ([adapter README](../interop/impls/print-with-poppy-company/README.md)). On 12 October the owner ran our deployed agent against the live store at printwithpoppy.com, which takes real payments. It is also our demo journey. Rows marked "Live:" come from that run; "Source:" from reading the code at the commit named; "Grid:" from the grid.

| Issue | Section | Severity | Status |
| --- | --- | --- | --- |
| Live: `POST /api/agent-sessions` answers `500 internal_error` ("Something went wrong. Retry the same request; do not create a duplicate order."), three times in a row on 12 October. | n/a (store error) | Medium | Tell the maintainer |
| Live and Source (`7ef69be`): the OpenAPI description `poppy.json` lists offered a non-Poppy way in, `startGuestAgentSession` ("Start a plain HTTP compatibility session (not native Poppy authentication)"), with no security requirement, beside the DPoP-protected operations; every real operation accepted either DPoP or the guest Bearer token (`AgentGuest`). Its instructions called the native Session a "guest session" too ("start a guest session at /oauth/token"). A Poppy agent reading it can be drawn in: ours called it three times. The guest token carries no agent identity, so the allowlist and DPoP binding don't apply to it. | 6, 4.3 | Medium | Fixed upstream in `c147418`: `/openapi.json` describes DPoP only, and the compatibility path has its own description at `/api/compat/openapi.json`. We refuse such writes anyway ([readings](readings.md#poppy-session-only)) |
| Source (`7ef69be`): in demo mode the compatibility path couldn't be turned off: `config.compatibility` was `ALLOW_COMPAT_AGENT_SESSIONS === "true" \|\| APP_MODE === "demo"`. Our adapter patched it. | 4.3 | Low | Fixed upstream in `c147418`: an explicit `false` turns it off. The patch is gone |
| Source: no licence was declared. | n/a | Low | Fixed upstream in `c147418`: MIT |
| Source (`c147418` to `cecb32f`): every secured operation listed a required `DPoP` header parameter (at `7ef69be` it was optional). That header is the transport's, made fresh for each request, not an argument; our client asked the model for every required parameter, so it would have refused any upload or order sent without one, before the card. | 6 | Medium | Fixed upstream in `cecb32f` ("Fix PDA signed-out uploads by separating DPoP from operation parameters"), and in our client: it now ignores `DPoP`, `Authorization`, `Accept` and `Content-Type` header parameters (OpenAPI says the last three "SHALL be ignored") |
| Source (`260dbb4`) and Grid: `/oauth/revoke` answers `500 internal_error` to a client assertion it refuses (adonis-agora's, whose `aud` is the token endpoint). Its revoke route calls `verifyAssertion` without the try/catch the token route has, so jose's error reaches the generic handler instead of becoming `401 invalid_client`. | 4.9, RFC 7009 2.2.1 | Low | Tell the maintainer; a known failure (adonis-agora × SO) |
| Source (`260dbb4`): Account Tokens aren't rotated on refresh (allowed; 30 days, revocable), so scenario R can't judge rotation. The new account operations, `getAccount` and `listAccountOrders`, declare `security: [{DPoP: []}]` with no scopes, though they need `poppy:read`; the description says so in prose. | 4.8, 6 | Low | n/a; the second is worth telling the maintainer |
| Source: an order is an operation proposed in a signed-out Session, which the draft limits to that Session (Ops 3.2); if the Session ends before it's confirmed, the agent can neither confirm it nor ask for it again ([N19](spec-issues.md#n19)). The store does nothing wrong; the draft leaves the case open, and this store makes it the normal path. Signed in with `poppy:write`, an order belongs to the account instead. | Ops 3.2, 6 | Medium (spec) | In spec-issues N19 |
| Grid (`260dbb4`): none of its own besides the revocation 500. Of its 53 cells that ran with the six grid agents, 45 pass; 7 failures are poppy-demo's caller requiring an `agent` member, which a Company without conversations doesn't have (poppy-demo's bug, listed above), and 1 is adonis-agora's SO. Every agent that claims them passes Direct Sign-In, its refusal, Mediated Sign-In with a code, sign-out, a signed-in read and `insufficient_scope`. It accepts any assertion `typ` and lifetimes up to 120 s ([S2](spec-issues.md#s2)), a reading, not a fault, and since `260dbb4` refuses a `scope` on the signed-out Session grant (S4). | 4.2 to 4.9 | n/a | n/a |

**What happened live (12 October).** The owner's deployed agent ran against printwithpoppy.com, in live payment mode. The protocol log shows: discovery 200, which our validator passed with 0 errors, 0 warnings and 3 notes; `POST /oauth/token` 200, a signed-out DPoP Session Token for 3600 s, so the maintainer's allowlisting of our `client_id` works; and `GET /api/catalog` with DPoP, 200. Earlier discovery attempts got no answer within our old 5-second limit, now 10 s. Later, with that Session live, the model called `POST /api/agent-sessions` three times; each was shown on an approval card, approved, and answered 500. The owner gave the agent only the store's URL, not the copyable prompt on its home page, so the call didn't come from a pasted instruction. The likely draw is the description, which listed the guest operation with no warning and called the native Session a guest session; whether the model also read the home page, whose prompt then said "Use the documented guest API if you do not support native Poppy sessions", isn't known (the wide-event logs added since would show it). Our fix (`b678221`): a write the description leaves outside the Poppy Session is refused before any card, and a receipt for a non-2xx answer says "Sent as you approved, but … answered 500". With that fix, the agent read the catalogue and reached the approval card for the photo upload (`POST /api/photos`, a 3.7 MB PNG): the first live run past the Session. The order, its approval and checkout haven't run live yet.
| Source (`246727d`), Grid and Live: `proposeOrder` (`POST /api/orders`) declares its `202` with an `operation` property but doesn't list it in `required`. Since 13 October our agent sends a write straight to a Company with Operations only when every success its description declares is a proposal that requires `operation` ([S22](spec-issues.md#s22)), so it now asks the User on its own card before the store's proposal: a third approval in the photo journey (interop OU, known failure). | 6, Ops 4.1 | Low | Tell the maintainer: `required: ["operation"]` restores the direct proposal |

## Tipping Co (timothyohare/personal-agent-protocol)

A learning demo with both sides: Tipping Co, a Company for an NRL tipping service, and a CLI Personal Agent. In our grid as `tipping-co`, both sides, at `fb7b4e6` since 13 October ([interop-testing.md](interop-testing.md#tipping-co-joins-the-grid)); in the full grid that day its agent had 29 pass, 70 fail, 261 unsupported, and its Company 50 pass, 13 fail, 177 unsupported. No licence is declared. Rows are from the grid on 13 October, or from reading the code at that commit.

| Issue | Where | Section | Severity |
| --- | --- | --- | --- |
| Grid: the agent sends no `client_id` at the token endpoint, only the client assertion. RFC 7521 4.2 makes it optional, and the draft never requires it, but every token request in the draft's examples carries one and every third-party Company in the grid refuses a request without it, so its first Session fails everywhere but at its own Company and our lenient mock (which accepts it since 13 October; [readings.md](readings.md)). | `packages/agent/src/company.ts:124-128` | 4.1, 4.2 | High (interop) |
| Grid: the agent refuses OAuth metadata without `authorization_endpoint`, which RFC 8414 2 requires only when a grant type uses it, so it can't discover a signed-out Company (Ilmer, everruns). | `packages/agent/src/discover.ts:74-76` | 3.2 | Medium |
| Grid: the Company wants the token endpoint as every client assertion's `aud`, at the revocation endpoint too, so agents that use the endpoint called (Datalayer's, pi-poppy, and ours until 13 October) can't sign out there ([S1](spec-issues.md#s1)). A reading the draft leaves open, not a fault. Since 13 October our agent tries the token endpoint after that `invalid_client` and signs out there. | `packages/company/src/token.ts:71-72`, `revoke.ts` | 4.1, 4.9 | Medium (spec) |
| Source: the agent's assertions carry a `kid` but no `typ`, so Companies that require `typ: JWT` refuse them ([S2](spec-issues.md#s2)). | `packages/poppy-core/src/assertions.ts` | 4.1, 4.2 | Medium (spec) |
| Source: Account Tokens aren't rotated on refresh (allowed), so scenario R can't judge rotation there. | `packages/company/src/grants.ts` | 4.8 | n/a |

## Alpine Retail (www.alpine-retail.com)

A test Company by a colleague of this project's owner, live since 13 October: Direct and Mediated (phone) sign-in, a Company Agent, and an OpenAPI API of three DPoP-protected reads; no Operations, no website section. Its source isn't public. Checked with its developer's approval: the validator CLI, the live lane, and our deployed agent driven in the owner's browser on 13 and 14 October ([deployment-tasks.md](deployment-tasks.md#3-then), [interop-testing.md](interop-testing.md#the-live-lane-first-run-13-october)). What worked: discovery (valid, no messages), a signed-out Session, conversations with its agent, API reads, Direct Sign-In through its consent page, a refresh with the Account Token, a signed-in read, and sign-out once our agent fell back to the token endpoint.

| Issue | Where | Section | Severity | Status |
| --- | --- | --- | --- | --- |
| Live: revocation takes only the token endpoint as the client assertion's `aud`, and answers `401 invalid_client` to the revocation endpoint, which four other Companies in the grid require. An agent that names the endpoint called can't sign out, and the Account Token stays live. The draft doesn't say which (S1). | `/oauth/revoke` | 4.1, 4.9 | Medium (spec) | Tell its developer: accept any of its own names (the endpoint called, the token endpoint, the issuer). Our agent falls back since 13 October |
| Live: because of the row above, the Account Token from the owner's first sign-in on 13 October, before our fallback, is still live at Alpine Retail until about 12 November; our agent kept no copy then. | Its token store | 4.9 | Low | Tell its developer: revoke it |
| Live: an unknown product code's `404` lists every valid code. Harmless in a demo; worth not copying into a real store. | `GET /api/products/{sku}/inventory` | 6 | Low | Mention to its developer |

## This project

What the comparison found in our own client, and what we did.

| Issue | Status |
| --- | --- |
| Our `poppy_domains` check stripped `www.` from both sides, which is looser than "includes `organization.domain`" (3.2). | Fixed: discovery now goes through the validator, which compares exactly, ignoring only case. |
| An API or conversation that answers 400 `invalid_session` (poppy-demo) left our cached token failing until it expired. | Fixed: the client starts a new Session and retries once. Tested against the mock in both modes. |
| Our spec said the OAuth metadata is at `{auth.issuer}/.well-known/oauth-authorization-server`, the append form; the code did RFC 8414 insertion. | Fixed in the spec. |
| The jwt-bearer grant could carry `scope` in one edge case: a narrowed read-only call in a signed-in Session whose Account Token was gone. 4.3 allows it, but authkit, everruns and TYPO3 reject it with `invalid_scope`, and a signed-out token has no scopes anyway. | Fixed: that grant never carries `scope`. |
| Our mock Company didn't require `typ: "JWT"`, a `kid` or a 60-second lifetime on assertions, though the strictest live Companies do, so a regression there would have gone unnoticed. | Fixed: the mock's `strictAssertions` mode (on by default) records and rejects each. Removing `typ` from our client assertion now fails most Poppy tests. |
| After a 429, a DPoP nonce challenge on the retry wasn't retried, so the call failed at Companies that require nonces. Found by running the conformance tests under the nonce profiles. | Fixed in `oauthRequest`; reverting it fails both nonce-profile Retry-After tests. |
| Our mock flagged random User IDs containing "ada" as personal information (about 1 ID in 1,600), and a crash test reset every Durable Object in the shared test runtime, including other files' mock Companies. Both made tests flaky. | Fixed: the mock's check matches whole values; the crash test runs in its own runtime. |
| Our mock required `token_type_hint` at revocation, which RFC 7009 makes optional. | Fixed: recorded, not required. We send `refresh_token`. |
| No interop test against another implementation (Datalayer's `CompanyService`, pi-poppy's mock). | Fixed: the [interop grid](interop-spec.md) runs our client against nine other projects' Companies, and their agents against our mock and each other's Companies. [Summary of the results](interop-results/README.md). |
| Appendix A is maintained by hand, unlike Datalayer's checked ledger. | Partly fixed: `npm run check:docs` checks every test it names exists. |
| The site crawl: Retry-After wasn't honoured on website pages (4.3). | Fixed: a page that answers 429 or 503 is loaded again after its `Retry-After`, through the shared `CompanyLimiter`; a long one fails with `rate_limited`. The browser join waits too, since its redirect loads a page. |
| The site crawl: a read-only GET narrowed to `poppy:read` even when it needed a custom scope. | Fixed: the narrowed token asks for the scopes the operation's security requirement declares, or `poppy:read` when it declares none. Tested at a Company with a custom-scope lookup and at one with only custom scopes. |
| The site crawl: Session Tokens went to any HTTPS host an OpenAPI description names (spec N10). | Fixed: tokens go only to hosts `poppy.json` lists, or under `organization.domain` or a `poppy_domains` entry; a description naming another server is refused with `untrusted_server` before any request. |
| The site crawl: operations confirmed on a website (Ops 4.4), `resource` on non-MCP entries, `extension_required` and `account_mismatch` had code but no test. | Fixed: each has a test against the mock. `account_mismatch` is handled on renewal and on reuse of an Account Token; at the code exchange the code is spent, so it still fails the sign-in. |
| A token response without `scope` was stored as no scope, which under-reported access (spec N6). | Fixed: an omitted `scope` is the scope asked for (RFC 6749 §5.1), or what the Session or Account Token held when none was asked for. |
| Poppy cards showed the Company's name, which it chooses, but not its domain (spec N14). | Fixed: every request card shows the verified `organization.domain` under the name. |
| The mock didn't check browser assertions' `alg`, embedded keys, `kid` and `iat`/`exp`; one DPoP key used for two User IDs; a one-time code from another Session; asking for a new proposal while one is open; a confirm without `revision`; later messages in a Direct Conversation. | Fixed: each has a violation id and a `TAMPERS` row. Rejected: a browser assertion's disallowed `alg`, unpublished `kid` (strict mode), missing `iat` or `exp`, or `iat` in the future; a one-time code from another Session (4.7); a confirm without `revision`. Recorded only: an embedded key in a browser assertion (the Guides say to ignore it); one DPoP key for two Users (4.3 has no MUST); a new proposal of an action whose operation was confirmed and isn't final (Ops 6; before a confirm the Company can't tell a forbidden re-ask from a harmless one, and returns the open operation); the agent's own words in an open Direct Conversation (our reading of S12). Two caught our client: the model could send its own words into a Direct Conversation, and could ask again for an action whose confirmed operation was still in progress. Both now refused, with tests. |
| The mock never played: token responses without `scope`, rotation with reuse detection, Companies with only custom scopes, SSE keep-alives. | Fixed: each is a mock option with a test. Under reuse detection, renewals in parallel still use each Account Token once. |
| No test against a Company that ignores `wait` or never sends `queued`. | Fixed: both are mock options with a test. |
| Browser contexts were held in a module-level map keyed by issuer and Session label, so two Users' agents sharing an isolate shared one context: a second User browsing the same Company saw the first User's signed-in pages. | Fixed: contexts belong to each agent's client, and a new Session gets a new context. Tested: "keeps each User's and each Session's browser cookies apart". |
| An approved form submit always failed with "The page is no longer open": the executor needed a browser that nothing ever set. | Fixed: the executor needs only the Session's context. Tested: "sends a form only after the User approves exactly what it sends…". |
| The browser treated the whole origin of the Company's issuer as sign-in pages, so at a Company whose issuer is its own website (Datalayer, pi-poppy, poppyseed and adonis-agora in the grid's scenario W) it refused to open any page. | Fixed: the sign-in pages are the authorization, device and Mediated Sign-In endpoints and what's under them, and the issuer's whole host only when it isn't the website. Tested: "keeps a website browsable whose issuer is its own origin, but not its sign-in endpoints". |
| With Browser Rendering, `click` on a submit button sent the form without the approval `submit` requires, and the approval named a selector, not what the form would send. | Fixed: Browser Rendering is gone. The fetch-based browser's `click` follows links only, and the approval card shows every visible value, which is sent exactly as approved. Tested: "clicks links, and never a form's button…". |
| Live at print-with-poppy: the model called a Company's own non-Poppy session endpoint, listed in its description with no security, three times, each on a card the User approved; and a receipt for a write the Company refused read as if it had worked. | Fixed (`b678221`): a write a description declaring DPoP leaves outside the Poppy Session is refused before any card ([readings](readings.md#poppy-session-only)), and the receipt for a non-2xx answer says "Sent as you approved, but … answered" the status. |
| A description listing the transport's own headers as required parameters (print-with-poppy's `DPoP`, from `c147418` to `cecb32f`) made the client ask the model for them, and refuse every call without one. | Fixed: `DPoP`, `Authorization`, `Accept` and `Content-Type` header parameters are dropped from what the model sees and checks. Tested in `test/print-journey.test.ts` with a print shop that lists `DPoP` and `Authorization` as required. |
| Found by print-with-poppy's maintainer after the live run of 12 Oct: our order proposal reached the store as a JSON string, not an object, and its parser answered 400. The model passed `poppy_api_call`'s `body` as a string of serialised JSON, and our client serialised it again. `poppy_api_describe` also showed the order's schema as a bare `$ref`, so the model never saw its fields. | Fixed: a JSON body is checked against the operation's request schema before a card or a request; a string of JSON where the schema wants an object gets a correction telling the model to pass the value itself (strings are never parsed for it, since an API may take one); a missing required body or a field that doesn't match is named. `poppy_api_describe` writes out `$ref`s. Then print-with-poppy's maintainer made `body` an object in the tool's own parameters (pull request 2), so pi refuses a string body before the tool runs, with `bodyValue` for a body that isn't an object. Tested in `test/print-journey.test.ts` and `test/poppy-tool-body.test.ts`. |
| Checking for the same mistake elsewhere after print-with-poppy's double-serialised body (13 Oct): `poppy_mcp_call` sent a tool's `args` without checking them against its `inputSchema`, so a missing or wrong argument, or a string of serialised JSON, reached the User's card and then the Company; a string of JSON in a field inside an OpenAPI body got only the schema's own error, not the correction; and `poppy_browse`'s `fill` without a `value` filled the field with nothing. | Fixed: MCP `args` are checked against `inputSchema` before a card or a call (`invalid_args`); the correction for serialised JSON names the place, at the top or deeper in, for bodies and `args` alike; `fill` needs a `value` (`""` clears a field). Tested in `test/poppy.test.ts` and `test/print-journey.test.ts`; interop scenario AM passes at every Company with an MCP server. |
| From the Cloudflare audit of 13 Oct: three loops a Company controlled. A conversation that said `working` or `queued`, had a person on, or was Direct was read every second for as long as it said so, each read waiting up to 20 s, so one stuck or forgotten conversation kept the agent's Durable Object awake around the clock. The idle backoff never grew either: `last_event_at` was set on every read that carried a status, so every idle conversation was read every 30 s. And an operation `in_progress` was read again after each `Retry-After`, as low as 1 s, for ever; each read also re-scheduled the job at 5 s and moved `updated_at`, so Activity's "since" was always now. | Fixed: `last_event_at` moves only on activity (an event, a change of status or responder, our own message); a busy conversation is read every second only within 2 minutes of activity, then at the idle pace, 30 s to 15 min, an hour after a day; an in-progress operation waits the later of `Retry-After` and a quarter of the time since it last changed; `updated_at` moves only when the operation changes ([our reading](readings.md#pace), spec issue [N46](spec-issues.md#n46)). Tested in `test/poppy.test.ts` and by interop scenarios XR and XT. |
| From an external audit of 13 Oct, eleven findings in our own code. **High:** after an interrupted confirm, a Company that changed a revision's terms in place (USD 10 to USD 999, revision unchanged) was confirmed again, and the card showed the new terms as if approved. **Medium:** the tracking backoff treated members in a new order as progress; a write whose description made `operation` optional, or declared ordinary successes beside the proposal, skipped our approval card (MCP too); a Company's OAuth `error_description` (a name, a short password, an OTP) reached the logs; a 31-day-old photo was still served and shown to the model, a photo-only message gave the model no image, and previews didn't count toward the storage cap; a reminder whose card failed was marked done with no retry, and a batch finishing at once left 120 finished schedules where 100 are kept; Company text could forge a `[User]:` line in the summarizer's input; "password hunter2" and similar notes passed the secret check; two USD 8 terms passed a USD 10 standing permission. And 10 high-severity dependency advisories (the MCP SDK under `agents`, `extract-zip` and `basic-ftp` under `@cloudflare/puppeteer`). | Fixed on 13 Oct: a revision's terms are fixed (Ops 3.1; the card keeps what the User saw and the revision is never confirmed again); progress compared canonically; the exemption needs every success to be a proposal that requires `operation` (S22), with a run-time check; errors that may carry a Company's words are logged by class and code only (`ForeignText`); photos expire on access and by an alarm job, photo-only messages show the image, previews count; reminders retry at 1, 5 and 30 minutes, then show as failed, and every finish prunes to 100; the summarizer gets one JSON line per message; a broader secret check; a permission's maximum caps the total (S20); `agents` 0.28.1 and an override for `@puppeteer/browsers`. Tests for each. Unverified: whether the forged line would have misled a real model. |
| Live at Alpine Retail, 13 and 14 Oct, five problems in our agent. Sign-out sent the revocation endpoint as `aud`, which Alpine refuses (S1). A refused revocation was silent: the account vanished from the Companies page, nothing reached Activity, and the token, still live at the Company, was deleted here, so nothing could try again. `poppy_status` gave expiry as a raw number and the model couldn't say how to sign out. A Direct Sign-In nobody finished stayed open in Needs you after it expired. And twice, a message sent with Enter just after a page reload vanished. | Fixed on 13 and 14 Oct: the token endpoint after an `invalid_client` at revocation or device; refused sign-outs kept in `poppy_signouts`, retried after 1 minute, 10 minutes, 1 hour and 6 hours, and shown on a notice, the Companies page (with Try again), Activity and `poppy_status`; readable dates, and the model told where the User signs out; an expiry job closes an unfinished sign-in at its deadline; a message sent before the socket opens isn't lost. A step-up's revocation of the replaced token goes the same way. Tested in `test/poppy.test.ts` and `test/ui/`; signed out live at Alpine on 14 Oct (401, then 200). |
