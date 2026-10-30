## Review

Target: supplied PR40 patch and final delta for `d277eaa7498f2b8e668d73d141e3c5274fcf8772`. Read-only final re-check; no execution or deployment inspection.

- **Correct:** Interrupted adopted uploads now use durable task attribution in the stored outcome, recovered card and model notice, while remaining `unknown` (`src/poppy/operations.ts:1013–1035`). The new checkpoint regression requires retained attribution, no “after you approved” claim and no second upload (`test/print-journey.test.ts:478–502`). Its simulated boundary is explicitly distinguished from a physical crash.
- **Correct:** Attribution remains presentation-only (`src/poppy/approval-projection.ts:24–27`). Activity avoids claiming a human decision, and receipts recognize adopted requests (`src/poppy/activity.ts:196–223`; `src/poppy-ui.tsx:659–690`). Lifecycle lookups accept bounded task IDs and follow linked outcomes (`src/poppy/frames.ts:14–19`; `src/poppy/approval-projection.ts:9–22`).
- **Correct:** Exact Company terms still produce a separate pending decision; the executor checks the stored approval and request before dispatch (`src/poppy/apis.ts:882–895,1029–1055`). Unresolved unknown outcomes still hold issuer writes (`src/poppy/operations.ts:284–297`). The recovery correction changes neither boundary.
- **Correct:** The browser delta adds light-scheme emulation and ordinary scrolling, without weakening assertions. Upload checks remain scoped to the current Company. The mobile negative control removes the current order’s exact checkout link before asserting its survival; desktop evidence cannot substitute (`scripts/app-photo-journey.mjs:90–121`; `scripts/app-smoke.mjs:88–89,168`).
- **Correct:** The obsolete blanket consent promise is corrected (`pda-spec.md:695`). Privacy text retains small-original image fallback, provider-dependent processing, separate retention and manual deletion/export limitations (`src/privacy.ts:68–90`). Remaining controls and unverified provider settings remain expressly unresolved (`docs/privacy-review.md:14–29`; `docs/evidence/task-photo-uploads/audit.md:49–60`).

No issues found.

- **Merge verdict: OK with notes.** No blocker found in this targeted source review. Final suite, browser, crash and interop results remain supervisor-owned; this review claims no execution evidence.