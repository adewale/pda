# Focused audit fixes

Base: `d8515e7be4282014c6ebcf21d156ac689f333050`. This local candidate retains concrete correctness, access-control and bounded-resource fixes. It removes the broader consent redesign and self-service privacy features from the earlier audit implementation.

| Retained issue | Fix and evidence |
| --- | --- |
| Company-chosen conversation IDs collide; domain/response/parent mismatches corrupt ownership | Issuer-scoped local handles and checked continuations/events. Legacy records with uncertain attribution are quarantined and stopped locally, without pretending remote work was cancelled. `test/audit-isolation.test.ts`. |
| Cancellation/withdrawal survives waits, authentication recovery and retries | Durable cancellation generations and authorization checks immediately before each confirmation attempt; preserve reconciliation of already-sent work. `test/audit-withdrawal.test.ts`. |
| Duplicate reservation release and stale confirmation replies | Claim the live reservation once; preserve newer/final state. Same withdrawal regressions. |
| Generic prose matcher cannot establish standing-permission coverage | Pause generic automatic approval and new grant creation; retain removable paused records and explicit revision approvals. See `operation-authorization.md`. |
| Logout, socket expiry and cross-account reconnect leave authority or queued text live | Revocable per-login SIDs, hibernation-safe socket checks and mandatory workspace binding. Preserve queued text on auth loss. `test/session-boundaries.test.ts`, `test/ui/reconnect-owner.test.tsx`. |
| Punctuation guesses input authority; background tools can mutate protected notes | Durable per-submission provenance; User-source note deletion remains in authenticated Settings. Model cleanup is limited to Agent noted notes. `test/turn-authority.test.ts`, `test/general-tools.test.ts`, `test/schedules.test.ts`. |
| Anonymous validator input can bypass envelope bounds or amplify JSON source locations | Streamed request limits, deadlines and structural guards; cumulative escaped-pointer allocation allowance before construction. Resource refusals are local policy, not protocol syntax errors. `test/validator-input.test.ts`, `test/pr-review-limits.test.ts`. |
| Shared spend settlement is lost or charged to the wrong UTC day | Durable reservations, admission-day attribution, idempotent shared settlement and retry outbox. Unknown usage retains liability conservatively. Existing dollar caps remain soft. `test/budget.test.ts`, model-access/recovery tests. |
| MCP sessions cross agent clients; explicit tool errors/failed response bodies misreport outcomes | Client-scoped MCP state, explicit MCP failure classification and honest uncertain receipts for existing approved writes. Browser/write approval state remains bound to the account and Session. Focused MCP/browser outcome regressions. |
| Calculator property assumes wrong error precedence | Correct the test oracle, keeping independent arithmetic and the original production resource limit. `calculator-property-triage.md`. |

## Removed from this candidate

- Universal disclosure cards for model messages, handoffs, API/MCP reads and proposals.
- Company-discovery and exact URL/navigation/click/redirect consent stores, routes and UI.
- MCP descriptor pins and their configuration.
- Self-service whole-agent deletion/recreation, its generation registry, and user-data export.
- New deployment-wide call/output/browser quotas and billing preflight tooling.
- The corresponding Evil Company modes, synthetic consent tests, extra migrations and configuration.
- Historical audit reports that mixed baseline defects, policy choices and remediation regressions.

Ordinary Company messages, API reads/proposals, signed-out URL reads, browser navigation and normal POST/redirect/GET behavior use their original workflows. Existing account-action approvals remain. Remaining intentional compatibility effects: older cookies require sign-in again, old unbound tabs must reload, uncertain legacy Company conversations are stopped locally, and old pending write/form cards without identity bindings need a fresh request. User-source notes are deleted in Settings; generic standing approval stays paused. This candidate does not claim universal private-data disclosure prevention, live-model attack resistance, a hard provider billing ceiling or production service acceptance.

## Validation

The final full `npm test` run passed all five suites: 1,715 passed and one existing skip (1,716 discovered across 72 files). The documentation checker verified 252 Appendix A names, 19 scenarios and five referenced adversarial tests. Typecheck and `git diff --check` passed; copied upstream protocol/socket/view/transcript modules remain untouched.

`node scripts/app-smoke.mjs --output /tmp/pda-trim-app-smoke.json` rebuilt the production frontend and passed in real local Chromium/workerd: signed-out page, accepted WebSocket, actual synthetic-model chat, persisted history after reload, route-specific headings, mobile drawer/layout, logout recovery and retained draft. Zero uncaught browser page errors were recorded. Authentication uses the actual signed-session verifier with a synthetic identity; no bypass is installed.

Restored workflow controls include ordinary signed-in website/API/MCP reads with no extra approval cards, and one existing form decision followed by a real POST/303/GET and an Address saved receipt. Tests use explicit decisions, not automatic-consent helpers. Logs are `/tmp/pda-trim-final-tests.log`, `/tmp/pda-trim-typecheck-final.log` and `/tmp/pda-trim-app-smoke.log`. No deployment, live OAuth exchange, paid model or remote Browser Run/device acceptance is claimed.
