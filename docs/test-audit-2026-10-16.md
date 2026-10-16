# Test audit, 16 October 2026

This follow-up addresses the seven outstanding findings from the test audit:
audience-attack evidence, nearest-double rounding, PDA client/account isolation,
accepted RSA verifier variants, address/DNS properties, reconnect sequences and
the runtime timezone set. The changes are in [PR #7](https://github.com/adewale/pda/pull/7).

The review used the repository's [Hegel skill](../.claude/skills/hegel/SKILL.md)
and [review checklist](../.claude/skills/hegel-review/SKILL.md), with the engine
from [hegel.dev](https://hegel.dev/). A test passing is evidence only for the
contract its oracle observes. Increasing case counts cannot repair a missing
oracle or an unsupported interop scenario.

## Findings and resulting behavior

| Finding | Change and observable evidence |
| --- | --- |
| YA could count a DPoP nonce challenge as proof of audience validation. | Establish an accepted, nonce-aware token request first. Require a fresh request with the intended foreign client-assertion audience, stable remaining claims, fresh Session/proof identifiers and the negotiated nonce. Only the specified `invalid_client` refusal proves protection; a nonce challenge is unsupported, missing setup is a harness error, and unrelated errors fail. Negative controls exercise misleading traces. |
| A relative-error bound did not establish nearest binary64 rounding. | Decode binary64 values into exact fractions and check the exact interval between adjacent midpoints, including ties-to-even, signed zero, subnormals and overflow. The new oracle reproduced a real calculator defect: `1 + 2^-53 + 2^-100` rounded to `1`. The implementation now rounds the exact quotient and remainder once at binary64 spacing. |
| One PDA identity/account could not expose cross-user or cross-account leaks. | Two real PDA clients, with separate SQL stores, each sign into both fixture accounts. An independent ownership model checks tokens, sessions, conversations, operations and actual order ownership after generated actions. Deliberately copied sealed tokens must fail renewal across both user and account boundaries. |
| The verifier advertised RS256 without positive coverage. | Parameterize accepted client assertions, Session assertions and self-contained DPoP proofs over ES256 and RS256, using matching real public keys. Assert the returned client identity/key set, User ID or DPoP thumbprint rather than acceptance alone. For each credential and algorithm, require a correctly signed baseline to pass and a proof/assertion signed by another key to fail with exactly the signature violation. The PDA's own signer continues to use ES256. |
| Address and DNS behavior had examples but no generated numeric model. | Compare IPv4/IPv6 values and special-range endpoints to independent numeric intervals. Exercise embedded IPv4 spellings, IPv6 compression/padding/case, malformed addresses, changing resolver answers and mixed public/private answers. Require the exact checked answer to be used, without a second resolution for the same connection. |
| Individual outbox examples did not establish reconnect behavior across sequences. | Drive the five real reducers against an independent ordered-map model through enqueue/send/disconnect/ack/failure/retry/dismiss actions. Check complete payloads and IDs, input immutability and that acknowledged messages never reappear. A separate example processes 100,000 pending messages. |
| Calendar properties chose only nine zones. | Draw from `Intl.supportedValuesOf("timeZone")` plus UTC, retaining transition examples. This covers the runtime's enumerated set; it is not a claim to enumerate every accepted timezone alias. |

The earlier changes in the same PR also retain MockCompany evidence and detect
replacement instances; verify actual outgoing model inputs, downloads, account
selection, cookies, privacy, token watches and push identity; and observe
approval, replay, retention, asynchronous recovery and background compaction
outcomes. Python session/order/privacy oracles have deliberate failing controls.

The additional audience review includes all three mock policies: lenient,
exact endpoint and token endpoint only. A raw endpoint-specific assertion should
be refused at a non-token endpoint under the third policy. A separate real PDA
flow checks token renewal and successful revocation through its existing
audience fallback, including the expected `[401, 200]` revocation trace.

## PBT assessment

The strongest properties now use independent representations: exact rational
intervals rather than the calculator, ownership records rather than returned
token fields, endpoint intervals rather than prefix masks, and an ordered map
rather than the outbox array. Real cryptographic verification and real PDA
flows complement those models. Rejection properties require the intended error
and recorded violation, with accepted baselines to prevent an always-rejecting
implementation from passing.

| Review area | Evidence and limit |
| --- | --- |
| Surfaces and variants | A TypeScript AST inventory records 904 named source exports/re-exports and 191 class entry points, with associated property imports or a stated reason for example/integration coverage. Import association is an index, not proof that every export is semantically covered. Pure types are checked by TypeScript; Workers, storage, routing and UI effects retain their dedicated integration suites. Interop build scheduling is reviewed separately from the application source index. |
| Accept and reject directions | Structured valid and one-defect inputs check JSON, JWT, discovery, path filling, durations and address parsing. Garbage/no-crash properties remain resilience checks and do not establish semantic rejection of every malformed input. |
| Configuration | Audience, nonce scope, assertion strictness, refresh rotation and session behavior are generated where applicable. Focused properties cover token-endpoint-only fallback. The longer general PDA state histories still use the lenient and exact endpoint policies. |
| Numeric domain | Supported rounding precision, tiny magnitudes, subnormals, midpoint ties, sticky bits and duration unit endpoints are explicit. No tolerance substitutes for the exact nearest-double contract. |
| State and scale | Generated PDA interleavings and outbox histories are bounded for execution cost. They do not prove arbitrary history length, scheduler fairness or durable crash recovery. Large outbox and scheduler examples each process 100,000 items; parser examples cover deep input and the exact accepted nesting boundary. |
| Oracle controls | The earlier audit killed 16 injected faults. This follow-up adds misleading attack-trace controls, copied-token controls and a reproduced calculator defect. No new full mutation score is claimed. |
| Triage | Failures in new tests were corrected rather than suppressed: response-envelope expectations, the `dropToken` options shape and audience-compatible replay baselines. Deep Python control observations now use fresh localhost sockets after connection resets; this adds no retry of protocol requests or skipped invariant. |

Hegel runs in Node because its native engine is unavailable in workerd. The
in-process model uses the production PDA protocol code with test SQL/host
adapters. It does not replace the Workers, durability or Docker suites. Deep
Hypothesis uses an independent Python client against the mock Company, which
can find mock/model disagreements but cannot establish production PDA behavior
by itself.

## Validation record

The regular GitHub Test and Interop workflows pass on `cc44ddf`:
1,494 tests passed with one intentional skip across the five Vitest
configurations; TypeScript and documentation checks passed. This includes the
third audience policy, accepted DPoP variants and the focused PDA fallback
property and the returned-identity assertions. The identity assertions also
passed their targeted deep runs. This includes the six wrong-signature
variants and the explicit known-failure metadata.

Completed follow-up checks:

- All Hegel properties have passed at `HEGEL_CASES=5000` across partitioned runs (141 tests including fixed examples, ten files). Changed properties were rerun; the entries below identify those runs rather than adding duplicate totals.
- Nine non-model Hegel files: 128 tests passed with `HEGEL_CASES=5000`.
- Final address/outbox files: nine tests passed at that setting after their additions.
- Final crypto/attack expansion: 18 tests passed at that setting, including the third audience policy and accepted DPoP variants.
- Real PDA audience fallback: one focused property passed at that setting; the other two model properties were not selected in that run.
- Both general PDA state models: passed at that setting, including the two-client/two-account model; the run took 4,188 seconds alongside the Python suites.
- Final returned-client-identity/key-set assertions and replay baseline: four properties passed at that setting in focused runs.
- Wrong-signature controls for all three credentials under ES256 and RS256: six properties passed at that setting.
- Final build-scheduler properties: 15 tests passed at that setting.
- Interop unit suite: 205 tests passed.
- Docker adversarial agent lane: 16 pass against both mock profiles.
- Docker adversarial Company lane: 10 pass.
- Docker network-fault lane: eight pass against both mock profiles.
- Those Docker runs reported zero failures, harness errors or unsupported cells; isolation probes passed.
- Live discovery: three pass, for Ilmer, Poppyseed and Alpine Retail.

The full deep Hypothesis profile (2,000 examples, up to 60 steps) is still
running at the time of this record: ten oracle controls and four of five
state machines have passed.

The [first full pinned ecosystem job](https://github.com/adewale/pda/actions/runs/38829561008)
produced all 2,880 cells (eight agents, twelve Companies, thirty scenarios):
967 pass, 262 fail, 1,291 unsupported and 360 setup errors. All setup errors
come from the Everruns agent image failing to fetch a dependency with an SSL
peer EOF. Its 360 cells did not execute. The missing row is
[rebuilding in two isolated shards](https://github.com/adewale/pda/actions/runs/38835758531).
Those observations will replace only the setup-error row, with attribution
recomputed over the full grid. The first run's four stale Everruns expectations
remain in place until that row executes.

The first grid's sole unexpected PDA failure was the already documented
held-proposal behavior in S22. Its known-failure entry omitted the observed
`expect ${p.status}` error code. The entry now supplies that exact code and
an empty failed-check list; a control confirmed that the actual cell matches
while a different error code remains unexpected. Its outcome remains a failure.

The local 32 GB Docker volume could not hold all builds. The runner now bounds
build concurrency (default two), preserves completed build logs immediately
and disables unneeded Rust debug data. Cargo dependency fetches use Git's CLI
with five network retries, preserving TLS verification. This changes build
transport, not protocol-request retry behavior. Detailed ecosystem results
remain encrypted outside Git pending private triage under
[SECURITY.md](../SECURITY.md); no new third-party vulnerability details are
published in this report. Build errors, unsupported cells and unexecuted cells
remain distinct from passes.

The first ecosystem job used `96be076`. The current build-fetch settings and
known-failure metadata differ, but Git tree hashes confirm identical
application, mock Company, runner and proxy source trees. The follow-up uses
the same upstream pins. Combining the observations does not represent them
as one simultaneous Docker run.

Builds fetch public dependencies and pinned upstream sources. Protocol tests
then run on internal Docker networks whose egress refusal is probed before
implementations start. Adversarial scenarios run only against our own
implementations; the broad ecosystem matrix uses honest scenarios. Synthetic
sessions, accounts and protocol traffic exercise discovery, nonce handling,
sign-in/out, conversations, operations and the other declared capabilities.
They do not use personal accounts or a live model.

Live signed-out Session/nonce/conversation scenarios require a legitimate
public client identity and its matching private interop key. Neither the
identity file nor deployment configuration is present in this workspace; its
location has been requested. An attempt to establish an isolated temporary
public metadata host could not connect from this environment; no client
identity or key was published. Discovery needs neither, so only discovery is
claimed for public Companies so far. No production key or deployment was changed.

## Reproduction

The regular commands remain `npm run typecheck`, `npm test` and
`npm run check:docs`. Deep validation is opt-in:

```sh
HEGEL_CASES=5000 npm run test:properties
npm run test:hypothesis -- --hypothesis-profile=deep
```

This audit partitioned the Hegel files and reran changed properties. For the
final Python run it used temporary pytest-xdist, without adding a project
dependency, with one isolated mock server per worker:

```sh
uv run --with pytest-xdist --directory test/hypothesis --frozen \
  pytest -n 4 --dist=loadfile --hypothesis-profile=deep
```

The deep budgets increase exploration and execution time; regular CI keeps
the existing default counts. Workspace logs, a machine-readable validation
summary, source inventory and failure ledger are retained outside Git in
`/workspace/pda-follow-up-audit`.
