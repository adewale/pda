# pi-poppy Company (interop adapter)

[pi-poppy](https://github.com/richardanaya/pi-poppy) ships a Company, `CompanyServer` (`src/company.ts`), that its conformance tests run against: discovery, Sessions, Direct, Device and Mediated Sign-In, conversations with SSE, handoff and Direct Conversations, OpenAPI and MCP APIs, browser Sessions and the Operations extension. This directory runs it behind the hooks API in [docs/interop-spec.md](../../../docs/interop-spec.md) section 5.3.

- **Upstream:** https://github.com/richardanaya/pi-poppy, commit `11ea10630180740f16ccd507b8f90f69870c7e32` (9 October 2026). Fetched by the Dockerfile; nothing is vendored.
- **Licence:** MIT (upstream). The adapter is ours.
- **Runtime:** Node 22 with `--experimental-strip-types`; no `npm install` (pi-poppy's `src/` imports only `node:` builtins).
- **Registry name:** `pi-poppy`, role `company`. Issuer `https://pi-poppy.company.interop.test`, organization "Example Company".
- **Prior art:** everruns' [`scripts/poppy-interop/company.ts`](https://github.com/everruns/everruns/blob/main/scripts/poppy-interop/company.ts) (PR #4531) runs the same `CompanyServer` for its own agent, behind a loopback HTTPS front with `requireNonce: true`.

## Ports

| Port | What |
| --- | --- |
| 8080 | `CompanyServer`'s request dispatcher on plain HTTP, with `baseUrl` set to `INTEROP_ORIGIN`, so the issuer, every endpoint and the DPoP `htu` check use the public name. |
| 8081 | `GET /manifest`, `GET /healthz`, `POST /reset` (a new `CompanyServer`), `GET /hooks`, `POST /hooks/<name>`. |

Environment: `INTEROP_SECRET`, `INTEROP_NAME` (default `pi-poppy`), `INTEROP_DOMAIN`, `INTEROP_ORIGIN` (default `https://<name>.company.interop.test`) and `INTEROP_COMMIT`, set by the runner; `PI_POPPY_REQUIRE_NONCE=1` (default off, as in `CompanyServer`; the `require_nonce` hook turns it on for scenario N), `PI_POPPY_DEFER_PERFORM=1` (default off: a confirmed operation is performed at once).

Fixture users are pi-poppy's own test users: `ada@example.com` / `correct-horse` (`acct_ada`) and `bea@example.com` / `battery-staple` (`acct_bea`), whose Mediated Sign-In asks for the one-time code `445566`. Scopes are `poppy:read` and `poppy:write`; Mediated Sign-In offers only `poppy:read`.

## Hooks

| Hook | How |
| --- | --- |
| `approve_authorization`, `deny_authorization` | Loads the consent page the URL names and posts it as the User would (email, password, scopes, decision), over loopback; returns the `Location` redirect. `account` is an email or account id. |
| `approve_device`, `deny_device` | Posts the device page's form. The Company grants the scopes the agent asked for; `scopes` can't narrow them. |
| `mediated_answers` | `{"fields": {"email", "password"}}`. |
| `last_one_time_code` | The code of the latest Mediated attempt that asked for one. |
| `end_sessions` | Marks every Session ended. |
| `staff_join`, `staff_reply` | `joinHuman` and a company message with `sender: "human"`. |
| `propose_operation` | The open proposal the Company's agent already made in that conversation (it proposes when asked for an exchange, `fixture.prompts.operation`); otherwise the same proposal, posted into the conversation. |
| `settle_operation` | `finishOperation` (`succeeded`, `failed` or `unknown`); only useful with `PI_POPPY_DEFER_PERFORM=1`. |
| `require_nonce` | Sets `CompanyServer`'s own `requireNonce` option: from then on every DPoP proof, at the token endpoint and every resource, needs its nonce. |
| `rate_limit`, `expire_tokens` | 501. `CompanyServer` can't expire the Session Tokens it has issued (each is sealed with its own `exp`), and its rate limiter (`rateLimit`) is a sliding window over every request, not "the next n requests". The adapter doesn't fake either. |
| `fixture` | `accounts` (emails), `scopes`, `openapi_write` (`createExchange`, which needs `poppy:write`), `mcp` (`search_products`, which works signed out), `prompts` (`hello`, `sign_in`: "Where is my order?", `operation`: an exchange) and `otp_account` (`bea@example.com`). |

Hook responses are the result object itself (spec 5.3). `CompanyServer`'s OpenAPI document has one operation, `createExchange`, so there is no `openapi` (read with `poppy:read`) or `openapi_public` (signed out): scenarios AO, N, R and RL are not claimed. The manifest claims D, S0, SD, SV, SM, SMC, SX, SXV, SO, SE, C, CI, CS, CA, AM, AS, O and OX.

The Company also offers unprompted: conversations answer "order", "account" or "return" with `sign_in_required` when signed out, and "exchange" with a proposal when signed in with `poppy:write` and the agent lists the `operations` extension.

## Patches and relaxations

| Patch | What | Default |
| --- | --- | --- |
| `patches/0001-interop-private-suffix.patch` | `src/net.ts` refuses any host that resolves to a private address, including a Personal Agent's `client_id` and `jwks_uri`. `PI_POPPY_INTEROP_PRIVATE_SUFFIX=.interop.test` allows private addresses for names under that suffix only; loopback is still refused. | Unset upstream; the image sets it. |

Other relaxations, with no upstream change:

- The adapter serves `CompanyServer`'s private `dispatch` on plain HTTP and sets its public `baseUrl` to the interop origin, instead of calling `start()` (an HTTPS listener on 127.0.0.1 that names itself `https://127.0.0.1:<port>`). The hooks read the Company's private records (Sessions, conversations, Mediated attempts) directly.
- The interop CA is trusted through `NODE_EXTRA_CA_CERTS`; the `ca` option is left unset.

## Readings

`S1: endpoint` (each assertion's `aud` must be exactly the endpoint it is posted to), `S2: any` (no `typ` required; lifetimes up to 120 s), `S3: either` (the issuer has no path), `S4: either` (`scope` on a signed-out Session request is ignored), `S23: per-company` (one nonce for every endpoint).

## Results

Runner, 11 October 2026 (`npm run interop`), with nonces off by default:

- **dpa, Datalayer TypeScript and Datalayer Python agents:** every claimed scenario passes. (AM is not claimed by the Datalayer TypeScript agent.)
- **pi-poppy agent:** every claimed scenario passes except `SE`, which is the agent's: it doesn't recover from `invalid_session`.

## Known issues

- **Key rotation:** a client assertion whose `kid` isn't in the cached JWKS is refused at once with 401 `invalid_client` ("unknown signing key"). `keyFor` throws before `verifyClientJwt` reaches its refetch path, which only runs when a known `kid` fails to verify. The client cache lasts 60 s, so an agent that rotates its keys is refused for up to a minute. The runner resets both sides for every cell, which makes a new `CompanyServer`, so this hasn't affected a run.
- **SSE with nothing new:** a stream opened at the latest cursor sends no bytes, not even headers, until the 15 s keep-alive (`writeHead` without a write). A client with a short timeout (pi-poppy's own: 2 s) sees a timeout.
