# datalayer-ts (agent)

Datalayer's TypeScript Personal Agent SDK ([datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), `src/`), behind an adapter for the interop harness ([spec](../../../docs/interop-spec.md) 5.2).

- **Upstream commit:** `12d71877d477b93f3ee68ebdc542560ba85997b9` (v0.6.0, 11 October 2026), fetched inside the image. Nothing upstream is vendored here.
- **Licence:** BSD-3-Clause (upstream). The adapter is ours.
- **Build:** `docker build -t interop/datalayer-ts-agent:dev .` Upstream has no lockfile at this commit, so `npm install` resolves dependency versions within its `package.json` ranges; installs run with `--ignore-scripts`.
- **Ports:** 8080 serves the agent's identity (`/agent.json` is the `client_id`, `/jwks.json`, `/oauth/callback`) at `INTEROP_ORIGIN` (default `https://datalayer-ts.agent.interop.test`). 8081 is the control API.
- **Environment:** `INTEROP_SECRET` (Bearer for `/step` and `/reset`; `/manifest` and `/healthz` are open), `INTEROP_NAME`, `INTEROP_ORIGIN`, and `NODE_EXTRA_CA_CERTS` for the run's CA.

## How the adapter drives the SDK

`adapter.mjs` assembles a Reactor host the way Datalayer's own pairing tests do (`src/__tests__/support/world.mjs`): an ES256 `JoseSigner` for client assertions, a `JoseDpopProofProvider` with one key per Company, in-memory token and authorization-state stores, a browser handoff that only records the authorization URL, and a protected-input contribution answered from `signin_continue` fields. Every step calls the SDK's clients (`discoverCompany`, `SessionClient`, `DirectSignInClient`, `DeviceSignInClient`, `MediatedSignInClient`, `ConversationClient`, `DpopFetchClient`, `OperationsClient`, `AccountTokenClient`). No model is involved. `/reset` rebuilds the host with a new signing key (new `kid`) and forgets every Company.

| op | Supported | Notes |
| --- | --- | --- |
| `discover` | yes | `apis` lists each API's `type`. |
| `session` | yes | Signed-out Session. |
| `signin` | yes | `direct` returns `pending.url`; `device` returns `pending.url` and `user_code`; `mediated` returns the field names. |
| `signin_continue` | yes | Direct: `callback_url`. Device: polls until approved (60 s). Mediated: `fields`, then `{code}` if the Company asks for one. A callback carrying `error=access_denied` is `{"ok": false, "poppy_error": "access_denied", "status": null}`. |
| `send` | yes | Starts or continues a conversation; with no `wait`, reads the events after the last cursor so `messages` holds the reply. Also returns `cursor` and the raw `events`. |
| `read` | yes | One page from `cursor`. |
| `sse` | yes | Collects up to `max_events` from the SSE stream (`timeout_ms`, default 10 s). |
| `api` | OpenAPI only | `operation` is `"METHOD /path"` or an `operationId` (looked up in the description); `args` fills path parameters, `args.body` is the JSON body. MCP (`tool`) is 501. |
| `approve_op` | yes | `approve` confirms with the user's approval; `decline` cancels. Needs a proposal seen in an earlier `send` or `read`. |
| `signout` | yes | Revokes the Account Token at the revocation endpoint. |
| `state` | yes | No token values. |
| `web_join` | 501 | Needs a browser. |

**Manifest:** scenarios `D S0 N SD SV SM SX SO C CI CS AO O OX`. Readings: `S1: token-endpoint` (assertion `aud` is the token endpoint), `S2: jwt-60s` (`typ: JWT`, `exp = iat + 60`), `S3: insertion`, `S4: omit` (the jwt-bearer grant never carries `scope`). `S23` is not declared: the SDK keeps no nonce between requests; it answers each `use_dpop_nonce` challenge once, with that response's nonce.

## Relaxations and patches

None. The SDK's default URL policy (`assertObviouslyPublic`) checks only the host string, so `*.interop.test` names that resolve to private addresses are allowed, and Node's `fetch` trusts the run's CA through `NODE_EXTRA_CA_CERTS`. `patches/` is empty.

## Verified (11 October 2026, by hand through a TLS proxy, not the runner)

- Against **datalayer-ts** (Company): discover, session, signed-out send (`sign_in_required` event), Direct, Device and Mediated (with one-time code) Sign-In, signed-in send that proposes an operation, read, SSE, OpenAPI `GET /api/orders`, `approve_op` (succeeded), signout (revoked); same message id twice (no duplicate) and with different text (`409 message_id_conflict`); denied sign-in; Sessions ended by the Company (`401 invalid_token`, then a new Session works).
- Against **datalayer-py** (Company): the same Direct journey, all green.
- Against **pi-poppy** (Company, nonces required): the same Direct journey, all green, including the `createExchange` operationId call (`202` with a proposed operation).
