# everruns-agent

> **Status (11 October 2026): not built end to end, not in `interop/registry.json`.** The `everruns-server` library compiled (about 25 minutes cold, with swap added to the colima VM), but the image build then failed with "No space left on device" on the shared Docker disk, so this adapter has not run, paired or passed any scenario. The Company adapter linked once, from an earlier revision; the agent adapter has never compiled. Add the registry entry once both images build and `npm run interop -- --agents everruns,dpa --companies everruns,dpa-mock` runs.

[everruns](https://github.com/everruns/everruns) as a Poppy Personal Agent (`crates/server/src/domains/poppy_agent/`, the `poppy_client` capability) behind the interop adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) (version 1, section 5.2).

- **Upstream:** https://github.com/everruns/everruns at `b09c922cc305e88be93b6f10768ef3855531571f` (10 October 2026, the head of `main` on 11 October). It includes PR #4531 (`scripts/poppy-interop.sh`), where everruns runs its own agent against pi-poppy's Company in-process; this adapter drives the same entry point over the network.
- **Licence:** MIT (everruns). Nothing is vendored: the Dockerfile fetches the commit, applies `patches/`, and compiles `adapter/main.rs` inside the workspace.
- **Registry name:** `everruns`, role `agent`. Its `client_id` is `https://everruns.agent.interop.test/api/v1/poppy/agent.json` (INTEROP_ORIGIN + `/api` + everruns' fixed path), its JWKS `…/api/v1/poppy/jwks.json`.

## How it runs

The adapter is an integration-test target of `everruns-server` (copied to `crates/server/tests/interop_adapter/main.rs`), using everruns' in-process server assembly (`crates/server/tests/test_harness.rs`, compiled from the pinned checkout) in in-memory mode: an embedded PostgreSQL per process, its binaries downloaded at image build time. The binary runs one ignored test, `serve`, until killed.

- Conversation steps call `dispatch("worker_poppy_call", …)`: the internal command the `poppy_client` tools use, with everruns' real `DirectEgressService` (DNS pinning, SSRF guard, no redirects for credentials). `discover` calls `PoppyAgent::discover`, the same client code, directly. No model.
- **Port 8080:** everruns' router, which publishes the client metadata and JWKS.
- **Port 8081:** `GET /manifest`, `GET /healthz`, `POST /reset` (a new server and database: a new signing key, no Users or Sessions), `POST /step`.

Build: `docker build -t interop/everruns-agent:dev interop/impls/everruns-agent`. A cold build takes about 25 minutes on 4 CPUs, and compiling `everruns-server` (one 360,000-line crate) needs more than the 5 GB a busy 8 GB colima VM had free: it was OOM-killed until the VM had swap. `CARGO_BUILD_JOBS` defaults to 1 for that reason. The cargo caches are shared with everruns-company (`id=everruns-*`, `sharing=locked`), so the second image only links its own test target.

## Ops

| op | Support |
| --- | --- |
| `discover` | Yes. `apis` are the APIs' `type`s. A document everruns won't use is `{"ok": false, "poppy_error": "discovery_failed", "status": 0, "detail"}`. |
| `session` | Yes. If the label's everruns session already holds a Poppy Session, that is the answer. Otherwise a `read` there discovers, starts a signed-out Session and stores it, then stops for want of a conversation; the adapter reads the stored `poppy_session_id`. `scope` is `null` (everruns doesn't keep it). |
| `send` | Yes. No `conversation` starts a new one when the label already has one; a `message_id` already used by the label is a retry into the same conversation (spec 5.2). `wait` is in seconds, default 0 (everruns moves its cursor past whatever a send returns, so a reply waited for here would never appear in a later `read`), at most 30. Messages are the Company's (`role: company`). A `conversation` other than the label's current one is 501. |
| `read` | Yes, from everruns' own cursor; `wait` in seconds. A `cursor` parameter is 501; `has_more` is `null` (everruns doesn't read or follow it). |
| `state` | Yes, from everruns' stored conversation rows, without tokens. |
| `signin`, `signin_continue`, `signout`, `sse`, `api`, `web_join`, `approve_op` | 501. everruns' personal agent is signed-out only, with no revocation, event streams, APIs or Operations. |

Errors: everruns reports a Company's refusal as a sentence for the model ("… refused the message: conversation_closed (…)"); the adapter returns `{"ok": false, "poppy_error": "<code>", "status": null, "detail"}`. everruns doesn't keep the HTTP status, so `status` is `null` unless the code was `HTTP nnn`. An unreachable Company is a 502 adapter error.

Scenarios: D, S0, C, CI. N needs `api`, so it's unsupported.

## Readings

`S1: token-endpoint` (both assertions), `S2: any` (the client assertion has `typ: JWT`; the Session assertion has no `typ`; both live 60 s), `S3: append` (`{issuer}/.well-known/oauth-authorization-server`), `S4: omit`, `S23: per-origin`.

## Patches and relaxations

1. `patches/0001-interop-allow-private-networks.patch` (interop-only, off by default): `EVERRUNS_INTEROP_ALLOW_PRIVATE_NETWORKS=1`, set by the image, lets RFC 1918 addresses through `is_blocked_ip`, the SSRF check after DNS pinning, because every `*.interop.test` name resolves to the proxy on a private Docker network. Loopback, link-local, metadata, CGNAT and documentation ranges stay blocked.
2. `patches/0002-renumber-duplicate-migrations.patch` (a build fix, not interop-specific): at this commit three migrations share version 218 (#4546, #4549 and #4553 merged in parallel), so a fresh database fails with `duplicate key value violates unique constraint "_sqlx_migrations_pkey"`. Two are renumbered to 219 and 220.
3. `patches/0003-expose-poppy-client-to-adapter.patch` (visibility only): `domains::poppy_agent::protocol`, `signing_key` and `channels::a2a::pact_keys` become `pub`, so `discover` can call `PoppyAgent::discover`. The `poppy_discover` tool's answer leaves out the issuer.
4. In-memory mode; the deployment's public base URL comes from INTEROP_ORIGIN (`configure_public_base_url`).
5. The front pins `Host` and `X-Forwarded-Proto` to INTEROP_ORIGIN.

TLS: no change. everruns' reqwest 0.13 (`rustls`) client trusts the system store, and `SSL_CERT_FILE` points it at `/interop/ca.pem`.

## Known issues it will show

- A DPoP nonce retry reuses the Session assertion (signed once, outside the retry loop), so Companies that require nonces and refuse a reused `jti` refuse the retry (Guides, Retries; `protocol.rs` `start_session`).
- OAuth metadata is fetched at the append location, not the RFC 8414 insertion location (spec 3.2), so it fails at Companies whose issuer has a path and that serve only the insertion location.
- The Session assertion has no `typ`, so Companies that require `typ: JWT` refuse it.
