# datalayer-ts (agent)

Datalayer's TypeScript Personal Agent SDK ([datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), `src/`), behind an adapter for the interop harness ([spec](../../../docs/interop-spec.md) 5.2).

- **Upstream commit:** `00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65` (v0.17.0, 13 October 2026; moved from `0c048aa7`, v0.10.0, on 13 October, and from `12d71877`, v0.6.0, on 12 October), fetched inside the image. Nothing upstream is vendored here.
- **Licence:** BSD-3-Clause (upstream). The adapter is ours.
- **Build:** the runner builds this directory. Upstream has no lockfile at this commit, so `npm install` resolves dependency versions within its `package.json` ranges; installs run with `--ignore-scripts`.
- **Ports:** 8080 serves the agent's identity (`/agent.json` is the `client_id`, `/jwks.json`, `/oauth/callback`) at `INTEROP_ORIGIN`. 8081 is the control API.
- **Environment:** the runner's `INTEROP_*` variables and `NODE_EXTRA_CA_CERTS`. The image must not create `/interop`: the runner copies the CA directory there.

## How the adapter drives the SDK

`adapter.mjs` assembles a Reactor host the way Datalayer's own pairing tests do (`src/__tests__/support/world.mjs`): an ES256 `JoseSigner` for client assertions, a `JoseDpopProofProvider` with one key per Company, in-memory token and authorization-state stores, a browser handoff that only records the authorization URL, and a protected-input contribution answered from `signin_continue`. Every step calls the SDK's clients (`discoverCompany`, `SessionClient`, `DirectSignInClient`, `DeviceSignInClient`, `MediatedSignInClient`, `ConversationClient`, `DpopFetchClient`, `McpClient`, `OperationsClient`, `AccountTokenClient`). No model is involved. `/reset` rebuilds the host with a new signing key (new `kid`) and forgets every Company.

The SDK leaves some decisions to its host, so the adapter makes them, as a host would:

- **Renewal.** A `401 invalid_token` renews once and retries: with the Account Token (`AccountTokenClient.refresh`) when signed in, otherwise `SessionClient.renew`. `invalid_session` starts a new Session and signs it in again with the Account Token.
- **Sign-in reuse.** `signin` with scopes the stored Account Token already covers signs the Session in without asking the user.
- **Retry keys.** `send`'s `message_id` is a key: the same key resends the same request, with the same message and wire id (128 random bits). A retried first message starts the conversation again, as the Python adapter does; it isn't sent to the conversation it started, which poppy-demo, poppyseed, Ilmer and adonis-agora refuse with `message_id_conflict` (spec issue S9).

| op | Supported | Notes |
| --- | --- | --- |
| `discover` | yes | A document the SDK refuses is `poppy_error: discovery_failed`, status 0. |
| `session` | yes | Returns the Session already held, or starts one. |
| `signin` | yes | `direct` returns `pending.url`; `device`, `url` and `user_code`; `mediated`, the field names. |
| `signin_continue` | yes | Direct: `callback_url` (an `error=` callback is `poppy_error` with status 0). Device: polls until the Company answers (60 s). Mediated: `fields`, then `code` after `{"pending": {"code_required": true}}`. |
| `send`, `read` | yes | `wait` is passed to the Company. Results add `operations` (proposals seen), `cursor` and the raw `events`. |
| `sse` | yes | Up to `max_events`, for about `wait` seconds; returns `last_id`. |
| `api` | yes | OpenAPI: `operation` is `"METHOD /path"` or an `operationId`; `args.params` fill path templates, the rest go in the query; `args.body` is the JSON body. A 4xx or 5xx is `poppy_error` with its status. MCP (`api: "mcp"` or a `tool`): `McpClient.callTool` with a Bearer token for the server's `url`, from `AccountTokenClient.bearerForMcp` when signed in, otherwise `SessionClient.bearerForMcp`; the body is the tool result (`content`, `structuredContent`, `isError`, `text`). |
| `approve_op` | yes | `approve` confirms with the user's approval; `decline` cancels. |
| `signout` | yes | Revokes the Account Token. |
| `state` | yes | No token values. |
| `web_join` | yes | `BrowserSessionClient.join`, with the adapter as the host's `BrowserFormPosts`: it POSTs the signed assertion as a form and keeps the answer; `joined` is a 3xx with a cookie. |
| `handoff`, `close` | yes | `ConversationClient.handoff` and `.close`. `send` takes `parent_conversation` (`start` with `parentConversationId`, 7.10) and `sender`, whose default stays `human`. Messages carry `sender`. |
| `confirm_again` | yes | `OperationsClient.confirm` again with the proposal as first seen; the SDK refuses locally only an operation handed to it in another state. |

**Manifest:** scenarios `D S0 N SD SV SVN SXV SM SMC SX SE SO R RL C CI CS CA AO AS AM O OX H DC W O2 CM`. Readings: `S1: endpoint` (each client assertion's `aud` is the endpoint it is sent to), `S2: jwt-60s` (`typ: JWT`, `exp = iat + 60`, a 22-character `jti`), `S3: insertion`, `S4: omit`. `S23` is not declared: the SDK keeps no nonce between requests; it answers each `use_dpop_nonce` challenge once, with that response's nonce.

## Moving from v0.6.0 to v0.10.0

Nothing the adapter calls changed its signature; the clients now trace through an optional telemetry point the adapter doesn't contribute. What changed for the grid:

- **MCP.** v0.10.0 adds `McpClient`, `McpBearerAuth` and `bearerForMcp` on `SessionClient` and `AccountTokenClient` (a token requested without DPoP, with `resource` set to the server's `url`). The adapter now runs `api` for MCP and claims AM; before, it answered 501.
- **Response limits.** Every client reads at most its `maxResponseBytes` of a response (`readLimited`); a larger body is refused.
- **Redirects.** A request with a body is never sent on to a redirect other than 303 (`redirect_refused`).
- **Mediated Sign-In** may send credentials to the `auth.issuer` host as well as the Company's domain (`endpointOnCompanyDomain`).
- **URL policy.** The portable check now refuses local names (`localhost`, `.local`, `.internal`, `home.arpa`, `localdomain`) and every non-global IP literal. `*.interop.test` isn't one, so nothing is relaxed.

## Moving from v0.10.0 to v0.17.0 (what changed upstream)

21 commits, seven releases, all on 12 and 13 October. Nothing in the agent SDK the adapter drives changed: `src/sessions.ts`, `src/conversations.ts`, `src/device.ts`, `src/auth.ts`, `src/operations.ts` and the MCP client are byte for byte the same. The new code on the agent side is outside the adapter's path:

- **Reactor displays** (`src/ui.ts`): `PapConfirm` (an operation to confirm), `PapOutcome` (what it came to) and `PapReplies` (a Company's replies, each with who wrote it), for a page to render.
- **`create_resolving_client`** (Python's `createResolvingFetch`): an opt-in transport that resolves each host and refuses private addresses (`unsafe_address`). The adapter doesn't use it; it would refuse every `*.interop.test` name, which resolves to the proxy on a private network.

Still 124 conformance cases, the same five files. No cell should change.

## Relaxations and patches

None. The SDK's default URL policy checks only host strings, so `*.interop.test` names on private addresses pass, and Node's `fetch` trusts the run's CA through `NODE_EXTRA_CA_CERTS`. `patches/` is empty.

## Known upstream issues seen in the grid

Still present at `00216eb7` (v0.17.0):

- **SSE resume (CS).** `ConversationClient.stream` ([`src/conversations.ts` lines 405-481](https://github.com/datalayer/personal-agent-protocol/blob/00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65/src/conversations.ts#L405-L481)) reconnects immediately, with no delay and no `retry:` handling, and throws `stream_unavailable` after five reconnects that bring nothing new. A Company that closes an idle stream (pda-mock after `wait`, Manzanita at once) fails it when the agent resumes at the latest event (Poppy 7.6).
- **Device polling ignores `use_dpop_nonce`** ([`src/device.ts` lines 333-360](https://github.com/datalayer/personal-agent-protocol/blob/00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65/src/device.ts#L333-L360): one proof, no nonce, no retry), unlike the Session, code, refresh and revocation requests, so Device Sign-In fails at Companies that require nonces (pi-poppy, scenario SVN). The Python SDK has the same gap (Poppy 4.3, RFC 9449 section 8).
- `validateDirectSignInCallback` (`src/auth.ts` lines 160-200) reports an `error` callback before checking `state`, after the pending state has been taken, so any `error=` callback to the redirect URI ends a pending sign-in. Low severity.

## Separate draft 0.2 peer — 28 October 2026

The `-v02` registry entry moves from SDK 0.25.0 (`97c1386`) to SDK 0.26.0 at [`0ff43c55cc303c3165cb2d5841eca026e1c7c699`](https://github.com/datalayer/personal-agent-protocol/tree/0ff43c55cc303c3165cb2d5841eca026e1c7c699). The shared Dockerfile takes that revision through its existing build argument; the runner supplies `INTEROP_COMMIT` for the manifest. The 0.1 peer and its source links above retain their original pin. Version 0.26 adds API-write idempotency and Company-side idempotency records; latest 0.27 changes to draft 0.3 and is not used by this 0.2 adapter.
