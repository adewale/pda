# Ecosystem refresh — 28 October 2026

This refresh reads 23 repository heads and 33 public Company hosts. It adds six source candidates, observes draft 0.3 upstream and in six live documents, and exercises Datalayer's last 0.2 SDK revision in Docker. The map's historical full-grid scores and live customer journeys retain their earlier dates.

The [survey JSON](evidence/ecosystem-2026-10-28/survey.json) records each observation time, source revision, request URL, diagnostics and canonical parsed-document hashes. The [generated report](evidence/ecosystem-2026-10-28/survey.md) makes the data readable. Nine existing heads moved, eight were unchanged, and six repositories were newly inspected. This is a bounded inventory, not an exhaustive census.

## Specification and package movement

The official source is now [`a95b757`](https://github.com/personal-agent-protocol/personal-agent-protocol/tree/a95b757872533a6ef1e1a9bcf29802857d2e5ff4), committed 26 October. Its [changelog](https://github.com/personal-agent-protocol/personal-agent-protocol/blob/a95b757872533a6ef1e1a9bcf29802857d2e5ff4/content/shared/changelog.mdx) describes draft **0.3 in progress**: Session Keys replace `session_id`; scopes become Company-defined; OAuth metadata and protected-resource bindings change; browser joining uses a one-time code and a Session Key proof. Other changes cover Token Exchange, conversation authors and the Company kit.

PDA continues to adopt the exact 19 October 0.2 source at `39b35bd`, with 0.1 compatibility. This refresh changes no runtime protocol profile or official-validator pin. `npm run spec:drift` detects changed and removed kit files; a removed current schema is now reported as drift instead of terminating the comparison with an unhandled 404. [Actual comparison output](evidence/ecosystem-2026-10-28/spec-drift.txt).

npm and PyPI advertise Datalayer **0.27.0**. Its [source changelog](https://github.com/datalayer/personal-agent-protocol/blob/a3713e358dd407080d446c8934250e9cdf684dad/CHANGELOG.md) still labels that heading unreleased, while describing the 0.3-only migration with no 0.2 compatibility. Poppyseed's registry advertises **0.3.1**, whose checked source says it reconciles with 26 October's draft 0.3. These registry/source observations do not establish deployed behavior.

## New source candidates

The new sources are detailed in [implementations.md](implementations.md#source-additions-and-profile-changes--28-october-2026):

- **koh/poppy**, with TYPO3 and Sylius integrations: one shared PHP 0.2 Company core and two framework integrations, published as read-only mirrors. All three report MIT licences. They are not counted as three independently exercised protocol engines.
- **PoppyKit client and server**: TypeScript SDKs for 0.2, MIT. Their READMEs require Node 24.21 or later and describe unreleased repairs with publication pending. No adapter was added and neither was run here.
- **kidkuddy/poppy-cli**: a Go command-line Personal Agent and testing skill for 0.2 Companies, MIT. Its README was inspected; the code was not executed.

The first four came from bounded GitHub searches since 23 October; the PoppyKit repositories came from Awesome Poppy. The watchlist now retains all six for later source comparisons. Search noise and forks remain leads rather than implementation counts.

## Public discovery

The 28 prior addresses were rechecked, then five named addresses from PAP Checker's directory were added and checked sequentially: `bank.notjustabank.com`, `food.papsandbox.com`, `poppy.lukemolony.com`, `stays.papsandbox.com` and `planmyvisit.to`. Different hostnames do not necessarily mean different Companies.

| Observation | Count | Interpretation |
| --- | --- | --- |
| Valid under a supported declared profile | 23 | Public discovery and issuer metadata passed; diagnostics remain visible |
| Invalid under a supported declared profile | 3 | ample.computer and the two Tilopay addresses retain domain-binding errors |
| Unsupported by PDA | 6 | Six documents advertise 0.3; no 0.3 conformance verdict is made |
| Indeterminate | 1 | Intercom's redirected discovery address returns 404 |

The 0.3 declarations are at Northlight Flowers, the food and stays sandboxes, Poppyseed, Not Just a Bank and its bank subdomain. PDA's version refusal is a compatibility boundary, not evidence that these documents violate 0.3. No fallback to 0.2 was attempted.

This managed run uses Node 24 fetch through the environment's HTTP proxy with TLS verification and public DNS checks. The proxy connection itself is not DNS-pinned; the receipt states this. The normal scheduled/local transport uses the existing DNS-pinned Node HTTPS fetcher. Only public discovery and issuer metadata were fetched: no Session, sign-in, Company API, conversation, payment or order. Raw metadata documents are not committed.

## Targeted interoperability

The four Datalayer `-v02` entries advance from SDK 0.25.0 (`97c1386`) to SDK **0.26.0** at [`0ff43c5`](https://github.com/datalayer/personal-agent-protocol/tree/0ff43c55cc303c3165cb2d5841eca026e1c7c699). That revision adds API-write idempotency while retaining 0.2. The 0.1 peers and their source links remain pinned as before. Latest 0.27.0 was not substituted because its wire profile is 0.3.

All seven needed images were rebuilt. The three agents, PDA and the TypeScript/Python SDKs, were paired with our 0.2 mock and the two SDK Companies. The isolated network passed the runner's no-egress probe before implementation startup. The own-code manifests report `c3eabd0-dirty` because monitoring and documentation edits were present during the run. Their executable build inputs (`src`, `test/mock-company`, `interop/runner` and `interop/impls`, excluding README files) are unchanged from base `c3eabd00e398f2934a462d44c38640c2cfd8cfff`; the measured manifest values are retained in the receipts.

```sh
npm run interop -- --agents pda,datalayer-ts-v02,datalayer-py-v02 \
  --companies lenient-company-v02,datalayer-ts-v02,datalayer-py-v02 \
  --scenarios D,S0 --build-jobs 1
```

**18 pass, none failed or unsupported.** The [smoke receipt](evidence/ecosystem-2026-10-28/grid-smoke-receipt.json) names the checked commits.

The same images then ran all thirty honest scenarios:

```sh
npm run interop -- --no-build --agents pda,datalayer-ts-v02,datalayer-py-v02 \
  --companies lenient-company-v02,datalayer-ts-v02,datalayer-py-v02 \
  --scenarios D,S0,N,SD,SV,SVN,SM,SMC,SX,SXV,C,CI,CS,CA,H,DC,SO,SE,R,AO,AM,AS,W,O,O2,OX,OU,RL,DP,CM
```

**211 pass, 7 fail, 52 unsupported, 0 error; no flaky cells. PDA: 74 pass, 0 fail, 16 unsupported.** [Aggregate receipt](evidence/ecosystem-2026-10-28/grid-receipt.json). The seven failures match the previously [published 0.25 compatibility findings](poppy-0.2-upgrade.md#validation): three TypeScript streaming cells and four SDK handoff/close response-shape cells. They remain unexempted and the command exits **1**. No new known-failure exemption was added.

The [publication allowlist](../interop/published-findings.json) permits only aggregate counts for those already public findings at the exact reviewed pins and error categories. It does not alter attribution, pass rates or exit status. Different failures or source commits require review before automatic publication. Raw traces stay in the gitignored local results directory.

Print with Poppy's new source head `4dcb1e8` has only four changed paths relative to retained `3360d8b`: frontend files, sandbox configuration and its guide. Its runtime pin remains unchanged, and this refresh makes no new live ordering claim.

## Repeatable monitoring

The [procedure](ecosystem-monitoring.md) and two workflows add:

- A Monday 07:00 UTC source/discovery survey, dated receipts, a review PR and before/after browser evidence for the map's generated observation block.
- Discovery/signed-out Session smoke checks for reviewed peer pin or executable adapter changes in a PR.
- A first-of-month 08:00 UTC cross-project grid, split into 21 bounded peer jobs with at most two concurrent. Complete publishable runs open a dated aggregate report PR; unexempted public failures remain failures.

The monthly selection covers PDA versus local Company adapters and registered Personal Agents versus our matching-profile mocks. It is broader than own-code CI, but not the full foreign-to-foreign matrix. Schedules activate after merge to the default branch. Publishing requires the repository to allow Actions-created PRs; this session's GitHub integration could not inspect that administrative setting (HTTP 403). The workflow explicitly dispatches CI because PRs created with `GITHUB_TOKEN` do not trigger `pull_request` workflows automatically.

## Limits

Everruns' incremental GitHub comparison reached the 300-file cap; no claim that its Poppy behavior stayed unchanged follows from that partial list. Searches requested only their recorded first page. Existing 0.25 results, the historical full ecosystem grid and live journeys retain their own dates. The metadata survey does not certify deployed Companies, and the local grid does not establish a live account or purchase flow. No result was sent to another project and no deployment was made.
