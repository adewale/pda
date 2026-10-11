# poppy-demo Personal Agent (caller)

The Personal Agent half of [irvinebroque/poppy-demo](https://github.com/irvinebroque/poppy-demo): `workers/caller`, a Pi agent on Cloudflare's `PiHarness`. It runs under `wrangler dev` in the container, with the spec 5.2 adapter in front.

- **Pinned commit:** `02a9b304e92fdfee465c57f2822742eecac8bdc8` (9 October 2026), cloned and checked out in the image build.
- **Licence:** none declared (see [poppy-demo-company](../poppy-demo-company/README.md)). We copy none of its code; the patch quotes the lines it changes.
- **Ports:** Worker on 8080 (behind the proxy as `poppy-demo.agent.interop.test`: `/agent.json`, `/jwks.json`, `/oauth/callback`), adapter on 8081.

## No model

The caller is model-driven: Pi calls one `poppy` tool, whose actions are `CallerSession.action()`. That method is the whole Poppy layer (discovery, token requests, DPoP, conversations, revocation). The caller's own UI reaches it through `POST /api/action`, with the visitor cookie and the same-origin check, and that's what the adapter calls. The model is never called. The container has no Workers AI: `AI` is a placeholder string, because `createAI()` throws at construction when the binding is undefined.

## Run

```sh
docker build -t poppy-demo-agent interop/impls/poppy-demo-agent
docker run -e INTEROP_SECRET=… -v ca.pem:/interop/ca.pem:ro poppy-demo-agent
```

| Env | Default | Meaning |
| --- | --- | --- |
| `AGENT_HOST` | `poppy-demo.agent.interop.test` | Public name; `CALLER_ORIGIN` and the `client_id` (`https://$AGENT_HOST/agent.json`) come from it. |
| `DEFAULT_COMPANY` | `poppy-demo.company.interop.test` | The Company it starts with, and returns to after `/reset`. |
| `INTEROP_SECRET` | none | Bearer secret for control requests. |

**One Company at a time.** The caller accepts only the origin in `RECEIVER_ORIGIN`, and every endpoint it uses must sit on that origin. When a step names a different `company`, the adapter restarts `wrangler dev` with `RECEIVER_ORIGIN=https://<company>`. That takes about 2 s, or up to two minutes on a loaded machine; the readiness wait allows 180 s. The signing key survives the restart. `/reset` deletes all state, which also rotates the key, but the `kid` stays `agent-key-1`.

## Ops

| Op | Support |
| --- | --- |
| `discover` | Yes. `apis` are the API types. Any document the caller won't use (or throws on) is `poppy_error: discovery_failed`, status 0. |
| `session` | Yes. Discovers first if needed. It keeps the Session the caller already has (the caller's `start`), so two calls give the same `session_id`, as `S0` expects. |
| `signin` | `direct` only; `device` and `mediated` answer 501. It always asks for `poppy:read poppy:write`, whatever `scopes` says. |
| `signin_continue` | `callback_url` only. The adapter replays the callback to the caller's `/oauth/callback` with the visitor cookie. `account` is `null`, because the caller doesn't know it. An `error` on the callback comes back as `poppy_error` with status 0. |
| `send` | `text`, `conversation`. A send without `conversation` presses the caller's "New session" (`/api/pi/new`) first, so it starts a new conversation. `message_id` answers 501: the caller makes its own ids, so `CI` can't be driven. `messages` are the Company's messages after ours; `message_id` is our message's id, read back from the events. |
| `read` | Yes, from the caller's own copy of the events. The caller has no long poll, so for `wait` the adapter repeats the events request every 500 ms while the conversation is `working`. `has_more` is always `false`: the caller never follows it. |
| `api` | Only `openapi` `listOrders`, which the caller sends as `GET {company}/api/orders`, the one operation it knows; anything else is 501. |
| `signout` | Revokes the Account Token, then renews the Session signed out. `{"revoked": false}` when no account is connected. |
| `state` | Yes. |
| `sse`, `web_join`, `approve_op` | 501. |

Results follow 5.2: a Poppy error the Company returned is `{"ok": false, "poppy_error", "status"}`, and one the caller raised itself has `status` 0. `send`, `signin` and `api` discover and start a Session first when the caller hasn't, since its UI makes the user do that by hand.

Scenarios claimed: `D`, `S0`, `N`, `SD`, `SX`, `SO`, `C`, `CA`, `AO`. `N` because the caller retries once with a `DPoP-Nonce`. `AO` works against Northstar only.

Readings: `S1` `endpoint` (each client assertion's `aud` is the endpoint it's sent to, including the revocation endpoint), `S2` `jwt-60s`, `S3` `append` (it fetches `${auth.issuer}/.well-known/oauth-authorization-server`; the same URL as insertion unless the issuer has a path), `S4` `omit`. `S23` doesn't apply: nonces aren't kept between requests.

## Relaxations

1. **Patch `0001-network-fetch-without-service-binding.patch`.** Upstream reaches its Company only through the `RECEIVER` service binding. With no binding configured, the caller uses `fetch()` with `redirect: "manual"`. Upstream behaviour is unchanged when the binding exists.
2. **Plain `wrangler dev` with [`wrangler.interop.jsonc`](wrangler.interop.jsonc).** No `RECEIVER` or AI binding, a placeholder UI, and wrangler started with `--local-upstream $AGENT_HOST --upstream-protocol https`.
3. **One Company per process.** The adapter restarts wrangler to retarget `RECEIVER_ORIGIN`.
4. **CA trust.** `/interop/ca.pem` goes into the system store, and `NODE_EXTRA_CA_CERTS` is set. Checked: `NODE_EXTRA_CA_CERTS` alone is enough for workerd under wrangler 4.149. With no CA trust, every fetch fails with `TLS peer's certificate is not trusted`.

## The grid (runner, 11 October 2026, run 2026-10-11T16:46:10Z)

| Company | Pass | Fail | Why it fails |
| --- | --- | --- | --- |
| poppy-demo | D S0 SD SX C CA SO AO | none | |
| poppyseed | D S0 SD SX C | CA, SO | **CA:** poppyseed ignores `wait` on a POST, so the signed-in send has no reply in its result; the scenario's assumption, not a bug (Poppy 7.3). **SO:** poppyseed answers `POST /oauth/revoke` with 200 and an empty body, as RFC 7009 permits. The caller `JSON.parse`s it, throws, and reports `action_failed`. The token is revoked at the Company, but the caller still holds it. |
| Ilmer | none | D S0 C | Ilmer is signed-out only, so its OAuth metadata has no `authorization_endpoint`. The caller runs `new URL()` on every endpoint, and `new URL(undefined)` throws, so this agent can't use any signed-out-only Company. |
| dpa-mock | none | D S0 N SD SX C CA SO AO | The caller requires `auth.issuer` to equal the Company's origin, and every endpoint to sit on it (`invalid_metadata`). dpa-mock's issuer is `https://auth.dpa-mock.company.interop.test`. The draft allows that (3.2). |
| adonis-agora | none | D S0 N SD SX C CA SO AO | The same check: the issuer is `https://adonis-agora.company.interop.test/poppy`. |

`CI`, `CS`, `SV`, `SM`, `SE`, `R`, `AM`, `AS`, `O`, `OX` and `RL` are unsupported: no chosen message ids, no SSE, Direct Sign-In only, no renewal op, one API operation, no Operations extension. Every failure is in [`known-failures.json`](../../known-failures.json).

Upstream issues these show: the two crashes (an empty revocation body; an absent optional endpoint), the single-origin rule, and those in [docs/poppy-issues.md](../../../docs/poppy-issues.md#poppy-demo-irvinebroquepoppy-demo).
