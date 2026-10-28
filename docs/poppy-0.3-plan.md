# Plan: Poppy 0.3, keeping 0.2, dropping 0.1

**Decision (owner, 28 October 2026):** PDA will speak Poppy 0.2 and 0.3, and stop speaking 0.1. This plan replaces the three-version assumption in [poppy-0.3-upgrade.md](poppy-0.3-upgrade.md), whose table of what each 0.3 change touches still stands. The problems in the 0.3 text are in [poppy-0.3-issues.md](poppy-0.3-issues.md).

## What we end with

- **The client** accepts a `poppy.json` declaring `0.2` or `0.3`. One declaring `0.1` is refused like any other unsupported version, before metadata or credentials are used, and the User is told the Company uses a version this agent no longer supports.
- **One agent, both versions.** Each Company is handled by its own declared version. A Company that moves from 0.2 to 0.3 keeps its User ID and, where the Company honours it, its Account Token.
- **The validator** has 0.2 and 0.3 profiles. A 0.1 document gets an "unsupported version" error. Versionless client metadata is checked against the newest profile unless the caller names another.
- **The mock Company, interop grid and property tests** run 0.2 and 0.3 lanes. 0.1 results stay committed as history.
- **Nothing is lost silently.** Account Tokens held at 0.1 Companies are revoked before 0.1 code is removed, wherever the agent wakes in time, and the User is told about any that couldn't be.

## Why 0.1 can go, and what it costs

Every live Company we have tested recently declares 0.2: Alpine Retail, Crosswalk, Stacktree, PlanMyVisit, Safe Rate and Print with Poppy ([live-0.2-testing.md](live-0.2-testing.md)). Upstream froze 0.1 and 0.2, and Datalayer's SDK already dropped 0.1. Keeping three profiles would triple every version branch, test lane and table.

The cost:

| What | Today | After |
| --- | --- | --- |
| Live 0.1 Companies | Ilmer and Poppyseed live entries default to 0.1; PAP Checker's directory listed only 0.1 hosts on 18 October | Unreachable; the agent says why |
| Interop registry | 26 of 40 entries are 0.1 (pinned peers, our fakes, Datalayer 0.17) | Retired; peers with a 0.2 release re-pinned |
| Known failures | 42 of 44 are scoped to 0.1 | Retired with their lane |
| Our own tests | The mock defaults to 0.1; only 4 test files ask for 0.2 | The default becomes 0.2; most of the Poppy suite is re-based |
| Datalayer conformance vectors | 0.1 cases | Retired, or replaced by their 0.2 set |
| Hypothesis client (Python) | Written for 0.1, accepts any `0.x` | Updated to 0.2, then 0.3 |

## Phases

Each phase is its own pull request and leaves `main` releasable. Phases 1 and 2 don't depend on 0.3 settling; phase 3 does.

### Phase 0. Prerequisites (no code)

1. **Settle open branches.** Merge or close #20, #26 and #27. #26 changes the interop runner that phase 2 edits.
2. **Close 0.2.** Run the signed-in 0.2 journey on a live Company with a test account: sign-in, an authenticated read, an approved sandbox operation, revocation ([live-0.2-testing.md](live-0.2-testing.md#remaining-account-checks)). Then promote the CHANGELOG's Unreleased entry to a release. That release is the rollback point that still speaks 0.1.
3. **A dated survey of live versions.** Run discovery against every live registry entry and the directory's hosts, and record each `protocol_version`. If a Company the owner relies on is still 0.1, decide before phase 2 whether to wait for it.
4. **Write the readings** for the 0.3 questions that decide the token endpoint: [T1](poppy-0.3-issues.md), T2, T3 and T34, in [readings.md](readings.md), and ask the owner whether to send them upstream.

### Phase 1. Version profiles, no behaviour change (2 to 3 days)

1. **Replace the `isDraft2` boolean** (11 calls in `src/poppy/`) with a profile chosen once per Company from its declared version: `profileFor(company)` returning an object with the behaviour each call site needs (assertion audience, MCP token mode, device-link hosts, read shape, discovery comparison). Unknown versions still throw.
2. **Operations behaviour by `protocol_version`,** not the extension's `version`, because Operations changed under "v1" ([T36](poppy-0.3-issues.md)).
3. **Split the validator's `draft-0.ts`** into shared rules and a 0.1 overlay, mirroring `draft-0.2.ts`, so removing 0.1 later deletes a file instead of editing shared code.
4. **Make the mock's version a required test parameter** with a single default constant, so phase 2 flips one value.

Done when the full suite passes unchanged and no file outside `protocol-version.ts` compares a version string.

### Phase 2. Remove 0.1 (about a week)

Two releases, because the binary that removes 0.1 can't speak 0.1 to clean up after it.

**Release A, the last that speaks 0.1: retire 0.1 accounts.**
- On each agent's next wake, find accounts whose Company's cached profile is 0.1. Revoke each Account Token through the existing sign-out path (`src/poppy/signout.ts`, `poppy_signouts`, with its retries), and tell the User on a notice and the Companies page.
- Work bound to a 0.1 Company in `poppy_task_contexts` is held and shown as needing the User, never replayed.
- The Worker can't count accounts across Durable Objects, so this runs per agent. Ship A, then wait at least a week, longer if the survey found 0.1 Companies Users rely on.

**Release B: 0.1 is gone.**
- **Client.** `PROTOCOL_VERSIONS` becomes `["0.2"]`. Delete the 0.1 paths:
  - the endpoint-audience fallback in `src/poppy/client.ts`;
  - the requested-host comparison with `www.` normalisation in discovery;
  - Bearer-by-default MCP and redirect-following for MCP metadata in `src/poppy/apis.ts`;
  - 0.1 device-link hosts in `src/poppy/signin.ts`;
  - the lenient 0.1 read shape in `src/poppy/conversations.ts`.
- **Leftover 0.1 tokens** from agents that didn't wake under A stay sealed and unused. The Companies page tells the User access may stay live until it expires, or until they remove it at the Company, as for a refused revocation today.
- **Unsupported-version message.** A clear card and Companies-page line instead of a generic discovery error.
- **Mock and tests.**
  - The default becomes 0.2.
  - 0.1-only mock behaviour and its violation ids go, with their `TAMPERS` rows; the catalogue test enforces all three together.
  - Tests that asserted 0.1 behaviour are deleted or re-based on 0.2, never weakened.
  - Property tests that model the key per User are re-based on 0.2.
- **Validator.** Remove the 0.1 profile and change the versionless default in `validate.ts` from `"0.1"` to `"0.2"`. Update messages that use `"0.1"` as the example version.
- **Interop.**
  - Retire the 0.1 registry entries and the known failures scoped to 0.1; keep their committed results under `docs/interop-results/` as history.
  - Re-pin peers that ship 0.2: Datalayer 0.25 or later, and Print with Poppy at its 0.2 commit. Drop peers that don't ship 0.2 from the grid until they do.
  - The mock adapter's `INTEROP_POPPY_VERSION` accepts only `0.2`, and later `0.3`.
- **Hypothesis client.** Move `test/hypothesis/poppy_client.py` to 0.2: issuer audience, final-host discovery, DPoP for MCP.
- **Docs.**
  - `pda-spec.md`'s version statement and Appendix A move from 0.1 sections to 0.2 sections. This is the largest single edit; `check:docs` guards its test names.
  - Do the same in `spec/grounding.md`, `docs/capabilities.md`, `docs/using.md`, `docs/validator.md` and README.
  - `spec-issues.md` and `readings.md` are already marked historical. The 0.1 snapshots in `spec/` stay as evidence.

Done when no source file names `0.1`, the suite passes on 0.2 alone, the 0.2 interop lane matches its last result, and a staging deploy refuses a 0.1 document with the new message.

### Phase 3. Add 0.3 beside 0.2 (2 to 3 weeks)

**Start when** upstream publishes 0.3, or its changelog has been quiet for about a week, or the owner accepts rework. Then:

1. **Pin.** Import the 0.3 commit with `npm run spec:import` and activate it with `spec/requirements-0.3.json`, a disposition for each of the 29 changelog entries ([poppy-0.3-upgrade.md](poppy-0.3-upgrade.md) has the file-by-file table).
2. **Discovery and validator.** Add `protected_resources`, sign-in types from `grant_types_supported`, `scopes_supported` and `auth.scopes`, `scope_hints`, `excluded_tasks`, the well-known-path redirect rule and loopback redirect URIs.
3. **Session Keys and the token endpoint.** This is the large one, and everything below depends on it. Do the mock first, then the client, then the property model. It covers:
   - a key per Session;
   - no `session_id` or `signed_in`;
   - `invalid_grant`;
   - `dpop_jkt` and the device code bound to the key;
   - `scope` per RFC 6749;
   - `insufficient_scope` in place of `sign_in_required`.
4. **Scopes and the cards.** Company-defined scopes from descriptions, hints on the sign-in card, and asking before an irreversible scope in a turn the User didn't start.
5. **The browser join.** GET the page, read the code outside the model, sign the proof with the Session Key, submit, follow the 303.
6. **MCP by Token Exchange,** `author` on messages (show the name, not the picture, [T39](poppy-0.3-issues.md)), and excluded tasks and alternatives as Company content.
7. **Interop and the official kit.** A 0.3 lane for our agent and mock. The official 0.3 Company validator runs against the 0.3 mock; where it disagrees with the text ([T45](poppy-0.3-issues.md)), record the difference as the kit's.

**Living with both versions:**

| Concern | Rule |
| --- | --- |
| Which profile | The version in the Company's current `poppy.json`, re-read on every discovery, as today |
| Sessions | 0.2 rows keep `session_id` and the key per User ID; 0.3 rows add a sealed Session Key and its thumbprint; additive columns only |
| A Company moves 0.2 → 0.3 | Discard its 0.2 Sessions, which are cheap, and keep the User ID. Try the stored Account Token with a new Session Key; on `invalid_grant`, ask the User to sign in |
| Scopes | 0.2's `poppy:read` and `poppy:write` stay valid for 0.2 Companies only; on a move to 0.3, granted scopes are re-read from the new metadata, never mapped by name |
| Errors | `sign_in_required` under 0.2, `insufficient_scope` under 0.3, chosen by profile ([T34](poppy-0.3-issues.md)'s reading for the 0.3 ambiguity) |
| Operations | Behaviour by `protocol_version`; approvals and pending confirmations stay bound to the profile they were made under, and a profile change holds them for the User |
| Interop | Separate 0.2 and 0.3 registry entries for our agent and mock; a 0.2 known failure never exempts a 0.3 cell |

### Phase 4. Release

Run both lanes, the official kit, the property and Hypothesis suites, and a staging journey on the 0.3 mock. Then do a live 0.3 Company when one exists, and say plainly in the changelog that none has been tried if none has. Write the CHANGELOG entry with migration and rollback steps.

## Rollback

| From | To | What happens |
| --- | --- | --- |
| Release A | 0.2 release | Revocations already sent stay sent; nothing else changes |
| Release B | Release A | A speaks 0.1 again; retired accounts stay retired |
| 0.3 release | Release B | 0.3 Sessions are discarded, which is safe; their columns are ignored; work bound to a 0.3 Company is held, never replayed |

## Risks

- **The 0.3 draft moves after phase 3 starts.** The Session Key design is the most likely to shift, and the rest depends on it. That is why phase 3 waits and phases 1 and 2 don't.
- **A Company Users rely on is still on 0.1** at release B. The phase 0 survey and the wait after release A are the mitigation; the owner can delay B.
- **Dormant agents keep 0.1 tokens** that release A never revoked. They stay unusable and are disclosed to the User.
- **Fewer peers.** With 0.1 gone, the grid loses most other projects until they ship 0.2, so interop evidence comes from fewer pairs. Say so in the ecosystem map.
