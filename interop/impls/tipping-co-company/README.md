# tipping-co (Company)

Tipping Co, the Company in [timothyohare/personal-agent-protocol](https://github.com/timothyohare/personal-agent-protocol) (`packages/company`): a learning demo of an NRL tipping service on Hono and Node 24, with in-memory stores. It runs behind the [interop spec](../../../docs/interop-spec.md) 5.3 adapter.

- **Pinned commit:** `fb7b4e64ad343d9406055a995f4beb06269c1ce6` (12 October 2026, still upstream's head on 13 October), cloned in the image build.
- **Licence:** none declared. Nothing upstream is kept in this repository: the build clones the commit, and the image is built and run only on the grid's machine, as print-with-poppy's adapter did before that project chose MIT.
- **Ports:** 8080 is upstream's Hono app from `createCompany()` with its own `tippingCo()` config, as `packages/company/src/server.ts` builds it, at `INTEROP_ORIGIN` (`tipping-co.company.interop.test`). 8081 is the hooks API.
- **How it runs:** [`adapter.mjs`](adapter.mjs) is copied into the upstream checkout so the workspace's packages resolve, and Node 24 runs their TypeScript directly, as upstream's own scripts do. Nothing upstream is patched.

## What it offers

From the code at the pinned commit:

- `poppy.json` with `auth.direct` (`poppy:read`, `poppy:write` and a custom `standings` scope) and one OpenAPI API. No `agent` (no conversations), no device or mediated sign-in, no MCP, no `web`, no extensions.
- Signed-out Sessions by the JWT-bearer grant, Direct Sign-In with PKCE S256 and RFC 9207 `iss` on its own login and consent pages, refresh with the Account Token (not rotated), and revocation. DPoP on every token and API request, with optional server nonces.
- The OpenAPI document has no `operationId`s, so the fixture names operations as `"METHOD /path"` ([spec](../../../docs/interop-spec.md) 5.2): `GET /api/ladder` signed out, `GET /api/me/tips` with `poppy:read`, `POST /api/me/tips` with `poppy:write`.

## Hooks

- `fixture`: accounts `tipper` and `rival` (upstream's two test users), Poppy's default scopes, the three operations above.
- `approve_authorization`, `deny_authorization`: play the person on Tipping Co's own pages, in process (`app.request`): open the authorization URL, sign in with the account's password (upstream's test passwords), then allow (only the asked-for scopes when `scopes` is given) or refuse on the consent page, and answer with the 303's `Location`.
- `require_nonce`: rebuilds the Company with `requireDpopNonce` (upstream's `POPPY_REQUIRE_DPOP_NONCE`) over the same stores.
- `expire_tokens`, `end_sessions`: edit the in-memory stores.
- `/reset`: a new Company with new stores.

Not offered: `rate_limit` (its limiter is fixed at 120 token requests a minute per address), `issuer_path` (the issuer is always the origin), `last_one_time_code`, device, staff and Operations hooks.

**Manifest:** scenarios `D S0 N CM SD SX SO R AO AS`. R's trace check needs a rotated Account Token, which this config never issues, so R is unsupported in practice. Readings: S1 `token-endpoint` (every client assertion's `aud` must be the token endpoint, at `/oauth/revoke` too), S2 `lenient-300s` (any `typ`, ES256, at most 300 s after `iat`), S3 `either` (the issuer is the origin), S4 `either` (a signed-out Session ignores `scope` and is granted none).

## Relaxations

- `INTEROP_ALLOW_TEST_HOSTS=1`, set in the image, off when unset: the config's `resolveHost` hook, which the Company's private-address check uses before it fetches an agent's `client_id` and `jwks_uri`, reports `*.interop.test` names as `192.0.2.1` (TEST-NET-1), because every such name resolves to the proxy on a private network. Other names resolve as upstream does, and the fetch itself goes to the proxy.
- The run CA is trusted through `NODE_EXTRA_CA_CERTS`.

## Results

First run, 13 October ([interop-testing.md](../../../docs/interop-testing.md#tipping-co-joins-the-grid)): the eight honest agents over the ten scenarios above, 80 cells, 50 pass, 13 fail, 17 unsupported, every failure a known one.

- adonis-agora and Tipping Co's own agent pass every scenario they claim; everruns runs only D, which passes.
- pda, both Datalayer agents and pi-poppy pass everything but SO. Their revocation assertion's `aud` is the revocation endpoint, and Tipping Co wants the token endpoint there too, so it answers `invalid_client` ([S1](../../../docs/spec-issues.md#s1), blamed on the spec).
- pi-poppy also fails N: it retries after `use_dpop_nonce` at the token endpoint only when `WWW-Authenticate` names the error, and an authorization server puts it in the JSON body (RFC 9449 8), as Tipping Co does.
- poppy-demo's caller fails all eight at discovery: it needs an `agent` member, as at print-with-poppy.
