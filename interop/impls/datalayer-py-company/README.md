# datalayer-py (Company)

Datalayer's Python reference Company, Manzanita Outfitters (`personal_agent_protocol.company` with `personal_agent_protocol/demo/manzanita.py`), behind the interop hooks adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) section 5.3.

- **Upstream:** [datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), commit `12d71877d477b93f3ee68ebdc542560ba85997b9` (11 October 2026, v0.6.0). The Dockerfile clones it at that commit; nothing upstream is copied into this repository.
- **Licence:** BSD 3-Clause (upstream). The adapter is ours.
- **Dependencies:** pinned in `constraints.txt`, from `pip freeze` of the first build.

## How it runs

One Python process (`adapter.py`, Python 3.12):

- **Port 8080:** the Company, `company_app(service)` from the SDK, served by uvicorn. Its domain and issuer come from `INTEROP_ORIGIN` (default `https://datalayer-py.company.interop.test`). The SDK rebuilds every request URL on that origin, never on the inner `Host`, so DPoP `htu` checks work behind the proxy.
- **Port 8081:** the control API. Hooks call the same in-process `CompanyService`, the way the upstream tests play the user at the Company.

`/manifest` and `/healthz` need no authentication; `/reset`, `/hooks` and `/hooks/<name>` need `Authorization: Bearer $INTEROP_SECRET`. A hook takes its params raw or as `{"params": {...}}` and answers `{"ok": true, "result": {...}}`.

## Hooks

| Hook | How |
| --- | --- |
| `fixture` | Manzanita's one account (`acct_ada`), its scopes (`orders:read orders:write`), `openapi` `{"api", "operation": "GET /api/orders"}`, `mcp` `{"api", "tool": "list_orders"}`, plus the write calls and the conversation texts the scripted company agent answers. |
| `approve_authorization` | Opens the agent's authorization URL at the Company (in process), reads the consent form's `request_id`, then `service.approve_authorization(request_id, account_id, scopes)`. A request the Company refuses with a redirect (`invalid_scope`, ...) is returned as that redirect. |
| `deny_authorization` | The same, then `service.deny_authorization`: a redirect with `error=access_denied` and `iss`. |
| `approve_device`, `deny_device` | `service.approve_device(user_code, account_id, scopes)`, `service.deny_device(user_code)`. |
| `mediated_answers` | Ada's email and password. Manzanita then asks for a one-time code. |
| `last_one_time_code` | Manzanita's fixed code, `246810`. |
| `end_sessions` | Deletes every Session and Session Token record from the store the adapter gave the Company; Account Tokens stay. The Company has no "end Session" feature, so this simulates one. Datalayer's Company then answers the old token with 401 `invalid_token` (not `invalid_session`). |
| `settle_operation` | `service.settle(operation, result, succeeded=outcome == "succeeded")`, for operations left `in_progress` (Manzanita's repair). |
| `staff_join`, `staff_reply`, `propose_operation` | 501. Manzanita has no staff (`humans_available` is false) and no way to inject a proposal: its scripted agent proposes the exchange when a signed-in user with `orders:write` asks for one ("Exchange it for something warmer"), or `POST /api/orders/ord_7Hk2/exchanges` proposes it. |

`POST /reset` builds a new Company with an empty store.

## Relaxations

All in the adapter, none in upstream code (`patches/` is empty):

- `INTEROP_ALLOW_TEST_HOSTS=1` (set in the image, off when unset): a Reactor `pap.urlSafetyPolicy` contribution at order 0 lets the Company fetch client metadata and JWKS from `*.interop.test` hosts that resolve to private addresses. Every other host keeps the SDK's `PublicUrlSafetyPolicy`.
- The httpx client the SDK is given trusts `/interop/ca.pem` (or `SSL_CERT_FILE`).
- The organization domain and issuer are `INTEROP_ORIGIN`'s host instead of `manzanita.example`.

## What works

Paired with its sibling `datalayer-py-agent`, and with `datalayer-ts-agent` and `pi-poppy-agent`, through a TLS proxy: discovery, signed-out Session, conversations, Direct, Device and Mediated Sign-In (with the one-time code), OpenAPI and MCP calls, `insufficient_scope`, operations proposed, confirmed (twice, performed once) and declined, revocation, browser Session join, and SSE. Our validator passes its `poppy.json` and OAuth metadata with no messages.

## What doesn't, or differs

- **SSE closes when caught up.** The stream sends the backlog after `Last-Event-ID` and ends, with no keep-alive and no live events (`service.py` `_stream`). The SDK's own client reconnects and then fails with `stream_unavailable`, so a stream resumed from the latest event never works, with either Datalayer client.
- **Mediated Sign-In with no `scope` signs in with no scopes** instead of `invalid_scope` (already in [poppy-issues.md](../../../docs/poppy-issues.md)). Seen in the pairing with `pi-poppy-agent`: `signed_in: true, scope: ""`.
- **Client assertions at the device authorization and revocation endpoints** must have `aud` equal to that endpoint (`service.py` lines 670 and 808), not the token endpoint or the issuer. The Datalayer clients, `datalayer-ts-agent` and `pi-poppy-agent` all send that; an agent that always uses the token endpoint would get `invalid_client`. The S1 reading only covers the token endpoint.
- **No DPoP nonces**, so scenario `N` doesn't apply; no rate limits (`RL`), no staff (`H`).

## Readings

`S1: token-endpoint` (assertion `aud` must be the token endpoint), `S2: any` (`typ` absent or `JWT`, lifetime up to five minutes), `S4: either` (`scope` on a signed-out Session request is ignored). The issuer has no path, so S3 doesn't arise.
