# Updating Poppy support

PDA supports one protocol version at a time, currently the pinned 28 October 2026 text of 0.3. [Decision 37](decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles) records that choice. The [current verification report](poppy-0.3-conformance.md#current-verification) is the source for implementation status and live limits.

## Upgrade procedure

A refresh or upgrade starts when the owner requests it. There is no scheduled discovery refresh, automatic import or automatic pull request.

1. Compare the live specification with the stored snapshot using `npm run spec:drift`, then review the changed text. These commands run on demand.
2. Pin the reviewed text and update its changelog ledger. Implement the client, mock and validator changes for the selected version, recording ambiguous readings and storage migration consequences.
3. Run the repository checks and applicable interop/security lanes. Record independent and live evidence separately, including what could not be verified.
4. Review the concrete change before promotion. Older protocols are not kept in an N/N−1 window; a future support policy requires an explicit decision.

## Then 0.3, as rewritten on 28 October

The conversion is on PR #36. Its [implementation and evidence inventory](poppy-0.3-conformance.md) includes the original audit and subsequent consistency fixes. The [ledger](poppy-0.3-upgrade.md) maps changelog entries to implementation choices; the [upstream audit](poppy-0.3-issues.md) remains separate from local defects.

## Historical plan

The [earlier plan at its immutable revision](https://github.com/adewale/pda/blob/4a5d2143c2d46a88e37c90e48247b5a7162f2b5e/docs/poppy-0.3-plan.md) described scheduled imports, multiple versions and ports that have since completed. It is retained as history, not an active workflow.
