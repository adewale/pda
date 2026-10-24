# print-with-poppy (Company)

[spenciefy/print-with-poppy](https://github.com/spenciefy/print-with-poppy), an agent-first photo-printing store: an Express server with SQLite (better-sqlite3) and image processing (sharp). It runs in its own demo mode in the container, with the [interop spec](../../../docs/interop-spec.md) 5.3 adapter in front.

- **Pinned commit:** `3360d8bbbadbfe5c0553b9fbf68849fc78ad0eb9` (24 October 2026, upstream's head), draft 0.2 only, cloned and checked out in the image build. The pin moved from `246727d` (13 October, draft 0.1) on 24 October, once upstream added `ALLOW_INTEROP_TEST_HOSTS` for this grid ([below](#the-pin-moves-to-3360d8b-02-24-october)); before that from `260dbb4` (12 October) and `7ef69be` (11 October) ([since `260dbb4`](#upstream-since-260dbb4), [since `7ef69be`](#upstream-since-7ef69be)).
- **Licence:** MIT, since `c147418` (`LICENSE`, Spencer Yen); its fonts keep their own licences. We fetch and run it unchanged and copy none of its code.
- **Ports:** the store on 8080 (behind the proxy as `print-with-poppy.company.interop.test`), the adapter on 8081.
- **Image:** two stages on `node:22-bookworm-slim` (upstream's `engines` says Node 22). The build stage has git and a compiler, as upstream's own image does, in case a native module has no prebuilt binary; the run stage has only `server/`, `src/offer.ts`, `src/ordering-method.ts` and the production `node_modules`. The browser frontend isn't built: no Poppy endpoint serves it, so `/` answers upstream's 503 "run npm run build" page. The sign-in pages are server-rendered, so they work without it (the logo they link to is missing, which no hook reads).

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

The adapter starts the store as upstream's `npm start` does (`tsx server/index.ts`) with a fixed environment and nothing else from the container's: `APP_MODE=demo`, `PORT=8080`, `HOST=0.0.0.0`, `PUBLIC_URL`, `DATA_DIR=/data/pwp`, `AGENT_CLIENT_IDS`, `ALLOW_COMPAT_AGENT_SESSIONS=false`, `NODE_ENV=production`, and `NODE_EXTRA_CA_CERTS`, through which Node trusts the run's CA when the store fetches an agent's client metadata and JWKS. No Stripe, Prodigi or Resend key is set, so no client for them exists, and demo mode never calls them: prices are computed locally, checkout is a local URL, the print order is a stub, and email (order mail and sign-in codes) is stored, not sent. With the internal network there is nowhere to send them anyway.

`POST /reset` stops the store, deletes `/data/pwp` (the SQLite file, uploaded photos and the demo secret) and starts it again, which also clears what it keeps in memory: the client metadata cache and the rate-limit counters (30 requests a minute at `/oauth`, from the proxy's one address).

### The allowlist

The store admits a Session only for a `client_id` its operator listed, so the adapter lists the grid's honest agents by the client metadata URL each adapter publishes:

| Agent | `client_id` |
| --- | --- |
| pda | `https://pda.agent.interop.test/poppy/client.json` |
| lenient-personal-agent, strict-personal-agent, sloppy-personal-agent (our fakes) | `https://<name>.agent.interop.test/poppy/client.json` |
| datalayer-ts, datalayer-py, datalayer-ts-v02, datalayer-py-v02, pi-poppy, poppy-demo, adonis-agora | `https://<name>.agent.interop.test/agent.json` |
| everruns | `https://everruns.agent.interop.test/api/v1/poppy/agent.json` |

This is the store's ordinary configuration, not a relaxation. The adversarial `evil-personal-agent` isn't listed: it never runs against a third-party Company (spec section 13). An agent added to the registry later needs adding here, or `--set print-with-poppy:AGENT_CLIENT_IDS=…`.

### The compatibility path is off

Besides native Poppy, the store offers a non-Poppy "HTTP compatibility" path: `POST /api/agent-sessions` hands out a Bearer guest token that the API accepts with no agent identity, assertion or DPoP. Upstream turns it on by default in demo mode. The adapter sets `ALLOW_COMPAT_AGENT_SESSIONS=false`, so the grid tests Poppy only: `/api/agent-sessions` answers 404 `not_available` and a `Bearer` token is refused with `invalid_token` (checked at `260dbb4` in a container with no network, where `/openapi.json` lists only the `DPoP` scheme and no `startGuestAgentSession`). Until `c147418` that setting couldn't turn it off in demo mode, and the adapter carried a one-line patch to `server/config.ts`; upstream now honours an explicit `false` (`tests/compat-config.test.ts`), so the patch is gone and the store runs unchanged.

Demo mode keeps the store's own browser demo: `/api/demo/agent.json` (a built-in agent identity, accepted without the allowlist), `/api/demo/session` and the `Demo` authorization scheme its web page uses, and `/api/demo/pay` and `/api/demo/ship`. None is in its discovery document or OpenAPI description, and no grid agent uses them; they are in the manifest's `relaxations` with demo mode.

## The pin moves to `3360d8b` (0.2), 24 October

On 23 October the move to upstream's 0.2 head (`e4aef11`) was blocked: the store refused to connect to any private address when it fetched an agent's client metadata, so on the grid's internal network every agent was refused at its first Session ("Invalid agent identity."). We asked its maintainer for a test setting rather than patch the store, and on 24 October upstream added one (`3360d8b`, #22): `ALLOW_INTEROP_TEST_HOSTS=true`. It is off by default; it lets a private address through only for a host name ending in `.interop.test`, and only into the RFC 1918 ranges and IPv6 unique-local addresses (never loopback or link-local); and the store refuses to start with it outside demo mode, on an origin that isn't HTTPS under `.interop.test`, on Cloudflare, or with provider credentials. The adapter sets it, and lists it among the manifest's relaxations. Nothing of upstream's is patched.

What else the move changed in the adapter: `src/ordering-method.ts` is copied beside `src/offer.ts`, since `server/` imports it; the manifest's `poppy` is `["0.2"]`, since the store refuses 0.1 assertions; and its readings are S1 `issuer` and S2 `lenient-300s` (`server/auth.ts`: the issuer as `aud`, `exp - iat <= 300`). The sign-in pages, the `records` table, the code email and `/api/health` are unchanged, so the hooks carried over. Datalayer's two 0.2 agents were added to the allowlist.

Run offline on 24 October, with `lenient-company-v02` as the 0.2 reference: `pda`, the lenient and strict fake agents, and Datalayer's TypeScript and Python 0.2 agents pass every scenario they run (D, S0, CM, SD, SX, SMC, SO, AO, AS, OU), and R is unsupported for each (the store doesn't rotate Account Tokens). OU now passes: the S22 known failure of the old pin is gone. The sloppy agent is refused at its first Session, as 0.2 requires of its token-endpoint `aud` (a known failure, blamed on the agent). Agents that speak only 0.1 share no version with the store, so their cells are unsupported, and the old pin's 0.1 known failures for this store are removed.

## Source refresh, 17 October (pin unchanged)

Upstream head `6dca0ad4f89b80015d0de26df887cb535ffe0594` (15 October) is 18 commits beyond our tested `246727d` pin. It fixes refused revocation assertions becoming 500s (`3cba737`, #2) and declares `poppy:read` on both account-read operations. It also adds product-preview workflows and selectable artwork. The proposal's 202 schema still leaves `operation` optional. Token/Session and revocation assertions still use endpoint audiences, so both server and reference client need migration to the revised draft's issuer audience. Source read only: no pin, runtime or known-failure change; no live orders or payments. Earlier statements below that revocation is “still” broken describe the old pin.

## Upstream since `260dbb4`

41 commits between the evening of 12 October and the morning of 13 October. Most are the store: pricing (shipping now included, 4×4 squares and 8×10 enlargements, mixed products in one order, volume pricing), private coupons and free checkout, receipts, emails and the homepage. What matters to Poppy:

- **An Agent Sandbox** (`639c591` to `0b88a9d`, `docs/SANDBOX.md`): `AGENT_SANDBOX=true`, allowed only with `APP_MODE=demo` and the compatibility path off, and refused with payment or print credentials installed. It is a separate deployment, https://sandbox.printwithpoppy.com, for testing agents without cards: the same storefront, `poppy.json` named "Print with Poppy — Agent Sandbox" with Mediated Sign-In only (no `auth.direct`), sign-in only for `@example.com`, `.org` or `.net` addresses, and four sandbox operations in the same OpenAPI description (`simulatePayment`, `simulateShipment`, `getSandboxEmails`, `getSandboxSignInEmail`, the last reading the captured sign-in code in the Session that started it). The live `poppy.json`'s API description now points agents without native Poppy support at the compatibility instructions. `docs/SANDBOX.md` says the live description links to the sandbox, which an agent discovers separately; no such link is in the server code at this commit. The adapter keeps plain demo mode (`AGENT_SANDBOX` unset), so Direct Sign-In and the hooks are as before.
- **Orders** (`proposalSchema`): `items[].product` (`prints`, `square`, `enlargement`, `poster`) and an optional `couponCode`; one poster and up to 100 prints per order, mixed. The OU fixture's order (one photo, `fit: contain`, no product) is still valid and prices as 4×6 prints.
- **Order status**: a view of an unpaid order queues a payment sync (live mode only), and a receipt route returns Stripe's receipt URL to the order's token holder.
- **Malformed JSON** answers with a message that no longer mentions compatibility Sessions.

The token, revocation, sign-in and Operations code (`server/auth.ts`, `server/signin.ts`, the Operations routes) is unchanged apart from refusing the `Demo` session scheme in the sandbox. `/oauth/revoke` still calls `verifyAssertion` without the token route's `try`/`catch`, so a refused revocation assertion is still a 500 (now `server/index.ts` lines 241-264). No cell should change.

## Upstream since `7ef69be`

26 commits on 12 October, `ab6ef2f` to `260dbb4`. Most are the storefront (artwork, copy, the homepage, a chat demo, hosted OpenAPI docs at `/docs`, email templates). What matters to Poppy:

- **Licence.** MIT (`c147418`).
- **Native and compatibility descriptions are separate** (`c147418`). `/openapi.json` (the one `poppy.json` lists) now describes DPoP only: `startGuestAgentSession` and the `AgentGuest` Bearer scheme moved to `/api/compat/openapi.json`, with their own instructions at `/api/compat/instructions`. At `7ef69be` the native description listed `POST /api/agent-sessions` with no security beside the DPoP operations, and every operation accepted either scheme. The homepage's copyable prompt changed from "Use the documented guest API if you do not support native Poppy sessions" to "Only if you do not support native Poppy sessions, read /api/compat/instructions".
- **`ALLOW_COMPAT_AGENT_SESSIONS=false` works in demo mode** (`c147418`), which retired our patch.
- **Malformed and oversized JSON bodies** answer 400 `invalid_request` and 413 `request_too_large` instead of 500 (`c147418`).
- **No `DPoP` header parameter** (`cecb32f`, "Fix PDA signed-out uploads by separating DPoP from operation parameters"). `7ef69be` listed an optional `DPoP` header parameter on every secured operation; `c147418` made it required; `cecb32f` removed it and says in the description that the client transport sets `Authorization: DPoP` and the proof. Our client asked the model for every required parameter, so against a description from those commits it refused any upload or order sent without a `DPoP` argument, before the card. It now ignores `DPoP`, `Authorization`, `Accept` and `Content-Type` header parameters (`TRANSPORT_HEADERS` in `src/poppy/apis.ts`; test in `test/print-journey.test.ts`).
- **Accounts** (`260dbb4`, `docs/ACCOUNTS.md`). `poppy.json` now has `auth.direct` and `auth.mediated` with `poppy:read` and `poppy:write`; the OAuth metadata has `authorization_endpoint`, the `authorization_code` and `refresh_token` grants, PKCE S256 and `scopes_supported`. Sign-in is by an emailed six-digit code, and the account is made when the code is first verified. New operations `getAccount` and `listAccountOrders` need `poppy:read`; signed in, proposing, confirming and cancelling need `poppy:write`. Account Tokens last 30 days and aren't rotated on refresh; `/oauth/revoke` revokes them. Guest ordering in a signed-out Session is unchanged.
- **Scope on a signed-out Session request** is refused with 400 `invalid_scope` ("Account scopes require sign-in"), where `7ef69be` ignored it: reading S4 moved from `either` to `omit`.

Nothing in the diff broke the adapter: the same environment starts the store, and the OU fixture still fits.

## The store's agent flow

Read from the pinned source (`server/index.ts`, `server/openapi.ts`, `server/commerce.ts`, `server/photos.ts`, `server/auth.ts`, `server/accounts.ts`, `server/signin.ts`, `server/worker.ts`), as an agent meets it:

1. **Discovery.** `poppy.json`: `auth.issuer` is the origin, `auth.direct` and `auth.mediated` (one field, `email`) with scopes `poppy:read` and `poppy:write`, one `openapi` API at `/openapi.json`, `extensions.operations` version 1 with `endpoint` `/api/operations`. No `agent` (no conversations), no `web`, no device sign-in. The OAuth metadata lists `/oauth/token`, `/oauth/authorize`, `/oauth/revoke` and the jwt-bearer, `authorization_code` and `refresh_token` grants.
2. **Session.** `POST /oauth/token`, jwt-bearer grant: a client assertion and a Session assertion, both `aud` exactly the token endpoint, at most 120 s; a DPoP proof; no `scope`. The `client_id` must be on `AGENT_CLIENT_IDS`, and its metadata and JWKS are fetched without redirects, cached five minutes. The answer is a DPoP Session Token for an hour, `scope: ""`, `signed_in: false`. Renewing with `session_id` keeps the same Session. The Session remembers whether the agent's metadata lists `operations` version 1.
3. **Direct Sign-In.** `/oauth/authorize` with `response_type=code`, a `redirect_uri` the agent's metadata lists, `scope`, `state` and an S256 challenge. The page asks for an email, sends a code to it, asks for the code, then shows the requested scopes as checkboxes with Allow and Cancel. Each form carries a flow id and CSRF token, the `poppy_signin` cookie and a same-origin `Origin`. The callback carries `code`, `state` and `iss`, or `error=access_denied`. The code (two minutes, single use) is exchanged at `/oauth/token` with the verifier, a client assertion, a DPoP proof and the Session's `session_id`.
4. **Mediated Sign-In.** `POST /api/poppy/sign-in` with `{scope, credentials: {email}}` and the Session Token answers `code_required` with a `sign_in_id`; `POST /api/poppy/sign-in/{sign_in_id}` with `{code}` from the same Session answers `complete` with an Account Token and a signed-in Session Token. Codes last ten minutes, allow five guesses and are used once.
5. **Every API call** needs `Authorization: DPoP` and a proof whose `htu` is the store's public origin and path.
6. **Upload.** `POST /api/photos` (`uploadPhoto`), `multipart/form-data` with one file in the field `photo` and no other field (multer: `files: 1, fields: 0`), at most 20 MB. sharp decodes it: JPEG, PNG or WebP, at most 40 megapixels, at least 300 px on the shorter side; anything else is 422 `invalid_image` or `image_too_small`, too big is 413 `upload_limit`. It answers 201 with the photo's `id` (`photo_…`), its name (the part's file name), size, a `lowResolution` flag and signed preview URLs. A Session keeps at most 100 photos; unused ones are deleted after 24 hours.
7. **Order.** `POST /api/orders` (`proposeOrder`) with a required `Idempotency-Key` of 16 to 128 letters, digits, `_` or `-` (a v4 UUID fits) and JSON `{email, address: {name, line1, line2?, city, state, postalCode, country: "US"}, items: [{photoId, quantity, fit: "contain" | "cover"}], product?: "prints" | "poster"}`. Signed in, it needs `poppy:write` first (403 `insufficient_scope`), and the order belongs to the account. An agent whose metadata doesn't list Operations v1 gets 403 `extension_required`. Otherwise 202 `{operation}`: `operation_id` (`op_…`), revision 1, `state: "proposed"`, a `summary` with the photos, crop, quantity, the full address, the email, prints, shipping, tax and total, the delivery estimate and the cancellation terms, `terms` (the whole quote: amounts in cents, the address, previews), `expires_at` 15 minutes on, `user_approval_required: true`, `confirmation: null`, `result: null`, and no `url`. The same key with the same body returns the same operation; with another body, 409 `idempotency_conflict`.
8. **Confirm.** `POST /api/operations/{id}/confirm` with exactly `{revision, approved_by: "user"}` (anything else is 400; another revision 409 `terms_changed`; another `approved_by` 403 `user_approval_required`). It answers the operation `in_progress` with `Retry-After: 2`; a background job prepares checkout every two seconds, and `GET /api/operations/{id}` then says `succeeded` with `result.summary` and `result.data`: `order_id`, `checkout_url` and `status_url`, the last two carrying a view token in the fragment. `succeeded` means a checkout exists, not that anything was paid or printed.
9. **Cancel.** `POST /api/operations/{id}/cancel` declines a proposal; a final operation is unchanged.
10. **Afterwards.** The User pays at `checkout_url` (Stripe-hosted Checkout outside demo mode); `GET /api/orders/{order_id}` reports payment, printing and shipping. An operation is only that Session's (Ops 3.2): another Session gets 404 `operation_not_found`. Signed in with `poppy:read`, `GET /api/account/orders` lists the account's orders.
11. **Sign-out.** `POST /oauth/revoke` with the Account Token and a client assertion whose `aud` is the revocation endpoint. Every Session Token of that grant loses its account access at once.
12. **Demo mode** (`APP_MODE=demo`, what the adapter runs): prices are computed locally with an illustrative 8.75% tax, checkout is a local URL, payment and shipping are simulated by `/api/demo/pay` and `/api/demo/ship`, and email, sign-in codes included, is stored in the SQLite file (`demo-signin-email` records), not sent. Nothing reaches Stripe, Prodigi or Resend.

The OpenAPI description lists `getOperation`, `confirmOperation` and `cancelProposal` under `/api/operations`; our client never calls those from the model's tools, because they are the operations endpoint (spec, Safety).

## Adapter

`GET /hooks` → `approve_authorization`, `deny_authorization`, `mediated_answers`, `last_one_time_code`, `expire_tokens`, `fixture`. Every other hook answers 501.

- `approve_authorization` and `deny_authorization` act as the person in the browser. They GET the authorization URL from the store directly (not through the proxy: these are the person's requests, not the agent's), POST the account's email, read the code the store "sent" from its SQLite, POST it, then POST Allow with the scopes asked for, or Cancel. The store shows Allow and Cancel only after the code, so a refusal signs in first. They return the 303's `Location`.
- `mediated_answers` → `{fields: {email}}`. `last_one_time_code` → the code in the newest code email.
- `expire_tokens` sets the expiry of every Session Token record to 0.
- `fixture`: one account, `ada@example.com` (made when its code is first verified), `scopes` `{read: ["poppy:read"], write: ["poppy:read", "poppy:write"]}`, no prompts (no conversations), `openapi` = `getAccount`, `openapi_write` = `proposeOrder` (signed in with `poppy:read` only, refused with `insufficient_scope` before the order is read), `openapi_public` = `getCatalog` (`GET /api/catalog`, which needs no Session), `openapi_upload` = `uploadPhoto` with `interop/files/lake.jpg` in `photo`, `openapi_propose` = `proposeOrder` of one 4×6 print of `${upload_id}` to a US address, `otp_account` = the same account.
- Unsupported: `require_nonce` (the store never asks for a DPoP nonce), `rate_limit` (its limits are fixed), `issuer_path` (the issuer is the origin), `end_sessions` (no way to end a Session), and the device, staff and operation hooks: there is no Device Sign-In, no conversation and no Company Agent to propose an operation.

The adapter reads and writes the store's SQLite with the store's own `better-sqlite3`, opening it for one hook and closing it after. Reading codes from demo mode's stored email, and rewriting token expiry, are in the manifest's `relaxations`.

Scenarios claimed: `D`, `S0`, `OU`, `CM`, `SD`, `SX`, `SMC`, `SO`, `AO`, `AS`, `R`. `OU` is the store's own path: the photo upload, then an order that proposes an operation in the signed-out Session ([N19](../../../docs/spec-issues.md#n19)), approved and confirmed. Not `SM`: the store's Mediated Sign-In always asks for a code (`SMC`). Not `O`, `OX`: they need a conversation in which the Company proposes. Not `N` (no nonces), `RL` (no `rate_limit` hook), `C`, `CI`, `CS`, `CA`, `SE` (no conversations), `SV`, `SXV` (no Device Sign-In). `R` runs to its end but the store doesn't rotate Account Tokens, so its last check, `refresh_rotated`, makes the cell unsupported.

Readings:

- `S1` `endpoint`: a client assertion's `aud` must be exactly the endpoint it is sent to, a string: the token endpoint at `/oauth/token`, the revocation endpoint at `/oauth/revoke`.
- `S2` `lenient-120s`: any `typ` but `poppy-browser+jwt`, and at most 120 s (`exp - iat ≤ 120`, `iat` no older than 120 s, 5 s of clock skew). Compatible with agents reading `jwt-60s` or `lenient-120s`; not with `lenient-300s` or `any`.
- `S3` `either`: the issuer is the bare origin, so both metadata locations are the same URL.
- `S4` `omit`: a `scope` on the jwt-bearer grant is refused with `invalid_scope`; every signed-out Session Token comes back with `scope: ""`.

## The grid

**At `260dbb4`** (run `2026-10-12T22:03:59Z`, `--companies print-with-poppy` with the seven honest agents and the 30 scenarios of the last full grid): 210 cells, 46 pass, 8 fail, 156 unsupported, no errors, every failure known.

| Agent | Pass | Fail | Why it fails |
| --- | --- | --- | --- |
| pda | D S0 CM SD SX SMC SO AO AS OU | none | |
| datalayer-ts, datalayer-py, pi-poppy | D S0 CM SD SX SMC SO AO AS | none | |
| adonis-agora | D S0 CM SD SX SMC AO AS | SO | Its revocation assertion's `aud` is the token endpoint ([S1](../../../docs/spec-issues.md#s1), as at poppyseed and pi-poppy). The store answers 500 `internal_error`, not 401 `invalid_client`: `/oauth/revoke` doesn't catch the assertion error ([server/index.ts](https://github.com/spenciefy/print-with-poppy/blob/260dbb4634f5dc0026d790715304be9b78783ff2/server/index.ts#L231-L254)). |
| poppy-demo | none | D S0 CM SD SX SO AO | Known: its caller reads `d.agent.protocols` for every Company ([session.ts line 178](https://github.com/irvinebroque/poppy-demo/blob/02a9b304e92fdfee465c57f2822742eecac8bdc8/workers/caller/src/session.ts#L178)), and this store, with no conversations, has no `agent` member. Before `260dbb4` it also lacked the `authorization_endpoint` the same line reads. |
| everruns | D | none | It starts a Session only for a conversation, so S0 and the rest are unsupported. |

R ran to its last step for the five agents that claim it (two expiries, two renewals with the Account Token, a signed-in read each time) and is unsupported only because the store doesn't rotate Account Tokens, so `refresh_rotated` has nothing to judge. Checks: no failures or warnings; 35 tentative S2 `typ` notes for pi-poppy's and adonis-agora's typ-less assertions, which this store accepts. The image builds in about a minute; npm finds prebuilt binaries for better-sqlite3 and sharp. It is about 625 MB on disk (about 150 MB compressed).

**At `7ef69be`** (12 October, runs `08:40:03Z` and, for OU, `10:00:01Z`): D and S0 passed for pda, datalayer-ts, datalayer-py, pi-poppy and adonis-agora, poppy-demo failed both at discovery, and pda passed OU at the store and at both of our mocks. The full grid that afternoon added CM ([results](../../../docs/interop-results/README.md)).
