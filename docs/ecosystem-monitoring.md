# Checking the Poppy ecosystem

The ecosystem has three kinds of evidence: source changes, public discovery documents and exercised behavior. Each keeps its own observation date and revision. The [map](ecosystem.md) links the [latest survey](ecosystem-status.md); old grid scores and live journeys retain their original dates.

## Weekly public survey

The **Ecosystem survey** workflow runs Mondays at 07:00 UTC and supports **Run workflow**. It reads the reviewed [watchlist](ecosystem-watchlist.json): repository heads, incremental GitHub comparisons, package versions, directories, bounded repository searches, specification discussions, and each Company's public discovery and issuer metadata. Company hosts are checked sequentially. No Session, sign-in, conversation, API call or purchase is started.

With Node 24, run the same survey locally:

```sh
npm ci --legacy-peer-deps
npm run ecosystem:survey
node scripts/ecosystem-map.mjs
npm run spec:drift
```

The default transport resolves and pins public addresses for every HTTPS request. In a managed environment whose internet access must use its HTTP proxy, use `npm run ecosystem:survey -- --transport proxy`; the proxy remains enabled, TLS stays verified, and public DNS addresses are checked before each request. The proxy connection itself is not DNS-pinned. The receipt names the transport. The validator CLI's existing DNS-pinned fetcher is unchanged.

The survey writes `docs/ecosystem-status.json` and `.md`. `--out <prefix>` writes elsewhere; `--since YYYY-MM-DD` sets the bounded search window. Failed observations retain the last successful source revision with its old observation date, rather than presenting it as freshly read. GitHub's 300-file comparison cap is marked incomplete. A 0.3 document that PDA cannot evaluate is reported as **unsupported**, not as an invalid 0.3 implementation. Unexpected transport failures remain indeterminate.

The workflow archives the receipt under `docs/evidence/ecosystem-<date>/`, updates only the map's generated observation block and opens or updates a dated PR. It never moves an adapter pin or rewrites the interpreted survey. Search results and directory links are leads for review; forks, mirrors and similarly named projects are not automatically counted as independent implementations.

Publication needs GitHub Actions to be allowed to create pull requests in this repository. Its job requests repository contents, pull-request and workflow-dispatch permissions. `GITHUB_TOKEN`-created PRs do not trigger `pull_request` CI automatically, so the publisher explicitly dispatches the read-only CI workflow on its branch. A fork may choose to run the survey locally instead. Schedules become active only after these workflows reach the default branch.

## Targeted checks after a reviewed pin change

The **Ecosystem cross-project grid** workflow selects changed registry entries and executable adapter files in a PR. Markdown-only adapter edits do not rebuild peers. Each selected Company runs against PDA; each selected Personal Agent runs against the matching-profile mock. PRs run discovery and signed-out Session smoke checks (`D,S0`); monthly and manual runs use all thirty honest scenarios. None selects a live deployment, adversarial peer, sloppy fake or one-sided validator runner.

An upstream source change first needs human review: confirm the wire profile, read its diff, then change the registry's exact commit and build argument or Dockerfile pin together. Keep older protocol peers separate. Rebuild and start with discovery and signed-out Session checks:

```sh
npm run interop -- --agents pda --companies <reviewed-company> --scenarios D,S0
npm run interop -- --agents <reviewed-agent> --companies lenient-company-v02 --scenarios D,S0
```

Use `lenient-company,strict-company` for a retained 0.1 agent. After smoke passes, run the peer's full honest scenarios. The adapter manifest must name the reviewed commit; unsupported scenarios, retained known failures and flaky passes stay separate.

`npm run ecosystem:grid-plan` prints the monthly job matrix without running code. `-- --peers <name,...>` limits it; `-- --base <full-base-SHA>` selects only changed peers. The workflow's manual `peers` input uses the same names. Moving a default upstream branch never silently changes the tested revision.

## Monthly cross-project grid

On the first day of each month at 08:00 UTC, the workflow runs PDA against every registered local honest Company and registered honest Personal Agents against our matching-profile mocks. At the initial watchlist this is 21 bounded jobs, at most two concurrent. Each job builds only the images it needs and uses a fresh internal network whose egress probe must fail. Large compiler jobs have additional swap. The ordinary CI interop job continues to cover our own implementations.

This coverage is broader than CI, but it is **not the complete foreign-to-foreign M×N matrix**. That larger run remains a local operation documented in [the harness README](../interop/README.md), with substantial disk and compiler-memory requirements. Neither grid exercises a live customer account.

Completed jobs publish aggregate receipts: checked implementation commits, passes, failures, unsupported scenarios and flaky passes. The narrow [published-findings list](../interop/published-findings.json) permits aggregate publication of the seven already public SDK compatibility failures at the exact reviewed 0.26.0 pins. This is a publication gate, not a conformance exemption: those failures still make the grid job exit nonzero. New error categories or different SDK commits need review before publication.

When every selected job has a publishable receipt, the report job opens a dated evidence PR, including the retained failures. Missing receipts stop publication. A manually selected subset is described by its implementation list; it does not establish that every monthly peer ran.

Raw traces, logs and new unexpected failures are not uploaded by this public workflow. An unexpected result stops automatic publication and needs reproduction in a private local workspace; follow [SECURITY.md](../SECURITY.md) if it may be a vulnerability. We do not contact other projects automatically.

## Reviewing a refresh

Read the dated source receipt before changing the map's interpreted claims. Distinguish a released package from an unreleased source heading, a new protocol declaration from support in PDA, and a passing document check from a working sign-in or order. Record incomplete searches and failed requests. Link a newly exercised result to its exact revisions and scenarios. Preserve the historical full-grid scorecard until an equivalent grid is rerun.
