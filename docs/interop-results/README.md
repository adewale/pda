# Interop grid results

A snapshot: the summary of one run of the [interop harness](../../interop/README.md), on 12 October 2026. It isn't regenerated, so it goes stale as the code changes. The full results (`results.json`, the `index.html` grid and a HAR file per cell) aren't committed. To get them:

- **Run the grid locally** (needs Docker): `npm run interop` with the command below, or `npm run interop -- --agents dpa --companies dpa-mock,dpa-mock-strict` for our own pair. Each run writes to `interop/results/<run>/` (gitignored); [interop spec](../interop-spec.md) section 9 describes the files.
- **Download CI's**: the Interop workflow (`.github/workflows/interop.yml`) runs our agent against both of our mocks and uploads the `interop-results` artifact from each run.

The command, run at `2026-10-12T00:12:27Z` on the local lane, the first full grid on the isolated network (interop spec section 3, Isolation):

```sh
npm run interop -- --no-build --agents dpa,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,adonis-agora \
  --companies dpa-mock,dpa-mock-strict,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,poppyseed,ilmer,adonis-agora \
  --scenarios D,S0,N,SD,SV,SVN,SM,SMC,SX,SXV,C,CI,CS,CA,SO,SE,R,AO,AM,AS,O,OX,RL,DP
```

The scenarios are every one without an adversary or faults; the adversarial ones ran apart (the security grid below). Our images (`agent-dpa`, `company-dpa-mock`, the proxy) were rebuilt from `990286a` before the run, and the runner was at `c4bb2a9`; the third-party images were the pinned builds already on disk: Datalayer at `12d71877`, pi-poppy at `11ea1063`, poppy-demo at `02a9b304`, poppyseed at `f479fb6b`, Ilmer at `4ca76e00`, adonis-agora's Company at `97838853` and its agent at `e66a2329`. The mock then changed on main (`0436ee9`: each check names its basis, and the lenient `dpa-mock` no longer reports seven checks that rest only on a SHOULD or the Guides), so `company-dpa-mock` was rebuilt at `3b1ed6e` and every cell in the `dpa-mock` and `dpa-mock-strict` columns (288) was run again: every outcome was the same, and none of the full grid's cells had recorded any of the seven checks.

The egress probe, run inside the network before any implementation started, got nowhere: `{"tcp 1.1.1.1:443":"ENETUNREACH","tcp 8.8.8.8:53":"ENETUNREACH","dns example.com":"EAI_AGAIN"}`.

1,296 cells: 661 pass, 143 fail, 492 unsupported, 0 errors. No cell was flaky. Every failure is a known upstream or spec failure, and no known failure was stale: for the first time the runner judged every wildcard entry too, since a full grid without the adversarial implementations now counts as covering every agent, Company and scenario. The run exits 0.

**Against the previous grid** (11 October, `18cbaa6`: 1,242 cells, 659 pass, 143 fail, 440 unsupported, 0 errors), the only changed cells are the 54 of the new scenario DP (an issuer with a path, whose metadata is only where RFC 8414 inserts it; S3): `dpa` passes it at both mocks, and the other 52 cells are unsupported, since only our agent lists DP and only our mock has the `issuer_path` hook. Every pair's counts are the previous grid's plus its one DP cell, and the 143 failures fall to the same rules, on the same pairs and scenarios, as listed below; the known failures file needed no change. Neither our client's changes since `18cbaa6` nor the isolated network changed a cell.

**Run again under the conformance levels** ([conformance-levels.md](../conformance-levels.md), decision 24), at `08b28e7` on 12 October (`2026-10-12T07:25:12Z`, `npm run interop` with no selection, so the adversarial cells ran too, with our images rebuilt): every interop cell's outcome is the same, 661 pass, 143 fail and 492 unsupported, with no known failure stale. The checks the Companies and the trace recorded across the interop cells, by level: 6 failures, 4 warnings and 619 tentative (our readings); only failures fail a cell. The security grid is unchanged too (25 pass, 155 unsupported), and the other 1,184 adversarial cells, aimed at other projects' implementations, were refused by the runner as designed.

Pass / fail / unsupported, by agent (rows) and Company (columns), over 24 scenarios:

| | dpa-mock | dpa-mock-strict | datalayer-ts | datalayer-py | pi-poppy | poppy-demo | poppyseed | ilmer | adonis-agora |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **dpa** | 24 / 0 / 0 | 24 / 0 / 0 | 18 / 0 / 6 | 18 / 0 / 6 | 19 / 0 / 5 | 10 / 0 / 14 | 19 / 0 / 5 | 4 / 0 / 20 | 18 / 0 / 6 |
| **datalayer-ts** | 20 / 2 / 2 | 20 / 2 / 2 | 17 / 1 / 6 | 17 / 1 / 6 | 17 / 1 / 6 | 10 / 0 / 14 | 18 / 0 / 6 | 4 / 0 / 20 | 18 / 0 / 6 |
| **datalayer-py** | 22 / 1 / 1 | 22 / 1 / 1 | 18 / 0 / 6 | 18 / 0 / 6 | 18 / 1 / 5 | 10 / 0 / 14 | 19 / 0 / 5 | 4 / 0 / 20 | 18 / 0 / 6 |
| **pi-poppy** | 19 / 3 / 2 | 1 / 21 / 2 | 14 / 3 / 7 | 14 / 3 / 7 | 16 / 2 / 6 | 1 / 9 / 14 | 17 / 1 / 6 | 1 / 3 / 20 | 15 / 2 / 7 |
| **poppy-demo** | 0 / 9 / 15 | 0 / 9 / 15 | 3 / 5 / 16 | 3 / 5 / 16 | 7 / 0 / 17 | 8 / 0 / 16 | 6 / 1 / 17 | 0 / 3 / 21 | 0 / 9 / 15 |
| **adonis-agora** | 20 / 0 / 4 | 1 / 19 / 4 | 12 / 4 / 8 | 12 / 4 / 8 | 13 / 3 / 8 | 1 / 9 / 14 | 14 / 3 / 7 | 1 / 3 / 20 | 18 / 0 / 6 |

Unsupported cells are scenarios one side doesn't list or a hook it doesn't have: Ilmer is signed-out only, poppy-demo's agent does Direct Sign-In and one API operation, only some Companies have the Operations extension, MCP or Device Sign-In, and only our agent and mock take part in DP.

The failures by the attribution rule that decided them (spec section 9), each in [`known-failures.json`](../../interop/known-failures.json) with its upstream source or spec-issue link:

**Rule 1, violation (agent):**

- pi-poppy × dpa-mock, dpa-mock-strict and adonis-agora, N; × dpa-mock, dpa-mock-strict and pi-poppy, SVN: on `use_dpop_nonce` pi-poppy re-signs the client assertion and proof but resends the same Session assertion (`session-assertion.jti-reused`).
- datalayer-ts and datalayer-py × dpa-mock and dpa-mock-strict, SVN: Device Sign-In polling never retries `use_dpop_nonce` (Poppy 4.3, RFC 9449 section 8). The same failure at pi-poppy's Company falls to rule 2.

**Rule 2, grid (agent):**

- pi-poppy × every Company with SE: after the Company ends the Session, pi-poppy renews, gets `invalid_session` and throws instead of starting a new Session ([N39](../spec-issues.md#n39)).
- poppy-demo × dpa-mock, dpa-mock-strict and adonis-agora, N: the issuer-origin rule below, which N is the first to hit by grid.
- datalayer-ts and datalayer-py × pi-poppy, SVN: as in rule 1.

**Rule 3, reading (spec):**

- [S2](../spec-issues.md#s2), assertion `typ`: pi-poppy's Session assertions and adonis-agora's client and Session assertions have no `typ`, and both declare S2 `any`. dpa-mock-strict, poppy-demo's Northstar and Ilmer declare `jwt-60s` and refuse them at the first Session (pi-poppy × dpa-mock-strict, poppy-demo and Ilmer; adonis-agora × the same three). The lenient reference `dpa-mock` accepts them.
- [S1](../spec-issues.md#s1), client assertion `aud`: adonis-agora names the token endpoint at the device authorization and revocation endpoints too; poppyseed, pi-poppy's Company and both Datalayer Companies want the endpoint called and answer `invalid_client` (SV, SXV, SO).

Rule 3 now needs evidence in the trace that the question mattered (a `reading.<id>.refused` check or a Company-recorded error of that question), not only two declarations that differ. Every cell above has it. Three cells the grid before `18cbaa6` labelled reading had none and are now unattributed (below): poppy-demo × dpa-mock and dpa-mock-strict, D, where poppy-demo refuses `poppy.json` for its `auth.` issuer before fetching any metadata, so S3 never came up; and poppy-demo × Ilmer, S0, where the caller crashes on Ilmer's missing `authorization_endpoint`, not on S1.

**Rule 4, unattributed (no single side by rule; the known failure names the cause):**

- poppy-demo × dpa-mock, dpa-mock-strict and adonis-agora (the rest, now including D at both mocks): its caller requires `auth.issuer` to equal the Company's origin, and those issuers are on `auth.` or under `/poppy` ([N36](../spec-issues.md#n36)).
- poppy-demo × Ilmer (D, S0 and C): Ilmer's metadata has no `authorization_endpoint`, and the caller runs `new URL(undefined)` on it.
- poppy-demo × Datalayer TS and Python, SD, SX, CA, SO, AO: the caller always asks for its hard-coded `poppy:read poppy:write`; Manzanita offers only `orders:read` and `orders:write` and answers `invalid_scope`.
- poppy-demo × poppyseed, SO: poppyseed answers revocation with an empty 200 (RFC 7009 allows it); the caller parses it as JSON and throws.
- adonis-agora × Datalayer TS and Python, SE: adonis-agora recovers from an ended Session by renewing with its Account Token and no `session_id`, which Poppy 4.8 says starts a new signed-in Session; Datalayer's Companies require `session_id` and answer `invalid_session`.
- pi-poppy × Datalayer TS and Python, O and OX: Datalayer sends optional Operation members as `null`, which pi-poppy rejects ([N41](../spec-issues.md#n41)).
- datalayer-ts × dpa-mock, dpa-mock-strict and both Datalayer Companies, CS: the TypeScript `ConversationClient.stream` reconnects at once and gives up with `stream_unavailable` after five empty reconnects.

The triage behind the 11 October run (`18cbaa6`) also fixed harness bugs that had shown as failures: metadata appended to an issuer's path (S3 `append`) wasn't recognised by scenario D or the revocation check; declared readings were keyed by name, so a project's Company's readings replaced its agent's; and three adapters (datalayer-py ignored `servers`, adonis-agora didn't accept `"METHOD /path"` or a body-only Poppy error, datalayer-ts sent a retried first message to the conversation it had started; see [S9](../spec-issues.md#s9)).

## No internet: what the third-party images tried to reach

The run's network is `--internal`, so a container that calls out fails instead of reaching anything, and its log says so. Every container's log in the run was searched for failed lookups and connections. Only the three images that run `wrangler dev` tried: poppy-demo's agent and Company and Ilmer's Company each looked up `workers.cloudflare.com` every time wrangler started (442 times in all, at each start and each restart on `/reset`), to fetch the `Request.cf` object. Wrangler logs `Unable to fetch the Request.cf object! Falling back to a default placeholder` and carries on, so no cell failed for it and it needs no known failure. Before the network was internal, these lookups and the fetches after them would have gone out to Cloudflare on every run. No other implementation, ours included, tried to reach anything outside the run.

## Security grid

The adversarial cells ([`docs/adversarial-interop.md`](../adversarial-interop.md)) ran separately, against our own implementations only (interop spec section 13), with `--no-build` on the same images and the same isolation (each run's egress probe got nowhere):

```sh
npm run interop -- --no-build --agents evil-agent --companies dpa-mock,dpa-mock-strict --scenarios YR,YD,YA,YT,YS,YK,YU
npm run interop -- --no-build --agents dpa --companies evil-company --scenarios XH,XI,BX
npm run interop -- --no-build --agents dpa --companies dpa-mock,dpa-mock-strict --scenarios NREP,CDUP,CIDUP,ODUP
```

| Attacker | Scenarios | Honest side | Pass / fail |
| --- | --- | --- | --- |
| `evil-agent` | YR, YD, YA, YT, YS, YK, YU | `dpa-mock`; `dpa-mock-strict` | 7 / 0; 7 / 0 |
| `evil-company` | XH, XI, BX | `dpa` | 3 / 0 |
| the network (proxy faults) | NREP, CDUP, CIDUP, ODUP | `dpa` × `dpa-mock`; × `dpa-mock-strict` | 4 / 0; 4 / 0 |

25 cells, all pass: the honest side refused every attack and no harm oracle fired.

