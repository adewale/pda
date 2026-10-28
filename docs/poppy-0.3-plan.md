# Plan: keeping up with weekly Poppy versions, starting with 0.3

**Decisions (owner, 28 October 2026):** PDA speaks the current Poppy versions and drops 0.1 now. Upstream ships a new version roughly every week, so a version must cost days, not weeks. This replaces the first version of this plan, which treated 0.3 as a one-off migration. [poppy-0.3-upgrade.md](poppy-0.3-upgrade.md) still says what each 0.3 change touches; the problems in the 0.3 text are in [poppy-0.3-issues.md](poppy-0.3-issues.md).

**Assumptions, for the owner to correct:**
- We support the **two newest published versions**, N and N−1, and drop anything older when a new one arrives. Today that is 0.2, and 0.3 once it is published.
- We implement **published** versions, the ones the changelog marks frozen, never upstream's in-progress `main`. A version's intake starts the day it is published.
- A version ships when our own checks pass on it. Live and peer evidence is recorded when it exists, and its absence is stated; it no longer gates a release.

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

**Dropping 0.1 is the first use of 6,** in the same week. It means:
- deleting the 0.1 paths in `client.ts` (endpoint-audience fallback), discovery (`www.` normalisation), `apis.ts` (Bearer-by-default MCP), `signin.ts` (device-link hosts) and `conversations.ts` (lenient read shape);
- moving the validator's versionless default to the newest version;
- retiring 26 interop entries and 42 known failures;
- moving the Python Hypothesis client to 0.2;
- showing a clear "this Company uses a version we no longer support" message.

## Then 0.3, as rewritten on 28 October

This section follows the 28 October text ([snapshot](../spec/draft-0.3-retrieved-2026-10-28/README.md)). That text replaced the earlier 0.3 design: Session Keys and signed-out Session Tokens are gone. Every request instead carries a `Poppy-Session` header, a JWT signed per request with a delegated key, and account access is plain OAuth. The problems in that text are in [poppy-0.3-issues.md](poppy-0.3-issues.md). Upstream's repository and official kit haven't caught up with it yet.

**Status, 28 October: steps 1 to 6 are built on branch `poppy-0.3`, beside 0.2 and 0.1.** The client, the validator and the mock Company speak 0.3 when a Company's `poppy.json` says `"0.3"`; nothing changes for a Company on 0.1 or 0.2. The mock checks 51 rules of 0.3 that an agent could break, each with a `TAMPERS` row that breaks it, and `test/poppy-0.3.test.ts` drives our client through every step against it with no violation or warning recorded. The three choices the text didn't settle are [decision 36](decisions.md#36-draft-03-beside-02-a-client_id-per-version-our-card-before-the-companys-terms-and-sessions-that-outlive-sign-out), and the smaller readings are in [readings.md](readings.md#draft-03-readings-28-october-text). What is left is step 7 and the list under "Not done yet".

**Shape.** Versions are ordered in `src/poppy/protocol-version.ts`; a rule a later version keeps is asked for with `sinceVersion(company, "0.2")`, and one only 0.3 has with `isVersion(company, "0.3")`, so `isDraft2` is gone. The session model splits inside `PoppyClient`: `token()` returns a Session Token before 0.3, and from 0.3 an access token for a signed-in Session or nothing for a signed-out one; `resource()` adds the Session header at 0.3. Discovery, Direct and Device Sign-In, conversations, APIs and browsing stay shared, with 0.3's differences as overlays.

**What we won't do: blind signing.** 10.7 says a Personal Agent SHOULD sign blindly "unless its own systems need to see which Companies a User works with". Ours do: the agent runs on our servers, in each User's Durable Object, and makes requests while the User is away, such as scheduled tasks. A User's device can't generate every `jti` on the agent's behalf. So we sign client assertions and delegations on the server, say so in the privacy policy, and avoid 10.7's risks by never handing a signature to a device.

| # | Step | Built | Where |
| --- | --- | --- | --- |
| 1 | Discovery and validator | The issuer from `https://{domain}/.well-known/oauth-protected-resource`, with `auth.issuer` only choosing among several; `protected_resources`; the redirect rule (the last URL's path is `/.well-known/poppy.json`, with no query); sign-in types from `grant_types_supported`; `scopes_supported`, `auth.scopes` and `auth.scope_hints`; `excluded_tasks`; Operations 2 and Mediated Sign-In entries. A `Draft 0.3` validator profile with 12 new messages, each with a fixture; the default for a document that names no version stays 0.2, the newest published one | `src/validator/profiles/draft-0.3.ts`, `src/validator/validate.ts`, `src/poppy/discovery.ts` |
| 2 | Session JWTs and delegations | A non-extractable P-256 delegated key per Company, so per User ID, in memory only; delegations signed by the key in `POPPY_SIGNING_JWKS`, four hours from an `iat` rounded down to the hour, renewed ten minutes early. Every request to an API, conversation, MCP server or the browser join carries a fresh Session JWT with `ath` when signed in. The `sid` lives in `poppy_sessions.session_id`; one new column, `used_account`, remembers the account a Session was used with after sign-out. The mock verifies delegations and Session JWTs in 5.3's order | `src/poppy/jwt.ts`, `src/poppy/client.ts`, `test/mock-company/core.ts` |
| 3 | OAuth for 0.3 | Refresh and access tokens, with refresh tokens in the sealed `poppy_accounts` rows Account Tokens used. DPoP proofs only when the issuer lists `dpop_signing_alg_values_supported`; the token's scheme is whatever `token_type` says. A service's protected resource metadata decides whether it gets a token of its own. `invalid_session` starts one new Session, keeping its account; a 401 with no error code and a `scope` is handled as `insufficient_scope`; `invalid_token` refreshes. A second account gets a new Session | `src/poppy/client.ts`, `src/poppy/signin.ts` |
| 4 | Browser join | Our browser loads the page; software reads the form's hidden code; our own request authorizes it at `{endpoint}/authorize` with the Session header and token; the browser submits the code alone. The token never reaches the browser and the code never reaches the model | `src/poppy/browser.ts`, `src/poppy/fetch-browser.ts` |
| 5 | Operations version 2 | `approval_required` from an API, an MCP error result with `structuredContent.operation`, or a Company Agent's message with `operation` puts the Company's summary on a card. Approved, the same request goes again with `Poppy-Approval` (an RFC 9651 Dictionary), MCP `_meta`, or a message's `approval`; an expired revision isn't sent; a new revision gets a new card. A 0.3 Company gets its own client_id, whose metadata lists Operations 2, so 0.2 Companies keep Operations 1 | `src/poppy/operations-v2.ts`, `src/poppy/apis.ts`, `src/poppy/conversations.ts`, `src/poppy/routes.ts` |
| 6 | The rest | Mediated Sign-In as a token-endpoint grant, with `code_required`, `sign_in_id` and `one_time_code`, and reserved field names refused; `author` on the messages we send, and the name a Company's author gives shown as text, never its picture; unknown `status` read as `working` and unknown `responder` as `human`; 0.3's scopes are the Company's own, described by `auth.scopes` | `src/poppy/signin.ts`, `src/poppy/conversations.ts`, `src/poppy/message-author.ts` |
| 7 | Interop and docs | Not started: see below | |

**Not done yet.**
- **Interop.** The grid's adapters declare 0.1 and 0.2 only (`interop/impls/pda-agent/adapter.ts`, `interop/impls/pda-mock/adapter.ts`), so there is no 0.3 cell, and the official kit has no 0.3 checker to run. Adding `"0.3"` to both adapters and a 0.3 profile to the scenarios is the next step; the mock and client already speak it.
- **The changelog ledger** for 0.3's 42 entries, mapping each to the code above or to "not ours".
- **Things the text allows that we don't use:** anonymous browsing User IDs (5.1), Agent IDs, excluded tasks read before a task (9.1 SHOULD; discovery keeps the URL), feedback reports (9.3 MAY; so the 200 alternative is never received), Markdown in an operation's summary (shown as text, which Ops 3 allows) and checking `terms` against the summary (Ops 5 SHOULD).
- **Retiring 0.1**, which comes after 0.3 is published and pinned, with the version-agnostic revocation routine from "Build once".

**If 0.3 changes again before it is published:** the Session header and delegations are the part most likely to move, since they were invented two days before this was built. The weekly plan builds published versions; this branch builds an unpublished one so the plan's steps are tested before 0.3 is pinned. When it is pinned, diff the pinned text against [the 28 October snapshot](../spec/draft-0.3-retrieved-2026-10-28/README.md) and change what moved.

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
