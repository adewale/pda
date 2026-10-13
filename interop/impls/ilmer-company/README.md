# Ilmer Past (Company)

Ilmer Past's signed-out Poppy Company (the `agent/` Worker in rbirkby/Ilmer.org, live at poppy.ilmer.org), run under `wrangler dev`, behind an [interop spec](../../../docs/interop-spec.md) 5.3 adapter.

- **Upstream:** [rbirkby/Ilmer.org](https://github.com/rbirkby/Ilmer.org), MIT licence. The Dockerfile clones it at a pinned commit; nothing is vendored here.
- **Pinned commit:** `de0d1ec50f09906fedf26a83b7b88042ebfebd56` (12 Oct 2026, upstream's head on 13 October; moved from `4ca76e0`, 11 Oct, on 13 October).
- **Patches:** none. Upstream deploys with the `cf` CLI; [`wrangler.jsonc`](wrangler.jsonc) is a container-only config with the same bindings and Durable Object classes, and Wrangler 4.149.0 is installed beside upstream's lockfile. Its `main` is [`interop-main.js`](interop-main.js), a container-only entry module that re-exports upstream's `src/index.ts` unchanged and gives `HistoryAgent` a stand-in Workers AI binding ([below](#what-changed-upstream-pin-moved-13-october)).

## What changed upstream (pin moved 13 October)

12 commits on 12 October, `4ca76e0` to `de0d1ec`. In `agent/`:

- **`poppy_domains`** now lists `ilmer.org` beside the issuer's own host (`src/poppy.ts`), because the main site, www.ilmer.org, began serving a static `poppy.json` naming the same issuer. In the grid the metadata lists `ilmer.company.interop.test` and `ilmer.org`; agents discover `ilmer.company.interop.test` and nothing else.
- **Framing:** `X-Frame-Options: DENY` became `Content-Security-Policy: frame-ancestors 'self' https://www.ilmer.org https://ilmer.org http://localhost:8080`, for a chat popover on the main site.
- **Web search and fetch tools** for the Company Agent (`src/agent.ts`): `webSearchTool({ binding: this.env.AI, provider: 'exa' })` and `webFetchTool({ binding: this.env.AI })` from `agents` 0.28.0. They take `env.AI` directly, not the `offline` stand-in the model call falls back to, and `webFetchTool` throws a `RangeError` at construction when the binding is undefined (`toSource` in `agents`' web-fetch core). The harness is built on the first message of each conversation, so without a binding every conversation would fail before the model is asked; upstream's own `ILMER_POPPY_OFFLINE=true` mode has the same gap. `interop-main.js` gives `HistoryAgent` an `env.AI` that rejects every call (`run`, `websearch`, `toMarkdown`, `gateway().run`), so the tools are built, the model call fails as before, and each reply is still the fixed apology. Nothing is fetched.
- `ProtocolError` lost its TypeScript parameter properties (plain fields now), a `.npmrc` with `min-release-age=3`, and tests for the protocol and the page.

## Run

```sh
docker build -t ilmer-company interop/impls/ilmer-company
docker run -e INTEROP_SECRET=... [-v ca.pem:/interop/ca.pem] ilmer-company
```

| Port | What |
| --- | --- |
| 8080 | `wrangler dev` over plain HTTP, for the proxy (`ilmer.company.interop.test`). |
| 8081 | The adapter's control API. |

| Variable | Default | Meaning |
| --- | --- | --- |
| `INTEROP_SECRET` | none | Bearer secret for control requests other than `/manifest` and `/healthz`. |
| `INTEROP_ORIGIN` | `https://ilmer.company.interop.test` | Set by the runner; passed as the Worker's `ORIGIN`. Ilmer builds its issuer, endpoints and DPoP `htu` from it. `wrangler dev --local-upstream <host> --upstream-protocol https` also makes `request.url` carry it. |

If `/interop/ca.pem` exists, the entrypoint adds it to the system trust store. workerd's outbound `fetch` trusts the system store, so Ilmer can fetch an agent's client metadata and JWKS through the proxy over TLS. Checked.

## Hooks

Ilmer has no accounts, sign-in, staff or operations, so the only hook is `fixture`: no accounts, no scopes, no APIs, `prompts.hello`, and `otp_account: null`. Every other hook answers 501, including `require_nonce`, `rate_limit` and `expire_tokens`: Ilmer has no DPoP nonces, its only limit is a daily prompt budget, and token lifetimes are fixed. Hook bodies and results are bare objects (spec 5.3). `POST /reset` stops Wrangler, deletes its Durable Object state and starts it again (about 2 s).

Scenarios: `D`, `S0`, `C`, `CI`, `CM`. Not `DC` (it answers `direct_conversations_not_supported`), `H` (its handoff never brings a person), `W` (no browser-session endpoint). Readings: S1 `token-endpoint`, S2 `jwt-60s` (`typ: JWT`, a `kid`, at most 60 s), S3 `either` (the issuer is a bare origin), S4 `omit`.

## Relaxations

- Runs under `wrangler dev` with the container-only config: `ORIGIN` is the interop origin, `LOCAL_DEV=false` (HTTPS `client_id`s only, as in production).
- No Workers AI binding, as upstream's own `ILMER_POPPY_OFFLINE=true` leaves out; since `de0d1ec`, a stand-in `env.AI` from `interop-main.js` that refuses every call, so the web tools can be built. The Company Agent's model call fails, so every reply is Ilmer's fixed "Sorry, I could not answer that just now. Please try again in a moment." That keeps cells deterministic, but it means the grid tests Ilmer's protocol layer, not its answers.
- The run CA in the system trust store.

Ilmer accepts any HTTPS `client_id` whose host isn't an IP literal or loopback, so `*.agent.interop.test` needs no allowlist change.

## What works

Checked by hand on a private network with a stand-in TLS proxy and a per-run CA:

- `/manifest`, `/healthz`, `/hooks`, `fixture`, 501 for other hooks, 401 without the secret, `/reset`.
- Discovery and OAuth metadata through the proxy name the interop origin.
- poppyseed's `TestAgent`, published at `https://seed-agent.agent.interop.test` through the proxy: discovery, then Ilmer fetched the agent's metadata and JWKS over TLS, then a signed-out Session (scope `poppy:read poppy:write`), then a conversation with `?wait=25` that came back in about 0.2 s with the offline apology and `idle`. Retrying the same message id returned the same conversation, and an events read matched.

## What doesn't, or differs

- Signed-out tokens get `poppy:read poppy:write` when `scope` is omitted, and conversations need `poppy:write`. An agent that asks for `scope=poppy:read` on a signed-out Session gets a token it can't converse with (`insufficient_scope`); see docs/poppy-issues.md.
- No DPoP nonces (no `N`), no Account Tokens (no `SO`), no direct conversations (`direct_conversations_not_supported`), no staff (handoff answers with a fixed message and never reaches `queued`).
- The live deployment, poppy.ilmer.org, answers with a real model and a 500-prompt daily budget shared by everyone, so the live lane should send very few conversation messages there.
