## Review

- **Correct:** The corrections consume IPv6/network tokens before filename matching and canonicalize complete hostname authorities (`src/poppy/task-text.ts:19–55`, `src/poppy/task-scope.ts:35–51`). Task provenance, pre-discovery authority capture and dispatch-time withdrawal checks remain separate safeguards (`src/tools/turn-authority.ts:53–81`, `src/poppy/discovery-authority.ts:15–28`, `src/poppy/tools.ts:375–393`).

- **Finding: P1 — Deictic fallback still selects an unrelated stored photo from an unknown filename.**
  - **Location:** `src/poppy/task-files.ts:45–49`.
  - **Minimal history:** Store one earlier `private.jpg`, then admit the genuine User request `Print this photo-old.jpg at first.example`, without attaching another photo.
  - **Source proof:** No known filename span matches. The singular regex nevertheless matches `this photo`: the hyphen supplies its word boundary, while `(?!\.[\p{L}\p{N}])` excludes only an immediately following dot plus letter/number. Line 49 therefore grants the earlier `private.jpg` ID. Unicode continuation variants, such as `this photo\u200b.jpg`, also escape that exclusion.
  - **Impact:** A Company-induced API call naming that unrelated ID passes `taskFiles.includes(ids)` and receives the automatic upload route, bypassing disclosure consent (`src/poppy/apis.ts:994–1006`). This mechanically adds an unselected ID; it is not merely uncertainty about whether an otherwise selected upload serves the task.
  - **History:** PR40 introduces this fallback. The final delta addresses `this photo.jpg` but leaves filename continuations beyond `.letter/number` unprotected. Existing unit and obedient-model regressions cover the dot case only (`test/poppy-task-files.test.ts:98–100`, `test/print-journey.test.ts:308–343`).
  - **Smallest sound fix:** Exclude deictic matches embedded in filename-like tokens, including hyphenated and Unicode continuations, before recent-batch inference. Extend those existing regressions to require no selected historical ID, a disclosure card and zero uploads for these variants.

- **Merge verdict: BLOCK.**

Source-only review of the supplied snapshot and patch artifacts. No tests, servers, network requests or private deployment inspection performed; no final-pin gate results claimed.