# everruns-company

> **Status (11 October 2026): not built end to end, not in `interop/registry.json`.** The `everruns-server` library compiled (about 25 minutes cold, with swap added to the colima VM), but the image build then failed with "No space left on device" on the shared Docker disk, so this adapter has not run, paired or passed any scenario. The Company adapter linked once, from an earlier revision; the agent adapter has never compiled. Add the registry entry once both images build and `npm run interop -- --agents everruns,dpa --companies everruns,dpa-mock` runs.

[everruns](https://github.com/everruns/everruns)' Poppy channel (a Company's front door for personal agents, `crates/server/src/channels/poppy/`) behind the interop adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) (version 1, section 5.3).

- **Upstream:** https://github.com/everruns/everruns at `b09c922cc305e88be93b6f10768ef3855531571f` (10 October 2026, "Poppy conversations reach sessions through the channel port (#4558)", the head of `main` on 11 October). It includes PR #4531, which added everruns' own interop run against pi-poppy (`scripts/poppy-interop.sh`); this adapter takes the same approach (everruns' in-process server and a stand-in turn runner), but over the network.
- **Licence:** MIT (everruns). Nothing is vendored: the Dockerfile fetches the commit, applies `patches/`, and compiles `adapter/main.rs` inside the workspace.
- **Registry name:** `everruns`, role `company`; reached as `everruns.company.interop.test`.

## How it runs

The adapter is an integration-test target of `everruns-server` (copied to `crates/server/tests/interop_adapter/main.rs` at build time), because everruns' in-process server assembly is its test harness, `crates/server/tests/test_harness.rs`, compiled here from the pinned checkout. The binary runs one ignored test, `serve`, until killed.

- **Port 8080:** everruns' real router in in-memory mode (an embedded PostgreSQL per process; its binaries are downloaded at image build time into `EVERRUNS_PG_CACHE`), with one agent and one published `poppy` channel whose domain is the INTEROP_ORIGIN host. A small front serves the channel's discovery document at `/.well-known/poppy.json` (`EVERRUNS_WELL_KNOWN=redirect` answers with the 302 to `/api/v1/channels/{id}/poppy/poppy.json?domain=…` that everruns' docs tell a company to serve instead) and forwards everything else.
- **Issuer:** `https://everruns.company.interop.test/api/v1/channels/{channel_id}/poppy`. The channel id changes on every `/reset`. RFC 8414 metadata is served at both the insertion location (`/.well-known/oauth-authorization-server/api/v1/channels/{id}/poppy`) and the append location.
- **The channel's agent** is a stand-in turn runner that answers each turn with `Reply N`, as in everruns' own channel tests. No model.
- **Port 8081:** `GET /manifest`, `GET /healthz` (no auth), `POST /reset` (a new server, database and channel), `GET /hooks`, `POST /hooks/<name>` (Bearer `INTEROP_SECRET`; a hook's response body is its result).

Build: `docker build -t interop/everruns-company:dev interop/impls/everruns-company`. See everruns-agent's README for build time and memory: compiling `everruns-server` needs more than 5 GB free, and `CARGO_BUILD_JOBS` defaults to 1.

## What works

| Scenario | |
| --- | --- |
| D | Discovery: `poppy.json`, and RFC 8414 metadata at both locations. |
| S0 | Signed-out Sessions: jwt-bearer grant, `private_key_jwt`, DPoP-bound ES256 Session Tokens. |
| C, CI | Conversations: start, send, events with `wait`, retries by message id. |

Hooks: `fixture` only (`{"accounts": [], "scopes": [], "prompts": {"hello"}}`). Every other hook answers 501, including `require_nonce`, `rate_limit` and `expire_tokens`: the channel has no sign-in, staff, operations, nonces or on-demand Session ending, and its rate limit is per minute from config.

## What doesn't

- No sign-in (Direct, Device or Mediated), APIs, SSE, handoff to a person (handoff answers that no one is available), Operations or DPoP nonces.
- The issuer, endpoints and DPoP `htu` come from the request's `Host` and `X-Forwarded-Proto` headers, where spec 3 says they MUST come from the configured origin. The front pins both headers to INTEROP_ORIGIN, so the Company behaves as configured.

## Patches and relaxations

1. `patches/0001-interop-allow-private-networks.patch` (interop-only, off by default): `EVERRUNS_INTEROP_ALLOW_PRIVATE_NETWORKS=1`, set by the image, lets RFC 1918 addresses through `is_blocked_ip`, the SSRF check after DNS pinning. Every `*.interop.test` name resolves to the proxy on a private Docker network, so without it the Company can't fetch any agent's client metadata or JWKS. Loopback, link-local, metadata, CGNAT and documentation ranges stay blocked.
2. `patches/0002-renumber-duplicate-migrations.patch` (a build fix): at this commit three migrations share version 218, so a fresh database can't be migrated (`duplicate key value violates unique constraint "_sqlx_migrations_pkey"`).
3. `patches/0003-expose-poppy-client-to-adapter.patch` (visibility only): not needed by this adapter, but applied so both everruns images build the same `everruns-server` and share one compile.
4. The front pins `Host` and `X-Forwarded-Proto` to INTEROP_ORIGIN.
5. In-memory mode, with a stand-in turn runner instead of a model.
6. The front serves `/.well-known/poppy.json`, the company-website part everruns leaves to the company.

TLS: no change. everruns' reqwest 0.13 (`rustls`) client trusts the system store, which `SSL_CERT_FILE` points at `/interop/ca.pem`.

## Readings

`S1: token-endpoint` (the Session assertion's `aud` must be exactly the token endpoint; the client assertion may name the token endpoint or the issuer), `S2: any` (no `typ` required, lifetime up to 300 s), `S3: either`, `S4: omit` (`scope` on a signed-out Session request is `invalid_scope`). No nonces, so no `S23`.
