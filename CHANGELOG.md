# Changelog

Release notes and upgrade instructions for PDA. Entries are newest first, inspired by [Pi's changelog](https://pi.dev/changelog). PDA's release number is separate from the Poppy version it speaks. **Unreleased entries describe repository changes, not a deployed release.**

## Unreleased — the agent speaks 0.4 beside 0.3 (in progress; not deployable)

The agent now speaks 0.4 beside 0.3, and chooses 0.4 from any Company that offers it ([decision 45](docs/decisions.md#45-04-spoken-on-the-branch-before-it-is-finished-and-strict-04-re-pins)). **Don't deploy this yet.** 0.4 support is unfinished: the real browser and Browser Control, among others, aren't done ([0.4 upgrade](docs/poppy-0.4-upgrade.md)). No live Company serves 0.4 yet; Print with Poppy is still on 0.3.

- `PROTOCOL_VERSIONS` is `0.3, 0.4`, and the 0.4 pin is `runtime`: since 11 November, 0.4 as published, `ed47408` (below). Build info adds `protocolRevisions` for each version; `protocolRevision` is the newest version's. The validator checks a document that names no usable version against 0.4.
- The mock Company serves 0.4 in 0.4's shape, alone or beside 0.3 through `supported_versions`, checks `Poppy-Version`, and records a version the agent declares that it never listed, or one that changes within a Session. Against it, the official 0.4 kit now passes 75 checks (83 on the bearer profile), where it stopped at `discovery.schema` before.
- Fixed: a Session started before its first request no longer restarts when that request declares its version.
- Operations 3 in 0.4 Sessions. Each approval says who approved it: `approver="user"`, `approved_at` when the User pressed the card's button, `input_type="tap"`, and the approval's own ID as `reference`, which is unique per approval and never reaches two Companies. They go in `Poppy-Approval`, in MCP `_meta`, and in a message's `extensions.operations.approval`. An operation needs `terms` and may leave out `summary`. Without one, the card shows every value in `terms` with its label. 0.3 Sessions still send version 2's approval.
- 0.4 conversation requests carry a request `id`, stored before sending and reused on retry, and a message takes its request's ID. Handoff and close send one too. The mock requires the ID, answers a retry with the same ID, path and body as it did, and gives `request_id_conflict` otherwise. Against the mock, the 0.4 kit now passes 105 checks (113 bearer, 84 issuerless). Most remaining failures are 0.4 conversation state, cancel and close.
- 0.4 conversation state: the agent reads `working`, `handoff`, `responder` and `closed`, including a stream's `working` events, and keeps `status` as the marker both versions share (`queued` while a handoff is pending). `poppy_handoff_cancel` withdraws a request for a person. Under 0.4, `poppy_close` reads first while the Company is still working and reports `closing`, and the conversation closes when a read says so.
- The mock speaks 0.4 conversations: state fields, `state` events only for `handoff`, `responder` and `closed`, POST replies with `conversation_id` alone, `handoff/cancel`, and a close that answers 202. Against it, the 0.4 kit's only findings are the DPoP prerequisite ones the 0.3 kit has. CI now runs the 0.4 kit with [reviewed findings](test/company-kit/reviewed-findings-0.4.json) beside 0.3's, and both kit steps name their version, since the script's default became 0.4 when the agent began speaking it.
- The mock checks the approvals 0.4 Sessions send: a missing `approver`, `input_type` with `agent`, `approved_at` that isn't an Integer, and a malformed or reused `reference`. It returns operations only to requests that declare Operations 3. Otherwise it refuses with `extension_required` in a JSON body.
- 0.4's tasks endpoint: the agent gets the excluded tasks and the feedback endpoint for each Session, with the Session header and no token even signed in, and reuses the response only in that Session. Feedback under 0.4 goes to the endpoint it names, with the Session header and never a token. The mock serves it and records a token sent there. The mock now answers feedback with an alternative in kit runs, so both kits check its references; the 0.4 kit's only mock skips are the two version checks and `tasks.skill-index`.
- `web.disabled` under 0.4: the agent reads the website's pages but never fills or submits a form there, refuses an approved submit if the Company set it since, and `poppy_discover` points the model to the Company Agent and APIs. The mock can set it, and records a form sent to such a website.
- `extension_required` in a 0.4 JSON body names the extension for the model and the User at MCP servers and protocol endpoints too, not only OpenAPI operations. The mock's MCP server sends it when configured to require an extension.
- 0.4 website pages fetched without a browser carry the Session header where the Company lists no `browser_session_endpoint`: signed out even in a signed-in Session, with the declared versions and the operator signature, on `organization.domain` only, and not on a redirect that leaves it. A page that refuses the header with `invalid_session` is fetched once more without it; a form isn't sent again. Where the Company lists `browser_session_endpoint`, the fetch browser joins as before and sends none, and 0.3 pages never carry it. The mock verifies a page's header and records one sent to another host, beside a token, or in a 0.3 request.
- Operations 3 approvals hold across Sessions of the same agent and User with the same account: an approval whose Session the Company ended is sent in the new one, instead of failing. Signed-out approvals stay signed out, a sign-out still voids an approval, and 0.3 approvals stay in their Session.
- After `version_unsupported` the agent fetches `poppy.json` afresh and chooses again. An API call without an approval is sent once more in a new Session under the new choice; a conversation message or an approved request isn't, and the model is told nothing was handled.
- The mock publishes a skill index in its 0.4 tasks response: one `SKILL.md`, by a reference relative to `tasks.endpoint`, with its digest. It records an artifact fetched with a token or Session header. The 0.4 kit's `tasks.skill-index` now passes, so its only mock skips are the two version checks. The agent ignores the index, which 9.4 allows ([decision 46](docs/decisions.md#46-the-agent-ignores-a-companys-skill-index)).
- 0.4 messages the agent writes carry `as_of_cursor`, the last cursor it handled. A Company Agent reply's `as_of_request` tells the model, as a hint, whether the reply covers its latest message, and `poppy_message` returns the message's ID. The mock sends `as_of_request` and checks `as_of_cursor`.
- A conversation keeps the versions it started in. After a Company moves to 0.4 while still serving 0.3, a 0.3 conversation continues in a 0.3 Session of its own, signed in to the same account, and other work stays in 0.4. A conversation whose versions the Company no longer serves is closed, and the model is told to start a new one.
- The model, Activity and the protocol log see a 0.4 conversation's four state fields (`closed`, `working`, `handoff`, `responder`) as the Company sent them, rather than a status derived from them.
- `poppy:browser-sign-in` (0.4 6): the agent's browser joins signed in only when the sign-in includes it, and otherwise, or after `insufficient_scope`, joins signed out with the same code and tells the model how to sign the website in. The scope is never requested from a Company without browser join, and `web.unscoped` is shown to the model and the User before it is.
- Standing instructions and agent approvals (Operations 5). On the Companies page, the User can write instructions for a 0.4 Company, such as "any exchange with a price difference of at most 100.00 USD", optionally for one account and with a limit over a period. When the Company returns an operation, a deterministic check approves it as the agent (`approver="agent"`, no `input_type`) only if every condition holds on its `terms`, the limit has room, and the Session holds no scope that can make changes that can't be undone. Anything else goes to the User's card, as does any later approval of the same operation. Withdrawing an instruction stops what it approved but hasn't sent. Activity names the instruction behind each agent approval, and the Companies page lists what each one approved. The model can read instructions in `poppy_status` but has no way to write them. New tables `poppy_instructions` and `poppy_instruction_spend`, and `approver` and `instruction_id` on approvals, come by migration.
- The 0.4 pin moves to 11 November: upstream published 0.4 on 10 November as the 1.0 release candidate. The [snapshot](spec/draft-0.4-retrieved-2026-11-11/README.md) and [kit](spec/company-kit-2026-11-11/README.md) match upstream `ed47408`; the 10 November pin stays in `spec/`. The ledger has 44 entries. The kit's results against the mock are unchanged. `scripts/spec-snapshot.mjs` now recognises a published version's wording.
- A Company can decline an approval (Operations 6). The agent reads `approval_declined` from an API, an MCP tool's error result or a later Company message, settles the card as refused, never sends the approval again, and tells the model not to retry. The Company's `reason` and `alternative` are shown as its own words. The mock can decline, and records a declined approval sent again, an agent approval after a decline, and an agent approval of a revision that answered the agent's own approval.
- Under 0.4 the agent also uses the scopes listed in the domain's protected resource metadata, and the validator's 0.4 profile accepts them there. The fetch browser keeps a cookie whose `Domain` is the Company's own domain, so a browser-session endpoint on `accounts.example.com` can sign in pages on `www.example.com`; any other `Domain` still stays host-only.
- When a sign-in grants fewer scopes than asked, the model is told the Company may not grant them to this User, and not to send the User to sign in again just for them. The mock's consent page names the agent asking to connect and says to continue only if the User asked. A test shows that a Direct Sign-In link forwarded to someone else gives nobody tokens (0.4 10.8).
- Website operations (Operations 4, 6, 7). When the User approves a form submit and a joined browser's website answers with `Poppy-Operation`, the agent fetches the operation at the Company's operations endpoint and shows its exact terms on a card. A standing instruction may approve them instead. The approval goes to the endpoint, never through the browser, and the browser then repeats exactly the approved submission. A repeat that fails or returns a new reference is looked up before anything else, and a decline at the endpoint is shown and never resent. The reference is taken only from the final response's own header, never shown to the model, and only when it names that browser's Session. On a scoped website `poppy:browser-sign-in` no longer stops a standing instruction, since it allows nothing beyond the other scopes. The mock's exchange form returns operations to a joined browser, and it records a reference the website never returned, `Poppy-Approval` on a browser request, and a website's operation approved elsewhere.
- A new 0.4 snapshot is strict, as any revision change is: the agent retires a 0.4 Company's open conversations and holds its pending approvals.

- The validator has a Draft 0.4 profile beside 0.3's. It checks extensions as lists of version entries, `tasks.endpoint` and the members that moved there, `web.disabled` and `web.unscoped`, website operations and Browser Control with browser join, `poppy:browser-sign-in` in `scopes_supported`, and warns when a Company offers Device Sign-In but not Direct. Messages for rules 0.4 kept from 0.3 link to the 0.4 pages.
- `validateCompany(fetcher, domain, { versions })` chooses the newest version the caller speaks from poppy.json and its `supported_versions`, as the agent will (3.4). A linked document must be on the same host and is never fetched through a redirect; one that names another version, lists `supported_versions` or names another domain is reported. Without `versions` it chooses among every version the validator has a profile for.
- Discovery chooses its version through `validateCompany`, with the versions the agent speaks, so a Company whose poppy.json is 0.4 and links a 0.3 document is used at 0.3, and one with no 0.3 document is refused. From a 0.4 document it reads extension version lists, `tasks.endpoint`, `web.disabled`, `web.unscoped` and the Operations 3 endpoint, and keeps a model's API calls off the tasks and operations endpoints. `SUPPORTED_EXTENSIONS` is keyed by protocol version.
- 0.4's `version_unsupported`, `version_mismatch` and `request_id_conflict` are known error codes. A message refused with `request_id_conflict` is reported as the agent's bug, like `message_id_conflict`; one refused with `version_mismatch` tells the model the conversation can't continue, and keeps it open for reads.
- A Session keeps what it declared (`poppy_sessions.declared`, added by migration). Under 0.4 its requests carry `Poppy-Version` and `Poppy-Extensions`, and a Company document that calls for other values starts a new Session, keeping the account, before anything is sent. 0.3 requests are unchanged.
- Conversations keep the protocol version and extensions they started in, and 0.4's `working` and `handoff`, in new `poppy_conversations` columns. The migration only adds columns: open conversations stay open, as 0.3 conversations.
- The kit schemas judge each request the agent sends by the version it declares, and the client metadata by both kits.
- The new profile agrees with the 10 November kit's `check --file` wherever both check. The kit's offline check doesn't check website operations or Browser Control without join, members moved to `tasks`, or `supported_versions` on another host; the pinned text requires each, so the validator keeps them.

## Unreleased — the 0.4 pin moves to 10 November: Operations 3, Browser Control, and Session headers on fetched pages

Nothing changes on the wire: the agent still speaks 0.3 alone.

- The 0.4 draft is pinned from the [10 November 2026 snapshot](spec/draft-0.4-retrieved-2026-11-10/README.md) and the [official kit](spec/company-kit-2026-11-10/README.md) downloaded from the protocol site the same day, both matching upstream [`a2f16ec`](https://github.com/personal-agent-protocol/personal-agent-protocol/commit/a2f16ec4c38e111289c12d7fbd8fec57b8aba06e). The 9 November pin stays in `spec/` as a record.
- Upstream added four changelog entries, now in the [ledger](docs/poppy-0.4-upgrade.md) with 38 dispositions. 0.4 uses Operations version 3, which adds a required `approver`, optional agent approvals and a `reference`, and makes `terms` required and `summary` optional. Plan item O3 sends only user approvals. Browser Control version 1 isn't declared, because the fetch browser has no window to hand to the User. Website pages fetched without a browser carry a signed-out Session header under 0.4 (W4).
- The new kit's validator has the same 132 checks: `operations.not-returned` became `extensions.not-returned`. Against the mock it gives the same baseline as the 9 November kit on all four profiles: 11 pass, 1 fails (`discovery.schema`) and 120 are skipped.
- The official kit now checks our agent too. After every Workers test, the JSON bodies, Session JWTs, delegations, approvals and client metadata the agent sent the mock are checked against the pinned 0.3 kit's own schemas and validator (`test/kit-schemas.ts`). The current suite passes it unchanged.
- The snapshot has no home-page walkthroughs: `scripts/spec-snapshot.mjs` can't read the site's new bundle. They are examples, not requirements.

## Unreleased — exact protected resource metadata, and a DPoP key per User ID

Two rules from the 0.4 draft that 0.3 also allows ([0.4 upgrade](docs/poppy-0.4-upgrade.md), H1 and H2).

- Protected resource metadata counts only when its `resource` is exactly the service it was fetched for (RFC 9728 3.3): the URL derived from an OpenAPI server or conversation endpoint, a `resource_metadata` challenge's URL, and an MCP server's URL. Metadata naming a parent, a sibling, another case, a trailing slash or a query is treated as absent at the derived URL, and refused after a challenge, so a service can no longer steer the agent into asking for a token for another resource. MCP no longer falls back to the root `/.well-known/oauth-protected-resource`, whose `resource` can't be a server with a path. A Company that relied on either looser match now gets the Company's own token at that service, or, for MCP, an error that it publishes no metadata.
- DPoP keys are held by issuer and User ID (0.4, 4.5). Keys stay in memory, so nothing stored changes.
- The mock records `resource.unverified-target` for a token request naming a resource that no metadata at its own derived URL names. New configurations: `mismatchedApiResourceMetadata` and `mcpPrmAtRootOnly`.

## Unreleased — the Poppy 0.4 draft, pinned beside 0.3

Nothing changes on the wire: the agent still speaks 0.3 alone.

- The 0.4 draft is pinned from the [9 November 2026 snapshot](spec/draft-0.4-retrieved-2026-11-09/README.md) and the [official kit](spec/company-kit-2026-11-09/README.md) downloaded the same day, both matching upstream [`b2569c5`](https://github.com/personal-agent-protocol/personal-agent-protocol/commit/b2569c552d100922e7d60829d33a0fc50d88e822). [Decision 43](docs/decisions.md#43-03-beside-04-both-versions-website-operations-and-approvals-across-sessions) records the choice to support both versions, and the [0.4 upgrade](docs/poppy-0.4-upgrade.md) the work, its order, and a ledger of all 34 changelog entries.
- `spec/upstream.json` lists one pin per version. `npm run check:spec` verifies each pin, its kit and its ledger, and that the runtime pins match the versions the agent speaks. `npm run spec:drift` checks only a published version's own pages and changelog entry titles, and every page of a draft.
- `node scripts/check-company-kit.mjs --protocol 0.4` runs the 0.4 kit against the mock. Its first run stops at `discovery.schema`, because the mock still lists each extension as an object rather than the versions it serves.

## Unreleased — explicit task access and personal data controls

- Company recipients and photo-upload permissions are explicit selections in the composer, durably bound to each admitted message. The Company list stays selected for later messages, across reloads and devices, until you change it; photo permissions last for one message. Prose names, negations, filenames and Company replies grant no access. An upload without an explicit file-and-destination selection retains its disclosure card. Legacy inferred grants are withdrawn; unfinished tasks need a fresh message and old tabs must reload.
- Scheduled tasks retain the selections from the message that created them; later chats cannot supply their permissions. Older Company tasks need to be cancelled and set again. Failed-message and photo retries open in the composer for review and fresh selections. Stop is rechecked before a prepared Company message is dispatched.
- Settings can stream a local-data export without stored credentials and request agent deletion. The export holds only what it explicitly lists. Deletion stops work, revokes Company tokens, erases local storage and invalidates older browser sessions. A Company that won't accept revocation can't hold your data: Settings lists it and why, and you can retry, keep your agent, or delete anyway, which destroys the agent's only copy of that credential. Interrupted deletion has a durable retry. Provider/Company copies and shared operator accounting are outside local erasure.
- Onboarding describes Company-driven exact-terms approval. Memory controls say what they delete and describe credential checks as best effort. Private photos are no-store and logout clears the browser cache.
- `apis.ts` and `poppy-ui.tsx` are stable entry points over modules separated by parsing, validation, transport, durable dispatch and interface responsibility. [Implementation boundaries](docs/architecture.md) describe ownership.
- The sign-in page shows its generic failure message for an unknown `?signin_error=` code; an inherited name such as `__proto__` used to break the page. The Worker and the page share one list of codes (`src/sign-in-errors.ts`).
- Public build provenance and `npm run check:live` support read-only release checks. Current protocol guides identify the 3 November pin. [Key rotation](docs/key-rotation.md) records operational steps and recovery limits.

## Unreleased — Poppy 0.3, the 3 November text

Protocol baseline: **0.3 as retrieved on 3 November 2026**, matching upstream commit [`7205250`](https://github.com/personal-agent-protocol/personal-agent-protocol/commit/7205250c6fb7d4a181707898fa418911ccbcb163) ([snapshot](spec/draft-0.3-retrieved-2026-11-03/README.md), [upstream changelog](https://personalagentprotocol.org/docs/changelog)). Operations **v2**, Mediated Sign-In **v1**. The [ledger](docs/poppy-0.3-upgrade.md) gives each of the changelog's 79 entries a disposition.

### Breaking

- Session JWTs carry their delegation in `poppy_dlg`, typed `poppy-delegation+jwt`, in place of `pap_dlg` and `pap-delegation+jwt`. A Company still on the 29 October text refuses them with `invalid_session` until it moves to the current text.
- `session_ended` starts a new Session once. `invalid_session` is no longer retried with a new Session; it reaches the tool or job as an error.
- In conversations, an approval goes in `extensions.operations.approval`, and a Company Agent's operation is read from `extensions.operations.operation`. Operations at the old top-level `operation` field are ignored. A message intent stored by an earlier build keeps the old `approval` field; restate any unsent approval.

### Added

- Companies without an OAuth issuer. A 404 for `/.well-known/oauth-protected-resource`, or metadata without authorization servers, means signed-out only, identified by `https://{organization.domain}`. Their APIs (MCP included, without server metadata), conversations, feedback and browser join work signed out, and sign-in is refused before anything is sent. The validator reports this as information (`prm-no-issuer`), not a MUST failure, and refuses sign-in offered without an issuer (`issuer-required`).
- `auth.disabled`: no sign-in at a Company whose issuer serves other clients. The validator refuses it together with Mediated Sign-In or `signed_in` access.
- Validator support for `organization.logo_uri`, `skill_index`, the `access` hint and the `links`, `disclosures` and `ucp` extension names.
- Mock checks and fixtures: `message.extension-unlisted`; `issuerless`, `authDisabled` and `omitScopesSupported` configurations.

- Web Bot Auth operator signatures (5.3) with the optional `POPPY_OPERATOR_KEY`, and a key directory at `/.well-known/http-message-signatures-directory`.
- Company-first Direct Conversations: accepting an invitation names its `user_requested` event, and the User can let the Company speak first.
- Company logos on the Companies page, fetched by the agent and served from `/api/companies/<domain>/logo`.
- A sign-in type a Company refuses with `unauthorized_client` is remembered for an hour, and the Session continues signed out.
- When a domain's Company identifier changes, accounts held under the old one are signed out and the User is told.
- The official Company kit is re-pinned to the 3 November download, matching upstream `7205250`.
- MCP 2026-07-28 beside 2025-06-18 (7; [#47](https://github.com/adewale/pda/issues/47)). A server that speaks only 2026-07-28 can now be used: requests carry the version and client metadata in `_meta` and its mirrored headers, with no `initialize` or `Mcp-Session-Id`. The client learns each server's era with a `server/discover` probe and falls back to `initialize` on the binding's legacy signal. A `tools/call` is never sent again by that negotiation ([readings](docs/readings.md#mcp-lifecycle)).
- The mock's MCP server speaks 2025-06-18, 2026-07-28 or both (`mcpVersions`), each enforcing its version's wire rules: `mcp.legacy-session`, `mcp.legacy-version-header`, `mcp.legacy-initialized`, and `mcp.modern-meta`, `-client-info`, `-version-header`, `-method-header`, `-name-header`, `-param-header` and `-session-id`. Its `state().mcp` lists every JSON-RPC message with the lifecycle it was served under.

### Changed

- Three rules where PDA had been stricter than 0.3 are relaxed. A server that a listed OpenAPI description names is a Session destination on any public HTTPS host. An MCP server's metadata is required only before requesting a token for it. Web alternatives keep HTTPS links on any host.
- The mock keeps idempotency records for the agent, the User and any account rather than the Session.
- An approval message stored by an earlier build with the top-level `approval` field is refused before sending.
- `scopes_supported` is recommended, not required (`scopes-supported-missing`, a warning). Direct and Device Sign-In may request scopes the Company documents in `auth.scopes` or an OpenAPI description, even when they're absent from it.
- Signing in again for more access requests the account's existing scopes along with the new ones.
- Domains sharing an issuer are no longer refused when their `auth` objects differ.
- The mock follows 8.2's conversation ownership (the `client_id`, the User ID, and the account once used) and 8.10's `invalid_request` for a Direct Conversation as parent.
- Readings: a 404 alone doesn't replace an issuer the agent already knew; issues 11 and 21 are settled upstream.
- An MCP server PDA hasn't seen before now gets a `server/discover` probe first. A 2025-06-18 server answers it with a 400, then gets `initialize` as before; the protocol log shows that 400. The mock's default 2025-06-18 server now refuses a request without the session `initialize` opened.

### Migration and rollback

- Nothing to migrate in storage. A Company without an issuer is keyed by `https://{domain}`, a new identifier with its own User IDs and Sessions. Discovery caches refresh on their own.
- Optional: set `POPPY_OPERATOR_KEY` (`node scripts/poppy-secrets.mjs operator-key`) to send operator signatures. `wrangler.jsonc` routes the key directory to the Worker.
- Rolling back to a build from before this change speaks the 29 October names, which Companies on the current text refuse. Reconcile any in-flight conversation approvals first.

### Validation

- Offline, on 3 November:
  - Passing: `npm run typecheck`, `check:spec`, `check:docs` and `test:tooling`.
  - The five Vitest projects: 1,447, 3, 272, 430 and 196 tests passing, after one interop expectation was updated for 9.2's web alternatives.
  - `npm run test:hypothesis`: 22 passing. A new machine covers a Company with no issuer, and the Python client signs with its own operator key.
  - `npm run check:approval-crashes`: every process-kill case passing.
  - The hosted dummy Company security check: no strict violations or warnings.
  - The re-pinned official Company kit, reviewed and DPoP-capable: only the documented findings and skips. That includes a new profile with no issuer: 91 checks passing, none failing or warning, 30 OAuth checks skipped.
- Not run: the Docker interop grid, the browser journeys and any live Company. Operator signatures haven't been checked against a real edge.
- Offline, on 4 November, for MCP 2026-07-28:
  - Passing: `npm run typecheck`, `check:spec` and `check:docs`.
  - The five Vitest projects: 1,538 (1 skipped), 3, 273, 431 and 196 tests passing.
  - `npm run test:hypothesis`: 22 passing. The independent Python client now speaks 2026-07-28 too, written from the MCP text, and each example's mock speaks 2025-06-18, 2026-07-28 or both.
  - The official Company kit, with and without DPoP, `--reviewed-findings`: only the documented findings and skips.
  - `npm run check:approval-crashes`: every process-kill case passing.
  - The Docker interop grid, honest lane: four agents × both mocks, 254 passing, 34 failing (all the sloppy agent's documented mistakes), 128 unsupported, no errors. `pda` passes all 72 of its supported cells, MCP's AM and ML included. The three security commands, with `--require-supported`: 8, 8 and 16 cells passing.
  - `scripts/app-smoke.mjs --approval-journey --photo-journey` in Chromium: every check passing, including the OpenAPI and MCP approval journeys and both photo journeys, with no uncaught browser errors.
  - Not run: any live Company, and the print-with-poppy peer, whose latest commit (`b340741`) still requires `pap_dlg`. No interop peer or live Company speaks 2026-07-28 yet.

## Unreleased — Poppy 0.3 alone

Protocol baseline: **0.3, the text retrieved on 29 October 2026** ([snapshot](spec/draft-0.3-retrieved-2026-10-29/README.md); `spec/upstream.json` pins its hashes; the restored browser rule has no upstream commit yet). Operations **v2**, Mediated Sign-In **v1**. 0.1 and 0.2 are no longer spoken ([decision 37](docs/decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles)).

### Breaking

- A Company whose `poppy.json` declares 0.1 or 0.2 is refused before its issuer is used, and can't be used until it moves to 0.3; an agent's accounts there go unused, and aren't revoked. Print with Poppy moved on 28 October (`b340741`, and printwithpoppy.com declares 0.3).
- The client metadata document is `/poppy/client.json` again, listing Operations 2; `/poppy/0.3/client.json` is gone. A Company that allowlisted it sees a new `client_id`, and the User signs in again.
- Operations 1 is gone: proposals, confirm and cancel, tracking, standing permissions, the `poppy_operation` tool and its card. A migration drops `poppy_operations`, `poppy_proposals` and `poppy_permissions`. A Company's terms use one exact-revision approval card; there is no preliminary API-write card.
- Sign-in asks for the Company's own scopes; `poppy:read` and `poppy:write` are gone.

### Added

- Approval dispatch verification uses actual process-group SIGKILL with a surviving Company request/effect ledger at four boundaries, for OpenAPI and MCP. It exposed a lost completion notification; approvals now persist a per-decision notification and retry its stable ID/text after restart without resending the action.
- Eight concurrent two-Company/two-User callback attacks check issuer, state and code combinations, then valid sign-ins and API reads.
- A separately patched copy of the official Company kit sends valid DPoP token proofs. Its assertion probes pass, with 18 independent positive/denial controls; original pinned verdicts remain unchanged.
- The manual 29 October spec refresh restores the explicit agent-controlled-browser MUST. PDA already uses its own browser; direct privacy/isolation evidence covers the restored rule.

- `poppy_feedback`: tells a Company about a task the User couldn't do there, once per task, never one it lists as excluded, and passes on another way to do it when the Company answers with one (9.3). `poppy_discover` now lists the tasks a Company leaves out of the protocol (9.1) and describes its scopes from its OpenAPI descriptions and `scope_hints`.
- Approval cards check the Company's terms against the request and the summary, and say what differs (Ops 5).
- A requirement ledger for 0.3: `spec/requirements-0.3.json` gives each of the changelog's 43 entries a disposition, and `npm run check:spec` holds it to the changelog.
- A mock check that no Session header reaches an OAuth endpoint (`session-jwt.oauth-endpoint`, 5.2).
- Four issues found while implementing, in [poppy-0.3-issues.md](docs/poppy-0.3-issues.md#found-while-implementing).
- The Python Hypothesis client and its five state machines speak 0.3: the Session header, refresh tokens, Operations 2, the browser join and MCP with its own token ([its README](test/hypothesis/README.md)).
- The interop grid's first run at 0.3 (29 October): our four agent profiles against `lenient-company`, `strict-company` and `evil-company`, every failure the sloppy agent's by design ([results](docs/interop-results/README.md)).
- print-with-poppy's adapter, back at `b340741`, the first other project on the 28 October text, and `print-with-poppy-live` for discovery at printwithpoppy.com. Its first run at 0.3: our three honest agents pass all ten scenarios it claims, the photo upload and its order (OU) among them, and the sloppy agent fails only its known `aud` ([results](docs/interop-results/README.md#print-with-poppy-at-03)). Its build stage starts from the full `node:22-bookworm` image, so the build installs no Debian packages.
- The first live 0.3 run: discovery (D) at printwithpoppy.com passes from our agent's container, and the validator finds it valid ([results](docs/interop-results/README.md#live-printwithpoppycom-29-october)).
- A trace check, `one_session`, that every resource request in a cell carries the Session header with one `sid`, and none reaches an OAuth endpoint (5.2).
- The interop agent reads pages in Node with `html-rewriter-wasm` (lol-html, as Workers' `HTMLRewriter`), so browsing scenarios see the page the Company served.
- An ecosystem refresh for 29 October: who implements the 28 October text, and dated public discovery results ([ecosystem.md](docs/ecosystem.md), [evidence](docs/evidence/ecosystem-2026-10-29/README.md)).

### Changed

- Restore retired-source links at immutable revisions, use a current adapter in the maintainer guide, and record the 1 November public deployment preflight with authenticated checks still blocked on access.

- Contributor guidance routes by subsystem; current verification, deployment state and backlog each have one source. Dated research is frozen at immutable revisions, and plugin proposals no longer carry copied grid statistics.
- Documentation evidence links use stable files instead of test titles. `check:docs` no longer starts Vitest; `npm test` no longer creates discovery reports. `test:tooling` checks the lightweight scripts.
- CI keeps full checks on main and selects runtime/specialist PR checks by changed inputs; documentation-only PRs keep lightweight required checks. No runtime safety assertions were removed.

- A photo selected for the User's task can upload to that task's Company without another permission click; the print journey asks once for the Company's order terms. Unselected saved photos still need disclosure consent. Company content cannot supply file selection or add recipients through filenames, email domains or URL queries. Uploads retain their first routing decision and durable outcome across replay ([decision 39](docs/decisions.md#39-a-requested-photo-upload-does-not-need-a-second-permission-click)).
- The privacy policy now describes task-authorized uploads, model image previews, operator access, provider/account-dependent processing, separate diagnostic retention and what local deletion does not erase. [The review](docs/history/privacy-review.md) records the remaining deletion, memory and retention UX problems without claiming they are fixed.
- Task API requests and MCP calls now run before the Company asks for approval of its exact terms. The preliminary per-write card is removed; unselected photos still need disclosure consent and website forms still need approval. This replaces decisions 36/37's blanket confirmation policy ([decision 38](docs/decisions.md#38-task-requests-use-the-companys-approval-boundary)).

### Fixed

- A late model-provider 401 no longer invalidates a replacement key. Calls bind the credential and workspace to a private saved-key generation; existing keys acquire a generation through an additive SQLite column.
- The validator refuses missing or malformed EC/RSA public key material and algorithm-family mismatches. Operation expiries reject impossible calendar dates and clock values instead of accepting JavaScript's date rollover.
- The ecosystem's revisions link targets the rendered implementation table. Documentation checks cover local files and anchors, and the current guides describe Operations 2, soft demo spending limits and the active specification snapshot.
- Pending Company terms no longer wake the model to recreate the request. Fresh calls reuse matching pending terms, and tool replay returns the recorded outcome without another write. Internal dispatch records stay out of approval cards, including after reconciliation and receipt expiry.
- Approved API/MCP results are kept whole instead of cut at 2,000 characters. Successful result URL/link fields are delivered directly as HTTPS links with their destinations labelled, including signed query strings. Links in operation summaries remain inert. The reported live checkout link's exact failure is not established by diagnostics that omit bodies and URLs.
- Every coalesced task call retains its durable identity after settlement, decline and revisions. Fresh attempts get immutable decision IDs; late clicks cannot approve them. Returned terms keep the transport's authority, and committed pending terms are republished after interrupted card delivery. A changed MCP read-only annotation cannot bypass a stored result.
- Approval storage is version 3 only: no old two-card flow, migration or missing-authority defaults. Older pending forms are refused and must be requested afresh; uncertain historical outcomes remain held.
- Activity exports diagnostics by action, retaining safe event copies separately from general pruning (50 flows, 200 events/256 KiB each). Closed link-rejection reasons and client-reported source/anchor equality are counts only; no URL values or hashes enter reports. Shared unit context and missing pruned history are disclosed.
- Turn diagnostics wait for in-flight tools before emitting, without blocking later runs. A deterministic failing reproduction established this lifetime race; it does not establish the cause of the earlier CI foreign-text assertion.
- Crash verification now has 16 actual process-group SIGKILL cases, including initial dispatch, interrupted terms publication, real Pi MCP result settlement and an unsafe replay negative control.
- A delayed refresh or retry response can no longer overwrite newer sign-in access, undo sign-out or restart a newer Session. Browser cookies and saved forms are invalidated when consent scopes or the account family change.
- Approval receipt failures preserve completed Company outcomes. Reconciliation and batch notifications keep their ID/text across failure and restart, and a batch acknowledges only decisions it actually claimed.
- Conversation streams handle CRLF split across chunks, bound individual events and unfinished text, cancel cleanly and release read timers. Concurrent feedback reports no longer duplicate a task or combine different Users in the mock's repetition oracle.
- Incompatible conversations retire locally after an upgrade instead of running failing read jobs indefinitely. History and pending-message evidence remain, and Activity explicitly retains an unknown remote outcome.
- The separately patched kit follows replacement DPoP nonces and signs fresh retry proofs. [Final adversarial audit, counterexamples and verification](docs/evidence/pr-36-final-audit/README.md).

- Remaining 0.3 conformance gaps: Company-wide holds and User reconciliation for uncertain actions, MCP cache invalidation after withdrawal or scope changes, safe metadata recovery after `invalid_token`, and conservative missing scope hints. Verification now includes endpoint redirect controls, model-boundary guards and direct User alternatives, API/MCP lifecycle cases, restored 0.3 security lanes in CI and actual Chromium approval/recovery journeys. The [conformance review](docs/poppy-0.3-conformance.md) lists the fixes and keeps live and language-model limits explicit.
- The PR 36 audit's nine findings: withdrawn conversation and browser approvals, account changes during browser join, interrupted legacy sign-ins, invisible Operations 1 cards, Company-dependent metadata and task caches, service metadata paths ending in `/`, Session JWT leak checks and tool steps left waiting after the Company's terms were decided. Sign-out now persists a local authority counter, so signing back into the same account cannot revive an old approval or browser context. [Fixes and regression evidence](docs/evidence/pr-36-audit/README.md).
- The protocol log called token-endpoint requests "Session header"; they carry our client assertion.
- Signing out withdraws its Sessions' pending approvals at once, not at the next token refresh.
- `extension_required` names the extension the Company asks for.
- The mock Company left out a scope a sign-in type can't grant instead of refusing it, when the issuer lists it (4.7, RFC 6749 3.3), and names the granted scope whenever it differs from the request, even where it usually omits it (RFC 6749 5.1). The Hypothesis port found both.
- The live lane's notice without an identity named 0.1's scenarios and error: at 0.3 a Company refuses S0, CL and ML's Session header with `invalid_session`, and only a sign-in with `invalid_client`.
- CI's interop job ran no cell at all after the move to 0.3: the mock's adapter still declared 0.1, so every cell was refused at version negotiation and the run passed. The adapter declares the version we speak, and a run in which no cell passes or fails now fails.
- One agent's OpenAPI descriptions and task coverage were cached per process, so a second agent in the same process (the interop image, the Durable Object's isolate) could use the first one's. Each cache is now per client.
- The interop checks require `conversation_id` on every conversation read (8.5).
- Scenarios S0, CM, N and XN exercised nothing at 0.3, since a signed-out request no longer starts a Session at the token endpoint; each now makes the request its requirement is about. Every scenario's requirements cite 0.3's sections.

### Removed

- Every interop peer, vector and lane that spoke 0.1 or 0.2, with `lenient-company-v02`, the official validator's lanes (`npm run interop:official`, `npm run interop:flaws`) and the adversarial agent, which waits for a 0.3 port. [interop-spec §14](docs/interop-spec.md#14-retired-with-01-and-02) lists each with its last pin.
- 0.1 and 0.2 error codes from the client's list: `account_mismatch`, `operation_not_found`, `sign_in_required`, `terms_changed` and `user_approval_required`. `rate_limited` stays as our own agent code.
- NREP, the replayed token request, from the mock's manifest: it replayed 0.2's Session request, and waits for a 0.3 rewrite.

## Earlier — Poppy 0.1 and draft 0.2

Protocol baseline: **0.2, upstream revision 19 October 2026**, commit [`39b35bd`](https://github.com/personal-agent-protocol/personal-agent-protocol/tree/39b35bdf240fc07f157d6ca4e29b5a41d4b36b5d), Operations **v1**. [Local specification and official changelog](spec/draft-0.2-2026-10-19/README.md). [Upstream changelog](https://personalagentprotocol.org/docs/changelog#v0-2). Draft 0.2 is still in progress; this entry targets that exact revision.

### Breaking Changes

- Unknown pre-1.0 versions are refused before issuer metadata or credentials are used. Older PDA treated every `0.x` as compatible. Declared **0.1 remains supported** by its existing rules.
- Invalid explicit validator protocol contexts are errors, rather than silently selecting a different version. Versionless client-metadata validation retains its 0.1 default.
- A model cannot expand a task to another Company after reading Company or tool content unless the User's own task names that domain. A new task with no named domain can choose its first Company; later additions require the User to name them. This also prevents a Company from starting sign-in at another Company.
- Pending work is bound to its original Company domain and profile. Ambiguous older work, or work whose issuer or wire version changed, is held for reconciliation. It is not silently replayed with different endpoints.

### Added

- **Draft 0.3, as upstream rewrote it on 28 October**, beside 0.2 and 0.1, on branch `poppy-0.3` ([snapshot](spec/draft-0.3-retrieved-2026-10-28/README.md), [plan and status](https://github.com/adewale/pda/blob/455b3b90e547c23534155b9323398cc642d0a050/docs/poppy-0.3-plan.md#then-03-as-rewritten-on-28-october)). A Company whose `poppy.json` says `"0.3"` is discovered through its domain's protected resource metadata, and every request to it carries a `Poppy-Session` JWT signed with a delegated key, one per User ID. Accounts use plain OAuth refresh and access tokens, with DPoP only when the issuer asks for it. The browser joins a Session by authorizing the page's code in our own request. Operations 2 puts the Company's terms on an approval card and sends the same request again with `Poppy-Approval`, MCP `_meta` or a message's `approval`. Mediated Sign-In is a token-endpoint grant, and messages carry `author`. The validator has a `Draft 0.3` profile with 12 new messages; the mock Company speaks 0.3 and checks 51 of its rules. A 0.3 Company sees its own client_id, `/poppy/0.3/client.json`, which lists Operations 2 ([decision 36](docs/decisions.md#36-draft-03-beside-02-a-client_id-per-version-our-card-before-the-companys-terms-and-sessions-that-outlive-sign-out)). Not yet in the interop grid; 0.3 isn't published, so this follows an in-progress text.
- Three snapshots of Personal Agent Protocol draft 0.3 as the site served it, at [01:47](spec/draft-0.3-retrieved-2026-10-25/README.md) and [06:13 UTC](spec/draft-0.3-retrieved-2026-10-25T0613Z/README.md) on 25 October and [18:34 UTC](spec/draft-0.3-retrieved-2026-10-26/README.md) on 26 October, since it kept changing, what it changes here ([docs/poppy-0.3-upgrade.md](docs/poppy-0.3-upgrade.md)), a plan to keep up with weekly versions, starting with 0.3 and dropping 0.1 ([docs/poppy-0.3-plan.md](https://github.com/adewale/pda/blob/455b3b90e547c23534155b9323398cc642d0a050/docs/poppy-0.3-plan.md)), every open problem in one list ([docs/poppy-0.3-issues.md](docs/poppy-0.3-issues.md)) and a review of its text ([docs/history/spec-issues-0.3.md](docs/history/spec-issues-0.3.md)). At the time, nothing of 0.3 was implemented; the protocol baseline stays 0.2. 0.2 was published and frozen on 24 October with the same text as the pinned revision.
- A 28 October ecosystem refresh: 23 checked repository heads, six new source candidates and 33 dated public discovery results. Six unsupported 0.3 declarations are distinguished from invalid supported-profile documents; historical grid and live-journey dates are preserved.

- A 23 October ecosystem refresh: 17 checked source heads, 28 dated public discovery/metadata results, Archon's new entry and current 0.2 declarations. Older Session results and grid scores retain their original dates.

- Public About and ecosystem pages at `/about` and `/about/ecosystem`. About links to the GitHub project, the Validator and the ecosystem map; the map uses the repository's Markdown, keeps historical results in a disclosure and has an About breadcrumb. The map is linked only from About; `/ecosystem` has no page or redirect.
- A signed-out MCP tool-listing scenario and four live 0.2 targets. [Live evidence](docs/history/live-0.2-testing.md) separates completed checks from those requiring sign-in.
- The official Company validator now runs against Datalayer's two 0.2 SDK Companies as well as our mock, and in file mode in the validator cross-check, over 99 documents that declare 0.2. A flawed-Company lane (`npm run interop:flaws`) gives our mock one of ten known flaws at a time and records which checkers notice: the official validator, and our adversarial and strict agents. [`spec/official-checks-0.2.json`](https://github.com/adewale/pda/blob/fea1c9f010530aac2c5dc6a50b9c4b0cb07b23d9/spec/official-checks-0.2.json) maps each of the validator's 74 checks to ours. [The lanes](https://github.com/adewale/pda/blob/fea1c9f010530aac2c5dc6a50b9c4b0cb07b23d9/interop/vectors/official/README.md).
- The interop runner checks that every token response carries `Cache-Control: no-store` (`company.token-no-store`, RFC 6749 5.1), a failure in any cell where it doesn't.
- The live lane's conversation scenario is now `CL`: its greeting says it is a test needing no action, and it closes the conversation it opens. `C`, which leaves the conversation open, runs only in the local grid, and a new local scenario, `CC`, has the Company close a conversation the agent left open: the agent must see the close, get `conversation_closed` for a later message, and start a new conversation.

- Explicit 0.1 and 0.2 profiles over the existing validator and client, with version and revision in validation reports and interop cells.
- A hash-verified, licensed copy of the 0.2 specification, guides, Operations text, official changelog, schemas and Company validator. `npm run check:spec` verifies it offline; `npm run spec:drift` compares upstream without changing the pin.
- Separate 0.2 mock and Datalayer 0.25.0 peer entries reuse the existing adapters. Historical 0.1 peers and their pins remain available. The official Company validator runs in a separate one-sided lane.
- Focused regression coverage for exact-version refusal, discovery redirects, issuer audiences, MCP DPoP/Bearer selection, approvals and cross-company prompt injection.
- A 48-entry ledger accounts for every change in the pinned official changelog. CI verifies the snapshot and ledger; the importer refuses to overwrite snapshots.
- An updated [ecosystem map](docs/ecosystem.md) and a [repeatable upgrade procedure](docs/upgrading.md).
- Fake Personal Agents for the interop grid: `lenient-personal-agent` (the reference agent), `strict-personal-agent` (refuses any departure it finds, a SHOULD included, and reports it) and `sloppy-personal-agent` (the mistakes real agents make), our agent with a profile in the adapter's network seam ([interop-spec §2.1](docs/interop-spec.md#21-the-fake-implementations)). The lenient and strict ones run in the live lane; a live Company's `liveScenarios` limits what it is sent.
- [Testing your Poppy implementation with ours](docs/testing-with-us.md), the page to send another project's maintainer.
- Proof that an interop run tests what it says: before a live run the runner fetches the live identity as a Company would and stops if it doesn't answer or doesn't hold the runner's key, and before any cell each implementation's manifest must match its registry entry (profile, version, adversarial, and the identity it signs as) ([interop-spec §8.1](docs/interop-spec.md#81-what-the-run-is)).

### Changed

- The separate Datalayer 0.2 peers advance to SDK 0.26.0 at `0ff43c5`. A rebuilt smoke passes 18 cells; the full 3×3 run records 211 pass, 7 unexempted compatibility failures and 52 unsupported, with PDA passing all 74 exercised cells. The 0.1 peers and official-validator pin are unchanged.

- The dependency security refresh moves Zod to 4.6.6, Happy DOM to 21.0.4, Vitest to 4.1.12 and the Workers test plugin to 1.4.9. Wrangler 4.154.0 and Miniflare 5.20261023.1-beta are shared with the Vite plugin through scoped overrides because its published dependencies still pin affected versions. The lockfile is regenerated with the project's `--legacy-peer-deps` install policy.

- The interop harness's own implementations are renamed so the sets pair up: `pda-mock` is `lenient-company`, `pda-mock-strict` is `strict-company`, `pda-mock-v02` is `lenient-company-v02` and `evil-agent` is `evil-personal-agent`. Commands, known failures and CI use the new names; dated results keep the old.
- Print with Poppy's grid pin moves to `3360d8b`, draft 0.2, with its `ALLOW_INTEROP_TEST_HOSTS` setting; its ordering scenario OU now passes.
- Under 0.2, discovery checks the final serving host, preserving `www.`; domains sharing an issuer must agree on `auth`. Issuers remain exact strings and continue to key User IDs and Account Tokens.
- Under 0.2, client and Session assertions name the issuer. The endpoint-audience fallback remains limited to 0.1. Assertions still live for one minute, within both versions' bounds.
- MCP authentication follows the server's protected-resource metadata. DPoP-capable 0.2 servers receive proof-bound tokens; other MCP servers receive Bearer tokens bound to their exact resource URL.
- Read and error validation, mock behavior, trace checks and known-failure matching use the selected protocol version. A 0.1 ambiguity cannot exempt a 0.2 failure.

### Fixed

- The upstream drift check reports a removed current schema as drift and continues comparing the remaining files, while preserving other HTTP failures as unavailable checks.

- Overlapping decisions on a local approval claim the pending request atomically after discovery, so an approved write is dispatched once and a competing decline cannot overwrite it.
- Transcript outcomes use the Company's exact issuer and operation ID. API proposal results retain the issuer after cards expire; older results use a card's verified domain only when it identifies one issuer, otherwise they keep waiting for a known outcome.
- The overlapping-model-call budget test seeds legacy spending with its synthetic clock, so the seven-day retention rule does not delete its fixture as calendar time advances.

- The validator reports an API type other than `openapi` or `mcp` as an error in a 0.2 document too (section 6's MUST); our client still skips the API and uses the Company. The 0.2 profile had kept the information level meant for a document newer than the validator knew. `api-type-newer` is retired.
- The validator reports a blank or whitespace-only `organization.name` as missing, as it does a missing one.
- The adversarial agent (`evil-personal-agent`) signed its assertions for the token endpoint, so against a 0.2 Company, which wants the issuer, every attack failed before it was sent. It now uses the issuer from 0.2 on.
- Live interop cells use the configured wire version and stop if discovery declares another version. Legacy live entries retain their 0.1 default.

- Removed accidental acceptance of newer draft versions under 0.1 validation rules.
- Discovery caches keep exact requested host keys. Old unversioned caches are revalidated.
- MCP session caches belong to each client and its DPoP keys, await shared initialization, clear failures and refresh metadata within its bounded cache lifetime. Account or sign-in changes invalidate the active session and tool catalogue.
- Harness retries retain their protocol context, and simultaneous runs use separate result directories.
- Versioned snapshot page names no longer collide between `0.1/spec` and `0.2/spec`.
- Legacy budget retention uses its caller's clock. Production metering retains main's durable reservations, admission-day charges and idempotent settlement outbox.
- Snapshot parsing handles versioned pages and imported walkthrough constants. The requirement table is generated from the reviewed ledger.

### Upgrading

1. Review [the requirement delta and evidence](docs/history/poppy-0.2-upgrade.md), including limitations. Do not infer complete conformance from a version number.
2. Install the existing lockfile with `npm ci --legacy-peer-deps`. Run `npm run check:spec`, `npm test`, `npm run typecheck`, and both interop lanes before deployment.
3. Storage changes are additive. Keep the existing signing and encryption keys. Do not reset User IDs, Account Tokens or consent. Discovery caches can be refreshed; pending work retains its profile context.
4. Check discovery and a read against a test Company, then sign in with a test account and approve a sandbox operation. Record the actual deployed commit and outcome before promoting this entry to a dated release.

### Validation and rollout

The combined own-code lane passes 102 cells; PDA passes all 74 exercised cross-project cells. The official validator passes 69 available checks with five skips. The full test suite passes with 1,747 tests and one intentional skip after integrating main PR #12 and the upgrade audit. Seven peer compatibility failures remain visible in [the upgrade evidence](docs/history/poppy-0.2-upgrade.md#validation). This change has not been deployed. Optional feedback submission and anonymous browsing remain separate features.

### Rollback

Return to the previous deployment with its original configuration and keys. An older 0.1-only binary cannot safely operate at a 0.2 Company: stop those tasks first. Preserve pending revocations and reconcile uncertain operation outcomes before retrying. Additive task-context records can remain in storage. See [compatibility and rollback](docs/upgrading.md#state-and-rollback).

## Baseline — 18 October 2026

Repository baseline [`d8515e7`](https://github.com/adewale/pda/commit/d8515e7be4282014c6ebcf21d156ac689f333050), before this upgrade. This is a historical marker, not an invented release number. PDA implements draft 0.1 with Operations v1, a discovery validator, strict mock, interop grid, adversarial and property tests. Earlier changes are in [Git history](https://github.com/adewale/pda/commits/main/).

## Maintaining this file

For each release, move reviewed entries from Unreleased into a dated version entry. Include Breaking Changes, Added, Changed and Fixed where relevant, followed by Upgrading, Validation and Rollback. Name the Poppy version, exact upstream revision and Operations revision; link the official changelog and local snapshot. Explain operator actions and retain unresolved gates. Never mark a deployment or check complete without its evidence.
