# print-with-poppy (Company)

[spenciefy/print-with-poppy](https://github.com/spenciefy/print-with-poppy), an agent-first photo-printing store: an Express server with SQLite (better-sqlite3) and image processing (sharp). It runs in its own demo mode in the container, with the [interop spec](../../../docs/interop-spec.md) 5.3 adapter in front.

- **Pinned commit:** `7ef69bef9ca9e485386b28a679c532ed7cbee739` (11 October 2026), cloned and checked out in the image build.
- **Licence:** none declared. The repository has no `LICENSE` and its `package.json` has no `license` field (only its two fonts carry their own licences). We fetch and run it unchanged except for the patch below and copy none of its code; the patch necessarily quotes the few lines it changes. Ask the author before publishing results widely.
- **Ports:** the store on 8080 (behind the proxy as `print-with-poppy.company.interop.test`), the adapter on 8081.
- **Image:** two stages on `node:22-bookworm-slim` (upstream's `engines` says Node 22). The build stage has git and a compiler, as upstream's own image does, in case a native module has no prebuilt binary; the run stage has only `server/`, `src/offer.ts` and the production `node_modules`. The browser frontend isn't built: no Poppy endpoint serves it, so `/` answers upstream's 503 "run npm run build" page.

## Run

```sh
docker build -t print-with-poppy-company interop/impls/print-with-poppy-company
docker run -e INTEROP_SECRET=… -e NODE_EXTRA_CA_CERTS=/interop/ca.pem -v ca.pem:/interop/ca.pem:ro print-with-poppy-company
```

| Env | Default | Meaning |
| --- | --- | --- |
| `INTEROP_ORIGIN` | `https://print-with-poppy.company.interop.test` | Set by the runner; passed to the store as `PUBLIC_URL`. The store builds its issuer, endpoints, DPoP `htu` and OpenAPI `servers` from it, never from the inner request. |
| `AGENT_CLIENT_IDS` | the grid's honest agents (below) | The store's own allowlist of agent `client_id`s, comma-separated, matched exactly. |
| `INTEROP_SECRET` | none | Bearer secret for control requests other than `/manifest` and `/healthz`. |

The adapter starts the store as upstream's `npm start` does (`tsx server/index.ts`) with a fixed environment and nothing else from the container's: `APP_MODE=demo`, `PORT=8080`, `HOST=0.0.0.0`, `PUBLIC_URL`, `DATA_DIR=/data/pwp`, `AGENT_CLIENT_IDS`, `ALLOW_COMPAT_AGENT_SESSIONS=false`, `NODE_ENV=production`, and `NODE_EXTRA_CA_CERTS`, through which Node trusts the run's CA when the store fetches an agent's client metadata and JWKS. No Stripe, Prodigi or Resend key is set, so no client for them exists, and demo mode never calls them: prices are computed locally, checkout is a local URL, the print order is a stub and email is stored, not sent. With the internal network there is nowhere to send them anyway.

`POST /reset` stops the store, deletes `/data/pwp` (the SQLite file, uploaded photos and the demo secret) and starts it again, which also clears what it keeps in memory: the client metadata cache and the rate-limit counters (30 requests a minute at `/oauth`, from the proxy's one address).

### The allowlist

The store admits a Session only for a `client_id` its operator listed, so the adapter lists the grid's honest agents by the client metadata URL each adapter publishes:

| Agent | `client_id` |
| --- | --- |
| dpa | `https://dpa.agent.interop.test/poppy/client.json` |
| datalayer-ts, datalayer-py, pi-poppy, poppy-demo, adonis-agora | `https://<name>.agent.interop.test/agent.json` |
| everruns (adapter written, not in the registry) | `https://everruns.agent.interop.test/api/v1/poppy/agent.json` |

This is the store's ordinary configuration, not a relaxation. The adversarial `evil-agent` isn't listed: it never runs against a third-party Company (spec section 13). An agent added to the registry later needs adding here, or `--set print-with-poppy:AGENT_CLIENT_IDS=…`.

## Patch

`patches/0001-compat-sessions-settable-off.patch`, one line of `server/config.ts`. Besides native Poppy, the store offers a non-Poppy "HTTP compatibility" path: `POST /api/agent-sessions` hands out a Bearer guest token that the API accepts with no agent identity, assertion or DPoP. Upstream turns it on whenever `APP_MODE=demo`, whatever `ALLOW_COMPAT_AGENT_SESSIONS` says. The patch lets `ALLOW_COMPAT_AGENT_SESSIONS=false` turn it off in demo mode too; unset, demo mode keeps it on as upstream does. The adapter sets it to `false`, so the grid tests Poppy only: `/api/agent-sessions` answers 404 `not_available` and a `Bearer` token is refused with `invalid_token`. The patch restricts the store; it relaxes nothing.

Demo mode keeps the store's own browser demo: `/api/demo/agent.json` (a built-in agent identity, accepted without the allowlist), `/api/demo/session` and the `Demo` authorization scheme its web page uses, and `/api/demo/pay` and `/api/demo/ship`. None is in its discovery document or OpenAPI description, and no grid agent uses them; they are in the manifest's `relaxations` with demo mode.

## Adapter

`GET /hooks` → `fixture`. Every other hook answers 501.

- `fixture`: no accounts and no scopes (signed out only), no prompts (no conversations), `openapi_public` = `getCatalog` (`GET /api/catalog`, which needs no Session), `otp_account: null`.
- Unsupported: `require_nonce` (the store never asks for a DPoP nonce), `rate_limit` (its limits are fixed), `expire_tokens` (Session Tokens live an hour), `issuer_path` (the issuer is the origin), and every sign-in, staff and operation hook: there is no sign-in, no conversation and no Company Agent to propose an operation.

Scenarios claimed: `D`, `S0`. Not `AO`, `AS`, `O`, `OX`: as written they start with Direct Sign-In (and `O`, `OX` with a conversation in which the Company proposes), and the store has neither. Its operations are proposed by the agent's own API call (`POST /api/orders` with an `Idempotency-Key`, after a `multipart/form-data` photo upload) in a signed-out Session, the path [N19](../../../docs/spec-issues.md#n19) is about. Testing it needs a signed-out Operations scenario and an `api` step that can upload a file, neither of which the harness has. Not `N` (no nonces), `RL` (no `rate_limit` hook), `C`, `CI`, `CS`, `CA` (no conversations), `SO`, `R`, `SE` (no Account Tokens).

Readings:

- `S1` `endpoint`: a client assertion's `aud` must be exactly the endpoint it is sent to, a string: the token endpoint at `/oauth/token`, the revocation endpoint at `/oauth/revoke`.
- `S2` `lenient-300s`: any `typ` but `poppy-browser+jwt`, and at most 120 s (`exp - iat ≤ 120`, `iat` no older than 120 s, 5 s of clock skew). The harness has no 120 s value; `lenient-300s` is the nearest that admits any `typ`. An agent declaring `jwt-60s` is compatible and one declaring `any` isn't, as they should be, but a refusal of an assertion living 121 to 300 s raises no `reading.S2.refused` check.
- `S3` `either`: the issuer is the bare origin, so both metadata locations are the same URL.
- `S4` `either`: the jwt-bearer grant ignores `scope`; every Session Token comes back with `scope: ""`.

## Not run yet

Written on 12 October 2026 and not yet built or run: Docker's disk had too little room. Before the first run, check that `npm ci --omit=dev` finds prebuilt binaries for better-sqlite3 and sharp on the platform, that the store starts within the runner's 60 s, and that it fetches an agent's client metadata through the proxy over TLS.
