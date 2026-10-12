# adonis-agora (Company)

A Poppy Company built from Davi de Carvalho's AdonisJS libraries, for the interop grid ([docs/interop-spec.md](../../../docs/interop-spec.md)):

- **[`@adonis-agora/authkit-server`](https://github.com/DavideCarvalho/adonis-agora-authkit)** 0.78.0, commit `97838853c44e55c5d4c71ac5741f26fc34f720dc`: discovery, RFC 8414 metadata, the token and revocation endpoints, DPoP, Direct, Device and Mediated Sign-In, browser Sessions.
- **[`@adonis-agora/agent`](https://github.com/DavideCarvalho/adonis-agora-agent)** 0.79.0, commit `e66a2329d436f603dd7c57a0ca81b36e65bd486f`: the conversation endpoint (`poppy_provider`), with the Session Token checked by AuthKit through the shared global slot.

Licence: MIT for both (copies are in the image at `/licenses/`). Nothing upstream is vendored here.

## How it's built

The libraries need a host app, so `app/` is a minimal AdonisJS 7 app written for the grid. It is booted with `IgnitorFactory`, so there's no build step. It provides only what the libraries leave to the host:

- config;
- two in-memory test accounts, `alice@example.test` and `bob@example.test`, with passwords generated at start;
- plain-HTML login and consent screens (AuthKit's `render` hook);
- a scripted `FakeModelProvider` in place of an LLM, with one tool, `list_orders`, that needs `poppy:read`;
- three OpenAPI operations behind AuthKit's `poppyAuth`:
  - `listOrders` (`GET /api/orders`, `poppy:read`);
  - `searchCatalog` (`GET /api/catalog`, any Session, signed in or not);
  - `updateProfile` (`POST /api/profile`, `poppy:write`).
- Shield CSRF exempts AuthKit's machine-to-machine routes and `/api/*`.

The Dockerfile installs both packages from npm at the versions their pinned commits released ("chore: version packages"). It also clones both repositories at those commits and fails the build unless the versions match. The libraries need Node 24 (`@adonisjs/core` 7), so the image uses `node:24.21.0-bookworm-slim`.

The issuer is `https://adonis-agora.company.interop.test/poppy`. It has a path, so it exercises reading S3. The metadata is served at both the RFC 8414 insertion URL and the append URL.

## Run

```sh
docker build -t adonis-agora-company interop/impls/adonis-agora-company
docker run --network <net> -e INTEROP_SECRET=<secret> -e INTEROP_ORIGIN=https://adonis-agora.company.interop.test adonis-agora-company
# then: docker cp <trust dir> <container>:/interop   (the image has no /interop; the entrypoint is in /interop-adapter)
```

- The proxy routes `adonis-agora.company.interop.test` to the container's port 8080. The adapter listens on 8081, in the same Node process.
- Optional environment:
  - `INTEROP_ORIGIN` (falls back to `PUBLIC_ORIGIN`, default `https://adonis-agora.company.interop.test`).
  - `POPPY_REQUIRE_NONCE=1` turns on AuthKit's `dpop.requireNonce`.
  - `INTEROP_ALLOW_PRIVATE_PEERS=0` turns the relaxation below off.

## Adapter (spec 5.3)

| Hook | How |
| --- | --- |
| `approve_authorization`, `deny_authorization` | Acts as the person in a browser, over the public origin. It signs in on the host's `/account/login` with CSRF, opens the agent's authorization URL, and submits AuthKit's consent form (`POST /poppy/oauth/authorize`, `decision=allow\|deny`, `scope[]`). It returns the `Location` AuthKit redirects to. |
| `approve_device`, `deny_device` | Same login, then AuthKit's `/poppy/device` screen and form. |
| `mediated_answers` | `{email, password}` for the account. |
| `last_one_time_code` | Bob's Mediated Sign-In needs a one-time code. The code is the one the host's `verify` callback "sent". |
| `end_sessions` | Sets `ended_at` on every open row of AuthKit's `auth_poppy_sessions`. AuthKit has no API for this. |
| `staff_join`, `staff_reply` | `PoppyConversations.humanJoined` and `postMessage`. The host's `handoff.request` answers `queued`. |
| `require_nonce` | Sets AuthKit's resolved `personalAgents.poppy.dpop.requireNonce` until `/reset`. |
| `rate_limit` | With `endpoint: "token"`, arms AuthKit's own Session limiter, which covers new Sessions only. Otherwise the host answers 429 with `Retry-After` on its `/api/*` routes. |
| `expire_tokens` | Moves `expires_at` into the past for every live row of `auth_poppy_tokens`. |
| `fixture` | Accounts; scopes; `openapi`, `openapi_public` and `openapi_write` as `{api: "openapi", operation, args}`; `prompts.hello` and `prompts.sign_in`; `otp_account` (bob). There is no `mcp` and no `prompts.operation`. |
| `propose_operation`, `settle_operation` | 501: there's no Operations extension. |

Hook bodies are the bare params, and replies are the bare result.

Scenarios `CM` and `H` were claimed before they were written; since 12 October `DC` (Direct Conversations and close in `@adonis-agora/agent`) and `W` (AuthKit's browser-session endpoint, on by default; its cookie is the host's session cookie, `Secure`, `HttpOnly`, `SameSite=Lax`) are too.

`/reset` does four things; accounts and passwords survive it:
- empties AuthKit's Poppy tables and grants;
- replaces the conversation and agent stores;
- turns `requireNonce` and rate limits back off;
- replaces AuthKit's agent client registry (`PoppyService.registry`), so cached agent metadata and JWKS are dropped. That stops a peer that rotated its keys on reset from being refused for 30 s. It reaches AuthKit's runtime through `build/src/agents/runtime.js` by file URL, because that module isn't in the package exports.

## Relaxations

Each is listed in `/manifest`:

1. **`personalAgents.poppy.allowInsecureClientIds`**: an upstream dev and test setting. It's off by default, and AuthKit refuses it when `NODE_ENV=production`. The image turns it on through `INTEROP_ALLOW_PRIVATE_PEERS=1`.
   - Without it, AuthKit's SSRF guard (`safe_fetch.ts`) refuses to fetch any agent's `client_id` behind the grid's proxy, because the proxy has a private address. The agent gets `invalid_client` ("client metadata: blocked address").
   - It's broader than the grid needs: it also accepts `http://` client IDs.
   - A narrower upstream setting would help, for example private addresses allowed only for a configured host suffix.
2. **`NODE_ENV=development`**, which the setting above requires.
3. **CA trust**: `/interop/ca.pem` is added to the system store, and `NODE_EXTRA_CA_CERTS` is set.
4. **The grid's host app**: memory stores, test accounts, a scripted model, and the `require_nonce`, `rate_limit` and `expire_tokens` hooks described above.

There are no source patches.

## Verified with the runner (interop/runner)

| Run | Pass | Fail | Unsupported | Error |
| --- | --- | --- | --- | --- |
| `--agents dpa --companies adonis-agora` | 15 | 2 (CA, AS) | 4 (R, AM, O, OX) | 1 (CS) |
| `--agents adonis-agora --companies adonis-agora` | 18 | 0 | 4 (R, AM, O, OX) | 0 |

The adonis × adonis row combines the full run with the later AS rerun after the CSRF fix.

What explains the dpa × adonis-agora cells that didn't pass:
- **R:** AuthKit never rotates the Account Token on refresh, so the `refresh_rotated` check has nothing to judge.
- **CS** (Company bug): the SSE handler in `@adonis-agora/agent` (`src/poppy/handler.ts`, stream setup) awaits the first stream item before it writes the response headers. A stream resumed with `Last-Event-ID` on an idle conversation therefore never answers at all, not even keep-alives. dpa's `sse` has no deadline on the headers, so its control call never returns. The adonis agent's `sse` aborts after its quiet period and passes.
- **CA:** a POST with `wait` is a read that returns as soon as any event follows the cursor, and the agent's own message is always one. So `wait` never holds for the reply. That's allowed, since `wait` is a hint (Poppy 7.3), but the scenario expects `send` to return the Company's reply.
- **AS:** dpa holds writes for the User's approval at a Company without the Operations extension, so nothing is sent.

## Verified by hand (before the runner)

Verified on a private Docker network behind a TLS-terminating stand-in proxy with a run CA, paired with [`adonis-agora-agent`](../adonis-agora-agent):

- Discovery, a signed-out Session, Direct Sign-In approved and denied, and Device Sign-In.
- Mediated Sign-In with a password (alice), and with a password and one-time code (bob). A wrong password gives `failed`.
- Conversations:
  - send and read;
  - SSE;
  - a retry with the same message ID returns the same conversation;
  - different content under the same ID gives `409 message_id_conflict`;
  - a staff join and reply;
  - an `authorization` event (`sign_in_required`, `scope: poppy:read`) for a signed-out order question.
- The OpenAPI call works signed in. It gives `403 sign_in_required` after sign-out.
- After `end_sessions`, the agent recovers with a new Session.
- The browser Session join answers 303 with a cookie.
- The DPoP nonce profile works (`POPPY_REQUIRE_NONCE=1`).

## Known issues

- **Reset and key rotation.** AuthKit caches an agent's JWKS and re-fetches it on an unknown `kid` at most every 30 s (`JWKS_REFRESH_COOLDOWN_MS`).
  - An agent that rotated its keys was refused with `401 invalid_client` for up to 30 s.
  - Fixed on the Company side: `/reset` now replaces the client registry.
- **SSE resume on an idle conversation never answers.** See the CS cell above.
- **Mediated sign-in after a different account.** A Session that was signed in to one account answers a second account's Mediated Sign-In with `account_mismatch`. That's correct Company behaviour.
- **`wait` returns early.** A POST with `wait` can return while the Company is still `working`, with only the first events. Readers must keep reading.

## The full grid (runner, run 2026-10-11T16:46:10Z)

| Agent | Pass | Fail / error |
| --- | --- | --- |
| dpa | D S0 N SD SV SM SMC SX SXV C CI SO SE AO RL | CA, AS; CS error |
| adonis-agora | D S0 N SD SV SM SMC SX SXV C CI CS CA SO SE AO AS RL | none |
| poppy-demo | none | D S0 N SD SX C CA SO AO |

- **CS (dpa), error.** `@adonis-agora/agent`'s SSE handler waits for the first event before sending any headers, so a stream resumed with `Last-Event-ID` on an idle conversation never answers, not even with a keep-alive. dpa's `sse` has no deadline on the headers, so the control call never returns (HTTP 0, blamed on the harness). Company bug; dpa's adapter could also set a deadline.
- **CA (dpa).** A `POST ?wait` returns as soon as any event follows the cursor, and the agent's own message always is one. It answers `working` with no reply, which Poppy 7.3 allows. That's the scenario's assumption.
- **AS (dpa).** dpa holds non-GET calls for the User's approval at a Company without the Operations extension, so the write is never sent. That's dpa's design, and the scenario has no approval step.
- **poppy-demo's agent** refuses discovery because the issuer has a path (`…/poppy`), and it requires `issuer` to equal the Company origin.
