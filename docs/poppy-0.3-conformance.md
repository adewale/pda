# Poppy 0.3 conformance review

This review targets the [29 October 2026 snapshot](../spec/draft-0.3-retrieved-2026-10-29/README.md). It separates PDA's implementation and verification problems from the [43 issues in the upstream text](poppy-0.3-issues.md). A changelog disposition of **Done** records an implemented change; it does not certify every normative requirement or every deployment path.

## Current verification

PDA implements the pinned 29 October 2026 text of Poppy 0.3 alone. This is the current verification summary; dated evidence packages retain the results of their own runs.

| Area | Evidence and limit |
| --- | --- |
| Repository implementation | [CI](../.github/workflows/ci.yml) runs documentation references on every PR, runtime checks on code/config changes, and specialist checks on their inputs; main runs all CI steps. [PR 38 checks](https://github.com/adewale/pda/pull/38/checks) retain the earlier run evidence. Passing them does not certify every normative requirement. |
| Own interop and security lanes | CI selects applicable honest/network, malicious-Company and malicious-agent cells explicitly, and refuses skipped required cells. [Lane definitions](../.github/workflows/interop.yml). |
| Official Company kit | The [pinned website kit and manual checklist review](company-kit-review.md) exercise our mock profiles and hosted dummy Company's handlers independently over local HTTPS. The original raw DPoP prerequisite findings remain explicit. A separately patched copy finishes those probes with valid DPoP and 18 independent proof controls; absent-feature skips remain skips. This verifies Company-side fixtures, not the full Personal Agent. |
| Independent Company | The current follow-up passes D, SD and OU against the pinned print-with-poppy demo, with no unsupported cells. [Current receipts](evidence/task-approvals/audit/README.md). The earlier ten-scenario run remains [dated PR 36 evidence](evidence/pr-36-interop-completion/README.md). All demo accounts, orders and payments are synthetic. |
| Browser interaction | The [current browser run](evidence/task-approvals/audit/README.md) exercises one terms decision, reload/reconciliation, scoped exports and exact source/anchor equality through the production build and authenticated WebSocket. Identity, model and Company are synthetic; checkout is not opened. |
| Process-crash recovery | [Sixteen actual SIGKILL cases](evidence/task-approvals/audit/process-crashes.json) retain independent Company processes/ledgers and reuse PDA SQLite: eight approval boundaries, six initial-task boundaries, and real Pi MCP settlement with an unsafe negative control. No business request or effect repeats; interrupted terms publication is repaired without execution. |
| Live services | The owner's 29 October diagnostics record authenticated 0.3 calls at Cliffside Retail and Print with Poppy, with approval and checkout defects described below. Discovery-only, synthetic-demo and authenticated-production evidence remain separate. Deployment state is recorded in deployment-tasks. |

Deployment state and remaining live checks are maintained only in [deployment-tasks](deployment-tasks.md#2-live-checks). This table reports recorded protocol evidence, not a claim that the current source is deployed.

The detailed PR 36/38 review is [frozen at its recorded revision](https://github.com/adewale/pda/blob/289c6592c6f6e629b1d525247f3c4e2243662bc2/docs/poppy-0.3-conformance.md). Its original counts and limitations describe those runs.
