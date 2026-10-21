# Poppy 0.2 upgrade: decisions and evidence

This change adds **dual 0.1/0.2 support**, targeting draft 0.2 at upstream commit `39b35bdf240fc07f157d6ca4e29b5a41d4b36b5d` (19 October 2026), Operations v1. Draft 0.2 is still in progress. It is not a stable published release or certification.

The ecosystem survey was completed before implementation. It changed the reuse decision: official schemas and a Company validator now exist, Datalayer has a 0.2 SDK and its own language matrix, and PDA's useful distinction is cross-project interoperability. See the [current map](ecosystem.md), including dated source links and retained historical evidence. We found no equivalent public cross-project M×N harness in the surveyed sources; that is not proof that none exists.

## Smallest safe steps

1. **Freeze evidence.** Preserve the 0.1 snapshots and peer pins. Import an unmodified, licensed 0.2 suite by commit; pin Operations and the official changelog too. Complete the official-change ledger before declaring support.
2. **Make version selection explicit.** Add a 0.2 validator overlay over the shared checks. Refuse unknown 0.x versions before metadata or credentials. Keep declared 0.1 behavior and the versionless validator default.
3. **Change only the affected client decisions.** Select discovery/domain comparison, assertion audience, device-link trust and MCP token mode by the declared version. Reuse crypto, safe transport, identity, token renewal, errors, sign-ins, conversations, approval cards and Operations.
4. **Protect state and consent.** Add immutable pending-work context; retain issuer-based identities and encryption contexts. Stop changed/ambiguous pending work for reconciliation. Add the model's Company task boundary and privacy disclosure.
5. **Validate independently.** Extend the existing harness, not a second runner. Keep 0.1 and 0.2 peer entries side by side. Run official Company checks separately from M×N cells; exercise independent SDK Companies and agents. Preserve failures and unsupported results.
6. **Release with evidence.** Update the changelog and map, run both lanes, then deploy to staging and exercise a test account and sandbox approval. Promote the Unreleased entry only after recording the deployed commit. See [upgrading and rollback](upgrading.md).

These are review and rollout boundaries, not permission for a new binary to guess a future version's meaning. No runtime rule is downloaded from upstream.

## Backward compatibility

Declared 0.1 Companies retain their profile, requested-domain normalization, token-endpoint Session audience, client-assertion fallback and Bearer MCP behavior. Unknown versions now fail closed: accidental acceptance of arbitrary 0.x was unsafe and is intentionally removed. Versionless client metadata keeps its 0.1 default unless a caller supplies a supported context.

The database migration adds `poppy_task_contexts`; it does not rewrite User IDs, sealed Account Tokens, account bindings, consent or existing record formats. An old binary can ignore this table. Old discovery cache entries are revalidated. New work keeps the Company domain, wire version, local specification revision and interface snapshot; resume compares the original context with current discovery. Legacy work resumes only with an unambiguous original domain and compatible context. Ambiguous work is not silently assigned the most recently discovered domain for an issuer.

Issuer changes never transfer credentials or approval. An interface/profile change holds work for reconciliation. An uncertain confirmation must be read back from the Company before retrying. Rolling back to the previous 0.1-only binary requires stopping 0.2 work first. Keep pending revocations and the existing signing/encryption keys.

## Reuse and future versions

The validator overlay reuses unchanged 0.1 rules; the client shares its transport and state machines. The SDK peers share one adapter and Dockerfile per language/role, parameterized by pinned source and wire version. The official validator is an unmodified independent one-sided check, provisioned through the same isolated Docker/proxy lifecycle; it contributes no M×N pass cells. Schemas are retained verbatim as upstream artifacts, not retyped into another local schema catalogue.

`npm run spec:import -- --source /path/to/upstream --commit <full-SHA> --version <major.minor> --revision <YYYY-MM-DD> --operations-version <version>` imports a new immutable directory from Git objects, refusing an existing directory. It leaves the active pin unchanged. Review the official changelog and actual text diff, update the ledger and affected profiles, then activate the pin in the same review. `npm run check:spec` verifies hashes, active revision and change-ledger coverage offline in CI. `npm run spec:drift` compares upstream without changing anything. Changing Operations under the same v1 label still requires a new snapshot and review.

Do not replace PDA's client wholesale with the current Datalayer SDK: it deliberately drops 0.1, while our compatibility goal retains it. Use it as an independent peer now; reconsider replacement once its lifecycle, storage, dual-version policy and Cloudflare constraints match ours. Reuse does not mean sharing production validators with the mock's oracle.

## Official changelog ledger

Every entry in the [pinned official changelog](../spec/draft-0.2-2026-10-19/pages/changelog.md) has a disposition below. The [machine-readable ledger](../spec/requirements-0.2.json) owns this generated table. Run `npm run spec:docs` after editing the ledger; CI checks the rendered table and official headings. This is change accounting, not a claim that every normative sentence has a dedicated automated test. “Company obligation” distinguishes requirements PDA does not implement as a deployed Company.

<!-- BEGIN GENERATED REQUIREMENT LEDGER -->
| Upstream change | Disposition | Implementation / evidence | Scope and limits |
| --- | --- | --- | --- |
| Breaking: HTTPS everywhere. | Shared + stricter profile | [code](../src/validator/primitives.ts), [evidence](../test/validator.test.ts) | Existing HTTPS checks cover endpoints; 0.2 treats all protocol URLs as a requirement. |
| Breaking: Versions before 1.0. | Changed | [code](../src/poppy/protocol-version.ts), [evidence](../test/poppy-0.2.test.ts) | Exact 0.1/0.2 dispatch; unsupported versions stop before issuer metadata. |
| Breaking: Redirects and addresses. | Shared | [code](../src/poppy/client.ts), [evidence](../test/prompt-injection.test.ts) | Manual redirects, URL/address safety and no credential forwarding; isolated interop hosts are an explicit test-only exception. |
| Breaking: Which domain `poppy.json` speaks for. | Changed | [code](../src/poppy/discovery.ts), [evidence](../test/poppy-0.2.test.ts) | Final serving host, case only; requested-host caches retain www. |
| Breaking: One issuer per Company. | Company obligation + shared | [code](../src/poppy/issuer.ts), [evidence](../test/properties/model.test.ts) | Exact full issuer keys User IDs and sealed Account Tokens. Client cannot verify whether an issuer represents one legal Company. |
| Which Company a document speaks for. | Shared | [code](../src/validator/profiles/draft-0.2.ts), [evidence](../test/validator.test.ts) | Mutual issuer/domain checks; RFC 8414 insertion for issuer paths. |
| Breaking: One `auth` per issuer. | Changed | [code](../src/poppy/client.ts), [evidence](../test/poppy-0.2.test.ts) | Compare auth fingerprints for currently cached domains sharing an issuer; cannot compare unseen domains. |
| Breaking: DPoP algorithms. | Changed | [code](../src/validator/profiles/draft-0.2.ts), [evidence](../test/poppy-0.2.test.ts) | Sign ES256; optional OAuth list must include ES256. |
| Breaking: `extension_required` responses. | Shared | [code](../src/poppy/client.ts), [evidence](../interop/runner/checks.ts) | Existing error/challenge handling; optional unknown extensions are not negotiated. |
| Breaking: Assertion audience. | Changed | [code](../src/poppy/client.ts), [evidence](../test/poppy-0.2.test.ts) | Issuer audience for both assertions in 0.2; endpoint fallback remains 0.1 only. |
| User IDs for anonymous browsing. | Optional deferred + privacy | [code](../src/privacy.ts), [evidence](../docs/upgrading.md) | Pairwise IDs remain private; anonymous sessions are not offered. |
| Breaking: Assertion lifetimes and replay. | Shared + Company obligation | [code](../src/poppy/jwt.ts), [evidence](../test/properties/jwt.test.ts) | Fresh random jti and 60-second assertions fit the five-minute maximum. Replay rejection belongs to Companies. |
| Breaking: A DPoP key per User ID. | Shared | [code](../src/poppy/client.ts), [evidence](../test/properties/model.test.ts) | DPoP key is per client/User and exact issuer; separate client instances never share it. |
| Breaking: DPoP Proof checks. | Company obligation | [code](../test/mock-company/core.ts), [evidence](../test/properties/jwt.test.ts) | Production PDA sends RFC 9449 proofs. The independent mock and trace checks exercise validation; not a production Company service. |
| Breaking: DPoP errors at APIs and conversations. | Shared + mock changed | [code](../test/mock-company/apis.ts), [evidence](../test/poppy-0.2.test.ts) | Nonce retry and error parsing reused; MCP mock preserves DPoP challenge/errors. |
| Which requests carry a DPoP Proof. | Shared | [code](../src/poppy/client.ts), [evidence](../test/poppy.test.ts) | Proof on token/resource requests; no proof required for revocation/device authorization. |
| Breaking: DPoP at MCP servers. | Changed | [code](../src/poppy/apis.ts), [evidence](../test/poppy-0.2.test.ts) | Select DPoP/Bearer from protected-resource metadata, bind resource and token type, send Bearer only to the exact listed URL. |
| `rate_limited` body. | Shared + Company obligation | [code](../src/poppy/client.ts), [evidence](../test/poppy.test.ts) | Existing Retry-After and rate-limit handling; protocol endpoints have the defined body, API bodies remain API-specific. |
| Breaking: A Session stays tied to its account. | Shared | [code](../src/poppy/client.ts), [evidence](../test/properties/model.test.ts) | Existing account_mismatch handling starts a new Session; no account switch within an existing Session. |
| Breaking: Device sign-in links. | Changed | [code](../src/poppy/signin.ts), [evidence](../test/ui/device-link.test.tsx) | 0.2 links use issuer host/poppy_domains or their subdomains; cards display Company name/domain. |
| Breaking: Mediated Sign-In responses. | Shared + mock changed | [code](../test/mock-company/auth.ts), [evidence](../test/poppy.test.ts) | Mediated statuses are parsed independently of transport success; 0.2 mock repeats terminal statuses and distinguishes unknown IDs. |
| Breaking: Mediated Sign-In credentials. | Shared | [code](../src/poppy/signin.ts), [evidence](../test/prompt-injection.test.ts) | Protected credential frames bypass the model and are not retained as a credential store. User must provide them again. |
| Breaking: Mediated Sign-In for the right Company. | Shared | [code](../src/poppy/signin.ts), [evidence](../test/poppy.test.ts) | Credential/code card binds to issuer and displays Company name/domain; no stored credential lookup is offered. |
| Work after a token expires. | Shared + Company obligation | [code](../src/poppy/client.ts), [evidence](../test/poppy.test.ts) | Token expiry renews access and does not erase accepted work. Company decides running-work policy after revocation. |
| Breaking: After sign-out. | Shared + mock changed | [code](../src/poppy/signout.ts), [evidence](../test/poppy.test.ts) | Stop local account use immediately, retain failed revocation work, require User sign-in; 0.2 mock protects account-bound Operations after sign-out. |
| Sessions from plain MCP clients. | Not a plain MCP client | [code](../src/poppy/apis.ts), [evidence](../docs/poppy-0.2-upgrade.md) | PDA uses Poppy User IDs and Sessions. Plain MCP client lifecycle is a Company obligation outside PDA role. |
| Conversation query parameters. | Shared + mock changed | [code](../test/mock-company/conversations.ts), [evidence](../test/poppy.test.ts) | Query parameters already used; 0.2 mock rejects fractional, negative or nonnumeric wait. |
| Breaking: Messages. | Mock changed | [code](../test/mock-company/conversations.ts), [evidence](../test/poppy.test.ts) | Keep accepted context-only messages and original message fields; Company sets role. |
| Long polling. | Shared | [code](../test/mock-company/conversations.ts), [evidence](../test/poppy.test.ts) | Cap long polls by waiting for cap; PDA reads again when send has no reply. |
| Breaking: Read fields. | Shared + diagnostics changed | [code](../interop/runner/checks.ts), [evidence](../test/poppy.test.ts) | Required read fields are checked, including conversation_id in 0.2; unknown event types remain skippable. |
| Streaming. | Shared | [code](../test/mock-company/conversations.ts), [evidence](../test/poppy.test.ts) | Last-Event-ID wins over cursor; trace and SDK tests exercise reconnects. |
| Repeated requests. | Shared | [code](../test/mock-company/conversations.ts), [evidence](../test/poppy.test.ts) | Repeated handoff/close preserve state without duplicating effects. |
| `user_requested`. | Shared | [code](../src/poppy/conversations.ts), [evidence](../test/poppy.test.ts) | A user_requested event offers a card; does not change responder/status or authorize User words. |
| Conversation errors. | Shared + Company obligation | [code](../src/poppy/client.ts), [evidence](../test/poppy.test.ts) | Existing invalid_request/rate_limited parsing; mock implements invalid wait errors. |
| Feedback. | Optional deferred | [code](../src/validator/profiles/draft-0.2.ts), [evidence](../test/validator.test.ts) | Validate feedback discovery and require auth, but do not send reports automatically; privacy UX is separate. |
| Breaking: Security considerations. | Changed | [code](../src/poppy/task-scope.ts), [evidence](../test/prompt-injection.test.ts) | Task Company boundary plus existing secret/approval boundaries; Company/tool content cannot add another domain. |
| Browser assertion audience. | Shared | [code](../src/poppy/browser.ts), [evidence](../test/poppy.test.ts) | Browser assertion keeps its endpoint audience and distinct typ; issuer rule applies to OAuth assertions only. |
| `extension_required` in conversations and Operations. | Shared + Company obligation | [code](../src/poppy/client.ts), [evidence](../interop/runner/checks.ts) | API/MCP/protocol error channels remain distinct; no per-tool extension negotiation is invented. |
| Breaking: Operations after sign-out. | Mock changed | [code](../test/mock-company/operations.ts), [evidence](../test/poppy-0.2.test.ts) | Account-owned operation requires current sign-in to the same account. Client never manufactures approval. |
| Operations. | Shared | [code](../src/poppy/operations.ts), [evidence](../test/poppy-0.2.test.ts) | Operation card includes terms and exact revision; only approved revision can confirm. |
| Examples. | Shared | [code](../src/poppy/jwt.ts), [evidence](../test/poppy.test.ts) | Random proof IDs, idempotent message/confirmation machinery and API write approval reused. |
| Guides. | Shared + Company obligation | [code](../src/poppy/signin.ts), [evidence](../test/poppy.test.ts) | ES256 and issuer audiences; protected credentials discarded. Company replay/reconnect challenges remain Company duties. |
| Guides: key refetches, rate limits, and running work. | Company guidance | [code](../test/mock-company/core.ts), [evidence](../docs/poppy-0.2-upgrade.md) | Company key refetch/rate-limit/running-work rules are not a Personal Agent feature. Mock checks do not certify deployed Companies. |
| Guides: hosting several companies. | Shared | [code](../src/poppy/issuer.ts), [evidence](../test/properties/model.test.ts) | Full issuer paths are distinct; exact issuer scopes identities and tokens. |
| Guides: conversations after sign-out. | Shared + Company obligation | [code](../src/poppy/conversations.ts), [evidence](../test/poppy.test.ts) | Client preserves conversations; sign_in_required asks User to sign in rather than silently doing so. |
| Guides: user ID privacy. | Privacy changed; optional deferred | [code](../src/privacy.ts), [evidence](../docs/upgrading.md) | Explain signed-out recognition and account linking; no anonymous mode claim. |
| Guides: finding a company. | Changed | [code](../src/poppy/client.ts), [evidence](../test/poppy-0.2.test.ts) | Discovery redirect to another domain produces a notice before sign-in/acting. |
| Guides: matching the spec. | Shared | [code](../src/poppy/client.ts), [evidence](../test/prompt-injection.test.ts) | ES256, manual redirect refusal, protected credentials, and signed-out ordinary browsing retained. |
<!-- END GENERATED REQUIREMENT LEDGER -->

## Old readings

The [0.1 issue catalogue](spec-issues.md) and [readings](readings.md) are historical, with stable IDs. They remain valid input for the 0.1 lane. In 0.2:

| Old finding | Treatment |
| --- | --- |
| S1 assertion audience | Superseded by exact issuer audience. No endpoint-audience reading exemption. |
| S2 assertion lifetime | Superseded by five-minute maximum. PDA's one-minute assertions remain valid. |
| S3 issuer path metadata | RFC 8414 insertion is explicit; legacy fallback is retained only where existing discovery uses it. |
| N9 HTTPS, N11 shared issuer, N15 prompt injection, N17 MCP token selection | Explicit new rules replace the old gaps. See the ledger for implementation and limits. |
| DPoP replay/algorithm readings | Token endpoint replay and ES256 requirements are explicit; API replay rejection is optional. Do not apply 0.1 mock readings as 0.2 MUSTs. |
| Other S/N findings | Not blanket-closed by this upgrade. Re-evaluate against the pinned text before reporting a current upstream issue. Original dates and reproductions stay intact. |

Known-failure entries without a version are scoped to 0.1. They cannot exempt a 0.2 failure. Retried cells retain protocol context. Version-specific trace checks avoid treating old readings as new requirements.

## Validation

Integrated main `93777e3` (PR #12): keep its issuer-scoped conversation handles, durable cancellation/approval checks, paused generic standing approvals, per-login revocation, input provenance, validator limits and durable budget settlement. These are not replaced by the version upgrade.

Results are local and isolated; no production deployment or real purchase is claimed. [Committed result summary](interop-results/2026-10-21-poppy-0.2.json) records each cell and official check without tokens or full traffic. Raw JSON, HAR, HTML and container logs remain in the gitignored artifact directories named there. Runs used the working tree before commit; they are not checks of a deployed release.

| Check | Result |
| --- | --- |
| Complete eligible PDA × own mocks, both 0.1 lanes and 0.2 | **102 pass, 0 fail, 54 unsupported, 0 error; no warnings**. Each mock entry has 34 passes. Includes eligible fault/adversarial scenarios against our own code. |
| 0.2 ordinary cross-project 3×3 grid, 30 scenarios | **211 pass, 7 fail, 52 unsupported, 0 error**; no failing trace checks, two nonce warnings from SDK device polling. PDA: **74 pass, 0 fail**, 16 unsupported, repeated as a separate column after the final MCP account-cache fix. Unsupported is not a pass. |
| Pinned official Company validator × 0.2 mock | **69 pass, 0 fail, 0 warn, 5 skip**. No automated sign-in or Operations checks in this revision. Kept outside M×N totals. |
| Full local suite | **1,747 pass, 1 skip, 0 fail** across all five projects. Includes main PR #12's security and durable budget fixes plus account-bound MCP lifecycle checks. Legacy ledger retention uses the injected clock; production charges remain on their admission day. The template inventory excludes documentation artifacts. Initial failing evidence remains recorded in the result summary. |
| Final focused checks | The full suite includes migration, MCP lifecycle, budget retention, snapshot parser and harness-policy regressions. The targeted clock/race and MCP account-isolation regressions also fail when their fixes are reverted. |
| Python Hypothesis | **16 pass**, including generated state-machine journeys. |
| Type checking, production build and browser smoke | Pass. Real local Chromium/workerd verifies chat, reload, mobile navigation, logout and revoked-session recovery with no uncaught browser errors; synthetic model and identity. Existing bundle-size warning remains. |
| Snapshot/ledger/import/drift | 56 upstream hashes and 48 official-change dispositions verified; importing from the pinned Git objects reproduces all hashes; no drift detected in upstream main, including the pinned Company validator. |
| Retained Datalayer 0.1 vectors | 23 pass, 3 reading/policy differences, 98 not applicable; zero `our-bug` failures. Differences: intentional unknown-0.x refusal, extension-name syntax, non-JSON metadata diagnostic. These are separate from M×N totals. |

The seven cross-project failures remain visible and are not added to known-failure exemptions. TypeScript SDK SSE reconnects return `stream_unavailable` after empty short streams (three cells). Both SDKs reject the mock's valid handoff/close responses without `conversation_id` (four cells); the pinned spec requires `status` and `responder` there and the official validator accepts these responses. These are compatibility findings requiring peer/adapter review, not evidence that an entire SDK is nonconformant. No finding was posted to another project.

An exploratory run requested all adversarial scenarios across foreign peers; the harness refused those cells under the own-project policy. It is not the ordinary 3×3 result above and contributes no conformance passes. Later combined ordinary and self-owned lanes are the evidence used here. Transient local disk failures were resolved by removing obsolete images and unused build caches created by this task; the successful reruns are recorded above.

## Remaining feature choices

Feedback submission and anonymous browsing are optional features and remain deferred. Discovery accepts valid feedback configuration; PDA never sends a report automatically. User IDs remain stable per issuer, with signed-out recognition and account linking explained in the privacy policy. The Company task boundary is conservative: after untrusted content, a new Company must have been named by domain in the User's own task. Scheduled tasks and resumed history do not acquire authority from Company text.

PDA is not a production Company server or a general plain-MCP client. The official kit does not automate sign-in or Operations in this revision. Passing its available checks does not fill those gaps. A live staging journey and deployment review remain release gates.
