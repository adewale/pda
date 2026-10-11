# poppy-demo Company (Northstar)

The Company half of [irvinebroque/poppy-demo](https://github.com/irvinebroque/poppy-demo): `workers/receiver`, "Northstar Outfitters", a Cloudflare Worker with two SQLite Durable Objects. It runs under `wrangler dev` in the container, with the spec 5.3 adapter in front.

- **Pinned commit:** `02a9b304e92fdfee465c57f2822742eecac8bdc8` (9 October 2026), cloned and checked out in the image build.
- **Licence:** none declared. The repository has no `LICENSE` and its `package.json` has no `license` field (only `licenses/cloudflare-agents.txt`, the MIT licence of the Cloudflare example its UI adapts). We fetch and run it unchanged except for the patch below and copy none of its code; the patch necessarily quotes the few lines it changes. Ask the author before publishing results widely.
- **Ports:** Worker on 8080 (behind the proxy as `poppy-demo.company.interop.test`), adapter on 8081.

## Run

```sh
docker build -t poppy-demo-company interop/impls/poppy-demo-company
docker run -e INTEROP_SECRET=… -v ca.pem:/interop/ca.pem:ro poppy-demo-company
```

| Env | Default | Meaning |
| --- | --- | --- |
| `COMPANY_HOST` | `poppy-demo.company.interop.test` | Public name; `RECEIVER_ORIGIN` is `https://` plus this. |
| `AGENT_HOST` | `poppy-demo.agent.interop.test` | The sibling agent (`CALLER_ORIGIN`), still accepted. |
| `INTEROP_PEER_SUFFIX` | `.agent.interop.test` in this image; unset upstream | Which other agents' `client_id`s are admitted (patch 0001). |
| `INTEROP_SECRET` | none | Bearer secret for control requests. |

The adapter starts `wrangler dev --local-upstream $COMPANY_HOST --upstream-protocol https` so `request.url` carries the public `https://` origin. Without `--upstream-protocol https`, wrangler's inner URL is `http://…` and every DPoP proof fails its `htu` check with `invalid_dpop_proof`. `/reset` stops wrangler, deletes its persisted state and starts it again.

## Adapter

`GET /hooks` → `approve_authorization`, `deny_authorization`, `fixture`. Every other hook answers 501.

- `approve_authorization` / `deny_authorization` drive Northstar's own consent page over HTTPS through the proxy, as a browser would: GET the authorization URL (which sets the `poppy_consent` cookie and renders the form with its nonce), then POST the form with `Origin` set to the issuer and `decision=approve` or `deny`. With `scopes`, only those checkboxes are ticked (so `AS` can approve `poppy:read` alone). The result is the 303 `Location`, with `code`, `state` and `iss`. Northstar has no login: the consent page stands for one synthetic account, so `account` is ignored.
- `fixture` → `{"accounts": ["demo-account"], "scopes": ["poppy:read", "poppy:write"], "openapi": {"api": "https://poppy-demo.company.interop.test/openapi.json", "operation": "listOrders"}}`.
- Hook bodies may be `{"params": {...}}` or the bare params object; results are `{"ok": true, "result": {...}}`.
- Unsupported: `approve_device`, `deny_device`, `mediated_answers`, `last_one_time_code` (Northstar has only Direct Sign-In), `end_sessions` (no admin path; Sessions end only after 24 h), `staff_join`, `staff_reply` (no staffed desk; handoff returns to the store assistant at once), `propose_operation`, `settle_operation` (no Operations extension).

Scenarios claimed: `D`, `S0`, `SD`, `SX`, `SO`, `C`, `CI`, `H`, `DC`, `AO`, `AS`. Not `N` (Northstar never sends a DPoP nonce), `R` (the refresh grant doesn't rotate the Account Token), `CS` (no SSE), `SV`, `SM`, `O`, `W`.

Readings: `S1` `token-endpoint` (assertion `aud` must equal the endpoint exactly), `S2` `jwt-60s` (`typ: JWT`, `exp - iat ≤ 60`), `S4` `omit` (a signed-out Session request carrying `scope` gets `invalid_scope`).

## Relaxations

1. **`INTEROP_PEER_SUFFIX` (patch `0001-interop-peer-suffix.patch`).** Upstream accepts exactly one `client_id`, its sibling's, fetched over a service binding, and requires `jwks_uri` to be exactly the sibling's. With the setting (unset by default), any HTTPS `client_id` on a host ending in the suffix is also admitted; its metadata and JWKS are fetched with `fetch(…, {redirect: "manual"})` and the `jwks_uri` must share the `client_id`'s origin. Every other upstream check stays (`private_key_jwt`, `redirect_uris` on the `client_id` origin, no private keys in the JWKS).
2. **Client identity on API calls (same patch).** Upstream compares every API and conversation request with the sibling's `client_id`, which would refuse every other agent's token with `invalid_session`. With the setting on, the token's owner record, which belongs to exactly one client, identifies it instead.
3. **No service bindings, plain `wrangler dev`.** Upstream configures the Workers with the `cf` beta CLI (`cloudflare.config.ts`); [`wrangler.interop.jsonc`](wrangler.interop.jsonc) restates the receiver's bindings without the `CALLER` binding.
4. **CA trust.** The entrypoint adds `/interop/ca.pem` to the system store and sets `NODE_EXTRA_CA_CERTS`. Wrangler 4.149 passes `NODE_EXTRA_CA_CERTS` on to workerd: with it, outbound HTTPS to `*.agent.interop.test` works; without any CA trust, workerd fails with `TLS peer's certificate is not trusted; reason = unable to get local issuer certificate`.

## Verified (11 October 2026, stand-in proxy)

- Image builds; `/manifest`, `/healthz`, `/hooks`, `fixture` answer; 501 for unsupported hooks.
- Discovery and OAuth metadata through the proxy name `https://poppy-demo.company.interop.test` throughout.
- With its sibling agent ([poppy-demo-agent](../poppy-demo-agent)): discover, signed-out Session, send, Direct Sign-In approved by `approve_authorization`, signed-in send, read, `listOrders`, revoke; and `deny_authorization` giving `access_denied`. Cross-project pairings are in the agent's README.

## Known upstream issues seen while running it

- A token that matches the format but names no Durable Object (`<64 hex>.<43 chars>`) gets 500 `server_error`, not 401 `invalid_token` (`idFromString` throws).
- A `client_id` that answers non-JSON gets 500 `server_error`, not `invalid_client` (`JSON.parse` outside the `try`).
- The rest are in [docs/poppy-issues.md](../../../docs/poppy-issues.md#poppy-demo-irvinebroquepoppy-demo).
