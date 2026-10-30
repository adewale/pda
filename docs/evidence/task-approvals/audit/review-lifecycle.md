## Review

Scope: exported revision `f10b24e1acab871797bce422cc366d1e83b91943`, against the supplied `86f7752..f10b24e` diff. Read-only review; no commands or tests executed.

No issues found.

### Correct
- **Durable replay/coalescing:** `poppy_task_calls` retains the selected request and payload fingerprint independently of current authority. Selection and binding persistence occur without an intervening await; terminal replay does not create another request (`src/poppy/operations.ts:330–371, 413–448`). Tracing settlement, decline, and successive revision handoffs did not expose a resend path.
- **Immutable decisions:** fresh task attempts receive distinct terms-decision IDs, even when Company terms repeat. Returning the already-approved revision is treated as refusal rather than reopening that decision (`src/poppy/apis.ts:1014–1025`; `src/poppy/operations.ts:350–359`). Delayed-click regression coverage checks the previous declined ID cannot claim the new pending decision (`test/poppy-notification-recovery.test.ts:48–73`).
- **Publication recovery:** the parent-to-terms link is persisted before card publication. Recovery restores linked executing parents to `terms` and republishes saved pending terms without dispatching them (`src/poppy/operations.ts:371, 887–943`). The process verifier explicitly kills before terms publication and checks the surviving Company ledger remains unchanged (`scripts/check-approval-crashes.mjs:162–303`).
- **Authority across preparation:** authority is captured before OpenAPI/MCP preparation and checked immediately before transport. Only an unapproved request’s known `invalid_session` refusal may advance its expected Session; account and withdrawal generation remain fixed. Returned terms retain the transport’s binding rather than sampling the account after response processing (`src/poppy/apis.ts:22–54, 885–888, 928, 1235–1241, 1262`; `src/poppy/client.ts:1324–1332, 1385–1392`).
- **Unsupported storage is refused:** approval version 3 requires explicit bindings and generations; older versions and preliminary API-write approvals cannot execute (`src/poppy/approvals.ts:12, 41–58, 72–86`; `src/poppy/apis.ts:964–969, 1301–1306`).

### Limitations and validation
- These guarantees concern recorded task attempts, not arbitrary fresh tasks after completion. Company-side Operations 2 remains responsible for operation-level at-most-once execution.
- Conservative unknown-outcome holds and incomplete automatic Ops 7 retry recovery remain the disclosed limits, not new findings.
- I inspected the crash verifier and focused regressions but did not independently reproduce their results. The supplied focused/property passes are contextual evidence. The supervisor should rerun `npm run check:approval-crashes` at this exact pin after the latest authority refinement.

### Merge verdict
**OK with notes.** No merge blocker found in this seam; this review is not proof against every possible interleaving.