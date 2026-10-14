# everruns-agent

> **Status (12 October 2026): in the grid as `everruns` (role `agent`), first run that day.** Against all eleven Companies over the 25 scenarios of [the last grid](../../../docs/interop-results/README.md): 32 pass, 11 fail, 232 unsupported, 0 errors, every failure a known one. It passes D, S0, C and CI at pda-mock, both Datalayer Companies, pi-poppy, poppyseed, adonis-agora and everruns' own Company, and D at the other four; the failures are its Session assertion's missing `typ` at the three Companies that require it (S2, the spec's) and DP at our two mocks (it reads S3 `append`). Image: 689 MB on disk (148 MB compressed).

[everruns](https://github.com/everruns/everruns) as a Poppy Personal Agent (`crates/server/src/domains/poppy_agent/`, the `poppy_client` capability) behind the interop adapter of [docs/interop-spec.md](../../../docs/interop-spec.md) (version 1, section 5.2).

- **Upstream:** https://github.com/everruns/everruns at `aceb2e2fcfdf9c91022e390ee5efe5a773043bb2` (13 October 2026, the head of `main` that morning; [what changed](#what-changed-upstream-pin-moved-13-october)). Before that, `f470ad7` (12 October). The pin moved from `b09c922` (10 October), 64 commits earlier, because the move needed only a small change: #4577 moved the protocol client (`PoppyAgent`, `PoppyClient`) into `everruns-capabilities` (`crates/capabilities/src/capabilities/poppy_client/`, public behind the `poppy-client` feature), with no change in what it sends, and #4560 and #4581 fixed the duplicate migration numbers (then squashed every migration into one baseline), so two of the three patches went. It includes PR #4531 (`scripts/poppy-interop.sh`), where everruns runs its own agent against pi-poppy's Company in-process; this adapter drives the same entry point over the network.
- **Licence:** MIT (everruns). Nothing is vendored: the Dockerfile fetches the commit, applies `patches/`, and compiles `adapter/main.rs` inside the workspace.
- **Registry name:** `everruns`, role `agent`. Its `client_id` is `https://everruns.agent.interop.test/api/v1/poppy/agent.json` (INTEROP_ORIGIN + `/api` + everruns' fixed path), its JWKS `…/api/v1/poppy/jwks.json`.

## What changed upstream (pin moved 13 October)

60 commits from `f470ad7` to `aceb2e2`, 12 and 13 October. None touches the Poppy code: `crates/capabilities/src/capabilities/poppy_client/`, `crates/server/src/domains/poppy_agent/`, `crates/server/src/channels/poppy/`, `crates/contracts/src/url_validation.rs` (patch 0001) and `crates/server/tests/test_harness.rs` are byte for byte the same, so both patches apply unchanged and the known failures' links into `poppy_client` point at the same lines. The rest is platform work: platform turns now run only as session actors and the durable engine is retired (#4629; the `TurnBackend` trait the Company's stand-in runner implements changed only in its comments), read-only personal access tokens, bound secrets, web search drivers, attachments kept through compaction, GitHub App tokens and docs. The image rebuilt cleanly with the same `adapter/main.rs`, and the smoke test passed (13 October: D and S0 against pda-mock as an agent, D, S0 and C against pda as a Company).

## How it runs

The adapter is an integration-test target of `everruns-server` (copied to `crates/server/tests/interop_adapter/main.rs`), using everruns' in-process server assembly (`crates/server/tests/test_harness.rs`, compiled from the pinned checkout) in in-memory mode: an embedded PostgreSQL per process, its binaries downloaded at image build time. The image runs the ignored test `serve`, a supervisor: it owns ports 8080 and 8081 and runs the adapter proper (the ignored test `child`) as a child process on loopback ports, forwarding every request to it, and answers `/reset` by killing the child and starting another (about 1.5 s). The first version started a new in-process server on each reset instead, and the harness keeps every server's router, pool and background tasks alive for the life of the process (it leaks its listener handles on purpose), so the container grew by about 280 MB a reset and died about twenty cells into its first run. A new process is a new embedded PostgreSQL (everruns spawns postgres with `PR_SET_PDEATHSIG`, so it dies with the child), a new database and a new signing key.

- Conversation steps call `dispatch("worker_poppy_call", …)`: the internal command the `poppy_client` tools use (`crates/server/src/domains/poppy_agent/commands.rs`, which runs the library's `PoppyClient` over a database store), with everruns' real `DirectEgressService` (DNS pinning, SSRF guard, no redirects for credentials). `discover` calls `PoppyAgent::discover`, the same client code, directly. No model.
- **Port 8080:** everruns' router, which publishes the client metadata and JWKS.
- **Port 8081:** `GET /manifest`, `GET /healthz`, `POST /reset` (a new process, server and database: a new signing key under a new `kid`, no Users or Sessions), `POST /step`.

Build: the runner builds it as `poppy-interop/agent-everruns:<tag>`; by hand, `docker build -t poppy-interop/agent-everruns:latest interop/impls/everruns-agent`. About 10 minutes from a cold cache on 4 CPUs (the dependencies about 4, then `everruns-server` and the test target about 6), and a rebuild after an adapter change about 6. Compiling `everruns-server` (one 360,000-line crate) needs more memory than an 8 GB colima VM has free: rustc was OOM-killed twice on 12 October, at two jobs and at one, until the VM's 6 GB swap file (`/swapfile-interop`, see [deployment-tasks](../../../docs/deployment-tasks.md)) was on. `CARGO_BUILD_JOBS` defaults to 1 for that reason. The cargo caches are shared with everruns-company (`id=everruns-*`, `sharing=locked`).

## Ops

| op | Support |
| --- | --- |
| `discover` | Yes. `apis` are the APIs' `type`s. A document everruns won't use is `{"ok": false, "poppy_error": "discovery_failed", "status": 0, "detail"}`. |
| `session` | Yes. If the label's everruns session already holds a Poppy Session, that is the answer. Otherwise a `read` there discovers, starts a signed-out Session and stores it, then stops for want of a conversation; the adapter reads the stored `poppy_session_id`. `scope` is `null` (everruns doesn't keep it). At a Company with no conversations (print-with-poppy) everruns starts no Session at all, since it uses one only for a conversation and has no API support, so `session` is 501 there. |
| `send` | Yes. No `conversation` starts a new one when the label already has one. A `message_id` already used by the label is a retry key (spec 5.2): the same request again, so a retried first message starts the conversation again (everruns' `new_conversation`, which 7.3 says returns the conversation already started) rather than going to that conversation's messages, which poppyseed and adonis-agora refuse with `message_id_conflict` ([S9](../../../docs/spec-issues.md#s9)); the Datalayer adapters do the same. `wait` is in seconds, default 0, at most 30. Messages are the Company's (`role: company`). A `conversation` other than the label's current one is 501. |
| `read` | Yes, from everruns' own cursor; `wait` in seconds. Its `messages` are every Company message everruns' client has handed back in that conversation, from sends and reads (as pda-agent answers from its inbox), because everruns moves its cursor past whatever a call returns: a Company that answers in the send's response (our mock does, even at `wait=0`) would otherwise leave nothing for scenario C's read. A `cursor` parameter is 501; `has_more` is `null` (everruns doesn't read or follow it). |
| `state` | Yes, from everruns' stored conversation rows, without tokens. |
| `signin`, `signin_continue`, `signout`, `sse`, `api`, `web_join`, `approve_op` | 501. everruns' personal agent is signed-out only, with no revocation, event streams, APIs or Operations. |

Errors: everruns reports a Company's refusal as a sentence for the model ("… refused the message: conversation_closed (…)"); the adapter returns `{"ok": false, "poppy_error": "<code>", "status": null, "detail"}`. everruns doesn't keep the HTTP status, so `status` is `null` unless the code was `HTTP nnn`. An unreachable Company is a 502 adapter error.

Scenarios: D, S0, C, CI and DP (discover and a Session at an issuer with a path). N and RL need `api`, so they're unsupported.

## Results

12 October 2026, local lane, `--image-tag evr`, the egress probe got nowhere (`ENETUNREACH`, `ENETUNREACH`, `EAI_AGAIN`), no flaky cell, no stale known failure:

| Company | D | S0 | C | CI | DP |
| --- | --- | --- | --- | --- | --- |
| pda-mock, datalayer-ts, datalayer-py, pi-poppy, poppyseed, adonis-agora, everruns | pass | pass | pass | pass | pda-mock: fail (S3); others don't offer it |
| pda-mock-strict | pass | fail (S2) | fail (S2) | fail (S2) | fail (S3) |
| poppy-demo (Northstar), ilmer | pass | fail (S2) | fail (S2) | fail (S2) | n/a |
| print-with-poppy | pass | unsupported (no conversations) | n/a | n/a | n/a |

- **S2 (spec, rule 3):** the Session assertion has no `typ` (`start_session` signs it with `typ: None`; the client assertion has `typ: JWT`) and everruns declares S2 `any`; pda-mock-strict, Northstar and Ilmer declare `jwt-60s` and answer `invalid_grant` at the first Session.
- **S3 (unattributed here; rule 2 blames the agent when pda runs DP too):** OAuth metadata is fetched only at `{issuer}/.well-known/oauth-authorization-server`, so with the `issuer_path` hook, where our mocks serve it only at RFC 8414's inserted location, discovery fails (`not_found`).

Both are in [`known-failures.json`](../../known-failures.json), linked at the pinned commit.

## Readings

`S1: token-endpoint` (both assertions), `S2: any` (the client assertion has `typ: JWT`; the Session assertion has no `typ`; both live 60 s), `S3: append` (`{issuer}/.well-known/oauth-authorization-server`), `S4: omit`, `S23: per-origin`.

## Patches and relaxations

1. `patches/0001-interop-allow-private-networks.patch` (interop-only, off by default): `EVERRUNS_INTEROP_ALLOW_PRIVATE_NETWORKS=1`, set by the image, lets RFC 1918 addresses through `is_blocked_ip`, the SSRF check after DNS pinning, because every `*.interop.test` name resolves to the proxy on a private Docker network. Loopback, link-local, metadata, CGNAT and documentation ranges stay blocked.
2. `patches/0002-expose-signing-key-to-adapter.patch` (visibility only): `domains::poppy_agent::signing_key` becomes `pub`, so `discover` can build the `PoppyAgent` that `worker_poppy_call` builds and call `PoppyAgent::discover`. The `poppy_discover` tool's answer leaves out the issuer. (At `b09c922` this patch also opened the protocol module, now public in `everruns-capabilities`, and a second patch renumbered three migrations that shared version 218, since fixed upstream.)
3. In-memory mode; the deployment's public base URL comes from INTEROP_ORIGIN (`configure_public_base_url`).
4. The front pins `Host` and `X-Forwarded-Proto` to INTEROP_ORIGIN.

TLS: no change. everruns' reqwest 0.13 (`rustls`) client trusts the system store, and `SSL_CERT_FILE` points it at `/interop/ca.pem`.

## Known issues the grid doesn't reach

- A DPoP nonce retry reuses the Session assertion (signed once, before the retry loop in `start_session`, `crates/capabilities/src/capabilities/poppy_client/protocol.rs` lines 416 to 424 at the pin), so a Company that requires nonces and refuses a reused `jti` refuses the retry (Guides, Retries). Scenario N would show it, but needs `api`, and everruns' Sessions exist only for conversations.
