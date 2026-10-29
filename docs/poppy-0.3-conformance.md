# Poppy 0.3 conformance review

This review targets the [28 October 2026 snapshot](../spec/draft-0.3-retrieved-2026-10-28/README.md). It separates PDA's implementation and verification problems from the [43 issues in the upstream text](poppy-0.3-issues.md). A changelog disposition of **Done** records an implemented change; it does not certify every normative requirement or every deployment path.

## Local problems and their fixes

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
| MCP lifecycle coverage lagged OpenAPI. | Revised terms, reentrant child decisions and interrupted-child recovery now run through both channels, alongside approve/decline, replay and withdrawal cases. `test/poppy-terms-lifecycle.test.ts`. |
| Security cells were skipped by the honest-only CI grid. | CI now runs the eight malicious-Company cases, the restored eight 0.3 malicious-agent cases and the code-exchange replay scenario as explicit own-project lanes. `--require-supported` makes a silently skipped security cell fail those runs. |
| Old replay attacks tested obsolete protocol behavior. | The 0.3 probes establish successful controls, mutate request binding/audience/keys/scopes/User ownership or approval data, and check actual effects. Fresh-jti controls isolate URL binding from optional replay policy. `NREP` also retries a consumed authorization code with fresh credentials. Same-URL JWT replay rejection and refresh-token rotation are not misrepresented as universal MUSTs. |
| Screenshots supplied card states rather than exercising the approval interaction. | Chromium now clicks both approvals over the actual WebSocket against the strict mock, verifies zero effects before terms approval and exactly one afterward, then reloads and checks the original transcript and Activity. It also verifies lost-answer recovery and a two-hour-old receipt. [Raw captures and receipt](evidence/pr-36-conformance/README.md). |
| Property replay selected objects by sorted random IDs. | Generated indices now select in creation order, retaining every object and command. Sorting opaque random IDs changed the selected binding between replays and made shrinking nondeterministic. Set-comparison assertions remain sorted; generators and safety assertions are preserved. |
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
