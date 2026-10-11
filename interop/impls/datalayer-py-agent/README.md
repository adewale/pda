# datalayer-py (Personal Agent)

Datalayer's Python Personal Agent SDK (`personal_agent_protocol`) behind the interop control adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) section 5.2. The adapter calls the SDK's protocol clients directly; no model is involved.

- **Upstream:** [datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), commit `12d71877d477b93f3ee68ebdc542560ba85997b9` (11 October 2026, v0.6.0). The Dockerfile clones it at that commit; nothing upstream is copied into this repository.
- **Licence:** BSD 3-Clause (upstream). The adapter is ours.
- **Dependencies:** pinned in `constraints.txt`, from `pip freeze` of the first build.

## How it runs

One Python process (`adapter.py`, Python 3.12):

- **Port 8080:** the agent's public identity at `INTEROP_ORIGIN` (default `https://datalayer-py.agent.interop.test`): client metadata at `/agent.json` (the `client_id`), the JWKS at `/jwks.json`, and the redirect URI `/oauth/callback`, all `Cache-Control: no-store`.
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
| `state` | | No token values. |

A refusal the Company sent is `{"ok": false, "poppy_error", "status"}`. The agent's own refusals (a denied sign-in's `access_denied`, a malformed answer the SDK rejects, a document it won't use) have status 0.

**Host policy (the adapter's, not the SDK's).** The SDK has no automatic recovery. As a host built on it would, the adapter answers 401 `invalid_token` or `invalid_session` by renewing the Session (Account Token refresh when signed in, otherwise the assertion), starting a new Session if the old one is gone, and retrying once. Scenarios R and SE depend on it.

## Relaxations

All in the adapter, none in upstream code (`patches/` is empty):

- `INTEROP_ALLOW_TEST_HOSTS=1` (set in the image, off when unset): a Reactor `pap.urlSafetyPolicy` contribution at order 0 lets discovery and metadata fetches reach `*.interop.test` hosts that resolve to private addresses. Every other host keeps the SDK's `PublicUrlSafetyPolicy`.
- The httpx client the SDK is given trusts `/interop/ca.pem` (or `SSL_CERT_FILE`).

## Findings

- **Device Sign-In against a Company that requires DPoP nonces fails.** `DeviceSignInClient.poll` sends one token request and never retries `use_dpop_nonce`; `device.py` has no nonce handling, unlike the Session, code, refresh and revocation requests. Against pi-poppy's Company: `poppy_error: use_dpop_nonce`, status 400. RFC 9449 section 8; Poppy 4.3.
- **SSE resumed from the latest event fails against Datalayer's own Companies**, which close a caught-up stream at once; the SDK's client reconnects and raises `stream_unavailable`. The adapter reports zero events instead.

## Readings

`S1: endpoint` (each client assertion's `aud` is the endpoint it is sent to: token, device authorization or revocation), `S2: jwt-60s` (`typ: JWT`, `kid`, 60-second lifetime), `S3: insertion`, `S4: omit`. The SDK retries a nonce once per request and keeps none, so S23 is not declared.
