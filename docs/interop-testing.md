# M×N interoperability testing for Poppy

How to test every Personal Agent implementation of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) against every Company implementation, using pirate testing. This document is the design and its rationale; [interop-spec.md](interop-spec.md) is the contract an implementation meets to join, and [`interop/`](../interop/README.md) is the harness.

The implementations are surveyed in [implementations.md](implementations.md) and mapped in [ecosystem.md](ecosystem.md). The ones the harness runs are in [`interop/registry.json`](../interop/registry.json), and the newest ones that could join are [below](#candidates-from-the-12-october-survey), with a cross-check of the validators. The spec issues the grid exercises are in [spec-issues.md](spec-issues.md), what it found in each project is in [poppy-issues.md](poppy-issues.md), and a snapshot of the last full grid is in [interop-results/](interop-results/README.md). How these ideas evolved is in [conformance-testing-history.md](conformance-testing-history.md); the step after this one, peers that misbehave on purpose, is [adversarial-interop.md](adversarial-interop.md).

**At 0.3, since 28 October.** The harness speaks the pinned 28 October text alone. Earlier adapters, vectors and cross-checks were retired with 0.1/0.2; [interop-spec §14](interop-spec.md#14-retired-with-01-and-02) retains their last pins. The adversarial agent and print-with-poppy have returned at 0.3, and the current website Company kit is pinned and run independently against our fixtures. The [current verification report](poppy-0.3-conformance.md#current-verification) owns status and evidence links. Sections below that name 0.1/0.2, Session Tokens or Account Tokens remain dated history.

## What's built

- **The runner** ([`interop/runner/`](../interop/runner)): a Node CLI, `npm run interop`. It builds each implementation's image, makes a CA and certificate per run with `openssl`, starts a Docker network with the recording proxy and every implementation, and runs each scenario × agent × Company cell, resetting both adapters first. It writes `results.json`, a HAR file per cell and an `index.html` grid to `interop/results/<run>/`.
- **The recording proxy** ([`interop/proxy/`](../interop/proxy)): terminates TLS for every `*.interop.test` name, forwards to each container on port 8080, and records each exchange in full, up to 2,000 a cell.
- **Scenarios as data** ([`interop/scenarios/`](../interop/scenarios)), one JSON file each: the honest scenarios below, plus the adversarial and network-fault ones of [adversarial-interop.md](adversarial-interop.md). Scopes come from each Company's fixture, so a Company with only custom scopes can take part.
- **The checker** ([`checks.ts`](../interop/runner/checks.ts), [`documents.ts`](../interop/runner/documents.ts), [`readings.ts`](../interop/runner/readings.ts)): pure functions over the recording, named with the mock Company's violation ids where one fits, plus `src/validator` over every discovery document and client metadata served.
- **Attribution** ([`attribution.ts`](../interop/runner/attribution.ts)) by the rules of [interop-spec.md section 9](interop-spec.md#9-results-and-attribution), and known failures ([`known-failures.json`](../interop/known-failures.json)).
- **Our two adapters:** [`pda-agent`](../interop/impls/pda-agent) runs `src/poppy` in Node, with Node's SQLite behind the Durable Object SQL API it uses, and no model; [`pda-mock`](../interop/impls/pda-mock) runs the mock Company behind the hooks API and reports its violations. It is registered twice: `lenient-company` (until 23 October `pda-mock`), the reference Company, is lenient where the draft is silent (assertion `typ`, `kid` and lifetime, reading S2), and `strict-company` (`pda-mock-strict`) keeps the strict checks, so a failure caused only by an open question is blamed on the spec, not hidden behind it. The agent adapter is registered as fakes too: `lenient-personal-agent`, the reference agent, `strict-personal-agent` and `sloppy-personal-agent` ([interop-spec §2.1](interop-spec.md#21-the-fake-implementations)). Node was chosen over `wrangler dev` because Node trusts the run's CA through `NODE_EXTRA_CA_CERTS`, starts in a second, and needs no `workerd` networking in a container; the mock and the client are plain TypeScript over `fetch`, so the bundle is our shipped code.
- **Datalayer's vectors** ([`interop/vectors/datalayer/`](interop-spec.md#14-retired-with-01-and-02)): a runner for Datalayer's 124 language-neutral conformance cases against `src/poppy` and `src/validator`. We also exported our validator fixtures and the mock's tamper rows as vectors in Datalayer's schema; they were removed because nothing consumed them, and the shared vectors repository they were meant to seed was never made.
- **Adapters for other projects**, each registered in [`interop/registry.json`](../interop/registry.json), which is the list. Each fetches upstream at a pinned commit; every change an implementation needed to act as a peer is an interop-only setting or a patch, listed in its manifest's `relaxations`. everruns joined on 12 October, both sides ([below](#everruns-joins-the-grid)), and Tipping Co (timothyohare) on 13 October, both sides ([below](#tipping-co-joins-the-grid)). Every pin was moved to its upstream's head on 13 October ([below](#pins-moved-on-13-october)). One more project has an adapter that isn't registered: `typo3-dirnbauer-company` (a README only: the extension it would run is private).
- **Known failures** take `*` for any agent, Company or scenario, so one root cause is one entry. Each also records what the failure looks like (its blame, error checks and failed step's code), so a different failure in a covered cell is unexpected.
- **CI** runs our agent against both mocks on pushes to `main` and on pull requests that touch the client, the validator, the mock or the harness, and keeps the results as an artifact (`.github/workflows/interop.yml`).

Other implementations' adapters go in `interop/impls/<name>-agent` and `interop/impls/<name>-company`, registered in [`interop/registry.json`](../interop/registry.json).

## Pirate testing

[Pirate testing](https://blog.oshineye.com/2010/02/pirate-testing.html) (Ade Oshineye, 2010) writes functional tests once, as language-neutral data, and has each implementation of a spec run them through a thin harness of its own. The name comes from Sam Ruby's [unbundling of the Pirate compiler's tests](https://www.intertwingly.net/blog/2004/10/08/Unbundling-Pirate-Tests) into one data file per test.

A new implementation starts with the accumulated cases, the lessons of every implementation live in one machine-readable place, and an argument about compliance is settled by a test case. The costs: it tests functional behaviour only, suites grow slow, failure messages tend to be generic, and a change to the shared data can break several implementations at once.

Pirate testing is 1 suite × N implementations, so it tests conformance rather than pairs. M×N interop needs two more things, both borrowed from existing interop runners: a pairing harness, and a way to tell which side failed.

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
- **Clients** expose a control API: `POST /step {op, company, params}`, plus `GET /log` for the requests they made, a debugging aid that only our `pda-agent` adapter serves; the interop spec doesn't define it, and the runner reads the recording proxy instead.
  - The `op`s ([interop-spec.md section 5.2](interop-spec.md#52-agent)) include `discover`, `session`, `signin`, `send`, `read`, `sse`, `api` (OpenAPI or MCP), `web_join`, `approve_op` and `signout`.
  - The API is authenticated with a per-run secret.
  - Ours drives `src/poppy` directly, not the model, so results never depend on an LLM.
- **Companies** expose a hooks protocol modelled on poppyseed's (`GET /hooks`, `POST /hooks/<name>`; [section 5.3](interop-spec.md#53-company)). The hooks approve or deny a sign-in, give the last one-time code, end Sessions, have staff join or reply, and propose or settle an operation. Each Company also describes its own data: scopes, an OpenAPI operation, an MCP tool, mediated credentials.
- **Network.** Every host is `*.interop.test`, served by a recording reverse proxy whose CA every container trusts. Our client already takes an injectable `Fetcher`. Other implementations need an interop-only setting that allows these names; pi-poppy also needs a loopback `client_id`.
- **Human steps.** A Company hook where one exists; otherwise a Playwright script per Company that matches the consent URL, fills it in and approves. Approvals on the agent side go through the adapter's `approve_op`, which uses the same path as the page under a test identity, never an auth bypass.
- **Checks on the recording.**
  - Our mock Company's named checks (`test/mock-company/violations.ts`) refactored into pure functions over a recorded exchange. Most need only the trace: JWT `typ`, `kid` and lifetime, `jti` reuse, DPoP `htu` and `ath`, tokens in URLs, one key per access token.
  - Discovery documents go through `src/validator/`.
  - New checks on Company responses: `WWW-Authenticate` on 401, `Retry-After` on 429, error codes, cursor and SSE shapes.
- **Attribution,** in order:
  1. a violation on one side;
  2. the grid pattern, against reference cells: our lenient mock, `lenient-company`, as the reference column (`strict-company` is an ordinary column), and our lenient fake agent, `lenient-personal-agent`, as the reference row, and the one-sided testers (poppyseed's check command, Datalayer's `pap company verify`, our validator) as reference rows;
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
| Conversations | `C` send and read (cursor, `has_more`), left open; `CL` the same with a labelled message, then a close (the live lane's); `CC` a conversation left open, closed by the Company, then `conversation_closed` and a new one; `CI` retry with the same message id; `CS` SSE and resume; `CA` `sign_in_required` mid-conversation; `H` handoff; `DC` Direct Conversation |
| APIs | `AO` OpenAPI call; `AM` MCP call; `AS` `insufficient_scope` |
| Browser | `W` browser Session join |
| Operations | `O` propose, approve, confirm; `O2` confirm twice, performed once; `OX` decline; `OU` a photo uploaded as `multipart/form-data`, then a write that proposes an operation in a signed-out Session, approved and confirmed (print-with-poppy's order; N19) |
| Limits | `RL` 429 with `Retry-After` |

Hardening (SSRF, duplicate JSON members, redirects on `client_id`) stays in one-sided tests (the validator's fixtures and the mock's tamper rows), not pairs.

### H, DC, W, O2 and CM (12 October)

This table named these five before they were written, with a few words each, so each was derived from the draft section it targets ([interop-spec.md section 6](interop-spec.md#6-scenarios) has the steps):

- **`H`** (7.7 to 7.9): a conversation, a handoff, the Company's `staff_join`, and a read showing a Company message with `sender: "human"`. A Company needs a way for a person to join; one whose handoff only says no one is available (poppy-demo, Ilmer) or that has no staff (Datalayer's Manzanita) doesn't claim it.
- **`DC`** (7.3, 7.8, 7.10, 7.12): a Direct Conversation under a signed-out conversation, the User's own words in it, the parent refusing a message with `direct_conversation_open`, `close`, and the parent taking messages again.
- **`W`** (5): a browser join for a signed-out Session, judged on the wire: `browser_joined` (a 303 with a cookie) and the browser checks of [section 8](interop-spec.md#8-checks).
- **`O2`** (Ops 5.2, 6): `O`, then the same confirm again (`confirm_again`). The Company must return the operation as it is, with the same `confirmation`.
- **`CM`** (4.1): a signed-out Session, then `client_fetched`: the Company fetched the agent's `client_id` and the key set holding the key that signed the assertion before granting the Session.

New: agent ops `handoff`, `close` and `confirm_again`, and `send`'s `sender` and `parent_conversation`; the fixture's `web_page` (the runner's default is the Company's home page); three `assert_trace` predicates; and six Company checks with their bases (`company.browser-session-response`, `company.browser-cookie`, `company.handoff-response`, `company.direct-parent-open`, `company.confirm-repeated`, and the Guides warning `company.metadata-fetch-credentials`), plus the browser assertion checks under the mock's ids.

Who claims them, from each project's code at its pinned commit:

| | H | DC | W | O2 | CM |
| --- | --- | --- | --- | --- | --- |
| Agents | pda, Datalayer TS and Python, pi-poppy, poppy-demo, adonis-agora | the same six | pda, Datalayer TS and Python, pi-poppy, adonis-agora | pda, Datalayer TS and Python, pi-poppy | all six |
| Companies | both mocks, pi-poppy, poppyseed, adonis-agora | both mocks, both Datalayer, pi-poppy, poppy-demo, poppyseed, adonis-agora | both mocks, both Datalayer, pi-poppy, poppyseed, adonis-agora | both mocks, both Datalayer, pi-poppy, poppyseed | all ten |

The run (`--image-tag tg1`, these five scenarios, the six agents above against the ten Companies, local lane): 163 pass, 34 fail, 103 unsupported, no errors, no flaky cell, every failure a known one, exit 0. By scenario: H 21 pass and 9 fail; DC 37 and 11; W 33 and 2; O2 23 and 1; CM 49 and 11. Every cell our agent ran passed (5 H, 8 DC, 7 W, 6 O2, 10 CM), and no new Company check failed anywhere: every Company that answered a handoff did so with 202, `status` and `responder`, every accepted join set a `Secure`, `HttpOnly` cookie that wasn't `SameSite=Strict`, every repeated confirm came back unchanged, and every Company fetched the agent's documents without credentials.

What failed:

- **Datalayer's clients and our mocks, H and DC (8 cells, new known failures).** Both SDKs refuse the answer to a handoff or a close unless it carries `conversation_id`; the draft has the Company return only `status` and `responder` (7.9, 7.12), which is what the mocks send ([poppy-issues.md](poppy-issues.md#datalayer-sdk-datalayerpersonal-agent-protocol)). Unattributed: they pass at every other Company, which adds `conversation_id`.
- **Earlier known failures** (26 cells): S2 readings (pi-poppy and adonis-agora at the strict mock, poppy-demo and Ilmer), and poppy-demo's caller refusing the discovery documents of the mocks, adonis-agora, Ilmer and print-with-poppy. Their entries already span every scenario.
- **Our browser, twice (fixed before the run above).** W found two bugs in `src/poppy/browser.ts`. It treated the whole origin of a Company's issuer as sign-in pages, so at a Company whose issuer is its website (Datalayer, pi-poppy, poppyseed, adonis-agora) it opened no page at all; now only the authorization, device and Mediated Sign-In endpoints are, and the issuer's host only when it isn't the website. And it called a join refused when the page it was redirected to answered 404 (Datalayer and pi-poppy have no home page); a join is refused only when the endpoint itself answers with an error.

Of the W joins that passed, only our agent's browser follows the 303 with the Company's cookie; the other agents' adapters post the assertion and stop, as a page that submits itself leaves the rest to the browser. `browser_joined` reports this as `followed` and doesn't require it.

## Plan

Status on 11 October 2026: steps 1 to 4 are done except the shared vectors repository (never made; our exported vectors were removed because nothing consumed them), the Playwright consent scripts, and nightly CI for the full grid. Scenarios H, DC, W, O2 and CM were written on 12 October ([above](#h-dc-w-o2-and-cm-12-october)). Datalayer's 124 cases run against our code: on 12 October, at `0c048aa`, with the discovery cases judged by whether our client refuses the document (not by the validator's severity), 24 pass, 2 fail on readings the draft leaves open, and 98 don't apply; on 13 October, at `00216eb` (0.17.0), the same.

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
5. **Live lane.** Public deployments (poppy.ilmer.org, withpoppyseed.dev), signed-out only and gently rate-limited. AdonisJS authkit and everruns come later. W needs no real browser: the join is a form POST, which our agent's fetch-based browser makes.

## Candidates from the 12 October survey

The re-survey ([implementations.md](implementations.md), [ecosystem.md](ecosystem.md)) found these. At first none was added: the runner refuses to start with less than 2 GB free on Docker's disk, and there was about 2.4 GB. Once there was room, print-with-poppy joined the registry on 12 October, and timothyohare's Tipping Co on 13 October; the others are still as below. The last four rows come from a second pass that evening, which also checked how far each pinned upstream had moved (the table after this one).

| Project | Side it could join | What an adapter would need | Decision |
| --- | --- | --- | --- |
| [print-with-poppy](https://github.com/spenciefy/print-with-poppy) at `7ef69be` (pin moved to `260dbb4` on 12 October; below the table) | Company | A Node 22 image (its `engines`) with its native dependencies (`better-sqlite3`, `sharp`), run with `APP_MODE=demo` (payments, prints and email are simulated), `PUBLIC_URL` on `*.interop.test`, and the grid's agents' `client_id`s in `AGENT_CLIENT_IDS`: an ordinary setting, not a relaxation; Node trusts the run's CA through `NODE_EXTRA_CA_CERTS`, as for our own adapters. Its non-Poppy Bearer "compatibility" path is forced on in demo mode, so a one-line patch lets `ALLOW_COMPAT_AGENT_SESSIONS=false` turn it off. Hooks: `reset` (a fresh `DATA_DIR` and process), `fixture` (no accounts or scopes; `getCatalog` as `openapi_public`). It takes D, S0 and OU. AO, O and OX as written start with Direct Sign-In (O and OX with a conversation), which it doesn't have; its Operations (an order proposed by the agent's own API call, after a multipart photo upload, in a signed-out Session) are scenario OU, added for it, with an `api` step that uploads a file from `interop/files/`. No licence is declared, so the adapter fetches upstream at build and keeps nothing. | In the grid as `print-with-poppy` ([`interop/impls/print-with-poppy-company`](../interop/impls/print-with-poppy-company)); first run 12 October, D and S0: pda, datalayer-ts, datalayer-py, pi-poppy and adonis-agora pass both; poppy-demo fails both at discovery, a known failure (its caller needs an `authorization_endpoint` and an `agent` member, as at Ilmer). Its S2 reading, any `typ` and at most 120 s, is the runner's `lenient-120s`. Image about 625 MB on disk. OU, 12 October: pda passes against it, and against both of our mocks. |
| [nestjs-agent](https://github.com/DavideCarvalho/nestjs-agent) `packages/poppy` at `548576a` | Company (the agent side is a copy of adonis-agora's client, already in the grid) | The conversation endpoint with its in-memory stores and fake model, behind adonis-agora AuthKit for discovery, tokens and the token resolver, as our `adonis-agora-company` image already runs. Built from the workspace, since the package isn't on npm. | Not built: it would add only a second conversation endpoint behind the same AuthKit. One docs commit since (`c0128df`, 13 October check). |
| [tusharck/poppy-validator](https://github.com/tusharck/poppy-validator) at `d2220bf`, [habib-analyst/poppy-sidecar](https://github.com/habib-analyst/poppy-sidecar) at `858db66` | Neither: they check documents | A validator is a reference row for attribution rule 2 at most. What they can do now is check the same documents as ours: the [cross-check](#validator-cross-check) below. | Run once, by hand. |
| [tiny-poppy-gate](https://github.com/bobbyhalljr/tiny-poppy-gate) at `a7d084d` | Neither | Nothing to adapt: an in-memory toy with its own document shape, no HTTP and no OAuth. | n/a |
| Fillthemat ([draft PR #200](https://github.com/fillthemat/fillthemat/pull/200)) | Company, later | Its discovery document so far has no `agent`, `apis` or `web`. Its issuers have a path on a shared host (`https://auth.fillthemat.com/schools/<id>`), the deployment our `DP` scenario was written for. | Watch; an adapter once sign-in or a Company Agent is merged. |
| [timothyohare/personal-agent-protocol](https://github.com/timothyohare/personal-agent-protocol) at `fb7b4e6` (new, evening of 12 Oct) | Both | A Node 24 image of its npm workspace (Hono, `jose`, in-memory stores), with no licence declared, so fetched at build and kept nowhere, as for print-with-poppy. The Company needs `PUBLIC_URL`-style config for its issuer and endpoints on `*.interop.test`, its scopes, and a way to sign a fixture user in on its own authorize page; the agent needs a driver for its `discover`, `startSession`, `signIn` and `call` functions with the callback host, and must trust the run's CA. It covers D, S0, SD, SV, SO, R and an OpenAPI call; no conversations, MCP, device or mediated sign-in, so C, CI and the Operations scenarios are unsupported. Its Company requires the token endpoint as `aud` at revocation too ([S1](spec-issues.md#s1)) and its agent sends no `typ` ([S2](spec-issues.md#s2)). | In the grid as `tipping-co`, both sides, since 13 October ([below](#tipping-co-joins-the-grid)). Its README still said "planning" and nothing had been pushed since 12 October, but the code at `fb7b4e6` ran unpatched. |
| Salespeak (salespeak.ai), Emora Health (emorahealth.com), Tilopay (tilopay.shop) | Company, live lane only | No public code. A live-lane entry would be signed-out D, S0 and, for Salespeak and Emora, a conversation, against someone's production service, and Emora is a health service. | Not added: the owner decides on live traffic to a business. Our validator has checked each once (valid). |
| [EkuboProtocol/cloud-wallet-poppy-pilot-agent](https://github.com/EkuboProtocol/cloud-wallet-poppy-pilot-agent) | Agent, if its code were public | Only client metadata and a JWKS are public. | n/a |
| [emilia-protocol#916](https://github.com/emiliaprotocol/emilia-protocol/pull/916), [service-handshake-pap-extension](https://github.com/neos-wave/service-handshake-pap-extension) | Neither | An offline Operations reference with no HTTP Company, and an extension proposal with schemas only. | n/a |

print-with-poppy's pin moved on 12 October from `7ef69be` to `260dbb4`, upstream's head that evening, 26 commits later ([adapter README](../interop/impls/print-with-poppy-company/README.md#upstream-since-7ef69be)). It is MIT now; `ALLOW_COMPAT_AGENT_SESSIONS=false` works in demo mode, so the patch is gone; the compatibility path is out of the Poppy description; and the store has accounts, Direct and Mediated Sign-In by an emailed code. The adapter gained `approve_authorization`, `deny_authorization`, `mediated_answers`, `last_one_time_code` (each reads the code from the email demo mode stores instead of sending) and `expire_tokens`, and claims SD, SX, SMC, SO, AO, AS and R besides D, S0, CM and OU. Its column, rerun with seven agents over 30 scenarios: 46 pass, 8 fail, 156 unsupported, every failure known ([results](interop-results/README.md#print-with-poppy-at-260dbb4-12-october)).

Datalayer's pin moved on 12 October from `12d7187` (0.6.0) to 0.10.0 (`0c048aa`, 34 commits later); the four adapters' READMEs say what changed for each. Its Companies now accept a client assertion `aud` of the issuer, the token endpoint or the endpoint called, and refuse assertions over 120 s (S2 `lenient-120s`). Device Sign-In still doesn't retry `use_dpop_nonce`, the TypeScript SSE client still gives up after five quick reconnects, a cancelled Operation's `result.data` is still `null` (a confirmed one no longer sends `expires_at: null`), and renewal still needs `session_id`. The full grid that day, with the four images rebuilt, changed 12 cells, all from the move; among them, adonis-agora's S1 cells at both Datalayer Companies now pass ([the results](interop-results/README.md)).

**Pinned upstreams on the evening of 12 October** (`git ls-remote`, then GitHub's compare; print-with-poppy's pin was being moved separately). Every pin below was moved on 13 October, to the heads of that morning ([what moved](#pins-moved-on-13-october)):

| Upstream | Pin | Head | Moved | What changed in its Poppy code | Recommendation |
| --- | --- | --- | --- | --- | --- |
| datalayer/personal-agent-protocol (4 adapters, the vectors) | `0c048aa` (0.10.0) | `ab90426` (0.16.0) | 19 commits | Company: a Session holding a scope no longer offered is `invalid_token` (a refresh for it `invalid_scope`); sign-ins from before a password reset end; telemetry. Agent: an opt-in client that refuses private addresses, which the adapters don't use. Still 124 conformance cases. None of the grid's known Datalayer failures (SVN, CS, handoff and close `conversation_id`, N41, renewal `session_id`) is fixed. | Optional. Move when the images are next rebuilt; no cell should change. |
| rbirkby/Ilmer.org | `4ca76e0` | `de0d1ec` | 12 commits | `poppy_domains` adds `ilmer.org`; the main site serves a static `poppy.json`; frames allowed from ilmer.org; web search and fetch tools on the Workers AI binding. | Hold. The new tools take `env.AI` directly, which the adapter runs without, so a move needs a rebuild and a check that the Worker still starts. No protocol gain. |
| DavideCarvalho/adonis-agora-authkit | `9783885` (0.78.0) | `fe2a3ff` (0.80.0) | 6 commits | A ready-made Mediated Sign-In by emailed code, and an admin page that blocks an agent and ends its Sessions. The adapter already serves Mediated Sign-In with its own `verify`. | Hold. Nothing the grid exercises changed. |
| DavideCarvalho/adonis-agora-agent | `e66a232` | `e139b95` | 8 commits | Docs and generative UI only; `poppy-client` unchanged. | Hold. |
| everruns/everruns | `f470ad7` | `b3f65e6` | 43 commits | None: the `poppy_client` capability, the `poppy` channel, the `poppy_agent` domain and both patched files are unchanged. A turn-backend refactor touched comments, not the API the adapters use. | Hold; it compiles for about 10 minutes and nothing would change. |
| richardanaya/pi-poppy, irvinebroque/poppy-demo, akshay5995/poppyseed | as pinned | same | 0 | | Nothing to do. |
| tusharck/poppy-validator, habib-analyst/poppy-sidecar (validator cross-check) | as pinned | same | 0 | | Nothing to do. |

nestjs-agent, not in the registry, moved one docs-only commit past `548576a`.

## Pins moved on 13 October

On the morning of 13 October we ran `git ls-remote` on every upstream the registry pins, read each diff since our pin in a fresh directory (GitHub tarballs of both commits, compared with `diff -r`; nothing of theirs ran outside Docker), moved every pin to its head, rebuilt each moved image, and smoke-tested it: a moved Company with `--agents pda --scenarios D,S0` (and C where it has conversations), a moved agent with `--companies pda-mock --scenarios D,S0`. Every smoke cell passed: pda against datalayer-ts, datalayer-py, Ilmer, print-with-poppy, adonis-agora and everruns, 17 pass and 1 unsupported (C at print-with-poppy); datalayer-ts, datalayer-py, adonis-agora and everruns against pda-mock, 8 pass; and the adonis-agora Company again after its `/reset` change, with pda and adonis-agora's agent over D, S0, C, SD, SM and SO, 12 pass. Each egress probe was `ENETUNREACH`, `ENETUNREACH`, `EAI_AGAIN`. The full grid ran at the new pins later that morning, after the refactors merged: no cell changed with the moves ([results](interop-results/README.md#latest-run-13-october-30-scenarios-8-agents-12-companies)).

| Upstream | Pin | New pin | Commits | What changed in its Poppy code | Adapter change |
| --- | --- | --- | --- | --- | --- |
| datalayer/personal-agent-protocol (4 adapters, the vectors) | `0c048aa` (0.10.0) | `00216eb` (0.17.0) | 21 | Company only: a Session holding a scope the configuration no longer offers is `invalid_token` (a refresh for one, `invalid_scope`); sign-ins from before a password reset end (`signedOutBefore`); refusals and Sessions reported to telemetry. Agent: an opt-in client that refuses private addresses, and three Reactor displays. The agent clients, `verify`, Manzanita and the 124 conformance cases are unchanged; none of the grid's known Datalayer failures is fixed. | None. Line-anchored links in the READMEs and known failures moved to the same code at the new commit. Vectors at `00216eb`: 24 pass, 2 fail (readings), 98 n/a, as before. |
| rbirkby/Ilmer.org | `4ca76e0` | `de0d1ec` | 12 | `poppy_domains` adds `ilmer.org`; `X-Frame-Options: DENY` became a `frame-ancestors` policy; web search and fetch tools for the Company Agent, built from `env.AI` directly. | The new tools throw at construction without a Workers AI binding, which would fail every conversation, so the container's `wrangler.jsonc` now points `main` at `interop-main.js`: it re-exports upstream's Worker and gives `HistoryAgent` a stand-in `env.AI` that refuses every call. Replies are still the fixed apology; C passes. Upstream's own `ILMER_POPPY_OFFLINE=true` mode has the same gap. |
| DavideCarvalho/adonis-agora-authkit | `9783885` (0.78.0) | `fe2a3ff` (0.80.0) | 6 | An admin page that allows or blocks an agent's `client_id` (a new `auth_agent_registry` table, read on every `isBlocked` and `isRegistered`), and a ready-made Mediated Sign-In by emailed code. Token, revocation, DPoP and discovery code unchanged. | Packages 0.80.0 and 0.80.1 in `app/package.json`; `/reset` also empties `auth_agent_registry`. |
| DavideCarvalho/adonis-agora-agent | `e66a232` (0.79.0) | `e139b95` (0.80.1) | 8 | None: `src/poppy-client/` is byte for byte the same; generative-UI sandbox checks and telemetry, a chat-client abort fix, docs. | None. |
| everruns/everruns | `f470ad7` | `aceb2e2` | 60 | None: `poppy_client`, `poppy_agent`, the `poppy` channel, `url_validation.rs` and the test harness are unchanged. Platform turns now run only as session actors (#4629); the `TurnBackend` trait changed only in comments. | None; both patches apply. Each image rebuilt in about 10 minutes. |
| spenciefy/print-with-poppy | `260dbb4` | `246727d` | 41 | A hosted Agent Sandbox mode (`AGENT_SANDBOX`, sandbox.printwithpoppy.com: Mediated Sign-In only, `@example.*` addresses, sandbox operations that simulate payment and shipment and read captured emails and codes); mixed products and coupons in an order. Token, revocation, sign-in and Operations code unchanged; the revocation 500 is still there. | None: the adapter keeps plain demo mode, and the OU order is still valid. |
| richardanaya/pi-poppy, irvinebroque/poppy-demo, akshay5995/poppyseed | as pinned | same | 0 | | Nothing to do. |
| tusharck/poppy-validator, habib-analyst/poppy-sidecar (validator cross-check) | as pinned | same | 0 | | Rerun at the same pins against our validator at `f52d11f`: the same counts as at `cb39236` (ours and poppy-validator agree on 92 of 107, ours and poppy-sidecar on 77, all three on 70). |

nestjs-agent, not in the registry, has one docs commit past `548576a` (`c0128df`).

## Tipping Co joins the grid

[timothyohare/personal-agent-protocol](https://github.com/timothyohare/personal-agent-protocol) at `fb7b4e6` (12 October, still its head on 13 October) is a learning demo with both sides in TypeScript on Node 24: Tipping Co, a Company for an NRL tipping service (Hono, in-memory stores, signed-out and Direct Sign-In Sessions, an OpenAPI API), and a CLI Personal Agent with a callback host. It declares no licence, so both adapters clone it at build and keep nothing, as print-with-poppy's did before its licence. Both run upstream's code unpatched, with Node 24 running its TypeScript as upstream's own scripts do ([`tipping-co-agent`](../interop/impls/tipping-co-agent), [`tipping-co-company`](../interop/impls/tipping-co-company)).

- **The Company** needs one relaxation: its private-address check before fetching an agent's documents resolves names through a hook in its config (`resolveHost`), which the adapter answers with a TEST-NET-1 address for `*.interop.test` names only (`INTEROP_ALLOW_TEST_HOSTS=1`). The hooks sign in on its own login and consent pages, in process. It claims D, S0, N, CM, SD, SX, SO, R, AO and AS; R is unsupported in practice, because it doesn't rotate Account Tokens. Readings: S1 `token-endpoint` (at revocation too), S2 `lenient-300s`, S3 `either`, S4 `either`.
- **The agent** needs none. Its OpenAPI calls take a method and a path, as its model's `poppy_call` tool does, so the adapter turns the step's operation into them from the description. Readings: S1 `token-endpoint`, S2 `any` (a `kid`, no `typ`), S3 `insertion`, S4 `omit`, S23 `per-origin`.
- **Harness fix.** The Company-side checks found an agent's documents only through the `client_id` form parameter, which Tipping Co's agent doesn't send, so CM failed at its own Company although the Company had fetched both documents. `clientIdOf` in `interop/runner/har.ts` now falls back to the client assertion's `iss` when it equals `sub` (RFC 7521 4.2, RFC 7523 3), for `client_fetched`, the metadata-fetch check and the client metadata validation; a test covers it.

**Its Company column** (13 October, the eight honest agents, its ten scenarios; 80 cells): 50 pass, 13 fail, 17 unsupported, every failure now a known one. adonis-agora and Tipping Co's agent pass every scenario they claim. pda, both Datalayer agents and pi-poppy pass everything but SO: they sign the revocation request's client assertion for the revocation endpoint, and Tipping Co wants its token endpoint there too, so it answers `invalid_client` ([S1](spec-issues.md#s1), blamed on the spec; the grid's first signed-in Company with that reading). pi-poppy also fails N: it retries a token request after `use_dpop_nonce` only when `WWW-Authenticate` names it, which an authorization server needn't send (RFC 9449 8). poppy-demo's caller fails all eight at discovery, as at print-with-poppy (it needs an `agent` member). everruns runs only D (it starts a Session only for a conversation), which passes.

**Its agent row** (13 October, all twelve Companies, its twelve scenarios; 144 cells): 18 pass, 81 fail, 45 unsupported. It passes every claimed scenario at its own Company and D at nine others. Everywhere else its first Session fails: it sends no `client_id` at the token endpoint, which RFC 7521 4.2 makes optional beside a client assertion and the draft never requires, but every token request in the draft's examples carries, and every other Company in the grid refuses a request without it. At Ilmer and everruns it stops at discovery: it requires `authorization_endpoint` in the OAuth metadata, which a signed-out Company needn't publish (RFC 8414 2). Both are known failures, with the agent's code linked.

**In the full grid** (13 October, 30 scenarios): its agent 29 pass, 70 fail, 261 unsupported; its Company 50 pass, 13 fail, 177 unsupported. The first runs above were before our mock changed: both mocks used to refuse a token request without `client_id` ("client_id is required"), stricter than RFC 7521 4.2. They now take the client from the client assertion when its `iss` and `sub` agree, and refuse a `client_id` that differs ([readings.md](readings.md)); Tipping Co's agent passes all twelve scenarios it claims at pda-mock, and pda-mock-strict still refuses it for the missing `typ` (S2).

## everruns joins the grid

[everruns](https://github.com/everruns/everruns) (Rust, MIT) has both sides: the `poppy_client` capability, a signed-out Personal Agent, and the `poppy` channel, a signed-out Company. Its adapters, [`everruns-agent`](../interop/impls/everruns-agent) and [`everruns-company`](../interop/impls/everruns-company), were written on 11 October but never built: the shared Docker disk filled. On 12 October, with about 70 GB free, both images were built and run, and the pair joined the registry.

- **Pin.** Moved from `b09c922` (10 October) to `f470ad7`, upstream's head on 12 October, 64 commits later. The move was small: the protocol client had moved, unchanged on the wire, into `everruns-capabilities` (#4577), which made one import path change and shrank a visibility patch to one line, and upstream had fixed (#4560) and then squashed (#4581) the duplicate migration numbers our second patch worked around. The Company's channel code is the same at both commits.
- **Build.** Each image is 689 MB on disk (148 MB compressed). Compiling `everruns-server` was OOM-killed twice in the 8 GB colima VM, at two jobs and at one, and built once the VM's 6 GB swap file was on: about 10 minutes from a cold cache, 6 for a rebuild.
- **Harness fixes before the cells meant anything.** (1) Each `/reset` started a new in-process server, and everruns' test harness keeps every one alive (it leaks its listener handles on purpose), so the agent's container grew about 280 MB a reset and died some twenty cells into its first run, failing the rest as harness errors. Both images now run a supervisor that restarts the adapter as a child process on each reset (1.5 s). (2) everruns moves its cursor past whatever a send returns, so at a Company that answers in the send (our mock), scenario C's read found nothing; the adapter's `read` now returns every Company message the client has handed back in the conversation, as pda-agent's does. (3) A retried first message went to the conversation it had started, which poppyseed and adonis-agora refuse ([S9](spec-issues.md#s9)); the adapter now resends the same request, as the Datalayer adapters do. (4) At print-with-poppy, which has no conversations, everruns starts no Session at all (it uses one only for a conversation), so `session` is now 501 there rather than a failure blamed on the Company. The agent also claims DP, which needs only `discover` and `session`.
- **Runs** (`--image-tag evr`, the 25 scenarios of [the last grid](interop-results/README.md), each run's egress probe `ENETUNREACH`, `ENETUNREACH`, `EAI_AGAIN`): everruns' agent against all eleven Companies, 275 cells, 32 pass, 11 fail, 232 unsupported; the six other agents against everruns' Company, 150 cells, 20 pass, 3 fail, 127 unsupported. No errors, no flaky cell, every failure known, no stale entry.
- **Failures.** everruns' Session assertion has no `typ` and it declares S2 `any`, so pda-mock-strict, Northstar and Ilmer refuse it at the first Session (S0, C, CI; [S2](spec-issues.md#s2), the spec's, as for pi-poppy and adonis-agora). It reads S3 `append`, fetching metadata only after the issuer's path, so DP fails at both our mocks ([S3](spec-issues.md#s3)). poppy-demo's caller fails D, S0 and C at everruns' Company on its issuer-origin rule, as at the other Companies whose issuer isn't their origin. Everything else passed: everruns' agent passes D, S0, C and CI at seven Companies, and every agent but poppy-demo passes them at everruns' Company.

## Validator cross-check

A validator is neither a Personal Agent nor a Company, so it has no row or column in the grid. Instead, on 12 October we ran ours and the two open third-party validators over the same `poppy.json` documents, in file mode with the requested domain given and no network.

- **Documents (107):** the 26 `poppy.json` fixtures of `test/validator.test.ts` (the spec's example, poppy-demo's live document as served on 11 October, and each mutation); 27 probes, one per rule we expected the validators to read differently; poppy-validator's own 51 fixtures; and poppy-sidecar's 3 generated examples. The grid's Companies serve their documents only at run time, and their HAR files aren't kept, so only poppy-demo's is in the set.
- **How:** `node interop/vectors/validators/run.mjs` ([its README](interop-spec.md#14-retired-with-01-and-02)). Ours runs through `validateText` in Node. Theirs are fetched at pinned commits (poppy-validator `d2220bf`, poppy-sidecar `858db66`) and run in a container with `--network none`, their source mounted read-only, on a digest-pinned Python image with poppy-validator's locked `jsonschema`.
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

### Draft 0.2: ours against the official validator

On 24 October the script gained the official Company validator (the pinned snapshot's CLI, `check --file`, in Docker with no network) and 99 documents that declare 0.2: the stored 0.2 specification's example, two of the original documents, and a 0.2 twin of every 0.1 document. File mode has no serving domain, so ours runs without one here. The 0.1 comparison above reran with the same counts on 24 October. After the 26 October fixes, ours agrees with poppy-validator on 89 of 107 and with poppy-sidecar on 76, all three on 68: three documents moved, a blank name (twice) and an unknown API type in a document declaring 0.2, which poppy-validator, written for 0.1, reads as a newer minor version.

Ours and the official validator gave the same verdict on 75 of 99 on 24 October. Two of the differences were gaps in ours, fixed on 26 October; rerun, they agree on 78, and the 21 left are ours being stricter on 14 and the official schema on 7. All the differences found, by rule, checked against [the stored 0.2 draft](../spec/draft-0.2-2026-10-19/pages/spec.md):

| Rule | Docs | Ours | Official | The 0.2 draft | Who's right |
| --- | --- | --- | --- | --- | --- |
| An issuer with a query or fragment | 3 | error | accepted | RFC 8414 §2 defines the issuer without either | Ours: an RFC MUST the official file mode doesn't check. |
| An unparseable URL (`agent.protocols[].endpoint`, `auth.issuer` of `https://.`, `resource`) | 4 | error | accepted | "an HTTPS URL" (3.1); RFC 8707's absolute URI | Ours. |
| `poppy:` scopes other than read and write | 2 | error | accepted | "Names starting with `poppy:` are reserved" (4.4), no keyword | A Rule, as at 0.1; the official validator doesn't check it. |
| An extension name without a domain prefix | 2 | error | accepted | "Anyone else MUST start an extension's name with a domain they control" (3.3) | Ours, by the MUST. |
| `operations` without its `endpoint` | 1 | error | accepted | Ops 2 | Ours; the official validator doesn't check extensions' members. |
| A mediated field listed twice | 1 | error | accepted | Silent | Ours, but on no text, as at 0.1. |
| An API type other than `openapi` or `mcp` | 3 | was info (`api-type-newer`) | error | "Each API's `type` MUST be one of these" (6); agents SHOULD skip unknown ones | **Official, and fixed on 26 October.** The 0.2 profile had kept the info level meant for a document newer than the validator knew; it is now `api-type-unknown`, an error at every version we check, which our client still doesn't refuse. These three now agree. |
| Empty `scopes`, `agent.protocols` or `mediated.fields` | 5 | warning | error | Silent on emptiness | The official JSON Schema's `minItems`, stricter than the text; ours warns. |
| An extension `version` written as a number | 2 | warning | error | "the extension's major version" (3.3), no type; the examples are strings ([N22](spec-issues.md#n22)) | The schema says string, the text doesn't; N22 stands. |
| A blank `organization.name` | 2 | `""`: was accepted; `"   "`: error | `""`: error; `"   "`: accepted | `organization`: "Display name and domain", required | **Fixed on 26 October:** ours now reports a blank or whitespace-only name as missing, so `""` agrees. The official schema's `minLength` still accepts spaces, so ours is stricter there. |

The changes this suggests to our validator are in [implementations.md](implementations.md#what-we-can-learn-from-the-12-october-participants). Things only ours checks: the issuer's metadata beyond endpoints (auth methods, algorithms, PKCE, the `iss` parameter), client metadata and JWKS, size, content type, UTF-8, non-public hosts, and a secret-looking mediated field marked `secret: false`. Things only poppy-validator reports: an issuer's metadata found only at the appended location (`OA09`, a diagnostic for S3), an empty `apis` list, an uppercase domain, and `web` without a browser session endpoint.

## Risks

The ones that happened: every project except ours and Ilmer needed a relaxation to accept test host names, and two of those relaxations are broader than needed ([N42](spec-issues.md#n42)); a strict reference Company hid everything else about two agents until we split it in two; harness bugs (a TLS wildcard that matched nothing, compressed bodies recorded undecoded, scenarios that treated `wait` as a promise) were as common as implementation bugs at first; and the shared Docker disk filled, which kept everruns out for a day; once it ran, its first cells were harness errors, from a memory leak in how its adapters reset.

- **Churn.** Everything is days old, and each draft can break compatibility: 0.1 to 0.3 took three weeks and retired every other project's adapter. Pin commits and the spec revision.
- **Few runnable servers.** Several implementations need patches to act as interop peers (allowlists, hard-wired peers, SSRF or loopback relaxations). Every relaxation must be an interop-only setting.
- **Workers under `wrangler dev`.** Trusting a private CA for outbound requests is unverified. Our adapters avoid it by running our code in Node; another Workers implementation would need the same, or a `Fetcher`-like seam.
- **Non-determinism.** LLM-backed Companies, timing, staff queues. Use stand-in runners and hooks rather than real time.
- **Wrong blame.** Our mock's readings could pass for the spec's. Keep its seven profiles, and label every attribution with the rule that made it.
- **Licences and goodwill.** Check licences before vendoring. Present the grid as being about the spec, not about anyone's project.

## The live lane: first run, 13 October

Our agent against Alpine Retail's live deployment (`alpine-retail-live`), with its developer's approval, one request a second, signed out: `npm run interop -- --lane live --agents pda --companies alpine-retail-live`.

- **D passes.** Discovery, the OAuth metadata and the OpenAPI description are all valid; the validator CLI agrees (0 errors, 0 warnings, 0 info).
- **S0, N and C fail at the same place, and correctly.** Alpine's token endpoint answers `invalid_client`: "Couldn't resolve the client metadata document host: https://pda.agent.interop.test/poppy/client.json". The live lane runs our agent's container on Docker's bridge, but the agent still names itself by its private interop host, which no public Company can fetch. Fixing that needs a live-lane identity at a public URL whose key only the runner holds; until then only `D` says anything about a live Company, and a live conversation is checked through the deployed agent instead.
- **Since then:** the live lane can have that identity. The deployed Worker serves a separate interop test client at `/poppy/interop/client.json` when the deployment sets `INTEROP_LIVE_JWKS`, and its private key stays on the runner's machine ([interop-spec §10](interop-spec.md#10-lanes), [how to set it up](../interop/README.md#the-live-lanes-identity)). With it, S0, N and C can reach a live Company's token endpoint as an agent it can verify. It has not run live yet.
- **Three runner bugs, fixed:** the lane tried to reset a live Company, which has no adapter (every cell was an error before anything was sent); a trace check made a cell unsupported, though the lane records nothing and section 10 says only steps and expectations decide; and C had no greeting without a fixture hook. Nothing reached Alpine but D's discovery fetches and three token requests.

**14 October, with the public identity.** The live lane now signs as the deployment's interop client (`/poppy/interop/client.json`, its key only on the runner's machine; [interop-spec §10](interop-spec.md#10-lanes)). Against Alpine Retail all four live scenarios pass: D, S0 (a signed-out Session), N (a Session, then an inventory read from the registry entry's `fixture`) and C (a conversation with its agent). A live Company gets a fixture from its registry entry, since it has no adapter.

