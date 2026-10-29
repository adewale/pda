# PR 36: three follow-up review corrections

The review identified three remaining defects in the production client. The fixes keep their scope separate from the [remaining interoperability evidence gaps](../../poppy-0.3-conformance.md#is-the-03-verification-sufficient).

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| Changing Session authority exhausted preparation attempts but blamed a Company refusal. | Exhaustion in that branch raises `approval_changed` and describes the local account/Session change. | Four preparation attempts change the Session; no resource request reaches the Company. Reverting the fix produces `server_error`. |
| One authorization handoff suppressed all later verification prompts in a conversation. | The Company event identifies a prompt. A tool call durably fixes its chosen prompt before sending; acknowledgement suppresses repeats of that prompt. | Identical wording in a later event permits a new handoff. Replaying an older call does not consume the new prompt. Lost answers retry the original message ID, including after another prompt and restart. Pre-upgrade saved handoffs retain their original identity. Withheld details never reach the Company. |
| Unreadable approvals were decoded again on every identity backfill. | An additive `action_identity_checked` flag records completed inspection, including unreadable requests. A partial index selects only unchecked rows; new proposals store their identity and flag together. | A history with 200 unreadable requests and a readable legacy request is inspected once. Four later operations, including a reconstructed client, use at most four index reads instead of the 814 reads observed without the fix. Existing derived identities survive migration. Unreadable approvals remain unsendable; unknown outcomes still hold writes. |

`regressions-before.txt` records the three targeted failures with `client.ts`, `agent-message.ts` and `operations.ts` temporarily restored from `d1d20feef1868b778cf212966dc74216f29a1e60`. The supporting schema/helper changes and final regression tests remained present. This is a targeted revert check, not a claim to have run the complete earlier commit. All three fixes were restored before the passing runs.

`full-suite-summary.txt` records the final run's project totals and documentation checks. `validation.json` records commands, source hashes, receipt hashes and results. Terminal colors and trailing whitespace are removed from the receipts. The summary is explicitly an extract; the full CI log remains available through the PR checks.

The first full run also exposed a race in the existing cursor-expiry notice test: an automatic background read could replace the deliberately expired cursor before its explicit read. Its fixture now suppresses scheduling during this test and restores it afterward. The real message tool, explicit read and notice assertion remain in place; production reader behavior is unchanged.

Reproduce the affected tests with Node 24 and the pinned dependencies:

```sh
npx vitest run --config test/vitest.config.ts \
  test/audit-withdrawal.test.ts test/poppy-model-policy.test.ts \
  test/poppy-approval-migration.test.ts test/rows.test.ts
npm run typecheck
npm run check:spec
npm test
```

The tests use the actual client and local SQLite/Worker runtime with a strict synthetic Company. They establish these regressions and their safety controls, not live sign-in, a real process-crash boundary around approval dispatch or additional independent-peer interoperability. Earlier PR screenshots retain their original capture revisions; these corrections change error text, authorization handoff behavior and migration work rather than the UI layout.
