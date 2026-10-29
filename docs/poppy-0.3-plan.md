# Plan: keeping up with weekly Poppy versions, starting with 0.3

**Decisions (owner, 28 October 2026):** PDA speaks the current Poppy version alone. Later the same day the owner dropped 0.1 and 0.2 together, and PDA now speaks only 0.3 as upstream rewrote it on 28 October ([decision 37](decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles)). Upstream ships a new version roughly every week, so a version must cost days, not weeks. [poppy-0.3-upgrade.md](poppy-0.3-upgrade.md) holds the ledger of 0.3's changelog entries; the problems in the 0.3 text are in [poppy-0.3-issues.md](poppy-0.3-issues.md).

**What changed from this plan's first assumptions:**
- ~~We support the two newest published versions, N and N−1.~~ We support one version, and it isn't published: upstream serves the 28 October text on its site without a commit. The pin is a dated snapshot (`spec/upstream.json`, `commit: null`), and `npm run spec:drift` says when the site moves. A version window, when we want one again, is a list in `src/poppy/protocol-version.ts`.
- ~~We implement published versions only.~~ We implemented the text six live Companies already declared, before upstream committed it.
- A version ships when our own checks pass on it. Live and peer evidence is recorded when it exists, and its absence is stated; it doesn't gate a release. This one stands.

## The target: a new version in two working days

| When | What happens | Who |
| --- | --- | --- |
| Publication day | A scheduled job sees the new version, imports it at its commit, generates a ledger skeleton from its changelog (every entry "Not started", Breaking ones marked), re-checks every finding in [poppy-0.3-issues.md](poppy-0.3-issues.md) against the new text, and writes a report | Automated |
| Day 1 | Implement the Breaking entries as an overlay on the previous version's profile, in client, mock and validator together; fill the ledger | One person, or a Claude session |
| Day 2 | The whole Poppy suite runs on N and N−1, the official kit runs on the N mock, the interop lanes for N run; the version that falls out of the window is removed; release | CI, then the owner |

A large version, like 0.3 with Session Keys, takes longer; most weekly versions won't.

## Build once (about a week)

These make each later version cheap. Most of the week goes on the first two.

1. **Versions as data.** One registry, `src/poppy/profiles/`, that client, mock, validator and interop runner all read. Each version is an overlay naming only what changed from the one before, each change tied to its ledger entry.
   - The 11 `isDraft2` calls become profile lookups.
   - Operations behaviour comes from `protocol_version`, since Operations changes under the same "v1" ([T36](poppy-0.3-issues.md)).
   - The validator's `draft-0.ts` becomes shared rules plus overlays.

   Done when no file outside the registry compares a version string.
2. **One suite, every supported version.** `npm test` runs the Workers and property projects once per supported version, with the mock's default version set from the run (`scripts/test-projects.mjs` gains a version axis).
   - A test that covers one version's behaviour declares it, for example `fromVersion("0.3")`. Every other test runs on all supported versions.
   - Adding a version is one line in the registry; dropping one is removing it.
   - This replaces re-basing the suite each time. Today the mock defaults to 0.1, and only 4 test files ask for 0.2.
3. **Automated intake, report only.** A scheduled workflow, daily, beside `deps.yml` and in the same report-only style, does three things and writes the result to the job summary:
   - compares the site with the newest snapshot (`spec-snapshot.mjs`) and upstream with the pins (`spec:drift`);
   - re-checks each finding's quoted phrases, so a fix upstream shows up as a phrase that no longer occurs;
   - on a newly published version, imports it.

   It opens no pull request, matching the owner's choice for dependencies. A scheduled Claude session that also drafts the Day 1 overlay as a pull request is possible, but needs the owner's approval first, since it would be an automatic pull request.
4. **Two pins.** `spec/upstream.json`, `check-spec` and `spec-import` hold one pin today; they hold the supported window instead. `spec-import` writes the ledger skeleton from the version's changelog. `check-spec` passes a skeleton while the version is inactive, and fails a Breaking entry still marked "Not started" once it is active.
5. **Docs that survive weekly changes.** Appendix A of `pda-spec.md` and `spec/grounding.md` cite upstream's anchors (`#sign-in`, `#sending-tokens`), which stay stable while section numbers move. Each version's ledger table is generated. Prose names "the supported versions" from one place instead of repeating version numbers.
6. **Retirement as a routine step.** Dropping a version removes:
   - its overlay and its mock behaviour, with their violation ids and `TAMPERS` rows;
   - its interop registry entries and the known failures scoped to it, while their committed results stay as history.

   One piece is version-agnostic, so retiring a version takes one release, not two. It is a revocation routine for a Company whose version has left the window: it tries the issuer as the assertion audience, then the endpoint, which covers every version so far. Account Tokens at such Companies are revoked on each agent's next wake, and the User is told; tokens that can't be revoked are shown as still live, as for a refused revocation today.

**Dropping 0.1 and 0.2 was the first use of 6,** on 28 October, both at once. It removed the 0.1 and 0.2 paths from client, mock and validator, Operations 1 and its tables, 33 interop entries and their known failures, the one-sided vectors and the official validator's 0.2 lanes. Not built: the version-agnostic revocation routine. A deployed agent's accounts at 0.1 and 0.2 Companies go unused rather than revoked, and those Companies are refused with "unsupported Poppy version" until they move to 0.3 (decision 37's consequences).

## Then 0.3, as rewritten on 28 October

This section follows the 28 October text ([snapshot](../spec/draft-0.3-retrieved-2026-10-28/README.md)). That text replaced the earlier 0.3 design: Session Keys and signed-out Session Tokens are gone. Every request instead carries a `Poppy-Session` header, a JWT signed per request with a delegated key, and account access is plain OAuth. The problems in that text are in [poppy-0.3-issues.md](poppy-0.3-issues.md). Upstream's repository and official kit haven't caught up with it yet.

**Status, 28 October: built on branch `poppy-0.3`, as the only version.** The client, the validator and the mock Company speak 0.3 alone; a `poppy.json` that declares 0.1 or 0.2 is refused. The mock checks the rules of 0.3 an agent could break, each with a `TAMPERS` row that breaks it, and every Poppy test runs against it with no violation or warning recorded. The choices the text didn't settle are decisions [36](decisions.md#36-draft-03-beside-02-a-client_id-per-version-our-card-before-the-companys-terms-and-sessions-that-outlive-sign-out) and [37](decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles), and the smaller readings are in [readings.md](readings.md#draft-03-readings-28-october-text).

**Shape.** `src/poppy/protocol-version.ts` names the one version and its pin. `PoppyClient.token()` returns an access token for a signed-in Session, or nothing for a signed-out one, and `resource()` adds the Session header to every request. With one version there are no overlays: the version tests (`sinceVersion`, `isVersion`) went with 0.1 and 0.2.

**What we won't do: blind signing.** 10.7 says a Personal Agent SHOULD sign blindly "unless its own systems need to see which Companies a User works with". Ours do: the agent runs on our servers, in each User's Durable Object, and makes requests while the User is away, such as scheduled tasks. A User's device can't generate every `jti` on the agent's behalf. So we sign client assertions and delegations on the server, say so in the privacy policy, and avoid 10.7's risks by never handing a signature to a device.

| # | Step | Built | Where |
| --- | --- | --- | --- |
| 1 | Discovery and validator | The issuer from `https://{domain}/.well-known/oauth-protected-resource`, with `auth.issuer` only choosing among several; `protected_resources`; the redirect rule (the last URL's path is `/.well-known/poppy.json`, with no query); sign-in types from `grant_types_supported`; `scopes_supported`, `auth.scopes` and `auth.scope_hints`; `excluded_tasks`; Operations 2 and Mediated Sign-In entries. A `Draft 0.3` validator profile with 12 new messages, each with a fixture; since 0.1 and 0.2 went, it is the only profile and the default for a document that names no version | `src/validator/profiles/draft-0.3.ts`, `src/validator/validate.ts`, `src/poppy/discovery.ts` |
| 2 | Session JWTs and delegations | A non-extractable P-256 delegated key per Company, so per User ID, in memory only; delegations signed by the key in `POPPY_SIGNING_JWKS`, four hours from an `iat` rounded down to the hour, renewed ten minutes early. Every request to an API, conversation, MCP server or the browser join carries a fresh Session JWT with `ath` when signed in. The `sid` lives in `poppy_sessions.session_id`; one new column, `used_account`, remembers the account a Session was used with after sign-out. The mock verifies delegations and Session JWTs in 5.3's order | `src/poppy/jwt.ts`, `src/poppy/client.ts`, `test/mock-company/core.ts` |
| 3 | OAuth for 0.3 | Refresh and access tokens, with refresh tokens in the sealed `poppy_accounts` rows Account Tokens used. DPoP proofs only when the issuer lists `dpop_signing_alg_values_supported`; the token's scheme is whatever `token_type` says. A service's protected resource metadata decides whether it gets a token of its own. `invalid_session` starts one new Session, keeping its account; a 401 with no error code and a `scope` is handled as `insufficient_scope`; `invalid_token` refreshes. A second account gets a new Session | `src/poppy/client.ts`, `src/poppy/signin.ts` |
| 4 | Browser join | Our browser loads the page; software reads the form's hidden code; our own request authorizes it at `{endpoint}/authorize` with the Session header and token; the browser submits the code alone. The token never reaches the browser and the code never reaches the model | `src/poppy/browser.ts`, `src/poppy/fetch-browser.ts` |
| 5 | Operations version 2 | `approval_required` from an API, an MCP error result with `structuredContent.operation`, or a Company Agent's message with `operation` puts the Company's summary on a card. Approved, the same request goes again with `Poppy-Approval` (an RFC 9651 Dictionary), MCP `_meta`, or a message's `approval`; an expired revision isn't sent; a new revision gets a new card. Our one client metadata document lists Operations 2. Every write waits for our own card first, since Operations 2 has no marker for writes that need approval (issue 40); the Company's terms are checked against the request, and any difference shown on the card (Ops 5 SHOULD) | `src/poppy/operations-v2.ts`, `src/poppy/apis.ts`, `src/poppy/conversations.ts`, `src/poppy/routes.ts` |
| 6 | The rest | Mediated Sign-In as a token-endpoint grant, with `code_required`, `sign_in_id` and `one_time_code`, and reserved field names refused; `author` on the messages we send, and the name a Company's author gives shown as text, never its picture; unknown `status` read as `working` and unknown `responder` as `human`; 0.3's scopes are the Company's own, described by `auth.scopes` | `src/poppy/signin.ts`, `src/poppy/conversations.ts`, `src/poppy/message-author.ts` |
| 7 | Interop, the ledger, task coverage and docs | The grid's adapters declare 0.3 alone, and the scenarios that need Operations 1 are retired; `spec/requirements-0.3.json` gives each of the changelog's 42 entries a disposition, which `npm run check:spec` holds to the changelog; excluded tasks are read before a task and feedback is sent once per task (`poppy_feedback`); every doc that described 0.1 or 0.2 as current says what holds at 0.3 | `interop/`, `spec/`, `src/poppy/coverage.ts`, `docs/` |

**Not done yet.**
- **The interop grid in Docker** first ran at 0.3 on 29 October ([results](interop-results/README.md#latest-run-29-october-poppy-03-our-agents-and-mocks)): our agent passed all 68 cells against both mocks and 8 of 8 against `evil-company`. The run found that CI's job had been running no cell at all, and an OpenAPI cache shared between agents; both are fixed. print-with-poppy (`b340741`) is pinned again, the first other project on the 28 October text, but its image hasn't been built: the sandbox's proxy refuses its base image's plain-HTTP apt fetches.
- **Two ports:** the adversarial agent, whose attacks were written for Session Tokens and Operations 1, and NREP, which replayed 0.2's Session request at the token endpoint. The Python Hypothesis client in `test/hypothesis/` was ported on 29 October, and found two slips in the mock's scope handling (its README).
- **What the text allows that we don't use:** anonymous browsing User IDs (5.1 MAY), since our browser always joins the User's Session; Agent IDs (5.1 MAY), since each User has one agent; Markdown in an operation's summary, shown as text, which Ops 3 allows.

**If 0.3 changes again before it is published:** the Session header and delegations are the part most likely to move, since they were invented two days before this was built. `npm run spec:drift` reports a changed page; diff it against [the 28 October snapshot](../spec/draft-0.3-retrieved-2026-10-28/README.md), take a new snapshot, and change what moved, entry by entry in the ledger.

## What no longer gates a version

| Was a gate | Now |
| --- | --- |
| 0.2's live signed-in journey | Evidence, recorded when a Company gives us a test account; it doesn't hold back 0.3 |
| Waiting for 0.3 to "settle" | Replaced by "implement published versions" |
| The four sign-in readings first | Decided in the pull request that implements them |
| A peer that speaks the version | Our mock, the official kit and our property tests are enough to ship; the changelog says which evidence exists |
| Two releases to remove a version | One, with the version-agnostic revocation routine |

## Costs and risks of going faster

- **CI time.** The Poppy projects run twice, once per supported version.
- **Thinner evidence per version.** Live Companies and peers lag a weekly cadence, so many versions ship with only our own checks and the official kit. Each release's changelog entry says so.
- **Users at Companies that lag.** A Company still on a version that has left the window becomes unreachable. The daily report shows which live Companies declare which version, and the owner can hold a retirement back a week.
- **Breaking changes to stored state.** Keep every Poppy table additive and version-tagged, and keep Sessions disposable, so a version can change how Sessions work without migrating old rows.
- **Upstream text that is wrong.** We'll implement our reading and record the issue, as now. The intake's phrase check shows when upstream fixes it.
