# Changelog

Release notes and upgrade instructions for PDA. Entries are newest first, inspired by [Pi's changelog](https://pi.dev/changelog). PDA's release number is separate from the Poppy version it speaks. **Unreleased entries describe repository changes, not a deployed release.**

## Unreleased — Poppy 0.1 and draft 0.2

Protocol baseline: **0.2, upstream revision 19 October 2026**, commit [`39b35bd`](https://github.com/personal-agent-protocol/personal-agent-protocol/tree/39b35bdf240fc07f157d6ca4e29b5a41d4b36b5d), Operations **v1**. [Local specification and official changelog](spec/draft-0.2-2026-10-19/README.md). [Upstream changelog](https://personalagentprotocol.org/docs/changelog#v0-2). Draft 0.2 is still in progress; this entry targets that exact revision.

### Breaking Changes

- Unknown pre-1.0 versions are refused before issuer metadata or credentials are used. Older PDA treated every `0.x` as compatible. Declared **0.1 remains supported** by its existing rules.
- Invalid explicit validator protocol contexts are errors, rather than silently selecting a different version. Versionless client-metadata validation retains its 0.1 default.
- A model cannot expand a task to another Company after reading Company or tool content unless the User's own task names that domain. A new task with no named domain can choose its first Company; later additions require the User to name them. This also prevents a Company from starting sign-in at another Company.
- Pending work is bound to its original Company domain and profile. Ambiguous older work, or work whose issuer or wire version changed, is held for reconciliation. It is not silently replayed with different endpoints.

### Added

- A 23 October ecosystem refresh: 17 checked source heads, 28 dated public discovery/metadata results, Archon's new entry and current 0.2 declarations. Older Session results and grid scores retain their original dates.

- Public About and ecosystem pages at `/about` and `/about/ecosystem`. About links to the GitHub project, the Validator and the ecosystem map; the map uses the repository's Markdown, keeps historical results in a disclosure and has an About breadcrumb. The map is linked only from About; `/ecosystem` has no page or redirect.
- A signed-out MCP tool-listing scenario and four live 0.2 targets. [Live evidence](docs/live-0.2-testing.md) separates completed checks from those requiring sign-in.
- The official Company validator now runs against Datalayer's two 0.2 SDK Companies as well as our mock, and in file mode in the validator cross-check, over 99 documents that declare 0.2. A flawed-Company lane (`npm run interop:flaws`) gives our mock one of ten known flaws at a time and records which checkers notice: the official validator, and our adversarial and strict agents. [`spec/official-checks-0.2.json`](spec/official-checks-0.2.json) maps each of the validator's 74 checks to ours. [The lanes](interop/vectors/official/README.md).
- The interop runner checks that every token response carries `Cache-Control: no-store` (`company.token-no-store`, RFC 6749 5.1), a failure in any cell where it doesn't.
- The live lane's conversation scenario is now `CL`: its greeting says it is a test needing no action, and it closes the conversation it opens. `C`, which leaves the conversation open, runs only in the local grid, and a new local scenario, `CC`, has the Company close a conversation the agent left open: the agent must see the close, get `conversation_closed` for a later message, and start a new conversation.

- Explicit 0.1 and 0.2 profiles over the existing validator and client, with version and revision in validation reports and interop cells.
- A hash-verified, licensed copy of the 0.2 specification, guides, Operations text, official changelog, schemas and Company validator. `npm run check:spec` verifies it offline; `npm run spec:drift` compares upstream without changing the pin.
- Separate 0.2 mock and Datalayer 0.25.0 peer entries reuse the existing adapters. Historical 0.1 peers and their pins remain available. The official Company validator runs in a separate one-sided lane.
- Focused regression coverage for exact-version refusal, discovery redirects, issuer audiences, MCP DPoP/Bearer selection, approvals and cross-company prompt injection.
- A 48-entry ledger accounts for every change in the pinned official changelog. CI verifies the snapshot and ledger; the importer refuses to overwrite snapshots.
- An updated [ecosystem map](docs/ecosystem.md) and a [repeatable upgrade procedure](docs/upgrading.md).
- Fake Personal Agents for the interop grid: `lenient-personal-agent` (the reference agent), `strict-personal-agent` (refuses any departure it finds, a SHOULD included, and reports it) and `sloppy-personal-agent` (the mistakes real agents make), our agent with a profile in the adapter's network seam ([interop-spec §2.1](docs/interop-spec.md#21-the-fake-implementations)). The lenient and strict ones run in the live lane; a live Company's `liveScenarios` limits what it is sent.
- [Testing your Poppy implementation with ours](docs/testing-with-us.md), the page to send another project's maintainer.
- Proof that an interop run tests what it says: before a live run the runner fetches the live identity as a Company would and stops if it doesn't answer or doesn't hold the runner's key, and before any cell each implementation's manifest must match its registry entry (profile, version, adversarial, and the identity it signs as) ([interop-spec §8.1](docs/interop-spec.md#81-what-the-run-is)).

### Changed

- The dependency security refresh moves Zod to 4.6.6, Happy DOM to 21.0.4, Vitest to 4.1.12 and the Workers test plugin to 1.4.9. Wrangler 4.154.0 and Miniflare 5.20261023.1-beta are shared with the Vite plugin through scoped overrides because its published dependencies still pin affected versions. The lockfile is regenerated with the project's `--legacy-peer-deps` install policy.

- The interop harness's own implementations are renamed so the sets pair up: `pda-mock` is `lenient-company`, `pda-mock-strict` is `strict-company`, `pda-mock-v02` is `lenient-company-v02` and `evil-agent` is `evil-personal-agent`. Commands, known failures and CI use the new names; dated results keep the old.
- Print with Poppy's grid pin moves to `3360d8b`, draft 0.2, with its `ALLOW_INTEROP_TEST_HOSTS` setting; its ordering scenario OU now passes.
- Under 0.2, discovery checks the final serving host, preserving `www.`; domains sharing an issuer must agree on `auth`. Issuers remain exact strings and continue to key User IDs and Account Tokens.
- Under 0.2, client and Session assertions name the issuer. The endpoint-audience fallback remains limited to 0.1. Assertions still live for one minute, within both versions' bounds.
- MCP authentication follows the server's protected-resource metadata. DPoP-capable 0.2 servers receive proof-bound tokens; other MCP servers receive Bearer tokens bound to their exact resource URL.
- Read and error validation, mock behavior, trace checks and known-failure matching use the selected protocol version. A 0.1 ambiguity cannot exempt a 0.2 failure.

### Fixed

- Overlapping decisions on a local approval claim the pending request atomically after discovery, so an approved write is dispatched once and a competing decline cannot overwrite it.
- Transcript outcomes use the Company's exact issuer and operation ID. API proposal results retain the issuer after cards expire; older results use a card's verified domain only when it identifies one issuer, otherwise they keep waiting for a known outcome.
- The overlapping-model-call budget test seeds legacy spending with its synthetic clock, so the seven-day retention rule does not delete its fixture as calendar time advances.

- The validator reports an API type other than `openapi` or `mcp` as an error in a 0.2 document too (section 6's MUST); our client still skips the API and uses the Company. The 0.2 profile had kept the information level meant for a document newer than the validator knew. `api-type-newer` is retired.
- The validator reports a blank or whitespace-only `organization.name` as missing, as it does a missing one.
- The adversarial agent (`evil-personal-agent`) signed its assertions for the token endpoint, so against a 0.2 Company, which wants the issuer, every attack failed before it was sent. It now uses the issuer from 0.2 on.
- Live interop cells use the configured wire version and stop if discovery declares another version. Legacy live entries retain their 0.1 default.

- Removed accidental acceptance of newer draft versions under 0.1 validation rules.
- Discovery caches keep exact requested host keys. Old unversioned caches are revalidated.
- MCP session caches belong to each client and its DPoP keys, await shared initialization, clear failures and refresh metadata within its bounded cache lifetime. Account or sign-in changes invalidate the active session and tool catalogue.
- Harness retries retain their protocol context, and simultaneous runs use separate result directories.
- Versioned snapshot page names no longer collide between `0.1/spec` and `0.2/spec`.
- Legacy budget retention uses its caller's clock. Production metering retains main's durable reservations, admission-day charges and idempotent settlement outbox.
- Snapshot parsing handles versioned pages and imported walkthrough constants. The requirement table is generated from the reviewed ledger.

### Upgrading

1. Review [the requirement delta and evidence](docs/poppy-0.2-upgrade.md), including limitations. Do not infer complete conformance from a version number.
2. Install the existing lockfile with `npm ci --legacy-peer-deps`. Run `npm run check:spec`, `npm test`, `npm run typecheck`, and both interop lanes before deployment.
3. Storage changes are additive. Keep the existing signing and encryption keys. Do not reset User IDs, Account Tokens or consent. Discovery caches can be refreshed; pending work retains its profile context.
4. Check discovery and a read against a test Company, then sign in with a test account and approve a sandbox operation. Record the actual deployed commit and outcome before promoting this entry to a dated release.

### Validation and rollout

The combined own-code lane passes 102 cells; PDA passes all 74 exercised cross-project cells. The official validator passes 69 available checks with five skips. The full test suite passes with 1,747 tests and one intentional skip after integrating main PR #12 and the upgrade audit. Seven peer compatibility failures remain visible in [the upgrade evidence](docs/poppy-0.2-upgrade.md#validation). This change has not been deployed. Optional feedback submission and anonymous browsing remain separate features.

### Rollback

Return to the previous deployment with its original configuration and keys. An older 0.1-only binary cannot safely operate at a 0.2 Company: stop those tasks first. Preserve pending revocations and reconcile uncertain operation outcomes before retrying. Additive task-context records can remain in storage. See [compatibility and rollback](docs/upgrading.md#compatibility-and-rollback).

## Baseline — 18 October 2026

Repository baseline [`d8515e7`](https://github.com/adewale/pda/commit/d8515e7be4282014c6ebcf21d156ac689f333050), before this upgrade. This is a historical marker, not an invented release number. PDA implements draft 0.1 with Operations v1, a discovery validator, strict mock, interop grid, adversarial and property tests. Earlier changes are in [Git history](https://github.com/adewale/pda/commits/main/).

## Maintaining this file

For each release, move reviewed entries from Unreleased into a dated version entry. Include Breaking Changes, Added, Changed and Fixed where relevant, followed by Upgrading, Validation and Rollback. Name the Poppy version, exact upstream revision and Operations revision; link the official changelog and local snapshot. Explain operator actions and retain unresolved gates. Never mark a deployment or check complete without its evidence.
