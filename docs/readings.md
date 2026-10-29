# Our readings of the draft's open questions

**Current: the 28 October text of 0.3, alone** ([decision 37](decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles)). Our readings of 0.1 and 0.2 are in this file's history; the ones 0.3 settled are listed [below](#settled-or-retired-by-03).

Where Poppy 0.3 is ambiguous, we had to pick a behaviour. This file records each pick: which reading our client takes, which our strict and lenient mock Companies take, whether we're strict or lenient there, and why. The questions we sent upstream are in [poppy-0.3-issues.md](poppy-0.3-issues.md); the older ids (S1, N19 and the rest) are from [spec-issues.md](spec-issues.md), the 0.1 list.

Back to [poppy-0.3-issues.md](poppy-0.3-issues.md) · [interop-spec.md §7](interop-spec.md#7-readings)

## The rule

**Strict where the ambiguity is security-relevant, lenient where it's cosmetic.**

[RFC 9413, "Maintaining Robust Protocols"](https://www.rfc-editor.org/rfc/rfc9413.html), argues that tolerating the unexpected (Postel's "be liberal in what you accept") lets one implementation's bug become everyone's de facto protocol, and that a protocol stays healthy when implementers choose deliberately what to accept, and say so. So:

- **What we send** takes the narrowest reading: the one every reading accepts, where there is one.
- **What we accept** is strict where a wrong guess could widen access, mix up identities or let something replay: the mocks refuse it, or record a named violation (`test/mock-company/violations.ts`) when the draft gives a Company no error to send.
- **What we accept** is lenient where the readings differ only in shape (an error's location, a cursor's spelling, a missing display name) and every reading leads to the same access.
- **How it's graded** is separate from what we do. A check that rests on a reading is tentative everywhere: a warning in the mock, the validator and the grid, and a failure it causes is the spec's ([conformance-levels.md](conformance-levels.md)). Being strict in behaviour never makes the other side's departure a violation.

## The implementations

| Name | What it is | Settings |
| --- | --- | --- |
| **Client** | `src/poppy/`, the Personal Agent; `pda` in the [interop registry](../interop/registry.json) | One behaviour |
| **Strict mock** | `test/mock-company/` with its defaults (`DEFAULT_CONFIG` in `types.ts`), as the conformance tests run it; `strict-company` in the grid | `strictAssertions: true`, `nonceScope: "company"`, `dpopTokens: true` |
| **Lenient mock** | The same mock with `strictAssertions: false`; `lenient-company`, the grid's reference Company for attribution rule 2 | As the strict mock, except S2. Both report every check with its basis and level; a warning or reading never fails a cell ([conformance-levels.md](conformance-levels.md)) |
| **Fake Personal Agents** | The client with a profile in the adapter's network seam (`interop/impls/pda-agent/profiles.ts`), for testing Companies: `lenient-personal-agent`, `strict-personal-agent`, `sloppy-personal-agent` ([interop-spec §2.1](interop-spec.md#21-the-fake-implementations)) | Readings in `PROFILE_READINGS`: the lenient agent reads S3 `either`; the strict agent the client's; the sloppy agent S1 `token-endpoint` and S2 `lenient-300s` |

The conformance tests also run sign-in, Sessions and sign-out under five other profiles (`PROFILES` in `test/poppy.test.ts`): a DPoP nonce per origin and per Company (S23), lenient assertions (S2), a trailing-slash issuer (S7), and an issuer with a path (S3).

## Questions declared in the grid

Each adapter declares these in its manifest (`readings` in `interop/impls/pda-agent/adapter.ts` and `interop/impls/pda-mock/adapter.ts`), and the runner checks the agent's declaration against its trace (`interop/runner/readings.ts`).

| Id | Question | Client | Strict mock | Lenient mock | Strict or lenient |
| --- | --- | --- | --- | --- | --- |
| [S1](#s1) | Client assertion `aud` | `issuer` | `issuer` | `issuer` | Settled by 4.1; kept to attribute the sloppy agent's `token-endpoint` |
| [S2](#s2) | Client assertion `typ` and lifetime | `jwt-60s` | `jwt-60s` | `lenient-300s` | Strict, except the reference Company |
| [S3](#s3) | Metadata location for an issuer with a path | `insertion` | `insertion` | `insertion` | Strict |
| [S23](#s23) | DPoP nonce scope | `per-origin` | `per-company` | `per-company` | Lenient, both sides |

### <a id="s1"></a>S1: the client assertion's `aud`

Settled. 4.1 has a client assertion name the Company's issuer as `aud`, as a single string, at every OAuth endpoint, so an assertion made for one Company is refused by every other (10.4). The client sends the issuer (`oauthRequest` in `src/poppy/client.ts`) and no longer retries with the token endpoint after `invalid_client`. Both mocks accept only the issuer: an array is `client-assertion.aud-array`, anything else `client-assertion.aud`, both MUST. The question stays in the grid so the runner can say why the sloppy agent, which names the token endpoint everywhere, is refused.

### <a id="s2"></a>S2: client assertion `typ`, `kid` and lifetime

- **Client:** header `typ: "JWT"`, a `kid` naming a published key, and `exp` 60 s after `iat` (`ASSERTION_SECONDS` in `src/poppy/jwt.ts`). 4.1 says only that the Personal Agent "MUST make them short-lived" (issue 7 asks for a number).
- **Strict mock:** refuses a client assertion without `typ: "JWT"` (`client-assertion.typ`), without a published `kid` (`.kid`), or living longer than 60 s (`.lifetime`).
- **Lenient mock:** no `typ` or `kid` needed, and assertions up to 300 s (`MAX_ASSERTION_LIFETIME`), which it declares as `lenient-300s`: the runner counts it compatible with agents reading `jwt-60s`, `lenient-120s` or `lenient-300s`, not with `any`. It still refuses a JWT of another kind used as one (`client-assertion.wrong-typ`), an algorithm 4.1 and the guides don't allow (ES256, PS384, and RS256 from the guides), a bad signature against the published keys, and a reused `jti`, and records an embedded key (`.embedded-key`).
- **Why.** Both mocks are strict on the parts that stop confusion and replay: a distinct `typ` for the other JWT kinds, a signature from a published key, single-use `jti`. Requiring `typ: "JWT"` on top, and 60 s rather than 300, is what the strictest Companies did, so the client sends it and the strict mock checks it. The lenient mock is the grid's reference Company: its job is attribution, not gatekeeping.

### <a id="s3"></a>S3: metadata location for an issuer with a path

- **Client:** RFC 8414 §3.1 insertion: `/.well-known/oauth-authorization-server` between the host and the issuer's path (`metadataUrl` in `src/validator/fetch.ts`, used by discovery through `validateCompany`). It doesn't fall back to the appended form. Tested in `test/validator.test.ts` with a `/tenant/` issuer.
- **Mocks:** the issuer is `https://auth.<domain>` with no path by default (optionally with a trailing slash). With `issuerPath` (`/tenant`), the metadata is served only at the inserted location; the appended one is 404. The conformance tests run sign-in, Sessions and sign-out under that profile too, and the grid's `DP` scenario runs it between our agent and both mocks.
- **Why strict.** It decides which document is trusted as the issuer's, and RFC 8414 has one answer. The security control is that the metadata's `issuer` must equal the issuer the domain names exactly (`metadata-issuer-mismatch`), and that holds either way.

### <a id="s23"></a>S23: DPoP nonce scope

- **Client:** keeps the latest `DPoP-Nonce` per server origin (`#nonces` in `src/poppy/client.ts`), at the token endpoint and at resources, and retries once on `use_dpop_nonce`. That works with a Company that keeps one nonce for all its origins, at the cost of one extra round trip per origin. DPoP is used only when the issuer lists `dpop_signing_alg_values_supported` (4.5).
- **Mocks:** one nonce for the whole Company (`nonceScope: "company"`) when nonces are required (`requireNonce`, off by default; the `require_nonce` hook in the grid). The `origin` profile is tested too.
- **Why lenient.** A server nonce only bounds how long a proof stays fresh; neither scope gives more access. The strict part is elsewhere: once a key has used a nonce at a server, dropping it is recorded (`dpop.nonce-ignored`), and proofs are checked for `htm`, `htu`, `ath`, `iat` and `jti` replay.

## Other questions we had to answer

These aren't declared in the grid's manifests, because they don't change what goes on the wire in a way the runner can check, or only one side has a choice to make.

| Question | Client | Mocks (both) | Strict or lenient, and why |
| --- | --- | --- | --- |
| Whether a write goes straight to the Company (Ops, issue 40) | Never: every write and every upload waits for our own card; when the Company answers `approval_required`, its terms go on a card of their own, and only that card's approval sends `Poppy-Approval` (decision 36) | Answer the exchange and the print order with `approval_required` | **Strict.** Operations 2 has no marker for writes that need approval, so a Company that doesn't ask would act on the model's word |
| <a id="poppy-session-only"></a>Only the Poppy Session (§7, issue 41) | The agent's only access to a Company's API is its Session header and the Company's access token. Where a description declares a scheme that takes that token (OAuth 2.0, or HTTP `Bearer` or `DPoP`, any case), a write whose security requirements, its own or the document's, name none of them is marked `usable: false` by `poppy_api_describe` and refused by `poppy_api_call` with `outside_poppy_session`, before a card, a token or a request (`tokenSchemes` and `outsidePoppySession` in `src/poppy/apis.ts`). Reads stay allowed; a description that declares no such scheme is called as before | The print shop is described as Print with Poppy's store: its token scheme and a Bearer `guest` scheme, `POST /agent-sessions` with no security, a public `GET /catalog`, writes that take either | **Strict where we can tell.** §7: "Every listed API MUST accept the Session header (5.2) and the Company's access tokens (4.5)"; another way in has none of the Session's guarantees. A Bearer scheme of the Company's own can't be told from the one that takes our token (issue 41), so a write that names only `guest` is let through |
| `client_id` beside a client assertion (4.1) | Always sends it | Takes the client from the assertion when `client_id` is left out, if its `iss` and `sub` are the same (RFC 7523 3); a `client_id` that is sent must equal both (`client-assertion.iss-sub`) | **Lenient** where the text is: RFC 7521 4.2 makes `client_id` optional with assertion authentication |
| "Same domain" (4.1) for `jwks_uri` and `redirect_uris` | Publishes both on `PUBLIC_ORIGIN` itself; the validator accepts the same host or a parent or child host | Requires exactly the `client_id`'s host (`client-metadata.jwks-uri`, `.redirect-uris`); refuses a redirect on the `client_id` fetch | **Strict** in the mocks: these bind our keys and redirects to our identity. The validator is broader only because it has no Public Suffix List, and says so |
| <a id="s7"></a>Trailing slashes in the issuer (S7) | Compares exactly: metadata `issuer` against the issuer the domain names, and `iss` on redirects | Publishes one string everywhere; the trailing-slash profile is tested | **Strict.** The issuer is the Company's identity; normalising it invites mix-up (RFC 9207) |
| A retry after sign-out (S8) | n/a (Company side) | The 8.11 check comes first, for a later message and a retried first message alike: a 401 challenge for the account's scopes | **Strict**, since the original can include account data. Found by the Hypothesis model (`test/hypothesis`) |
| Message-id idempotency (S9) | 128-bit ids, reused with the same content on retry | Ids are per `client_id` and User ID, not per conversation. The same content (the same JSON value, whatever its members' order: `canonicalJson`) returns the original; different content is 409 `message_id_conflict` and `message.id-reused` | **Lenient** on where a retry may go (cosmetic: it's the same message); **strict** on changed content, which could be a different action under an old id |
| Which Sessions a revoked refresh token signs out (N4) | Revokes the replaced token after a step-up (4.7, SHOULD) | Signs out the Sessions signed in with that token or one it was rotated from (`grant` in `test/mock-company/core.ts`), not the account's other sign-ins | **Strict**, to the letter of 4.6 |
| Cursor on an empty first read (S10) | Opaque; stores only strings, so `null`, `""` or an id all work | The last event's id, else the cursor it was given (`null` first) | **Lenient.** Cosmetic. The grid's checks take a string or `null` there; any other value is `company.events-cursor`, a Reading and so a warning |
| Who may write in a Direct Conversation (8.10, S12) | Sends only the User's own words, with `author: { "type": "human" }` | Records `direct.agent-words` and `direct.agent-words-later`, and accepts the message | **Strict**: a Direct Conversation is the User's. Recorded, not refused, because the draft has no error for it |
| `queued` on handoff (8.9) | Doesn't depend on it | Says `queued`; `neverQueued` goes straight to `working`. While a person already handles the conversation, a handoff changes nothing | **Lenient.** Cosmetic |
| `direct_closed` when the parent's close closes it (8.10, 8.12) | Marks the Direct Conversation closed on `direct_closed` | Closing a parent closes its open Direct Conversation first, so the parent gets `direct_closed` and then its own `closed` state | **Strict**, to the letter of 8.10. The order is ours |
| "The request again" after a 429 (5.6) | One limiter per Company across Users and tasks (`CompanyLimiter`): nothing is sent there until the `Retry-After` passes | 429 to every request inside the window. The same request sent again inside its own `Retry-After` is `rate-limit.retry-after-ignored` (MUST); any other is `rate-limit.shared-limit-ignored` (Guides) | **Lenient** in grading, to the letter of the MUST; the Company's 429 still holds |
| Approving zero scopes (S16) | Not exercised | A test can approve zero scopes; the mock then signs in with an empty scope | Undecided; no test covers it |
| Another User ID on the same account (S17, issue 21) | n/a | A conversation that used an account may be continued by any Session of the same `client_id` signed in to that account | Lenient, matching "belongs to that account" literally. The `client_id` check stays strict |
| A missing `organization.name` (S18) | Shows the domain when the name is missing | Always publish a name | **Lenient** in the client: cosmetic. The validator reports it as an error, since `organization` is "Display name and domain" |
| Algorithms (4.1, 5.2) | Signs client assertions, delegations and Session JWTs with ES256 | Accept ES256 and PS384 for client assertions and delegations, as 4.1 and 5.2 require, and RS256 for client assertions, as the guides add; ES256 or RS256 for DPoP | Client strict in what it sends; mocks as the text |
| Local agents (4.1) | Hosted identity only | Refuses a `client_id` that isn't `https` (`client-metadata.not-https`) | **Strict.** The identity is the `client_id`'s HTTPS origin |
| MCP `readOnlyHint` (§7) | A tool the Company's MCP server marks `readOnlyHint: true` runs without our card, as an OpenAPI GET does | n/a | **Lenient, knowingly**: the server is the Company's own (its protected resource metadata names the Company's issuer), and the Company is the one that would act |
| An alternative's `web` reference (9.2, issue 18) | Kept only when it is HTTPS on one of the Company's hosts, with no credentials in the URL (`readAlternative` in `src/poppy/coverage.ts`); `openapi` and `mcp` references only when they name an API `poppy.json` lists, as 9.2 requires | n/a | **Strict.** 9.2 checks API references and not web ones; 4.3 closes the same hole for sign-in links |
| <a id="pace"></a>How often to check a busy conversation (N46) | `Retry-After` is the least wait, never a schedule. A conversation that says `working` or `queued`, has a person on, or is Direct is read every second only while something happened in the last 2 minutes; otherwise at the idle pace, a quarter of the quiet time, 30 s to 15 min, an hour after a day. A read follows `has_more` for at most 10 pages (`src/poppy/pace.ts`) | n/a (Company side); the adversarial Company's `endlessEvents` (XR) does the opposite on purpose | **Strict**, since the cost is the agent's |
| An approved request that fails or gets no answer (Ops 7) | Never automatically resend an uncertain write. Unknown outcomes, approved 5xx, accepted OpenAPI 202 and accepted conversation approvals hold further writes Company-wide until the User checks and records the original outcome. Reads and other Companies remain usable. The original receipt and separate User assertion are durable; reconciliation sends nothing | n/a | **Conservative.** The text describes resending the same approval (no keyword); we retain our no-resend policy. Its MUST NOT on fresh approval while the outcome is unknown is enforced with a broad hold because request syntax cannot prove different business actions. `test/poppy-outcome-guard.test.ts`; actual browser recovery evidence in `docs/evidence/pr-36-conformance/`. |
| <a id="n19"></a>An approval whose Session the Company ended (N19, issue 12) | An approval is bound to the Session and account it was shown in. When the Company answers it `invalid_session`, the client starts a new Session and doesn't send the approval on it: the card fails with `approval_changed`, nothing was done, and the User and the model are told; asking again gets a new card. An approval whose answer was lost reads "may or may not have happened" and is never sent again | The print shop's orders, signed out, belong to their Session (Ops 3) | **Strict about sending nothing more.** Tested: "stops at the Company's terms when the signed-out Session they belong to ended…", "tells the User an order may have happened when the answer to its approved request was lost…" (`test/print-journey.test.ts`) |

## Draft 0.3 readings (28 October text)

Readings we took to implement [the 28 October text](../spec/draft-0.3-retrieved-2026-10-28/README.md). The problems behind several of them are in [poppy-0.3-issues.md](poppy-0.3-issues.md).

| Question | Client | Mock | Strict or lenient |
| --- | --- | --- | --- |
| How long a delegation lives (5.2: at most 24 hours) | Four hours from an `iat` rounded down to the hour, as the guides suggest; a new key and delegation ten minutes before the old one expires; the key is non-extractable and memory only | Refuses one longer than 24 hours or expired (with 30 s of skew); caches a verified one until it expires | **Strict** in what we send |
| An access token and the User ID (5.3, step 3) | n/a | Checks the token was issued to the Session JWT's `client_id`, and nothing about its User: sign-in names no User ID, so a token can't carry one | **Lenient**, because 5.3 checks only the `client_id` |
| Who may approve an operation (Ops 3) | The approval card is bound to the Session and account it was shown in; after a sign-out, or on a new Session, it isn't sent | Any Session of the same agent and User, signed in to the account, for a signed-in operation; the Session itself for a signed-out one | **Strict** on our side; the mock follows the text |
| A Session after sign-out (5.5) | Keeps its `sid`, continues signed out, and remembers the account it used: another account gets a new Session | Refuses a second account in one Session with `invalid_session`, and records it as a SHOULD (`session.second-account`) | **Strict**: 5.4's SHOULD, and the Company MAY refuse |
| Unknown `status` and `responder` (8.7) | `working` and `human` | n/a | **Lenient**, and safe: an unknown status keeps us reading, an unknown responder is treated as a person |
| A message with `sender` instead of `author` (8.4) | Reads `author.type`, and `sender` when a Company still sends it (`writtenBy` in `src/poppy/message-author.ts`); writes `author` alone | A message that carries `sender` is a warning (`message.sender-field`) | **Lenient**: cosmetic |
| Per-service tokens (4.5) | Before a signed-in call to an OpenAPI server or the conversation endpoint, reads its protected resource metadata without redirects; a `resource` other than the domain, on one of the Company's hosts, gets its own token | Serves the API's metadata only with `apiResource` | **Strict** about where tokens go: a `resource` off the Company's hosts is ignored |
| `invalid_session` (7, issue 11) | A new `sid` once, keeping the account it was signed in to; a second `invalid_session` is the error. An approval is never sent on the new Session | Sends it for every failed Session-header check, an ended Session, a second account and a refused `client_id` | As the text |
| The Session header at OAuth endpoints (5.2) | Never sent there: token, device and revocation requests carry the client assertion | Records `session-jwt.oauth-endpoint` (Rule) when one arrives | As the text |
| Excluded tasks and feedback (9.1, 9.3) | Fetches the excluded-tasks document with no token, caches it within discovery's bounds, and tells the model when it couldn't be read. Feedback goes once per task per Company, never for a task the Company lists as excluded | Lists two excluded tasks and takes feedback when configured, recording a repeated or excluded report | **Strict** in what we send: 9.3's SHOULD NOT and "one report for each task" |

## <a id="settled-or-retired-by-03"></a>Settled or retired by 0.3

- **S1**, the client assertion's `aud`: the issuer (4.1). Above.
- **S4**, `scope` on a signed-out Session request: there is no Session request in 0.3; the agent makes its Sessions itself (5.2).
- **S5**, renewing a signed-in Session with an assertion: there are no Session assertions; a signed-in request carries an access token from a refresh token (4.4, 4.5).
- **S11**, `sign_in_required` without `scope`: the error is gone; a 401 challenge names the scope (8.11).
- **S13, S14**, where an ended Session's error goes: 0.3 has one, `invalid_session` with a JSON body (7).
- **S20**, what a standing permission covers, and **S22**, which writes propose operations: Operations 1 is gone, and Operations 2 has neither (issue 40).
- **Ops 3 `operation_id` characters**: 0.3 gives operation ids and revisions the characters of Conversation IDs (`parseOperationV2` in `src/poppy/operations-v2.ts`).

## Mismatches between declarations and code

The changelog ledger records implementation dispositions. It is not a conformance certificate: Appendix A names behavioral checks, and the [conformance review](poppy-0.3-conformance.md) separates automated evidence, local readings and remaining limits. The PR 36 review corrected authority, cache, migration, operation-outcome and verification gaps.

## Limits in our own verification

- The hosted agent uses the stated blind-signing exception; it does not claim device-only privacy.
- Model-boundary guards recognize credential/contact formats and explicit verification requests. They do not establish universal personal-data detection or correct interpretation of every paraphrase.
- The User must actually check an uncertain outcome before recording it; the resulting assertion is attributed to the User, while the original uncertain receipt is preserved.
- Live authenticated OAuth/payment journeys remain unverified without an allowlisted test identity and a non-production Company. Local browser, Python and pinned independent demo runs have their own stated limits.

## Scope hints and descriptions (upstream audit 30/31)

Missing scope hints are displayed and supplied to the model as irreversible changes with personal data, following the conservative Guides advice. This is a local reading of the conflict with the specification, not a new MUST. The Company's description is preserved; listed OpenAPI descriptions precede `auth.scopes`. Every sign-in still uses the User's own approval interface.

## Keeping this current

When a reading changes, change the code, the adapter's declared `readings`, and the entry here, in one commit.

## Fetch timeout for discovery documents

The Guides say to set "a timeout of a few seconds" for fetches. We read that as 10 seconds for discovery documents, OAuth metadata, client metadata and API descriptions, in the validator and the agent alike. We used 5 seconds until 12 October, when a live Company on a serverless host (print-with-poppy) took longer than that to answer after a cold start. Size and redirect limits are unchanged.
