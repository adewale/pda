# Interop grid results

A copy of one run of the [interop harness](../../interop/README.md), so the grid can be read without running it:

- [`results.json`](results.json): every cell's outcome, blame, rule, steps and checks ([interop spec](../interop-spec.md) section 9).
- [`index.html`](index.html): the same as one grid per scenario. Its links to each cell's HAR point at files that aren't committed (they hold every request and response of the run).

The run, on 11 October 2026 (`2026-10-11T17:19:41Z`):

```sh
npm run interop -- --no-build --agents dpa,datalayer-ts,datalayer-py,pi-poppy \
  --companies dpa-mock,dpa-mock-strict,datalayer-ts,datalayer-py,pi-poppy
```

Our implementations are at `33ec7e1` (`-dirty` only because `interop/known-failures.json` was being edited); Datalayer at `12d71877`, pi-poppy at `11ea1063`. 460 cells: 354 pass, 42 fail, 64 unsupported, 0 errors. Every failure is a known upstream or spec failure, so the run exits 0.

Pass / fail / unsupported, by agent (rows) and Company (columns), over 23 scenarios:

| | dpa-mock | dpa-mock-strict | datalayer-ts | datalayer-py | pi-poppy |
| --- | --- | --- | --- | --- | --- |
| **dpa** | 23 / 0 / 0 | 23 / 0 / 0 | 18 / 0 / 5 | 18 / 0 / 5 | 19 / 0 / 4 |
| **datalayer-ts** | 20 / 2 / 1 | 20 / 2 / 1 | 17 / 1 / 5 | 17 / 1 / 5 | 17 / 1 / 5 |
| **datalayer-py** | 22 / 1 / 0 | 22 / 1 / 0 | 18 / 0 / 5 | 18 / 0 / 5 | 18 / 1 / 4 |
| **pi-poppy** | 19 / 3 / 1 | 1 / 21 / 1 | 14 / 3 / 6 | 14 / 3 / 6 | 16 / 2 / 5 |

The failures, each in [`known-failures.json`](../../interop/known-failures.json) with its upstream source link:

| Cells | Rule, blame | Cause |
| --- | --- | --- |
| pi-poppy × dpa-mock-strict, 19 scenarios | reading, spec | S2: pi-poppy's Session assertion has no `typ` and it declares S2 `any`; the strict mock declares `jwt-60s`. The lenient reference `dpa-mock` accepts it. |
| pi-poppy × every Company that asks for nonces, N and SVN | violation, agent | On `use_dpop_nonce` pi-poppy re-signs the client assertion and proof but resends the same Session assertion: `session-assertion.jti-reused`. |
| pi-poppy × every Company, SE | grid, agent | After the Company ends the Session, pi-poppy renews, gets `invalid_session` and throws instead of starting a new Session (Poppy 4.2). |
| pi-poppy × Datalayer TS and Python, O and OX | unattributed | Datalayer answers `"expires_at": null` and `"result": {"data": null}`; pi-poppy accepts these members absent, not null. The Operations extension doesn't say whether optional members may be null. |
| datalayer-ts and datalayer-py × every Company that asks for nonces, SVN | violation or grid, agent | Device polling never retries `use_dpop_nonce` (Poppy 4.3, RFC 9449 section 8). |
| datalayer-ts × dpa-mock, dpa-mock-strict, Datalayer TS and Python, CS | unattributed | The TypeScript `ConversationClient.stream` reconnects at once and gives up with `stream_unavailable` after five empty reconnects. |
