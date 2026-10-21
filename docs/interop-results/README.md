# Interop grid results

**21 October 2026:** [dual-version upgrade evidence](../poppy-0.2-upgrade.md#validation), with a [per-cell result summary](2026-10-21-poppy-0.2.json). The historical snapshots below retain their original dates and pins. CI now also runs the 0.2 mock and the official validator separately.

A snapshot: the summary of one run of the [interop harness](../../interop/README.md), on 13 October 2026, with the 12 October runs kept below it. It isn't regenerated, so it goes stale as the code changes. The full results (`results.json`, the `index.html` grid and a HAR file per cell) aren't committed. To get them:

- **Run the grid locally** (needs Docker): `npm run interop` with the command below, or `npm run interop -- --agents pda --companies pda-mock,pda-mock-strict` for our own pair. Each run writes to `interop/results/<run>/` (gitignored); [interop spec](../interop-spec.md) section 9 describes the files.
- **Download CI's**: the Interop workflow (`.github/workflows/interop.yml`) runs our agent against both of our mocks and uploads the `interop-results` artifact from each run.

For current validation, see [the two complete isolated grid runs on 17 October](https://github.com/adewale/pda/actions/runs/38988240129). The dated snapshot below is retained as historical context.

## Public snapshot: 13 October, 30 scenarios, 8 agents, 12 Companies

The first full grid with every pin at its upstream's head of 13 October ([interop-testing.md](../interop-testing.md#pins-moved-on-13-october)): Datalayer at 0.17.0 (`00216eb`), Ilmer at `de0d1ec`, adonis-agora's AuthKit at 0.80.0 (`fe2a3ff`) and agent at 0.80.1 (`e139b95`), everruns at `aceb2e2`, print-with-poppy at `246727d`; pi-poppy (`11ea106`), poppy-demo (`02a9b30`) and poppyseed (`f479fb6`) hadn't moved. everruns is in the grid for the first time rather than in runs of its own, and Tipping Co (timothyohare, `fb7b4e6`) is new on both sides. Our code is `3ac7f67` plus the mock's `client_id` change below, after the seven refactors merged that morning. Every image was rebuilt in the first run (`2026-10-13T04:53:27Z`); the honest scenarios then ran again with the same images (`2026-10-13T05:18:57Z`), after two known failures were widened, and every one of the 2,880 cells came out the same:

```sh
npm run interop                     # first, everything: every image rebuilt
npm run interop -- --no-build --agents pda,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,adonis-agora,everruns,tipping-co \
  --companies pda-mock,pda-mock-strict,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,poppyseed,ilmer,print-with-poppy,adonis-agora,everruns,tipping-co \
  --scenarios D,S0,N,SD,SV,SVN,SM,SMC,SX,SXV,C,CI,CS,CA,H,DC,SO,SE,R,AO,AM,AS,W,O,O2,OX,OU,RL,DP,CM
```

**2,880 cells: 1,000 pass, 273 fail, 1,607 unsupported, 0 errors.** Every failure matched a known failure, no cell was flaky and no known failure was stale, so the run exits 0. Egress probe `ENETUNREACH`, `ENETUNREACH`, `EAI_AGAIN`. Checks recorded: 6 failures, 4 warnings, 1,086 tentative (our readings). Our agent, `pda`, passed 213 of the 214 cells it ran; the one failure is SO at Tipping Co, a reading the draft leaves open ([S1](../spec-issues.md#s1)).

The first command also ran the security grid (32 cells, all pass; [below](#security-grid)). Run without `--agents` and `--scenarios`, it pairs every adversarial scenario with every implementation, and the runner refuses each cell whose honest side isn't ours (2,730 of them) before anything is sent, recording each as `error`, blame `harness`, as interop spec section 13 says. Those refusals make that command exit 1 whatever the other cells do, so a full grid is the honest command above plus the three security commands below.

Pass / fail / unsupported, by agent (rows) and Company (columns):

| | pda-mock | pda-mock-strict | datalayer-ts | datalayer-py | pi-poppy | poppy-demo | poppyseed | ilmer | print-with-poppy | adonis-agora | everruns | tipping-co |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **pda** | 30 / 0 / 0 | 30 / 0 / 0 | 22 / 0 / 8 | 22 / 0 / 8 | 24 / 0 / 6 | 12 / 0 / 18 | 24 / 0 / 6 | 5 / 0 / 25 | 10 / 0 / 20 | 22 / 0 / 8 | 4 / 0 / 26 | 8 / 1 / 21 |
| **datalayer-ts** | 24 / 4 / 2 | 24 / 4 / 2 | 21 / 1 / 8 | 21 / 1 / 8 | 23 / 1 / 6 | 12 / 0 / 18 | 24 / 0 / 6 | 5 / 0 / 25 | 9 / 0 / 21 | 22 / 0 / 8 | 4 / 0 / 26 | 8 / 1 / 21 |
| **datalayer-py** | 25 / 3 / 2 | 25 / 3 / 2 | 22 / 0 / 8 | 22 / 0 / 8 | 23 / 1 / 6 | 12 / 0 / 18 | 24 / 0 / 6 | 5 / 0 / 25 | 9 / 0 / 21 | 22 / 0 / 8 | 4 / 0 / 26 | 8 / 1 / 21 |
| **pi-poppy** | 24 / 3 / 3 | 1 / 26 / 3 | 19 / 2 / 9 | 19 / 2 / 9 | 21 / 2 / 7 | 1 / 11 / 18 | 22 / 1 / 7 | 1 / 4 / 25 | 9 / 0 / 21 | 19 / 2 / 9 | 4 / 0 / 26 | 7 / 2 / 21 |
| **poppy-demo** | 0 / 12 / 18 | 0 / 12 / 18 | 5 / 5 / 20 | 5 / 5 / 20 | 10 / 0 / 20 | 10 / 0 / 20 | 9 / 1 / 20 | 0 / 4 / 26 | 0 / 7 / 23 | 0 / 12 / 18 | 0 / 3 / 27 | 0 / 8 / 22 |
| **adonis-agora** | 24 / 0 / 6 | 1 / 23 / 6 | 18 / 1 / 11 | 18 / 1 / 11 | 17 / 3 / 10 | 1 / 11 / 18 | 18 / 3 / 9 | 1 / 4 / 25 | 8 / 1 / 21 | 22 / 0 / 8 | 4 / 0 / 26 | 9 / 0 / 21 |
| **everruns** | 4 / 1 / 25 | 1 / 4 / 25 | 4 / 0 / 26 | 4 / 0 / 26 | 4 / 0 / 26 | 1 / 3 / 26 | 4 / 0 / 26 | 1 / 3 / 26 | 1 / 0 / 29 | 4 / 0 / 26 | 4 / 0 / 26 | 1 / 0 / 29 |
| **tipping-co** | 12 / 0 / 18 | 1 / 11 / 18 | 1 / 8 / 21 | 1 / 8 / 21 | 1 / 6 / 23 | 1 / 7 / 22 | 1 / 7 / 22 | 0 / 3 / 27 | 1 / 8 / 21 | 1 / 10 / 19 | 0 / 2 / 28 | 9 / 0 / 21 |

**Against 12 October.** The 1,800 cells of the 12 October grid (six agents, ten Companies, the same 30 scenarios) came out the same at the new pins: compared cell by cell with that run's `results.json`, 1,766 have the same outcome, and the other 34 are print-with-poppy's sign-in cells (unsupported at `7ef69be`), which match its column rerun at `260dbb4` that evening, scenario by scenario. No pin move changed a cell, as each upstream's diff suggested. Datalayer 0.17.0's new refusals (a scope no longer offered, a sign-in from before a password reset) aren't reached by any scenario. The 1,080 new cells are everruns' row and column (as in its own runs of 12 October, now over 30 scenarios and with Tipping Co: 33 pass, 11 fail as an agent; 24 pass, 5 fail as a Company) and Tipping Co's row and column.

**What's new:**

- **Tipping Co's Company** (column: 50 pass, 13 fail, 177 unsupported). adonis-agora, everruns and Tipping Co's own agent pass every cell they run there. pda, both Datalayer agents and pi-poppy fail SO: Tipping Co wants the token endpoint as the client assertion's `aud` at revocation too, and they send the revocation endpoint (reading [S1](../spec-issues.md#s1), blamed on the spec). pi-poppy also fails N, rule 2: it retries a token request after `use_dpop_nonce` only when `WWW-Authenticate` names it, which RFC 9449 8 doesn't ask of an authorization server, and Tipping Co puts it in the JSON body only. poppy-demo fails all eight at discovery (no `agent` member, as at print-with-poppy).
- **Tipping Co's agent** (row: 29 pass, 70 fail, 261 unsupported). It passes everything it claims at its own Company and, since the mock change below, at pda-mock (12 of 12, DP included). Elsewhere its first Session fails with `invalid_client`: it sends no `client_id` at the token endpoint, which RFC 7521 4.2 allows and every third-party Company refuses. At pda-mock-strict and Northstar the grid blames its missing `typ` first ([S2](../spec-issues.md#s2)). At Ilmer and everruns it stops at discovery, because it requires `authorization_endpoint`, which a signed-out Company needn't publish.
- **Our mock accepts a token request without `client_id`** when the client assertion's `iss` and `sub` agree, using `iss` as the client (RFC 7521 4.2, RFC 7523 3); a `client_id` that is sent must still equal them. Before, both mocks answered `invalid_client` ("client_id is required"), stricter than any MUST. The reading is in [readings.md](../readings.md); the test is in `test/mock-company.test.ts`.
- **Two known failures widened, none removed.** adonis-agora × print-with-poppy, SO, is now unattributed rather than blamed on adonis-agora: Tipping Co's agent fails SO there too, so the grid rule no longer singles one agent out. Tipping Co's agent's R at print-with-poppy and adonis-agora is blamed on the Company by the grid rule, as no other agent can judge rotation there.

Each implementation's totals and what its failures are: [the ecosystem scorecard](../ecosystem.md#scorecard). The failures by rule are as in the 12 October run below, plus the Tipping Co entries in [`known-failures.json`](../../interop/known-failures.json).

## 12 October, 30 scenarios

The command, run at `2026-10-12T13:20:47Z` on the local lane, on the isolated network, with every image rebuilt at the pins in [`interop/registry.json`](../../interop/registry.json) (Datalayer at 0.10.0), after scenarios H, DC, W, O2 and CM were written and AO learned to approve a held write:

```sh
npm run interop -- --agents pda,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,adonis-agora \
  --companies pda-mock,pda-mock-strict,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,poppyseed,ilmer,print-with-poppy,adonis-agora \
  --scenarios D,S0,N,SD,SV,SVN,SM,SMC,SX,SXV,C,CI,CS,CA,SO,SE,R,AO,AM,AS,O,OX,RL,DP,OU,H,DC,W,O2,CM
```

**1,800 cells: 849 pass, 171 fail, 780 unsupported, 0 errors.** No cell was flaky and no known failure was stale; every failure matched a known failure's recorded cause (blame, checks and step), so the run exits 0. Checks recorded: 6 failures, 4 warnings, 744 tentative. Our agent, `pda`, passed every one of the 195 cells it ran.

Against the 1,440-cell run below, the 360 new cells are scenarios H, DC, W, O2, CM and OU. Their failures are known: Datalayer's SDKs require `conversation_id` in the answer to a handoff or a close (7.9 and 7.12 say status and responder), the S2 `typ` reading at the strict Companies, and poppy-demo's discovery. everruns ran apart on both sides ([interop-testing.md](../interop-testing.md#everruns-joins-the-grid)) and isn't in these totals.

Pass / fail / unsupported, by agent (rows) and Company (columns), over 30 scenarios:

| | pda-mock | pda-mock-strict | datalayer-ts | datalayer-py | pi-poppy | poppy-demo | poppyseed | ilmer | print-with-poppy | adonis-agora |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **pda** | 30 / 0 / 0 | 30 / 0 / 0 | 22 / 0 / 8 | 22 / 0 / 8 | 24 / 0 / 6 | 12 / 0 / 18 | 24 / 0 / 6 | 5 / 0 / 25 | 4 / 0 / 26 | 22 / 0 / 8 |
| **datalayer-ts** | 24 / 4 / 2 | 24 / 4 / 2 | 21 / 1 / 8 | 21 / 1 / 8 | 23 / 1 / 6 | 12 / 0 / 18 | 24 / 0 / 6 | 5 / 0 / 25 | 3 / 0 / 27 | 22 / 0 / 8 |
| **datalayer-py** | 25 / 3 / 2 | 25 / 3 / 2 | 22 / 0 / 8 | 22 / 0 / 8 | 23 / 1 / 6 | 12 / 0 / 18 | 24 / 0 / 6 | 5 / 0 / 25 | 3 / 0 / 27 | 22 / 0 / 8 |
| **pi-poppy** | 24 / 3 / 3 | 1 / 26 / 3 | 19 / 2 / 9 | 19 / 2 / 9 | 21 / 2 / 7 | 1 / 11 / 18 | 22 / 1 / 7 | 1 / 4 / 25 | 3 / 0 / 27 | 19 / 2 / 9 |
| **poppy-demo** | 0 / 12 / 18 | 0 / 12 / 18 | 5 / 5 / 20 | 5 / 5 / 20 | 10 / 0 / 20 | 10 / 0 / 20 | 9 / 1 / 20 | 0 / 4 / 26 | 0 / 3 / 27 | 0 / 12 / 18 |
| **adonis-agora** | 24 / 0 / 6 | 1 / 23 / 6 | 18 / 1 / 11 | 18 / 1 / 11 | 17 / 3 / 10 | 1 / 11 / 18 | 18 / 3 / 9 | 1 / 4 / 25 | 3 / 0 / 27 | 22 / 0 / 8 |

The sections below are the print-with-poppy column rerun at its new pin, then the day's earlier runs, kept for their per-rule detail.

## print-with-poppy at `260dbb4`, 12 October

The store's pin moved from `7ef69be` to `260dbb4` that evening, 26 commits later: it now has accounts (Direct and Mediated Sign-In by an emailed code), and the adapter claims seven sign-in scenarios besides D, S0, CM and OU ([adapter README](../../interop/impls/print-with-poppy-company/README.md)). Its column was rerun on its own, at `2026-10-12T22:03:59Z` on the local lane, every image rebuilt, with the seven honest agents (everruns included) and the 30 scenarios of the run above:

```sh
npm run interop -- --agents pda,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,adonis-agora,everruns \
  --companies print-with-poppy \
  --scenarios AM,AO,AS,C,CA,CI,CM,CS,D,DC,DP,H,N,O,O2,OU,OX,R,RL,S0,SD,SE,SM,SMC,SO,SV,SVN,SX,SXV,W
```

**210 cells: 46 pass, 8 fail, 156 unsupported, 0 errors.** Egress probe `ENETUNREACH`, `ENETUNREACH`, `EAI_AGAIN`. No flaky cell, no stale entry, every failure known; the run exits 0. Checks: no failures, no warnings, 35 tentative (S2 `typ` notes for pi-poppy's and adonis-agora's assertions, which the store accepts).

| Agent | Pass | Fail | Unsupported |
| --- | --- | --- | --- |
| pda | 10: D, S0, CM, SD, SX, SMC, SO, AO, AS, OU | 0 | 20 |
| datalayer-ts, datalayer-py, pi-poppy | 9 each: D, S0, CM, SD, SX, SMC, SO, AO, AS | 0 | 21 each |
| adonis-agora | 8: D, S0, CM, SD, SX, SMC, AO, AS | 1: SO | 21 |
| poppy-demo | 0 | 7: D, S0, CM, SD, SX, SO, AO | 23 |
| everruns | 1: D | 0 | 29 |

- **poppy-demo, 7 cells (known).** Its caller reads `d.agent.protocols` for every Company; the store has no conversations, so no `agent` member. It used to trip on the missing `authorization_endpoint` first; the store has one now.
- **adonis-agora, SO (known, new).** Its revocation request's client assertion names the token endpoint ([S1](../spec-issues.md#s1)); the store wants `/oauth/revoke`, as poppyseed and pi-poppy do. Where they answer `invalid_client`, the store answers 500 `internal_error`: its revoke route doesn't catch the assertion error ([poppy-issues.md](../poppy-issues.md#print-with-poppy-spenciefyprint-with-poppy)).
- **R, 5 cells unsupported.** Every agent renewed through two expiries and read the account, but the store doesn't rotate Account Tokens, so `refresh_rotated` has nothing to judge.
- **SM unsupported.** The store's Mediated Sign-In always sends a code, so it claims SMC, which all five agents that claim it pass, and not SM.

Against its column in the run above (6 agents: 16 pass, 3 fail, 161 unsupported, at `7ef69be`), the same six agents now have 45 pass, 8 fail, 127 unsupported: the 29 new passes are the sign-in scenarios, and the five new failures are poppy-demo's crash in four of them and adonis-agora's SO. OU still passes for pda, now that our client refuses a write the description leaves outside the Poppy Session, and no other agent claims it.

## Earlier runs

The command, run at `2026-10-12T09:00:00Z` on the local lane, on the isolated network (interop spec section 3, Isolation), after Datalayer's pin moved to 0.10.0:

```sh
npm run interop -- --agents pda,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,adonis-agora \
  --companies pda-mock,pda-mock-strict,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,poppyseed,ilmer,print-with-poppy,adonis-agora \
  --scenarios D,S0,N,SD,SV,SVN,SM,SMC,SX,SXV,C,CI,CS,CA,SO,SE,R,AO,AM,AS,O,OX,RL,DP
```

The scenarios are every one that then existed without an adversary or faults; the adversarial ones ran apart (the security grid below). Scenario OU (an upload, then an operation in a signed-out Session) was added later that day and isn't in this run; pda passes it against pda-mock, pda-mock-strict and print-with-poppy. everruns (agent and Company, at `f470ad7`) joined the registry later that day too and isn't in this run; its own two runs over these 25 scenarios are in [interop-testing.md](../interop-testing.md#everruns-joins-the-grid). Every image was built (from cache where nothing changed) at `c5ae73d`, which also holds the runner: Datalayer at `0c048aa7` (v0.10.0; it was `12d71877`, v0.6.0), pi-poppy at `11ea1063`, poppy-demo at `02a9b304`, poppyseed at `f479fb6b`, Ilmer at `4ca76e00`, print-with-poppy at `7ef69bef`, adonis-agora's Company at `97838853` and its agent at `e66a2329`. The four Datalayer images are 677 MB (TypeScript) and 451 MB (Python) each; each pair shares every layer below its adapter.

The egress probe, run inside the network before any implementation started, got nowhere: `{"tcp 1.1.1.1:443":"ENETUNREACH","tcp 8.8.8.8:53":"ENETUNREACH","dns example.com":"EAI_AGAIN"}`.

1,440 cells: 683 pass, 137 fail, 620 unsupported, 0 errors. No cell was flaky. Every failure is a known upstream or spec failure, and no known failure was stale: with every honest Company in the run (print-with-poppy included), the runner judged every wildcard entry too. The checks the Companies and the trace recorded, by level: 6 failures, 4 warnings and 624 tentative (our readings); only failures fail a cell. The run exits 0.

**Rerun at `2026-10-12T10:00:08Z`** with the same images (`--no-build`), after the runner learnt two things: a read of events and a send with `wait` must carry `cursor`, `has_more`, `status` and `responder` (7.5's MUST, and 7.3), and a known failure now names the failure it expects (its blame, error checks and failed step's code), so a different failure in the same cell is unexpected. Every cell came out the same: 683 pass, 137 fail, 620 unsupported, no flaky cell, no stale entry. No Company tripped the new events checks; every one sends all four fields. Each entry in `known-failures.json` took its blame, checks and errors from this run's cells.

**Against the previous grid** (`2026-10-12T00:12:27Z` and its rerun under the conformance levels at `08b28e7`: 1,296 cells, 661 pass, 143 fail, 492 unsupported, with Datalayer at `12d71877`): the 144 new cells are print-with-poppy's column (10 pass, 2 fail, 132 unsupported; a signed-out Company with Operations and no conversations, so most scenarios don't apply). Over the other 1,296, 12 cells changed, all from the Datalayer move:

- adonis-agora × datalayer-ts and datalayer-py, SV, SXV and SO: fail → pass. Datalayer's Companies now accept a client assertion `aud` of the issuer, the token endpoint or the endpoint called ([S1](../spec-issues.md#s1)), so adonis-agora's token-endpoint `aud` at the device authorization and revocation endpoints is accepted.
- pi-poppy × datalayer-ts and datalayer-py, O: fail → pass. A confirmed operation now omits `expires_at` instead of sending `null`. Their two known failures were stale and are gone.
- datalayer-ts × pda-mock, pda-mock-strict, pi-poppy and poppyseed, AM: unsupported → pass. The TypeScript SDK now has an MCP client, so the adapter claims AM.

Before the full grid, two narrow runs covered the Datalayer rows and columns (`--companies datalayer-ts,datalayer-py` with all six agents, then `--agents datalayer-ts,datalayer-py` with the other seven Companies). The first reported the two pi-poppy O entries stale, and one flaky cell, datalayer-py × datalayer-py SV: the Company's fetch of the agent's `agent.json`, 5 s after the previous one, met a connection uvicorn had just closed at its default 5 s keep-alive ("socket hang up"), so the device token request was `invalid_client`. The Python adapters now keep idle connections 75 s; the full grid had no flaky cell.

Pass / fail / unsupported, by agent (rows) and Company (columns), over 24 scenarios:

| | pda-mock | pda-mock-strict | datalayer-ts | datalayer-py | pi-poppy | poppy-demo | poppyseed | ilmer | print-with-poppy | adonis-agora |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **pda** | 24 / 0 / 0 | 24 / 0 / 0 | 18 / 0 / 6 | 18 / 0 / 6 | 19 / 0 / 5 | 10 / 0 / 14 | 19 / 0 / 5 | 4 / 0 / 20 | 2 / 0 / 22 | 18 / 0 / 6 |
| **datalayer-ts** | 21 / 2 / 1 | 21 / 2 / 1 | 17 / 1 / 6 | 17 / 1 / 6 | 18 / 1 / 5 | 10 / 0 / 14 | 19 / 0 / 5 | 4 / 0 / 20 | 2 / 0 / 22 | 18 / 0 / 6 |
| **datalayer-py** | 22 / 1 / 1 | 22 / 1 / 1 | 18 / 0 / 6 | 18 / 0 / 6 | 18 / 1 / 5 | 10 / 0 / 14 | 19 / 0 / 5 | 4 / 0 / 20 | 2 / 0 / 22 | 18 / 0 / 6 |
| **pi-poppy** | 19 / 3 / 2 | 1 / 21 / 2 | 15 / 2 / 7 | 15 / 2 / 7 | 16 / 2 / 6 | 1 / 9 / 14 | 17 / 1 / 6 | 1 / 3 / 20 | 2 / 0 / 22 | 15 / 2 / 7 |
| **poppy-demo** | 0 / 9 / 15 | 0 / 9 / 15 | 3 / 5 / 16 | 3 / 5 / 16 | 7 / 0 / 17 | 8 / 0 / 16 | 6 / 1 / 17 | 0 / 3 / 21 | 0 / 2 / 22 | 0 / 9 / 15 |
| **adonis-agora** | 20 / 0 / 4 | 1 / 19 / 4 | 15 / 1 / 8 | 15 / 1 / 8 | 13 / 3 / 8 | 1 / 9 / 14 | 14 / 3 / 7 | 1 / 3 / 20 | 2 / 0 / 22 | 18 / 0 / 6 |

Unsupported cells are scenarios one side doesn't list or a hook it doesn't have: Ilmer is signed-out only, print-with-poppy is signed-out only with no conversations, poppy-demo's agent does Direct Sign-In and one API operation, only some Companies have the Operations extension, MCP or Device Sign-In, and only our agent and mock take part in DP.

The failures by the attribution rule that decided them (spec section 9), each in [`known-failures.json`](../../interop/known-failures.json) with its upstream source or spec-issue link:

**Rule 1, violation (agent):**

- pi-poppy × pda-mock, pda-mock-strict and adonis-agora, N; × pda-mock, pda-mock-strict and pi-poppy, SVN: on `use_dpop_nonce` pi-poppy re-signs the client assertion and proof but resends the same Session assertion (`session-assertion.jti-reused`).

**Warning (agent), below a failure (conformance levels):**

- datalayer-ts and datalayer-py × pda-mock and pda-mock-strict, SVN: Device Sign-In polling never retries `use_dpop_nonce` (Poppy 4.3, RFC 9449 section 8; still so at `0c048aa`). The same failure at pi-poppy's Company falls to rule 2.

**Rule 2, grid (agent):**

- pi-poppy × every Company with SE: after the Company ends the Session, pi-poppy renews, gets `invalid_session` and throws instead of starting a new Session ([N39](../spec-issues.md#n39)).
- poppy-demo × pda-mock, pda-mock-strict and adonis-agora, N: the issuer-origin rule below, which N is the first to hit by grid.
- datalayer-ts and datalayer-py × pi-poppy, SVN: as above.

**Rule 3, reading (spec):**

- [S2](../spec-issues.md#s2), assertion `typ`: pi-poppy's Session assertions and adonis-agora's client and Session assertions have no `typ`, and both declare S2 `any`. pda-mock-strict, poppy-demo's Northstar and Ilmer declare `jwt-60s` and refuse them at the first Session (pi-poppy × pda-mock-strict, poppy-demo and Ilmer; adonis-agora × the same three). The lenient reference `pda-mock` accepts them.
- [S1](../spec-issues.md#s1), client assertion `aud`: adonis-agora names the token endpoint at the device authorization and revocation endpoints too; poppyseed and pi-poppy's Company want the endpoint called and answer `invalid_client` (SV, SXV, SO). Datalayer's Companies did too until 0.10.0.

Rule 3 needs evidence in the trace that the question mattered (a `reading.<id>.refused` check or a Company-recorded error of that question), not only two declarations that differ. Every cell above has it. poppy-demo × pda-mock and pda-mock-strict, D (refused for the `auth.` issuer before any metadata is fetched, so S3 never came up) and poppy-demo × Ilmer, S0 (a crash on the missing `authorization_endpoint`, not S1) are unattributed for that reason.

**Rule 4, unattributed (no single side by rule; the known failure names the cause):**

- poppy-demo × pda-mock, pda-mock-strict and adonis-agora (the rest, including D at both mocks): its caller requires `auth.issuer` to equal the Company's origin, and those issuers are on `auth.` or under `/poppy`, as the draft's own examples allow.
- poppy-demo × Ilmer (D, S0 and C) and × print-with-poppy (D, S0): neither has an `authorization_endpoint` (signed-out only), and the caller runs `new URL(undefined)` on it.
- poppy-demo × Datalayer TS and Python, SD, SX, CA, SO, AO: the caller always asks for its hard-coded `poppy:read poppy:write`; Manzanita offers only `orders:read` and `orders:write` and answers `invalid_scope`.
- poppy-demo × poppyseed, SO: poppyseed answers revocation with an empty 200 (RFC 7009 allows it); the caller parses it as JSON and throws.
- adonis-agora × Datalayer TS and Python, SE: adonis-agora recovers from an ended Session by renewing with its Account Token and no `session_id`, which Poppy 4.8 says starts a new signed-in Session; Datalayer's Companies still require `session_id` and answer `invalid_session`.
- pi-poppy × Datalayer TS and Python, OX: Datalayer's cancel still sends `result.data: null`, which pi-poppy rejects ([N41](../spec-issues.md#n41)).
- datalayer-ts × pda-mock, pda-mock-strict and both Datalayer Companies, CS: the TypeScript `ConversationClient.stream` reconnects at once and gives up with `stream_unavailable` after five empty reconnects.

The triage behind the 11 October run (`18cbaa6`) also fixed harness bugs that had shown as failures: metadata appended to an issuer's path (S3 `append`) wasn't recognised by scenario D or the revocation check; declared readings were keyed by name, so a project's Company's readings replaced its agent's; and three adapters (datalayer-py ignored `servers`, adonis-agora didn't accept `"METHOD /path"` or a body-only Poppy error, datalayer-ts sent a retried first message to the conversation it had started; see [S9](../spec-issues.md#s9)).

## No internet: what the third-party images tried to reach

The run's network is `--internal`, so a container that calls out fails instead of reaching anything, and its log says so. Every container's log in the `2026-10-12T00:12:27Z` run was searched for failed lookups and connections (not repeated for the 09:00 run). Only the three images that run `wrangler dev` tried: poppy-demo's agent and Company and Ilmer's Company each looked up `workers.cloudflare.com` every time wrangler started (442 times in all, at each start and each restart on `/reset`), to fetch the `Request.cf` object. Wrangler logs `Unable to fetch the Request.cf object! Falling back to a default placeholder` and carries on, so no cell failed for it and it needs no known failure. Before the network was internal, these lookups and the fetches after them would have gone out to Cloudflare on every run. No other implementation, ours included, tried to reach anything outside the run.

## Security grid

The adversarial cells ([`docs/adversarial-interop.md`](../adversarial-interop.md)) ran separately, against our own implementations only (interop spec section 13), with `--no-build` on the same images and the same isolation (each run's egress probe got nowhere):

```sh
npm run interop -- --no-build --agents evil-agent --companies pda-mock,pda-mock-strict --scenarios YR,YD,YA,YT,YS,YK,YU,YM
npm run interop -- --no-build --agents pda --companies evil-company --scenarios XH,XI,BX,XB,XN,XO,XP,XE
npm run interop -- --no-build --agents pda --companies pda-mock,pda-mock-strict --scenarios NREP,CDUP,CIDUP,ODUP
```

| Attacker | Scenarios | Honest side | Pass / fail |
| --- | --- | --- | --- |
| `evil-agent` | YR, YD, YA, YT, YS, YK, YU, YM | `pda-mock`; `pda-mock-strict` | 8 / 0; 8 / 0 |
| `evil-company` | XH, XI, BX, XB, XN, XO, XP, XE | `pda` | 8 / 0 |
| the network (proxy faults) | NREP, CDUP, CIDUP, ODUP | `pda` × `pda-mock`; × `pda-mock-strict` | 4 / 0; 4 / 0 |

32 cells, all pass: the honest side refused or safely withstood every attack and no harm oracle fired. On 13 October the same 32 cells ran inside the full `npm run interop` with rebuilt images, and all passed again. The `evil-agent` and `evil-company` rows were rerun on 12 October 2026 after the malicious-Company attacks `XB` (oversized `poppy.json`), `XN` (DPoP nonce loop), `XO` (operation terms swapped under their id), `XP` (consent spoofing) and `XE` (a forged message from the User), and the malicious-agent attack `YM` (confirm without approval), were added; the network row is unchanged. Still listed, not yet built: `XM` (a mix-up needs two Companies in one cell), `XS` (needs the N42 "private" test suffix), `YF` (a code only returns through the consent hook) and `YC` (needs a consent-page reader) — see [`docs/adversarial-interop.md`](../adversarial-interop.md).

Later on 13 October, after the agent's conversation reads and operation tracking were paced and the attacks `XR` (endless reading) and `XT` (an operation in progress for ever) were added, our agent ran against both mocks and `evil-company`, all ten of its scenarios included: 78 cells, 78 pass, 0 fail.

