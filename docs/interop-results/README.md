# Interop grid results

A snapshot: the summary of one run of the [interop harness](../../interop/README.md), on 12 October 2026. It isn't regenerated, so it goes stale as the code changes. The full results (`results.json`, the `index.html` grid and a HAR file per cell) aren't committed. To get them:

- **Run the grid locally** (needs Docker): `npm run interop` with the command below, or `npm run interop -- --agents dpa --companies dpa-mock,dpa-mock-strict` for our own pair. Each run writes to `interop/results/<run>/` (gitignored); [interop spec](../interop-spec.md) section 9 describes the files.
- **Download CI's**: the Interop workflow (`.github/workflows/interop.yml`) runs our agent against both of our mocks and uploads the `interop-results` artifact from each run.

The command, run at `2026-10-12T09:00:00Z` on the local lane, on the isolated network (interop spec section 3, Isolation), after Datalayer's pin moved to 0.10.0:

```sh
npm run interop -- --agents dpa,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,adonis-agora \
  --companies dpa-mock,dpa-mock-strict,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,poppyseed,ilmer,print-with-poppy,adonis-agora \
  --scenarios D,S0,N,SD,SV,SVN,SM,SMC,SX,SXV,C,CI,CS,CA,SO,SE,R,AO,AM,AS,O,OX,RL,DP
```

The scenarios are every one that then existed without an adversary or faults; the adversarial ones ran apart (the security grid below). Scenario OU (an upload, then an operation in a signed-out Session) was added later that day and isn't in this run; dpa passes it against dpa-mock, dpa-mock-strict and print-with-poppy. everruns (agent and Company, at `f470ad7`) joined the registry later that day too and isn't in this run; its own two runs over these 25 scenarios are in [interop-testing.md](../interop-testing.md#everruns-joins-the-grid). Every image was built (from cache where nothing changed) at `c5ae73d`, which also holds the runner: Datalayer at `0c048aa7` (v0.10.0; it was `12d71877`, v0.6.0), pi-poppy at `11ea1063`, poppy-demo at `02a9b304`, poppyseed at `f479fb6b`, Ilmer at `4ca76e00`, print-with-poppy at `7ef69bef`, adonis-agora's Company at `97838853` and its agent at `e66a2329`. The four Datalayer images are 677 MB (TypeScript) and 451 MB (Python) each; each pair shares every layer below its adapter.

The egress probe, run inside the network before any implementation started, got nowhere: `{"tcp 1.1.1.1:443":"ENETUNREACH","tcp 8.8.8.8:53":"ENETUNREACH","dns example.com":"EAI_AGAIN"}`.

1,440 cells: 683 pass, 137 fail, 620 unsupported, 0 errors. No cell was flaky. Every failure is a known upstream or spec failure, and no known failure was stale: with every honest Company in the run (print-with-poppy included), the runner judged every wildcard entry too. The checks the Companies and the trace recorded, by level: 6 failures, 4 warnings and 624 tentative (our readings); only failures fail a cell. The run exits 0.

**Rerun at `2026-10-12T10:00:08Z`** with the same images (`--no-build`), after the runner learnt two things: a read of events and a send with `wait` must carry `cursor`, `has_more`, `status` and `responder` (7.5's MUST, and 7.3), and a known failure now names the failure it expects (its blame, error checks and failed step's code), so a different failure in the same cell is unexpected. Every cell came out the same: 683 pass, 137 fail, 620 unsupported, no flaky cell, no stale entry. No Company tripped the new events checks; every one sends all four fields. Each entry in `known-failures.json` took its blame, checks and errors from this run's cells.

**Against the previous grid** (`2026-10-12T00:12:27Z` and its rerun under the conformance levels at `08b28e7`: 1,296 cells, 661 pass, 143 fail, 492 unsupported, with Datalayer at `12d71877`): the 144 new cells are print-with-poppy's column (10 pass, 2 fail, 132 unsupported; a signed-out Company with Operations and no conversations, so most scenarios don't apply). Over the other 1,296, 12 cells changed, all from the Datalayer move:

- adonis-agora × datalayer-ts and datalayer-py, SV, SXV and SO: fail → pass. Datalayer's Companies now accept a client assertion `aud` of the issuer, the token endpoint or the endpoint called ([S1](../spec-issues.md#s1)), so adonis-agora's token-endpoint `aud` at the device authorization and revocation endpoints is accepted.
- pi-poppy × datalayer-ts and datalayer-py, O: fail → pass. A confirmed operation now omits `expires_at` instead of sending `null`. Their two known failures were stale and are gone.
- datalayer-ts × dpa-mock, dpa-mock-strict, pi-poppy and poppyseed, AM: unsupported → pass. The TypeScript SDK now has an MCP client, so the adapter claims AM.

Before the full grid, two narrow runs covered the Datalayer rows and columns (`--companies datalayer-ts,datalayer-py` with all six agents, then `--agents datalayer-ts,datalayer-py` with the other seven Companies). The first reported the two pi-poppy O entries stale, and one flaky cell, datalayer-py × datalayer-py SV: the Company's fetch of the agent's `agent.json`, 5 s after the previous one, met a connection uvicorn had just closed at its default 5 s keep-alive ("socket hang up"), so the device token request was `invalid_client`. The Python adapters now keep idle connections 75 s; the full grid had no flaky cell.

Pass / fail / unsupported, by agent (rows) and Company (columns), over 24 scenarios:

| | dpa-mock | dpa-mock-strict | datalayer-ts | datalayer-py | pi-poppy | poppy-demo | poppyseed | ilmer | print-with-poppy | adonis-agora |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **dpa** | 24 / 0 / 0 | 24 / 0 / 0 | 18 / 0 / 6 | 18 / 0 / 6 | 19 / 0 / 5 | 10 / 0 / 14 | 19 / 0 / 5 | 4 / 0 / 20 | 2 / 0 / 22 | 18 / 0 / 6 |
| **datalayer-ts** | 21 / 2 / 1 | 21 / 2 / 1 | 17 / 1 / 6 | 17 / 1 / 6 | 18 / 1 / 5 | 10 / 0 / 14 | 19 / 0 / 5 | 4 / 0 / 20 | 2 / 0 / 22 | 18 / 0 / 6 |
| **datalayer-py** | 22 / 1 / 1 | 22 / 1 / 1 | 18 / 0 / 6 | 18 / 0 / 6 | 18 / 1 / 5 | 10 / 0 / 14 | 19 / 0 / 5 | 4 / 0 / 20 | 2 / 0 / 22 | 18 / 0 / 6 |
| **pi-poppy** | 19 / 3 / 2 | 1 / 21 / 2 | 15 / 2 / 7 | 15 / 2 / 7 | 16 / 2 / 6 | 1 / 9 / 14 | 17 / 1 / 6 | 1 / 3 / 20 | 2 / 0 / 22 | 15 / 2 / 7 |
| **poppy-demo** | 0 / 9 / 15 | 0 / 9 / 15 | 3 / 5 / 16 | 3 / 5 / 16 | 7 / 0 / 17 | 8 / 0 / 16 | 6 / 1 / 17 | 0 / 3 / 21 | 0 / 2 / 22 | 0 / 9 / 15 |
| **adonis-agora** | 20 / 0 / 4 | 1 / 19 / 4 | 15 / 1 / 8 | 15 / 1 / 8 | 13 / 3 / 8 | 1 / 9 / 14 | 14 / 3 / 7 | 1 / 3 / 20 | 2 / 0 / 22 | 18 / 0 / 6 |

Unsupported cells are scenarios one side doesn't list or a hook it doesn't have: Ilmer is signed-out only, print-with-poppy is signed-out only with no conversations, poppy-demo's agent does Direct Sign-In and one API operation, only some Companies have the Operations extension, MCP or Device Sign-In, and only our agent and mock take part in DP.

The failures by the attribution rule that decided them (spec section 9), each in [`known-failures.json`](../../interop/known-failures.json) with its upstream source or spec-issue link:

**Rule 1, violation (agent):**

- pi-poppy × dpa-mock, dpa-mock-strict and adonis-agora, N; × dpa-mock, dpa-mock-strict and pi-poppy, SVN: on `use_dpop_nonce` pi-poppy re-signs the client assertion and proof but resends the same Session assertion (`session-assertion.jti-reused`).

**Warning (agent), below a failure (conformance levels):**

- datalayer-ts and datalayer-py × dpa-mock and dpa-mock-strict, SVN: Device Sign-In polling never retries `use_dpop_nonce` (Poppy 4.3, RFC 9449 section 8; still so at `0c048aa`). The same failure at pi-poppy's Company falls to rule 2.

**Rule 2, grid (agent):**

- pi-poppy × every Company with SE: after the Company ends the Session, pi-poppy renews, gets `invalid_session` and throws instead of starting a new Session ([N39](../spec-issues.md#n39)).
- poppy-demo × dpa-mock, dpa-mock-strict and adonis-agora, N: the issuer-origin rule below, which N is the first to hit by grid.
- datalayer-ts and datalayer-py × pi-poppy, SVN: as above.

**Rule 3, reading (spec):**

- [S2](../spec-issues.md#s2), assertion `typ`: pi-poppy's Session assertions and adonis-agora's client and Session assertions have no `typ`, and both declare S2 `any`. dpa-mock-strict, poppy-demo's Northstar and Ilmer declare `jwt-60s` and refuse them at the first Session (pi-poppy × dpa-mock-strict, poppy-demo and Ilmer; adonis-agora × the same three). The lenient reference `dpa-mock` accepts them.
- [S1](../spec-issues.md#s1), client assertion `aud`: adonis-agora names the token endpoint at the device authorization and revocation endpoints too; poppyseed and pi-poppy's Company want the endpoint called and answer `invalid_client` (SV, SXV, SO). Datalayer's Companies did too until 0.10.0.

Rule 3 needs evidence in the trace that the question mattered (a `reading.<id>.refused` check or a Company-recorded error of that question), not only two declarations that differ. Every cell above has it. poppy-demo × dpa-mock and dpa-mock-strict, D (refused for the `auth.` issuer before any metadata is fetched, so S3 never came up) and poppy-demo × Ilmer, S0 (a crash on the missing `authorization_endpoint`, not S1) are unattributed for that reason.

**Rule 4, unattributed (no single side by rule; the known failure names the cause):**

- poppy-demo × dpa-mock, dpa-mock-strict and adonis-agora (the rest, including D at both mocks): its caller requires `auth.issuer` to equal the Company's origin, and those issuers are on `auth.` or under `/poppy`, as the draft's own examples allow.
- poppy-demo × Ilmer (D, S0 and C) and × print-with-poppy (D, S0): neither has an `authorization_endpoint` (signed-out only), and the caller runs `new URL(undefined)` on it.
- poppy-demo × Datalayer TS and Python, SD, SX, CA, SO, AO: the caller always asks for its hard-coded `poppy:read poppy:write`; Manzanita offers only `orders:read` and `orders:write` and answers `invalid_scope`.
- poppy-demo × poppyseed, SO: poppyseed answers revocation with an empty 200 (RFC 7009 allows it); the caller parses it as JSON and throws.
- adonis-agora × Datalayer TS and Python, SE: adonis-agora recovers from an ended Session by renewing with its Account Token and no `session_id`, which Poppy 4.8 says starts a new signed-in Session; Datalayer's Companies still require `session_id` and answer `invalid_session`.
- pi-poppy × Datalayer TS and Python, OX: Datalayer's cancel still sends `result.data: null`, which pi-poppy rejects ([N41](../spec-issues.md#n41)).
- datalayer-ts × dpa-mock, dpa-mock-strict and both Datalayer Companies, CS: the TypeScript `ConversationClient.stream` reconnects at once and gives up with `stream_unavailable` after five empty reconnects.

The triage behind the 11 October run (`18cbaa6`) also fixed harness bugs that had shown as failures: metadata appended to an issuer's path (S3 `append`) wasn't recognised by scenario D or the revocation check; declared readings were keyed by name, so a project's Company's readings replaced its agent's; and three adapters (datalayer-py ignored `servers`, adonis-agora didn't accept `"METHOD /path"` or a body-only Poppy error, datalayer-ts sent a retried first message to the conversation it had started; see [S9](../spec-issues.md#s9)).

## No internet: what the third-party images tried to reach

The run's network is `--internal`, so a container that calls out fails instead of reaching anything, and its log says so. Every container's log in the `2026-10-12T00:12:27Z` run was searched for failed lookups and connections (not repeated for the 09:00 run). Only the three images that run `wrangler dev` tried: poppy-demo's agent and Company and Ilmer's Company each looked up `workers.cloudflare.com` every time wrangler started (442 times in all, at each start and each restart on `/reset`), to fetch the `Request.cf` object. Wrangler logs `Unable to fetch the Request.cf object! Falling back to a default placeholder` and carries on, so no cell failed for it and it needs no known failure. Before the network was internal, these lookups and the fetches after them would have gone out to Cloudflare on every run. No other implementation, ours included, tried to reach anything outside the run.

## Security grid

The adversarial cells ([`docs/adversarial-interop.md`](../adversarial-interop.md)) ran separately, against our own implementations only (interop spec section 13), with `--no-build` on the same images and the same isolation (each run's egress probe got nowhere):

```sh
npm run interop -- --no-build --agents evil-agent --companies dpa-mock,dpa-mock-strict --scenarios YR,YD,YA,YT,YS,YK,YU,YM
npm run interop -- --no-build --agents dpa --companies evil-company --scenarios XH,XI,BX,XB,XN,XO,XP,XE
npm run interop -- --no-build --agents dpa --companies dpa-mock,dpa-mock-strict --scenarios NREP,CDUP,CIDUP,ODUP
```

| Attacker | Scenarios | Honest side | Pass / fail |
| --- | --- | --- | --- |
| `evil-agent` | YR, YD, YA, YT, YS, YK, YU, YM | `dpa-mock`; `dpa-mock-strict` | 8 / 0; 8 / 0 |
| `evil-company` | XH, XI, BX, XB, XN, XO, XP, XE | `dpa` | 8 / 0 |
| the network (proxy faults) | NREP, CDUP, CIDUP, ODUP | `dpa` × `dpa-mock`; × `dpa-mock-strict` | 4 / 0; 4 / 0 |

32 cells, all pass: the honest side refused or safely withstood every attack and no harm oracle fired. The `evil-agent` and `evil-company` rows were rerun on 12 October 2026 after the malicious-Company attacks `XB` (oversized `poppy.json`), `XN` (DPoP nonce loop), `XO` (operation terms swapped under their id), `XP` (consent spoofing) and `XE` (a forged message from the User), and the malicious-agent attack `YM` (confirm without approval), were added; the network row is unchanged. Still listed, not yet built: `XM` (a mix-up needs two Companies in one cell), `XS` (needs the N42 "private" test suffix), `YF` (a code only returns through the consent hook) and `YC` (needs a consent-page reader) — see [`docs/adversarial-interop.md`](../adversarial-interop.md).

