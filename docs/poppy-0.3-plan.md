# Plan: keeping up with weekly Poppy versions, starting with 0.3

> **The 0.3 section is out of date since 28 October 2026.** The draft dropped Session Keys and the JWT bearer grant for a signed `Poppy-Session` header with delegated keys and optional blind signing, moved Operations to version 2 and Mediated Sign-In to an extension grant ([snapshot](../spec/draft-0.3-retrieved-2026-10-28/README.md)). The weekly machinery and the removal of 0.1 still stand; the list of 0.3 work needs redoing against the new text.

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

## Then 0.3 (about 1.5 to 2 weeks, once published)

0.3 is the largest change since 0.1, so it costs more than a typical week. The machinery doesn't make the Session Key rewrite small, but it does mean 0.2 keeps working unchanged beside it. In order, each a pull request against the 0.3 overlay:

1. **Discovery and validator.** `protected_resources`, sign-in types from `grant_types_supported`, `scopes_supported`, `auth.scopes`, `scope_hints`, `excluded_tasks`, the well-known-path redirect rule and loopback redirect URIs.
2. **Session Keys and the token endpoint.** This includes `invalid_grant`, `dpop_jkt`, `scope` per RFC 6749 and `insufficient_scope`. Decide the readings for [T1, T2, T3 and T34](poppy-0.3-issues.md) in this pull request, not before it. Sessions are version-tagged and disposable, so a Company moving from 0.2 to 0.3 just gets new Sessions; its User ID stays, and its Account Token is tried with a new Session Key.
3. **Scopes and cards,** the **browser join,** **MCP by Token Exchange,** **`author`** (show the name, not the picture, [T39](poppy-0.3-issues.md)), and **excluded tasks.** These are independent of each other once step 2 lands, so they can go in parallel.

If 0.4 is published while 0.3 is in progress, the intake imports it and its Breaking entries go into a 0.4 overlay on top. The window becomes 0.3 and 0.4 when both are done, and 0.2 retires then.

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
