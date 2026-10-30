## Review

- **Correct:** The previously reported known-span history is corrected. Multiword/dotted filenames are masked independently of recipient cues, and directly quoted recipient titles are removed before filename selection (`/tmp/pda-photo-review-recipient/src/poppy/task-files.ts:23,46`).

- **Finding: P1 — Parenthesized quoted recipients bypass the new opacity rule.**
  - **Location:** `/tmp/pda-photo-review-recipient/src/poppy/task-files.ts:23,51–59`.
  - **Minimal history:** Submit one earlier `private.jpg`. Then send, without attachments: `Check my order status at (“some this photo”) (first.example).`
  - **Source-derived counterexample, not executed:** Line 23 requires the quote immediately after the receiver cue’s whitespace, so `at (“…”)` remains unmasked. The ordinary-reference grammar matches `this photo”)`. Its receiver check examines the prefix ending in `some `, misses the outer cue, and grants the latest `private.jpg` ID.
  - **Why this is in scope:** Parenthesis wrappers are already explicitly accepted by `recipientCue` (`/tmp/pda-photo-review-recipient/src/poppy/task-text.ts:10–11`). This is a mismatch between existing receiver syntax and the new opacity pass, not an arbitrary natural-language interpretation.
  - **Impact:** `first.example` remains an allowed recipient. A Company-induced upload naming the unrelated ID takes the automatic route instead of disclosure consent (`/tmp/pda-photo-review-recipient/src/poppy/apis.ts:1003–1006`).
  - **Smallest sound fix:** Make quoted-recipient masking honor the opening wrappers already recognized by `recipientCue`, consuming the complete quoted title. Extend the existing unknown-recipient unit and obedient-model histories with parenthesis/bracket wrappers, requiring no selected ID and zero uploads.

- **Merge verdict: BLOCK.** The exact previous history is closed; this closely neighboring structural bypass remains.

Source-only review at supplied pin `2690ecb027dc7a94aeed55a62e0a9fcfef6e7d68`. No edits, execution, network or private-configuration inspection. Supervisor-reported tests and final-pin gates were not independently verified.