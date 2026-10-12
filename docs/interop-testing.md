# M×N interoperability testing for Poppy

How to test every Personal Agent implementation of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) against every Company implementation, using pirate testing. This is the design and its rationale; [interop-spec.md](interop-spec.md) is the contract an implementation meets to join, and [`interop/`](../interop/README.md) is the harness. The implementations are surveyed in [implementations.md](implementations.md) and mapped in [ecosystem.md](ecosystem.md); the newest ones that could join, and a cross-check of the validators, are [below](#candidates-from-the-12-october-survey), and the ones the harness runs are in [`interop/registry.json`](../interop/registry.json); the spec issues the grid exercises are in [spec-issues.md](spec-issues.md), and what it found in each project is in [poppy-issues.md](poppy-issues.md). A summary of the last full grid, a snapshot, is in [interop-results/](interop-results/README.md). How these ideas evolved is in [conformance-testing-history.md](conformance-testing-history.md), and the next step, deliberately misbehaving peers, in [adversarial-interop.md](adversarial-interop.md).

## What's built

- **The runner** ([`interop/runner/`](../interop/runner)): a Node CLI, `npm run interop`. It builds each implementation's image, makes a CA and certificate per run with `openssl`, starts a Docker network with the recording proxy and every implementation, and runs each scenario × agent × Company cell, resetting both adapters first. It writes `results.json`, a HAR file per cell and an `index.html` grid to `interop/results/<run>/`.
- **The recording proxy** ([`interop/proxy/`](../interop/proxy)): terminates TLS for every `*.interop.test` name, forwards to each container on port 8080, and records each exchange in full.
- **Scenarios as data** ([`interop/scenarios/`](../interop/scenarios)), one JSON file each: the honest scenarios below, plus the adversarial and network-fault ones of [adversarial-interop.md](adversarial-interop.md). Scopes come from each Company's fixture, so a Company with only custom scopes can take part.
- **The checker** ([`checks.ts`](../interop/runner/checks.ts), [`documents.ts`](../interop/runner/documents.ts), [`readings.ts`](../interop/runner/readings.ts)): pure functions over the recording, named with the mock Company's violation ids where one fits, plus `src/validator` over every discovery document and client metadata served.
- **Attribution** ([`attribution.ts`](../interop/runner/attribution.ts)) by the four rules, and known failures ([`known-failures.json`](../interop/known-failures.json)).
- **Our two adapters:** [`dpa-agent`](../interop/impls/dpa-agent) runs `src/poppy` in Node, with Node's SQLite behind the Durable Object SQL API it uses, and no model; [`dpa-mock`](../interop/impls/dpa-mock) runs the mock Company behind the hooks API and reports its violations. It is registered twice: `dpa-mock`, the reference Company, is lenient where the draft is silent (assertion `typ`, `kid` and lifetime, reading S2), and `dpa-mock-strict` keeps the strict checks, so a failure caused only by an open question is blamed on the spec, not hidden behind it. Node was chosen over `wrangler dev` because Node trusts the run's CA through `NODE_EXTRA_CA_CERTS`, starts in a second, and needs no `workerd` networking in a container; the mock and the client are plain TypeScript over `fetch`, so the bundle is our shipped code.
- **Datalayer's vectors** ([`interop/vectors/datalayer/`](../interop/vectors/datalayer)): a runner for Datalayer's 124 language-neutral conformance cases against `src/poppy` and `src/validator`. We also exported our validator fixtures and the mock's tamper rows as vectors in Datalayer's schema; they were removed because nothing consumed them, and the shared vectors repository they were meant to seed was never made.
- **Adapters for other projects**, each registered in [`interop/registry.json`](../interop/registry.json), which is the list. Each fetches upstream at a pinned commit; every change an implementation needed to act as a peer is an interop-only setting or a patch, listed in its manifest's `relaxations`. Two more aren't registered: `everruns-agent` and `everruns-company` (written; the library compiled, but the images weren't built end to end for lack of Docker disk, and they stay unrun, by the owner's choice, until our own agent is verified against a real Company) and `typo3-dirnbauer-company` (a README only: the extension it would run is private).
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
  - Our mock Company's named checks (`test/mock-company/violations.ts`) refactored into pure functions over a recorded exchange. Most need only the trace: JWT `typ`, `kid` and lifetime, `jti` reuse, DPoP `htu` and `ath`, tokens in URLs, one key per access token.
  - Discovery documents go through `src/validator/`.
  - New checks on Company responses: `WWW-Authenticate` on 401, `Retry-After` on 429, error codes, cursor and SSE shapes.
- **Attribution,** in order:
  1. a violation on one side;
  2. the grid pattern, against reference cells: our lenient mock, `dpa-mock`, as the reference column (`dpa-mock-strict` is an ordinary column), and the one-sided testers (poppyseed's check command, Datalayer's `pap company verify`, our validator) as reference rows;
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

## Candidates from the 12 October survey

The re-survey ([implementations.md](implementations.md), [ecosystem.md](ecosystem.md)) found these. At first none was added: the runner refuses to start with less than 2 GB free on Docker's disk, and there was about 2.4 GB. Once there was room, print-with-poppy joined the registry on 12 October; the others are still as below.

| Project | Side it could join | What an adapter would need | Decision |
| --- | --- | --- | --- |
| [print-with-poppy](https://github.com/spenciefy/print-with-poppy) at `7ef69be` | Company | A Node 22 image (its `engines`) with its native dependencies (`better-sqlite3`, `sharp`), run with `APP_MODE=demo` (payments, prints and email are simulated), `PUBLIC_URL` on `*.interop.test`, and the grid's agents' `client_id`s in `AGENT_CLIENT_IDS`: an ordinary setting, not a relaxation; Node trusts the run's CA through `NODE_EXTRA_CA_CERTS`, as for our own adapters. Its non-Poppy Bearer "compatibility" path is forced on in demo mode, so a one-line patch lets `ALLOW_COMPAT_AGENT_SESSIONS=false` turn it off. Hooks: `reset` (a fresh `DATA_DIR` and process), `fixture` (no accounts or scopes; `getCatalog` as `openapi_public`). It takes D and S0. AO, O and OX as written start with Direct Sign-In (O and OX with a conversation), which it doesn't have; its Operations (an order proposed by the agent's own API call, after a multipart photo upload, in a signed-out Session) need a scenario the harness doesn't have yet. No licence is declared, so the adapter fetches upstream at build and keeps nothing. | In the grid as `print-with-poppy` ([`interop/impls/print-with-poppy-company`](../interop/impls/print-with-poppy-company)); first run 12 October, D and S0: dpa, datalayer-ts, datalayer-py, pi-poppy and adonis-agora pass both; poppy-demo fails both at discovery, a known failure (its caller needs an `authorization_endpoint` and an `agent` member, as at Ilmer). Its S2 reading, any `typ` and at most 120 s, is the runner's `lenient-120s`. Image about 625 MB on disk. |
| [nestjs-agent](https://github.com/DavideCarvalho/nestjs-agent) `packages/poppy` at `548576a` | Company (the agent side is a copy of adonis-agora's client, already in the grid) | The conversation endpoint with its in-memory stores and fake model, behind adonis-agora AuthKit for discovery, tokens and the token resolver, as our `adonis-agora-company` image already runs. Built from the workspace, since the package isn't on npm. | Not built: it would add only a second conversation endpoint behind the same AuthKit. |
| [tusharck/poppy-validator](https://github.com/tusharck/poppy-validator) at `d2220bf`, [habib-analyst/poppy-sidecar](https://github.com/habib-analyst/poppy-sidecar) at `858db66` | Neither: they check documents | A validator is a reference row for attribution rule 2 at most. What they can do now is check the same documents as ours: the [cross-check](#validator-cross-check) below. | Run once, by hand. |
| [tiny-poppy-gate](https://github.com/bobbyhalljr/tiny-poppy-gate) at `a7d084d` | Neither | Nothing to adapt: an in-memory toy with its own document shape, no HTTP and no OAuth. | n/a |
| Fillthemat ([draft PR #200](https://github.com/fillthemat/fillthemat/pull/200)) | Company, later | Its discovery document so far has no `agent`, `apis` or `web`. Its issuers have a path on a shared host (`https://auth.fillthemat.com/schools/<id>`), the deployment our `DP` scenario was written for. | Watch; an adapter once sign-in or a Company Agent is merged. |

Datalayer's 0.10.0 (`0c048aa`, 34 commits past our pin) changes cells: its Companies now accept a client assertion `aud` of the issuer, the token endpoint or the endpoint called, so adonis-agora's S1 known failures at both Datalayer Companies should pass, and assertions over 120 s are refused. Device Sign-In still doesn't retry `use_dpop_nonce`, the TypeScript SSE client still gives up after five quick reconnects, some optional Operation members are still `null`, and renewal still needs `session_id`. Moving the pin means rebuilding two images and re-running their rows and columns.

## Validator cross-check

A validator is neither a Personal Agent nor a Company, so it has no row or column in the grid. Instead, on 12 October we ran ours and the two open third-party validators over the same `poppy.json` documents, in file mode with the requested domain given and no network.

- **Documents (107):** the 26 `poppy.json` fixtures of `test/validator.test.ts` (the spec's example, poppy-demo's live document as served on 11 October, and each mutation); 27 probes, one per rule we expected the validators to read differently; poppy-validator's own 51 fixtures; and poppy-sidecar's 3 generated examples. The grid's Companies serve their documents only at run time, and their HAR files aren't kept, so only poppy-demo's is in the set.
- **How:** `node interop/vectors/validators/run.mjs` ([its README](../interop/vectors/validators/README.md)). Ours runs through `validateText` in Node. Theirs are fetched at pinned commits (poppy-validator `d2220bf`, poppy-sidecar `858db66`) and run in a container with `--network none`, their source mounted read-only, on a digest-pinned Python image with poppy-validator's locked `jsonschema`.
- **Same verdict (valid or not), first run (12 October, before [decision 24](decisions.md#24-conformance-levels-from-each-requirements-basis)):** ours and poppy-validator on 75 of 107; ours and poppy-sidecar on 84; all three on 65. poppy-sidecar is the loosest: it accepts malformed versions, unparseable issuers and extension names without a domain, and checks HTTPS only as a prefix.
- **Same verdict under the conformance levels** (the script, at `cb39236`): ours and poppy-validator on 92; ours and poppy-sidecar on 77; all three on 70. Grading each message by its basis moved ours to theirs on 17 documents: our hardening (HTTPS everywhere, duplicate members, an integer extension `version`, empty mediated fields) became warnings our client still refuses, and four field-table and RFC rules became errors. The last column says where each row stands now.

The 32 documents where ours and poppy-validator differed on the first run, by cause, each checked against [the stored draft](../spec/draft-0.1-2026-10-09/pages/spec.md):

| Rule | Docs | Ours | poppy-validator | The draft | Who's right | Since decision 24 |
| --- | --- | --- | --- | --- | --- | --- |
| HTTPS for `apis[].url`, `auth.mediated.endpoint`, `web.browser_session_endpoint` | 6 | error | info (advisory) | HTTPS is stated only for `issuer` and conversation endpoints (3.1) | Both say why. Ours is stricter on purpose ([N9](spec-issues.md#n9)), and its message says so. | Agree: ours is a warning (a reading, N9) that our client still refuses. |
| An issuer with a query or fragment, in a file | 3 | error | info; error only when it fetches the metadata | RFC 8414 §2 defines the issuer without either | The same rule; we apply it without the network. | Still differ. |
| `poppy:` scopes other than read and write | 2 | error | info | "Names starting with `poppy:` are reserved for this protocol" (4.4), with no keyword | A rule without a keyword: a judgement either way. | Still differ: a Rule, so an error. |
| Scope syntax (a space in a scope) | 2 | error | info | RFC 6749 §3.3's grammar | Ours: such a scope can't be requested at all. | Still differ: RFC, so an error. |
| Extension `version` as an integer | 2 | error | accepted | "Each entry has a `version`, the extension's major version" (3.3); no type stated ([N22](spec-issues.md#n22)); the examples are strings | Theirs: we're stricter than the text. A warning would do. | Agree: a warning (a reading). |
| Empty `auth.mediated.fields`; a field name listed twice | 2 | error | nothing; info | Silent | Ours, but it rests on no text. | Empty fields agree (a warning); the duplicate name still differs. |
| `operations` without its `endpoint` | 1 | error | not checked | "lists the extension … with the URL of its operations endpoint" (Ops 2) | Ours; they don't check extensions' members. | Still differ. |
| A duplicate JSON member | 1 | error | accepted (Python keeps the last) | RFC 8259 §4: names SHOULD be unique | Ours: two parsers can see two different documents. | Agree: a warning our client still refuses. |
| An unparseable `resource` | 1 | error | info (it's a MAY member) | RFC 8707 asks for an absolute URI | Ours. | Still differ. |
| A trailing dot on `organization.domain` | 1 | error | info | Silent | Cosmetic; either. | Still differ. |
| An API type other than `openapi` or `mcp` in a 0.1 document | 2 | info | error | "Each API's `type` MUST be one of these" (6); agents SHOULD skip unknown ones | **Theirs**, for a document that says 0.1; they make it info for a newer minor, as we do for every document. | Agree: an error at a minor version we know. |
| A plain extension name the draft doesn't define | 2 | warning | error | "Anyone else MUST start an extension's name with a domain they control" (3.3) | **Theirs** by the letter; a later minor version may define the name, which is why we warn. | Still differ: kept a reading. |
| `apis[]` entry with no `description` | 2 | warning | error | "Each has a `type` …, a `url`, and a short `description`" (3.1) | Theirs by the field table; harmless to agents either way. | Agree: an error (a Rule). |
| `agent.protocols: []` | 2 | warning | error | "`protocols` lists its supported conversation protocols" (3.1) | Theirs: an empty list offers nothing. | Still differ: the field table has no "Yes" for it. |
| No `organization.name` | 1 | warning | error (sidecar too) | `organization`: "Display name and domain", required (3.1) | Open: [S18](spec-issues.md#s18). | Agree: an error (a Rule). |
| A byte order mark | 1 | warning | error (neither Python parser reads it) | RFC 8259 §8.1: senders MUST NOT add one; parsers MAY ignore it | The Company breaks a MUST NOT; an error is defensible. | Agree: an error (RFC). |
| `auth.issuer` of `https://.` | 1 | accepted | error | An HTTPS URL that names a host | **Theirs: a gap in ours.** `httpsUrl` in `src/validator/primitives.ts` checks the scheme, not the host. | Agree: fixed, an error. |

The changes this suggests to our validator are in [implementations.md](implementations.md#what-we-can-learn-from-the-12-october-participants). Things only ours checks: the issuer's metadata beyond endpoints (auth methods, algorithms, PKCE, the `iss` parameter), client metadata and JWKS, size, content type, UTF-8, non-public hosts, and a secret-looking mediated field marked `secret: false`. Things only poppy-validator reports: an issuer's metadata found only at the appended location (`OA09`, a diagnostic for S3), an empty `apis` list, an uppercase domain, and `web` without a browser session endpoint.

## Risks

The ones that happened: every project except ours and Ilmer needed a relaxation to accept test host names, and two of those relaxations are broader than needed ([N42](spec-issues.md#n42)); a strict reference Company hid everything else about two agents until we split it in two; harness bugs (a TLS wildcard that matched nothing, compressed bodies recorded undecoded, scenarios that treated `wait` as a promise) were as common as implementation bugs at first; and the shared Docker disk filled, which kept everruns out.


- **Churn.** Everything is days old, and Draft 0.1 can break compatibility. Pin commits and the spec revision.
- **Few runnable servers.** Several implementations need patches to act as interop peers (allowlists, hard-wired peers, SSRF or loopback relaxations). Every relaxation must be an interop-only setting.
- **Workers under `wrangler dev`.** Trusting a private CA for outbound requests is unverified. Our adapters avoid it by running our code in Node; another Workers implementation would need the same, or a `Fetcher`-like seam.
- **Non-determinism.** LLM-backed Companies, timing, staff queues. Use stand-in runners and hooks rather than real time.
- **Wrong blame.** Our mock's readings could pass for the spec's. Keep its six profiles, and label every attribution with the rule that made it.
- **Licences and goodwill.** Check licences before vendoring. Present the grid as being about the spec, not about anyone's project.
