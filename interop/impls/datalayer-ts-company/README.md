# datalayer-ts (Company)

Datalayer's TypeScript Company ([datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), `src/company/`), running its reference Company, Manzanita Outfitters (`src/demo/manzanita.ts`), behind the hooks adapter for the interop harness ([spec](../../../docs/interop-spec.md) 5.3).

- **Upstream commit:** `00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65` (v0.17.0, 13 October 2026; moved from `0c048aa7`, v0.10.0, on 13 October, and from `12d71877`, v0.6.0, on 12 October), fetched inside the image. Nothing upstream is vendored here.
- **Licence:** BSD-3-Clause (upstream). The adapter is ours.
- **Build:** the runner builds this directory (same base as the agent image; `npm install --ignore-scripts`, no upstream lockfile; `package.json`'s dependencies and the build script are unchanged at v0.17.0).
- **Ports:** 8080 is the Company, served by the SDK's own `companyRequestListener` at `INTEROP_ORIGIN`. The listener rebuilds every request URL on `CompanyConfig.base`, so DPoP `htu` checks use the configured origin, not the proxy's inner request. 8081 is the hooks API.

## Hooks

The Company and the adapter run in one process; hooks call the `CompanyService` and its store directly. Results are the raw objects of spec 5.3. `/reset` builds a fresh Manzanita with an empty store. The adapter assembles Manzanita from the demo's own parts, as `manzanita()` does (accounts, agent, the four executors, the OpenAPI API and, since v0.10.0, the MCP server), so it can hand the service its store.

| Hook | Supported | How |
| --- | --- | --- |
| `approve_authorization` | yes | Opens the authorization URL on the service (as the user's browser would), reads `request_id` from the consent page, then `service.approveAuthorization`. The consent page's browser binding (v0.8.0: a `__Host-poppy_consent` cookie and a `csrf` field) guards only the form's POST (`consentDecision`), which the hook doesn't use. |
| `deny_authorization` | yes | `service.denyAuthorization`: `error=access_denied`. |
| `approve_device` / `deny_device` | yes | `service.approveDevice` / `denyDevice`. |
| `mediated_answers` | yes | Ada's email and password (Manzanita has one account). |
| `last_one_time_code` | yes | Manzanita's code is fixed (`246810`). |
| `end_sessions` | yes | Deletes every Session and Session Token record. Account Tokens survive. |
| `expire_tokens` | yes | Rewrites every Session record so its tokens' expiry is in the past. |
| `propose_operation` | yes | Manzanita's agent proposes the exchange when a signed-in user asks (`fixture.prompts.operation`) and the agent declared the Operations extension; the hook returns that proposal from the conversation's events. |
| `settle_operation` | yes | `service.settle`: only an operation `in_progress` can be settled (Manzanita's repair). |
| `fixture` | yes | Account `acct_ada` (also `otp_account`), `GET /api/orders`, `POST /api/orders/{order_id}/exchanges`, the MCP tool `list_orders`, and prompts. No `openapi_public` (every Manzanita API call needs a sign-in). |
| `require_nonce`, `rate_limit` | 501 | The service never sends DPoP nonces and has no rate limiter; the adapter doesn't fake either. |
| `staff_join`, `staff_reply` | 501 | Manzanita has no staff. |

**Manifest:** scenarios `D S0 SD SV SXV SMC SX SE SO R C CI CS CA AO AS O OX DC W O2 CM`: Manzanita has Direct Conversations and close (`service.ts:2223-2275`, `2462-2493` at v0.17.0), a browser-session endpoint (`#browserSession`, `3000-3031`), a repeated confirm that returns the operation unchanged (`2838-2841`), and fetches each agent's `client_id` and keys when a Session starts. Not `H`: Manzanita has no staff, so nothing can play `staff_join`. Not `SM`: Manzanita's only account always asks for a one-time code (that's `SMC`). Not `N` or `RL`; not `AM`, since every Manzanita MCP tool needs a signed-in user. Readings: `S1: either` (the assertion `aud` may be the issuer, the token endpoint or the endpoint it's sent to, at the token, device and revocation endpoints alike), `S2: lenient-120s` (`typ` absent or `JWT`, at most 120 s, `jti` of 16 to 256 characters), `S3: insertion` (its issuer has no path, so both forms coincide), `S4: omit`.

## Moving from v0.10.0 to v0.17.0 (what changed upstream)

21 commits on 12 and 13 October. In the Company (`src/company/service.ts`, `store.ts`, `points.ts`, `index.ts`); `verify.ts` and `src/demo/manzanita.ts` are unchanged, and so is `adapter.mjs`:

- **A scope no longer offered ends the Session** (0.13.0): `#offers` refuses a Session holding a scope the configuration doesn't offer with `invalid_token` (`#caller`, the MCP server), and a refresh asking for one with `invalid_scope`. Manzanita offers every scope the fixture names, so nothing in the grid reaches it.
- **A password reset ends earlier sign-ins** (0.15.0): an `AccountDirectory` that also answers `signedOutBefore` makes the service refuse and revoke a sign-in from before that time; Account Tokens carry `signedInAt`. Manzanita's accounts don't answer it.
- **Telemetry** (0.16.0): every request runs under an `AsyncLocalStorage` record, and identity checks, Sessions, interface switches, sign-outs and refusals are reported to `pap.telemetry`. The adapter contributes no sink.
- **Reactor displays** (`src/ui.ts`): `PapConfirm`, `PapOutcome`, `PapReplies`.

No cell should change.

## Moving from v0.6.0 to v0.10.0

What changed upstream that matters here (`src/company/service.ts`, `verify.ts`, `index.ts` and `src/demo/manzanita.ts`):

- **Client assertion `aud`.** `#client` verifies against the issuer, the token endpoint and the endpoint called (line 723), and serves the token, device and revocation endpoints. S1 is now `either`.
- **Assertion limits.** Client and Session assertions live at most 120 s (was five minutes), with a `jti` of 16 to 256 characters and a string `aud`; DPoP proofs also need a 16+ character `jti`.
- **Operations.** A confirmed Operation omits `expires_at` instead of sending `null` (line 2670). A proposal still carries `confirmation: null` and `result: null`, and a cancelled one `result.data: null` (line 2563). Confirming checks the scopes recorded with the proposal.
- **Mediated Sign-In** with a missing or unknown `scope` is `invalid_scope`; failed attempts lock a key out (5 failures, then 15 minutes, doubling); `authenticate` takes a `SignInContext`, which Manzanita's accounts accept.
- **MCP and web.** Manzanita now serves an MCP server at `/mcp` (Bearer Session Tokens issued for that `url` only, tokens requested without DPoP) and `web` (a browser-session endpoint and a page per operation). A token request without a DPoP header is now read as a request for an MCP Bearer token.
- **Conversations.** A reply is framed by `working` and `idle` state events; a retried start answers only the conversation's owner.
- **Other hardening:** a token in any query is refused; a repeated `Authorization` or `DPoP` header is 400; a malformed body is 400 `invalid_request`, not 500; a DPoP refusal at the token endpoint carries `WWW-Authenticate`; the client policy is asked before a `client_id` is fetched; the replay cache lives in the Company's store.
- **Fetching agents' metadata.** `buildCompany` now defaults to `createResolvingFetch()`, which resolves the host and refuses it if any address isn't global unicast. That is what the one new relaxation below is for.

## Relaxations and patches

No patches. Two settings:

- `organization.domain` and the issuer come from `INTEROP_ORIGIN` (Manzanita's `config.domain`, upstream default `manzanita.example`). Configuration upstream supports.
- `INTEROP_ALLOW_TEST_HOSTS=1` (set in the image, off when unset): the adapter passes `buildCompany` a `fetch` that is the SDK's own `createResolvingFetch()`, except that `*.interop.test` names go through `createResolvingFetch({ allowPrivateNetworks: true })`, because the grid's agents live on the run's private network. Every other host keeps the SDK's default. The SDK's `fetch` option is the documented way to replace the transport ("a test network, an egress proxy").

Manzanita's scopes are `orders:read` and `orders:write`, not Poppy's `poppy:*`. The `fixture` hook names them (`scopes.read`, `scopes.write`, interop spec 5.3), and scenarios sign in with them, so no scope relaxation is needed.

The default client policy allows every agent.

## Known upstream issues seen in the grid

Still present at `00216eb7` (v0.17.0):

- **The OpenAPI description** (`ManzanitaApi.openapi()`, [`src/demo/manzanita.ts` lines 203-223](https://github.com/datalayer/personal-agent-protocol/blob/00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65/src/demo/manzanita.ts#L203-L223)) has templated paths (`/api/orders/{order_id}/exchanges`) with no `parameters`, so a client that fills only declared parameters sends `{order_id}` literally and gets 404. Ours fills undeclared templates from the call's arguments by name, and refuses a call that leaves one unfilled.
- **SSE** (`#stream`, [`src/company/service.ts` lines 2573-2594](https://github.com/datalayer/personal-agent-protocol/blob/00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65/src/company/service.ts#L2573-L2594)) sends the backlog after `Last-Event-ID` and closes, with no keep-alive and no live events; Datalayer's own client then gives up (`stream_unavailable`) when resuming at the latest event.
- **Renewal requires `session_id`.** A `refresh_token` grant without one is `invalid_session` ([lines 1009-1016](https://github.com/datalayer/personal-agent-protocol/blob/00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65/src/company/service.ts#L1009-L1016)), where Poppy 4.8 says it starts a new signed-in Session.
- **A cancelled Operation's `result.data` is `null`** ([line 2761](https://github.com/datalayer/personal-agent-protocol/blob/00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65/src/company/service.ts#L2761)).
- Ended Sessions answer `401 invalid_token`, not `invalid_session` (`#caller`, lines 1922-1942).

Fixed by v0.10.0: device authorization and revocation requests had to name that endpoint as `aud` (now any of the three); a confirmed Operation's `expires_at` was `null` (now omitted); Mediated Sign-In without `scope` signed in with no scopes (now `invalid_scope`).
