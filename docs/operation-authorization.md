# Operation approval and withdrawal

PDA implements Operations 2. It sends requests for the User's task normally; a Company can carry out a routine request immediately. When the Company returns `approval_required` with an operation, the agent shows that revision's exact terms on its own card. Only the User's decision on that card authorizes sending the request again with the approval. The model cannot approve it.

Website forms and disclosure of files the User did not select for the task still need their own local cards. A task-selected photo needs no second disclosure click. [The design](../pda-spec.md#apis-7) explains these paths and their durable request records.

## What the decision authorizes

An approval names the Company's operation ID, revision and expiry. The stored request also binds the issuer, Session, account and authority generation. Before dispatch, the client checks those bindings and checks that the reconstructed method and URL still match the request shown on the card. It repeats the authority checks after asynchronous preparation, including token renewal, rate-limit waits and DPoP nonce challenges.

A pending decision is claimed once before dispatch. If approval and decline arrive together, the first claim wins. A late click on an earlier receipt cannot approve a new attempt, even if the Company repeats the same terms. New terms require a new decision.

## Withdrawal and uncertain outcomes

Declining a pending card ends that local decision without sending an approval. Signing out or changing the account or Session invalidates the authority bound to an unsent request. Stop and reset withdraw task grants, including permission to upload task-selected photos. These changes do not undo a request already dispatched.

Operations 2 has no remote confirm, cancel or operation-tracking endpoint. If a dispatched action's outcome is unknown, the agent preserves its receipt and blocks further writes at that Company until the User checks what happened. It does not resend the uncertain request. The User can record that the action happened or did not happen; this assertion is stored separately from the original receipt and sends no business request. A failed receipt update or notification does not turn a committed result into permission to retry.

## Earlier protocol and storage forms

The 0.3 migration removes Operations 1's proposals, operation tracking and standing-permission tables. Old operation cards become closed notices; they do not remain removable grants. Migration performs no remote cancellation or confirmation ([decision 37](decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles)).

Current stored approvals use version 3 with explicit authority bindings. Earlier pending forms are refused rather than executed or upgraded. Restate unfinished work in a fresh User request. Historical receipts and unknown-outcome holds remain evidence of earlier attempts; an unsupported record is not proof that its request did nothing. [Upgrading](upgrading.md#pre-10-approval-reset) describes the storage boundary and rollback limits.

## Verification

[Withdrawal tests](../test/audit-withdrawal.test.ts) exercise sign-out during token preparation and DPoP retry. [Concurrent-decision tests](../test/approval-concurrency.test.ts) check that competing decisions dispatch at most once. [Outcome tests](../test/poppy-outcome-guard.test.ts) cover holds across interfaces and replacement Sessions, reconciliation of linked records, and receipt repair after interruption. These tests use controlled Company responses; they do not establish whether a real Company completed an uncertain action.
