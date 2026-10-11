# datalayer-py (Company)

Datalayer's Python reference Company, Manzanita Outfitters (`personal_agent_protocol.company` with `personal_agent_protocol/demo/manzanita.py`), behind the interop hooks adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) section 5.3.

- **Upstream:** [datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), commit `12d71877d477b93f3ee68ebdc542560ba85997b9` (11 October 2026, v0.6.0). The Dockerfile clones it at that commit; nothing upstream is copied into this repository.
- **Licence:** BSD 3-Clause (upstream). The adapter is ours.
- **Dependencies:** pinned in `constraints.txt`, from `pip freeze` of the first build.

## How it runs

One Python process (`adapter.py`, Python 3.12):

- **Port 8080:** the Company, `company_app(service)` from the SDK, served by uvicorn. Its domain and issuer come from `INTEROP_ORIGIN` (default `https://datalayer-py.company.interop.test`). The SDK rebuilds every request URL on that origin, never on the inner `Host`.
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

All in the adapter, none in upstream code (`patches/` is empty). Each is off unless its variable is `1`; the image sets both.

- `INTEROP_ALLOW_TEST_HOSTS=1`: a Reactor `pap.urlSafetyPolicy` contribution at order 0 lets the Company fetch client metadata and JWKS from `*.interop.test` hosts that resolve to private addresses. Every other host keeps the SDK's `PublicUrlSafetyPolicy`.
- `INTEROP_POPPY_SCOPES=1`: the scenarios ask for `poppy:read` and `poppy:write`; Manzanita knows `orders:read` and `orders:write` and refuses anything else with `invalid_scope`. In this mode the Company also offers the two poppy scopes, and its agent, API and MCP server are wrapped to read them as the orders scopes they stand for. `write_scopes` becomes `poppy:write` alone, because the service requires every write scope to confirm an operation. The poppy names get no `custom_scopes` description: `poppy:` names are reserved (our validator flags it, and our agent refuses the discovery document).
- The httpx client the SDK is given trusts `/interop/ca.pem` (or `SSL_CERT_FILE`).
- The organization domain and issuer are `INTEROP_ORIGIN`'s host instead of `manzanita.example`.

## Scenarios

Claimed: D, S0, SD, SV, SMC, SX, SXV, R, SE, SO, C, CI, CS, CA, DC, AO, AS, W, O, O2, OX. Not claimed:

- **SM:** Manzanita's one account always asks for a one-time code.
- **AM:** every MCP tool needs a signed-in user.
- **N, RL, H:** no nonces, no rate limits, no staff.

## Findings

- **DPoP `htu` is compared with the decoded path.** `company/asgi.py` rebuilds the URL from ASGI `scope["path"]`, which is percent-decoded, so a request to `/api/orders/%7Border_id%7D/exchanges` is checked against `.../{order_id}/...` and refused with 401 `invalid_dpop_proof`. It should use `raw_path`: RFC 9449 section 4.3 and RFC 3986 section 6.2.2.2 only normalize unreserved characters. Seen with `dpa` in scenario AS.
- **Its OpenAPI description doesn't declare path parameters.** `/api/orders/{order_id}/exchanges` has no `parameters`, which OpenAPI 3.x requires for path templates, so a client that fills only declared parameters (ours) sends the template literally.
- **SSE closes when caught up.** `_stream` sends the backlog after `Last-Event-ID` and ends, with no keep-alive and no live events. The SDK's own client reconnects and then raises `stream_unavailable`.
- **Mediated Sign-In with no `scope` signs in with no scopes** instead of `invalid_scope` (already in [poppy-issues.md](../../../docs/poppy-issues.md)).
- **Client assertions at the device authorization and revocation endpoints** must have `aud` equal to that endpoint (`service.py` lines 670 and 808). The S1 reading only covers the token endpoint.
- **An ended or expired Session gets 401 `invalid_token`**, never `invalid_session`.

## Readings

`S1: token-endpoint` (assertion `aud` must be the token endpoint), `S2: any` (`typ` absent or `JWT`, lifetime up to five minutes), `S4: either` (`scope` on a signed-out Session request is ignored). The issuer has no path, so S3 doesn't arise.
