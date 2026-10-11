# datalayer-py (Personal Agent)

Datalayer's Python Personal Agent SDK (`personal_agent_protocol`) behind the interop control adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) section 5.2. The adapter calls the SDK's protocol clients directly; no model is involved.

- **Upstream:** [datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), commit `12d71877d477b93f3ee68ebdc542560ba85997b9` (11 October 2026, v0.6.0). The Dockerfile clones it at that commit; nothing upstream is copied into this repository.
- **Licence:** BSD 3-Clause (upstream). The adapter is ours.
- **Dependencies:** pinned in `constraints.txt`, from `pip freeze` of the first build.

## How it runs

One Python process (`adapter.py`, Python 3.12):

- **Port 8080:** the agent's public identity at `INTEROP_ORIGIN` (default `https://datalayer-py.agent.interop.test`): client metadata at `/agent.json` (the `client_id`), the JWKS at `/jwks.json`, and the redirect URI `/oauth/callback`. Served with `Cache-Control: no-store`, so a Company sees a reset's new key at once.
- **Port 8081:** the control API. The host contributions the SDK requires are made as Reactor contributions, like its own demo kit: an ES256 signer (one key, rotated by `/reset`, with a fresh `kid`), per-Company DPoP keys, an in-memory token and state store, protected input fed from `signin_continue`'s `fields`, a browser handoff that records the authorization URL, and a form-POST browser for browser Sessions.

`/manifest` and `/healthz` need no authentication; `/reset` and `/step` need `Authorization: Bearer $INTEROP_SECRET`.

## Ops

| `op` | SDK call | Notes |
| --- | --- | --- |
| `discover` | `DiscoveryClient.discover` | `apis` are the API URLs; `api_types` is added. |
| `session` | `SessionClient.start` | A new pairwise User ID per `label` (default `default`). |
| `signin` `direct` | `DirectSignInClient.begin` | Returns `{"pending": {"url"}}`. Scopes default to the method's declared scopes. |
| `signin` `device` | `DeviceSignInClient.begin` | Returns `{"pending": {"url", "user_code"}}`. |
| `signin` `mediated` | (none yet) | Returns `{"pending": {"fields": [names]}}`. |
| `signin_continue` | `complete`, `poll` (until done, up to `timeout` s), `MediatedSignInClient.sign_in` / `submit_code` | Mediated: a `code_required` answer returns `{"pending": {"fields": ["code"], "sent_to"}}`; call again with `{"fields": {"code"}}`. A `failed` mediated sign-in is `{"signed_in": false, "status": "failed"}`. `account` is always `null`: the Company doesn't say. |
| `send` | `ConversationClient.start` / `send`, then `read_events` if the Company answered with a receipt | `wait` defaults to 5; `sender` to `agent`. Returns the messages and a summary of every event after the last cursor. |
| `read` | `ConversationClient.read_events` | |
| `sse` | `ConversationClient.stream` | `cursor` is sent as `Last-Event-ID` (the SDK has no `?cursor`); stops at `max_events` or `timeout` s. |
| `api` | `ApiClient.call`; `McpClient.call_tool` with a Bearer token from `SessionClient.bearer_for_mcp` or `AccountTokenClient.bearer_for_mcp` | `operation` is `"METHOD /path"` or an OpenAPI `operationId`; `args` fill path and query parameters by name, and `args.body` (or the rest of `args`, for a write) is the body. |
| `approve_op` | `OperationsClient.confirm` with `approve(operation)`, or `cancel` | |
| `signout` | `AccountTokenClient.revoke` | |
| `web_join` | `BrowserSessionClient.join` | `joined` is a 302/303 with `Set-Cookie` from the browser-session endpoint. |
| `state` | | No token values. |

Errors: a refusal the Company sent is `{"ok": false, "poppy_error", "status"}`. A denied Direct Sign-In (the `error=access_denied` redirect) is `poppy_error: access_denied` with `status: null`, because no HTTP response carried it. When the SDK refuses what the Company sent (or a local check fails), the adapter answers 422 `{"error": <SDK code>, "detail"}`.

## Relaxations

All in the adapter, none in upstream code (`patches/` is empty):

- `INTEROP_ALLOW_TEST_HOSTS=1` (set in the image, off when unset): a Reactor `pap.urlSafetyPolicy` contribution at order 0 lets discovery and metadata fetches reach `*.interop.test` hosts that resolve to private addresses. Every other host keeps the SDK's `PublicUrlSafetyPolicy`.
- The httpx client the SDK is given trusts `/interop/ca.pem` (or `SSL_CERT_FILE`).

## What works

- **With its sibling `datalayer-py-company`:** every op above: discovery, signed-out Session, conversations (signed out, `sign_in_required`, signed in), Direct (approve and deny), Device and Mediated (with one-time code) Sign-In, OpenAPI and MCP, `insufficient_scope`, an operation proposed in conversation then confirmed twice (performed once) or declined, revocation, browser Session join, SSE, and a retried message ID.
- **With `datalayer-ts-company`:** the same, including Device, Mediated and SSE.
- **With `pi-poppy-company`:** discovery, Session (with DPoP nonces), conversations, Direct and Mediated Sign-In, OpenAPI by `operationId` (202 with an operation), MCP, revocation.
- Our validator passes its client metadata and JWKS with no messages.

## What doesn't

- **Device Sign-In against a Company that requires DPoP nonces fails.** `DeviceSignInClient.poll` sends one token request and never retries `use_dpop_nonce` (`device.py` has no nonce handling, unlike the Session, code and refresh requests). Against `pi-poppy-company`: `{"ok": false, "poppy_error": "use_dpop_nonce", "status": 400}`. RFC 9449 section 8; Poppy 4.3.
- **SSE resumed from the latest event fails against Datalayer's own Companies**, which close a caught-up stream at once; the client reconnects and raises `stream_unavailable` (see the Company README).
- **No recovery from an ended Session.** The SDK has no automatic new-Session-and-retry, so `SE` isn't claimed: after the Company's `end_sessions`, `send` returns `poppy_error: invalid_token` (401).
- Not claimed: `R` (no op drives renewal), `SE`, `H`, `DC`, `RL`.

## Readings

`S1: token-endpoint` (Session and code exchange assertions; device and revocation assertions use those endpoints), `S2: jwt-60s` (`typ: JWT`, `kid`, 60-second lifetime), `S3: insertion` (`/.well-known/oauth-authorization-server` + issuer path), `S4: omit` (no `scope` on a Session request). The SDK retries a nonce once per request and keeps none, so S23 is not declared.
