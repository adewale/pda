# datalayer-ts (Company)

Datalayer's TypeScript Company ([datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), `src/company/`), running its reference Company, Manzanita Outfitters (`src/demo/manzanita.ts`), behind the hooks adapter for the interop harness ([spec](../../../docs/interop-spec.md) 5.3).

- **Upstream commit:** `12d71877d477b93f3ee68ebdc542560ba85997b9` (v0.6.0), fetched inside the image. Nothing upstream is vendored here.
- **Licence:** BSD-3-Clause (upstream). The adapter is ours.
- **Build:** the runner builds this directory (same base as the agent image; `npm install --ignore-scripts`, no upstream lockfile).
- **Ports:** 8080 is the Company, served by the SDK's own `companyRequestListener` at `INTEROP_ORIGIN`. The listener rebuilds every request URL on `CompanyConfig.base`, so DPoP `htu` checks use the configured origin, not the proxy's inner request. 8081 is the hooks API.

## Hooks

The Company and the adapter run in one process; hooks call the `CompanyService` and its store directly. Results are the raw objects of spec 5.3. `/reset` builds a fresh Manzanita with an empty store. The adapter assembles Manzanita from the demo's own parts, as `manzanita()` does, so it can hand the service its store.

| Hook | Supported | How |
| --- | --- | --- |
| `approve_authorization` | yes | Opens the authorization URL on the service (as the user's browser would), reads `request_id` from the consent page, then `service.approveAuthorization`. |
| `deny_authorization` | yes | `service.denyAuthorization`: `error=access_denied`. |
| `approve_device` / `deny_device` | yes | `service.approveDevice` / `denyDevice`. |
| `mediated_answers` | yes | Ada's email and password (Manzanita has one account). |
| `last_one_time_code` | yes | Manzanita's code is fixed (`246810`). |
| `end_sessions` | yes | Deletes every Session and Session Token record. Account Tokens survive. |
| `expire_tokens` | yes | Rewrites every Session record so its tokens' expiry is in the past. |
| `propose_operation` | yes | Manzanita's agent proposes the exchange when a signed-in user asks (`fixture.prompts.operation`); the hook returns that proposal from the conversation's events. |
| `settle_operation` | yes | `service.settle`: only an operation `in_progress` can be settled (Manzanita's repair). |
| `fixture` | yes | Account `acct_ada` (also `otp_account`), `GET /api/orders`, `POST /api/orders/{order_id}/exchanges`, and prompts. No `openapi_public` (every Manzanita API call needs a sign-in) and no `mcp`. |
| `require_nonce`, `rate_limit` | 501 | The service never sends DPoP nonces and has no rate limiter; the adapter doesn't fake either. |
| `staff_join`, `staff_reply` | 501 | Manzanita has no staff. |

**Manifest:** scenarios `D S0 SD SV SXV SMC SX SE SO R C CI CS CA AO AS O OX`. Not `SM`: Manzanita's only account always asks for a one-time code (that's `SMC`). Not `N`, `RL` or `AM`. Readings: `S1: endpoint` (the assertion `aud` must equal the endpoint it's sent to; the device and revocation endpoints too), `S3: insertion` (its issuer has no path, so both forms coincide), `S4: omit`.

## Relaxations and patches

No patches. One setting:

- `organization.domain` and the issuer come from `INTEROP_ORIGIN` (Manzanita's `config.domain`, upstream default `manzanita.example`). Configuration upstream supports.

Manzanita's scopes are `orders:read` and `orders:write`, not Poppy's `poppy:*`. The `fixture` hook names them (`scopes.read`, `scopes.write`, interop spec 5.3), and scenarios sign in with them, so no scope relaxation is needed.

The default client policy allows every agent and the default URL policy checks only host strings, so `*.agent.interop.test` client metadata and JWKS need no relaxation.

## Known upstream issues seen in the grid

- **The OpenAPI description** (`ManzanitaApi.openapi()`) has templated paths (`/api/orders/{order_id}/exchanges`) with no `parameters`, so a client that fills only declared parameters sends `{order_id}` literally and gets 404. Ours now fills undeclared templates from the call's arguments by name, and refuses a call that leaves one unfilled.
- **SSE** sends the backlog after `Last-Event-ID` and closes, with no keep-alive and no live events; Datalayer's own client then gives up (`stream_unavailable`) when resuming at the latest event.
- Ended Sessions answer `401 invalid_token`, not `invalid_session`.
