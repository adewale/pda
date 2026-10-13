# adonis-agora (Personal Agent)

The Poppy client of [`@adonis-agora/agent`](https://github.com/DavideCarvalho/adonis-agora-agent) (`packages/adonis/src/poppy-client`, version 0.80.1), for the interop grid ([docs/interop-spec.md](../../../docs/interop-spec.md)).

- **Pinned commit:** `e139b9599e61db17f85fa186f4073f81ee6bc19b`.
- **Licence:** MIT. A copy is in the image at `/licenses/`.
- **Vendoring:** nothing upstream is vendored here.

## What changed upstream (pin moved 13 October)

From `e66a232` (0.79.0) to `e139b95` (0.80.1 plus four docs commits), eight commits on 11 and 12 October: generative-UI sandbox validation and telemetry (#373), a chat-client fix that settles `send` and `resume` when aborted before the request goes out (#375), and docs. `packages/adonis/src/poppy-client/`, the only code this image bundles, is byte for byte the same, and so are its dependency pins (`jose`, `@modelcontextprotocol/sdk`). No cell should change.

## How it's built

- **The library.** The client is framework-agnostic: Node built-ins, `jose` and the MCP SDK. The Dockerfile clones the pinned commit and bundles `src/poppy-client/index.ts` into one ESM file with esbuild. `jose` and `@modelcontextprotocol/sdk` are installed at the versions the package pins.
- **The adapter.** `app/adapter.mjs` calls the library's protocol functions directly:
  - `PoppyAgent.company`, `CompanyClient.token`;
  - `startDirectSignIn` and `completeDirectSignIn`;
  - `tokens.deviceAuthorization` and `pollDeviceSignInOnce`;
  - `mediatedSignIn` and `submitMediatedCode`;
  - `ConversationClient`, `callOpenApi`, `connectMcp`, `createBrowserAssertion`, `signOut`.

  It never uses the library's LLM mode or CLI.
- **Port 8080.** The library's own `startIdentityServer` serves `/agent.json`, `/jwks.json`, `/logo.svg` and `/oauth/callback` there.
- **State.** Everything is kept in memory in `StateStore.memory()`.

## Run

```sh
docker build -t adonis-agora-agent interop/impls/adonis-agora-agent
docker run --network <net> -e INTEROP_SECRET=<secret> -e INTEROP_ORIGIN=https://adonis-agora.agent.interop.test adonis-agora-agent
# then: docker cp <trust dir> <container>:/interop   (the image has no /interop; the entrypoint is in /interop-adapter)
```

- The proxy routes `adonis-agora.agent.interop.test` to the container's port 8080. The control API is on 8081.
- `INTEROP_ORIGIN` sets the identity origin, falling back to `AGENT_ORIGIN`.

## Adapter (spec 5.2)

| Op | Support |
| --- | --- |
| `discover`, `session` | Yes. `apis` is the list of API types. `label` is ignored: there's one Session per Company. |
| `signin` | `direct` returns `{pending: {url}}`. `device` returns `{pending: {url, user_code}}`. `mediated` returns `{pending: {fields}}`. If an Account Token already covers the scopes, it renews with it and returns `{signed_in: true}` (4.8). Scopes default to every scope the sign-in type offers. |
| `signin_continue` | Direct takes `callback_url`, or the last callback the identity server received. Device polls at the Company's `interval` for up to 90 s. Mediated takes `fields`; if the Company wants a one-time code it answers `{pending: {code_required: true}}`, and a second call with `{code}` completes it. `account` is always `null`: the client doesn't learn it. |
| `send`, `read` | Yes. `message_id` is a retry key: the same key sends the same message with the same id. A `send`'s `wait` defaults to 10 s; after the POST answers, the adapter keeps reading until the Company is no longer `working`. `read` passes `wait` through. |
| `sse` | Yes, through `CompanyClient.fetch` and the library's `parseSse`. It stops after `wait` seconds of quiet (default 1), or after 10 s. It returns `{events, last_id}`, where `data` is parsed JSON. |
| `api` | `api` is the type. OpenAPI by `operationId`, or by `"METHOD /path"` for an operation without one (spec 5.2), through `callOpenApi`, which resolves the path against the description's `servers`: `args.params` fill path templates, then the query string, and `args.body` is the body. MCP by `tool`, through `connectMcp`. |
| `web_join` | Yes. The adapter POSTs the library's browser assertion as a form, as its one-shot page makes a browser do. Joined means 3xx with a cookie. |
| `signout`, `state` | Yes. `state` carries no token values. |
| `handoff`, `close` | Yes: the library's `ConversationClient.handoff` and `.close`. `send` takes `parent_conversation` (7.10) and `sender`. |
| `approve_op` | 501: the client doesn't implement the Operations extension. |

`/reset` generates new keys (a new `kid`), new state, and restarts the identity server.

The agent's own refusals answer `{ok: false, poppy_error, status: 0}`. Discovery failures become `discovery_failed`.

## Readings

| Id | Reading | What the client sends |
| --- | --- | --- |
| S1 | `token-endpoint` | Client assertions use the token endpoint as `aud`, including for revocation. The library can be set to use the issuer instead. |
| S2 | `any` | Assertions last 60 s and have no `typ` header. |
| S3 | `insertion` | Metadata is fetched at the RFC 8414 insertion URL. |
| S4 | `omit` | No `scope` on a signed-out Session request. |
| S23 | `per-origin` | Nonces are remembered per origin. |

## Relaxations

There are no patches. The only relaxation is CA trust: the entrypoint adds `/interop/ca.pem` to the system store and sets `NODE_EXTRA_CA_CERTS`.

The client applies no SSRF or private-address checks of its own, and it accepts `*.interop.test`.

## Verified with the runner

| Run | Pass | Fail | Unsupported | Error |
| --- | --- | --- | --- | --- |
| `--agents adonis-agora --companies adonis-agora` | 18 | 0 | 4 (R, AM, O, OX) | 0 |
| `--agents adonis-agora --companies dpa-mock` | 1 (D) | 19 | 2 (O, OX) | 0 |

- The adonis × adonis row includes the AS rerun after a host CSRF fix.
- Every dpa-mock failure is the same: `client-assertion.typ` ("header typ must be \"JWT\", got undefined"), blamed on the agent by rule 1 (violation). The client signs assertions without `typ`.

## Verified by hand (before the runner)

Paired with [`adonis-agora-company`](../adonis-agora-company) behind a TLS stand-in proxy, every op above passed, including the nonce profile and recovery after the Company ended the Session.

Known gaps:

- After the agent signs out of one account, a Mediated Sign-In for a *different* account on the same Session gets `account_mismatch` from the Company. Unlike the refresh path, the library's mediated path doesn't start a new Session on `account_mismatch`.
- Client assertions carry no `typ: "JWT"`. A Company that requires it, as poppy-demo's does, will answer `invalid_client`.

## The full grid (runner, run 2026-10-11T16:46:10Z)

A dated snapshot from the 11 October grid. The latest results for every pair are in [docs/interop-results/README.md](../../../docs/interop-results/README.md), and each project's totals in [the ecosystem scorecard](../../../docs/ecosystem.md#scorecard).

| Company | Pass | Fail |
| --- | --- | --- |
| adonis-agora | D S0 N SD SV SM SMC SX SXV C CI CS CA SO SE AO AS RL | none |
| poppyseed | D S0 SD SM SMC SX C CI CS CA SE AO AM AS | SV, SXV, SO |
| dpa-mock | D | everything else it ran (19) |
| poppy-demo | D | S0 SD SX C CI CA SO AO AS |
| Ilmer | D | S0 C CI |

- **dpa-mock, poppy-demo, Ilmer.** The client signs assertions without `typ: "JWT"`, and all three require it: dpa-mock records `client-assertion.typ`, Northstar answers `invalid_grant` (reported as `invalid_client`), and Ilmer answers `invalid_client`. The draft leaves `typ` open (S2), but every strict Company refuses an assertion without it.
- **poppyseed SV, SXV, SO.** The client assertion's `aud` is the token endpoint even at the device authorization and revocation endpoints. poppyseed wants the URL of the endpoint the assertion is sent to, and answers `invalid_client` "assertion signature or claims are invalid".
