# The official Company validator's lanes

The pinned, unmodified official Company validator (`kit/company/validate` in [personal-agent-protocol/personal-agent-protocol](https://github.com/personal-agent-protocol/personal-agent-protocol), copied by `npm run spec:import` into [`spec/draft-0.2-2026-10-19/`](../../../spec/draft-0.2-2026-10-19/kit/company/validate/README.md) and hash-checked by `npm run check:spec`). It acts as a test Personal Agent against a Company. Both lanes reuse the harness's internal network, recording proxy, CA, identity hosting and cleanup. All upstream code runs inside Docker; the validator has no internet route, and its private test key exists only in its temporary container.

Neither is an M×N implementation: the validator advertises no interop scenarios, so its placeholder cell is `unsupported` and it adds nothing to the grid's pass rates.

## Against the 0.2 Companies: `npm run interop:official`

Runs `check` against our mock (`lenient-company-v02`) and Datalayer's two SDK Companies (`datalayer-ts-v02`, `datalayer-py-v02`), or the ones named with `--targets a,b`. Each report is `official-validator-<company>.json` in the run directory, with a summary in `official-validator.json`. The script fails when the validator never runs against a target or finds a MUST failure in our mock; another project's failure is a finding, not a script failure. CI runs it against our mock only (`--targets lenient-company-v02`), since the SDK Companies build from upstream.

Official negative checks deliberately send invalid assertions and proofs: their success is the Company refusing them, not a clean trace of an ordinary agent.

**24 October:** all three Companies get 69 pass, 0 fail, 0 warn, 5 skip, with the same five skips (`dpop.nonce`, which needs a Company that requires nonces, and four `mcp.bearer-*` checks, which need MCP with Bearer tokens). The [flawed-Company lane](#the-flawed-company-lane-npm-run-interopflaws)'s honest variants reach those: 70 pass and 4 skip each. [Result summary](../../../docs/interop-results/2026-10-24-official-and-flaws.json).

## The flawed-Company lane: `npm run interop:flaws`

Is a checker any good? Give it a Company with a known flaw and see whether it notices. The official validator's own tests do this with an in-memory Company (`test/fake-company.ts`); this lane does it to our 0.2 mock with ten flaws (`COMPANY_FLAWS` in [`test/mock-company/types.ts`](../../../test/mock-company/types.ts)), each turning off one of the Company's protections. The pda-mock adapter takes them from `INTEROP_MOCK_FLAWS`, which only this script sets (`--set`); `test/mock-company.test.ts` proves each one changes what the mock does.

For each flaw, one harness run checks the flawed mock with the official validator and with our own checkers that claim the protection: the adversarial agent's attacks (`YR`, `YD`, `YT`, `YS`, `YA`, `YK`) and the strict agent's Company-side checks (`S0`, `CIDUP`). Three honest variants first: the honest mock, one that requires DPoP nonces and one with Bearer MCP at 0.2 (`INTEROP_MOCK_VARIANT`). On every honest variant all six attacks and both strict-agent scenarios pass and the official validator finds nothing, so a failure under a flaw is the flaw's. Information only: the exit status is 0 unless the harness failed. `--flaws a,b` runs only those.

**24 October** ([summary](../../../docs/interop-results/2026-10-24-official-and-flaws.json)):

| Flaw | Official validator | Ours |
| --- | --- | --- |
| `accept-replayed-assertion` | caught (`session.assertion-replay`) | caught (`YR`) |
| `accept-replayed-proof` | caught (`dpop.token-replay`) | caught (`YD`) |
| `accept-wrong-htu` | caught (`dpop.token-htu`, `dpop.resource-htu`) | nothing targets it |
| `accept-other-key` | caught (`dpop.wrong-key`) | caught (`YT`) |
| `accept-bearer-scheme` | caught (`dpop.bearer-scheme`) | caught (`YS`) |
| `accept-query-token` | caught (`dpop.token-in-url`) | nothing targets it |
| `accept-token-endpoint-aud` | caught (`session.client-assertion-aud`) | **missed**: `YA` sends another Company's `aud`, not this one's token endpoint |
| `token-cacheable` | caught, a warning (`session.no-store`, SHOULD) | **missed**: no Company-side check looks at `Cache-Control` |
| `retry-new-conversation` | caught (`conversations.retry-same-id`; also `message-id-conflict`) | caught (`CIDUP`) |
| `accept-rotated-account-token` | nothing targets it (sign-in isn't automated) | caught (`YK`) |

Before this lane, the adversarial agent couldn't open a Session at a 0.2 Company at all: it signed both assertions for the token endpoint, and 0.2 wants the issuer, so every attack ended `error` before it was sent. It now uses the issuer from 0.2 on, as our client does (`interop/impls/pda-agent/attacks.ts`), and the runner's `YA` evidence accepts a baseline `aud` on the token endpoint's origin.

## What each official check maps to

[`spec/official-checks-0.2.json`](../../../spec/official-checks-0.2.json) maps each of the 74 checks in the pinned catalog to what of ours would notice a Company breaking the same requirement: a validator message, a runner check, a scenario or an attack. 49 have something of ours behind them and 25 have nothing, mostly negative conversation checks (an empty message, an unknown cursor, a second close) and DPoP refusals no agent of ours provokes. `interop/test/official-coverage.test.ts` holds it to the catalog and checks that every reference exists. It doesn't judge whether either side's check is right; the flawed-Company lane does that for the security checks.

The other way round, the validator doesn't automate sign-in or Operations in this revision, which our grid covers with its hooks. Agreement is not certification: these lanes supplement the independent Python client, Datalayer's cases and the interop grid.
