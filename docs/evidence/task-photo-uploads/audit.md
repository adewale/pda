# Task-selected photos: audit disposition

Initial source-review pin: `00d034c713624afa81ba690d19e4d7630551e77e`. Three independent read-only reviews ran against an immutable export. They did not execute tests or inspect production. The supervisor reproduced the actionable paths and made the following corrections before requesting re-review.

| Initial finding | Correction and regression |
| --- | --- |
| Attachment metadata selected another historical photo | Parse marker IDs separately; remove metadata before narrative matching. `copy of private.jpg` cannot select `private.jpg`. The obedient-model theft regression attempts the other file and receives a disclosure card, with zero uploads. |
| A user-role compaction summary became User authority | Read original placed `pi.user` submissions with durable ingress provenance. Generations memoize their task key; API tools, including resumed tools, read their generating task's memo. The compaction theft regression checks no automatic transfer and no summary-triggered image injection. |
| A schemeless URL query supplied another recipient | Parse host/port before paths and queries. The live-agent fake-Company redirect regression records zero requests at the second Company. |
| Account/Session authority was captured after discovery | Persist a checkpoint before asynchronous preparation/discovery and check it after discovery. Gated histories cover sign-out, same-account re-sign-in and a different account, with zero photo requests. |
| A new selected call left an older disclosure independently executable | Coalesce equivalent pending file disclosure with matching action identity and authority; retire its button before dispatch. Delayed decisions, restart and replay produce one upload. |
| Deletion/expiry hid a committed result | Bind checked input identity and aliases; recover recorded outcomes before discovery or attachment reads. Both deletion and expiry return the saved success without another send. |
| A stopped tool without a result said Sent | Keep the missing-result state. Rendered transcript regression requires unconfirmed wording, never Sent. |
| Three successful automatic uploads said 0 of 3 | Count affirmative automatic completion. A rendered three-photo transcript requires 3 of 3. |
| Unknown uploads appeared Failed on their originating step | Application-generated lifecycle references preserve the durable outcome through successful and error results. Network loss, gateway/server failures and known HTTP refusal regressions distinguish Unknown from Failed. |
| The privacy policy promised only smaller images | Disclose previews or sufficiently small originals, which may retain metadata; update policy assertions and usage documentation. |
| Desktop output could satisfy mobile browser assertions | Scope the upload assertion to the current Company and reload assertion to the current order's exact source/resolved checkout link. Add a mobile-receipt-removal negative control. Execution evidence is recorded separately. |

## Further supervisor findings

- **Filename in narrative:** a hostname-shaped filename repeated in ordinary User text could supply another recipient. Known filenames are data even in narrative; sentence punctuation cannot change that. Disabling this filter makes the obedient-model regression send to the second Company.
- **First recipient:** the inferred-first-Company fallback could override an explicit destination before any Company result. Explicit destinations now constrain the first call. Disabling that restriction makes the direct scope regression fail. URL queries, email URLs, Markdown links and non-default destination ports have focused checks.
- **Stop/reset and older admissions:** task grants are revocable, not reconstructed forever from history. Authenticated Stop/reset withdraw them; new admissions carry the current task policy, and earlier admissions are not upgraded. Background attempts after withdrawal/older admissions send nothing; a fresh genuine User request succeeds. Disabling withdrawal makes the regression upload after Stop. A suspended-token history also verifies that Stop prevents the photo request.
- **Alias identity:** the full suite exposed a formerly accepted operation-ID/method-path alias being rejected by the new early fingerprint. Only aliases resolving to the same checked operation are retained. The existing replay assertion remains unchanged and passes.
- **Canonical projection:** the unchanged Hegel property exposed different lifecycle IDs on coalesced outcomes. Prefer the canonical task root and project through linked terms/revisions, with cycle refusal and an indexed parent lookup. The property was fixed in production code, not narrowed or weakened.
- **All file methods:** file-bearing calls retain durable dispatch rather than taking the ordinary GET fast path.

## Second independent review and corrections

Three fresh source-only reviews inspected `0b499a1209208383bc9a704d7b400e0e26da0d0f`. They confirmed the initial corrections and found five further structural/lifecycle failures and two presentation issues:

- A qualified URL inside a schemeless URL or email query was scanned separately. `task-text.ts` now consumes the complete outer locator once; paths, queries and email data remain opaque. Network references also cannot select a historical filename. Obedient-model regressions require zero second-Company requests.
- A longer filename mentioned in narrative selected a contained shorter name. Full known filename spans are resolved before IDs are added; contained suffixes are suppressed, and crossing overlaps remain ambiguous.
- Duplicate `this photo.jpg` names fell through to an unrelated recent photo. Recognized unresolved filename spans are removed from ordinary-reference inference. Ordinary extensionless words are not filename grants without quotes or an explicit naming clause.
- Adoption retired only one of multiple equivalent pending disclosures. Every equivalent pending sibling is linked and made non-executable before sending. One-, two- and three-old-card histories, delayed decisions and restart retain one upload. Linked read-only projections follow the actual child state.
- Receipt-publication failure replaced a committed success or stripped an unknown outcome's reference. Completion now rereads the durable business outcome even when publication throws. Real SDK tool-result tests cover both successful and unknown automatic uploads; restoration/restart does not send again.
- Raw Company MCP data could forge the new `poppyTask` field. Only the application-owned OpenAPI result path supplies this UI reference; forged MCP data cannot change state or trigger a durable lookup. Company result data is retained, not discarded.
- Adopted disclosure receipts and Activity falsely implied a card click. The successful claim records task-selection attribution separately from authority; linked receipts, Activity and recovery notices preserve it. The marker confers no execution permission.

The supervisor reproduced nine selection/recipient failures before correction. Disabling sibling retirement and publication-boundary recovery makes four lifecycle regressions fail; disabling the two presentation corrections makes both UI regressions fail. Additional checks cover Unicode hostname suffixes, filename/recipient-name collisions, sentence punctuation and the durable classification of a file-bearing GET before transport refusal/loss. A counterfactual GET description is not evidence that the strict mock serves GET uploads.

The corrected source passed **2,209 tests in 118 files**, none skipped: Workers 1,330; durability 3; page 268; interop unit/contract 415; properties 193. Typecheck, the docs-name check and the pinned-spec check passed. The unchanged Hegel properties retain their original generators and assertions. Browser/crash runs at the preceding pin are not silently promoted to this source revision; final receipts identify their own pin.

## Third independent review and corrections

Three fresh source-only reviews inspected `91a8536ace2b6b22cb1c1773f0f7e50197be0c6f`. The durable-lifecycle lane found no blocker; security and UI/policy found the following remaining issues:

- Bracketed IPv6 locator paths/queries could select an unrelated historical filename. URL-normalized Unicode hostname separators could expose an inner hostname suffix as another recipient. The lexer now consumes the complete outer network token and uses WHATWG URL parsing for its authority, rather than finding DNS-shaped substrings. Numeric hosts, IPv6 and IDNA separator variants remain whole; unsupported network data stays opaque to filename matching. Known filename data is compared canonically without normalizing file-selection text. Seven focused regressions failed on an otherwise unchanged `91a8536` application; the corrected source passes them. Obedient-model histories require a disclosure card with zero uploads for the IPv6 theft, and zero second-Company requests for all three Unicode separators.
- An interrupted adopted `apr_` request still stored “after you approved” and lost its task attribution on the recovered card. Recovery now uses the durable attribution marker, without changing authority or the unknown-outcome hold. A storage-checkpoint regression failed before correction; it requires unknown status, no human-click claim, retained card attribution and no resend. This simulates the durable boundary; it is not a physical selected-multipart process-crash probe.
- The tool table retained the blanket consent-card promise. It now describes immutable per-call routing and disclosure cards only for unselected files.

The full run also caught an over-refusal: ordinary question punctuation was being treated as a dotless network authority, preventing the MCP-injection fixture from reaching its hostile description. Dotless opaque data no longer chooses a Company, and trailing question punctuation preserves filename references instead of falling through to a newer photo. The safety oracle was not weakened. An intermediate added-test typo was corrected. Typecheck and 125 focused selection, lifecycle and prompt-injection tests pass; final full-suite and runtime receipts are recorded separately.

Browser evidence now fixes the color scheme to light on both sides, rather than inheriting a sunset-dependent OS theme. Mobile evidence uses ordinary scrolling to frame the confirmed upload. Neither change alters application behavior or edits screenshot pixels.

## Verification at the preceding fix candidate

The supervisor ran `npm run typecheck`, `npm test` and `npm run check:spec`. The full suite passed **2,186 tests in 118 files**, none skipped: Workers 1,309; durability 3; page 266; interop unit/contract 415; properties 193. Hegel used its default case count, including the unchanged coalescing property. The docs-name check verified 386 Appendix A names and nine adversarial scenarios/four named tests; existence is not behavioral coverage. The spec check verified 43 dispositions and 13 pinned pages.

This is not yet the final browser/crash/interop/deployment receipt. Re-review and publication gates follow at an immutable source pin. No live OAuth, model-provider account, checkout, payment, print or email service has been exercised by these tests. Gateway/provider logging, retention and training settings remain unverified. The product shortcomings in `docs/privacy-review.md` remain unimplemented unless explicitly stated otherwise.
