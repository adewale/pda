# Poppy 0.4: the upgrade

PDA speaks 0.3. The 0.4 draft is pinned beside it, from the [10 November 2026 snapshot](../spec/draft-0.4-retrieved-2026-11-10/README.md) and the [official kit](../spec/company-kit-2026-11-10/README.md) retrieved the same day, both at upstream commit `a2f16ec`. Nothing speaks 0.4 at runtime until step P1 below. [Decision 43](decisions.md#43-03-beside-04-both-versions-website-operations-and-approvals-across-sessions) records the choices this plan follows: support both versions, start on this draft, adopt website operations, bind approvals to the agent, User ID and account rather than one Session, and require an exact `resource` in protected resource metadata on both the derived and the challenge path.

The 10 November pin replaced the 9 November one (`b2569c5`) a day later. Upstream had added four changelog entries: Operations version 3 with agent approvals and required `terms`, the Browser Control extension, and the Session header on website pages fetched without a browser. Decision 43 expected Operations to stay at version 2 in both protocol versions. Under 0.4 it is now version 3, and 0.3 keeps version 2 (O3).

0.3 is frozen, so its pin, ledger and kit stay as they are. 0.4 will get newer snapshots. Each one gets its own dated directory, a review of the changelog and the diff against this pin, and an updated [ledger](../spec/requirements-0.4.json); work items below then move with it. [upgrading.md](upgrading.md) has the procedure.

## How the kit grounds the work

The kit is written for Companies, so it checks our mock Company directly and our agent indirectly. We use it three ways:

1. **The mock, milestone by milestone.** `node scripts/check-company-kit.mjs --protocol 0.4 --output <file>` runs the pinned, unmodified kit CLI against the mock over local HTTPS, with the mock declaring 0.4. Each mock item below names the catalogue checks it should turn from skip or fail to pass. When the mock passes a milestone, its expected findings go in `test/company-kit/reviewed-findings-0.4.json`, and CI runs that milestone with `--reviewed-findings`, as it does for 0.3.
2. **What the agent sends.** The kit's `schemas/` describe requests from a Personal Agent: conversation requests and messages, the Session JWT, the delegation, client metadata, approvals, feedback reports and the browser-session authorization. Tests that capture the agent's requests at the mock check their bodies against these schemas with the kit's own dependency-free `validate/schema.ts`, so neither our mock nor our validator judges our agent alone.
3. **Our validator against theirs.** The kit's `check --file <poppy.json>` checks a document offline. The validator's 0.4 profile (F7) is compared with it on the same fixtures; where they disagree, the pinned text decides and the reading goes in [readings.md](readings.md).

The kit can't check sign-in beyond an unknown `sign_in_id`, and it checks website operations and the Session header on fetched website pages not at all; those keep our own mock checks and interop.

**Baseline, 9 and 10 November.** Before any 0.4 work, both 0.4 kits stop at `discovery.schema` on all four mock profiles: 11 checks pass, 1 fails and 120 are skipped. The mock lists each extension as an object, and 0.4 lists the versions it serves (3.3). The mock performed nothing (`companyEffects` 0). F1 and M1 are the first items that move this.

## Order of work

Each item that changes the agent ships with the mock behaviour it needs, a stable id in `test/mock-company/violations.ts` with a negative `TAMPERS` case, and tests that fail when the change is reverted. "0.4 only" means the 0.3 profile keeps 0.3's rule.

**Layer 0.**
- **H1. DPoP keys by issuer and User ID** (4.5). Today the key cache is keyed by issuer, which gives one key per User ID only because each issuer has one stored User ID. Valid 0.3; ships first. Test: the same issuer and User ID give the same key, another issuer or a changed User ID a new one.

**Layer 1.**
- **H2. Exact protected resource metadata** (4.5; RFC 9728 3.3). Use metadata only when its `resource` is exactly the identifier it was fetched for, both at the derived URL and at a `resource_metadata` URL from a challenge (decision 43). The MCP transport's fallback to the root `/.well-known/oauth-protected-resource` follows the same rule. Valid 0.3. Tests cover a parent resource, a difference in case or trailing slash, a query, that no token request names the wrong resource, and a negative interop fixture.
- **V0. The schema oracle.** Done. The mock keeps what the agent sent, decoded: JSON bodies, Session JWTs and delegations, `Poppy-Approval` and the client metadata, but no form bodies. After every test, [test/kit-schemas.ts](../test/kit-schemas.ts) checks them with the pinned kit's unmodified `validate/schema.ts` and `schemas/`, beside the violation check in `agent-helpers`. [test/kit-schemas.test.ts](../test/kit-schemas.test.ts) shows that each schema is applied and that a broken payload is refused. It reads the 0.3 kit and gains the 0.4 kit at F2, when a Session's version decides which schemas apply.

**Layer 2.**
- **S3. Readings.** Record what 0.4 settles and what it leaves open: the retry rule after `version_unsupported` (3.4), `web.disabled` as a SHOULD NOT that covers browsers only (6), whether the fetch browser, an HTTP client that runs no scripts but does browser join, is a browser or the agent's own HTTP client on a website without `browser_session_endpoint` (5.2, 5.6), and whether it submits forms on a `web.disabled` website (local policy), whether to continue a conversation in a new Session after a version change, which is local policy (8.2), and how `as_of_request` is read (8.4).

**Layer 3.**
- **F1. Versions and discovery** (3.3, 3.4). Read `supported_versions` and each extension's version list; choose the newest version both sides speak; never fall back to a version the Company doesn't list. Kit: `discovery.schema`, `discovery.protocol-version`, `discovery.supported-versions`, `discovery.versions-same-company`.
- **F4. Error codes.** `version_unsupported`, `version_mismatch` and `request_id_conflict` in the wire types and client errors.
- **F7. The validator's 0.4 profile**, compared with the kit's `--file` (above).
- **K1. Mock sign-in** (Company obligations). Refresh with `auth.disabled` answers `invalid_grant`; Sessions are found by client_id, `sid` and User ID; a delegated key reused for another User ID is refused.
- **K2. `auth.scopes` first** (4.7), 0.4 only. 0.3 keeps OpenAPI descriptions first.
- **K3. Device Sign-In links** on the issuer's host or `organization.domain` only (4.3), 0.4 only: under 0.3 an issuer for several domains may put its device page on another protected resource's host. The test's domain doesn't come from the mock's `poppyDomains`.
- **O1. Operations details** (Operations 3 to 7). `approved_at` and `input_type`, revisions whose summary alone changed, and approving an earlier revision the User prefers.

**Layer 4.**
- **F2. Session headers** (3.4, 5.2). `Poppy-Version` on every Session request and `Poppy-Extensions`, fixed for the Session; client metadata stops listing extensions for 0.4. Kit: `session.version-missing`, `session.version-unsupported`.
- **F5. Storage.** Each conversation keeps the versions it started in, its four state fields and its request IDs. The migration rewrites the `poppy_conversations_open` index, the `status != 'closed'` queries and the `poppy_protocol_conversation_status` trigger, and must not reuse `retireIncompatibleConversations`, which would close every open 0.3 conversation.
- **M1. Mock foundation.** The mock serves 0.3 and 0.4 from one domain, checks `Poppy-Version`, and keeps one Session per version.
- **W2. `web.disabled` and `web.unscoped`** (6). Kit: `discovery.web-disabled`, `discovery.web-unscoped`.
- **X1. `extension_required` in a JSON body** at APIs (7), 0.4 only.
- **W4. The Session header on fetched website pages** (5.2, 5.6), 0.4 only: under 0.3 website pages never carry it. A page the agent fetches with its own HTTP client gets a signed-out Session header, never an access token, and only on `organization.domain`. A redirect is re-signed only while it stays on that host, and after `invalid_session` the page may be fetched once without the header. Which fetches count is S3's reading. The mock verifies the header on its pages and records one sent off-host or with `ath`.

**Layer 5.**
- **O3. Operations version 3** (0.4 Operations 3, 5, 6). 0.4 Sessions declare `operations` version 3; 0.3 Sessions keep version 2. Every approval carries `approver="user"`. The agent makes no agent approvals: only the person's interface approves a Company's exact terms. `reference` is the local approval record's ID, unique per approval, so it never reaches two Companies. Under version 3 an operation needs `terms` and may omit `summary`: the card shows the Company's `summary` when there is one, and otherwise every value in `terms`, labelled, and the approval stays bound to the exact terms. The mock requires `approver` and rejects `input_type` with `agent`. Kit: `approval.schema.json` and `operation.schema.json` through V0.
- **A1. Approvals across Sessions** (Operations 3; decision 43). Replace `sameAuthority`'s `sessionId` comparison with the agent, User ID and account; signed-out stays separate.
- **C1. Conversation state** (8.7): `working`, `handoff`, `closed` and `responder`. Kit: `conversations.closed-not-working`, `conversations.working-settles`.
- **T1. `tasks.endpoint`** (9), read per Session with the Session header and no token; `feedback.endpoint` comes from its response. Kit: `tasks.response`, `tasks.alternative-references`.
- **W1. `poppy:browser-sign-in`** (6), requested only from a Company with a browser-session endpoint, with a fallback on `insufficient_scope`.

**Layer 6.**
- **R1. Retry after `version_unsupported`** (3.4): fetch `poppy.json` uncached, choose again, and send once in a new Session only if the choice changed.
- **C2. Request IDs** (8.2): every conversation request carries an `id`, stored before sending and reused on retry. Kit: `conversations.missing-request-id`, `conversations.invalid-request-id`, `conversations.request-id-boundaries`, `conversations.request-id-conflict`, `conversations.request-id-other-conversation`, `conversations.request-id-other-url`.
- **T2. Skills** (9.4): the tasks response's skill index. Kit: `tasks.skill-index`.
- **W3. Website operations** (Operations 4 to 8.2): `Poppy-Operation` from the agent's browser, approval at the operations endpoint, the browser's request repeated, `performing` and `performed`. The local form-consent card stays in front.

**Layer 7.**
- **C3. Withdrawing a handoff** (8.9). Kit: `conversations.cancel-without-handoff`, `conversations.closed-handoff-cancel`.
- **C4. Close returns 202** (8.12); the conversation stays open until `closed` is true.
- **C5. `as_of_cursor`** on agent messages (8.4).
- **C6. `version_mismatch`** (8.13): finish in a Session with the conversation's versions, or start a new conversation.

**Layer 8.** **U1** model tools (handoff cancel, state), **U2** Activity, **U3** the protocol log, each reading the four state fields.

**Layer 9.** **V1** the Python Hypothesis client, **V2** interop peers and fixtures for 0.4, **V3** a newer 0.4 snapshot and kit if upstream has moved, **V4** the validator documentation.

**Then:** G1 the design and guides, P1 adding 0.4 to `PROTOCOL_VERSIONS` and its pin's `runtime`, and L1 the live checks in [deployment-tasks.md](deployment-tasks.md).

## The 10 November changelog, entry by entry

The 0.4 draft's changelog has 38 entries. [spec/requirements-0.4.json](../spec/requirements-0.4.json) gives each a disposition, implementation, evidence and the plan items or kit checks that cover it. "Planned" entries point here for evidence until their item lands. `npm run check:spec` requires an entry for every title, in order, and verifies this generated table (`npm run spec:docs`).

<!-- BEGIN GENERATED REQUIREMENT LEDGER -->
| Upstream change | Disposition | Implementation / evidence | Scope and limits |
| --- | --- | --- | --- |
| Direct Sign-In preferred | Done | [code](../src/poppy/signin.ts), [evidence](../test/properties/poppy.test.ts) | chooseSignInType already tries Direct, then Device, then Mediated. Still to do: the 0.4 validator profile warns when a Company that offers sign-in offers Device but not Direct (F7). |
| Several protocol versions | Planned | [code](../src/poppy/protocol-version.ts), [evidence](../docs/poppy-0.4-upgrade.md) | F1 chooses a version from poppy.json and supported_versions; F2 sends Poppy-Version on every Session request; R1 retries once after version_unsupported; M1 gives the mock linked documents and version checks; F7 validates them. Kit: discovery.supported-versions, discovery.versions-same-company, session.version-missing, session.version-unsupported. |
| Extensions declared per request | Planned | [code](../src/poppy/routes.ts), [evidence](../docs/poppy-0.4-upgrade.md) | F1 reads each extension as a list of versions; F2 sends Poppy-Extensions, fixed per Session, and drops extensions from the client metadata; M1 takes the declaration from the header. |
| Conversations across versions | Planned | [code](../src/poppy/conversations.ts), [evidence](../docs/poppy-0.4-upgrade.md) | F5 stores the versions each conversation started in; C6 handles version_mismatch by finishing in a Session with those versions or starting a new conversation. |
| `poppy:browser-sign-in` for signed-in browser join | Planned | [code](../src/poppy/browser.ts), [evidence](../docs/poppy-0.4-upgrade.md) | W1 requests the scope only from a Company that lists browser_session_endpoint and falls back on insufficient_scope; the mock requires it; F7 checks scopes_supported. |
| `web.unscoped` | Planned | [code](../src/poppy/discovery.ts), [evidence](../docs/poppy-0.4-upgrade.md) | W2 reads it before requesting the scope. Kit: discovery.web-unscoped. |
| `web.disabled` | Planned | [code](../src/poppy/discovery.ts), [evidence](../docs/poppy-0.4-upgrade.md) | W2: a Personal Agent SHOULD NOT use a browser on such a Company's website; pages fetched without a browser are not covered (W4). Kit: discovery.web-disabled. |
| Session header on website pages fetched without a browser | Planned | [code](../src/poppy/fetch-browser.ts), [evidence](../docs/poppy-0.4-upgrade.md) | W4, 0.4 only: under 0.3 website pages never carry the header. Pages the agent fetches with its own HTTP client, rather than a joined browser, carry a signed-out Session header to organization.domain only, never with an access token; a redirect is re-signed only on that host; after invalid_session the page may be fetched once without it. S3 records whether the fetch browser counts as a browser when no browser join is available. |
| Conversation state in four fields | Planned | [code](../src/poppy/conversations.ts), [evidence](../docs/poppy-0.4-upgrade.md) | F5 migrates the conversation rows, index and protocol-log trigger; C1 reads working, handoff, closed and responder; U1 to U3 update the tools, Activity and protocol log. Kit: conversations.closed-not-working, conversations.working-settles. |
| Requests are accepted, then acted on | Planned | [code](../src/poppy/conversations.ts), [evidence](../docs/poppy-0.4-upgrade.md) | C2: a POST without wait returns only conversation_id; read until working is false; send the next request only after acceptance when order matters. |
| Request IDs on every conversation request | Planned | [code](../src/poppy/conversations.ts), [evidence](../docs/poppy-0.4-upgrade.md) | F5 stores request IDs durably for messages, handoff, cancel and close; C2 sends a top-level id. Kit: conversations.missing-request-id, conversations.invalid-request-id, conversations.request-id-boundaries, conversations.request-id-conflict, conversations.request-id-other-conversation, conversations.request-id-other-url. |
| Withdrawing a handoff | Planned | [code](../src/poppy/conversations.ts), [evidence](../docs/poppy-0.4-upgrade.md) | C3 adds handoff cancel and direct_conversation_open; U1 adds a model tool. Kit: conversations.cancel-without-handoff, conversations.closed-handoff-cancel. |
| What a message took into account | Planned | [code](../src/poppy/conversations.ts), [evidence](../docs/poppy-0.4-upgrade.md) | C5: as_of_cursor only on messages with author.type agent; as_of_request read as a hint. |
| Closing doesn't wait its turn | Planned | [code](../src/poppy/conversations.ts), [evidence](../docs/poppy-0.4-upgrade.md) | C4: close returns 202; the row stays open until closed is true; read until working is false before closing. |
| Task coverage per Session | Planned | [code](../src/poppy/coverage.ts), [evidence](../docs/poppy-0.4-upgrade.md) | T1 reads tasks.endpoint per Session with the Session header and no token, and takes feedback.endpoint from it; T2 feeds the skill index to the Skills milestone. Kit: tasks.response, tasks.alternative-references, tasks.skill-index. |
| Browser Control extension | Not used | [code](../src/poppy/fetch-browser.ts), [evidence](../docs/poppy-0.4-upgrade.md) | Not declared. Support means handing the User control of the agent's browser and providing navigator.poppy.controller (Browser Control 3, 5, 6). The fetch browser runs no JavaScript and has no window to hand over. Without the declaration a Company handles marked steps as it would without the extension (3). Revisit if the agent gains a real browser. |
| Operations on websites | Planned | [code](../src/poppy/fetch-browser.ts), [evidence](../docs/poppy-0.4-upgrade.md) | Adopted (decision 43), with Operations version 3 under 0.4 (O3). W3 surfaces Poppy-Operation from the agent's own browser, approves at the operations endpoint, repeats the browser's request with its own replay safety, and keeps the local form-consent card. Needs A1. |
| Operations version 3: agent approvals | Planned | [code](../src/poppy/operations-v2.ts), [evidence](../docs/poppy-0.4-upgrade.md) | O3: 0.4 Sessions declare operations version 3 and 0.3 Sessions keep version 2. Every approval says approver user: the agent makes no agent approvals, because only the person's interface approves a Company's exact terms. reference is the local approval record's ID, unique per approval and so never sent to two Companies. Kit: approval.schema.json through the schema oracle (V0). |
| Operations require terms | Planned | [code](../src/poppy/operations-v2.ts), [evidence](../docs/poppy-0.4-upgrade.md) | O3: under version 3 an operation needs terms and may omit summary. The card shows the Company's summary when there is one, and otherwise every value in terms, labelled; the approval stays bound to the exact terms. Version 2 keeps its required summary. Kit: operation.schema.json. |
| `auth.disabled` without other clients | Company obligation | [code](../test/mock-company/auth.ts), [evidence](../docs/poppy-0.4-upgrade.md) | K1: the mock answers refresh with invalid_grant and revocation with success. No agent change: it already refuses sign-in with auth.disabled. |
| Client assertions when no tokens exist | Company obligation | [code](../test/mock-company/auth.ts), [evidence](../docs/poppy-0.4-upgrade.md) | K1: the mock may skip assertion checks while it has issued no refresh token. |
| `extension_required` in a JSON body at APIs | Partly done | [code](../src/poppy/openapi-dispatch.ts), [evidence](../docs/poppy-0.4-upgrade.md) | openapi-dispatch.ts already reads a JSON body; X1 moves the mock's apis.ts to a body and keeps the WWW-Authenticate reading for 0.3 only. |
| Device sign-in links on the issuer or Company domain | Planned | [code](../src/poppy/signin.ts), [evidence](../docs/poppy-0.4-upgrade.md) | K3 applies to the 0.4 profile only: under 0.3 a multi-domain issuer may legally put its device page on another protected resource's host, and refusing it ends the sign-in. |
| Refresh token lifetimes left to the Company | Company obligation | [code](../test/mock-company/core.ts), [evidence](../docs/poppy-0.4-upgrade.md) | No agent change. The mock's refreshTokenTtl only sets an expiry at issue, so nothing depends on a fixed lifetime. |
| A DPoP key per User ID | Done | [code](../src/poppy/client.ts), [evidence](../interop/test/dpop-keys.test.ts) | H1: DPoP keys are held by issuer and User ID, so a changed User ID gets a new key. Each issuer still has one stored User ID; the key stays in memory and is regenerated after a restart. Shipped on 0.3, which allows it. |
| Checking protected resource metadata | Done | [code](../src/poppy/client.ts), [evidence](../interop/test/resource-metadata-refresh.test.ts) | H2: derived metadata counts only when its resource is exactly the service URL, or the origin and path the well-known segment was inserted into (interop/test/service-resource.test.ts). Per decision 43, metadata from a resource_metadata challenge must name the same service exactly. MCP reads only the URL derived from the server (src/poppy/mcp-transport.ts). The mock records resource.unverified-target for a token request naming any other resource. Shipped on 0.3, which allows it. |
| Scopes described twice | Planned | [code](../src/poppy/signin.ts), [evidence](../docs/poppy-0.4-upgrade.md) | K2: describeScopes prefers an OpenAPI description today, the 0.3 order; 0.4 prefers auth.scopes. |
| One User ID per delegated key at the Company | Company obligation | [code](../src/poppy/jwt.ts), [evidence](../docs/poppy-0.4-upgrade.md) | The agent already makes one delegated key per User ID (5.2). K1 lets the mock reject a key reused for another User ID. |
| Sessions found by User ID too | Company obligation | [code](../test/mock-company/core.ts), [evidence](../docs/poppy-0.4-upgrade.md) | K1 keys mock Sessions by client_id, sid and User ID, keeping the violation for an agent that changes sub or agent_id within a Session. No change on the wire. |
| Operations: what a revision covers | Planned | [code](../src/poppy/operations-v2.ts), [evidence](../docs/poppy-0.4-upgrade.md) | O1: a revision may keep its number when only summary changes. |
| Operations: new terms for the same action | Planned | [code](../src/poppy/operations-v2.ts), [evidence](../docs/poppy-0.4-upgrade.md) | O1: review how the terms card presents a new revision for the same operation_id. |
| Operations: approval in another Session | Planned | [code](../src/poppy/authority.ts), [evidence](../docs/poppy-0.4-upgrade.md) | A1, per decision 43: approvals bind to the agent, User ID and account, not one sid; signed-out stays separate from signed-in. |
| When and how the User approved | Planned | [code](../src/poppy/operations-v2.ts), [evidence](../docs/poppy-0.4-upgrade.md) | O1 sends approved_at (Unix seconds; an Integer in the header) and input_type without personal or device data, with approver user under version 3 (O3); the mock parses Integer members. |
| Operations: what counts as the same request | Planned | [code](../test/mock-company/operations.ts), [evidence](../docs/poppy-0.4-upgrade.md) | O1: the agent already repeats the same request; the mock compares requests by meaning, and the agent may approve an earlier revision. |
| Protecting refresh tokens | Guidance | [code](../src/poppy/keys.ts), [evidence](../docs/key-rotation.md) | The client signing keys are Worker secrets, apart from sealed refresh tokens. Rotating DPoP keys at refresh is optional; H1 keeps one per User ID. |
| Operations without storage | Guidance | [code](../src/poppy/operations-v2.ts), [evidence](../docs/poppy-0.4-upgrade.md) | Company guidance. The agent side, approving earlier terms the User prefers, is part of O1. |
| Feedback operations for other clients | Done | [code](../src/poppy/coverage.ts), [evidence](../test/poppy-0.3.test.ts) | Feedback goes only to feedback.endpoint through poppy_feedback; under 0.4 that endpoint comes from the tasks response (T1). |
| Advertising CIMD support | Not used | [code](../src/poppy/routes.ts), [evidence](../docs/poppy-0.4-upgrade.md) | Company guidance for clients other than Personal Agents. |
<!-- END GENERATED REQUIREMENT LEDGER -->
