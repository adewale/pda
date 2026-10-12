# Our readings of the draft's open questions

Where Poppy Draft 0.1 is ambiguous, we had to pick a behaviour. This file records each pick: which reading our client takes, which our strict and lenient mock Companies take, whether we're strict or lenient there, and why. The questions themselves, with suggested fixes, are in [spec-issues.md](spec-issues.md); its "What we do" column summarises the rest, and for S1, S2, S3, S4, S7 and S23 links here, where the reading and the reasoning behind it are kept.

Back to [spec-issues.md](spec-issues.md) · [interop-spec.md §7](interop-spec.md#7-readings)

## The rule

**Strict where the ambiguity is security-relevant, lenient where it's cosmetic.**

[RFC 9413, "Maintaining Robust Protocols"](https://www.rfc-editor.org/rfc/rfc9413.html), argues that tolerating the unexpected (Postel's "be liberal in what you accept") lets one implementation's bug become everyone's de facto protocol, and that a protocol stays healthy when implementers choose deliberately what to accept, and say so. So:

- **What we send** takes the narrowest reading: the one every reading accepts, where there is one.
- **What we accept** is strict where a wrong guess could widen access, mix up identities or let something replay: the mocks refuse it, or record a named violation (`test/mock-company/violations.ts`) when the draft gives a Company no error to send.
- **What we accept** is lenient where the readings differ only in shape (an error's location, a cursor's spelling, a missing display name) and every reading leads to the same access.
- **How it's graded** is a separate matter from what we do. A check that rests on a reading is tentative everywhere: a warning in the mock, the validator and the grid, and a failure it causes is the spec's ([conformance-levels.md](conformance-levels.md)). Being strict in behaviour never makes the other side's departure a violation.

## The three implementations

| Name | What it is | Settings |
| --- | --- | --- |
| **Client** | `src/poppy/`, the Personal Agent; `dpa` in the [interop registry](../interop/registry.json) | One behaviour |
| **Strict mock** | `test/mock-company/` with its defaults (`DEFAULT_CONFIG` in `types.ts`), as the conformance tests run it; `dpa-mock-strict` in the grid | `strictAssertions: true`, `clientAssertionAud: "lenient"`, `nonceScope: "company"` |
| **Lenient mock** | The same mock with `strictAssertions: false`; `dpa-mock`, the grid's reference Company for attribution rule 2 | As the strict mock, except S2. Both report every check with its basis and level; a warning or reading never fails a cell ([conformance-levels.md](conformance-levels.md)) |

The conformance tests also run sign-in, Sessions and sign-out under six other profiles (`PROFILES` in `test/poppy.test.ts`): exact `aud` (S1), a DPoP nonce per origin and per Company (S23), lenient assertions (S2), a trailing-slash issuer (S7), and an issuer with a path (S3). So the client is tested against both answers to S1, S2, S7 and S23, and against an issuer with a path, not only the mock's default.

## Section 7 questions (declared in the grid)

Each adapter declares these in its manifest (`readings` in `interop/impls/dpa-agent/adapter.ts` and `interop/impls/dpa-mock/adapter.ts`), and the runner checks the agent's declaration against its trace (`interop/runner/readings.ts`).

| Id | Question | Client | Strict mock | Lenient mock | Strict or lenient |
| --- | --- | --- | --- | --- | --- |
| [S1](spec-issues.md#s1) | Client assertion `aud` | `endpoint` | `either` | `either` | Client strict; mocks lenient among values that all name this Company, strict otherwise |
| [S2](spec-issues.md#s2) | Assertion `typ` and lifetime | `jwt-60s` | `jwt-60s` | `lenient-300s` | Strict, except the reference Company |
| [S3](spec-issues.md#s3) | Metadata location for an issuer with a path | `insertion` | `insertion` | `insertion` | Strict |
| [S4](spec-issues.md#s4) | `scope` on a signed-out Session request | `omit` | `either` | `either` | Client strict; mocks lenient |
| [S23](spec-issues.md#s23) | DPoP nonce scope | `per-origin` | `per-company` | `per-company` | Lenient, both sides |

### <a id="s1"></a>S1: the client assertion's `aud`

- **Client:** the endpoint the assertion is sent to, as a single string: `clientAssertion(signing, clientId, endpoint)` in `oauthRequest` (`src/poppy/client.ts`), called with the token, device authorization or revocation endpoint. That's the narrowest audience, and every Company in the grid that checks `aud` accepts it.
- **Mocks:** `authenticateClient` in `test/mock-company/core.ts` accepts the endpoint called, the token endpoint or the issuer (`clientAssertionAud: "lenient"`). It refuses an array (`client-assertion.aud-array`) and anything else (`client-assertion.aud`). The `exact` setting, tested as a profile, accepts only the endpoint called.
- **Why.** `aud` is security-relevant: it stops an assertion made for one server being replayed at another. All three accepted values name this Company, so accepting any of them can't let in an assertion made for someone else, and the assertion's `jti` is single-use across all three endpoints (`freshJti`). The three readings differ only in which of this Company's names is used, which is cosmetic. Being lenient there lets the mock tell an agent's real faults from this open question.

### <a id="s2"></a>S2: assertion `typ`, `kid` and lifetime

- **Client:** header `typ: "JWT"`, a `kid` naming a published key, and `exp` 60 s after `iat`, on both client and Session assertions (`ASSERTION_SECONDS` in `src/poppy/jwt.ts`).
- **Strict mock:** refuses an assertion without `typ: "JWT"` (`client-assertion.typ`, `session-assertion.typ`), without a published `kid` (`.kid`), or living longer than 60 s (`.lifetime`).
- **Lenient mock:** no `typ` or `kid` needed, and assertions up to 300 s (`MAX_ASSERTION_LIFETIME`), which it declares as `lenient-300s`: the runner counts it compatible with agents reading `jwt-60s`, `lenient-120s` or `lenient-300s`, not with `any`. (`lenient-120s`, any `typ` and at most 120 s, is print-with-poppy's reading, and Datalayer 0.10.0's.) It still refuses a DPoP proof or browser assertion used as one (`client-assertion.wrong-typ`, `session-assertion.browser-typ`), an algorithm other than ES256 or RS256, a bad signature against the published keys, and a reused `jti`, and records an embedded key (`.embedded-key`).
- **Why.** The parts that stop confusion and replay are strict in both mocks: a distinct `typ` for the other JWT kinds (see N25), a signature from a published key, single-use `jti`. Requiring `typ: "JWT"` on top, and 60 s rather than 300, is what the strictest live Companies do, so the client sends it and the strict mock checks it. The lenient mock is the grid's reference Company: its job is attribution, not gatekeeping, and the interop spec treats S2 as a warning. If it refused typ-less agents, every cell for pi-poppy's and adonis-agora's agents would stop at the first token request and nothing past it would be tested. `dpa-mock-strict` runs in the same grid, so the strict reading is still checked.

### <a id="s3"></a>S3: metadata location for an issuer with a path

- **Client:** RFC 8414 §3.1 insertion: `/.well-known/oauth-authorization-server` between the host and the issuer's path (`metadataUrl` in `src/validator/fetch.ts`, used by discovery through `validateCompany`). It doesn't fall back to the appended form. Tested in `test/validator.test.ts` with a `/tenant/` issuer.
- **Mocks:** the issuer is `https://auth.<domain>` with no path by default (optionally with a trailing slash). With `issuerPath` (`/tenant`), it is `https://auth.<domain>/tenant` and the metadata is served only at the inserted location, `/.well-known/oauth-authorization-server/tenant`; the appended one is 404. The conformance tests run sign-in, Sessions and sign-out under that profile too, and the grid's `DP` scenario (the `issuer_path` hook) runs it between our agent and both mocks.
- **Why strict.** This isn't cosmetic: it decides which document is trusted as the issuer's. RFC 8414, which the draft builds on, has one answer. Falling back would make two requests where one should do, and would entrench a misreading RFC 9413 warns about. The security control is that the metadata's `issuer` must equal `auth.issuer` exactly (`metadata-issuer-mismatch`), and that holds either way.

### <a id="s4"></a>S4: `scope` on a signed-out Session request

- **Client:** never sends `scope` on the jwt-bearer grant; only `resource` narrows it (`src/poppy/client.ts`, the comment "A signed-out token has no scopes (4.2)").
- **Mocks:** `#jwtBearer` in `test/mock-company/auth.ts` ignores `scope` and issues a token with no scopes, whatever was asked.
- **Why.** The client sends the reading no Company rejects (three reject `scope` there). The mocks accept both because the parameter can't widen anything: a signed-out token gets no scopes either way. That makes it cosmetic as far as access goes.

### <a id="s23"></a>S23: DPoP nonce scope

- **Client:** keeps the latest `DPoP-Nonce` per server origin (`#nonces` in `src/poppy/client.ts`), at the token endpoint and at resources, and retries once on `use_dpop_nonce`. That works with a Company that keeps one nonce for all its origins, at the cost of one extra round trip per origin.
- **Mocks:** one nonce for the whole Company (`nonceScope: "company"`) when nonces are required (`requireNonce`, off by default; the `require_nonce` hook in the grid). The `origin` profile is tested too.
- **Why lenient.** A server nonce only bounds how long a proof stays fresh; neither scope gives more access. The strict part is elsewhere: once a key has used a nonce at a server, dropping it is recorded (`dpop.nonce-ignored`), and proofs are checked for `htm`, `htu`, `ath`, `iat` and `jti` replay.

## Other questions we had to answer

These aren't declared in the grid's manifests, because they don't change what goes on the wire in a way the runner can check, or only one side has a choice to make.

| Id | Client | Mocks (both) | Strict or lenient, and why |
| --- | --- | --- | --- |
| [S5](spec-issues.md#s5) Renewing a signed-in Session | Renews with the Account Token (`refresh_token` grant), never the Session assertion | Records `token.signed-in-renewed-with-assertion`, then issues a signed-out token | **Strict.** An assertion mustn't keep a Session signed in to an account. The mock records it rather than refusing because the draft defines no error. |
| [S6](spec-issues.md#s6) "Same domain" for `jwks_uri` and `redirect_uris` | Publishes both on `PUBLIC_ORIGIN` itself; the validator accepts the same host or a parent or child host | Requires exactly the `client_id`'s host (`client-metadata.jwks-uri`, `.redirect-uris`); refuses a redirect on the `client_id` fetch (`client-metadata.fetch-status`) | **Strict** in the mocks: these bind our keys and redirects to our identity. The validator is broader only because it has no Public Suffix List, and says so. The refused redirect follows the Guides ("Fetch the `client_id` URL without following redirects"), a recommendation. |
| <a id="s7"></a>[S7](spec-issues.md#s7) Trailing slashes in the issuer | Compares exactly: metadata `issuer` against `auth.issuer` (`metadata-issuer-mismatch`), and `iss` on redirects | Publishes one string everywhere; the trailing-slash profile is tested | **Strict.** The issuer is the Company's identity; normalising it invites mix-up (RFC 9207). |
| [S8](spec-issues.md#s8) A retry after sign-out | n/a (Company side) | The 7.11 check comes first, for a later message and a retried first message alike: `sign_in_required` | **Strict**, since the original can include account data. The retried first message skipped the check until the Hypothesis model (`test/hypothesis`) caught it. |
| [S9](spec-issues.md#s9) Message-id idempotency | 128-bit ids, reused with the same content on retry | Ids are per `client_id` and User ID, not per conversation. The same content (the same JSON value, whatever its members' order: `canonicalJson`) returns the original, including a first message retried to the conversation it started; different content is 409 `message_id_conflict` and `message.id-reused` | **Lenient** on where a retry may go (cosmetic: it's the same message); **strict** on changed content, which could be a different action under an old id. |
| [N4](spec-issues.md#n4) Which Sessions a revoked Account Token signs out | Revokes the replaced token after a step-up, as 4.4 recommends (SHOULD) | Signs out the Sessions signed in with that token or one it was rotated from (`grant` in `test/mock-company/core.ts`), not the account's other sign-ins; reuse detection revokes only the reused token's own sign-in | **Strict**, to the letter of 4.9: signing out more than was revoked is harmless for access but hides N4 from our tests. Found by the Hypothesis model (`test/hypothesis`); the mock used to sign out the whole account. |
| [S10](spec-issues.md#s10) Cursor on an empty first read | Opaque; stores only strings, so `null`, `""` or an id all work | The last event's id, else the cursor it was given (`null` first) | **Lenient.** Cosmetic. |
| [S11](spec-issues.md#s11) `sign_in_required` has no `scope` | Asks for the scopes the task needs | `sign_in_required` without `scope`; `insufficient_scope` names it | **Lenient.** The User consents to the scopes either way. |
| [S12](spec-issues.md#s12) Who may write in a Direct Conversation | Sends only the User's own words, as `human` | Records `direct.agent-words` and `direct.agent-words-later`, and accepts the message | **Strict**, on our reading of 7.10 ("The Personal Agent sends the User's messages as written, with `sender: "human"`"), which has no keyword: a Direct Conversation is the User's. Mislabelling the agent's words as `human` would break 7.8's MUST, but these checks catch the agent's own words, labelled `agent`. Recorded, not refused, because the draft has no error for it. |
| [S13](spec-issues.md#s13), [S14](spec-issues.md#s14) Errors for an ended Session, and where DPoP errors go | Reads `WWW-Authenticate` on 401, then an `invalid_session` body on 400 or 401; either starts a new Session | 401 with both `WWW-Authenticate` and a JSON body; `endedSessionError: "invalid_session"` sends poppy-demo's 400 body instead | **Lenient.** Where the error is written is cosmetic; every reading leads to a new Session, never to more access. |
| [S15](spec-issues.md#s15) `queued` on handoff | Doesn't depend on it | Says `queued`, as 7.9 describes (no keyword); `neverQueued` goes straight to `working` | **Lenient.** Cosmetic. |
| [S16](spec-issues.md#s16) Approving zero scopes | Not exercised | A test can approve zero scopes; the mock then signs in with an empty scope | Undecided; no test covers it. |
| [S17](spec-issues.md#s17) Another User ID on the same account | n/a | A conversation that used an account may be continued by any Session of the same `client_id` signed in to that account | Lenient, matching "belongs to that account" literally. The `client_id` check stays strict. |
| [S18](spec-issues.md#s18) `web` without a URL, a missing `organization.name` | Shows the domain when the name is missing; `web: {}` means the site at `organization.domain` | Always publish a name | **Lenient** in the client: a missing name is cosmetic. The validator reports a missing `organization.name` as an error, since the required `organization` is "Display name and domain" (3.1, a rule without a key word; [conformance-levels.md](conformance-levels.md)), but our client tolerates it. |
| [S19](spec-issues.md#s19) Algorithms | Signs only ES256 | Accepts ES256 and RS256 for assertions and DPoP | Client strict in what it sends; mocks lenient. Both follow the Guides: "Support ES256 and RS256, and sign with ES256 when you can"; the spec names no algorithm. The validator warns when metadata offers neither. |
| [S20](spec-issues.md#s20) What a standing permission covers | Covers an operation only at that account, if its summary contains the permission's action word, every amount is in its currency and within its limit, and it has uses left and hasn't expired; a limit the terms don't let it check means asking the User | n/a: a Company can't see the approval | **Strict**, as far as the draft allows: it spends money without asking. Still a heuristic; see the spec's open questions. |
| [S21](spec-issues.md#s21) Local agents | Hosted identity only | Refuses a `client_id` that isn't `https` (`client-metadata.not-https`) | **Strict.** The identity is the `client_id`'s HTTPS origin. |
| [S22](spec-issues.md#s22) Which writes propose operations | At a Company with Operations, writes go to the Company, expecting a proposal; without it, our own approval card first | Proposes when the client lists Operations | **Lenient, knowingly.** A write that isn't proposed would act at once, which is security-relevant. Gating every write locally would make the User approve twice at every Ops Company. It's an open risk in the spec ("Writes at Companies with the Operations extension"). |

## Mismatches between declarations and code

None known. The three found while writing this were fixed: `dpa-mock` now declares S2 `lenient-300s`, which is what it enforces; the mocks can serve an issuer with a path, so `insertion` is tested; and [interop-spec.md §4](interop-spec.md#4-manifest)'s example manifest shows the `dpa` adapter's own readings.

## Gaps in our own code

- None known. (S8 in the mock, a retried first message answered without the 7.11 check, was closed when the Hypothesis model found it.)

## Keeping this current

When a reading changes, change the code, the adapter's declared `readings`, the entry here, and the "What we do" cell in [spec-issues.md](spec-issues.md) where it summarises rather than links, in one commit.
