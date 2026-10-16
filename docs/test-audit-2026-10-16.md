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
| One PDA identity/account could not expose cross-user or cross-account leaks. | Two real PDA clients, with separate SQL stores, each sign into both fixture accounts. An independent ownership model checks tokens, sessions, conversations, operations and actual order ownership after generated actions. Separate fixed controls require copied sealed tokens to fail renewal across user and account boundaries, with accepted baselines and successful restoration. These controls run once each, outside the generated histories. |
| The verifier advertised RS256 without positive coverage. | Parameterize accepted client assertions, Session assertions and self-contained DPoP proofs over ES256 and RS256, using matching real public keys. Assert the returned client identity/key set, User ID or DPoP thumbprint rather than acceptance alone. For each credential and algorithm, require a correctly signed baseline to pass and a proof/assertion signed by another key to fail with exactly the signature violation. The PDA's own signer continues to use ES256. |
| Address and DNS behavior had examples but no generated numeric model. | Compare IPv4/IPv6 values and special-range endpoints to independent numeric intervals. Exercise embedded IPv4 spellings, IPv6 compression/padding/case, malformed addresses, changing resolver answers and mixed public/private answers. Require the exact checked answer to be used, without a second resolution for the same connection. |
| Individual outbox examples did not establish reconnect behavior across sequences. | Drive the five real reducers against an independent ordered-map model through enqueue/send/disconnect/ack/failure/retry/dismiss actions. Check complete payloads and IDs, input immutability and that acknowledged messages never reappear. A separate overload regression checks mixed waiting/sent/failed entries across three reconnect cycles at 100,000 messages, exact payload/order retention and per-operation input-traversal budgets. |
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
| Accept and reject directions | Structured valid and one-defect inputs check JSON, JWT, discovery, path filling, durations and address parsing. Garbage/no-crash properties remain resilience checks and do not establish semantic rejection of every malformed input. |
| Configuration | Audience, nonce scope, assertion strictness, refresh rotation and session behavior are generated where applicable. Focused properties cover token-endpoint-only fallback. The longer general PDA state histories still use the lenient and exact endpoint policies. |
| Numeric domain | Supported rounding precision, tiny magnitudes, subnormals, midpoint ties, sticky bits and duration unit endpoints are explicit. No tolerance substitutes for the exact nearest-double contract. |
| State and scale | Generated PDA interleavings and outbox histories are bounded for execution cost. They do not prove arbitrary history length, scheduler fairness or durable crash recovery. The outbox overload test counts input visits instead of claiming a wall-time or supported-capacity guarantee; the scheduler also has a 100,000-item example; parser examples cover deep input and the exact accepted nesting boundary. |
| Oracle controls | The earlier audit killed 16 injected faults. This follow-up adds misleading attack-trace controls, copied-token controls and a reproduced calculator defect. No new full mutation score is claimed. |
| Triage | Failures in new tests were corrected rather than suppressed: response-envelope expectations, the `dropToken` options shape and audience-compatible replay baselines. Deep Python control observations now use fresh localhost sockets after connection resets; this adds no retry of protocol requests or skipped invariant. |

Hegel runs in Node because its native engine is unavailable in workerd. The
in-process model uses the production PDA protocol code with test SQL/host
adapters. It does not replace the Workers, durability or Docker suites. Deep
Hypothesis uses an independent Python client against the mock Company, which
can find mock/model disagreements but cannot establish production PDA behavior
by itself.

The mock is part of the test oracle: an incorrect ownership rule or an
always-accepting verifier would mislead the client tests. Independent Python
histories and deliberate invalid-input controls check that oracle; they still
cannot settle a shared misreading of the draft. Third-party interoperability
provides another perspective, with unsupported scenarios explicitly excluded
from successful evidence.

## Local recovery follow-up and priorities

`test/recovery.test.ts` builds a bounded set of histories in local workerd:
confirmation lost before/after peer handling, object termination before approval or after
an uncertain answer, overlapping approvals, simultaneous socket resubmissions,
revocation across termination, missing durable jobs, delivery retry counts across
evictions and authorization changes before a due task. It uses actual agent
SQLite, lifecycle recovery, sockets and alarms with fake Companies/providers.
Individual-object aborts/evictions do not reset the peer's evidence. Approval,
socket and revocation histories terminate an individual object with
`DurableObjectState.abort`; reminder histories exercise graceful eviction.
Graceful eviction waits for in-flight work and cannot stand in for a crash. This adds
controlled failure/interleaving coverage, not arbitrary concurrent PBT or proof
of deployed Cloudflare behavior.

The Node histories select commands enabled by the current model. Counts are
incremented only after a command completes, summed against the requested trace
length, and reported for successful examples. Initialization is excluded from
the isolation counts; an expected signed-out refusal has its own label.
Renewal executes a token request instead of merely dropping a cache. Counts
measure executed actions, including intentional idempotent actions, not unique
states, exhaustive transition coverage or a number of independent guarantees.
Fixed copied-token controls no longer run inside every generated example. Deployment
signing keys are fresh per test worker, not regenerated for every history;
cryptographic key/algorithm variation remains in its dedicated properties. The
outbox histories intentionally retain late acknowledgements and other
idempotency probes; their counts separate actual state changes from intentional
no-ops instead of calling both state transitions. The first measured run
exposed zero effective retries/dismissals despite many attempts: IDs were drawn
without reference to failed entries. The generator now selects eligible IDs
and commands for most steps, with a smaller deliberate no-op class. Every
history starts with a generated enqueue, so an all-no-op trace cannot pass as
stateful coverage.

The outbox stress budgets apply to a single reducer call, not total work to
empty the queue. Acknowledging every message individually can still require
quadratic total work with the array representation. The stress regression
makes no efficient-whole-queue-draining claim.

The priority order is based on possible harm and remaining uncertainty:

| Priority | Evidence added locally | Remaining boundary |
| --- | --- | --- |
| Approval and effects | Lost-request/answer histories, replay after abrupt termination, overlapping approvals | Process termination while an external peer is committing; recovery with non-idempotent peers |
| Message/event ordering | Simultaneous socket duplicates and resend after abrupt termination; existing cursor/replay examples | Generated event-reader races and failure between every handling/cursor boundary |
| Isolation/revocation | Local access stays revoked across abrupt termination while remote revocation is pending; generated account ownership and copied-token controls | Every combination of credential expiry and in-flight background work |
| Durable jobs | Missing job recovery, retries through eviction, one committed reminder run, authorization rechecked before tasks | Arbitrary alarm schedules, crash points and eventual-progress/fairness claims |
| Independent interoperability | Prior pinned matrix retained as historical evidence | No live or Docker matrix rerun in this local-only follow-up; signed live flows remain unverified |
| Oracle effectiveness and architecture | Enabled-command counts, focused negative controls, review of PR implementation changes | Counts do not prove correctness; targeted fault controls and storage/transaction boundaries still require review |

The follow-up deliberately makes no production requests, deployment, paid API
calls or remote CI runs. Local providers, web requests, push services and
Companies are faked; normal tests need no deployment credentials.

## Implementation review of the PR branch and local follow-up

The application changes are small and separate from the harness changes:

| Application file | Behavior and verification |
| --- | --- |
| `src/tools/calculate.ts` | Exact quotient/remainder rounding to nearest binary64, ties to even; independent rational-interval properties cover sticky bits, subnormals, signed underflow and overflow. |
| `src/client.tsx`, `src/main.tsx`, `index.html` | Separate the page component from DOM bootstrap. Sign-in tests import once and mount/unmount the real App instead of resetting all modules and importing during an active React act. The browser entry still renders the same component. |
| `src/use-pi-session.ts` | Extract retry/dismiss reducers and use them in the actual hook, retaining original operation IDs/payloads. Reducer models, the mixed-state stress regression and UI socket tests exercise them. |
| `src/poppy/operations.ts` | Validate response identity/content before settling confirmation uncertainty; restore missing tracking jobs on startup. Reserve the per-operation confirmation guard before awaiting recovery-job persistence. A new standalone reproducer sent two confirms before the fix; after it, one. Another control makes the job write fail and verifies a later attempt can proceed, with no request sent before persistence succeeds. The mock performed once even in the duplicate-request reproducer; no duplicate business effect is claimed. |
| `src/poppy/capability.ts` | Run operation-job recovery on lifecycle startup; existing stable jobs retain their schedule. |
| `src/agent.ts` | Run lifecycle startup on authenticated native RPC after recording identity. Native RPC bypasses lifecycle fetch/alarm/WebSocket handlers. The local Settings-route reproducer returned without restoring a missing reminder job before the fix; it now restores it before returning. |

Executable interop changes are in `interop/impls/pda-agent/{attacks,adapter}.ts`
and `interop/runner/{traces,cell,cli,docker}.ts`: accepted nonce-aware attack
setup, precise refusal/evidence classification and bounded image builds with
completed-log retention. The Everruns Dockerfiles change dependency-fetch
transport/debug data, not wire behavior. Known-failure metadata records the
existing failure; it does not turn it into a pass.

Test infrastructure changes retain the mock's evidence and add observation
hooks. `scripts/run-tests.mjs`, `scripts/test-projects.mjs` and
`scripts/check-docs.mjs` share the project list and invocation-local discovery
reports. The checker has controls for failed/skipped/parameterized tests,
missing/partial/malformed reports, both discovery paths and titles containing
the suite separator. No source-export inventory or new dependency is required.

## Repairs after the independent multi-agent review

Confirmation, read and cancel responses must decode to the requested operation.
A successful confirm must also describe the approved revision in a confirmed
state. Malformed JSON values, missing fields and mismatched IDs leave the
outcome uncertain and recoverable; a tracking read with a malformed answer
reschedules instead of silently ending. Controls use the real client and mock,
then corrupt the answer after the peer handled it, checking eventual state and
one actual effect. Startup restores missing jobs for outstanding confirmations
and in-progress operations without replacing existing schedules. Fault injection
establishes recovery when persistence fails before insertion; the actual queue
inserts synchronously before awaiting alarm rearming, so this is not a claim to
have reproduced a natural Workers crash between those writes.

Generated reads now inject an independent Company event and check its exact
inbox payload, cursor and model notice. Earlier pending replies are allowed;
only the injected event's notice is matched. Conversation histories compare the
remote User owner as well as local rows. Signed-out proposal attempts require
`sign_in_required` and unchanged proposals/effects. Outbox IDs are selected from
current, previously removed and never-allocated classes, restoring late-ACK/error
and pending retry/dismiss coverage. At 100,000 entries native serialization
compares the whole payload and order without millions of framework object
comparisons; traversal and immutability checks remain.

Audience and replay evidence share credential-comparison logic and reject
expired, future or overlong credentials and incorrect assertion types. Their
60-second freshness precondition matches the attack generator; it is not a
new claim about a peer's clock policy. Cryptographic validity is still checked
separately by the real verifier properties. Synthetic recordings of newly
signed credentials now use their actual request time.

The Workers helper joins due work claimed by another alarm. Per-test teardown
flushes job/alarm cancellation under the object's concurrency gate before
aborting only agents owned by that test, preserving Company evidence. Bounded
controls cover an in-flight held reader, persisted cancellation and overlapping
alarm completion. A separate one-file-worker diagnostic run passed, but added
wall time, so default file parallelism is unchanged. The protocol deadlines are
unchanged. These repair the confirmed harness defects; the precise
causes of the two historical timeouts remain unproven.

The historical matrix distinguishes capability exclusions from execution:
1,588 unsupported cells ran no steps and 19 became unsupported at runtime;
132 known failures lack causal attribution and 113 are attributed to readings.
Excluding our mocks, the PDA has 153 passes, one known failure and 146 unsupported
cells against ten independent Companies. Expected signatures do not establish
root causes or validate subsequent implementation changes. The public grid is
labelled as a snapshot; profile counts, validator severity versus client
refusal, runtime-cost claims and adapter status are reconciled across docs.

The first repair-validation run exposed a regression: rejecting a still-proposed
confirm answer before processing it suppressed the existing same-revision
terms-tampering warning. The client now observes and warns about changed terms
while preserving uncertainty. Two existing conformance controls passed after
the correction. That run also exposed a cold-import UI timeout followed by
overlapping React act/root failures; separating bootstrap removes repeated
module resets and gives each test a clean component mount. These failed runs
are retained as diagnostic evidence, not described as successful validation.

## Validation record

The latest passing project runs contain **1,560 passes and one intentional
skip**. Workers were rerun after adding the positive discovery assertion and
using one file worker; the other four projects passed in the preceding full
invocation. This is a record of passing project runs, not a claim that the last
full `npm test` invocation exited successfully.

| Project | Passed | Skipped | Observed local duration |
| --- | ---: | ---: | ---: |
| Workers (including 17 recovery histories; one file worker) | 967 | 1 | 740 s |
| Durability | 1 | 0 | 48 s |
| UI | 197 | 0 | 42 s |
| Interop unit | 237 | 0 | 8 s |
| Properties (including fixed controls) | 158 | 0 | 136 s |

Final TypeScript checking and the local production build passed. The build
retains its existing Vite chunk-size advisory; the entry chunk is about
1.51 MB (459 KB gzip). Nothing was deployed. Normal properties retained their
100-case budget. The mixed 100,000-entry outbox regression took 18 seconds;
generated counts included 289 effective retries and 287 effective dismissals,
with deliberate no-ops reported separately.

The preceding full invocation took 882 seconds and correctly exited 1: one
existing SSE example received a discovery error before its stream assertions.
All other assertions passed, and reused documentation discovery checked 1,561
declarations in 58 files. That success did not override the failed exit status.
The diagnostic now reports the discovery answer before parsing JSON.
The fresh Workers rerun passed all 23 files in 740 seconds (747 seconds for the
whole process), versus 622 seconds for Workers with two file workers in the
failed run. Single-file-worker execution costs wall time; it does not reduce
the concurrency exercised within histories or extend protocol deadlines.
That experiment is not a default configuration change. Reproduce it with
`node node_modules/vitest/vitest.mjs run --config test/vitest.config.ts --maxWorkers=1`.
Summing the latest project durations gives about sixteen minutes on this
workspace, not an observed successful full invocation or a prediction of CI
billing. CI retains its existing parallelism and fifteen-minute job budget;
no remote CI run or budget increase was used to resolve this.

The earlier follow-up's two 30-second timeouts (step-up revocation exhaustion
and operation-summary confirmation) passed in isolation and in a subsequent
full run. The later repair runs exposed different timing-sensitive cases.
Confirmed teardown/alarm defects and the UI cold-import problem were repaired,
but these observations do not establish the precise historical timeout causes
or prove the suite free of timing sensitivity. Failed runs remain in the
private failure ledger; assertions and protocol deadlines were not weakened.

The changed histories were verified at the normal case budget. The historical
deep results below do not apply to the changed generators, and neither deep
Python nor the Docker/live matrix was rerun in this local-only follow-up.

Historical baseline: the regular GitHub Test and Interop workflows passed on `0e76cd1`:
1,494 tests passed with one intentional skip across the five Vitest
configurations; TypeScript and documentation checks passed. This includes all
new audience, algorithm, identity and signature controls and the explicit
known-failure metadata. The sole skip is the deployer-specific identity scan
in `test/template.test.ts`, which needs the absent `deployment.local.json`;
the generic template scans still ran.

The baseline deep Hegel run exercised all then-current properties at
`HEGEL_CASES=5000` across partitioned runs and changed-property reruns. Its
141 tests included fixed examples; those totals are not multiplied together.
The two general state models took 4,188 seconds while Python ran concurrently.
The complete deep Python profile passed five state machines and ten oracle
controls at 2,000 examples and up to 60 steps, in 5,731 seconds. These are
historical results, not validation of the later changes above.

The baseline production bundle built, with a Vite chunk-size advisory (1.51 MB
entry chunk, 460 KB gzip). Local Docker adversarial agent, adversarial Company
and network-fault lanes reported 16, ten and eight passes respectively, with
no failures, harness errors or unsupported cells; their isolation probes passed.
Historical live discovery passed for Ilmer, Poppyseed and Alpine Retail.

The complete pinned ecosystem matrix covers 2,880 cells: eight agents,
twelve Companies and thirty honest scenarios. Final results are **1,000 pass,
273 documented known failures and 1,607 unsupported**, with zero harness
errors, unexpected failure signatures, stale expectations or flaky cells. Known
failures and unsupported capabilities are not passes.

The [first full job](https://github.com/adewale/pda/actions/runs/38829561008)
had 360 setup-error cells because the Everruns agent image failed to fetch a
dependency with an SSL peer EOF. The missing row completed in
[two isolated follow-up shards](https://github.com/adewale/pda/actions/runs/38835758531):
33 pass, eleven known failures and 316 unsupported, without errors or flaky
cells. Only the original setup-error row was replaced. The combined report
checks every cell appears exactly once, verifies consistent pins, readings
and relaxations, then recomputes attribution over the full grid. Fingerprints
confirm that classification did not change outcomes, steps or checks. The
four expectations made stale by the unbuilt agent matched again after it ran;
none were removed to make the report pass.

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
are encrypted in the Actions artifacts; decrypted reports remain in a private
workspace outside Git for triage under [SECURITY.md](../SECURITY.md). Artifact
digests were verified. No new third-party vulnerability details are published
in this report. Build errors, unsupported cells and unexecuted cells remain
distinct from passes.

For that historical matrix, the first ecosystem job used `96be076`. The
missing-row shards changed build-fetch settings and known-failure metadata;
Git tree hashes confirmed identical application, mock Company, runner and
proxy source trees across those source runs, with the same upstream pins.
Those comparisons do not validate the later local agent/confirmation changes;
no fresh ecosystem-matrix result is claimed for them. The combined report records all three source runs and
their isolation proofs rather than presenting them as one simultaneous run.

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

Run `npm run typecheck` and `npm test` for regular verification. `npm test`
runs the five projects listed in `scripts/test-projects.mjs`, then checks the
documentation's test references using JSON reports from that same invocation.
The reports live in a fresh temporary directory and are removed afterward;
there is no persistent discovery cache or cross-run freshness assumption.
Failed/skipped/parameterized tests still have names; existence is independent
of assertion success. Every project must supply complete discovery evidence;
a missing/malformed report fails explicitly without fallback. The wrapper
retains test failures even when the documentation check succeeds.

`npm run check:docs` remains independent: it performs fresh `vitest list`
discovery, without executing tests. Use it for docs-only work; running it after
`npm test` needlessly discovers everything twice. Targeted Vitest commands do
not supply evidence to the full documentation check. The checker proves only
that references exist, not that those tests satisfy their claims. Changes to
Vitest's JSON schema require updating the reader and its contract controls.

Deep validation is opt-in:

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
summary and failure ledger are retained outside Git in
`/workspace/pda-follow-up-audit`. The export/class inventory has been removed;
it was not evidence of behavioral coverage.
