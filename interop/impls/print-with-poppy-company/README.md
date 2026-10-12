# print-with-poppy (Company)

[spenciefy/print-with-poppy](https://github.com/spenciefy/print-with-poppy), an agent-first photo-printing store: an Express server with SQLite (better-sqlite3) and image processing (sharp). It runs in its own demo mode in the container, with the [interop spec](../../../docs/interop-spec.md) 5.3 adapter in front.

- **Pinned commit:** `7ef69bef9ca9e485386b28a679c532ed7cbee739` (11 October 2026), cloned and checked out in the image build.
- **Licence:** none declared. The repository has no `LICENSE` and its `package.json` has no `license` field (only its two fonts carry their own licences). We fetch and run it unchanged except for the patch below and copy none of its code; the patch necessarily quotes the few lines it changes. Ask the author before publishing results widely.
- **Ports:** the store on 8080 (behind the proxy as `print-with-poppy.company.interop.test`), the adapter on 8081.
- **Image:** two stages on `node:22-bookworm-slim` (upstream's `engines` says Node 22). The build stage has git and a compiler, as upstream's own image does, in case a native module has no prebuilt binary; the run stage has only `server/`, `src/offer.ts` and the production `node_modules`. The browser frontend isn't built: no Poppy endpoint serves it, so `/` answers upstream's 503 "run npm run build" page.

**Demo boundary:** this no-charge environment is the container running `APP_MODE=demo`, not the public `printwithpoppy.com` store. The public `/demo` page is a scripted visual walkthrough, not an API test environment. Check `/api/config` for the mode before testing; never assume the production domain simulates payment. The OU result below covers upload through checkout preparation, not simulated payment and shipment.

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

## The store's agent flow

Read from the pinned source (`server/index.ts`, `server/openapi.ts`, `server/commerce.ts`, `server/photos.ts`, `server/auth.ts`, `server/worker.ts`, `scripts/agent.ts`), as an agent meets it:

1. **Discovery.** `poppy.json`: `auth.issuer` is the origin, one `openapi` API at `/openapi.json`, `extensions.operations` version 1 with `endpoint` `/api/operations`. No `agent`, no `web`, no sign-in types. The OAuth metadata lists `/oauth/token`, `/oauth/revoke` (never issues Account Tokens) and the jwt-bearer grant only.
2. **Session.** `POST /oauth/token`, jwt-bearer grant: a client assertion and a Session assertion, both `aud` exactly the token endpoint, at most 120 s; a DPoP proof. The `client_id` must be on `AGENT_CLIENT_IDS`, and its metadata and JWKS are fetched without redirects, cached five minutes. The answer is a DPoP Session Token for an hour, `scope: ""`, `signed_in: false`. Renewing with `session_id` keeps the same Session. The Session remembers whether the agent's metadata lists `operations` version 1.
3. **Every API call** needs `Authorization: DPoP` and a proof whose `htu` is the store's public origin and path.
4. **Upload.** `POST /api/photos` (`uploadPhoto`), `multipart/form-data` with one file in the field `photo` and no other field (multer: `files: 1, fields: 0`), at most 20 MB. sharp decodes it: JPEG, PNG or WebP, at most 40 megapixels, at least 300 px on the shorter side; anything else is 422 `invalid_image` or `image_too_small`, too big is 413 `upload_limit`. It answers 201 with the photo's `id` (`photo_…`), its name (the part's file name), size, a `lowResolution` flag and signed preview URLs. A Session keeps at most 100 photos; unused ones are deleted after 24 hours.
5. **Order.** `POST /api/orders` (`proposeOrder`) with a required `Idempotency-Key` of 16 to 128 letters, digits, `_` or `-` (a v4 UUID fits) and JSON `{email, address: {name, line1, line2?, city, state, postalCode, country: "US"}, items: [{photoId, quantity, fit: "contain" | "cover"}], product?: "prints" | "poster"}`. An agent whose metadata doesn't list Operations v1 gets 403 `extension_required`. Otherwise 202 `{operation}`: `operation_id` (`op_…`), revision 1, `state: "proposed"`, a `summary` with the photos, crop, quantity, the full address, the email, prints, shipping, tax and total, the delivery estimate and the cancellation terms, `terms` (the whole quote: amounts in cents, the address, previews), `expires_at` 15 minutes on, `user_approval_required: true`, `confirmation: null`, `result: null`, and no `url`. The same key with the same body returns the same operation; with another body, 409 `idempotency_conflict`.
6. **Confirm.** `POST /api/operations/{id}/confirm` with exactly `{revision, approved_by: "user"}` (anything else is 400; another revision 409 `terms_changed`; another `approved_by` 403 `user_approval_required`). It answers the operation `in_progress` with `Retry-After: 2`; a background job prepares checkout every two seconds, and `GET /api/operations/{id}` then says `succeeded` with `result.summary` and `result.data`: `order_id`, `checkout_url` and `status_url`, the last two carrying a view token in the fragment. `succeeded` means a checkout exists, not that anything was paid or printed.
7. **Cancel.** `POST /api/operations/{id}/cancel` declines a proposal; a final operation is unchanged.
8. **Afterwards.** The User pays at `checkout_url` (Stripe-hosted Checkout outside demo mode); `GET /api/orders/{order_id}` reports payment, printing and shipping. An operation is only that Session's (Ops 3.2): another Session gets 404 `operation_not_found`.
9. **Demo mode** (`APP_MODE=demo`, what the adapter runs): prices are computed locally with an illustrative 8.75% tax, checkout is a local URL, payment and shipping are simulated by `/api/demo/pay` and `/api/demo/ship`, and email is stored, not sent. Nothing reaches Stripe, Prodigi or Resend.

The OpenAPI description lists `getOperation`, `confirmOperation` and `cancelProposal` under `/api/operations`; our client never calls those from the model's tools, because they are the operations endpoint (spec, Safety).

## Adapter

`GET /hooks` → `fixture`. Every other hook answers 501.

- `fixture`: no accounts and no scopes (signed out only), no prompts (no conversations), `openapi_public` = `getCatalog` (`GET /api/catalog`, which needs no Session), `openapi_upload` = `uploadPhoto` with `interop/files/lake.jpg` in `photo`, `openapi_propose` = `proposeOrder` of one 4×6 print of `${upload_id}` to a US address, `otp_account: null`.
- Unsupported: `require_nonce` (the store never asks for a DPoP nonce), `rate_limit` (its limits are fixed), `expire_tokens` (Session Tokens live an hour), `issuer_path` (the issuer is the origin), and every sign-in, staff and operation hook: there is no sign-in, no conversation and no Company Agent to propose an operation.

Scenarios claimed: `D`, `S0`, `OU`, `CM`. `OU` is the store's own path: the photo upload, then an order that proposes an operation in the signed-out Session ([N19](../../../docs/spec-issues.md#n19)), approved and confirmed. Not `AO`, `AS`, `O`, `OX`: as written they start with Direct Sign-In (and `O`, `OX` with a conversation in which the Company proposes), and the store has neither. Not `N` (no nonces), `RL` (no `rate_limit` hook), `C`, `CI`, `CS`, `CA` (no conversations), `SO`, `R`, `SE` (no Account Tokens).

Readings:

- `S1` `endpoint`: a client assertion's `aud` must be exactly the endpoint it is sent to, a string: the token endpoint at `/oauth/token`, the revocation endpoint at `/oauth/revoke`.
- `S2` `lenient-120s`: any `typ` but `poppy-browser+jwt`, and at most 120 s (`exp - iat ≤ 120`, `iat` no older than 120 s, 5 s of clock skew). Compatible with agents reading `jwt-60s` or `lenient-120s`; not with `lenient-300s` or `any`.
- `S3` `either`: the issuer is the bare origin, so both metadata locations are the same URL.
- `S4` `either`: the jwt-bearer grant ignores `scope`; every Session Token comes back with `scope: ""`.

## The grid (runner, 12 October 2026, run 2026-10-12T08:40:03Z)

| Agent | Pass | Fail | Why it fails |
| --- | --- | --- | --- |
| dpa, datalayer-ts, datalayer-py, pi-poppy, adonis-agora | D S0 | none | |
| poppy-demo | none | D S0 | A known failure, as at Ilmer: its caller checks `authorization_endpoint` and `agent.protocols` for every Company ([session.ts line 178](https://github.com/irvinebroque/poppy-demo/blob/02a9b304e92fdfee465c57f2822742eecac8bdc8/workers/caller/src/session.ts#L178)), and this store, signed out with no conversations, has neither, so discovery throws. |

**OU** (12 October 2026, run 2026-10-12T10:00:01Z, `--agents dpa --companies dpa-mock,dpa-mock-strict,print-with-poppy --scenarios OU`): dpa passes at all three, with no check failing and no warning. At the store: discovery, a signed-out Session, the OpenAPI description, `POST /api/photos` as `multipart/form-data` after the held upload was approved (201, a 480×360 JPEG flagged low-resolution), `POST /api/orders` with an `Idempotency-Key` (202, the operation), the confirm (`in_progress`), one read after `Retry-After` (`succeeded`, with the checkout link), and the same Session at the end.

No check failed; the only findings are three tentative S2 `typ` notes for pi-poppy's and adonis-agora's typ-less assertions, which this store accepts. The image builds in about a minute; npm found prebuilt binaries for better-sqlite3 and sharp. It is about 625 MB on disk (about 150 MB compressed). With the patch, `POST /api/agent-sessions` answers 404 `not_available` and a `Bearer` token gets 401 `invalid_token`, checked in a container with no network.
