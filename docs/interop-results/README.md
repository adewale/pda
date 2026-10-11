# Interop grid results

A copy of one run of the [interop harness](../../interop/README.md), so the grid can be read without running it:

- [`results.json`](results.json): every cell's outcome, blame, rule, steps and checks ([interop spec](../interop-spec.md) section 9).
- [`index.html`](index.html): the same as one grid per scenario. Its links to each cell's HAR point at files that aren't committed (they hold every request and response of the run).

The run, on 11 October 2026 (`2026-10-11T18:10:44Z`), local lane:

```sh
npm run interop -- --no-build --agents dpa,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,adonis-agora \
  --companies dpa-mock,dpa-mock-strict,datalayer-ts,datalayer-py,pi-poppy,poppy-demo,poppyseed,ilmer,adonis-agora
```

Our implementations are at `18cbaa6`; Datalayer at `12d71877`, pi-poppy at `11ea1063`, poppy-demo at `02a9b304`, poppyseed at `f479fb6b`, Ilmer at `4ca76e00`, adonis-agora's Company at `97838853` and its agent at `e66a2329`. 1,242 cells: 659 pass, 143 fail, 440 unsupported, 0 errors. Every failure is a known upstream or spec failure, and no known failure went unmatched, so the run exits 0.

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
- A few cells whose real cause is elsewhere are labelled reading because the scenario lists a question the two sides happen to declare differently: poppy-demo × dpa-mock and dpa-mock-strict, D (S3, though the issuer has no path) and poppy-demo × Ilmer, S0. Their known-failure reasons give the cause.

**Rule 4, unattributed (no single side by rule; the known failure names the cause):**

- poppy-demo × dpa-mock, dpa-mock-strict and adonis-agora (the rest): its caller requires `auth.issuer` to equal the Company's origin, and those issuers are on `auth.` or under `/poppy` ([N36](../spec-issues.md#n36)).
- poppy-demo × Ilmer: Ilmer's metadata has no `authorization_endpoint`, and the caller runs `new URL(undefined)` on it.
- poppy-demo × Datalayer TS and Python, SD, SX, CA, SO, AO: the caller always asks for its hard-coded `poppy:read poppy:write`; Manzanita offers only `orders:read` and `orders:write` and answers `invalid_scope`.
- poppy-demo × poppyseed, SO: poppyseed answers revocation with an empty 200 (RFC 7009 allows it); the caller parses it as JSON and throws.
- adonis-agora × Datalayer TS and Python, SE: adonis-agora recovers from an ended Session by renewing with its Account Token and no `session_id`, which Poppy 4.8 says starts a new signed-in Session; Datalayer's Companies require `session_id` and answer `invalid_session`.
- pi-poppy × Datalayer TS and Python, O and OX: Datalayer sends optional Operation members as `null`, which pi-poppy rejects ([N41](../spec-issues.md#n41)).
- datalayer-ts × dpa-mock, dpa-mock-strict and both Datalayer Companies, CS: the TypeScript `ConversationClient.stream` reconnects at once and gives up with `stream_unavailable` after five empty reconnects.

The triage that produced this run also fixed harness bugs that had shown as failures: metadata appended to an issuer's path (S3 `append`) wasn't recognised by scenario D or the revocation check; declared readings were keyed by name, so a project's Company's readings replaced its agent's; and three adapters (datalayer-py ignored `servers`, adonis-agora didn't accept `"METHOD /path"` or a body-only Poppy error, datalayer-ts sent a retried first message to the conversation it had started; see [S9](../spec-issues.md#s9)).
