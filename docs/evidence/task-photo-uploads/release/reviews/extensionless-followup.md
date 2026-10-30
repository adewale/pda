## Review

- **Correct:** The exact extensionless history is corrected: `this photo backup` is now masked before ordinary-reference inference (`/tmp/pda-photo-review-extensionless/src/poppy/task-files.ts:45`). Unit and obedient-model regressions cover that history (`test/poppy-task-files.test.ts:107–113`, `test/print-journey.test.ts:312–318`, relative to the new snapshot).

- **Finding: P1 — Recipient-cued known spans still lend deictic references.**
  - **Location:** `/tmp/pda-photo-review-extensionless/src/poppy/task-files.ts:45–52`.
  - **Minimal history:** Submit an image named `this photo backup`, then a separate `private.jpg`. Send: `Check my order status at “this photo backup” (first.example).` No current attachment markers.
  - **Source proof:** The complete known filename span is recognized, but `recipientCue` matches `at “` (`src/poppy/task-text.ts:10–11`). That correctly prevents filename selection (`src/poppy/task-files.ts:64`), but also incorrectly prevents masking at line 45. The singular grammar then matches `this photo` inside the quoted recipient name, and line 52 selects the unrelated latest `private.jpg`.
  - **Impact:** A Company-induced upload naming that ID receives the automatic route (`src/poppy/apis.ts:1003–1006`). The explicit `first.example` remains allowed by recipient scope. This mechanically grants an unrelated ID from recognized recipient data, rather than merely misinterpreting an already-selected photo’s purpose.
  - **History:** The extensionless correction closes the original request, but retains this exception in the same suppression predicate.
  - **Smallest sound fix:** Mask recognized multiword/dotted spans independently of `recipientCue`; retain the cue when deciding whether a filename selects an ID. This preserves ordinary single-word names. Add the quoted-recipient history to unit and obedient-model regressions, requiring no selection, disclosure consent and zero uploads.

- **Merge verdict: BLOCK.**

Source-only review at supplied pin `af46bc754fccca2cd9fd5c83100abba4e10e5033`. No execution, edits, network or private-configuration inspection performed. Supervisor-reported tests and final-pin runtime gates were not independently verified.