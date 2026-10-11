# Issues found in Poppy implementations and the specification

This file lists what we found by reading other implementations of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) Draft 0.1 (updated 9 October 2026), and the gaps in the specification that their differences expose. It also lists what the comparison found in our own client.

- **Date.** Everything here was checked on 11 October 2026, two days after the draft was published. Every implementation was days old.
- **Method.** We read the code and compared it with the text of the specification, the Guides and the Operations extension. We didn't run anyone else's code. Live documents were fetched from public URLs. File and line references are to each repository's default branch on that date.
- **Severity** is how much an issue matters to interoperability or security, not a judgement of the project. Many of these are demos, and several were built in a day.

The implementations themselves are listed in the [README](../README.md#other-implementations).

## Contents

- [The specification](#the-specification)
- [poppy-demo](#poppy-demo-irvinebroquepoppy-demo)
- [Datalayer SDK](#datalayer-sdk-datalayerpersonal-agent-protocol)
- [poppyseed](#poppyseed-akshay5995poppyseed)
- [adonis-agora authkit and agent](#adonis-agora-authkit-and-agent-davidecarvalho)
- [everruns](#everruns-everrunseverruns)
- [Ilmer.org](#ilmerorg-rbirkbyilmerorg)
- [pi-poppy](#pi-poppy-richardanayapi-poppy)
- [This project](#this-project)

## The specification

Each item says where the text is silent or ambiguous, how the implementations differ as a result, and what we do. Section numbers are the draft's.

| # | Section | Issue | How implementations differ | What we do |
| --- | --- | --- | --- | --- |
| S1 | 4.1, 4.2 | **Client assertion `aud`** at the token, revocation and device endpoints is never stated. | Every implementation guesses "the exact endpoint called"; some also accept the issuer. | Exact endpoint. |
| S2 | 4.2, Guides | **Assertion `typ` header and maximum lifetime** are unspecified. Only browser assertions get "no more than 60 seconds"; the Guides say "reject assertions that claim a long lifetime" without a number. | poppy-demo and Ilmer require `typ: "JWT"`, a `kid` and a lifetime of 60 s or less; others accept 300 s. | `typ: "JWT"`, `kid`, 60 s. |
| S3 | 3.2, RFC 8414 §3.1 | **Metadata location for an issuer with a path.** RFC 8414 inserts the well-known segment before the path; the draft only shows a path-less issuer. | everruns appends (`{issuer}/.well-known/oauth-authorization-server`); others insert. The TYPO3 lab and authkit use path issuers and serve the inserted form. | Insert, per RFC 8414. Our own spec text said "append" until this review; fixed. |
| S4 | 4.2 | **Signed-out `scope`.** "A signed-out token has none" conflicts with Companies that gate conversations on `poppy:read`. What `scope` means on the jwt-bearer grant is undefined. | Ilmer grants signed-out tokens `poppy:read poppy:write`; authkit, everruns and TYPO3 reject `scope` there with `invalid_scope`. | Never send `scope` on the jwt-bearer grant. Note 4.3 says "any token request MAY include scope", so rejecting it conflicts with 4.3. |
| S5 | 4.2, 4.8 | **Renewing a signed-in Session with an assertion** has no defined error. | Datalayer's TypeScript Company keeps the Session signed in; authkit silently returns `signed_in: false`; poppy-demo returns `invalid_grant`. | Renew signed-in Sessions with the Account Token only. |
| S6 | 4.1 | **"Same domain"** for `jwks_uri` and `redirect_uris` isn't defined (host? registrable domain? port?). Redirects on the `client_id` fetch aren't addressed. | Most read it as the exact host; authkit as host and port. Everyone refuses redirects on `client_id`. | Our validator accepts the same host or a parent/child host, and calls a redirect an error. |
| S7 | 3.2 | **Issuer exactness vs. trailing slashes.** The draft says "exactly", but `https://a.example` and `https://a.example/` are different strings. | Datalayer's client strips a trailing slash before comparing, and uses the stripped value for the 4.5 `iss` check. | Exact string comparison. |
| S8 | 7.3, 7.11 | **Retried messages after sign-out.** 7.3 says a retry returns "the original response"; 7.11 says an account conversation needs sign-in. They conflict when the retry comes after sign-out. | poppy-demo returns the original response, which can include account data. | n/a (Company side). We suggest 7.11 wins. |
| S9 | 7.3 | **Message-id idempotency** doesn't say whether ids are per conversation, what happens to a retry while the first is in flight, or what "the original response" includes. | All different. | 128-bit ids, reused on retry. |
| S10 | 7.5 | **Cursor on an empty read** with no cursor given isn't defined. | `null`, `""` and `start_<id>` all appear. | Cursors are opaque; we store only strings. |
| S11 | 7.11 | **A `sign_in_required` event has no `scope`**, so the agent can't tell which scopes to request. | poppy-demo omits it. | Request the scopes the task needs. |
| S12 | 7.10 | **Direct Conversations:** may the agent send `sender: "agent"` messages, such as context-only ones? Unsupported Direct Conversations come back as 400 `invalid_request`, 400 `direct_conversations_not_supported`, or `conversation_not_found`. | Three error shapes. | We report the Company's error to the model; nothing special yet. |
| S13 | 6, 7.13 | **API errors for an ended Session.** Section 6 lists only `invalid_token`, `sign_in_required` and `insufficient_scope`. | poppy-demo returns 400 `invalid_session` with no `WWW-Authenticate`. | We now start a new Session on either signal (see below). |
| S14 | 4.3 | **DPoP error status at resource servers** isn't stated (400 or 401?). | Mixed; some send no `WWW-Authenticate`. | We read `WWW-Authenticate` on 401 and 403, then the body's `error`. |
| S15 | 7.9 | **The `queued` transition on handoff** is mandatory but impractical without a human queue. | No Company emits it reliably. | We treat `queued` as still in progress and keep reading in the background; nothing depends on it. |
| S16 | 4.4 | **Approving zero scopes:** signed in with `scope: ""`, or `access_denied`? | Undefined. | Nothing special yet: we show the granted scopes. |
| S17 | 7.2 | **"Belongs to that account":** can a different User ID signed in to the same account continue a conversation? | poppy-demo scopes everything by User ID. | n/a. |
| S18 | 3.1 | **`web` has no URL**, and `web: {}` and `apis: []` have no stated meaning. `organization.name` is described ("display name and domain") but not said to be required. | Ilmer invents `web.url` and `organization.url`. | Our validator warns when `name` is missing and accepts `web: {}`. |
| S19 | Guides | **Algorithms:** is ES256 required, or only preferred? | withpoppyseed.dev advertises RS256; others are ES256-only. | Sign with ES256. |
| S20 | Ops 5.1 | **Standing permissions have no checkable action.** Operations have no standard action field, money has no direction, and an approval can't be proved to the Company. | SmokeSol and gmackie/attest raise the same points. | Match a summary word and `{ amount, currency }` objects. |
| S21 | 4.1 | **Local agents.** An HTTPS `client_id` on the same domain as the redirect URIs rules out an agent on someone's laptop unless it has a hosted identity. | pi-poppy, poppyseed (dev flag) and Ilmer's tests use loopback `client_id`s. | Hosted identity. |
| S22 | Ops 4 | **Which writes propose.** A Company may use operations for some actions and not others. | poppyseed marks proposing OpenAPI operations with `x-poppy-operation: true`. | We expect a proposal from any write at a Company with operations. |
| S23 | Guides | **DPoP nonces "for that server":** per origin, or per Company? | Mixed. | Per origin. |

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

Its live documents pass our validator with no errors or warnings, and are fixtures in `test/validator.test.ts`.

## Datalayer SDK (datalayer/personal-agent-protocol)

The most complete SDK: Python and TypeScript, both sides, reference Companies, a requirements ledger and 125 shared conformance cases.

| Issue | Where | Section | Severity |
| --- | --- | --- | --- |
| The TypeScript Company keeps a Session signed in when it's renewed with an assertion. (The Python Company is correct.) | `src/company/service.ts:517-521` | 4.2 | High |
| An Account Token request without `session_id` is refused with `invalid_session`; the draft says it starts a new signed-in Session. | `service.ts:542-549`; `service.py:504-509` | 4.8 | Medium |
| Mediated Sign-In silently drops unknown or missing scopes instead of returning `invalid_scope`. | `service.ts:983`; `service.py:900` | 4.4 | Medium |
| The client strips a trailing `/` from the issuer before comparing, and uses that value for the `iss` check. | `models.ts:393,506`; `discovery.ts:154` | 3.2, 4.5 | Medium |
| DPoP `jti` replay gap: `iat` up to +60 s is accepted, but `jti` is remembered only until now + 60 s. | `crypto.ts:229-254` | 4.3 | Medium |
| No `WWW-Authenticate` on 400 `invalid_dpop_proof`. | `service.ts:212` | 4.3 | Low |
| SSE ignores `?cursor`. | `service.ts:1160` | 7.6 | Low |
| Handoff with no one available adds no message. | | 7.9 | Low |

**Worth copying:** `protocol/requirements.yaml` maps 160 requirements to code and tests, with a test that the references exist. Its blind spot: it only holds sentences with RFC 2119 keywords, and three of the bugs above sit in sentences without one.

## poppyseed (akshay5995/poppyseed)

A Company library for Next.js with a conformance suite, live at withpoppyseed.dev.

| Issue | Where | Section | Severity |
| --- | --- | --- | --- |
| `redirect_uris` are checked for the same host, not for HTTPS, and the authorization code is then sent there. | `packages/core/src/clients.ts:210-217` | 4.1 | High |
| withpoppyseed.dev 308-redirects every path from the apex to `www.`, including `POST /oauth/token`, while `auth.issuer` and every endpoint name the apex. Discovery works; every token request fails for a client that, correctly, never follows redirects with credentials. Its demo agent's `client_id` redirects too, so no Company can load it. | Deployment | 3, Guides | High (deployment) |
| Direct Sign-In always requires `session_id` and `private_key_jwt`, so a plain MCP client can't use MCP's own flow. | `oauth.ts:130` | 6 | Medium |
| Any `resource` parameter is treated as an MCP Bearer request. | `oauth.ts:77-83` | 4.3 | Low (possible) |

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
| Checked only against its own mock. | | Note |

## This project

What the comparison found in our own client, and what we did.

| Issue | Status |
| --- | --- |
| Our `poppy_domains` check stripped `www.` from both sides, which is looser than "includes `organization.domain`" (3.2). | Fixed: discovery now goes through the validator, which compares exactly, ignoring only case. |
| An API or conversation that answers 400 `invalid_session` (poppy-demo) left our cached token failing until it expired. | Fixed: the client starts a new Session and retries once. Tested against the mock in both modes. |
| Our spec said the OAuth metadata is at `{auth.issuer}/.well-known/oauth-authorization-server`, the append form; the code did RFC 8414 insertion. | Fixed in the spec. |
| The jwt-bearer grant could carry `scope` in one edge case: a narrowed read-only call in a signed-in Session whose Account Token was gone. 4.3 allows it, but authkit, everruns and TYPO3 reject it with `invalid_scope`, and a signed-out token has no scopes anyway. | Fixed: that grant never carries `scope`. |
| Our mock Company didn't require `typ: "JWT"`, a `kid` or a 60-second lifetime on assertions, though the strictest live Companies do, so a regression there would have gone unnoticed. | Fixed: the mock's `strictAssertions` mode (on by default) records and rejects each. Removing `typ` from our client assertion now fails 46 Poppy tests. |
| No interop test against another implementation (Datalayer's `CompanyService`, pi-poppy's mock). | Open. |
| Appendix A is maintained by hand, unlike Datalayer's checked ledger. | Open. |
| No test against a Company that ignores `wait` or never sends `queued`. | Open. |
