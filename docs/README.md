# Documentation

Use the source below for the question it owns. Link to that source when another document needs its status. Historical reports keep their recorded dates, revisions and results in [history](history/README.md); raw receipts and screenshots stay in `evidence/` and `interop-results/`.

## Guides

| Question | Source |
| --- | --- |
| What is PDA? | [Project overview](../README.md) |
| How do I use my agent? | [Using your agent](using.md) |
| How do I configure and deploy a copy? | [Setup](setup.md) |
| What is deployed, and which live checks remain? | [Deployment tasks](deployment-tasks.md) |
| How do I upgrade PDA or refresh its Poppy support? | [Upgrade procedure](upgrading.md) |
| How do I run or join the interop grid? | [Harness instructions](../interop/README.md) |
| What should another project's maintainer expect? | [Testing with us](testing-with-us.md) |
| How do I contribute and run checks? | [Contributor guide](../CLAUDE.md) |

## Reference and current evidence

| Question | Source |
| --- | --- |
| What is built, and why? | [Design and requirements](../pda-spec.md); [decisions](decisions.md) preserve rationale and superseded choices |
| Which capabilities and model tools exist? | [Capabilities](capabilities.md) |
| What authorizes an operation? | [Operation authorization](operation-authorization.md) |
| How do we test against Companies? | [Company testing](company-testing.md) |
| What makes a finding an error, warning or local refusal? | [Conformance levels](conformance-levels.md) |
| What does the discovery validator check? | [Validator](validator.md) |
| What must a grid adapter provide? | [Harness contract](interop-spec.md) |
| Which adversarial scenarios exist, and what remains? | [Adversarial interop](adversarial-interop.md) |
| Which protocol text and changes are implemented? | [0.3 requirement ledger](poppy-0.3-upgrade.md); [active pin](../spec/upstream.json) |
| What has actually been verified, with what limits? | [Current verification](poppy-0.3-conformance.md#current-verification) |
| What did the independent Company kit establish? | [Company kit review](company-kit-review.md) |
| Which upstream ambiguities remain, and how do we read them? | [28 October 0.3 issue list](poppy-0.3-issues.md); [our readings](readings.md) |
| Which peers implement the protocol? | [Current ecosystem observations](ecosystem.md#current-ecosystem) |
| What product work remains? | [TODO](../TODO.md) |

## Historical records and drafts

- [History index](history/README.md): earlier draft reviews, upgrade plans, audits, ecosystem surveys and testing reports. The 25–26 October 0.3 review describes different wire rules from the 28 October rewrite.
- [Grid reports](interop-results/README.md): dated runs, with their original outcomes and limitations.
- [Proposals](proposals/README.md): parked external drafts and the conditions for reviewing them before submission.
- [Changelog](../CHANGELOG.md): completed changes, migrations and rollback notes.
- [Security and disclosure policy](../SECURITY.md): reporting findings and handling external disclosure.

Keep the requirement ledger, verification results, deployed state and product backlog separate: they answer different questions. A completed implementation entry is not a claim of full verification or deployment.
