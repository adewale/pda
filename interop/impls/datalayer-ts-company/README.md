# datalayer-ts (Company)

Datalayer's TypeScript Company ([datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), `src/company/`), running its reference Company, Manzanita Outfitters (`src/demo/manzanita.ts`), behind the hooks adapter for the interop harness ([spec](../../../docs/interop-spec.md) 5.3).

- **Upstream commit:** `12d71877d477b93f3ee68ebdc542560ba85997b9` (v0.6.0), fetched inside the image. Nothing upstream is vendored here.
- **Licence:** BSD-3-Clause (upstream). The adapter is ours.
- **Build:** `docker build -t interop/datalayer-ts-company:dev .` (same base as the agent image; `npm install --ignore-scripts`, no upstream lockfile).
- **Ports:** 8080 is the Company, served by the SDK's own `companyRequestListener` at `INTEROP_ORIGIN` (default `https://datalayer-ts.company.interop.test`). The listener rebuilds every request URL on `CompanyConfig.base`, so DPoP `htu` checks use the configured origin, not the proxy's inner request. 8081 is the hooks API.
- **Environment:** `INTEROP_SECRET`, `INTEROP_NAME`, `INTEROP_ORIGIN`, `NODE_EXTRA_CA_CERTS`.

## Hooks

The Company and the adapter run in one process; hooks call the `CompanyService` directly. `/reset` builds a fresh Manzanita with an empty store.

| Hook | Supported | How |
| --- | --- | --- |
| `approve_authorization` | yes | Opens the authorization URL on the service (as the user's browser would), reads `request_id` from the consent page, then `service.approveAuthorization`. Returns the callback with `code`, `state` and `iss`. |
| `deny_authorization` | yes | `service.denyAuthorization`: `error=access_denied`. |
| `approve_device` / `deny_device` | yes | `service.approveDevice` / `denyDevice`. |
| `mediated_answers` | yes | Ada's email and password (Manzanita has one account). |
| `last_one_time_code` | yes | Manzanita's code is fixed (`246810`). |
| `end_sessions` | yes | Deletes every Session and Session Token record (the adapter wraps the memory store to know their keys). Account Tokens survive. |
| `settle_operation` | yes | `service.settle`: only an operation `in_progress` can be settled (Manzanita's repair). |
| `fixture` | yes | Account `acct_ada`, scopes `orders:read orders:write`, `GET /api/orders`, and conversation texts that trigger `sign_in_required` and a proposal. |
| `staff_join`, `staff_reply`, `propose_operation` | 501 | The service has no public method for these; Manzanita's agent proposes an exchange when a signed-in user asks for one. |

**Manifest:** scenarios `D S0 SD SV SM SX SE SO C CI CS AO AS O O2 OX`. Not `N`: the Company never sends DPoP nonce challenges. Readings: `S1: token-endpoint` (the assertion `aud` must equal the token endpoint), `S3: insertion` (its issuer has no path, so both forms coincide), `S4: omit`.

## Relaxations and patches

- `organization.domain` and the issuer come from `INTEROP_ORIGIN` (Manzanita's `config.domain`, whose upstream default is `manzanita.example`). This is configuration upstream supports, not a patch.

Nothing else: the default client policy allows every agent, and the default URL policy checks only host strings, so `*.agent.interop.test` client metadata and JWKS are fetched without a relaxation. `patches/` is empty.

## Verified (11 October 2026, by hand through a TLS proxy)

- With **datalayer-ts** (agent): every hook above except `settle_operation`, across Direct, Device and Mediated journeys; see the agent's README.
- With other agents: see the report in the commit that added this directory.
