# Upgrading PDA and Poppy

PDA release numbers, Poppy wire versions, the interop control protocol, validator output versions, and extension versions are separate. Read [CHANGELOG.md](../CHANGELOG.md) before upgrading. Its reverse-chronological entries use Pi's release-note structure: Breaking Changes, Added, Changed and Fixed, plus migration, validation and rollback instructions. Unreleased means not deployed or certified.

PDA speaks 0.3 and is adding 0.4 beside it ([decision 43](decisions.md#43-03-beside-04-both-versions-website-operations-and-approvals-across-sessions)). A published version is frozen; a draft gets newer snapshots until it is published. A refresh starts when the owner requests it; there is no scheduled discovery refresh, automatic import or automatic pull request. Review the concrete change before promotion. A future support policy needs an explicit decision.

## Current protocol inputs

[spec/upstream.json](../spec/upstream.json) has one pin per protocol version, each with a site snapshot, the official kit retrieved with it, and the Operations and Mediated Sign-In versions it uses:

- **0.3**, published and frozen: the [3 November 2026 snapshot](../spec/draft-0.3-retrieved-2026-11-03/README.md) and [kit](../spec/company-kit-2026-11-03/README.md), upstream commit `7205250`. Spoken at runtime. Its [requirement ledger](poppy-0.3-upgrade.md) records implementation and limits.
- **0.4**, a draft: the [9 November 2026 snapshot](../spec/draft-0.4-retrieved-2026-11-09/README.md) and [kit](../spec/company-kit-2026-11-09/README.md), upstream commit `b2569c5`. Not yet spoken; the [0.4 upgrade](poppy-0.4-upgrade.md) has the work and its ledger.

`npm run check:spec` verifies every pin offline, and that the runtime pins are exactly the versions in `src/poppy/protocol-version.ts`. `npm run spec:drift` compares the pins with the live site: for a frozen version, only its own pages and its changelog entry titles; for a draft, every page. An extension can change between draft revisions without changing its version.

0.1 and 0.2 were dropped on 28 October ([decision 37](decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles)); their snapshots stay in `spec/` as records.

## Upgrade procedure

1. Run `npm run check:spec`. Then `npm run spec:drift` compares upstream without modifying anything. Drift in a frozen version means upstream changed a published text: review it as a new finding rather than re-pinning. Review the official changelog and specification, guides, Operations and schema diffs. Never fetch rules dynamically at runtime.
2. For the current site-snapshot format, run `node scripts/spec-snapshot.mjs --save` to save a new dated copy without activating it. Preserve previous snapshots. Review the text and hashes. Download the kit from the protocol site into its own dated `spec/company-kit-*` directory with its manifest, and check it with `node scripts/check-company-kit.mjs --protocol <version> --verify-pin`. Then update the version's pin together with its requirement delta, and the runtime constants only when that version's pin is `runtime`. `npm run spec:import -- --help` can separately archive files from a full upstream commit; its Git-archive manifest is not an active site-snapshot manifest and cannot be selected by the current checker. Supporting that format needs a separately reviewed checker change before activation.
3. Update the version's JSON requirement ledger (`spec/requirements-<version>.json`), then run `npm run spec:docs` to regenerate its table in `docs/poppy-<version>-upgrade.md`. Each changed rule names its version, basis, implementation, evidence and remaining limitations. Revisit the readings in [readings.md](readings.md): an ambiguity the new text settles is no longer a reading.
4. Run the version's kit against the mock: `node scripts/check-company-kit.mjs --protocol <version> --output <file>`, and compare its results with the reviewed findings. Reuse unchanged client machinery and checks. Each version-dependent rule asks which version its Session uses. Never let an unknown 0.x version fall back to an older profile, and never speak a version the Company doesn't list. Check versionless client metadata with an explicit protocol context.
5. Keep old peer pins and add new ones as separate registry entries. Run the grid with every peer that speaks the version, and any independent checks that do. Preserve unsupported outcomes, trace evidence and version-specific failure attribution.
6. Add an Unreleased changelog entry: operator-visible effects, breaking changes, migration and rollback steps, exact protocol revision, upstream changelog link, and validation actually completed. Don't invent historical release numbers.
7. Deploy only after checks pass. Verify signed-out discovery and reads first, then a test-account sign-in and an approved sandbox operation. Record deployed commit and evidence. Never count offline or sandbox success as a live production check.

## Pre-1.0 approval reset

There is no compatibility path for the old two-card API flow. Stored approvals now require version 3 with explicit authority bindings and withdrawal generations. Earlier pending forms are refused, not migrated or executed; the User must start those tasks again. Preserve historical receipts and unknown-outcome holds: refusal to execute an old record is not proof that its earlier attempt did nothing. File-disclosure consent for unselected photos and website-form confirmation remain separate current flows. Task-selected photos no longer need a second disclosure click (decision 39). Earlier input admissions acquire no new task grant during this upgrade: restate unfinished work in a fresh User message. Existing receipts and supported exact-terms decisions retain their original bindings.

## State and rollback

Composer access is now explicit. The additive `turn_sources.task_access` migration withdraws legacy inferred task grants; it does not invent Company or file permissions for old inputs. Restate unfinished tasks with the Company selection in a fresh message. Stored receipts, unknown-outcome holds and explicit pending disclosure decisions remain intact. Old browser tabs must reload to use the new composer.

Keep stable User IDs and sealed refresh tokens keyed by the exact issuer. Add schema columns rather than changing encryption contexts or deleting account records. Treat discovery caches as disposable. In-flight sign-ins and approvals must retain their domain and profile context; a changed protocol or issuer needs reconciliation before an action resumes. An issuer change never transfers credentials or consent.

Keep the previous deploy available, but do not roll an active task ledger back to a binary that ignores its durable call mappings or immutable decisions: replay could dispatch again. Reconcile in-flight work before rollback. In particular, the task-photo change adds frozen file routes and links equivalent pending disclosures; do not roll those active ledgers back to the pre-change upload code, which ignores that routing and can create another disclosure attempt. Prefer a forward fix; do not reset the ledger to make rollback convenient. An old binary does not support a new wire version, and a binary from before 28 October can't speak 0.3: the 0.3 migration dropped Operations 1's tables, and its Sessions and tokens are 0.3's. Never resend an approved request whose outcome is unknown (Operations 2, 7); ask the Company, or the User, first. Retain revocation work and show pending revocations to the User.
