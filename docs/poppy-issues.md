# Issues found in Poppy implementations and the specification

This file lists what we found by reading other implementations of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) Draft 0.1 (updated 9 October 2026), and the gaps in the specification that their differences expose. It also lists what the comparison found in our own client.

- **Date.** Everything here was checked on 11 October 2026, two days after the draft was published, when every implementation was days old. The notes on Datalayer 0.10.0 are from 12 October.
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

Rust, both sides, signed-out only (PRs #4479, #4531, #4549, #4558).

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
| Grid: two migrations share the number 218, which breaks any fresh database. | migrations | | High (deployment) |

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
| Grid: its Company answers an unknown `kid` with `invalid_client` and doesn't refetch the JWKS for 60 s, though the Guides say "Companies refetch `jwks_uri` when they see an unknown `kid`". | Guides | Low |

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
| No interop test against another implementation (Datalayer's `CompanyService`, pi-poppy's mock). | Fixed: the [interop grid](interop-spec.md) runs our client against seven other projects' Companies, and their agents against our mock and each other's Companies. [Summary of the results](interop-results/README.md). |
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
