# Poppy interop harness specification

The runner currently checks explicit 0.1 and 0.2 lanes. Each cell records the common `protocolVersion` and local `specificationRevision`; no common version is unsupported. Retries preserve that context. Unversioned known failures apply only to 0.1. Registry entries marked `vectorsOnly` are explicit provisioning helpers excluded from the default M×N grid. The official validator reuses provisioning and cleanup in its [one-sided lane](../interop/vectors/official/README.md); its checks do not contribute grid passes.


Version 1. What an implementation of the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) provides to join the M×N interop grid, and what the runner does with it. The rationale and plan are in [interop-testing.md](interop-testing.md); the code is in [`interop/`](../interop).

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
      "name": "pda",
      "role": "agent",
      "source": "https://github.com/adewale/pda",
      "commit": "850860c",
      "build": "interop/impls/pda-agent",
      "notes": "Drives src/poppy directly; no model."
    }
  ]
}
```

- `name` MUST match `^[a-z0-9-]{1,32}$` and be unique within its role.
- `build` is a directory holding a `Dockerfile`, or `url` is a running deployment (live lane only, section 10).
- `context` (optional) is the Docker build context, relative to the repository root; without it the context is `build`. Our own adapters build from the repository root (`"context": "."`), since they bundle `src/`.
- `commit` MUST pin the implementation's source. The runner records it in every result. `"HEAD"` means the commit of this repository being run, for implementations built from it.
- `fixture` (optional, live lane only) is a live Company's fixture, since it has no adapter to answer the `fixture` hook: for example `openapi_public`, the read N calls. It is merged over the lane's one greeting.
- `subdomains` (optional) lists further names under `<name>.company.interop.test` the Company serves, beyond the runner's defaults (`www`, `auth`, `api`, `mcp`, `cdn`, `uk`, `app`, `login`, `id`, `accounts`, `oauth`, `chat`, `agent`).
- `env` (optional) is extra environment for the container. Entries of one role with the same `build` and `context` share one image, named after the first; `env` tells them apart (`pda-mock` and `pda-mock-strict` are one image with two profiles, and the adversarial `evil-agent`/`evil-company` are the honest images with `INTEROP_ADVERSARY` set).
- `owner` (optional) is `"self"` for an implementation this project owns. An adversarial or faulted cell runs only when every honest side is `owner: "self"`, except `evil-company` against another project's agent (section 13).
- `adversarial` (optional) is `true` for an implementation that misbehaves on purpose (`evil-agent`, `evil-company`). The live lane (section 10) refuses it; it is never a grid reference (section 9, rule 2) and never counts toward interop pass rates.

## 3. Network

Every cell runs on a private network with one recording proxy, and nothing on that network can reach the internet.

- **Isolation.** The local lane's network is created `--internal`: no route out, and Docker's resolver answers only the run's own names, so no container, ours or a third party's, can reach a real system, whether for analytics, a model API or a package install at startup. The runner MUST NOT run an implementation on a network that isn't internal, and no option, setting or registry field lifts this. Before any implementation starts, the runner checks that `docker network inspect` reports the network internal and runs an egress probe with `docker exec` in the proxy (on the internal network only, as every implementation is): a TCP connection to `1.1.1.1:443` and to `8.8.8.8:53`, and a DNS lookup of `example.com`. Every attempt must fail; if one succeeds, or the probe gives no verdict, the run stops. `results.json` records the probe's outcome as `isolation` (a typical one: `ENETUNREACH`, `ENETUNREACH`, `EAI_AGAIN`). An implementation that needs the internet at runtime fails its cells, and the failure is a known failure with what it tried to reach; the network is never opened for it. Everything an image needs is fetched when it is built.
- **Control relay.** A port can't be published from an internal network, so the runner reaches the proxy's control port (8082) through a relay: a second container of the proxy image running `relay.mjs`, on the internal network and on a second, ordinary per-run network, publishing only its own port on `127.0.0.1` and forwarding every connection to one fixed address, the proxy's control port. Adapters' control calls go through the proxy's `/control`, and the proxy, on the internal network only, has no way out either. The relay is the only container with a published port or a route out, and it runs our code. It carries only control traffic, which the proxy never records, so the recording and attribution don't see it.
- **Names.** A Company `x` is reached at `x.company.interop.test` and any subdomain of it. An agent `y` publishes its client metadata and JWKS at `y.agent.interop.test`. The runner itself is `runner.interop.test`.
- **Resolution.** Every name resolves to the proxy through Docker network aliases: each Company's name, the default subdomains and its registry `subdomains`, each agent's name, and `runner.interop.test`. A name not in that list doesn't resolve.
- **TLS.** The proxy terminates TLS with a certificate for `*.company.interop.test`, `*.<x>.company.interop.test` for each Company `x`, `*.agent.interop.test` and `runner.interop.test`, issued by a CA generated per run. (TLS wildcards match one label, so `*.*.company.interop.test` would match nothing; each Company gets its own.) Every container MUST trust that CA; the runner copies it to `/interop/ca.pem` before the container starts and sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` to it.
- **`/interop` belongs to the runner.** An adapter image MUST NOT create `/interop`. The runner copies its trust directory with `docker cp`, which creates `/interop` when it is absent but copies *into* it when it exists; the CA would then land at `/interop/trust/ca.pem` and every TLS connection would fail.
- **`SSL_CERT_FILE` replaces the system bundle.** Clients that honour it (Python's `ssl` and `httpx`, Ruby, Go on Linux) read `SSL_CERT_FILE` *instead of* the system CAs, and `REQUESTS_CA_BUNDLE` does the same for `requests`. Inside the private network that is what is wanted: every name is the proxy's, and nothing else is reachable (Isolation). An adapter whose implementation insists on a combined bundle MAY build one of the system CAs and `/interop/ca.pem` and point these variables at it; Node's `NODE_EXTRA_CA_CERTS` adds to the built-in CAs and needs nothing.
- **Upstreams.** The proxy forwards each name to its container over plain HTTP on port 8080, adding `X-Forwarded-Proto: https` and the original `Host`. Containers carry the network alias `<role>-<name>` (`company-x`, `agent-y`). An implementation MUST build its own URLs from its configured origin, not from the inner request.
- **Environment.** The runner sets `INTEROP_SECRET`, `INTEROP_NAME`, `INTEROP_ROLE`, `INTEROP_DOMAIN` (`x.company.interop.test` or `y.agent.interop.test`), `INTEROP_ORIGIN` (`https://` and the domain) and `INTEROP_COMMIT`, then the registry's `env` and any `--set name:KEY=VALUE` given to the runner.
- **Recording.** The proxy writes every exchange, request and response in full, to a HAR file per cell, up to 2,000 exchanges a cell. Past that, requests still pass through and the HAR's comment counts the ones not recorded, so an agent that loops (XR, XT) leaves a HAR small enough to send and still fails `bounded_requests`. Nothing is redacted: every key and token is generated for the run.
- **Fault injection.** A scenario's `faults` list (section 6) makes the proxy the network adversary. Each fault is `{match, action}`, where `match` is `{host?, path?, method?, direction?, nth?}` and `action` is one of `replay` (resend an honest request verbatim, later), `duplicate` (forward the request twice), `drop_response` (forward it, then drop the answer to the client), `delay` (`{ms}`, hold the request), `truncate` (`{bytes}`, cut the answer), `reset` (reset the client connection) and `status` (`{status}`, answer another status). An exchange the proxy created or altered is marked `_interop.injected`/`_interop.fault` in the HAR; the checks skip injected exchanges, so an injected request is never blamed on an honest side.
- **Labels and cleanup.** Every container, network (the internal one and the relay's) and volume the runner creates carries the label `interop.run=<tag>`, the run's random tag. On exit, on error and on SIGINT or SIGTERM it removes exactly those (containers with their anonymous volumes), unless `--keep`. It never removes images, which runs reuse, never touches the build cache, and never removes anything without its own run's label.
- **Disk.** Before it starts, the runner runs `df -Pk /` in a short-lived container of the proxy image (its root is the overlay on Docker's data disk) and refuses to start with less free than `--min-free-gb` (2 GB by default). A first run, before the proxy image exists, skips the check.
- **Interop-only settings.** An implementation MAY need to allow `*.interop.test` names, a private CA or a peer it doesn't know. Each such relaxation MUST be a setting that is off by default, and the adapter MUST name it in its manifest (`relaxations`).

## 4. Manifest

Every adapter serves `GET /manifest` on its control port (8081), with no authentication:

```json
{
  "interop": 1,
  "name": "pda",
  "role": "agent",
  "commit": "850860c",
  "poppy": ["0.1"],
  "extensions": ["operations"],
  "scenarios": ["D", "S0", "N", "SD", "C", "CI", "SO", "O"],
  "readings": { "S1": "endpoint", "S2": "jwt-60s", "S3": "insertion", "S4": "omit", "S23": "per-origin" },
  "relaxations": []
}
```

- `scenarios` lists what the adapter claims to support. A cell whose scenario either side doesn't list is `unsupported`, not failed.
- `readings` keys are section 7's question ids.
- `attacks` (adversarial adapters only) lists the attack ids the adapter can `arm` (section 5). An armed attack the adapter doesn't support answers 501, so the cell is `unsupported`.

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
| `send` | `{"text", "conversation"?, "message_id"?, "wait"?, "sender"?, "parent_conversation"?}` | `{"conversation", "message_id", "status", "messages": [{"role", "sender"?, "text"}]}`. `message_id` in params is a retry key: two sends with the same key send the same message, with the same id. `sender` is `"human"` for the User's own words (7.8; the agent's default otherwise). `parent_conversation` starts a Direct Conversation under that conversation (7.10), its id the result's `conversation`. |
| `handoff` | `{"conversation", "text"?}` | `{"status", "responder"}`, the Company's answer to a handoff request (7.9). An agent that sends a note for the person first may take it from `text`. |
| `close` | `{"conversation"}` | `{"status", "responder"}`, the Company's answer to closing the conversation (7.12). |
| `confirm_again` | `{"operation"}` | `{"status", "operation"?}`: the agent sends the confirm of an operation it already confirmed again, unchanged, as it would after losing the first answer (Ops 5.2, 6); `status` is the state the Company returned. An agent that never sends a confirm twice answers 501. |
| `read` | `{"conversation", "cursor"?, "wait"?}` | `{"messages", "cursor", "has_more", "status"}` |
| `sse` | `{"conversation", "cursor"?, "max_events", "wait"?}` | `{"events": [{"id", "type", "data"}], "last_id"}` |
| `api` | `{"api", "operation" \| "tool", "args"}` | `{"status", "body"}`, or `{"held"}` (below) |
| `web_join` | `{"url"}` | `{"joined": bool}` |
| `approve_op` | `{"operation", "decision": "approve" \| "decline"}` | `{"status"}`; for a held write, `{"status", "result"?}` with the API's answer as `api` gives it |
| `signout` | `{"label"?}` | `{"revoked": bool}` |
| `state` | | `{"sessions": [...], "accounts": [...]}`, with no token values |
| `arm` | `{"attack", ...}` | `{"armed": "<attack>"}` (adversarial agent only; an unknown attack answers 501) |
| `attack` | `{...}` | the Company's answer to the armed attack, or a Poppy refusal `{ok: false, poppy_error}` (adversarial agent only) |

- **`api`.** `api` is `"openapi"`, `"mcp"` or an API entry's `url`. For OpenAPI, `operation` names one operation of the description: its `operationId`, or, for one without, `"METHOD /path"` with the method in upper case and the path exactly as the description writes it (`"POST /orders/{order_id}/exchanges"`); `args` is `{"params"?, "body"?, "files"?}`, where `params` fill path and query parameters by name. `files` is for an operation whose request body is `multipart/form-data`: each file field's name, with the file as `{"name", "type", "data"}`, `data` its bytes in base64; `body`'s members are the form's other fields. In a scenario, `files` names a file in `interop/files/` (`{"photo": "lake.jpg"}`), and the runner sends the agent its name, media type and content, so adapters need no access to the harness's files. For MCP, `tool` is a tool's name and `args` its arguments. A Poppy error from the Company (a 4xx or 5xx whose body or `WWW-Authenticate` carries an `error`) is `{"ok": false, "poppy_error", "status"}`, as for any step. Any other answer, an HTTP error without a Poppy error included, is `{"ok": true, "result": {"status", "body"}}` with the API's real status: a 404 is reported as 404, never as a 200 with the 404 inside.
- **Held writes.** An agent that holds a write for its User's approval (at a Company without the Operations extension, say, or any upload of its User's file) answers `api` with `{"held": "<id>"}` and sends nothing. `approve_op` with that id plays the User's decision through the agent's own approval path, and its answer is the write's outcome: a refusal as `{"ok": false, "poppy_error"}`, a response as `{"status": "done", "result": {"status", "body"}}`. Scenarios run that step with `"when": "${w.held}"` (section 6).
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
| `issuer_path` | `{"path"?}` (default `/tenant`) | `{"path"}`: from now until reset, the issuer has that path and its server metadata is only where RFC 8414 3.1 inserts it, `/.well-known/oauth-authorization-server<path>` (scenario `DP`, S3) |
| `arm` | `{"attack", ...}` | `{"armed": "<attack>"}`: reconfigure the Company so the attack is its only deviation (adversarial Company only; an unknown attack answers 501) |
| `fixture` | | `{"accounts": [...], "scopes"?: {"read", "write"}, "openapi"?, "openapi_public"?, "openapi_write"?, "openapi_upload"?, "openapi_propose"?, "mcp"?, "prompts"?, "otp_account"?}`: the data scenarios need (below) |

`fixture` members: `scopes.read` is the list of scopes a sign-in asks for to read (`["poppy:read"]` when absent) and `scopes.write` those it asks for to write too (`["poppy:read", "poppy:write"]` when absent), so a Company with its own scopes (`orders:read`) is tested with them, not relaxed into Poppy's; scenarios refer to them as `${fixture.scopes.read}` and `${fixture.scopes.write}`. (Version 1's `scopes`, a list of every scope offered, is still read, as `scopes.all`.) `openapi` is a read needing `scopes.read`, `openapi_public` one that works signed out, `openapi_write` one needing `scopes.write`, each `{"api", "operation", "args": {"params"?, "body"?}}`; `openapi_upload` is a signed-out upload (`args.files`, section 5.2) and `openapi_propose` a signed-out write that proposes an operation naming what was uploaded as `${upload_id}` (scenario OU); `mcp` is `{"api", "tool", "args"}`; `prompts` are messages to the Company's agent: `hello` (any reply), `sign_in` (one it answers with `sign_in_required` when signed out), `operation` (one it answers with a proposed operation when signed in); `otp_account` is an account whose Mediated Sign-In asks for a one-time code; `web_page` is the page a browser join returns to (scenario W), which the runner sets to the Company's home page, `https://<domain>/`, when the fixture names none.

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
- A value a step's params take from the fixture may itself carry references, such as `openapi_propose`'s `${upload_id}`; they are resolved, once more, when the step runs.
- `runner` operations: `first` (`{"of": [references]}`: the first that names something other than null, resolved without failing on one that names nothing; for a result one of two steps saved, an `api` answer or the `approve_op` of a held write), `wait` (`{"ms"}`), `fetch` (a raw request through the proxy, for one-sided probes; it carries `X-Interop-Probe` and no check judges it) and `assert_trace` (a predicate over the recording so far: `request_seen`, `nonce_retry`, `revoked`, `refresh_rotated`, `retry_after_respected`, `browser_joined`, `confirm_repeated`, `client_fetched`, and the harm oracles below). `browser_joined`: a browser join was answered 303 with a cookie (its result says whether the browser carried the cookie to `return_to`); inapplicable when the Company lists no `web.browser_session_endpoint`. `confirm_repeated`: an operation was confirmed at least twice and every answer was a success with the same `confirmation`; inapplicable without a second confirm. `client_fetched`: before granting the first Session, the Company fetched the agent's `client_id` document and the `jwks_uri` it names, holding the key that signed the Session assertion (agents' keys are new in every cell, section 5.1); inapplicable when the Company fetched nothing of the agent's, as when it registers agents ahead of time (4.1's MAY). A predicate with nothing to judge (no nonce was ever asked for) makes the cell `unsupported`.
- **Harm oracles** (adversarial scenarios): `assert_trace` predicates that check the attack did no harm. `no_request_to {host}` and `token_not_sent_to {host}` fail if the honest side reached, or leaked a token to, a sink host; `performed_at_most_once {path, method?}` fails on a second 2xx for a write; `no_2xx_after {path?}` fails if a replayed (injected) request was accepted; `no_secret_in {value | values}` fails if a planted canary or an issued token appeared in an outbound request. Injected exchanges (section 3) are skipped where an honest request is judged, and judged where the replay or the sink is.
- **The attack-observed precondition:** `assert_trace {check: "attack_observed", path?, method?, status?, injected?, body_contains?}` must find the attack in the recording. If it doesn't, the cell is `error` with blame `harness` (an attack that never happened proves nothing), the way a predicate with nothing to judge is `unsupported`.
- **Credential replays:** YR and YD use `attack_observed` with `replay: "assertion"` or `"dpop"`. Evidence must show an accepted Session grant followed by reuse of that exact credential, with the other assertions/proof fresh and their stable claims unchanged. The adversarial agent completes bounded nonce negotiation before freezing the accepted credential; setup failure is `error`, never a Company refusal. `replay_rejected` judges the observed replay: HTTP 400 `invalid_grant` for the Session assertion, or `invalid_dpop_proof` for DPoP. An accepted replay or unrelated server error fails. A replay answered only with a nonce challenge is `unsupported`: it establishes no replay-cache behavior. The refused attack is never automatically retried with a replacement credential.
- **Client audience mutation:** YA uses `attack_observed` with `mutation: "client_audience"`. It requires an accepted Session baseline and a subsequent request with only the client assertion's audience changed, apart from fresh one-shot claims. The Session assertion and DPoP proof stay fresh, the proof uses the accepted nonce, and the endpoint, client, signing header and other stable claims stay unchanged. `audience_rejected` requires HTTP 400 or 401 `invalid_client`; a nonce-only challenge is `unsupported`, an unrelated refusal or success fails, and missing setup/evidence is a harness error.
- **Adversarial fields:** `"adversary": "company" | "agent" | "network"` marks the side that misbehaves (`network` is the fault-injection proxy). `"faults"` is the proxy's fault list (section 3). `"permitted_by": "N10"` names a draft requirement that permits the attack, so a failure is the spec's, not the honest side's (section 9, rule 0). An `arm` step (an agent or Company op) arms the attack before it is sprung.
- A step whose operation the adapter answers 501 ends the cell as `unsupported`, unless the step is `"optional": true`.
- `"when": "${name.path}"` runs a step only when the reference names something other than null or false; otherwise the step is recorded as skipped. It is for steps one side's design needs and another's doesn't (approving a held write, section 5.2).
- The scenarios are the files in `interop/scenarios/`; [interop-testing.md](interop-testing.md#scenarios) lists them by area. The five added last were named there before they were written, so each is defined from the draft section it targets:
  - `H` (7.7 to 7.9): a conversation, a handoff answered with `status` and `responder`, the Company's `staff_join`, then a read showing a Company message with `sender: "human"`.
  - `DC` (7.3, 7.8, 7.10, 7.12): a conversation, then a Direct Conversation under it (`send` with `parent_conversation` and `sender: "human"`), a reply in it, the parent refusing a message with `direct_conversation_open`, the User's words, `close`, and the parent taking a message again.
  - `W` (4.2, 5): a signed-out Session, then `web_join` with the fixture's `web_page`; `browser_joined` and the browser checks judge the wire.
  - `O2` (Ops 5.2, 6): `O`, then `confirm_again`; `confirm_repeated` and `company.confirm-repeated` judge the second answer.
  - `CM` (4.1, 4.2): a signed-out Session, then `client_fetched`; the validator judges the agent's documents and `company.metadata-fetch-credentials` the fetches.
- `readings` lists the section 7 questions the scenario depends on, which attribution rule 3 considers when the trace shows one of them mattered; `live: true` marks scenarios the live lane may run.

## 7. Readings

The open questions whose answers change the wire format. An adapter declares its reading; the runner checks the declared reading against the trace.

| Id | Question | Values |
| --- | --- | --- |
| S1 | Client assertion `aud` | `issuer`; `token-endpoint` (the token endpoint, at the device and revocation endpoints too); `endpoint` (the endpoint the assertion is sent to); `either` |
| S2 | Assertion `typ` and lifetime | `jwt-60s` (`typ: "JWT"`, at most 60 s); `lenient-120s` (any `typ`, at most 120 s); `lenient-300s` (any `typ`, at most 300 s); `any` |
| S3 | Metadata location for an issuer with a path | `insertion`, `append`, `either` |
| S4 | `scope` on a signed-out Session request | `omit`, `poppy-read`, `either` |
| S23 | DPoP nonce scope | `per-origin`, `per-company` |

Our own adapters' readings, and why we chose them, are in [readings.md](readings.md).

## 8. Checks

After each cell the runner checks the recording, independently of either side's opinion.

- Discovery documents and client metadata go through [`src/validator/`](../src/validator).
- Trace checks over each exchange, named with the mock Company's violation ids (`test/mock-company/violations.ts`) where one exists: assertion `typ`, `kid`, lifetime and `jti` reuse; DPoP `htu`, `htm`, `ath`, `iat` and `jti` reuse; tokens in URLs; a Session Token sent to a host the Company didn't list; redirects followed with credentials.
- Browser joins (5), by the mock's ids and bases: the browser assertion goes in a form POST's body, never the URL (`browser-assertion.in-url`, MUST), with `typ` `poppy-browser+jwt`, `iss`, `iat` and `exp` at most 60 s apart, `aud` the endpoint it went to, a fresh `jti`, and `return_to` HTTPS on the Company's domain.
- Company-side checks, prefixed `company.`: `WWW-Authenticate` on 401, `Retry-After` on 429, OAuth error bodies, `iss` on authorization responses, SSE event ids, and the shape of a read of events and of a send with `wait`, which must carry `events`, `cursor`, `has_more`, `status` and `responder` (7.5's MUST; under 7.3 a send with `wait` answers as a read would). And, each with its basis:
  - `company.browser-session-response` (Rule, 5): a join the Company accepted (2xx or 3xx) answers 303 to `return_to` and sets a cookie; a 400 refusal isn't judged here.
  - `company.browser-cookie` (MUST, 5): that cookie is `Secure` and `HttpOnly`, and not `SameSite=Strict`.
  - `company.handoff-response` (Rule, 7.9; 7.7's MUST): a handoff the Company accepted answers 202 with `status` and `responder`.
  - `company.direct-parent-open` (Rule, 7.10): while a Direct Conversation is open (from the Company's 2xx to a start with `parent_conversation_id` until a close of either, or a `direct_closed` event the agent read), a message or handoff to its parent gets 409 `direct_conversation_open` naming it.
  - `company.confirm-repeated` (Rule, Ops 5.2; Ops 6's MUST): a confirm sent again for an operation the Company already answered with a confirmation gets that operation back with the same `confirmation`, not an error (401, 403 and 429 aside, which concern the token, its scopes or a limit).
  - `company.metadata-fetch-credentials` (Guides, "Fetching metadata safely"; a warning): the Company's fetch of a `client_id` document or key set carries no cookie, `Authorization` or `DPoP`.
- An agent's declared readings of S1, S2 and S4, checked against what it sent, as `reading.<id>` warnings. S1 is checked at every endpoint a client assertion goes to (token, device authorization, revocation). The runner finds server metadata wherever either S3 reading puts it (inserted before an issuer's path or appended after it).
- Refusals a Company's declared readings explain, as `reading.<id>.refused` warnings: an OAuth request answered `invalid_client` or `invalid_grant` that carried a client assertion `aud` other than the one the Company's S1 reading wants at that endpoint, or, when the Company reads S2 `jwt-60s`, an assertion without `typ: "JWT"` or living over 60 s (`lenient-120s`, `lenient-300s`: living over 120 s or 300 s). They judge neither side; attribution reads them as the evidence rule 3 needs (section 9).

Each check reports `{id, side, severity: "error" | "warning", basis, exchange, detail, source}`, and its basis sets its severity ([conformance-levels.md](conformance-levels.md)):

- **Error.** A MUST, an RFC's MUST or a normative rule without a key word, broken. Only errors fail a cell.
- **Warning.** A SHOULD, the Guides, or our reading of an open question. For example: S2's `typ`, `kid` and lifetime; S1's array `aud`; `token.unlisted-host` (N10); `redirect.credentials-followed` (the Guides). A reading is tentative: a failure it explains is the spec's.

A trace check that shares an id with the mock rests on the mock's basis. A Company adapter's `GET /violations` lists every check it recorded, with its `basis` and `level` (`failure`, `warning` or `tentative`; [spec/grounding.md](../spec/grounding.md#mock-company-checks)). The runner makes a failure an error and anything else a warning, and treats a record with no known basis as a failure. Both profiles of our mock report everything.

## 9. Results and attribution

A run writes `interop/results/<run>/results.json`:

```json
{
  "interop": 1,
  "run": "2026-10-11T12:00:00Z",
  "spec": "Personal Agent Protocol Draft 0.1",
  "implementations": [{ "name": "pda", "role": "agent", "commit": "850860c", "readings": {} }],
  "cells": [
    {
      "agent": "pda", "company": "pda-mock", "scenario": "SD",
      "outcome": "pass" | "fail" | "unsupported" | "error",
      "blame": "agent" | "company" | "spec" | "harness" | null,
      "rule": "adversarial" | "violation" | "warning" | "grid" | "reading" | "unattributed" | null,
      "steps": [{ "actor", "op", "ms", "ok", "error"? }],
      "checks": [...],
      "har": "SD/pda__pda-mock.har",
      "flaky": true,
      "attempts": [{ "outcome", "reason"?, "har" }]
    }
  ],
  "flaky": [{ "agent", "company", "scenario" }],
  "staleKnown": [{ "agent", "company", "scenario", "issue", "reason" }],
  "levels": { "failure": 12, "warning": 340, "tentative": 95 }
}
```

- `pass`: every step and expectation held and no check reported an error. Warnings don't fail a cell. `levels` counts the interop cells' checks by level (failure, warning, tentative), and the console and report print it.
- `error`: the harness failed (a container didn't start, an adapter crashed); blame `harness`.
- A cell also carries `reason` (why it didn't pass, and what decided its blame) and `known` (a known failure's issue). The run carries `lane`, on the local lane `isolation` (the internal network's name and the egress probe's outcome, section 3), and each implementation its manifest's `relaxations`.
- **Retries.** A cell that fails or errors runs once more, after both adapters are reset again as for any cell (`--no-retry` turns this off; a cell whose implementation never started isn't retried). The cell records both runs in `attempts`, and the first run's HAR stays beside the second's (`SD/pda__x.attempt2.har`). A cell that passes the second time is a pass with `flaky: true`: it is listed apart, in the console and the report, doesn't fail the run and never matches a known failure. One that fails again is recorded as its second run.

A cell is a **security cell** when a side is an adversarial implementation, or its scenario names an `adversary` or a `faults` list. Security cells go in a separate security grid in the report, never count toward the interop pass rates, and never stand in as grid references (rule 2).

Attribution, applied in order, labels each failed cell with the rule that decided it:

0. **adversarial (applied first, for a cell with an adversarial side):** the adversarial side's violations are expected, so they don't count against it. The cell **passes** when the honest side refuses (the expected `poppy_error`, or status 0 for the agent's own refusal) and no harm oracle fires. A failed cell is blamed on the honest side with rule `adversarial`, or on the `spec` (still rule `adversarial`) when the scenario names a `permitted_by` the draft hasn't closed. A Company's recorded violation of an injected or adversarial request is a warning, not an error. (A network-fault cell has no adversarial side and falls through to the rules below; it is still a security cell.)
1. **violation:** checks found errors on one side only. An error the Company recorded that is exactly a declared reading difference is not counted. That is a check belonging to a section 7 question (S1: `client-assertion.aud`, an RFC check) where the two sides' declared readings of that question are incompatible; a cell whose every error is such a check goes to rule 3 at once. The S2 checks (`client-assertion.typ`, `.kid`, `.lifetime` and the same for `session-assertion`) rest on our reading, so they are warnings and go to rule 1b. A strict Company refusing a typ-less assertion from an agent that declared S2 `any` is the spec's open question; an agent that declared `jwt-60s` and sent no `typ` broke its own reading (rule `warning`). A cell with no one-sided errors whose trace has a `reading.<id>.refused` check (section 8) also goes to rule 3 at once when the two sides' readings of that question are incompatible. A Company that records no violations shows the same open question this way: its device endpoint answers `invalid_client` to an `aud` its S1 reading doesn't accept, from an agent that declared another reading.
1b. **warning, and readings below a failure:** with no error to decide the cell, a check the Company recorded at a lower level does. If it rests on our reading, the cell is blamed on the `spec` (rule `reading`). The exception is when both sides declared compatible readings of that question and the agent sent otherwise: then rule `warning` blames the agent. If it rests on a SHOULD or the Guides and is recorded on one side only, rule `warning` blames that side. Departing from a recommendation is not a violation, so the blame is at warning level. The runner's own trace and validator warnings are passive observations, not a Company's refusal, and decide nothing here.
2. **grid:** the same agent passes this scenario against the reference Company (`pda-mock`, the mock with its S2-lenient settings; `pda-mock-strict` is the same mock with strict assertions) but this Company fails it with every agent that ran it: blame the Company. Or this agent fails it with every Company it ran against, while this Company passes it with another agent: blame the agent. Unsupported and errored cells don't count.
3. **reading:** the two sides declare incompatible readings of a question the scenario lists in `readings`, or that one of the cell's error checks belongs to (rule 1), and the trace shows that question mattered: a `reading.<id>.refused` check (the Company refused what its reading doesn't accept) or a Company-recorded error of that question. Blame `spec`. Declarations that merely differ are not evidence: poppy-demo × pda-mock fails D on poppy-demo's issuer-origin rule, though the two read S3 differently, and without evidence the cell goes on to rule 4. (A `reading.<id>` warning isn't evidence either: it says the agent sent something other than its own declared reading, so the declared difference wasn't what went over the wire.) Compatible means equal, or `either` on one side; for S2 a Company accepts an agent reading at least as narrow as its own (`jwt-60s`, then `lenient-120s`, then `lenient-300s`, then `any`), so a Company reading `jwt-60s` is incompatible with every wider agent reading, one reading `lenient-120s` with `lenient-300s` and `any`, and one reading `lenient-300s` with `any`, and for S23 a Company reading `per-origin` only with an agent reading `per-company`.
4. **unattributed:** none of the above.

A failed or errored cell that matches an entry of `interop/known-failures.json` (`{"version": 1, "failures": [{agent, company, scenario, blame, checks?, errors?, issue, reason}]}`) is shown with its issue link and reason. Any of `agent`, `company` and `scenario` may be `"*"`, for any: one root cause is one entry (`{"agent": "pi-poppy", "company": "*", "scenario": "SE", "blame": "agent", "errors": ["invalid_session"]}`). The rest says what the failure looks like, so that a different failure in a covered cell is still unexpected:

- `blame` (required): the side attribution blames, `agent`, `company`, `spec` or `harness`, or `null` for unattributed. The cell's must be the same. Where one root cause is blamed differently across the cells an entry spans (rule 2 can decide a cell its neighbours leave unattributed), `blame` is a list, and the cell's must be one of them.
- `checks`: every error check the failure may show (trace, validator and Company-recorded ids). Each of the cell's error checks must be in the list; warnings don't count. Absent, the cell may have none.
- `errors`: the codes its first failed step may show (`failureCode` in `interop/runner/attribution.ts`): the Poppy error of a refusal (`invalid_grant`), `expect <path>` for an expectation that didn't hold (`expect outcome.poppy_error`), the text before the first colon of any other step error, or `error` for a cell that errored before any step. A cell that failed only on its checks has no code, and needs none. Absent, the cell may not have one.

An entry matches a cell when it covers the cell and all three hold. When several entries match, the one with the fewest wildcards wins, then the first in the file. A covered cell that matches no entry is unexpected, and its `reason` names the entry it missed and what differed. The runner exits 1 when any failed or errored cell isn't a known failure, or when a known failure is **stale**: it matched no failed or errored cell (fixed, changed, or wrong), though the run could judge it. A run judges an entry when each field it names matched a cell that ran and each `*` spans a dimension the run covered whole (every honest agent, every honest Company or every scenario of the lane without an `adversary` or `faults`; the adversarial implementations and scenarios run apart, section 13, so a full grid without them still covers its dimensions), so a partial run (`--agents pda --companies pda-mock`, or `--scenarios D`) never flags an entry for cells it didn't run. A wildcard entry is stale only when no failed cell it covers is left, even where a more specific entry is the one attached to those cells. Stale entries are listed in the console, in `staleKnown` and in the report.

The runner also writes `index.html`: the grid, one table per scenario with agents as rows and Companies as columns, each cell linking to its steps, checks and HAR.

## 10. Lanes

- **Local:** every implementation in a container, on the private, internal network, with no way to the internet (section 3, Isolation). The default.
- **Live:** public deployments, signed-out scenarios only (`D`, `S0`, `ML` (MCP listing, no tool call), `N`, `C` where the Company allows signed-out conversations), at most one request a second per Company. The live lane uses real names and public TLS, and only our agent, which needs the internet, so the runner keeps it apart from the local lane: it creates no internal network and runs our agent alone, on Docker's default bridge with its control port published, and no third-party image. It first ran on 13 October 2026, against `alpine-retail-live` with its developer's approval. A live Company has no adapter, so it is never reset, its hooks answer 501 (an optional hook step is skipped), and it gets a fixture of one greeting. Companies are registry entries with `url` and an expected `protocolVersion` (legacy entries default to 0.1). A discovered version mismatch stops the cell before Session authentication; scenarios are those marked `live` that need no Company hook; nothing is recorded, so only steps and expectations decide a cell. Agents pace themselves from `INTEROP_PACE_MS`.
- **The live lane's identity.** A public Company fetches the agent's `client_id`, so the live lane needs one on the internet. Our deployed Worker serves a separate interop test client at `<PUBLIC_ORIGIN>/poppy/interop/client.json` with its public keys at `/poppy/interop/jwks.json`, only when the deployment sets `INTEROP_LIVE_JWKS`. It has its own key, never the real client's, and no redirect URI. Its private key stays on the runner's machine, in the gitignored `interop/.live-identity.json` that `scripts/interop-live-identity.mjs` writes. When that file exists, the runner passes the `client_id` and the key to our own agent's container (`INTEROP_LIVE_CLIENT_ID`, and `INTEROP_LIVE_KEY` through the docker CLI's environment, not its arguments), and the agent signs as that client. No other implementation gets them, and the local lane never uses them. Without the file the agent names itself at `pda.agent.interop.test`, which no public Company can fetch: a Company that checks client metadata refuses `S0`, `N` and `C` with `invalid_client`, and only `D` says anything. The runner says which identity it is using before it starts.
- **The live lane never runs adversarial cells.** Adversarial implementations and scenarios with an `adversary` or `faults` list are dropped from the live lane: we never attack a public deployment, whoever's it is.

## 11. One-sided vectors

Hardening cases that need no peer (SSRF, duplicate JSON members, redirects on `client_id`, malformed documents) stay out of the grid, as one-sided tests: our validator's fixtures in `test/validator.test.ts` and the mock Company's tamper rows in `test/mock-company.test.ts`. Version 1 of this document also exported both as language-neutral vectors in `interop/vectors/`, in Datalayer's schema (`id`, `kind`, `role`, `requirements`, `check`, `input`, `expect`), to seed a shared vectors repository. That repository was never made and nothing consumed the files, so they and the tests that kept them current were removed. The other direction remains: `interop/vectors/datalayer/run.mjs` runs Datalayer's cases, in that schema, against our client and validator. `interop/vectors/validators/run.mjs` compares our validator with two independent validators over the same documents, theirs in Docker with no network.

## 12. Versioning

This document is version 1; every JSON body above carries `interop: 1` or `version: 1`. A change that breaks an adapter increments it, and the runner supports the previous version for one release.

## 13. The own-project rule

Adversarial testing (the malicious implementations and the fault-injection proxy of [`docs/adversarial-interop.md`](adversarial-interop.md)) is restricted to implementations this project owns, to control risk and blast radius.

- An adversarial or faulted cell runs only on the **local** lane, and only when every honest side is `owner: "self"`, with one exception: `evil-company` may attack any agent, our own or another project's built at its pinned commit, when the scenario has no proxy faults. The owner approved that exception on 13 October 2026. The runner refuses any other adversarial cell (it marks it `error`, blame `harness`, with the reason) and never runs one in the live lane. The usable cells are therefore `evil-company` × every agent, `evil-agent × pda-mock`/`pda-mock-strict`, and proxy faults over `pda × pda-mock`/`pda-mock-strict`.
- **No flag lifts the rest.** Running another adversarial implementation against someone else's, or anything adversarial in the live lane, is a code change, which goes through the disclosure process in [`SECURITY.md`](../SECURITY.md). A failure in an adversarial cell may be a vulnerability in someone's project, so its results stay in the gitignored `interop/results/` and go to its maintainers privately before anything about them is committed, and a spec-permitted attack goes to the authors as an N-numbered issue.
- `--image-tag <tag>` (default `latest`) builds and runs under a tag, so an adversarial run with `--image-tag adv` never overwrites the `:latest` images a full grid run is using. It is the only way to keep a side build of our images: don't `docker tag` them by hand. A side tag costs disk until it is removed (`docker image rm poppy-interop/<image>:<tag>`); the runner never removes images.
