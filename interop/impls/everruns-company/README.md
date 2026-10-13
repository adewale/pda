# everruns-company

> **Status (12 October 2026): in the grid as `everruns` (role `company`), first run that day.** With the six other agents and everruns' own over the 25 scenarios of [the last grid](../../../docs/interop-results/README.md): 24 pass, 3 fail, 148 unsupported, 0 errors, every failure a known one. dpa, both Datalayer agents, pi-poppy, adonis-agora and everruns pass D, S0, C and CI; poppy-demo's caller fails D, S0 and C on its issuer-origin rule, as at the other Companies whose issuer isn't their origin. Image: 689 MB on disk (148 MB compressed).

[everruns](https://github.com/everruns/everruns)' Poppy channel (a Company's front door for personal agents, `crates/server/src/channels/poppy/`) behind the interop adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) (version 1, section 5.3).

- **Upstream:** https://github.com/everruns/everruns at `aceb2e2fcfdf9c91022e390ee5efe5a773043bb2` (13 October 2026, the head of `main` that morning; [what changed](#what-changed-upstream-pin-moved-13-october)). Before that, `f470ad7` (12 October). The pin moved from `b09c922` (10 October, "Poppy conversations reach sessions through the channel port (#4558)"); `crates/server/src/channels/poppy/` is the same at both, and the move dropped the migration patch (fixed upstream in #4560, then squashed into one baseline by #4581). It includes PR #4531, which added everruns' own interop run against pi-poppy (`scripts/poppy-interop.sh`); this adapter takes the same approach (everruns' in-process server and a stand-in turn runner), but over the network.
- **Licence:** MIT (everruns). Nothing is vendored: the Dockerfile fetches the commit, applies `patches/`, and compiles `adapter/main.rs` inside the workspace.
- **Registry name:** `everruns`, role `company`; reached as `everruns.company.interop.test`.

## What changed upstream (pin moved 13 October)

60 commits from `f470ad7` to `aceb2e2`, 12 and 13 October. None touches the Poppy code: `crates/capabilities/src/capabilities/poppy_client/`, `crates/server/src/domains/poppy_agent/`, `crates/server/src/channels/poppy/`, `crates/contracts/src/url_validation.rs` (patch 0001) and `crates/server/tests/test_harness.rs` are byte for byte the same, so both patches apply unchanged and the known failures' links into `poppy_client` point at the same lines. The rest is platform work: platform turns now run only as session actors and the durable engine is retired (#4629; the `TurnBackend` trait the Company's stand-in runner implements changed only in its comments), read-only personal access tokens, bound secrets, web search drivers, attachments kept through compaction, GitHub App tokens and docs. The image rebuilt cleanly with the same `adapter/main.rs`, and the smoke test passed (13 October: D and S0 against dpa-mock as an agent, D, S0 and C against dpa as a Company).

## How it runs

The adapter is an integration-test target of `everruns-server` (copied to `crates/server/tests/interop_adapter/main.rs` at build time), because everruns' in-process server assembly is its test harness, `crates/server/tests/test_harness.rs`, compiled here from the pinned checkout. The image runs the ignored test `serve`, a supervisor that owns ports 8080 and 8081, runs the adapter proper (the ignored test `child`) as a child process on loopback ports and forwards to it, and answers `/reset` by starting a new child (about 1.5 s): starting a new in-process server on each reset, as the first version did, leaked about 280 MB a reset (see everruns-agent's README).

- **Port 8080:** everruns' real router in in-memory mode (an embedded PostgreSQL per process; its binaries are downloaded at image build time into `EVERRUNS_PG_CACHE`), with one agent and one published `poppy` channel whose domain is the INTEROP_ORIGIN host. A small front serves the channel's discovery document at `/.well-known/poppy.json` (`EVERRUNS_WELL_KNOWN=redirect` answers with the 302 to `/api/v1/channels/{id}/poppy/poppy.json?domain=…` that everruns' docs tell a company to serve instead) and forwards everything else.
- **Issuer:** `https://everruns.company.interop.test/api/v1/channels/{channel_id}/poppy`. The channel id changes on every `/reset`. RFC 8414 metadata is served at both the insertion location (`/.well-known/oauth-authorization-server/api/v1/channels/{id}/poppy`) and the append location.
- **The channel's agent** is a stand-in turn runner that answers each turn with `Reply N`, as in everruns' own channel tests. No model.
- **Port 8081:** `GET /manifest`, `GET /healthz` (no auth), `POST /reset` (a new process, server, database and channel), `GET /hooks`, `POST /hooks/<name>` (Bearer `INTEROP_SECRET`; a hook's response body is its result).

Build: the runner builds it as `poppy-interop/company-everruns:<tag>`; by hand, `docker build -t poppy-interop/company-everruns:latest interop/impls/everruns-company`. See everruns-agent's README for build time and memory: compiling `everruns-server` needs more memory than an 8 GB colima VM has without swap, and `CARGO_BUILD_JOBS` defaults to 1.

## Results

12 October 2026, local lane, `--image-tag evr`, the egress probe got nowhere, no flaky cell, no stale known failure. dpa, datalayer-ts, datalayer-py, pi-poppy, adonis-agora and everruns pass D, S0, C and CI here (poppy-demo doesn't list CI). poppy-demo fails D, S0 and C: its caller requires `auth.issuer` to be the Company's origin, and a channel's issuer is `…/api/v1/channels/{id}/poppy` (the draft allows both; a known failure, blamed on the agent by rule 2, as at dpa-mock, dpa-mock-strict and adonis-agora). No agent tripped a check here, and the Company recorded nothing (it serves no `/violations`).

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
2. `patches/0002-expose-signing-key-to-adapter.patch` (visibility only): not needed by this adapter, but applied so both everruns images build the same `everruns-server` and share one compile.
3. The front pins `Host` and `X-Forwarded-Proto` to INTEROP_ORIGIN.
4. In-memory mode, with a stand-in turn runner instead of a model.
5. The front serves `/.well-known/poppy.json`, the company-website part everruns leaves to the company.

TLS: no change. everruns' reqwest 0.13 (`rustls`) client trusts the system store, which `SSL_CERT_FILE` points at `/interop/ca.pem`.

## Readings

`S1: token-endpoint` (the Session assertion's `aud` must be exactly the token endpoint; the client assertion may name the token endpoint or the issuer), `S2: lenient-300s` (no `typ` required, lifetime up to 300 s: `MAX_LIFETIME_SECS` in `channels/poppy/client.rs`; declared `any` until 12 October), `S3: either`, `S4: omit` (`scope` on a signed-out Session request is `invalid_scope`). No nonces, so no `S23`.
