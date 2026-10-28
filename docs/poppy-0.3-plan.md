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

**Shape.** 0.2 and 0.3 now differ in how a request is authorised, not just in details, so the profile for each version supplies a *session model* behind one interface. The rest of the client calls that interface and doesn't change for the version:
- **0.2:** the existing Session Tokens from the JWT bearer grant, with DPoP.
- **0.3:** a Session JWT on every request, plus an OAuth access token when signed in, plus a DPoP proof when that token is DPoP-bound.

Discovery, Direct and Device Sign-In, conversations, APIs and browsing stay shared, with 0.3's differences as overlays.

**What we won't do: blind signing.** 10.7 says a Personal Agent SHOULD sign blindly "unless its own systems need to see which Companies a User works with". Ours do: the agent runs on our servers, in each User's Durable Object, and makes requests while the User is away, such as scheduled tasks. A User's device can't generate every `jti` on the agent's behalf. So we sign client assertions and delegations on the server, say so in the privacy policy, and avoid 10.7's risks by never handing a signature to a device.

**Work, in order** (sizes as before: S a day or less, M a few days):

| # | Step | What | Size |
| --- | --- | --- | --- |
| 1 | Discovery and validator | The issuer from `https://{domain}/.well-known/oauth-protected-resource`, with `auth.issuer` only when it lists several; `protected_resources`; the well-known-path redirect rule; sign-in types from `grant_types_supported`; `scope_hints`; `excluded_tasks`; extension entries. A `draft-0.3` validator profile. Today `src/poppy/discovery.ts` reads the issuer from `poppy.json` only | M |
| 2 | Session JWTs and delegations | A P-256 delegated key per User ID in each Durable Object, non-extractable. Delegations are signed by the key in `POPPY_SIGNING_JWKS`, live 24 hours at most, and are renewed early with rounded times, as the guides suggest. A random `sid` per Session replaces `session_id` in `poppy_sessions`, as an additive column. Each request is signed in one place, `src/poppy/jwt.ts`, called from `PoppyClient.resource`. The mock verifies delegations and Session JWTs first, as 5.3 orders | M |
| 3 | OAuth for 0.3 | Refresh and access tokens; Account Tokens keep their sealed storage. DPoP only when the issuer lists `dpop_signing_alg_values_supported`, reusing today's DPoP code. Tokens for one service when its protected resource metadata names another `resource`. New errors: `invalid_session`, where we start one new Session and then stop; a 401 with no error code, handled as a scope request; `invalid_token`, where we refresh. Under 0.3, drop `account_mismatch`, `sign_in_required` and the `rate_limited` body, and use a new Session for a second account | M |
| 4 | Browser join | GET the page, POST the code to `{browser_session_endpoint}/authorize` with the Session header and token, then submit the form. The code never reaches the model, and the token never reaches the browser | S |
| 5 | Operations version 2 | A write answered with `approval_required` and the operation shows the User a card with the `summary`, `terms` and `expires_at`. The approved request is then repeated, with `Poppy-Approval` (an RFC 9651 Dictionary, which needs a small serializer), MCP `_meta`, or a conversation message's `approval` field. A 503 waits for `Retry-After`. Under 0.3 there is no confirm, cancel or standing permission; `src/poppy/operations.ts` and `approvals.ts` keep v1 for 0.2 only. Writes at Companies without the extension keep our own approval card | M–L |
| 6 | The rest | Mediated Sign-In as a token-endpoint grant (form parameters, the `code_required` error, `sign_in_id` and `one_time_code`); `author` on messages, showing the name and not the picture; unknown status and responder values; feedback without `kind`, and its 200 alternative; excluded tasks as Company content | S each |
| 7 | Interop and docs | A 0.3 lane for our agent and mock, and the official kit once upstream publishes one for this design. The ledger for 0.3's 42 changelog entries, three of them about the guides. Readings for the open problems we take a side on | M |

Step 2 is the foundation. After it, steps 3 to 6 are independent, and two people can split them. For one person that is about three weeks; with the weekly machinery already built and two people after step 2, about two.

**Mock first, every step.** The mock Company implements each 0.3 rule before the client does, with a violation id for every MUST it checks. 5.3's verification, at-most-once Operations and the browser join's code checks matter most there, because no other 0.3 Company exists to catch our mistakes.

**If 0.3 changes again before it is published:** of this list, step 2 is the most likely to move, since it was invented two days ago. That is why the weekly plan builds published versions only. This sketch is the order to use when 0.3 is published, not a reason to start on the in-progress text.

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
