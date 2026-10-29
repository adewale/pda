# PR 36: final adversarial audit

Six independent reviewers audited the PR at `3f46ac5047e4a0f0a892787846c3ab41acdb2519` against base `977e3bf146b958e8301fc1963379532d0fdad761`. Their areas were approval dispatch/recovery, OAuth/session authority, discovery/browser/hosting, migrations/UI, protocol conformance, and independent test oracles/evidence. Reviewers then challenged fixes outside their own areas. Root integrated the changes and owns final verification.

The audit covers code and local verification. The hosted pair is still undeployed; authenticated live OAuth/model verification and broader independent MCP/conversation/browser-join coverage remain open. Passing this audit supports a merge recommendation, not a production deployment claim.

## Findings and fixes

| ID | Finding | Fix and regression scope |
| --- | --- | --- |
| F01 | An older refresh response could overwrite a newer sign-in token or delete its account on `invalid_grant`. Sign-out could also lose to asynchronous token sealing. | Compare the exact sealed credential on refresh writes/errors and guard account-family generations around signing, sealing and dispatch. Ordinary refresh rotation remains valid. |
| F02 | A late `invalid_session` response could restart a different, newer Session and resend under it. | Response-triggered retries recheck the binding actually sent before mutating current state. |
| F03 | Scope narrowing or replacement consent could retain an older joined browser cookie and saved form, especially when old-grant revocation failed. | Contexts bind canonical scopes and account-family generation. New browsing rejoins; saved old forms fail without sending. Scope reordering is harmless. |
| F04 | A committed User reconciliation could permanently lose its model notice after card/callback failure; retry returned early. | A separately armed durable reconciliation notice preserves its exact ID/text and drains on linked-card retry/startup. Historical resolved rows default to no replay. |
| F05 | Failed receipt publication could change an already successful action from `done` to retryable `failed`; crashes could leave stale sending cards. | Card publication is outside business-outcome classification. Recovery repairs terminal receipts from durable outcomes without resending or reviving dismissed/aged receipts. |
| F06 | Batch recovery reused one notification ID with changed text, including after a User reconciliation. | Freeze the versioned batch notification before first delivery and replay the same ID/text. |
| F07 | A batch could describe a committed upload as undecided after card failure and clear its repair flag. | Use the durable terminal outcome, repair receipts before acknowledgement, and preserve pending recovery on publication failure. |
| F08 | A batch could clear a concurrent single handler's pending notice for an ID it had skipped. | Decision claims record explicit batch ownership; acknowledgement and recovery follow actual ownership, including claim/snapshot crash recovery. |
| F09 | CRLF split across network chunks invented SSE event boundaries, losing message data or cursors. | One incremental line-ending normalizer is shared by conversation streaming and the interop adapter. Every byte split is checked for CRLF, LF and CR, with replay/cursor assertions. |
| F10 | Individual stream events and unfinished text had no memory bound. | Bound each to 2,000,000 UTF-16 code units; cancel oversized streams while preserving earlier committed messages/cursors. Larger streams of bounded events remain valid. |
| F11 | Each streamed read left a timeout pending until the deadline. | A shared deadline-read helper clears the timer on data, EOF, error and timeout; 1,000 immediate reads leave none pending. |
| F12 | Concurrent normalized-task feedback calls could both POST before the sent intent existed. | Serialize per-client/Company/task attempts. Failed reports stay retryable; different tasks and Users remain independent. |
| F13 | The mock's repeated-feedback oracle incorrectly combined different Users. | Include verified client and User identity in its private repetition key. Keep the existing same-User negative control and public evidence schema. |
| F14 | The separately patched kit retained an old DPoP nonce after ordinary token responses and could reuse retry proofs. | Observe each token response's nonce, regenerate retry proofs, and retain independent positive/denial controls. Original archive and 79 source files remain unchanged. |
| F15 | Old conversations became uncloseable background retry loops after the protocol upgrade, and presence updates could stop before reaching valid work. | Add nullable retirement metadata, stop incompatible conversations locally, preserve history/cursor/pending evidence, terminate old reads and show an explicitly unknown local outcome. Supported contexts remain active. |
| F16 | Upgrade instructions named the old snapshot and implied a Git archive could be activated by the site-only checker. | Point to the actual 29 October pin and describe manual site capture. Clearly distinguish archival import from supported pin activation. |

The receipt, batch, stream and refresh patterns include pre-existing defects that remained relevant to the PR's new durability/interoperability claims. Findings are not all newly introduced regressions. Some before controls use the original committed production module in an isolated source copy; others demonstrate a follow-on failure after the first partial fix. The logs retain those scopes.

## Verification

Final source and verification receipts are recorded in the evidence follow-up. Each before/after log below is an actual local test run, with the original fixture and limits retained. The eight real process-crash cases cover the documented execution boundaries. Reconciliation, batch ownership, receipt publication and new async races have separate deterministic Worker/Node controls; this does not claim arbitrary process-crash coverage.

## Counterexamples and focused controls

- Authorization: [old refresh](account-refresh-before.txt), [late Session retry](account-retry-before.txt), [post-storage sign-out](account-store-before.txt), [62 focused client checks](account-after.txt).
- Browser authority: [four failing controls before](browser-before.txt), [narrowed/replacement grants after](browser-after.txt).
- Approval state: [lost reconciliation](reconciliation-before.txt), [receipt failures](receipts-before.txt), [batch/single ownership race](batch-ownership-before.txt), [final focused ownership/notice/migration checks](approval-after.txt).
- Streams: [CRLF framing](sse-framing-before.txt), [unbounded events/text](sse-bounds-before.txt), [pending timers](sse-timers-before.txt), [timer controls after](sse-timers-after.txt).
- Feedback: [concurrent-report failure](feedback-before.txt), [232 Worker checks after, including the original mock negative controls](conformance-after.txt).
- Upgrade: [legacy conversation failures](legacy-before.txt), [migration checks after](legacy-after.txt).

The patched-kit tests also use an intentionally permissive invalid-signature control to prove their denial oracle rejects a malformed proof accepted by a broken peer. Historical kit files and earlier evidence packages are unchanged.

Legacy compatibility: old batches whose claim owner was never recorded may report an outcome individually as well as in the batch. The migration preserves pending information instead of adopting another handler's notice from an old intent snapshot. No Company request is repeated.
