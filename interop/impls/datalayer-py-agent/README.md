# datalayer-py (Personal Agent)

Datalayer's Python Personal Agent SDK (`personal_agent_protocol`) behind the interop control adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) section 5.2. The adapter calls the SDK's protocol clients directly; no model is involved.

- **Upstream:** [datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), commit `0c048aa7fef8d98bbc23de5474220b6e7206384a` (12 October 2026, v0.10.0; moved from `12d71877`, v0.6.0). The Dockerfile clones it at that commit; nothing upstream is copied into this repository.
- **Licence:** BSD 3-Clause (upstream). The adapter is ours.
- **Dependencies:** pinned in `constraints.txt`, from `pip freeze` of the first build. The SDK's dependencies and its `server` extra are the same at v0.10.0, so the file still covers them; `datalayer_reactor` 1.0.5 still meets `>=1.0.5` (1.1 is needed only by the `ui` extra, which the image doesn't install).

## How it runs

One Python process (`adapter.py`, Python 3.12):

- **Port 8080:** the agent's public identity at `INTEROP_ORIGIN` (default `https://datalayer-py.agent.interop.test`): client metadata at `/agent.json` (the `client_id`), the JWKS at `/jwks.json`, and the redirect URI `/oauth/callback`, all `Cache-Control: no-store`. uvicorn keeps idle connections 75 s, not its default 5 s: a Company polling every 5 s otherwise raced the proxy reusing a connection uvicorn had just closed ("socket hang up", then `invalid_client`), which showed once as a flaky SV cell.
- **Port 8081:** the control API. The host contributions the SDK requires are Reactor contributions, as in its own demo kit: an ES256 signer (rotated by `/reset`, with a fresh `kid`), per-Company DPoP keys, an in-memory token and state store, protected input fed from `signin_continue`, a browser handoff that records the authorization URL, and a form-POST browser for browser Sessions.

`/manifest` and `/healthz` need no authentication; `/reset` and `/step` need `Authorization: Bearer $INTEROP_SECRET`. The image leaves `/interop` absent: the runner copies its trust directory there.

## Ops

| `op` | SDK call | Notes |
| --- | --- | --- |
| `discover` | `DiscoveryClient.discover` | `apis` are types; `api_urls` is added. A document the SDK won't use is `poppy_error: discovery_failed`, status 0. |
| `session` | `SessionClient.start`, then `renew` | One Session per `label`: started once, then renewed with the same ID while signed out; a signed-in Session is returned as it is. |
| `signin` | `DirectSignInClient.begin`, `DeviceSignInClient.begin`, or the Mediated form's field names | With an Account Token already held for the Session, `AccountTokenClient.refresh` signs it in instead, and no `pending` is returned. |
| `signin_continue` | `complete`; `poll` until done; `MediatedSignInClient.sign_in`, then `submit_code` | A one-time code request returns `{"pending": {"code_required": true}}`; continue with `code`. |
| `send` | `ConversationClient.start` / `send`, then `read_events` if the Company answered with a receipt | `message_id` is the runner's retry key, mapped to one SDK-generated message ID. `wait` defaults to 5. |
| `read` | `ConversationClient.read_events` | `cursor` and `wait` as given. |
| `sse` | `ConversationClient.stream` | One stream: events until the Company ends it, `max_events` or `wait` seconds. `cursor` goes as `Last-Event-ID` (the SDK has no `?cursor`). The SDK's reconnect isn't used; a stream that ends with no event (the SDK's `stream_unavailable`) is zero events. Returns `last_id`. |
| `api` | `ApiClient.call`; `McpClient.call_tool` with a Bearer token from `SessionClient.bearer_for_mcp` or `AccountTokenClient.bearer_for_mcp` | `api` is a type or a URL. `operation` is `"METHOD /path"` or an OpenAPI `operationId`, and paths are relative to the description's first `servers` URL (its origin when it lists none); `args.params` fill the path template and the rest go in the query; `args.body` is the body. |
| `approve_op` | `OperationsClient.read`, then `confirm` with `approve(operation)`, or `cancel` | `status` is the operation's state afterwards. |
| `signout` | `AccountTokenClient.revoke` | |
| `web_join` | `BrowserSessionClient.join` | `joined` is a 302 or 303 with `Set-Cookie` from the browser-session endpoint. |
| `handoff`, `close` | `ConversationClient.handoff`, `.close` | `send` takes `parent_conversation` (`start(parent_conversation_id=)`, 7.10). Messages carry `sender`. |
| `confirm_again` | `OperationsClient.confirm` with the proposal as first seen | The SDK refuses locally only an operation handed to it in another state, so the cached proposal sends the confirm again. |
| `state` | | No token values. |

A refusal the Company sent is `{"ok": false, "poppy_error", "status"}`. The agent's own refusals (a denied sign-in's `access_denied`, a malformed answer the SDK rejects, a document it won't use) have status 0.

**Host policy (the adapter's, not the SDK's).** The SDK has no automatic recovery. As a host built on it would, the adapter answers 401 `invalid_token` or `invalid_session` by renewing the Session (Account Token refresh when signed in, otherwise the assertion), starting a new Session if the old one is gone, and retrying once. Scenarios R and SE depend on it.

## Moving from v0.6.0 to v0.10.0

None of the SDK calls the adapter makes changed signature, so `adapter.py` is unchanged. What changed underneath:

- Token, device, Account Token, MCP and DPoP responses are read only up to a limit (`send_bounded`: 100 KiB for OAuth responses, 1 MiB through `DpopHttpClient`); a larger one is `response_too_large`.
- `DpopHttpClient` never sends a request with a body to a redirect other than 303 (`redirect_refused`).
- Mediated credentials may go to the `auth.issuer` host as well as the Company's domain.
- `STANDING_PERMISSION_STORES` now lives in `reactor.py` and is a core contribution point; `operations` still re-exports it. New optional points (`pap.telemetry`, `pap.approvalSurface`) need no contribution: with none, nothing is emitted, and the approval surface is only for the CLI's live-session actions, not `OperationsClient`.
- `PublicUrlSafetyPolicy` judges an IPv4 address inside IPv6 as that address. The adapter's relaxation is unchanged.
- An `Operation` the SDK serializes omits `expires_at`, `terms` and `url` when they have no value, instead of `null` (Company side; the adapter already dumps with `exclude_none`).

The assertions the agent sends are unchanged: `aud` is the endpoint called, `typ: JWT`, a 60-second lifetime and a 22-character `jti`, within the 120 s and 16-character minimum v0.10.0's Companies now require.

## Relaxations

All in the adapter, none in upstream code (`patches/` is empty at v0.10.0 too):

- `INTEROP_ALLOW_TEST_HOSTS=1` (set in the image, off when unset): a Reactor `pap.urlSafetyPolicy` contribution at order 0 lets discovery and metadata fetches reach `*.interop.test` hosts that resolve to private addresses. Every other host keeps the SDK's `PublicUrlSafetyPolicy`.
- The httpx client the SDK is given trusts `/interop/ca.pem` (or `SSL_CERT_FILE`).

## Findings

- **Device Sign-In against a Company that requires DPoP nonces fails.** Still so at v0.10.0: `DeviceSignInClient.poll` and `_poll_token` ([`device.py` lines 200 to 287](https://github.com/datalayer/personal-agent-protocol/blob/0c048aa7fef8d98bbc23de5474220b6e7206384a/personal_agent_protocol/device.py#L200-L287)) send one token request and never retry `use_dpop_nonce`, unlike the Session, code, refresh and revocation requests. Against pi-poppy's Company: `poppy_error: use_dpop_nonce`, status 400. RFC 9449 section 8; Poppy 4.3.
- **SSE resumed from the latest event fails against Datalayer's own Companies**, which still close a caught-up stream at once at v0.10.0 (`CompanyService._stream`); the SDK's client reconnects and raises `stream_unavailable`. The adapter reports zero events instead.

## Readings

`S1: endpoint` (each client assertion's `aud` is the endpoint it is sent to: token, device authorization or revocation), `S2: jwt-60s` (`typ: JWT`, `kid`, 60-second lifetime), `S3: insertion`, `S4: omit`. The SDK retries a nonce once per request and keeps none, so S23 is not declared.
