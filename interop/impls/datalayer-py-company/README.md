# datalayer-py (Company)

Datalayer's Python reference Company, Manzanita Outfitters (`personal_agent_protocol.company` with `personal_agent_protocol/demo/manzanita.py`), behind the interop hooks adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) section 5.3.

- **Upstream:** [datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), commit `0c048aa7fef8d98bbc23de5474220b6e7206384a` (12 October 2026, v0.10.0). The Dockerfile clones it at that commit; nothing upstream is copied into this repository.
- **Licence:** BSD 3-Clause (upstream). The adapter is ours.
- **Dependencies:** pinned in `constraints.txt`, from `pip freeze` of the first build (at v0.6.0). v0.10.0 changes no runtime dependency: `datalayer_reactor>=1.0.5` is still the floor, and the new `ui` and `telemetry` extras (Reactor 1.1, OpenTelemetry) are imported only when used.

## Moving from v0.6.0 to v0.10.0

What changed upstream that matters here:

- **Client assertion `aud`.** `_client` now accepts the issuer, the token endpoint or the endpoint called, at the token, device authorization and revocation endpoints alike (`company/service.py` lines 580-611). S1 is now `either`.
- **Assertion limits.** Client and Session assertions live at most 120 s (was five minutes) and need a `jti` of 16 to 256 characters; `typ` is still absent or `JWT` (`company/verify.py`). DPoP proofs also need a 16+ character `jti` (`crypto.py`).
- **Operations.** An Operation omits `expires_at`, `terms` and `url` when they have no value, instead of sending `null` (`models.py`). `result.data` is still `null` on a cancelled operation.
- **Mediated Sign-In** with no `scope` is now `invalid_scope`, and failed attempts lock a key out (5 failures, 15 minutes). `AccountDirectory.authenticate` takes a `SignInContext`; Manzanita's own does.
- **Other hardening:** a token in the query is refused on every route; a repeated `Authorization` or `DPoP` header is 400; a request body over 1 MiB is 413; a DPoP refusal at the token endpoint carries `WWW-Authenticate`; the consent page binds its request to the browser (`__Host-poppy_consent` cookie and a `csrf` field); the web cookie is `__Host-poppy_session`; the replay cache lives in the Company's store; an unfetchable `client_id` is remembered for 30 s; an agent's reply is framed by `working` and `idle` state events; Manzanita's agent says plainly when it can't propose an exchange to an agent that didn't declare Operations.

Adapter changes: `ManzanitaPlugin` now contributes exactly what the adapter's own subclass did (accounts, agent, the four executors, the API and the MCP server), so the adapter uses it as it is. The consent hooks still read `request_id` from the page and call `approve_authorization` and `deny_authorization` directly, which the new browser binding doesn't involve (it guards the form POST, `consent_decision`). Readings: S1 `either`, S2 `lenient-120s`.

## How it runs

One Python process (`adapter.py`, Python 3.12):

- **Port 8080:** the Company, `company_app(service)` from the SDK, served by uvicorn. Its domain and issuer come from `INTEROP_ORIGIN` (default `https://datalayer-py.company.interop.test`). The SDK rebuilds every request URL on that origin, never on the inner `Host`. uvicorn keeps idle connections 75 s rather than its default 5 s, so the proxy never reuses one uvicorn has just closed.
- **Port 8081:** the control API. Hooks call the same in-process `CompanyService`, the way the upstream tests play the user at the Company. Each hook answers its result object as the body.

`/manifest` and `/healthz` need no authentication; `/reset`, `/hooks` and `/hooks/<name>` need `Authorization: Bearer $INTEROP_SECRET`. The image leaves `/interop` absent: the runner copies its trust directory there.

## Hooks

| Hook | How |
| --- | --- |
| `fixture` | Manzanita's one account (`acct_ada`, also `otp_account`); `openapi` `GET /api/orders`; `openapi_write` `POST /api/orders/{order_id}/exchanges` with `params.order_id`; `openapi_public` `GET /api/openapi.json` (Manzanita has no signed-out API operation; its description, served at the API's own path, is the one GET that works signed out); `mcp` `list_orders`; prompts its scripted agent answers. |
| `approve_authorization`, `deny_authorization` | Opens the agent's authorization URL at the Company (in process), reads the consent form's `request_id`, then `service.approve_authorization` or `deny_authorization`. A request the Company refuses with a redirect (`invalid_scope`, ...) is returned as that redirect. |
| `approve_device`, `deny_device` | `service.approve_device`, `service.deny_device`. |
| `mediated_answers`, `last_one_time_code` | Ada's email and password; Manzanita's fixed code `246810`. |
| `propose_operation` | Reads the conversation from the store and returns the latest operation Manzanita's agent proposed in it that is still `proposed`. |
| `settle_operation` | `service.settle`, for operations left `in_progress`. |
| `end_sessions` | Deletes every Session and Session Token record from the store the adapter gave the Company; Account Tokens stay. Manzanita has no "end Session" feature, so this stands in for one. The Company then answers the old token with 401 `invalid_token`. |
| `expire_tokens` | Rewrites every stored Session Token's expiry to one second ago; the service's own expiry check then refuses it (401 `invalid_token`). |
| `require_nonce`, `rate_limit`, `staff_join`, `staff_reply` | 501: the service has no DPoP nonces, no rate limits and no staff, and the adapter doesn't fake them. |

`POST /reset` builds a new Company with an empty store.

## Relaxations

All in the adapter, none in upstream code (`patches/` is empty). The one setting is off unless its variable is `1`; the image sets it.

- `INTEROP_ALLOW_TEST_HOSTS=1`: a Reactor `pap.urlSafetyPolicy` contribution at order 0 lets the Company fetch client metadata and JWKS from `*.interop.test` hosts that resolve to private addresses. Every other host keeps the SDK's `PublicUrlSafetyPolicy`.
- The httpx client the SDK is given trusts `/interop/ca.pem` (or `SSL_CERT_FILE`).
- The organization domain and issuer are `INTEROP_ORIGIN`'s host instead of `manzanita.example`.

Manzanita's scopes are `orders:read` and `orders:write`; the `fixture` hook names them (`scopes.read`, `scopes.write`, interop spec 5.3) and scenarios sign in with them, so no scope relaxation is needed.

## Scenarios

Claimed: D, S0, SD, SV, SMC, SX, SXV, R, SE, SO, C, CI, CS, CA, AO, AS, O, OX, and since 12 October DC, W, O2 and CM: Manzanita implements Direct Conversations and close (`service.py:1720-1768`, `1939-1964`), its browser-session endpoint (`_browser_session`, `2523-2589`), a repeated confirm that returns the operation unchanged (`2283-2285`), and fetches each agent's `client_id` and `jwks_uri` when a Session starts. Not claimed:

- **SM:** Manzanita's one account always asks for a one-time code.
- **AM:** every MCP tool needs a signed-in user.
- **N, RL, H:** no nonces, no rate limits, no staff.

## Findings

Still so at v0.10.0:

- **DPoP `htu` is compared with the decoded path.** `company/asgi.py` rebuilds the URL from ASGI `scope["path"]` ([line 59](https://github.com/datalayer/personal-agent-protocol/blob/0c048aa7fef8d98bbc23de5474220b6e7206384a/personal_agent_protocol/company/asgi.py#L59)), which is percent-decoded, so a request to `/api/orders/%7Border_id%7D/exchanges` is checked against `.../{order_id}/...` and refused with 401 `invalid_dpop_proof`. It should use `raw_path`: RFC 9449 section 4.3 and RFC 3986 section 6.2.2.2 only normalize unreserved characters. Seen with `dpa` in scenario AS.
- **Its OpenAPI description doesn't declare path parameters.** `/api/orders/{order_id}/exchanges` has no `parameters` ([demo/manzanita.py lines 141-143](https://github.com/datalayer/personal-agent-protocol/blob/0c048aa7fef8d98bbc23de5474220b6e7206384a/personal_agent_protocol/demo/manzanita.py#L141-L143)), which OpenAPI 3.x requires for path templates, so a client that fills only declared parameters sends the template literally.
- **SSE closes when caught up.** `_stream` ([company/service.py lines 2034-2058](https://github.com/datalayer/personal-agent-protocol/blob/0c048aa7fef8d98bbc23de5474220b6e7206384a/personal_agent_protocol/company/service.py#L2034-L2058)) sends the backlog after `Last-Event-ID` and ends, with no keep-alive and no live events. The SDK's own client reconnects and then raises `stream_unavailable`.
- **Renewal requires `session_id`.** A `refresh_token` grant without one is `invalid_session` ([company/service.py lines 731-736](https://github.com/datalayer/personal-agent-protocol/blob/0c048aa7fef8d98bbc23de5474220b6e7206384a/personal_agent_protocol/company/service.py#L731-L736)), where Poppy 4.8 says it starts a new signed-in Session.
- **A cancelled Operation's `result.data` is `null`** ([company/service.py lines 2195-2213](https://github.com/datalayer/personal-agent-protocol/blob/0c048aa7fef8d98bbc23de5474220b6e7206384a/personal_agent_protocol/company/service.py#L2195-L2213); `OperationResult.data` defaults to `None`, [models.py line 281](https://github.com/datalayer/personal-agent-protocol/blob/0c048aa7fef8d98bbc23de5474220b6e7206384a/personal_agent_protocol/models.py#L281)). `expires_at`, `terms` and `url` are now omitted instead.
- **An ended or expired Session gets 401 `invalid_token`** ([company/service.py lines 1446-1454](https://github.com/datalayer/personal-agent-protocol/blob/0c048aa7fef8d98bbc23de5474220b6e7206384a/personal_agent_protocol/company/service.py#L1446-L1454)), never `invalid_session`.

Fixed by v0.10.0:

- Mediated Sign-In with no `scope` signed in with no scopes; it is now `invalid_scope`.
- Client assertions at the device authorization and revocation endpoints had to name that endpoint as `aud`; any of the issuer, the token endpoint and the endpoint called is now accepted.
- A proposed Operation's unset `expires_at` was `null`; it is now omitted.

## Readings

`S1: either` (assertion `aud` may be the issuer, the token endpoint or the endpoint it is sent to, at every endpoint), `S2: lenient-120s` (`typ` absent or `JWT`, lifetime at most 120 s, `jti` of 16 to 256 characters), `S4: either` (`scope` on a signed-out Session request is ignored). The issuer has no path, so S3 doesn't arise.
