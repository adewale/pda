# Changelog

Release notes and upgrade instructions for PDA. Entries are newest first, inspired by [Pi's changelog](https://pi.dev/changelog). PDA's release number is separate from the Poppy version it speaks. **Unreleased entries describe repository changes, not a deployed release.**

## Unreleased — Poppy 0.3 alone

Protocol baseline: **0.3, the text upstream published on its site on 28 October 2026**, which has no upstream commit yet ([snapshot](spec/draft-0.3-retrieved-2026-10-28/README.md); `spec/upstream.json` pins its hashes). Operations **v2**, Mediated Sign-In **v1**. 0.1 and 0.2 are no longer spoken ([decision 37](docs/decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles)).

### Breaking

- A Company whose `poppy.json` declares 0.1 or 0.2 is refused before its issuer is used, and can't be used until it moves to 0.3; an agent's accounts there go unused, and aren't revoked. Print with Poppy moved on 28 October (`b340741`, and printwithpoppy.com declares 0.3).
- The client metadata document is `/poppy/client.json` again, listing Operations 2; `/poppy/0.3/client.json` is gone. A Company that allowlisted it sees a new `client_id`, and the User signs in again.
- Operations 1 is gone: proposals, confirm and cancel, tracking, standing permissions, the `poppy_operation` tool and its card. A migration drops `poppy_operations`, `poppy_proposals` and `poppy_permissions`. A Company's terms are an approval card, after our own card for the write.
- Sign-in asks for the Company's own scopes; `poppy:read` and `poppy:write` are gone.

### Added

- `poppy_feedback`: tells a Company about a task the User couldn't do there, once per task, never one it lists as excluded, and passes on another way to do it when the Company answers with one (9.3). `poppy_discover` now lists the tasks a Company leaves out of the protocol (9.1) and describes its scopes from its OpenAPI descriptions and `scope_hints`.
- Approval cards check the Company's terms against the request and the summary, and say what differs (Ops 5).
- A requirement ledger for 0.3: `spec/requirements-0.3.json` gives each of the changelog's 42 entries a disposition, and `npm run check:spec` holds it to the changelog.
- A mock check that no Session header reaches an OAuth endpoint (`session-jwt.oauth-endpoint`, 5.2).
- Four issues found while implementing, in [poppy-0.3-issues.md](docs/poppy-0.3-issues.md#found-while-implementing).
- The Python Hypothesis client and its five state machines speak 0.3: the Session header, refresh tokens, Operations 2, the browser join and MCP with its own token ([its README](test/hypothesis/README.md)).
- The interop grid's first run at 0.3 (29 October): our four agent profiles against `lenient-company`, `strict-company` and `evil-company`, every failure the sloppy agent's by design ([results](docs/interop-results/README.md)).
- print-with-poppy's adapter, back at `b340741`, the first other project on the 28 October text, and `print-with-poppy-live` for discovery at printwithpoppy.com. Its first run at 0.3: our three honest agents pass all ten scenarios it claims, the photo upload and its order (OU) among them, and the sloppy agent fails only its known `aud` ([results](docs/interop-results/README.md#print-with-poppy-at-03)). Its build stage starts from the full `node:22-bookworm` image, so the build installs no Debian packages.
- The first live 0.3 run: discovery (D) at printwithpoppy.com passes from our agent's container, and the validator finds it valid ([results](docs/interop-results/README.md#live-printwithpoppycom-29-october)).
- A trace check, `one_session`, that every resource request in a cell carries the Session header with one `sid`, and none reaches an OAuth endpoint (5.2).
- The interop agent reads pages in Node with `html-rewriter-wasm` (lol-html, as Workers' `HTMLRewriter`), so browsing scenarios see the page the Company served.
- An ecosystem refresh for 29 October: who implements the 28 October text, and dated public discovery results ([ecosystem.md](docs/ecosystem.md), [evidence](docs/evidence/ecosystem-2026-10-29/README.md)).

### Fixed

- Remaining 0.3 conformance gaps: Company-wide holds and User reconciliation for uncertain actions, MCP cache invalidation after withdrawal or scope changes, safe metadata recovery after `invalid_token`, and conservative missing scope hints. Verification now includes endpoint redirect controls, model-boundary guards and direct User alternatives, API/MCP lifecycle cases, restored 0.3 security lanes in CI and actual Chromium approval/recovery journeys. The [conformance review](docs/poppy-0.3-conformance.md) lists the fixes and keeps live and language-model limits explicit.
- The PR 36 audit's nine findings: withdrawn conversation and browser approvals, account changes during browser join, interrupted legacy sign-ins, invisible Operations 1 cards, Company-dependent metadata and task caches, service metadata paths ending in `/`, Session JWT leak checks and tool steps left waiting after the Company's terms were decided. Sign-out now persists a local authority counter, so signing back into the same account cannot revive an old approval or browser context. [Fixes and regression evidence](docs/evidence/pr-36-audit/README.md).
- The protocol log called token-endpoint requests "Session header"; they carry our client assertion.
- Signing out withdraws its Sessions' pending approvals at once, not at the next token refresh.
- `extension_required` names the extension the Company asks for.
- The mock Company left out a scope a sign-in type can't grant instead of refusing it, when the issuer lists it (4.7, RFC 6749 3.3), and names the granted scope whenever it differs from the request, even where it usually omits it (RFC 6749 5.1). The Hypothesis port found both.
- The live lane's notice without an identity named 0.1's scenarios and error: at 0.3 a Company refuses S0, CL and ML's Session header with `invalid_session`, and only a sign-in with `invalid_client`.
- CI's interop job ran no cell at all after the move to 0.3: the mock's adapter still declared 0.1, so every cell was refused at version negotiation and the run passed. The adapter declares the version we speak, and a run in which no cell passes or fails now fails.
- One agent's OpenAPI descriptions and task coverage were cached per process, so a second agent in the same process (the interop image, the Durable Object's isolate) could use the first one's. Each cache is now per client.
- The interop checks require `conversation_id` on every conversation read (8.5).
- Scenarios S0, CM, N and XN exercised nothing at 0.3, since a signed-out request no longer starts a Session at the token endpoint; each now makes the request its requirement is about. Every scenario's requirements cite 0.3's sections.

### Removed

- Every interop peer, vector and lane that spoke 0.1 or 0.2, with `lenient-company-v02`, the official validator's lanes (`npm run interop:official`, `npm run interop:flaws`) and the adversarial agent, which waits for a 0.3 port. [interop-spec §14](docs/interop-spec.md#14-retired-with-01-and-02) lists each with its last pin.
- 0.1 and 0.2 error codes from the client's list: `account_mismatch`, `operation_not_found`, `sign_in_required`, `terms_changed` and `user_approval_required`. `rate_limited` stays as our own agent code.
- NREP, the replayed token request, from the mock's manifest: it replayed 0.2's Session request, and waits for a 0.3 rewrite.

## Earlier — Poppy 0.1 and draft 0.2

Protocol baseline: **0.2, upstream revision 19 October 2026**, commit [`39b35bd`](https://github.com/personal-agent-protocol/personal-agent-protocol/tree/39b35bdf240fc07f157d6ca4e29b5a41d4b36b5d), Operations **v1**. [Local specification and official changelog](spec/draft-0.2-2026-10-19/README.md). [Upstream changelog](https://personalagentprotocol.org/docs/changelog#v0-2). Draft 0.2 is still in progress; this entry targets that exact revision.

### Breaking Changes

- Unknown pre-1.0 versions are refused before issuer metadata or credentials are used. Older PDA treated every `0.x` as compatible. Declared **0.1 remains supported** by its existing rules.
- Invalid explicit validator protocol contexts are errors, rather than silently selecting a different version. Versionless client-metadata validation retains its 0.1 default.
- A model cannot expand a task to another Company after reading Company or tool content unless the User's own task names that domain. A new task with no named domain can choose its first Company; later additions require the User to name them. This also prevents a Company from starting sign-in at another Company.
- Pending work is bound to its original Company domain and profile. Ambiguous older work, or work whose issuer or wire version changed, is held for reconciliation. It is not silently replayed with different endpoints.

### Added

- **Draft 0.3, as upstream rewrote it on 28 October**, beside 0.2 and 0.1, on branch `poppy-0.3` ([snapshot](spec/draft-0.3-retrieved-2026-10-28/README.md), [plan and status](docs/poppy-0.3-plan.md#then-03-as-rewritten-on-28-october)). A Company whose `poppy.json` says `"0.3"` is discovered through its domain's protected resource metadata, and every request to it carries a `Poppy-Session` JWT signed with a delegated key, one per User ID. Accounts use plain OAuth refresh and access tokens, with DPoP only when the issuer asks for it. The browser joins a Session by authorizing the page's code in our own request. Operations 2 puts the Company's terms on an approval card and sends the same request again with `Poppy-Approval`, MCP `_meta` or a message's `approval`. Mediated Sign-In is a token-endpoint grant, and messages carry `author`. The validator has a `Draft 0.3` profile with 12 new messages; the mock Company speaks 0.3 and checks 51 of its rules. A 0.3 Company sees its own client_id, `/poppy/0.3/client.json`, which lists Operations 2 ([decision 36](docs/decisions.md#36-draft-03-beside-02-a-client_id-per-version-our-card-before-the-companys-terms-and-sessions-that-outlive-sign-out)). Not yet in the interop grid; 0.3 isn't published, so this follows an in-progress text.
- Three snapshots of Personal Agent Protocol draft 0.3 as the site served it, at [01:47](spec/draft-0.3-retrieved-2026-10-25/README.md) and [06:13 UTC](spec/draft-0.3-retrieved-2026-10-25T0613Z/README.md) on 25 October and [18:34 UTC](spec/draft-0.3-retrieved-2026-10-26/README.md) on 26 October, since it kept changing, what it changes here ([docs/poppy-0.3-upgrade.md](docs/poppy-0.3-upgrade.md)), a plan to keep up with weekly versions, starting with 0.3 and dropping 0.1 ([docs/poppy-0.3-plan.md](docs/poppy-0.3-plan.md)), every open problem in one list ([docs/poppy-0.3-issues.md](docs/poppy-0.3-issues.md)) and a review of its text ([docs/spec-issues-0.3.md](docs/spec-issues-0.3.md)). At the time, nothing of 0.3 was implemented; the protocol baseline stays 0.2. 0.2 was published and frozen on 24 October with the same text as the pinned revision.
- A 28 October ecosystem refresh: 23 checked repository heads, six new source candidates and 33 dated public discovery results. Six unsupported 0.3 declarations are distinguished from invalid supported-profile documents; historical grid and live-journey dates are preserved.

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

- The separate Datalayer 0.2 peers advance to SDK 0.26.0 at `0ff43c5`. A rebuilt smoke passes 18 cells; the full 3×3 run records 211 pass, 7 unexempted compatibility failures and 52 unsupported, with PDA passing all 74 exercised cells. The 0.1 peers and official-validator pin are unchanged.

- The dependency security refresh moves Zod to 4.6.6, Happy DOM to 21.0.4, Vitest to 4.1.12 and the Workers test plugin to 1.4.9. Wrangler 4.154.0 and Miniflare 5.20261023.1-beta are shared with the Vite plugin through scoped overrides because its published dependencies still pin affected versions. The lockfile is regenerated with the project's `--legacy-peer-deps` install policy.

- The interop harness's own implementations are renamed so the sets pair up: `pda-mock` is `lenient-company`, `pda-mock-strict` is `strict-company`, `pda-mock-v02` is `lenient-company-v02` and `evil-agent` is `evil-personal-agent`. Commands, known failures and CI use the new names; dated results keep the old.
- Print with Poppy's grid pin moves to `3360d8b`, draft 0.2, with its `ALLOW_INTEROP_TEST_HOSTS` setting; its ordering scenario OU now passes.
- Under 0.2, discovery checks the final serving host, preserving `www.`; domains sharing an issuer must agree on `auth`. Issuers remain exact strings and continue to key User IDs and Account Tokens.
- Under 0.2, client and Session assertions name the issuer. The endpoint-audience fallback remains limited to 0.1. Assertions still live for one minute, within both versions' bounds.
- MCP authentication follows the server's protected-resource metadata. DPoP-capable 0.2 servers receive proof-bound tokens; other MCP servers receive Bearer tokens bound to their exact resource URL.
- Read and error validation, mock behavior, trace checks and known-failure matching use the selected protocol version. A 0.1 ambiguity cannot exempt a 0.2 failure.

### Fixed

- The upstream drift check reports a removed current schema as drift and continues comparing the remaining files, while preserving other HTTP failures as unavailable checks.

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
