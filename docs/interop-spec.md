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
- `commit` MUST pin the implementation's source. The runner records it in every result.

## 3. Network

Every cell runs on a private network with one recording proxy.

- **Names.** A Company `x` is reached at `x.company.interop.test` and any subdomain of it. An agent `y` publishes its client metadata and JWKS at `y.agent.interop.test`. The runner itself is `runner.interop.test`.
- **TLS.** Every name resolves to the proxy, which terminates TLS with a certificate for `*.company.interop.test`, `*.*.company.interop.test`, `*.agent.interop.test` and `runner.interop.test`, issued by a CA generated per run. Every container MUST trust that CA; the runner mounts it at `/interop/ca.pem` and sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` to it.
- **Upstreams.** The proxy forwards each name to its container over plain HTTP on port 8080, adding `X-Forwarded-Proto: https` and the original `Host`. An implementation MUST build its own URLs from its configured origin, not from the inner request.
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
| `POST /reset` | Forget every Company, Session, token, key and conversation; the next run starts clean. Agents also rotate the keys their client metadata lists. |
| `GET /healthz` | 200 once ready. The runner waits up to 60 s. |

### 5.2 Agent

`POST /step` with `{"op": "<op>", "company": "<domain>", "params": {...}}`. The `company` is a host name such as `x.company.interop.test`. The result is `{"ok": true, "result": {...}}` or an error as above. A Poppy error the Company returned is not an adapter error: it is `{"ok": false, "poppy_error": "<code>", "status": <http status>}`.

| `op` | `params` | `result` |
| --- | --- | --- |
| `discover` | | `{"issuer", "poppy_version", "conversations": bool, "apis": [names]}` |
| `session` | `{"label"?}` | `{"session_id", "signed_in": false, "scope"}` |
| `signin` | `{"method": "direct" \| "device" \| "mediated", "scopes"?, "account"?, "label"?}` | `{"pending": {"url"?, "user_code"?, "fields"?}}` or `{"signed_in": true, "account", "scope"}` |
| `signin_continue` | `{"callback_url"?, "fields"?}` | `{"signed_in": true, "account", "scope"}`. `callback_url` is the redirect the runner captured; `fields` answer a Mediated form. |
| `send` | `{"text", "conversation"?, "message_id"?, "wait"?}` | `{"conversation", "message_id", "status", "messages": [{"role", "text"}]}` |
| `read` | `{"conversation", "cursor"?}` | `{"messages", "cursor", "has_more", "status"}` |
| `sse` | `{"conversation", "cursor"?, "max_events"}` | `{"events": [{"id", "type", "data"}]}` |
| `api` | `{"api", "operation" \| "tool", "args"}` | `{"status", "body"}` |
| `web_join` | `{"url"}` | `{"joined": bool}` |
| `approve_op` | `{"operation", "decision": "approve" \| "decline"}` | `{"status"}` |
| `signout` | `{"label"?}` | `{"revoked": bool}` |
| `state` | | `{"sessions": [...], "accounts": [...]}`, with no token values |

An agent adapter MUST drive the implementation's protocol code, not a language model, so that a result never depends on one.

### 5.3 Company

Company adapters use the hooks protocol of poppyseed's check command: `GET /hooks` lists the hook names supported, and `POST /hooks/<name>` performs one.

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
| `propose_operation` | `{"conversation"}` | `{"operation"}` |
| `settle_operation` | `{"operation", "outcome"}` | `{}` |
| `fixture` | | `{"accounts": [...], "scopes": [...], "openapi"?: {"api", "operation"}, "mcp"?: {"api", "tool"}}`: the data scenarios need |

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

- A step names one actor (`agent`, `company` or `runner`) and one operation. `save` stores its result for later `${...}` references. `fixture` is the Company's `fixture` hook result.
- `expect` compares saved values. `poppy_error` expectations (`{"step": "...", "poppy_error": "invalid_session"}`) are how scenarios test refusals.
- `runner` operations: `wait` (`{"ms"}`), `fetch` (a raw request through the proxy, for one-sided probes) and `assert_trace` (a predicate over the recording so far).
- A step whose operation the adapter answers 501 ends the cell as `unsupported`.

## 7. Readings

The open questions whose answers change the wire format. An adapter declares its reading; the runner checks the declared reading against the trace.

| Id | Question | Values |
| --- | --- | --- |
| S1 | Client assertion `aud` | `issuer`, `token-endpoint`, `either` |
| S2 | Assertion `typ` and lifetime | `jwt-60s`, `any` |
| S3 | Metadata location for an issuer with a path | `insertion`, `append`, `either` |
| S4 | `scope` on a signed-out Session request | `omit`, `poppy-read`, `either` |
| S23 | DPoP nonce scope | `per-origin`, `per-company` |

## 8. Checks

After each cell the runner checks the recording, independently of either side's opinion.

- Discovery documents and client metadata go through [`src/validator/`](../src/validator).
- Trace checks over each exchange, named with the mock Company's violation ids (`test/mock-company/violations.ts`) where one exists: assertion `typ`, `kid`, lifetime and `jti` reuse; DPoP `htu`, `htm`, `ath`, `iat` and `jti` reuse; tokens in URLs; a Session Token sent to a host the Company didn't list; redirects followed with credentials.
- Company-side checks, prefixed `company.`: `WWW-Authenticate` on 401, `Retry-After` on 429, OAuth error bodies, `iss` on authorization responses, cursor and SSE shapes.

Each check reports `{id, side, severity: "error" | "warning", exchange, detail}`.

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

Attribution, applied in order, labels each failed cell with the rule that decided it:

1. **violation:** checks found errors on one side only.
2. **grid:** the same agent passes this scenario against the reference Company (`dpa-mock`) but this Company fails it with every other agent, or the converse.
3. **reading:** the two sides declare different readings of a question the failing exchange depends on. Blame `spec`.
4. **unattributed:** none of the above. A known failure listed in `interop/known-failures.json` (`{agent, company, scenario, issue}`) is shown with its issue link.

The runner also writes `index.html`: the grid, one table per scenario with agents as rows and Companies as columns, each cell linking to its steps, checks and HAR.

## 10. Lanes

- **Local:** every implementation in a container, on the private network. The default.
- **Live:** public deployments, signed-out scenarios only (`D`, `S0`, `N`, `C` where the Company allows signed-out conversations), at most one request a second per Company. The live lane uses real names and public TLS, and only our agent.

## 11. One-sided vectors

Hardening cases that need no peer (SSRF, duplicate JSON members, redirects on `client_id`, malformed documents) stay as pirate vectors in `interop/vectors/`, using Datalayer's schema (`id`, `kind`, `role`, `requirements`, `check`, `input`, `expect`).

## 12. Versioning

This document is version 1; every JSON body above carries `interop: 1` or `version: 1`. A change that breaks an adapter increments it, and the runner supports the previous version for one release.
