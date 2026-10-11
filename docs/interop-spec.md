# Poppy interop harness specification

Version 1. What an implementation of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) Draft 0.1 provides to join the M×N interop grid, and what the runner does with it. The rationale and plan are in [interop-testing.md](interop-testing.md); the code is in [`interop/`](../interop).

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Terms

- **Implementation:** one Personal Agent (role `agent`) or one Company (role `company`). A project with both sides registers two implementations.
- **Adapter:** the thin, per-implementation shim that exposes this spec's API in front of an implementation. It is the pirate-testing harness: the test data is shared, the adapter is not.
- **Scenario:** a named sequence of steps, written as data (section 6).
- **Cell:** one agent × one Company × one scenario. A **run** executes a set of cells.
- **Reading:** an implementation's answer to an open question in the draft (section 7).
- **Verdict:** a cell's outcome and the side blamed for it (section 9).

## 2. Registry

`interop/registry.json` lists the implementations. A new implementation joins by pull request to this file.

```json
{
  "version": 1,
  "implementations": [
    {
      "name": "dpa",
      "role": "agent",
      "source": "https://github.com/adewale/dpa",
      "commit": "850860c",
      "build": "interop/impls/dpa-agent",
      "notes": "Drives src/poppy directly; no model."
    }
  ]
}
```

- `name` MUST match `^[a-z0-9-]{1,32}$` and be unique within its role.
- `build` is a directory holding a `Dockerfile`, or `url` is a running deployment (live lane only, section 10).
- `context` (optional) is the Docker build context, relative to the repository root; without it the context is `build`. Our own adapters build from the repository root (`"context": "."`), since they bundle `src/`.
- `commit` MUST pin the implementation's source. The runner records it in every result. `"HEAD"` means the commit of this repository being run, for implementations built from it.
- `subdomains` (optional) lists further names under `<name>.company.interop.test` the Company serves, beyond the runner's defaults (`www`, `auth`, `api`, `mcp`, `cdn`, `uk`, `app`, `login`, `id`, `accounts`, `oauth`, `chat`, `agent`).
- `env` (optional) is extra environment for the container. Entries of one role with the same `build` and `context` share one image, named after the first; `env` tells them apart (`dpa-mock` and `dpa-mock-strict` are one image with two profiles).

## 3. Network

Every cell runs on a private network with one recording proxy.

- **Names.** A Company `x` is reached at `x.company.interop.test` and any subdomain of it. An agent `y` publishes its client metadata and JWKS at `y.agent.interop.test`. The runner itself is `runner.interop.test`.
- **Resolution.** Every name resolves to the proxy through Docker network aliases: each Company's name, the default subdomains and its registry `subdomains`, each agent's name, and `runner.interop.test`. A name not in that list doesn't resolve.
- **TLS.** The proxy terminates TLS with a certificate for `*.company.interop.test`, `*.<x>.company.interop.test` for each Company `x`, `*.agent.interop.test` and `runner.interop.test`, issued by a CA generated per run. (TLS wildcards match one label, so `*.*.company.interop.test` would match nothing; each Company gets its own.) Every container MUST trust that CA; the runner copies it to `/interop/ca.pem` before the container starts and sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` to it.
- **`/interop` belongs to the runner.** An adapter image MUST NOT create `/interop`. The runner copies its trust directory with `docker cp`, which makes `/interop` when it is absent, but copies *into* it when it exists, so the CA would land at `/interop/trust/ca.pem` and every TLS connection would fail.
- **`SSL_CERT_FILE` replaces the system bundle.** Clients that honour it (Python's `ssl` and `httpx`, Ruby, Go on Linux) read `SSL_CERT_FILE` *instead of* the system CAs, and `REQUESTS_CA_BUNDLE` does the same for `requests`. Inside the private network that is what is wanted: every name is the proxy's. An adapter that also needs public CAs (to fetch something at startup) MUST build a bundle of the system CAs and `/interop/ca.pem` and point these variables at it; Node's `NODE_EXTRA_CA_CERTS` adds to the built-in CAs and needs nothing.
- **Upstreams.** The proxy forwards each name to its container over plain HTTP on port 8080, adding `X-Forwarded-Proto: https` and the original `Host`. Containers carry the network alias `<role>-<name>` (`company-x`, `agent-y`). An implementation MUST build its own URLs from its configured origin, not from the inner request.
- **Environment.** The runner sets `INTEROP_SECRET`, `INTEROP_NAME`, `INTEROP_ROLE`, `INTEROP_DOMAIN` (`x.company.interop.test` or `y.agent.interop.test`), `INTEROP_ORIGIN` (`https://` and the domain) and `INTEROP_COMMIT`, then the registry's `env` and any `--set name:KEY=VALUE` given to the runner.
- **Recording.** The proxy writes every exchange, request and response in full, to a HAR file per cell. Nothing is redacted: every key and token is generated for the run.
- **Interop-only settings.** An implementation MAY need to allow `*.interop.test` names, a private CA or a peer it doesn't know. Each such relaxation MUST be a setting that is off by default, and the adapter MUST name it in its manifest (`relaxations`).

## 4. Manifest

Every adapter serves `GET /manifest` on its control port (8081), with no authentication:

```json
{
  "interop": 1,
  "name": "dpa",
  "role": "agent",
  "commit": "850860c",
  "poppy": ["0.1"],
  "extensions": ["operations"],
  "scenarios": ["D", "S0", "N", "SD", "C", "CI", "SO", "O"],
  "readings": { "S1": "token-endpoint", "S3": "insertion" },
  "relaxations": ["Accepts *.interop.test as public hosts"]
}
```

- `scenarios` lists what the adapter claims to support. A cell whose scenario either side doesn't list is `unsupported`, not failed.
- `readings` keys are section 7's question ids.

## 5. Adapter APIs

Control requests carry `Authorization: Bearer <secret>`, where the runner passes the secret in `INTEROP_SECRET`. Bodies are JSON. Every endpoint answers 200 with a JSON body, 501 for an operation the adapter doesn't support, or 4xx/5xx with `{"error": "<code>", "detail": "<text>"}`.

### 5.1 Common

| Request | Meaning |
| --- | --- |
| `GET /manifest` | Section 4. |
| `POST /reset` | Forget every Company, Session, token, key and conversation; the next run starts clean. Agents also rotate the keys their client metadata lists, each new key under a new `kid`: a Company that cached the previous JWKS must not find a reused `kid` naming a different key. |
| `GET /healthz` | 200 once ready. The runner waits up to 60 s. |

### 5.2 Agent

`POST /step` with `{"op": "<op>", "company": "<domain>", "params": {...}}`. The `company` is a host name such as `x.company.interop.test`. The result is `{"ok": true, "result": {...}}` or an error as above. A Poppy error the Company returned is not an adapter error: it is `{"ok": false, "poppy_error": "<code>", "status": <http status>}`. So is the agent's own refusal of something the Company did (`discovery_failed` for documents it won't use, `access_denied` for a declined sign-in), with `status` 0.

| `op` | `params` | `result` |
| --- | --- | --- |
| `discover` | | `{"issuer", "poppy_version", "conversations": bool, "apis": [types]}` |
| `session` | `{"label"?}` | `{"session_id", "signed_in": false, "scope"}` |
| `signin` | `{"method": "direct" \| "device" \| "mediated", "scopes"?, "account"?, "label"?}` | `{"pending": {"url"?, "user_code"?, "fields"?}}` or `{"signed_in": true, "account", "scope"}` |
| `signin_continue` | `{"callback_url"?, "fields"?, "code"?}` | `{"signed_in": true, "account", "scope"}`, or `{"pending": {"code_required": true}}` when a Mediated Sign-In asks for a one-time code. `callback_url` is the redirect the runner captured; `fields` answer a Mediated form; `code` is the one-time code. A Device Sign-In continues by polling until the Company answers. |
| `send` | `{"text", "conversation"?, "message_id"?, "wait"?}` | `{"conversation", "message_id", "status", "messages": [{"role", "text"}]}`. `message_id` in params is a retry key: two sends with the same key send the same message, with the same id. |
| `read` | `{"conversation", "cursor"?, "wait"?}` | `{"messages", "cursor", "has_more", "status"}` |
| `sse` | `{"conversation", "cursor"?, "max_events", "wait"?}` | `{"events": [{"id", "type", "data"}], "last_id"}` |
| `api` | `{"api", "operation" \| "tool", "args"}` | `{"status", "body"}`, or `{"held"}` (below) |
| `web_join` | `{"url"}` | `{"joined": bool}` |
| `approve_op` | `{"operation", "decision": "approve" \| "decline"}` | `{"status"}`; for a held write, `{"status", "result"?}` with the API's answer as `api` gives it |
| `signout` | `{"label"?}` | `{"revoked": bool}` |
| `state` | | `{"sessions": [...], "accounts": [...]}`, with no token values |

- **`api`.** `api` is `"openapi"`, `"mcp"` or an API entry's `url`. For OpenAPI, `operation` names one operation of the description: its `operationId`, or, for one without, `"METHOD /path"` with the method in upper case and the path exactly as the description writes it (`"POST /orders/{order_id}/exchanges"`); `args` is `{"params"?, "body"?}`, where `params` fill path and query parameters by name. For MCP, `tool` is a tool's name and `args` its arguments. A Poppy error from the Company (a 4xx or 5xx whose body or `WWW-Authenticate` carries an `error`) is `{"ok": false, "poppy_error", "status"}`, as for any step. Any other answer, an HTTP error without a Poppy error included, is `{"ok": true, "result": {"status", "body"}}` with the API's real status: a 404 is reported as 404, never as a 200 with the 404 inside.
- **Held writes.** An agent that holds a write for its User's approval (at a Company without the Operations extension, say) answers `api` with `{"held": "<id>"}` and sends nothing. `approve_op` with that id plays the User's decision through the agent's own approval path, and its answer is the write's outcome: a refusal as `{"ok": false, "poppy_error"}`, a response as `{"status": "done", "result": {"status", "body"}}`. Scenarios run that step with `"when": "${w.held}"` (section 6).
- **`read` with a `cursor`** returns only the messages after that cursor, as the Company's events endpoint does.

An agent adapter MUST drive the implementation's protocol code, not a language model, so that a result never depends on one.

### 5.3 Company

Company adapters use a hooks protocol modelled on poppyseed's check command (not identical to it): `GET /hooks` lists the hook names supported, and `POST /hooks/<name>` performs one, with the params as the request body. A hook answers its result object itself, raw: `{"redirect": "..."}`, not wrapped. (Agent `/step` results are wrapped, `{"ok": true, "result": {...}}`, because a step can also be a Poppy refusal; a hook can't.)

| Hook | `params` | `result` |
| --- | --- | --- |
| `approve_authorization` | `{"url", "account", "scopes"?}` (the authorization URL the agent produced) | `{"redirect"}`: the callback URL with `code`, `state` and `iss` |
| `deny_authorization` | `{"url"}` | `{"redirect"}` with `error=access_denied` |
| `approve_device` | `{"user_code", "account", "scopes"?}` | `{}` |
| `deny_device` | `{"user_code"}` | `{}` |
| `mediated_answers` | `{"account"}` | `{"fields": {...}}`: values that sign that account in |
| `last_one_time_code` | | `{"code"}` |
| `end_sessions` | | `{"ended": n}` |
| `staff_join` | `{"conversation", "text"}` | `{}` |
| `staff_reply` | `{"conversation", "text"}` | `{}` |
| `propose_operation` | `{"conversation"}` | `{"operation"}`: an operation proposed in that conversation. A Company whose agent proposes when asked (`fixture.prompts.operation`) may return the proposal it already made. |
| `settle_operation` | `{"operation", "outcome"}` | `{}` |
| `require_nonce` | | `{}`: from now until reset, DPoP proofs need a server nonce |
| `rate_limit` | `{"requests", "retry_after", "endpoint"?: "token" \| "resource"}` | `{}`: the next `requests` requests answer 429 with `Retry-After: retry_after` |
| `expire_tokens` | | `{"expired": n}`: every Session Token issued so far is now expired |
| `fixture` | | `{"accounts": [...], "scopes"?: {"read", "write"}, "openapi"?, "openapi_public"?, "openapi_write"?, "mcp"?, "prompts"?, "otp_account"?}`: the data scenarios need (below) |

`fixture` members: `scopes.read` is the list of scopes a sign-in asks for to read (`["poppy:read"]` when absent) and `scopes.write` those it asks for to write too (`["poppy:read", "poppy:write"]` when absent), so a Company with its own scopes (`orders:read`) is tested with them, not relaxed into Poppy's; scenarios refer to them as `${fixture.scopes.read}` and `${fixture.scopes.write}`. (Version 1's `scopes`, a list of every scope offered, is still read, as `scopes.all`.) `openapi` is a read needing `scopes.read`, `openapi_public` one that works signed out, `openapi_write` one needing `scopes.write`, each `{"api", "operation", "args": {"params"?, "body"?}}`; `mcp` is `{"api", "tool", "args"}`; `prompts` are messages to the Company's agent: `hello` (any reply), `sign_in` (one it answers with `sign_in_required` when signed out), `operation` (one it answers with a proposed operation when signed in); `otp_account` is an account whose Mediated Sign-In asks for a one-time code.

A Company adapter that records the agent's protocol violations MAY serve them at `GET /violations` (authenticated) as `{"violations": [{"id", "detail"}]}`. The runner adds each to the cell's checks as an agent-side error, with `source` `company:<name>`.

A Company with no hook for a human step MAY instead ship a Playwright script (`interop/impls/<name>/consent.mjs`) that the runner calls with the consent URL and account.

## 6. Scenarios

A scenario is a JSON file in `interop/scenarios/`:

```json
{
  "id": "SD",
  "title": "Direct Sign-In",
  "requirements": ["4.5", "4.6"],
  "needs": { "agent": ["discover", "session", "signin", "signin_continue"], "company": ["approve_authorization"] },
  "steps": [
    { "agent": "discover" },
    { "agent": "session", "save": "s" },
    { "agent": "signin", "params": { "method": "direct", "scopes": ["poppy:read"] }, "save": "pending" },
    { "company": "approve_authorization", "params": { "url": "${pending.pending.url}", "account": "${fixture.accounts.0}" }, "save": "consent" },
    { "agent": "signin_continue", "params": { "callback_url": "${consent.redirect}" }, "save": "done" },
    { "expect": { "${done.signed_in}": true } }
  ]
}
```

- A step names one actor (`agent`, `company` or `runner`) and one operation. `save` stores its result for later `${...}` references. `fixture` is the Company's `fixture` hook result. A string that is exactly one reference becomes the referenced value, of any type; a reference to nothing fails the cell.
- `expect` compares saved values: a value, or operators `$exists`, `$in`, `$ne`, `$contains`, `$includes_scope`, `$gte`, `$lte`, `$length`, `$length_gte`, `$some` (an array member matching a partial object) and `$match` (a regular expression). `poppy_error` expectations (`{"step": "...", "poppy_error": "invalid_session"}`) are how scenarios test refusals: a refused step fails the cell unless a later expectation names it this way.
- `runner` operations: `wait` (`{"ms"}`), `fetch` (a raw request through the proxy, for one-sided probes; it carries `X-Interop-Probe` and no check judges it) and `assert_trace` (a predicate over the recording so far: `request_seen`, `nonce_retry`, `revoked`, `refresh_rotated`, `retry_after_respected`). A predicate with nothing to judge (no nonce was ever asked for) makes the cell `unsupported`.
- A step whose operation the adapter answers 501 ends the cell as `unsupported`, unless the step is `"optional": true`.
- `"when": "${name.path}"` runs a step only when the reference names something other than null or false; otherwise the step is recorded as skipped. It is for steps one side's design needs and another's doesn't (approving a held write, section 5.2).
- `readings` lists the section 7 questions the scenario depends on, for attribution rule 3; `live: true` marks scenarios the live lane may run.

## 7. Readings

The open questions whose answers change the wire format. An adapter declares its reading; the runner checks the declared reading against the trace.

| Id | Question | Values |
| --- | --- | --- |
| S1 | Client assertion `aud` | `issuer`; `token-endpoint` (the token endpoint, at the device and revocation endpoints too); `endpoint` (the endpoint the assertion is sent to); `either` |
| S2 | Assertion `typ` and lifetime | `jwt-60s`, `any` |
| S3 | Metadata location for an issuer with a path | `insertion`, `append`, `either` |
| S4 | `scope` on a signed-out Session request | `omit`, `poppy-read`, `either` |
| S23 | DPoP nonce scope | `per-origin`, `per-company` |

## 8. Checks

After each cell the runner checks the recording, independently of either side's opinion.

- Discovery documents and client metadata go through [`src/validator/`](../src/validator).
- Trace checks over each exchange, named with the mock Company's violation ids (`test/mock-company/violations.ts`) where one exists: assertion `typ`, `kid`, lifetime and `jti` reuse; DPoP `htu`, `htm`, `ath`, `iat` and `jti` reuse; tokens in URLs; a Session Token sent to a host the Company didn't list; redirects followed with credentials.
- Company-side checks, prefixed `company.`: `WWW-Authenticate` on 401, `Retry-After` on 429, OAuth error bodies, `iss` on authorization responses, cursor and SSE shapes.

- An agent's declared readings of S1, S2 and S4, checked against what it sent, as `reading.<id>` warnings. S1 is checked at every endpoint a client assertion goes to (token, device authorization, revocation).

Each check reports `{id, side, severity: "error" | "warning", exchange, detail, source}`. A MUST broken is an error; what the draft leaves open but strict Companies enforce (assertion `typ` and a 60-second lifetime, S2) is a warning, so a lenient pair isn't failed for it.

## 9. Results and attribution

A run writes `interop/results/<run>/results.json`:

```json
{
  "interop": 1,
  "run": "2026-10-11T12:00:00Z",
  "spec": "Draft 0.1, Oct 9 2026",
  "implementations": [{ "name": "dpa", "role": "agent", "commit": "850860c", "readings": {} }],
  "cells": [
    {
      "agent": "dpa", "company": "dpa-mock", "scenario": "SD",
      "outcome": "pass" | "fail" | "unsupported" | "error",
      "blame": "agent" | "company" | "spec" | "harness" | null,
      "rule": "violation" | "grid" | "reading" | "unattributed" | null,
      "steps": [{ "actor", "op", "ms", "ok", "error"? }],
      "checks": [...],
      "har": "SD/dpa__dpa-mock.har"
    }
  ]
}
```

- `pass`: every step and expectation held and no check reported an error. Warnings don't fail a cell.
- `error`: the harness failed (a container didn't start, an adapter crashed); blame `harness`.
- A cell also carries `reason` (why it didn't pass, and what decided its blame) and `known` (a known failure's issue). The run carries `lane`, and each implementation its manifest's `relaxations`.

Attribution, applied in order, labels each failed cell with the rule that decided it:

1. **violation:** checks found errors on one side only. A violation the Company recorded that is exactly a declared reading difference is not counted: a check that belongs to a section 7 question (S2: `client-assertion.typ`, `.kid`, `.lifetime` and the same for `session-assertion`; S1: `client-assertion.aud`) where the two sides' declared readings of that question are incompatible. A cell whose every error is such a check goes to rule 3 at once: a strict Company refusing a typ-less assertion from an agent that declared S2 `any` is the spec's open question, not the agent's mistake. An agent that declared `jwt-60s` and sent no `typ` broke its own reading, and rule 1 blames it.
2. **grid:** the same agent passes this scenario against the reference Company (`dpa-mock`, the mock with its S2-lenient settings; `dpa-mock-strict` is the same mock with strict assertions) but this Company fails it with every agent that ran it: blame the Company. Or this agent fails it with every Company it ran against, while this Company passes it with another agent: blame the agent. Unsupported and errored cells don't count.
3. **reading:** the two sides declare incompatible readings of a question the scenario lists in `readings`, or that one of the cell's error checks belongs to (rule 1). Blame `spec`. Compatible means equal, or `either` on one side; for S2 a Company reading `jwt-60s` is incompatible only with an agent reading `any`, and for S23 a Company reading `per-origin` only with an agent reading `per-company`.
4. **unattributed:** none of the above.

A failed or errored cell listed in `interop/known-failures.json` (`{"version": 1, "failures": [{agent, company, scenario, issue, reason}]}`) is shown with its issue link and reason. Any of `agent`, `company` and `scenario` may be `"*"`, for any: one root cause is one entry (`{"agent": "pi-poppy", "company": "*", "scenario": "SE"}`). When several entries match a cell, the one with the fewest wildcards wins, then the first in the file. The runner exits 1 when any failed or errored cell isn't a known failure, and lists entries that matched no failed cell in what it ran, which are fixed or stale.

The runner also writes `index.html`: the grid, one table per scenario with agents as rows and Companies as columns, each cell linking to its steps, checks and HAR.

## 10. Lanes

- **Local:** every implementation in a container, on the private network. The default.
- **Live:** public deployments, signed-out scenarios only (`D`, `S0`, `N`, `C` where the Company allows signed-out conversations), at most one request a second per Company. The live lane uses real names and public TLS, and only our agent. Companies are registry entries with `url`; scenarios are those marked `live` that need no Company hook; nothing is recorded, so only steps and expectations decide a cell. Agents pace themselves from `INTEROP_PACE_MS`.

## 11. One-sided vectors

Hardening cases that need no peer (SSRF, duplicate JSON members, redirects on `client_id`, malformed documents) stay as pirate vectors in `interop/vectors/`, using Datalayer's schema (`id`, `kind`, `role`, `requirements`, `check`, `input`, `expect`). `validator.json` holds our validator's fixtures (a document's text, or the responses a fake network served, and the message ids expected); `mock-company.json` holds the mock Company's tamper rows (what an agent got wrong, and the check a strict Company names for it). Both are generated from the tests (`npm run interop:vectors`), and the tests fail while they are stale.

## 12. Versioning

This document is version 1; every JSON body above carries `interop: 1` or `version: 1`. A change that breaks an adapter increments it, and the runner supports the previous version for one release.
