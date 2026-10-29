# Company kit review, 29 October 2026

The [pinned official kit](../spec/company-kit-2026-10-29/README.md) now checks our two mock profiles, a strict Bearer profile and the isolated hosted Company's handlers. Its CLI and 79 source files are unmodified. This is independent Company-side verification; it does not directly certify PDA's Personal Agent implementation.

## Reproduce

With Node 24, OpenSSL and the project's installed dependencies:

```sh
node scripts/check-company-kit.mjs --output /tmp/company-kit.json
node scripts/check-company-kit.mjs --reviewed-findings --output /tmp/company-kit-reviewed.json
```

The runner creates a fresh upstream test identity, serves its metadata and keys over local HTTPS, and uses workerd for both Company implementations. It provisions the generated public client ID at the hosted Company's existing allowlisted `/poppy/client.json` URL. It changes neither that allowlist nor the validator. Certificates and hostnames are verified; only declared fixture hosts can reach the loopback TLS server. The kit's explicit `--allow-private-addresses` setting permits this local topology. Temporary keys and Company secrets are removed after the run.

The hosted Company has no conversations or website browser join, so its run uses the signed-out `GET /products` as the Session probe. Both mock profiles offer their normal interfaces plus feedback, with the mock's deliberately unknown document fields disabled. The additional strict Bearer profile uses the supported `dpopTokens: false` setting; the DPoP profiles retain their proof requirements.

## Results

Raw upstream verdicts are preserved in [the receipt](evidence/pr-36-company-kit/results.json). Each run reports all 120 catalogue entries.

| Company profile | Pass | Fail | Inconclusive warnings | Skip |
| --- | ---: | ---: | ---: | ---: |
| Lenient mock, DPoP required | 111 | 1 | 7 | 1 |
| Strict mock, DPoP required | 111 | 1 | 7 | 1 |
| Strict mock, Bearer | 119 | 0 | 0 | 1 |
| Hosted dummy Company in local workerd | 55 | 0 | 7 | 58 |

The mock's one skip is feedback alternative references: its response is the valid empty 202 acceptance, so there is no alternative to inspect. The hosted skips correspond to absent features, including conversations, feedback, Mediated/Device Sign-In and browser join. They are listed by ID in [the reviewed findings](../test/company-kit/reviewed-findings.json), and retain their upstream reasons in the receipt. They are not counted as passes.

### DPoP prerequisite disagreement

The kit's client-assertion probes send a token request without a DPoP proof, even when the issuer advertises `dpop_signing_alg_values_supported`. Our Company refuses it with `invalid_dpop_proof`, as the [pinned specification's token rules](../spec/draft-0.3-retrieved-2026-10-28/pages/0.3-spec.md#45-access-tokens) require the Personal Agent to send a proof in that case. The kit marks seven assertion checks inconclusive. Its unknown Mediated Sign-In ID probe has the same omission, but records a failure instead of an inconclusive result on the two mocks.

We have retained those verdicts. The strict Bearer profile passes all eight corresponding checks, including PS384, issuer audience, signature, expiry and replay controls. The ordinary DPoP paths remain covered by the Worker, hosted security and interop tests. The native kit cannot yet distinguish its malformed precondition from those later token checks on a DPoP-required issuer.

`--reviewed-findings` compares exact finding IDs, profile, status and prerequisite error. It also requires all eight accepted Bearer controls and the exact absent-feature skips. It fails on a new finding, a disappeared finding or a failed control. It does not relabel the raw failures or warnings as passes. CI retains the receipt as an artifact. No feedback was sent to the protocol maintainers.

### Separately patched DPoP run

`node scripts/check-company-kit.mjs --with-dpop --reviewed-findings --output /tmp/company-kit-dpop.json` verifies the original archive and all 79 files, then applies [a small token-probe patch](../test/company-kit/dpop-probes.patch) to a temporary copy. The original pin and raw verdicts above remain unchanged. A zero-context patch is applied only after the exact source hashes pass.

The copy uses the kit's own WebCrypto signer, an independent ephemeral P-256 DPoP key and fresh request-bound proofs. A separate valid assertion learns the nonce before each assertion probe, so nonce negotiation cannot consume the assertion under test. Retry proofs are fresh; the expected assertion verdicts are unmodified.

| Profile | Pass | Fail | Warnings | Skip |
| --- | ---: | ---: | ---: | ---: |
| Lenient mock, DPoP required | 119 | 0 | 0 | 1 |
| Strict mock, DPoP required | 119 | 0 | 0 | 1 |
| Strict mock, Bearer | 119 | 0 | 0 | 1 |
| Hosted handlers, local workerd | 62 | 0 | 0 | 58 |

An additional six controls on each DPoP profile use the unmodified upstream signer: valid, missing proof, bad signature, wrong method, wrong URL, then valid again. All 18 reach their intended errors (`invalid_grant` for a valid proof and nonexistent refresh token; `invalid_dpop_proof` for denials). No PDA JWT implementation is imported. The kit still performs zero Company actions and verifies no live sign-in.

[Fresh raw/patched receipts, controls and a prepared upstream report](evidence/pr-36-interop-completion/README.md). Nothing was posted upstream; the report and patch are ready for review.

### Changes the kit prompted

1. The mock removed `context` when echoing a message into event history. This also made context-only message events invalid. It now retains the message as sent, with only the Company-assigned `role` added.
2. A query credential was refused as `invalid_token`, which looked like token validation. The Company now refuses the forbidden transport as `invalid_request`, independently of whether the value is issued or invented.
3. MCP answered unidentified clients with a missing-Session error, preventing ordinary OAuth metadata discovery. It now returns an unauthenticated challenge with `resource_metadata`, without creating a Session or performing an action. An issued Poppy token still requires its Session header.

Three Worker regressions fail against `c98ebf64f8209cf651a855c714fdd4874e0f546f` and pass with these changes. The kit also supplies the independent before/after counterexamples. The comparison is behavioral; no UI markup changed in this follow-up.

## Manual checklist review

We reviewed all 229 checkbox entries across the kit's 52 source groups below. The [upstream checklist](../spec/company-kit-2026-10-29/kit/checklist.md) remains unchanged. A group appearing here means its scope and evidence were reviewed; it does not mark every item in that group as passed. Compound and incomplete generated quotations need their surrounding pinned specification text.

Evidence abbreviations:

- **Kit:** the raw independent results above. Signed-out checks only, except token-error probes that require no account sign-in.
- **Mock:** [hand-made Worker requests and tamper controls](../test/mock-company.test.ts), plus the [shared handlers](../test/mock-company/). These exercise fixture behavior, not a production Company's operations.
- **Hosted:** [password/CSRF, OAuth, PKCE, DPoP and action checks](../test/hosted/company-security.node.mjs) and [the actual hosted handlers](../test/hosted/company.ts), run locally in workerd.
- **Lifecycle:** [API/MCP approval and recovery tests](../test/poppy-terms-lifecycle.test.ts), [unknown-outcome tests](../test/poppy-outcome-guard.test.ts), independent Python and Docker evidence linked in the conformance report.

| Source lines; entries | Scope and local evidence | Remaining manual limit or disposition |
| --- | --- | --- |
| 13–19; 4 | Discovery: Kit validates HTTPS documents and Mock/Hosted serve them at their domains. Local private addressing is explicitly configured. | Live TLS, DNS and Company metadata-fetch safeguards remain open. |
| 20–25; 3 | Fields: Kit validates the serving domain and issuer selection on the mock's two storefronts. | Hosted has one storefront; the other-domain comparison is inapplicable there. |
| 26–40; 12 | OAuth metadata: Kit checks issuer, protected resources, required grants and endpoints. | A shared production provider and several tenants are outside the hosted pair. |
| 41–45; 2 | Agent identity: Bearer controls exercise ES256/PS384 and reject endpoint audiences; Mock supplies direct negative controls. | DPoP-required kit token probes remain inconclusive as explained above. |
| 46–51; 3 | Delegated keys: Kit exercises replacement keys, PS384 delegations and missing/invalid delegations. | External key distribution and blind-signing deployments are not exercised. |
| 52–58; 4 | Session verification: Kit and Mock check identity, account, `ath`, claims and missing-header rejection. | No live multi-server Session store is verified. |
| 59–63; 2 | Request credentials: Kit passes cookie-free resource requests and query-token refusal; regression covers both issued and invented values. | Captured local traffic does not audit an external Company's logs. |
| 64–77; 3 | Secrets: Mock redacts recorded headers; Hosted exposes only protected counters; token/code responses use no-store. | Dummy credentials and codes exist in fixture memory. No production retention or telemetry audit is claimed. |
| 78–89; 7 | JWT recommendations: Kit/Mock cover algorithm, signature, audience, lifetime and replay denial. | Deployer key custody and operational rotation remain unverified. |
| 90–98; 6 | Key rotation: delegated-key replacement passes Kit; JWT roots have IDs. | Mock client/JWKS caching has no bounded expiry or unknown-key refetch policy. Open for production reuse. |
| 99–108; 5 | Metadata fetching: source review confirms HTTPS, credential-free requests and no redirects. Local runner confines all destinations. | Shared Company handlers lack a production response-size/timeout/address-pinning/cache policy. |
| 109–116; 5 | Rate limits: Mock can inject 429 responses; PDA retry behavior has direct tests. | Company per-network/client/User/Session quotas and rate-limit headers are not implemented as production controls. |
| 117–123; 4 | Transport/JSON: local TLS verifies the certificate/hostname; generated events use RFC 3339 and tolerate unknown fields. | Duplicate JSON members use ordinary parsing in these Company fixtures; production TLS policy remains unchecked. |
| 124–130; 4 | Agent verification: Kit/Mock exercise identity fetch and malformed credentials; Hosted rejects unlisted clients before fetching. | Metadata/JWKS cache expiry and session-creation quotas remain open. No vendor authorization server is integrated. |
| 131–146; 11 | Session recommendations: one shared verifier, complete-delegation cache key and common ownership checks are present; Kit covers failure responses. | Cache limits/replication and real staff tools are not verified. DPoP-required controls stay enabled. |
| 147–156; 5 | Sessions: Mock tests stable identity, account changes, ended Sessions and key replacement; Hosted uses those handlers. | State is ephemeral. Ended-Session retention and restart durability are production gaps. |
| 157–162; 3 | Internal services: fixture handlers receive verified context in-process. | No gateway, service credential or downstream trust boundary exists to review. Inapplicable to this pair. |
| 163–171; 6 | Multi-Company hosting: Mock separates Companies and issuers; cross-Company tests cover token and cache isolation. | Hosted has one Company. A production shared-provider deployment is not verified. |
| 172–180; 2 | Agent-specific issuer policy: advertised scope lists and configured registration are explicit. | Per-client business scope policy is fixture configuration, not a vendor integration. |
| 181–195; 12 | Browser join: Kit and Mock cover cookies, one-time codes, cross-browser pairing, expiry and Session binding. | Hosted deliberately offers no browser join. Real website expiry and sign-out remain unverified. |
| 196–202; 4 | APIs: Kit checks descriptions and MCP metadata; Mock tests exact token resources and scope enforcement. | Unidentified MCP clients receive a challenge only. No generic non-Poppy OAuth sign-in is implemented by this fixture. |
| 203–207; 2 | Conversation ownership/IDs: Kit and Mock test cross-User/account denial and opaque valid IDs. | Hosted does not offer conversations. |
| 208–211; 1 | Message content: Kit passes text/data/context and extension handling; new regression preserves context-only messages. | Hosted does not offer conversations. |
| 212–215; 1 | Event reads: Kit checks event schemas, required fields and cursors. | Long-term event retention is not proven by an in-memory fixture. |
| 216–220; 2 | Status/author: Kit and Mock verify response states and Company author types. | No real staff identity or support-platform adapter exists. |
| 221–224; 1 | Direct Conversations: Mock checks parent ownership and nested/closed-parent refusal. | Kit does not complete a human conversation; Hosted does not offer the feature. |
| 225–229; 2 | Alternatives: Kit validates excluded-task references; PDA tests filter unlisted interfaces/hosts. | The mock's empty feedback acceptance supplies no alternative for that separate kit check. |
| 230–234; 2 | Feedback: Kit accepts signed-out reports only with a Session; source stores reports as data. | No model consumes the mock's feedback. Hosted offers no feedback endpoint. |
| 235–243; 6 | Retries: Mock and Lifecycle check message/API idempotency and request binding; PDA tests fresh proofs and backoff. | Company idempotency records are ephemeral; production retention remains open. |
| 244–250; 2 | API descriptions: manually reviewed mock product/order descriptions and schemas; Kit checks published documents. | No real business API catalogue or model task-success evaluation is claimed. |
| 251–262; 9 | Browser recommendations: Kit and Mock cover join headers, cookies and single-use records. | Production cookie lifetime, logging and storage operations are unverified; Hosted has no browser join. |
| 263–275; 10 | Conversation recommendations: scripted mock emits authorization/state events and supports stream/handoff test hooks. | No phone-parity claim, real staff workflow or 30-day event retention. Scripted behavior is not model evidence. |
| 276–284; 6 | Exclusions/feedback: mock publishes task-shaped exclusions and caches them; Kit validates their documents. | Real customer alternatives, task policy and feedback processing need a Company owner. Hosted omits these features. |
| 285–291; 2 | Error wording: Mock ownership tests return the same not-found response; fixture descriptions are synthetic. | No audit of another system's errors or operational telemetry. |
| 292–295; 1 | Direct Sign-In: Mock/Hosted verify exact redirect URI, client identity, code, PKCE and callback issuer. | A real hosted User journey remains pending deployment inputs. |
| 296–300; 2 | Device Sign-In: Mock tests that GET does not consent and that approval/polling is separate. | No real device phishing-risk assessment. Hosted offers Direct only. |
| 301–306; 3 | Scopes: Kit checks descriptions/hints; Mock/Hosted refuse unrequested or unavailable scope grants. | This does not assess a real business's scope model. |
| 307–310; 1 | Mediated transition: hosted pair omits Mediated Sign-In. Mock offers all flows to exercise clients. | The mock intentionally departs from the transitional SHOULD as a test fixture. |
| 311–315; 2 | Mediated fields: Mock tamper tests cover reserved names and scope overgranting. | Hosted offers no Mediated Sign-In; Kit's unknown-ID case needs its missing DPoP prerequisite. |
| 316–324; 6 | Lifetimes/sign-out: Mock/Hosted exercise expiry, rotation, revocation and scope withdrawal. | No password-reset system, production unused-token expiry job or downstream payment worker exists. |
| 325–335; 6 | Scope wording: reviewed dummy order/address scope descriptions and hints; PDA tests use conservative defaults. | Real irreversible-action classification needs the Company's business context. |
| 336–349; 9 | Consent: Hosted verifies password, Origin/CSRF, single use, PKCE and frame protection. | Page still uses raw scope names and lacks account/lifetime, agent branding, new-scope and consequence explanations. PAR is not implemented. |
| 350–357; 5 | Device recommendations: Mock covers interval, pending/denial, expiry and explicit approval. | Real code-matching UI, abuse quotas and risk assessment are not implemented; Hosted has no Device flow. |
| 358–367; 5 | Mediated recommendations: Mock tests unknown account/wrong-password equivalence and one-time-code outcomes. | Production attempt quotas, unusual-sign-in policy, notifications and credential storage are outside this fixture. |
| 368–372; 2 | Account settings: token revocation is exercised locally. | There is no Company UI listing/disconnecting connected agents. PDA's own Settings is a different scope. |
| 373–382; 5 | Scope enforcement: Mock/Hosted authorize API/MCP calls in software; Mock also checks conversations/websites. | No real human support tools exist. Hosted omits conversations/websites. |
| 383–387; 2 | Extensions: Kit checks advertised schemas; Mock ignores unknown fields/extensions while testing required ones. | Unknown-extension adversarial fixtures remain deliberate negative cases. |
| 388–391; 1 | Operations advertising: Kit and Mock check no operation is returned to an agent that omits version 2. | Full approved-operation execution is not tested by the signed-out kit. |
| 392–400; 6 | Operation objects: Mock and Lifecycle cover terms, revised terms, expiry and no effect before approval. | Business completeness of arbitrary summaries is not machine-verifiable. Dummy order terms are the reviewed scope. |
| 401–409; 6 | Approval verification: Mock/Lifecycle cover request/account/revision binding, reentrant decisions and repeat responses. | Deployed multi-server races and external processors are unverified. |
| 410–415; 3 | At-most-once: local replay, interruption and effect-count tests preserve uncertain outcomes and no resend. | Company records disappear on restart; hosted evidence rejects instance changes. Production durability remains open. |
| 416–430; 11 | Operations recommendations: reviewed dummy summaries, request fingerprints, approval records and retention in shared handlers. | No downstream service, real pre-approval rules or production approval audit store exists. |

## Open before production Company reuse

The kit is useful precisely because it does not turn our fixtures into a production Company. The review leaves these concrete obligations open:

- Durable Session, conversation, token, idempotency and performed-operation storage, with retention and restart behavior that preserve ownership and at-most-once effects. Hosted instance-change rejection protects the smoke evidence, not business durability.
- Bounded Company metadata fetching, SSRF defenses at connection time, bounded cache expiry and unknown-key refetch throttling.
- Real per-network/client/User/Session abuse controls, duplicate-member JSON handling and operational secret/logging review.
- Complete consent wording, Company account settings, and real Direct/Device/Mediated sign-in checks for the flows a deployment actually offers. The hosted consent's raw scopes are a documented usability gap.
- Human support, downstream service authorization and downstream idempotency, if a future Company connects those systems. They are absent from the current pair.
- A deployed non-production journey with real GitHub OAuth and the User's model key. The missing setup inputs in [the hosted instructions](../test/hosted/README.md#missing-inputs) still apply.

The upstream validator's DPoP prerequisite disagreement remains recorded locally. Resolving it upstream requires the maintainer to review a report; no external issue or message was sent.
