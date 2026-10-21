# Operation approval and withdrawal

Every new operation requires the User's approval of its exact revision on the agent's own card. Generic standing permissions are paused. A summary beginning with a word such as "exchange" cannot establish that the permission covers the action and every term, as Operations §5.1 requires. A Company's normal proposal call remains part of the protocol: it proposes an action, and the User then approves that proposal.

Older permissions remain visible as paused records in Companies and can be removed. The page offers no new automatic grants. Existing records showing a standing permission as the decision maker describe earlier actions; they do not grant future authority. The runtime also refuses new `standing_permission` approvals, including calls from older adapters.

## Existing approvals after an update

Startup recovery and sign-in recovery retire unsent approvals created by the old summary heuristic and show their proposals for explicit approval. An operation whose confirmation may already have been sent is kept in tracking. The agent reads its state and requests cancellation rather than discarding its outcome or confirming it again.

Existing per-revision User approvals remain valid across ordinary authentication recovery, provided their terms and account still match and the User has not withdrawn them. Removing a separate standing permission does not invalidate an independently recorded User approval.

When a definitely unsent approval was made while signed out, signing in identifies an account the original decision did not name. The agent binds the accessible proposal to that account, reopens its card and requires fresh explicit approval. It does not leave the proposal permanently stuck behind the account check or silently carry authority across that change.

## Withdrawing an approval

Decline or cancellation first records a durable cancellation request, clears approval, and advances an authorization generation. These writes happen before network work. A refused cancellation, a restart, or a delayed original response cannot restore permission to confirm.

The agent checks the current generation, revision, account and User approval immediately before every actual confirmation request. This includes attempts after token renewal, rate-limit waits and DPoP nonce challenges. No asynchronous preparation occurs between that final check and starting the request.

Once a request has started, cancelling cannot establish that the Company has not already acted. The agent keeps checking the same operation and retries cancellation. The page reports a cancellation that has not been accepted. A final response or a newer revision already observed cannot be overwritten by a delayed older confirmation response; a contradiction gets a notice asking the User to check with the Company.

Pending cancellation and unknown outcomes continue to block a new proposal for the same request until the existing operation is final. The agent does not treat cancellation failure as evidence that nothing happened.

## Reservation accounting

Older in-flight operations can still hold a limited-use reservation. Settlement claims the current operation's reservation once before updating the permission's counters. A late response holding an older row snapshot cannot release the same use again or decrement another operation's reservation. Reservations for possibly sent work remain until its outcome can be reconciled.

## Verification

`test/audit-withdrawal.test.ts` exercises removal and expiry of older permissions, failed cancellation followed by sign-in recovery, unknown confirmations after recovery, cancellation during token preparation and DPoP retry, delayed success after cancellation or a newer revision, compound summaries, concurrent reservation settlement, fresh approval after signed-out recovery, and a newer User decision interleaved with legacy retirement. It uses the Workers runtime and actual Durable Object SQLite; remote responses are controlled to establish each ordering.

`test/poppy.test.ts` keeps ordinary explicit approval, changed terms, authentication recovery, operation tracking and failure behavior covered. `test/ui/poppy-ui.test.tsx` checks that paused grants remain removable and no automatic-grant form is offered.
