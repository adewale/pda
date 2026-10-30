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

## Verification at the fix candidate

The supervisor ran `npm run typecheck`, `npm test` and `npm run check:spec`. The full suite passed **2,186 tests in 118 files**, none skipped: Workers 1,309; durability 3; page 266; interop unit/contract 415; properties 193. Hegel used its default case count, including the unchanged coalescing property. The docs-name check verified 386 Appendix A names and nine adversarial scenarios/four named tests; existence is not behavioral coverage. The spec check verified 43 dispositions and 13 pinned pages.

This is not yet the final browser/crash/interop/deployment receipt. Re-review and publication gates follow at an immutable source pin. No live OAuth, model-provider account, checkout, payment, print or email service has been exercised by these tests. Gateway/provider logging, retention and training settings remain unverified. The product shortcomings in `docs/privacy-review.md` remain unimplemented unless explicitly stated otherwise.
