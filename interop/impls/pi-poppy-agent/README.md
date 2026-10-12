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

Environment (set by the runner): `INTEROP_SECRET`, `INTEROP_NAME` (default `pi-poppy`), `INTEROP_DOMAIN`, `INTEROP_ORIGIN` (default `https://<name>.agent.interop.test`), `INTEROP_COMMIT`. The interop CA is trusted through `NODE_EXTRA_CA_CERTS`.

## Ops

| op | Support |
| --- | --- |
| `discover` | Yes. `apis` are the API types (`api_urls` has their URLs). A document pi-poppy won't use is `poppy_error: discovery_failed`, status 0. |
| `session` | Yes; one Session per Company and `label`, started on first use (by any op) and reused after. |
| `signin` / `signin_continue` | `direct`; `device` (polls up to 60 s, as the extension does); `mediated`, where a `code_required` answer is `{"pending": {"code_required": true}}` and the next `signin_continue` takes `code`. A stored Account Token that covers the scope is used first, as the extension does. A denied consent is `poppy_error: access_denied`, status 0. |
| `send` | Yes; `wait` defaults to 2 and no cursor is sent, as the extension does. `message_id` is used as the message id, so a repeat is a retry. `messages` are every message event the Company returned. |
| `read` | Yes, with `wait`. No `cursor` reads from the start. |
| `sse` | Partial: pi-poppy's `readEventStream` reads one burst, stopping at the first chunk that holds a complete frame, or after 300 ms; `wait` is ignored; `last_id` is the last event's id. The extension has no SSE tool, so `CS` is not claimed. |
| `api` | `api` is a type (`openapi`, `mcp`; the first API of that type) or a URL. OpenAPI: `operation` is an `operationId` or `"METHOD /path"`; `args.params` fill the path template and the rest go in the query; `args.body` is the JSON body. The adapter reads the OpenAPI document (the model's job in pi); `callApi` sends only GET and POST. MCP: pi-poppy mints the Bearer token (`mcpBearer`); the adapter stands in for pi's built-in MCP client with `initialize`, `notifications/initialized` and `tools/call`, passing `args` as the tool's arguments. An HTTP error is the Company's `error` with its status. |
| `web_join` | Yes (`joinBrowser`). |
| `approve_op` | `approve` confirms with a user approval built from the Company's name and summary; `decline` cancels (the extension's `poppy_operation_cancel`). |
| `signout` | Yes (`revoke`). |
| `state` | Yes, without tokens. |

Errors (spec 5.2): a Poppy or OAuth error from the Company is `{"ok": false, "poppy_error", "status"}` with the HTTP status of pi-poppy's last request. pi-poppy's own refusal (a document or response its parser rejects, a check it fails, a timeout) is `{"ok": false, "poppy_error", "status": 0, "detail"}`, with pi-poppy's message and its last request in `detail`.

## Patches and relaxations

| Patch | What | Default |
| --- | --- | --- |
| `patches/0001-interop-private-suffix.patch` | `src/net.ts` refuses any host that resolves to a private address. `PI_POPPY_INTEROP_PRIVATE_SUFFIX=.interop.test` allows private addresses for names under that suffix only; loopback is still refused. | Unset upstream; the image sets it. |

Other relaxations, with no upstream change:

- The identity documents are served by `IdentityServer`'s own handler at the interop origin on plain HTTP behind the proxy, instead of its loopback HTTPS listener (which no other machine could reach; see [poppy-issues.md](../../../docs/poppy-issues.md#pi-poppy-richardanayapi-poppy)).
- The interop CA is trusted through `NODE_EXTRA_CA_CERTS`; pi-poppy's `ca` option (`PI_POPPY_CA`) is left unset.

## Readings

`S1: endpoint` (every assertion's `aud` is the endpoint it is sent to), `S2: any` (client assertions carry `typ: "JWT"`, but Session assertions carry no `typ`; both live 60 s), `S3: append` (`{issuer}/.well-known/oauth-authorization-server`), `S4: omit` (no `scope` on a signed-out Session request), `S23: per-origin` (one nonce per origin).

## Results

In the full grid of 12 October ([summary](../../../docs/interop-results/README.md)), pi-poppy passed 102 cells, failed 45 and had 93 unsupported, every failure a known one. Its only Company with no failed cell is print-with-poppy (D and S0). With Datalayer at v0.10.0, O passes at both Datalayer Companies; OX still fails there on `result.data: null`.

Runner, 11 October 2026 (`npm run interop`), before Datalayer v0.10.0 and before our mock was split into `dpa-mock` and `dpa-mock-strict`:

- **pi-poppy Company:** every claimed scenario passes except `SE`.
- **Datalayer TypeScript Company:** passes D, S0, SD, SV, SMC, SX, SXV, C, CI, CA, SO, R, AO and AS. `O` and `OX` fail on `null` members (below), and `SE` as above.
- **Datalayer Python Company:** every cell fails at discovery: its `custom_scopes` defines `poppy:read` and `poppy:write`, which pi-poppy refuses ("custom scope names must not start with poppy:") and our validator flags (`validator.scope-reserved`).
- **dpa-mock:** every cell fails at the first Session, `invalid_grant`. The strict mock requires `typ: "JWT"` on the Session assertion, which pi-poppy doesn't send (`session-assertion.typ`).

## Known failures

- **Session ended (`SE`):** after a Company ends the Session, pi-poppy answers 401 `invalid_token` by renewing. The renewal's 400 `invalid_session` is thrown rather than recovered with a new Session (spec 4.2).
- **Nonce retry:** on `use_dpop_nonce` pi-poppy re-signs the client assertion and the proof but resends the same Session assertion, so a Company that refuses a reused `jti` refuses the retry (`session-assertion.jti-reused`: N at dpa-mock, dpa-mock-strict and adonis-agora; SVN at dpa-mock, dpa-mock-strict and pi-poppy's Company).
- **Session assertion without `typ`:** strict Companies (dpa-mock-strict, poppy-demo's Northstar, Ilmer) refuse it ([S2](../../../docs/spec-issues.md#s2)).
- **`null` for absent members:** pi-poppy's `parseOperation` accepts an optional member absent but not `null`. Datalayer answered a confirm with `"expires_at": null` ("expires_at must be a non-empty string") until v0.10.0, and still answers a cancel with `"result": {"data": null}` ("result.data must be an object"). The Company performed or cancelled the operation, but the agent reports a failure ([N41](../../../docs/spec-issues.md#n41)).
- **SSE:** a stream opened at the latest cursor, at a Company that sends nothing until there is an event (pi-poppy's own), times out after pi-poppy's 2 s.
