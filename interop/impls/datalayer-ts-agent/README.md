# datalayer-ts (agent)

Datalayer's TypeScript Personal Agent SDK ([datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), `src/`), behind an adapter for the interop harness ([spec](../../../docs/interop-spec.md) 5.2).

- **Upstream commit:** `12d71877d477b93f3ee68ebdc542560ba85997b9` (v0.6.0, 11 October 2026), fetched inside the image. Nothing upstream is vendored here.
- **Licence:** BSD-3-Clause (upstream). The adapter is ours.
- **Build:** the runner builds this directory. Upstream has no lockfile at this commit, so `npm install` resolves dependency versions within its `package.json` ranges; installs run with `--ignore-scripts`.
- **Ports:** 8080 serves the agent's identity (`/agent.json` is the `client_id`, `/jwks.json`, `/oauth/callback`) at `INTEROP_ORIGIN`. 8081 is the control API.
- **Environment:** the runner's `INTEROP_*` variables and `NODE_EXTRA_CA_CERTS`. The image must not create `/interop`: the runner copies the CA directory there.

## How the adapter drives the SDK

`adapter.mjs` assembles a Reactor host the way Datalayer's own pairing tests do (`src/__tests__/support/world.mjs`): an ES256 `JoseSigner` for client assertions, a `JoseDpopProofProvider` with one key per Company, in-memory token and authorization-state stores, a browser handoff that only records the authorization URL, and a protected-input contribution answered from `signin_continue`. Every step calls the SDK's clients (`discoverCompany`, `SessionClient`, `DirectSignInClient`, `DeviceSignInClient`, `MediatedSignInClient`, `ConversationClient`, `DpopFetchClient`, `OperationsClient`, `AccountTokenClient`). No model is involved. `/reset` rebuilds the host with a new signing key (new `kid`) and forgets every Company.

The SDK leaves some decisions to its host, so the adapter makes them, as a host would:

- **Renewal.** A `401 invalid_token` renews once and retries: with the Account Token (`AccountTokenClient.refresh`) when signed in, otherwise `SessionClient.renew`. `invalid_session` starts a new Session and signs it in again with the Account Token.
- **Sign-in reuse.** `signin` with scopes the stored Account Token already covers signs the Session in without asking the user.
- **Retry keys.** `send`'s `message_id` is a key: the same key resends the same message, with the same wire id (128 random bits) and conversation.

| op | Supported | Notes |
| --- | --- | --- |
| `discover` | yes | A document the SDK refuses is `poppy_error: discovery_failed`, status 0. |
| `session` | yes | Returns the Session already held, or starts one. |
| `signin` | yes | `direct` returns `pending.url`; `device`, `url` and `user_code`; `mediated`, the field names. |
| `signin_continue` | yes | Direct: `callback_url` (an `error=` callback is `poppy_error` with status 0). Device: polls until the Company answers (60 s). Mediated: `fields`, then `code` after `{"pending": {"code_required": true}}`. |
| `send`, `read` | yes | `wait` is passed to the Company. Results add `operations` (proposals seen), `cursor` and the raw `events`. |
| `sse` | yes | Up to `max_events`, for about `wait` seconds; returns `last_id`. |
| `api` | OpenAPI only | `operation` is `"METHOD /path"` or an `operationId`; `args.params` fill path templates, the rest go in the query; `args.body` is the JSON body. A 4xx or 5xx is `poppy_error` with its status. MCP is 501: the TypeScript SDK has no MCP client. |
| `approve_op` | yes | `approve` confirms with the user's approval; `decline` cancels. |
| `signout` | yes | Revokes the Account Token. |
| `state` | yes | No token values. |
| `web_join` | 501 | Needs a browser. |

**Manifest:** scenarios `D S0 N SD SV SXV SM SMC SX SE SO R RL C CI CS CA AO AS O OX`. Readings: `S1: endpoint` (each client assertion's `aud` is the endpoint it is sent to), `S2: jwt-60s` (`typ: JWT`, `exp = iat + 60`), `S3: insertion`, `S4: omit`. `S23` is not declared: the SDK keeps no nonce between requests; it answers each `use_dpop_nonce` challenge once, with that response's nonce.

## Relaxations and patches

None. The SDK's default URL policy checks only host strings, so `*.interop.test` names on private addresses pass, and Node's `fetch` trusts the run's CA through `NODE_EXTRA_CA_CERTS`. `patches/` is empty.

## Known upstream issues seen in the grid

- **SSE resume (CS).** `ConversationClient.stream` reconnects immediately, with no delay and no `retry:` handling, and throws `stream_unavailable` after five reconnects that bring nothing new. A Company that closes an idle stream (dpa-mock after `wait`, Manzanita at once) fails it when the agent resumes at the latest event (Poppy 7.6).
- **Device polling ignores `use_dpop_nonce`** (`src/device.ts`), unlike the Session, code, refresh and revocation requests, so Device Sign-In fails at Companies that require nonces (pi-poppy). The Python SDK has the same gap (Poppy 4.3, RFC 9449 section 8).
- `validateDirectSignInCallback` (`src/auth.ts`) reports an `error` callback before checking `state`, after the pending state has been taken, so any `error=` callback to the redirect URI ends a pending sign-in. Low severity.
