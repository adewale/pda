## Review

- **Correct:** The original hyphen and Unicode-continuation counterexamples are closed by complete-reference matching (`/tmp/pda-photo-review-deictic/src/poppy/task-files.ts:48–52`). Added tests cover those cases and preserve ordinary references with sentence punctuation (`/tmp/pda-photo-review-deictic/test/poppy-task-files.test.ts:98–105`).

- **Finding: P1 — A known extensionless filename can still lend a reference to an unrelated recent photo.**
  - **Location:** `/tmp/pda-photo-review-deictic/src/poppy/task-files.ts:45–52`.
  - **Minimal history:** Submit an older image named `this photo backup`; then submit `private.jpg`. Send a fresh request: `Print the file this photo backup at first.example`, without attachment markers.
  - **Source proof:** The complete older filename is recognized, but is unselectable without quotes or a naming clause (`:59–65`). Line 45 nevertheless leaves it in `plain` because it contains no dot. `unresolvedName` is false, and the singular grammar matches `this photo` inside that known filename. Line 52 consequently selects the unrelated latest `private.jpg` ID.
  - **Impact:** A Company-induced call naming `private.jpg` takes the automatic upload route rather than disclosure consent (`/tmp/pda-photo-review-deictic/src/poppy/apis.ts:994–1006`). This is mechanical selection from a recognized filename span, not merely a model misunderstanding an otherwise selected photo.
  - **History and coverage:** This remains the same fallback-widening class introduced by PR40. The new unsupported-name regression covers `this photo .odd`, whose dot activates suppression, but not extensionless longer names (`/tmp/pda-photo-review-deictic/test/poppy-task-files.test.ts:107–113`).
  - **Smallest sound fix:** Reject ordinary-reference matches contained within longer recognized, unresolved filename spans regardless of extension. Preserve ordinary references containing a single-word historical name such as `photo`. Add the extensionless history to unit and obedient-model regressions, requiring no unrelated selection and zero automatic uploads.

- **Merge verdict: BLOCK.** The original examples are corrected, but this neighboring structural disclosure bypass remains.

Source-only review of the supplied `2eef6fdcc51b099b114ab9e632fe9cda6434c151` snapshot and delta. No edits, tests, servers, network requests or private-configuration inspection performed. Supervisor-reported execution results were not independently verified.