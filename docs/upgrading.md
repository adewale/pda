# Upgrading PDA and Poppy

PDA release numbers, Poppy wire versions, the interop control protocol, validator output versions, and extension versions are separate. Read [CHANGELOG.md](../CHANGELOG.md) before upgrading. Its reverse-chronological entries use Pi's release-note structure: Breaking Changes, Added, Changed and Fixed, plus migration, validation and rollback instructions. Unreleased means not deployed or certified.

## Current protocol inputs

[spec/upstream.json](../spec/upstream.json) pins Poppy 0.2 and Operations v1 to an upstream commit and a hash-verified local copy. [The official changelog](../spec/draft-0.2-2026-10-19/pages/changelog.md) is the starting point for each upgrade, alongside the actual specification diff. Operations v1 can change between draft revisions without changing its extension version.

Draft 0.3 is on the site (25 October 2026) but not in upstream's repository yet, so there is no commit to import and `spec:drift` doesn't see it. [spec/draft-0.3-retrieved-2026-10-25T0613Z](../spec/draft-0.3-retrieved-2026-10-25T0613Z/README.md), the newer of two that day, is a site snapshot for reading, not a pin; [poppy-0.3-upgrade.md](poppy-0.3-upgrade.md) is the plan. 0.2 was published and frozen on 24 October with the text of the pinned revision.

## Upgrade procedure

1. Run `npm run check:spec`. Then `npm run spec:drift` compares upstream without modifying anything. Review the official changelog and specification, guides, Operations and schema diffs. Never fetch rules dynamically at runtime.
2. Use `npm run spec:import -- --help` to import from a full upstream commit without changing the active pin. Record an immutable snapshot in a new version-and-date directory, with source commit, licence and file hashes. Preserve previous snapshots. Update the pin only in the same change as its reviewed requirement delta.
3. Update the JSON requirement ledger, then run `npm run spec:docs` to regenerate [the requirement delta](poppy-0.2-upgrade.md). Each changed rule names its version, basis, implementation, evidence and remaining limitations. Revisit the old spec-issue readings; a resolved 0.1 ambiguity is no longer a reading in 0.2.
4. Reuse unchanged client machinery and checks. Add a new explicit profile for an incompatible draft. Never let an unknown 0.x version fall back to an older profile. Check versionless client metadata with an explicit protocol context.
5. Keep old peer pins and add new ones as separate registry entries. Run both protocol lanes, independent peers and official validator checks. Preserve unsupported outcomes, trace evidence and version-specific failure attribution.
6. Add an Unreleased changelog entry: operator-visible effects, breaking changes, migration and rollback steps, exact protocol revision, upstream changelog link, and validation actually completed. Don't invent historical release numbers.
7. Deploy only after checks pass. Verify signed-out discovery and reads first, then a test-account sign-in and an approved sandbox operation. Record deployed commit and evidence. Never count offline or sandbox success as a live production check.

## Compatibility and rollback

Keep stable User IDs and sealed Account Tokens keyed by the exact issuer. Add schema columns rather than changing encryption contexts or deleting account records. Treat discovery caches as disposable. In-flight sign-ins and approvals must retain their domain and profile context; a changed protocol or issuer needs reconciliation before an action resumes. An issuer change never transfers credentials or consent.

Keep the previous deploy available. Rollback can read additive state, but an old binary does not support a new wire version: disable 0.2 interactions before returning to a 0.1-only binary. Do not replay a confirmation whose result is uncertain. Reconcile it through the Company's operation status first. Retain revocation work and show pending revocations to the User.
