# M×N interoperability testing for Poppy

How to test every Personal Agent implementation of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) against every Company implementation, using pirate testing. This is the design and its rationale; [interop-spec.md](interop-spec.md) is the contract an implementation meets to join, and [`interop/`](../interop/README.md) is the harness. The implementations are listed in the [README](../README.md#other-implementations); the spec issues the grid exercises are in [spec-issues.md](spec-issues.md), and what it found in each project is in [poppy-issues.md](poppy-issues.md). A summary of the last full grid, a snapshot, is in [interop-results/](interop-results/README.md). How these ideas evolved is in [conformance-testing-history.md](conformance-testing-history.md), and the next step, deliberately misbehaving peers, in [adversarial-interop.md](adversarial-interop.md).

## What's built

- **The runner** ([`interop/runner/`](../interop/runner)): a Node CLI, `npm run interop`. It builds each implementation's image, makes a CA and certificate per run with `openssl`, starts a Docker network with the recording proxy and every implementation, and runs each scenario × agent × Company cell, resetting both adapters first. It writes `results.json`, a HAR file per cell and an `index.html` grid to `interop/results/<run>/`.
- **The recording proxy** ([`interop/proxy/`](../interop/proxy)): terminates TLS for every `*.interop.test` name, forwards to each container on port 8080, and records each exchange in full.
- **Scenarios as data** ([`interop/scenarios/`](../interop/scenarios)): D, S0, N, SD, SV, SVN, SM, SMC, SX, SXV, C, CI, CS, CA, SO, SE, R, AO, AM, AS, O, OX, RL and DP. Scopes come from each Company's fixture, so a Company with only custom scopes can take part.
- **The checker** ([`checks.ts`](../interop/runner/checks.ts), [`documents.ts`](../interop/runner/documents.ts), [`readings.ts`](../interop/runner/readings.ts)): pure functions over the recording, named with the mock Company's violation ids where one fits, plus `src/validator` over every discovery document and client metadata served.
- **Attribution** ([`attribution.ts`](../interop/runner/attribution.ts)) by the four rules, and known failures ([`known-failures.json`](../interop/known-failures.json)).
- **Our two adapters:** [`dpa-agent`](../interop/impls/dpa-agent) runs `src/poppy` in Node, with Node's SQLite behind the Durable Object SQL API it uses, and no model; [`dpa-mock`](../interop/impls/dpa-mock) runs the mock Company behind the hooks API and reports its violations. It is registered twice: `dpa-mock`, the reference Company, is lenient where the draft is silent (assertion `typ`, `kid` and lifetime, reading S2), and `dpa-mock-strict` keeps the strict checks, so a failure caused only by an open question is blamed on the spec, not hidden behind it. Node was chosen over `wrangler dev` because Node trusts the run's CA through `NODE_EXTRA_CA_CERTS`, starts in a second, and needs no `workerd` networking in a container; the mock and the client are plain TypeScript over `fetch`, so the bundle is our shipped code.
- **Datalayer's vectors** ([`interop/vectors/datalayer/`](../interop/vectors/datalayer)): a runner for Datalayer's 124 language-neutral conformance cases against `src/poppy` and `src/validator`. We also exported our validator fixtures and the mock's tamper rows as vectors in Datalayer's schema; they were removed because nothing consumed them, and the shared vectors repository they were meant to seed was never made.
- **Adapters for seven other projects:** Datalayer (TypeScript and Python, both sides), pi-poppy (both), poppy-demo (both), poppyseed (Company), adonis-agora (both), Ilmer (Company), and everruns (both; compiles, not yet built into images). Each fetches upstream at a pinned commit; every change an implementation needed to act as a peer is an interop-only setting or a patch, listed in its manifest's `relaxations`.
- **Known failures** take `*` for any agent, Company or scenario, so one root cause is one entry.
- **CI** runs our agent against both mocks on pushes to `main` and on pull requests that touch the client, the validator, the mock or the harness, and keeps the results as an artifact (`.github/workflows/interop.yml`).

Other implementations' adapters go in `interop/impls/<name>-agent` and `interop/impls/<name>-company`, registered in [`interop/registry.json`](../interop/registry.json).

## Pirate testing

[Pirate testing](https://blog.oshineye.com/2010/02/pirate-testing.html) (Ade Oshineye, 2010) writes functional tests once, as language-neutral data, and has each implementation of a spec run them through a thin harness of its own. The name comes from Sam Ruby's [unbundling of the Pirate compiler's tests](https://www.intertwingly.net/blog/2004/10/08/Unbundling-Pirate-Tests) into one data file per test.

- **What it gives:** new implementations start with the accumulated cases; the lessons of every implementation live in one machine-readable place; arguments about compliance get settled by a test case.
- **What it costs:** it tests functional behaviour, not everything; suites grow slow; failure messages tend to be generic; a change to the shared data can break several implementations at once.

Pirate testing is 1 suite × N implementations: it tests conformance, not pairs. M×N interop needs two more things, both borrowed from established interop runners: a pairing harness, and a way to tell which side failed.

Datalayer already applies it to Poppy: 124 shared JSON cases in `protocol/fixtures/conformance/` (`id`, `kind`, `role`, `requirements`, `check`, `input`, `expect`) and one scenario run across its four Python and TypeScript pairings.

## What we borrow from

| Project | What we take |
| --- | --- |
| [QUIC Interop Runner](https://interop.seemann.io) | The M×N grid. Each implementation is a container registered by pull request. Test cases are short names, and an implementation exits with a fixed code when it doesn't support one, so new cases break nobody. A middlebox records traffic. Blame is read from the grid: a red column is a server, a red row is a client. |
| [MCP conformance](https://github.com/modelcontextprotocol/conformance) | The runner plays the other side: a scenario server to test a client, a client to test a server. It records traffic and writes named checks. It's the closest domain: agent protocols with OAuth. |
| OpenID Foundation conformance suite | Test plans with variants, results of FAILURE, WARNING or REVIEW, and scripted browser steps for consent pages. |
| [Matrix Complement](https://github.com/matrix-org/complement) | A black-box container contract: fixed ports, a private CA, health checks, and per-implementation skips for unsupported features. |
| BoringSSL BoGo | A small shim per implementation that the runner drives. |
| [Web Platform Tests](https://wpt.fyi) | A results dashboard, plus a file of known failures per implementation that links each one to an issue. |

## Design

```
            ┌──────── poppy-interop runner (Node CLI / GitHub Action) ────────┐
            │ registry.json: implementation → image or URL, pinned commit     │
            │ scenarios/*.json: pirate data   readings: S1–S23 profiles       │
            └─────┬──────────────────────────────────────────┬───────────────┘
     control API  │                                          │  hooks API
                  ▼                                          ▼
            ┌──────────┐        ┌──────────────────┐   ┌───────────┐
            │ Client   │ HTTPS  │ Recording proxy  │   │ Company   │
            │ adapter  │───────▶│ private CA,      │──▶│ + hooks   │
            │ (shim)   │◀───────│ *.interop.test,  │◀──│           │
            └──────────┘        │ one HAR per cell │   └───────────┘
                                └────────┬─────────┘
                                         ▼
               passive checks: src/validator + the mock Company's checks
               as pure functions + Company-response checks
                                         ▼
               results.json → matrix page (click a cell: steps, HAR, violations)
```

- **Packaging.** Each implementation is a container. A Workers implementation is a `wrangler dev` process.
  - Each serves `GET /manifest`: name, commit, role, the scenarios it supports, and its readings of the open spec questions. An unsupported step answers 501, the equivalent of QUIC's "unsupported" exit code.
- **Clients** expose a control API: `POST /step {op, company, params}`, plus `GET /log` for the requests they made.
  - The `op`s are `discover`, `session`, `signin`, `send`, `read`, `sse`, `api`, `mcp`, `web_join`, `approve_op` and `signout`.
  - The API is authenticated with a per-run secret.
  - Ours drives `src/poppy` directly, not the model, so results never depend on an LLM.
- **Companies** expose poppyseed's existing hooks protocol (`GET /hooks`, `POST /{hook}`). The hooks are site sign-in, last one-time code, end Session, staff join, staff reply, performed and settle. Each Company also describes its own data: scopes, an OpenAPI operation, an MCP tool, mediated credentials.
- **Network.** Every host is `*.interop.test`, served by a recording reverse proxy whose CA every container trusts. Our client already takes an injectable `Fetcher`. Other implementations need an interop-only setting that allows these names; pi-poppy also needs a loopback `client_id`.
- **Human steps.** A Company hook where one exists; otherwise a Playwright script per Company that matches the consent URL, fills it in and approves. Approvals on the agent side go through the adapter's `approve_op`, which uses the same path as the page under a test identity, never an auth bypass.
- **Checks on the recording.**
  - Our mock Company's 142 named checks (`test/mock-company/violations.ts`) refactored into pure functions over a recorded exchange. Most need only the trace: JWT `typ`, `kid` and lifetime, `jti` reuse, DPoP `htu` and `ath`, tokens in URLs, one key per access token.
  - Discovery documents go through `src/validator/`.
  - New checks on Company responses: `WWW-Authenticate` on 401, `Retry-After` on 429, error codes, cursor and SSE shapes.
- **Attribution,** in order:
  1. a violation on one side;
  2. the grid pattern, against reference cells: our strict mock under its six profiles as reference columns, and the one-sided testers (poppyseed's check command, Datalayer's `pap company verify`, our validator) as reference rows;
  3. a disagreement on an open spec question, which is the spec's fault;
  4. otherwise unattributed, with known failures linked to issues.

  Many readings show up in the traffic: the assertion's `aud` (S1), its `typ` and lifetime (S2), which metadata URL was fetched (S3), `scope` on a signed-out Session (S4), nonce reuse across origins (S23). The results page shows each implementation's readings.
- **Cadence.** Nightly, on demand, and on any pull request to the registry. Commits and the spec revision are pinned and bumped deliberately.

## Scenarios

| Area | Scenarios |
| --- | --- |
| Discovery and identity | `D` discovery (RFC 8414 location, validator verdict); `DP` discovery and a Session at an issuer with a path (S3); `CM` the Company fetches our `client_id` and keys |
| Sessions | `S0` signed-out Session; `N` DPoP nonce, retried with a fresh proof |
| Sign-in | `SD` Direct (PKCE, `iss`); `SV` Device (polling, `slow_down`); `SM` Mediated (and a wrong password); `SX` denied |
| Lifecycle | `R` renew and rotate; `SE` Session ended by the Company, then recovery; `SO` sign out and revoke |
| Conversations | `C` send and read (cursor, `has_more`); `CI` retry with the same message id; `CS` SSE and resume; `CA` `sign_in_required` mid-conversation; `H` handoff; `DC` Direct Conversation |
| APIs | `AO` OpenAPI call; `AM` MCP call; `AS` `insufficient_scope` |
| Browser | `W` browser Session join |
| Operations | `O` propose, approve, confirm; `O2` confirm twice, performed once; `OX` decline |
| Limits | `RL` 429 with `Retry-After` |

Hardening (SSRF, duplicate JSON members, redirects on `client_id`) stays in one-sided tests (the validator's fixtures and the mock's tamper rows), not pairs.

## Plan

Status on 11 October 2026: steps 1 to 4 are done except the shared vectors repository (never made; our exported vectors were removed because nothing consumed them), the Playwright consent scripts, nightly CI for the full grid, and scenarios H, DC, W, O2 and CM. Datalayer's 124 cases run against our code: 24 pass, 2 fail on readings the draft leaves open, and 98 don't apply.


1. **Pirate vectors, no network.**
   - Export our validator fixtures and the mock's tamper rows as language-neutral JSON. (Done, then removed: nothing consumed them.)
   - Run Datalayer's 124 cases against `src/poppy` and `src/validator`.
   - Propose a shared `poppy-test-vectors` repository using Datalayer's schema, and merge in poppyseed's 124 mutants.
2. **3×3.**
   - Clients: ours, Datalayer TypeScript, poppy-demo's caller.
   - Companies: our strict mock, Datalayer's Manzanita, poppy-demo's receiver.
   - Scenarios D, S0, N, SD, C, CI, SO and O: 72 cells, with docker-compose and `wrangler dev` behind the proxy.
   - poppy-demo needs a small upstream patch to take its peer from the environment, because its Company accepts only its own agent. If that stalls, substitute pi-poppy's Company or poppyseed's reference app.
3. **The passive checker, attribution and a published grid**, with Company hooks or Playwright scripts, nightly in CI.
4. **Widen.**
   - Clients: pi-poppy, Datalayer Python.
   - Companies: pi-poppy's mock, poppyseed's app, Datalayer's Python Company.
   - Scenarios: SV, SM, R, SE, CS, H, DC, AO, AM, RL.
   - Invite implementers by registry pull request.
5. **Live lane.** Public deployments (poppy.ilmer.org, withpoppyseed.dev), signed-out only and gently rate-limited. AdonisJS authkit and everruns come later; W needs real browsers.

## Risks

The ones that happened: every project except ours and Ilmer needed a relaxation to accept test host names, and two of those relaxations are broader than needed ([N42](spec-issues.md#n42)); a strict reference Company hid everything else about two agents until we split it in two; harness bugs (a TLS wildcard that matched nothing, compressed bodies recorded undecoded, scenarios that treated `wait` as a promise) were as common as implementation bugs at first; and the shared Docker disk filled, which kept everruns out.


- **Churn.** Everything is days old, and Draft 0.1 can break compatibility. Pin commits and the spec revision.
- **Few runnable servers.** Several implementations need patches to act as interop peers (allowlists, hard-wired peers, SSRF or loopback relaxations). Every relaxation must be an interop-only setting.
- **Workers under `wrangler dev`.** Trusting a private CA for outbound requests is unverified. Our adapters avoid it by running our code in Node; another Workers implementation would need the same, or a `Fetcher`-like seam.
- **Non-determinism.** LLM-backed Companies, timing, staff queues. Use stand-in runners and hooks rather than real time.
- **Wrong blame.** Our mock's readings could pass for the spec's. Keep its six profiles, and label every attribution with the rule that made it.
- **Licences and goodwill.** Check licences before vendoring. Present the grid as being about the spec, not about anyone's project.
