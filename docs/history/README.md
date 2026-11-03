# Historical reports

These records describe the dates, source revisions and protocol drafts stated in each report. Their findings, counts and limitations are preserved. Repository-relative links were adjusted when the files moved here. Update the [current source](../README.md) when behavior changes rather than refreshing an old report.

## Protocol drafts and upgrades

| Record | Scope |
| --- | --- |
| [Specification issues: 0.1](spec-issues.md) | S- and N-numbered findings against the 0.1 text |
| [0.2 upgrade](poppy-0.2-upgrade.md) | 21 October decisions and evidence; 0.1/0.2 support was later removed |
| [Specification issues: earlier 0.3 draft](spec-issues-0.3.md) | T-numbered findings against the 25–26 October text, before its wire rules were rewritten |
| [Earlier 0.3 upgrade plan](poppy-0.3-upgrade-plan-2026-10-26.md) | The plan against that same 25–26 October text, separated from the current generated ledger |

The active [0.3 issue list](../poppy-0.3-issues.md), [requirement ledger](../poppy-0.3-upgrade.md), [upgrade procedure](../upgrading.md), and [verification summary](../poppy-0.3-conformance.md#current-verification) remain outside this archive.

## Ecosystem and interoperability

| Record | Scope |
| --- | --- |
| [Implementation findings](poppy-issues.md) | Source reviews and grid findings against early peer revisions |
| [Ecosystem refresh: 23 October](ecosystem-refresh-2026-10-23.md) | Dated repository, directory and discovery observations |
| [Ecosystem refresh: 28 October](ecosystem-refresh-2026-10-28.md) | Dated source observations and targeted interoperability |
| [Interop design and rationale](interop-testing.md) | How the harness developed, including retired peers and scenarios |
| [Conformance testing history](conformance-testing-history.md) | Research behind the testing approach and its original plan |
| [Live 0.2 testing](live-0.2-testing.md) | The 21 October signed-out checks and later dated observations |

The [complete implementation catalogue](https://github.com/adewale/pda/blob/289c6592c6f6e629b1d525247f3c4e2243662bc2/docs/implementations.md) is preserved at its immutable revision. Current peer observations belong in the [ecosystem map](../ecosystem.md#current-ecosystem); runnable peer pins belong in [the registry](../../interop/registry.json).

## Audits and local investigations

| Record | Scope |
| --- | --- |
| [Focused audit fixes](audit-fixes.md) | The earlier authorization and isolation candidate, with its own baseline |
| [Upgrade audit: 21 October](audit-2026-10-21.md) | Review of the 0.2 upgrade and integrated fixes |
| [Calculator property triage](calculator-property-triage.md) | The 21 October error-precedence counterexample and oracle correction |
| [Privacy review: 30 October](privacy-review.md) | Policy wording, photo-upload choices and remaining product gaps |

The detailed [PR 36/38 conformance review](https://github.com/adewale/pda/blob/289c6592c6f6e629b1d525247f3c4e2243662bc2/docs/poppy-0.3-conformance.md) is also frozen at its recorded revision. The [retired support plan](https://github.com/adewale/pda/blob/4a5d2143c2d46a88e37c90e48247b5a7162f2b5e/docs/poppy-0.3-plan.md) records the earlier scheduled-import and multiple-version proposal; decision 37 superseded it.

Evidence packages remain at their existing paths in `../evidence/` and `../interop-results/`. Identical files retained by different runs keep each package self-contained and attributable to its run.
