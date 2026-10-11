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
| `discover` | Yes. `apis` are the API URLs. |
| `session` | Yes. A first call starts a signed-out Session. Later calls start a new Session, which is signed in if an Account Token is held. |
| `signin` | `direct` only; `device` and `mediated` answer 501. It always asks for `poppy:read poppy:write`, whatever `scopes` says. |
| `signin_continue` | `callback_url` only. The adapter replays the callback to the caller's `/oauth/callback` with the visitor cookie. `account` is `null`, because the caller doesn't know it. An `error` on the callback comes back as `poppy_error`. |
| `send` | `text`, `conversation`. A send without `conversation` presses the caller's "New session" (`/api/pi/new`) first, so it starts a new conversation. `message_id` answers 501: the caller makes its own ids, so `CI` can't be driven. `messages` are the Company's messages after ours; `message_id` is our message's id, read back from the events. |
| `read` | Yes, from the caller's own copy of the events after one events request. `has_more` is always `false`: the caller never follows it. |
| `api` | Only Northstar's `listOrders` (`GET /api/orders`), the one operation the caller knows; anything else is 501. |
| `signout` | Revokes the Account Token, then renews the Session signed out. `{"revoked": false}` when no account is connected. |
| `state` | Yes. |
| `sse`, `web_join`, `approve_op` | 501. |

Results follow 5.2. A Poppy error the Company returned is `{"ok": false, "poppy_error", "status"}`. An error the caller raised itself (it refused a document, or a step was out of order) is `{"ok": false, "agent_error", "status"}`; 5.2 has no shape for that.

Scenarios claimed: `D`, `S0`, `N`, `SD`, `SX`, `SO`, `C`, `AO`. `N` because the caller retries once with a `DPoP-Nonce`. `AO` works against Northstar only.

Readings: `S1` `token-endpoint` (each client assertion's `aud` is the endpoint it's sent to, including the revocation endpoint), `S2` `jwt-60s`, `S3` `append` (it fetches `${auth.issuer}/.well-known/oauth-authorization-server`; the same URL as insertion unless the issuer has a path), `S4` `omit`. `S23` doesn't apply: nonces aren't kept between requests.

## Relaxations

1. **Patch `0001-network-fetch-without-service-binding.patch`.** Upstream reaches its Company only through the `RECEIVER` service binding. With no binding configured, the caller uses `fetch()` with `redirect: "manual"`. Upstream behaviour is unchanged when the binding exists.
2. **Plain `wrangler dev` with [`wrangler.interop.jsonc`](wrangler.interop.jsonc).** No `RECEIVER` or AI binding, a placeholder UI, and wrangler started with `--local-upstream $AGENT_HOST --upstream-protocol https`.
3. **One Company per process.** The adapter restarts wrangler to retarget `RECEIVER_ORIGIN`.
4. **CA trust.** `/interop/ca.pem` goes into the system store, and `NODE_EXTRA_CA_CERTS` is set. Checked: `NODE_EXTRA_CA_CERTS` alone is enough for workerd under wrangler 4.149. With no CA trust, every fetch fails with `TLS peer's certificate is not trusted`.

## Pairings (11 October 2026, stand-in proxy, HTTPS throughout)

| Company | Result |
| --- | --- |
| poppy-demo (sibling) | **Works.** discover, signed-out Session, send (reply inline), Direct Sign-In approved through Northstar's consent page, signed-in send ("Order #1042…"), read, `listOrders`, revoke (Session back to signed out); deny gives `poppy_error: access_denied`; `/reset` rotates the key. |
| poppyseed | **Mostly works.** Discover, signed-out Session, Direct Sign-In approved for alice through poppyseed's consent page (`poppy:read poppy:write`, signed in), send and read work. poppyseed ignores `wait` on a POST, so `send` returns `status: working` with no reply; the reply ("Noted.") appears in the next `read`. **Sign-out fails**: poppyseed answers `POST /oauth/revoke` with 200 and an empty body, as RFC 7009 permits. The caller runs `JSON.parse` on the body, throws, and reports `action_failed`. The token is revoked at the Company, but the caller still holds it and still thinks it's signed in. |
| Ilmer | **Fails at `D`**, with `{"ok": false, "agent_error": "action_failed", "status": 500}`. Ilmer is signed-out only, so its OAuth metadata has no `authorization_endpoint`. The caller checks every endpoint with `new URL(…)`, and `new URL(undefined)` throws. A missing `authorization_endpoint` is a TypeError, so poppy-demo's agent can't use any signed-out-only Company. |
| adonis-agora | See the adonis-agora-company README. |

Upstream issues these show: the two crashes above (an empty revocation body; an absent optional endpoint), and those in [docs/poppy-issues.md](../../../docs/poppy-issues.md#poppy-demo-irvinebroquepoppy-demo).
