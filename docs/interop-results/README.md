# Interop grid results

A snapshot: the summary of one run of the [interop harness](../../interop/README.md), on 11 October 2026. It isn't regenerated, so it goes stale as the code changes. The full results (`results.json`, the `index.html` grid and a HAR file per cell) aren't committed. To get them:

- **Run the grid locally** (needs Docker): `npm run interop` with the command below, or `npm run interop -- --agents dpa --companies dpa-mock,dpa-mock-strict` for our own pair. Each run writes to `interop/results/<run>/` (gitignored); [interop spec](../interop-spec.md) section 9 describes the files.
- **Download CI's**: the Interop workflow (`.github/workflows/interop.yml`) runs our agent against both of our mocks and uploads the `interop-results` artifact from each run.

The command, run at `2026-10-11T20:18:42Z` on the local lane:

```sh
npm run interop -- --no-build --agents dpa,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,adonis-agora \
  --companies dpa-mock,dpa-mock-strict,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,poppyseed,ilmer,adonis-agora
```

Our implementations are at `18cbaa6` (the images were not rebuilt; `src/`, the mock and our adapters were unchanged since, and the run's `results.json` recorded `04c2471-dirty`, the runner's own uncommitted retry, cleanup and attribution changes); Datalayer at `12d71877`, pi-poppy at `11ea1063`, poppy-demo at `02a9b304`, poppyseed at `f479fb6b`, Ilmer at `4ca76e00`, adonis-agora's Company at `97838853` and its agent at `e66a2329`. 1,242 cells: 659 pass, 143 fail, 440 unsupported, 0 errors. Every failed cell was run a second time and failed again, so no cell was flaky. Every failure is a known upstream or spec failure, and no known failure was stale (each matched a failed cell), so the run exits 0.

Pass / fail / unsupported, by agent (rows) and Company (columns), over 23 scenarios:

| | dpa-mock | dpa-mock-strict | datalayer-ts | datalayer-py | pi-poppy | poppy-demo | poppyseed | ilmer | adonis-agora |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **dpa** | 23 / 0 / 0 | 23 / 0 / 0 | 18 / 0 / 5 | 18 / 0 / 5 | 19 / 0 / 4 | 10 / 0 / 13 | 19 / 0 / 4 | 4 / 0 / 19 | 18 / 0 / 5 |
| **datalayer-ts** | 20 / 2 / 1 | 20 / 2 / 1 | 17 / 1 / 5 | 17 / 1 / 5 | 17 / 1 / 5 | 10 / 0 / 13 | 18 / 0 / 5 | 4 / 0 / 19 | 18 / 0 / 5 |
| **datalayer-py** | 22 / 1 / 0 | 22 / 1 / 0 | 18 / 0 / 5 | 18 / 0 / 5 | 18 / 1 / 4 | 10 / 0 / 13 | 19 / 0 / 4 | 4 / 0 / 19 | 18 / 0 / 5 |
| **pi-poppy** | 19 / 3 / 1 | 1 / 21 / 1 | 14 / 3 / 6 | 14 / 3 / 6 | 16 / 2 / 5 | 1 / 9 / 13 | 17 / 1 / 5 | 1 / 3 / 19 | 15 / 2 / 6 |
| **poppy-demo** | 0 / 9 / 14 | 0 / 9 / 14 | 3 / 5 / 15 | 3 / 5 / 15 | 7 / 0 / 16 | 8 / 0 / 15 | 6 / 1 / 16 | 0 / 3 / 20 | 0 / 9 / 14 |
| **adonis-agora** | 20 / 0 / 3 | 1 / 19 / 3 | 12 / 4 / 7 | 12 / 4 / 7 | 13 / 3 / 7 | 1 / 9 / 13 | 14 / 3 / 6 | 1 / 3 / 19 | 18 / 0 / 5 |

Unsupported cells are scenarios one side doesn't list or a hook it doesn't have: Ilmer is signed-out only, poppy-demo's agent does Direct Sign-In and one API operation, and only some Companies have the Operations extension, MCP or Device Sign-In.

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

Rule 3 now needs evidence in the trace that the question mattered (a `reading.<id>.refused` check or a Company-recorded error of that question), not only two declarations that differ. Every cell above has it. Three cells the previous grid labelled reading had none and are now unattributed (below): poppy-demo × dpa-mock and dpa-mock-strict, D, where poppy-demo refuses `poppy.json` for its `auth.` issuer before fetching any metadata, so S3 never came up; and poppy-demo × Ilmer, S0, where the caller crashes on Ilmer's missing `authorization_endpoint`, not on S1.

**Rule 4, unattributed (no single side by rule; the known failure names the cause):**

- poppy-demo × dpa-mock, dpa-mock-strict and adonis-agora (the rest, now including D at both mocks): its caller requires `auth.issuer` to equal the Company's origin, and those issuers are on `auth.` or under `/poppy` ([N36](../spec-issues.md#n36)).
- poppy-demo × Ilmer (D, S0 and C): Ilmer's metadata has no `authorization_endpoint`, and the caller runs `new URL(undefined)` on it.
- poppy-demo × Datalayer TS and Python, SD, SX, CA, SO, AO: the caller always asks for its hard-coded `poppy:read poppy:write`; Manzanita offers only `orders:read` and `orders:write` and answers `invalid_scope`.
- poppy-demo × poppyseed, SO: poppyseed answers revocation with an empty 200 (RFC 7009 allows it); the caller parses it as JSON and throws.
- adonis-agora × Datalayer TS and Python, SE: adonis-agora recovers from an ended Session by renewing with its Account Token and no `session_id`, which Poppy 4.8 says starts a new signed-in Session; Datalayer's Companies require `session_id` and answer `invalid_session`.
- pi-poppy × Datalayer TS and Python, O and OX: Datalayer sends optional Operation members as `null`, which pi-poppy rejects ([N41](../spec-issues.md#n41)).
- datalayer-ts × dpa-mock, dpa-mock-strict and both Datalayer Companies, CS: the TypeScript `ConversationClient.stream` reconnects at once and gives up with `stream_unavailable` after five empty reconnects.

The triage behind the previous run (`18cbaa6`) also fixed harness bugs that had shown as failures: metadata appended to an issuer's path (S3 `append`) wasn't recognised by scenario D or the revocation check; declared readings were keyed by name, so a project's Company's readings replaced its agent's; and three adapters (datalayer-py ignored `servers`, adonis-agora didn't accept `"METHOD /path"` or a body-only Poppy error, datalayer-ts sent a retried first message to the conversation it had started; see [S9](../spec-issues.md#s9)).
