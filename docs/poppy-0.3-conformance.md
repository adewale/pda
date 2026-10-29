# Poppy 0.3 conformance review

This review targets the [29 October 2026 snapshot](../spec/draft-0.3-retrieved-2026-10-29/README.md). It separates PDA's implementation and verification problems from the [43 issues in the upstream text](poppy-0.3-issues.md). A changelog disposition of **Done** records an implemented change; it does not certify every normative requirement or every deployment path.

## Current verification

PDA implements the pinned 29 October 2026 text of Poppy 0.3 alone. This is the current verification summary; dated evidence packages retain the results of their own runs.

| Area | Evidence and limit |
| --- | --- |
| Repository implementation | The [PR checks](https://github.com/adewale/pda/pull/36/checks) run types, specification integrity, Worker, durability, page, interop and property tests on the commit under review. Passing them does not certify every normative requirement. |
| Own interop and security lanes | CI selects applicable honest/network, malicious-Company and malicious-agent cells explicitly, and refuses skipped required cells. [Lane definitions](../.github/workflows/interop.yml). |
| Official Company kit | The [pinned website kit and manual checklist review](company-kit-review.md) exercise our mock profiles and hosted dummy Company's handlers independently over local HTTPS. The original raw DPoP prerequisite findings remain explicit. A separately patched copy finishes those probes with valid DPoP and 18 independent proof controls; absent-feature skips remain skips. This verifies Company-side fixtures, not the full Personal Agent. |
| Independent Company | The pinned print-with-poppy 0.3 demo was rerun against the current client and passed all ten supported scenarios. [Fresh receipts and source hashes](evidence/pr-36-interop-completion/README.md). Demo accounts, orders and payments are synthetic. |
| Browser interaction | The fresh [application smoke run](evidence/pr-36-interop-completion/README.md#browser-evidence) uses the production build, authenticated WebSocket and strict mock. Identity, model and Company are synthetic. |
| Process-crash recovery | Eight actual SIGKILL cases terminate PDA and workerd, reuse SQLite and retain a separate Company process/request ledger. OpenAPI and MCP each cover four boundaries; no business request or effect repeats. [Receipt and recovered-notification defect](evidence/pr-36-interop-completion/README.md). |
| Live services | Discovery has been checked at printwithpoppy.com. Authenticated live 0.3 journeys remain unverified. The [isolated hosted pair](../test/hosted/README.md) is prepared; account/OAuth inputs and the User's model key are still needed. |

## Is the 0.3 verification sufficient?

There is substantial evidence for the pinned implementation and its local safety properties. There is not yet enough evidence for broad cross-project interoperability or a production-verified 0.3 journey. The repository's full test count includes the rest of the application; it is not a count of independent protocol checks. The 96 CI interop cells use our code on both sides, including profiles of the same implementations.

The independent evidence has narrower scope. print-with-poppy supplies ten supported scenarios at one pinned demo, including sign-in and a photo order, but no independent MCP, conversations, handoff, streaming or browser join. Its fresh run is source-pinned in the completion evidence; the peer remains outside the CI grid. The official kit independently checks our Company fixtures, while the Python client exercises those fixtures through a separate implementation written under our own readings. Neither directly proves that PDA's client works against every other Company.

The sufficiency review found a concrete shared assumption: the Python message oracle discarded `context`, as our mock had done before the official kit exposed that defect. The oracle now requires the whole message as sent. Three focused counterexamples fail under the old oracle and pass under the corrected one; loss or mutation of context is still rejected. Generators, configured examples, step counts and the other invariants are unchanged. [Fresh Python verification and counterexamples](evidence/pr-36-verification/README.md).

| Priority | Current result | Remaining boundary |
| --- | --- | --- |
| 1. Authenticated isolated deployment | Prepared, locally security-checked and upload-dry-run; still undeployed. No Cloudflare identity or private hosted settings are configured in this checkout. | Need the isolated account, separate GitHub OAuth App and allowlisted User settings; the User enters a model key after real sign-in. Run consent, API/MCP approve and decline, refresh, sign-out and reload on that pair. |
| 2. Actual approval process crashes | Eight passing OpenAPI/MCP cases kill the PDA/workerd process group at before-dispatch, after-effect, after-commit and after-notification boundaries. The Company and its business-request ledger survive; SQLite identity, User attribution and holds survive. | This exposed and fixed a lost completion notification. A per-decision durable notification retries the same ID/text through the existing idempotent model callback; acknowledgement loss may repeat the callback. This is local process evidence, not a Cloudflare outage simulation. |
| 3. Independent interfaces | Fresh print-shop demo: all ten supported scenarios pass. Dated source checks found Datalayer, poppyseed and PoppyKit still using earlier Session-Key/Session-Token 0.3 designs. | No matching independent MCP, conversation/streaming or browser-join peer was found among the checked projects. Rewriting their wire implementations ourselves would not supply independent evidence. Search scope and pins are in the completion receipt. |
| 4. Combined authorization attacks | Eight Worker tests interleave four sign-ins across two Companies and two Users, swap issuer/state/code combinations, check token destinations and unchanged account bindings, then complete four valid flows. | These are actual client/Worker tests. The grid still has no multi-Company `XM` scenario; its ordinary cell owns one Company. |
| 5. Kit DPoP prerequisites | Original unmodified verdicts retained. A temporary patched copy passes 119 checks on each mock/Bearer profile, with one skip; hosted handlers pass 62 with 58 feature skips. Eighteen independent valid/missing/bad-signature/method/URL controls pass. | The patch supplies only the missing token-request prerequisite; it does not relax Company validation or modify upstream expected results. No report has been posted upstream. |
| 6. Fresh independent/browser evidence | Fresh print-shop, production-build Chromium and local Python runs are recorded with source hashes. Python passes 21 tests with its existing generators and limits. | These remain occasional manual runs; Python stays outside CI. Its ungenerated expiry/cursor/stream/consent cases and independent peer limits remain explicit. |

[Completion evidence, commands, screenshots, before-fix failure and source hashes](evidence/pr-36-interop-completion/README.md). The manual spec refresh found one new browser-ownership MUST; the controlled-browser design already complied, and a direct regression now covers it. The site sentence has not yet reached the upstream GitHub head, so the 29 October snapshot remains the exact pin.

This is an assessment of evidence, not a new version-support policy or a claim that every absent scenario is an implementation defect. Production Company storage, abuse controls and consent gaps from [the kit review](company-kit-review.md) remain a separate fixture-readiness backlog.

## Local problems and their fixes

The consistency follow-up addresses the ten findings from the second PR review:

| Review finding | Final change |
| --- | --- |
| 1. Withheld replies looked sent. | Typed message outcomes drive transcript summaries, including saved results from before this update. A withheld reply is never quoted as a sent message. |
| 2. Restart revived dismissed receipts. | Card recovery repairs content while preserving age and dismissal; a first User reconciliation is still a new event. |
| 3. Old actions looked pending after Activity retention. | The page requests durable decisions for the approvals in its loaded transcript. Reads are bounded, read-only and scoped to the authenticated User's own object. Activity remains a bounded feed. |
| 4. Recovered batches omitted User reconciliation. | Batch recovery reads the same checked outcome used by Activity and the page, preserving its User provenance and the original uncertain receipt. |
| 5. Hosted checking echoed private JSON. | Both hosted commands use one private-file reader/writer and safe error formatter. Malformed settings, manifests and secrets are refused without printing input values. |
| 6. Outcome interpretation was duplicated. | One typed approval-state projection and one reconciliation formatter serve receipts, transcript decisions, Activity and batch recovery. |
| 7. Message policy and delivery were mixed into the tool adapter. | A conversation helper owns classification, saved policy, stable message identity, acknowledgement and typed results. The tool adapts arguments. |
| 8. Authority comparison was repeated. | A shared Session/account/withdrawal predicate replaces repeated comparisons. Browser context ownership, scope-sensitive MCP cache bindings and all checks around asynchronous work remain distinct. |
| 9. Current documentation contradicted itself. | This report owns the current verification summary. The design and README link here; the active upgrade procedure specifies manual, single-version upgrades. The obsolete plan is linked at its frozen revision. |
| 10. Several capture drivers were maintained. | New evidence uses the application smoke entry point. Earlier images and receipts remain, with immutable links to their archived source and instructions. |

The Python client and strict mock retain their independent validation. Their agreement is useful evidence precisely because they do not share all of PDA's implementation.

Three further review findings are fixed in [the follow-up regressions](evidence/pr-36-review-feedback/README.md): exhaustion caused by changing local Session authority reports `approval_changed`; authorization handoffs are suppressed per Company verification prompt, with the chosen prompt fixed across tool replay; and indexed, durable inspection progress keeps unreadable approval requests out of later identity backfills. Unreadable requests remain unsendable, and an unknown outcome still holds writes at its Company.

| Problem | Result and evidence |
| --- | --- |
| Fresh approval after an uncertain action could repeat its effect. | An unresolved outcome now holds further actions requiring approval at that Company across APIs, MCP, conversations, accounts and Sessions. Reads and other Companies remain usable. Exact request matching alone cannot recognize equivalent business actions. `test/poppy-outcome-guard.test.ts` covers changes of parameters, channel and Session as well as pending-card races. |
| An uncertain receipt had no safe reconciliation path. | Only the authenticated User's page can record **I checked: it happened / did not happen**. The original uncertain receipt stays in the database; the checked outcome is recorded separately. The decision never resends the request. Linked terms cards resolve together, with atomic competing-decision handling and recovery after interrupted card updates. |
| Uncertain outcomes could be described as failed, dismissed or aged out. | The transcript says the outcome is unknown. Unresolved receipts remain available after an hour and cannot be dismissed. User-checked outcomes carry their provenance in the transcript and Activity. `test/ui/outcome-resolution.test.tsx` and the [actual browser journey](evidence/pr-36-conformance/README.md) exercise these states. |
| A 5xx or accepted asynchronous write could appear to have a known outcome. | Approved 5xx responses and OpenAPI 202 responses remain uncertain. A conversation approval acknowledgement confirms delivery rather than the Company's eventual action. None releases the hold merely because a response arrived. Existing recovery assertions retain the side-effect and no-resend checks. |
| MCP reused sessions/catalogues after same-account reauthentication or scope changes. | Its cache binding includes the durable authority generation and scope set. `test/mcp-session-isolation.test.ts` checks new initialization/catalogues and normal reuse. |
| Stale service metadata survived `invalid_token`. | A bounded, credential-free metadata refetch validates the challenge URI, Company issuer and allowed resource again. It can move between default and service-specific audiences, while MCP keeps its exact selected resource. `interop/test/resource-metadata-refresh.test.ts`. |
| Redirect safety relied on design and trace checks. | Actual HTTP 307 transport tests cover token, device, revocation, API, browser authorization, conversation, feedback and MCP endpoints. A sink receives neither credentials nor the POST body; successful direct controls still authenticate. `interop/test/authenticated-redirects.test.ts`. |
| A malformed protected-resource issuer escaped the discovery error boundary. | A generated `authorization_servers: ["0"]` case exposed an unchecked URL. The validator now retains its diagnostics and returns only an HTTPS-validated selected issuer, so discovery refuses it without fetching malformed metadata. Four fixed examples fail before the guard and pass with it; the property generator and oracle are unchanged. |
| Smaller protocol behaviors lacked direct assertions. | Tests now cover cross-domain discovery notices, unknown scope hints/fields, conflicting issuer aliases, author names and inert rendering, unknown conversation states, terminal Mediated Sign-In errors and unknown/unlisted task references. `interop/test/poppy-spec-edge-coverage.test.ts` and `test/ui/company-author-display.test.tsx`. |
| Missing scope hints and description precedence were implicit. | Missing hints use the Guides' conservative irreversible/personal-data default, without changing the Company's actual description. OpenAPI descriptions precede `auth.scopes`. Both are explicit local readings of upstream issues 30/31, with sign-in-card and model-facing tests. |
| Verification replies, alternatives and feedback privacy depended on model instructions. | Tool-boundary guards withhold recognizable credentials and explicit verification replies, request an authorization event, and reject recognizable personal identifiers in feedback. Exclusions and validated web alternatives are delivered directly to the User even if the model omits them. `test/poppy-model-policy.test.ts` and `interop/test/model-policy.test.ts`. |
| Verification filtering rewrote warnings and harmless replies, then repeated authorization requests. | Only a positive verification request and a proposed credential/contact reply trigger replacement. Warnings and ordinary task replies pass through. One stable authorization message per Company verification prompt prevents repeated requests while allowing a later prompt in the same conversation. The tool's decision and chosen prompt survive replay and restart without exposing withheld details, including when the first answer was lost. Worker tests check actual outgoing messages and request counts. |
| Ordinary numeric and UUID order identifiers looked like secrets. | Outbound messages use recognizable credential formats and named secret fields. The broader opaque-value filter remains on memory storage. Bare numbers are treated as verification replies only in verification context; task identifiers remain usable in text and structured data. Credential denial controls remain in place. |
| User attribution vanished when a reconciled receipt expired or was dismissed. | The transcript's Activity fallback keeps the User-attributed outcome. Page tests render both checked outcomes with no receipt present; the browser journey also ages the resolved receipt out and checks the original step after reload. |
| MCP lifecycle coverage lagged OpenAPI. | Revised terms, reentrant child decisions and interrupted-child recovery now run through both channels, alongside approve/decline, replay and withdrawal cases. `test/poppy-terms-lifecycle.test.ts`. |
| Security cells were skipped by the honest-only CI grid. | CI now runs the eight malicious-Company cases, the restored eight 0.3 malicious-agent cases and the code-exchange replay scenario as explicit own-project lanes. `--require-supported` makes a silently skipped security cell fail those runs. |
| Old replay attacks tested obsolete protocol behavior. | The 0.3 probes establish successful controls, mutate request binding/audience/keys/scopes/User ownership or approval data, and check actual effects. Fresh-jti controls isolate URL binding from optional replay policy. `NREP` also retries a consumed authorization code with fresh credentials. Same-URL JWT replay rejection and refresh-token rotation are not misrepresented as universal MUSTs. |
| Screenshots supplied card states rather than exercising the approval interaction. | Chromium now clicks both approvals over the actual WebSocket against the strict mock, verifies zero effects before terms approval and exactly one afterward, then reloads and checks the original transcript and Activity. It also verifies lost-answer recovery and a two-hour-old receipt. [Raw captures and receipt](evidence/pr-36-conformance/README.md). |
| Property replay selected objects by sorted random IDs. | Generated indices now select in creation order, retaining every object and command. Sorting opaque random IDs changed the selected binding between replays and made shrinking nondeterministic. Set-comparison assertions remain sorted; generators and safety assertions are preserved. |
| Private hosted settings could appear in preparation errors. | Invalid-origin and invalid-account tests reproduced echoed private values in assertion diagnostics. Preparation now prints only its supplied validation message; the hosted security smoke asserts malformed values never appear on stdout or stderr. |
| Independent verification and documentation had gone stale. | The Python client and pinned print-shop demo are rerun separately from the own-mock grid. Appendix A cites the new checks; the readings and changelog ledger describe their limits. Results are recorded with the evidence package. |

The initial nine adversarial PR findings and their regressions remain documented in [the earlier fix report](evidence/pr-36-audit/README.md).

## Separate hosted test pair

The [hosted test-pair setup](../test/hosted/README.md) uses separate Worker names and namespaces, the production PDA's real GitHub OAuth, a password-checked dummy Company, and no paid demo lane or payment integration. Generated settings and fresh secrets stay in ignored private files. Preparation defaults to a build and upload dry-run. Local workerd checks cover consent passwords, Origin/CSRF, single-use consent, strict OAuth exchange and protected evidence counters; CI runs those checks too.

Live deployment and authenticated verification remain pending the test account, OAuth application and User-supplied model credentials. No synthetic signed-in identity is published as an authentication shortcut.

## Limits that remain explicit

- **Live authenticated verification needs an allowlisted identity and a non-production Company.** This checkout has no live identity configured; the known live store takes real payments. Local browser and independent demo runs do not establish live OAuth or external payment behavior.
- **Language is not a closed schema.** Credential/contact guards cover recognizable forms. They cannot identify every personal statement, name or paraphrased verification request. The model is still instructed to keep feedback general and to use alternatives appropriately; tests establish the guarded consequences and direct User notices, not universal model obedience.
- **The hold is deliberately broad.** PDA cannot prove that two arbitrary API/MCP requests have different business effects, so an unresolved write pauses other actions requiring approval at that Company until the User checks. A User's recorded outcome is attributed to the User; it is not a newly verified Company response.
- **Own-mock agreement has limits.** The client and mock can share a misreading. Independent clients/Companies and negative controls reduce that risk without eliminating it. This report makes no percentage-conformance claim.

## Disposition of the existing upstream audit

The audit's issues stay open in the upstream text unless that text changes. Local mitigations below do not change the public wire format or make another Company enforce a rule it does not implement.

| Issue | PDA disposition |
| --- | --- |
| 1. Copied access tokens without the agent key | Send the required Session header and token proofs. Another Company's MCP server may ignore the header; PDA cannot enforce its verification. |
| 2. Delegations can impersonate known User IDs | Keep per-Company non-extractable keys and confidential opaque User IDs. Binding delegations to `sub` requires an upstream protocol change. |
| 3. Execution can repeat after revision expiry | Our mock retains performed outcomes and returns the original response. The upstream retention rule still needs correction for other Companies. |
| 4. Copied browser authorization can authorize another code | Our mock rejects reused Session JWT IDs. Mandatory body binding or replay rejection at another Company's endpoint requires an upstream change. |
| 5. Removed keys and cached delegations | Four-hour delegations bound exposure locally. The upstream cache/revocation contradiction remains. |
| 6. DPoP keys link Users across Companies | Already mitigated by separate keys per Company. |
| 7. Blind assertions lack an enforced maximum lifetime | PDA sends one-minute assertions; mocks enforce the chosen lifetime/replay policies. The upstream blind-signing rule remains incomplete. |
| 8. Blind-signing privacy overclaim | Hosted PDA does not use blind signing or claim that its servers cannot see the Companies it contacts. |
| 9. One User can get an entire agent revoked | Upstream identity/revocation policy problem; a client patch cannot change a Company's policy. |
| 10. Device links on shared provider hosts | Follow the specified host checks. A new issuer-path restriction could reject legitimate provider pages and is not silently introduced. |
| 11. `invalid_session` conflates recoveries | One bounded restart; old approvals do not move to the replacement Session. |
| 12. Signed-out approval cannot follow its conversation | Refuse stale approval and require fresh terms; the upstream ownership contradiction remains. |
| 13. The model can write an approval | Software owns approval attachment; Company/model text cannot supply the User's approval. |
| 14. Idempotency advice loops on Operations | Approved requests use the Operations extension's key handling; upstream Guides wording remains inconsistent. |
| 15. Stateless revision example omits ownership | Our stateful mock checks ownership explicitly. |
| 16. Another User can finish Mediated Sign-In | Random sign-in IDs and client matching mitigate exposure. Stronger public cross-User binding needs protocol context the grant does not carry. |
| 17. Domain settings with issuer-wide grants | Immutable task contexts prevent local drift; the shared issuer still lacks a standardized domain selector. |
| 18. Unrestricted alternative web links | Only HTTPS links without userinfo on listed Company hosts are retained. |
| 19. Walkthroughs show an earlier design | Follow the pinned normative text; upstream editorial correction remains. |
| 20. Incomplete secret list | Keep the broader set of tokens, assertions, proofs, sign-in and browser codes out of model/log output. |
| 21. Conversation ownership after account use | The mock's same-client/account interpretation is explicit and tested. |
| 22. Session header on excluded-task fetch | Public-document reading: credential-free GET, tested. |
| 23. SSE reconnect reuses stale JWTs | PDA creates fresh signed requests on reconnect rather than relying on automatic stale-header replay. |
| 24. Signed-out requests without a header | PDA always sends the header on resource requests; mock rejection is explicit. |
| 25. Clock skew and thumbprint hash | SHA-256 thumbprints and declared verification windows; upstream interoperability choices remain. |
| 26. A forgotten Session restarts silently | No reliable client detection exists without a Company signal. |
| 27. MCP servers may ignore the header | Send it and validate metadata; do not invent a missing capability signal. |
| 28. Signed-out-only Companies still need OAuth metadata | Follow the stated discovery requirements. |
| 29. Browser cookies can outlive access tokens | Local authority guards prevent reuse after withdrawal; cookie expiry at another Company is outside PDA's control. |
| 30. Scope descriptions and hints disagree | Use an explicit conservative missing-hint default while preserving descriptions. |
| 31. Scope description precedence | OpenAPI first, then `auth.scopes`, with tests and a documented reading. |
| 32. Author pictures can track readers | Render names as inert text; do not fetch remote author pictures. |
| 33. Direct Conversation parent error missing | Local rejection remains a documented `invalid_request` choice. |
| 34. RFC 10027 selection is not directly observable | Direct, then Device, then Mediated is testable; an external risk assessment is not a wire assertion. |
| 35. Guides allow closing conversations at sign-out | Preserve conversations as the normative specification requires. |
| 36. Invalid example operation ID | Parse the defined character set; the mock generates valid IDs. |
| 37. Refresh-token optionality wording | Preserve or replace stored refresh tokens according to the response. |
| 38. Bad or missing references | Upstream editorial correction; no runtime behavior invented. |
| 39. Smaller wording/example slips | Keep implementation tied to normative sections; preserve the audit's editorial findings. |
| 40. No marker for writes needing approval | Keep the initial local approval before Company terms. The two-card cost remains a deliberate safety choice. |
| 41. OpenAPI cannot identify the Poppy token scheme | Refuse clearly non-Poppy writes; two generic Bearer schemes remain indistinguishable without upstream markup. |
| 42. Browser code is used twice | Follow the detailed authorize-once, submit-once steps; the mock tracks both stages separately. |
| 43. Issuer need not advertise callback `iss` | Check callback `iss`; the validator warns when the metadata declaration is absent. |

Omitting `agent_id` for one agent, using ES256, and the hosted-system exception to blind signing are supported choices, not missing mandatory features.
