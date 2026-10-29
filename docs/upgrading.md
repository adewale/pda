# Upgrading PDA and Poppy

PDA release numbers, Poppy wire versions, the interop control protocol, validator output versions, and extension versions are separate. Read [CHANGELOG.md](../CHANGELOG.md) before upgrading. Its reverse-chronological entries use Pi's release-note structure: Breaking Changes, Added, Changed and Fixed, plus migration, validation and rollback instructions. Unreleased means not deployed or certified.

## Current protocol inputs

[spec/upstream.json](../spec/upstream.json) pins Poppy 0.3, Operations 2 and Mediated Sign-In 1 to the text upstream published on its site on 28 October 2026, a hash-verified snapshot in [spec/draft-0.3-retrieved-2026-10-28](../spec/draft-0.3-retrieved-2026-10-28/README.md). Upstream hasn't committed that text, so the pin names no commit (`commit: null`), and `npm run spec:drift` compares it with the live site instead. [The official changelog](../spec/draft-0.3-retrieved-2026-10-28/pages/changelog.md) is the starting point for each upgrade, alongside the actual specification diff; [poppy-0.3-upgrade.md](poppy-0.3-upgrade.md) is the requirement ledger for this one. An extension can change between draft revisions without changing its version.

0.1 and 0.2 were dropped on 28 October ([decision 37](decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles)); their snapshots stay in `spec/` as records.

## Upgrade procedure

1. Run `npm run check:spec`. Then `npm run spec:drift` compares upstream without modifying anything. Review the official changelog and specification, guides, Operations and schema diffs. Never fetch rules dynamically at runtime.
2. Use `npm run spec:import -- --help` to import from a full upstream commit without changing the active pin. Record an immutable snapshot in a new version-and-date directory, with source commit, licence and file hashes. Preserve previous snapshots. Update the pin only in the same change as its reviewed requirement delta.
3. Update the JSON requirement ledger (`spec/requirements-0.3.json` for 0.3), then run `npm run spec:docs` to regenerate [the requirement delta](poppy-0.3-upgrade.md). Each changed rule names its version, basis, implementation, evidence and remaining limitations. Revisit the readings in [readings.md](readings.md): an ambiguity the new text settles is no longer a reading.
4. Reuse unchanged client machinery and checks. Add a new explicit profile for an incompatible draft. Never let an unknown 0.x version fall back to an older profile. Check versionless client metadata with an explicit protocol context.
5. Keep old peer pins and add new ones as separate registry entries. Run the grid with every peer that speaks the version, and any independent checks that do. Preserve unsupported outcomes, trace evidence and version-specific failure attribution.
6. Add an Unreleased changelog entry: operator-visible effects, breaking changes, migration and rollback steps, exact protocol revision, upstream changelog link, and validation actually completed. Don't invent historical release numbers.
7. Deploy only after checks pass. Verify signed-out discovery and reads first, then a test-account sign-in and an approved sandbox operation. Record deployed commit and evidence. Never count offline or sandbox success as a live production check.

## Compatibility and rollback

Keep stable User IDs and sealed refresh tokens keyed by the exact issuer. Add schema columns rather than changing encryption contexts or deleting account records. Treat discovery caches as disposable. In-flight sign-ins and approvals must retain their domain and profile context; a changed protocol or issuer needs reconciliation before an action resumes. An issuer change never transfers credentials or consent.

Keep the previous deploy available. Rollback can read additive state, but an old binary does not support a new wire version, and a binary from before 28 October can't speak 0.3: the 0.3 migration dropped Operations 1's tables, and its Sessions and tokens are 0.3's. Never resend an approved request whose outcome is unknown (Operations 2, 7); ask the Company, or the User, first. Retain revocation work and show pending revocations to the User.
