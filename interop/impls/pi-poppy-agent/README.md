# pi-poppy Personal Agent (interop adapter)

[pi-poppy](https://github.com/richardanaya/pi-poppy) is a Personal Agent extension for the pi coding agent, by Richard Anaya. This directory runs its `PersonalAgent` (`src/agent.ts`) behind the adapter API in [docs/interop-spec.md](../../../docs/interop-spec.md) section 5.2. The adapter calls `PersonalAgent` in the order pi-poppy's own extension (`index.ts`) does; no model is involved.

- **Upstream:** https://github.com/richardanaya/pi-poppy, commit `11ea10630180740f16ccd507b8f90f69870c7e32` (9 October 2026). Fetched by the Dockerfile; nothing is vendored.
- **Licence:** MIT (upstream). The adapter is ours.
- **Runtime:** Node 22 with `--experimental-strip-types`, as pi-poppy's own tests run. pi-poppy's `src/` imports only `node:` builtins, so there is no `npm install`.
- **Registry name:** `pi-poppy`, role `agent`.
- **Prior art:** everruns' [`scripts/poppy-interop.sh`](https://github.com/everruns/everruns/blob/main/scripts/poppy-interop.sh) (PR #4531) runs `PersonalAgent` at the same commit against everruns' Company. It primes the Company's document cache instead of relaxing pi-poppy's address checks, and redirects DNS to loopback. Here the agent's documents are served at a real interop name instead, so no cache priming is needed.

## Ports

| Port | What |
| --- | --- |
| 8080 | pi-poppy's `IdentityServer` request handler on plain HTTP, reached through the proxy as `https://pi-poppy.agent.interop.test`: `/agent.json` (the `client_id`), `/jwks.json`, `/logo.png`, `/oauth/callback`. |
| 8081 | Control API: `GET /manifest`, `GET /healthz`, `POST /reset`, `POST /step`, and `GET /log` (method, URL and status of every request pi-poppy made). |

Environment: `INTEROP_SECRET`, `INTEROP_NAME` (default `pi-poppy`), `INTEROP_ORIGIN` (default `https://<name>.agent.interop.test`). The interop CA is trusted through `NODE_EXTRA_CA_CERTS`.

## Ops

| op | Support |
| --- | --- |
| `discover` | Yes. `apis` are the API URLs. |
| `session` | Yes. `label` keys separate Sessions. |
| `signin` / `signin_continue` | `direct`, `device` (polls up to 60 s, as the extension does) and `mediated` (a second `signin_continue` with `fields.code` answers a one-time code). A stored Account Token that covers the scope is used first, as the extension does. A denied consent returns `{"ok": false, "poppy_error": "access_denied", "status": 302}`. |
| `send` | Yes; `wait` defaults to 2 and no cursor is sent, as the extension does. `messages` are every message event the Company returned. |
| `read` | Yes. No `cursor` reads from the start. |
| `sse` | Partial: pi-poppy reads one burst, stopping at the first complete frame or after 300 ms. |
| `api` | OpenAPI: `operation` may be an `operationId` or `"METHOD /path"`; the adapter reads the OpenAPI document (the model's job in pi). `callApi` sends only GET and POST. MCP: pi-poppy mints the Bearer token (`mcpBearer`); the adapter stands in for pi's built-in MCP client with `initialize`, `notifications/initialized` and `tools/call`. |
| `web_join` | Yes (`joinBrowser`). |
| `approve_op` | `approve` confirms with a user approval built from the Company's name and summary; `decline` cancels (the extension's `poppy_operation_cancel`). |
| `signout` | Yes (`revoke`). |
| `state` | Yes, without tokens. |

Errors: a Poppy or OAuth error from the Company is `{"ok": false, "poppy_error", "status"}`, with the status of pi-poppy's last request. A check pi-poppy itself refused (for example a document that doesn't parse) is HTTP 422 `agent_refused` with the message and the last request.

## Patches and relaxations

| Patch | What | Default |
| --- | --- | --- |
| `patches/0001-interop-private-suffix.patch` | `src/net.ts` refuses any host that resolves to a private address. `PI_POPPY_INTEROP_PRIVATE_SUFFIX=.interop.test` allows private addresses for names under that suffix only; loopback is still refused. | Unset upstream; the image sets it. |

Other relaxations, with no upstream change:

- The identity documents are served by `IdentityServer`'s own handler at the interop origin on plain HTTP behind the proxy, instead of its loopback HTTPS listener (which no other machine could reach; see [poppy-issues.md](../../../docs/poppy-issues.md#pi-poppy-richardanayapi-poppy)).
- The interop CA is trusted through `NODE_EXTRA_CA_CERTS`; pi-poppy's `ca` option (`PI_POPPY_CA`) is left unset.

## Readings

`S1: token-endpoint` (every assertion's `aud` is the endpoint it is sent to), `S3: append` (`{issuer}/.well-known/oauth-authorization-server`), `S4: omit` (no `scope` on a signed-out Session request), `S23: per-origin` (one nonce per origin). S2 is not declared: client assertions carry `typ: "JWT"`, but Session assertions carry no `typ`; both live 60 s.

## Checked by hand

Through a stand-in for the runner (one TLS proxy with a per-run CA, as in spec section 3):

- **pi-poppy agent → pi-poppy Company (nonces required):** discover, Session, send, Direct Sign-In through `approve_authorization`, denied sign-in, Device Sign-In, Mediated Sign-In with a one-time code, signed-in send, retry with the same message id, staff reply, OpenAPI and MCP calls, proposal from a conversation and through `propose_operation`, confirm, web join and sign-out all pass.
- **pi-poppy agent → Datalayer TypeScript and Python Companies:** discover, Session, send, Direct Sign-In, signed-in send, OpenAPI call (and MCP on Python) pass. Confirming an operation fails: the Company's confirm answers 200 with `"expires_at": null`, and pi-poppy's `parseOperation` throws `expires_at must be a non-empty string` (it accepts the member absent, not null), so the agent reports a failure for an operation the Company performed.

## Known failures

- After a Company ends the Session, pi-poppy answers 401 `invalid_token` by renewing, and the renewal's 400 `invalid_session` is thrown rather than recovered with a new Session (`SE` is not claimed).
- Operations whose confirm response has `expires_at: null` (Datalayer) are reported as failed.
- `sse` is a single short burst; `CS` is not claimed. There are no ops for handoff or Direct Conversations in spec 5.2, so `H` and `DC` are not claimed.
