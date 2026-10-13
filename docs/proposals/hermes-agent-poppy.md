# [Feature]: Poppy (Personal Agent Protocol) support: a standalone plugin, plus two generic plugin seams it needs

> **Draft for a GitHub issue on [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), using its `feature_request.yml` template. Not posted.**
>
> - Hermes was researched against `main` at `97a9ae8e` (11 October 2026) and rechecked at `6e7b83a2` (13 October 2026), 542 commits later; paths are relative to that tree. Every cited file, hook and quote is still there. What moved: catalog rule 10 (a plugin's dependencies now install inside Hermes's exact pins), and `hermes plugins validate` now warns on imports of core modules the plugin docs don't name, `tools.url_safety` among them. The linked issues were rechecked the same day: #75576 is closed as completed, #130295 as not planned, and the other four are open. Facts about Poppy, Datalayer's SDK and the interop grid were last brought up to date on 13 October 2026, from adewale/dpa's docs.
> - Items marked *(unverified)* are inferences from code or docs that I haven't run.
> - CONTRIBUTING.md suggests GitHub Discussions for design proposals, so this may fit better there, with a short linked issue for the two seams.

## Problem or Use Case

[Personal Agent Protocol](https://personalagentprotocol.org/) ("Poppy", Draft 0.1, published 9 October 2026) is an open protocol for a person's own agent to deal with businesses. The protocol's site names no author and speaks as "we" ("So we built Personal Agent Protocol"); [Sierra's announcement](https://sierra.ai/blog/poppy) says the work is led by Sierra and Meta, with 35 named design partners. A business ("Company") publishes `/.well-known/poppy.json`, and a personal agent can then:

- start a signed-out Session as itself;
- sign the person in on the Company's own page (Direct), with a link and code (Device), or by forwarding credentials (Mediated), with scopes the person chooses and can revoke;
- talk to the Company's agent, and call its OpenAPI or MCP APIs with DPoP-bound tokens;
- receive proposed **operations** (an order, a refund, a booking) that the person approves before anything happens.

Today Hermes users who want their agent to act at a business can browse anonymously, or hand over a password or browser profile with full access. Poppy defines a middle ground: scoped and revocable.

Why now:

- Draft 0.1 is the only version, and its open-topics page says "Every part of it can still change, including the parts the specification already covers" and that "other gaps will come up as people implement the protocol."
- adewale/dpa's survey (`docs/implementations.md`, last updated 13 October 2026) lists 14 implementations, each "at most a few days old". The only one in Python is Datalayer's SDK; the other Python Poppy projects it found are two validators. It found no Poppy issue, pull request or proposal in Hermes Agent or the eight other agent frameworks it searched; the one framework that had one, OpenAgents, closed it as not planned. A search of Hermes's issues, pull requests and Discussions on 13 October found none either.
- Hermes's experience would reach the spec while it can still change, particularly what a self-hosted agent needs to host its identity, which Hermes already met with MCP CIMD (#75576, #130295).

## Proposed Solution

Following CONTRIBUTING.md ("Third-Party Product Integrations: Ship as a Standalone Plugin"; "These do not land in this repo"; "widen the generic plugin surface"), the proposal has two parts:

- a **standalone plugin**, `hermes-poppy`, in its own repository, installable with `hermes plugins install owner/repo`, and later offered to the catalog;
- **two small generic seams in Hermes** that it can't work without, each useful beyond Poppy.

### The plugin

**Packaging and dependency.**

- `plugin.yaml` declares `provides_tools`, `provides_hooks`, `config_schema` (a signing key as a `secret`), and `python_dependencies`.
- The plugin uses Datalayer's [`personal-agent-protocol`](https://github.com/datalayer/personal-agent-protocol) Python SDK (BSD-3-Clause, on PyPI). Our grid runs 0.17.0 (commit `00216eb`, 13 October). PyPI had 0.20.0 by 10:32 UTC that day, which our grid hasn't run: eleven releases, 0.10.0 to 0.20.0, came out on 12 and 13 October. At 0.10.0 its README claimed Draft 0.1 plus the Operations extension v1. An earlier README listed Device and Mediated Sign-In, Account Token exchange, MCP Bearer, SSE, handoff and close, and Operations as not built, though our grid was already running its Device Sign-In, SSE and Operations code at 0.6.0 (adewale/dpa `docs/implementations.md`). From 0.10.0 to 0.17.0 the agent modules our adapter calls didn't change.
- Our interop adapter drives the Python client through 28 of the grid's 30 interop scenarios (all but DP and OU, which it doesn't claim): discovery, Sessions, Direct, Device and Mediated sign-in, Account Tokens, conversations with SSE, handoff and close, OpenAPI and MCP, and Operations; the adapter also calls its browser-Session join. Against twelve Companies on 13 October it passed 201 cells and failed 8: the Device Sign-In nonce gap below (3), the handoff and close answers at our two mocks (4, also below), and SO at Tipping Co, a reading the draft leaves open (spec issue S1).
- `PyJWT[crypto]` and `cryptography` are already core Hermes dependencies (`pyproject.toml`), so nothing heavy is added for JOSE. Catalog rule 10 (`plugin-catalog/README.md`, changed on 12 October) installs a plugin's dependencies inside Hermes's exact pins. The SDK asks for `pyjwt[crypto]>=2.13`, `httpx>=0.27` and `pydantic>=2.10`, which Hermes's pins (2.13.0, 0.28.1, 2.13.4) meet; it also brings typer, PyYAML and Datalayer's `datalayer-reactor`. With eleven releases in two days, the plugin needs the tight floor and upper bound that rule asks for.
- The SDK takes the HTTP client it is given, and its URL-safety policy is a replaceable contribution (`pap.urlSafetyPolicy`); our adapter replaces both. The plugin would pass Hermes's `create_ssrf_safe_async_client()` (`tools/url_safety.py`). Since 12 October `hermes plugins validate` warns on that import, because the plugin docs don't name `tools.url_safety` (`hermes_cli/plugin_validate_private_imports.py`). Either Hermes documents it for plugins, or the plugin uses the SDK's own opt-in `create_resolving_client` (0.16.0 and later), which resolves each Company host, refuses private addresses and pins the connection.

**Tools.** They are registered with `ctx.register_tool` in a `poppy` toolset, so `hermes tools` and `platform_toolsets` control them. They take a `domain` and return JSON, and never take or return tokens, keys, codes or credentials.

| Tool | Does |
| --- | --- |
| `poppy_discover(domain)` | Validates `poppy.json` and the issuer's RFC 8414 metadata. Returns the organization, sign-in types and scopes, APIs, Company agent and extensions. |
| `poppy_sign_in(domain, scopes, reason)` | Uses a stored Account Token that covers the scopes. Otherwise it starts Direct sign-in (a link) or Device sign-in (a link and code), sent to the person, and returns "waiting for the person". A signed-out Session starts on first use. |
| `poppy_status(domain?)` | Sessions, accounts and granted scopes, open conversations, and every open operation and approval. No token values. |
| `poppy_message` / `poppy_read` / `poppy_handoff` / `poppy_close` | Conversations with the Company's agent. The message id is fixed per call, so a retry never posts twice. |
| `poppy_api_describe` / `poppy_api_call` | OpenAPI operations, with a DPoP Session Token. A `multipart/form-data` operation takes files by reference to something the person attached, never as bytes in a tool argument. |
| `poppy_mcp_list` / `poppy_mcp_call` | The Company's MCP server, with a Bearer token minted for its `url` only. |
| `poppy_operation(domain, id)` | Reads a proposed operation. |
| `poppy_confirm(domain, id)` / `poppy_cancel(domain, id)` | Asks to confirm or cancel. Always gated by the person (below). |
| `poppy_sign_out(domain)` | Revokes the Account Token. It only reduces access. |

**Company content is untrusted.** Company messages, API results and MCP tool descriptions go back as data, in the same `<untrusted_tool_result>` framing Hermes gives MCP and browser results (`agent/tool_dispatch_helpers.py`), *(unverified: whether a plugin can opt into it)*. Company MCP servers go through `poppy_mcp_call`, not `mcp_servers`, so the Company's tool descriptions never become first-class tools.

**Approvals.** A `pre_tool_call` hook returns `{"action": "approve", ...}` for `poppy_confirm` and `poppy_cancel`, and for the writes listed below. That reaches `request_tool_approval` (`tools/approval.py`): "the SAME human gate as Tier-2 dangerous shell patterns … so the LLM cannot skip it", with Telegram buttons, `/approve` and `/deny` in the gateway. Any non-interactive context without an approval bridge fails closed. Cron follows `approvals.cron_mode`, which is `deny` by default; an operator who sets `approve` would let a cron job confirm an operation, so the plugin should refuse `poppy_confirm` and `poppy_cancel` in cron itself.

- The reason text is built by plugin code from the stored operation: the Company's `summary` **verbatim**, its verified `organization.domain`, the account and the terms.
- `rule_key` includes the operation id and revision, so an "always" can't approve a different operation.
- Asks for Hermes: a way to offer only once/deny for these, and a review of whether `register_approval_transport` is the better fit.

Having the Operations extension doesn't make every write at a Company safe to send, because a Company may use operations "for some actions and not others" (Operations 1), and the draft defines no marker for the writes that propose one (spec issue S22). The rules our agent follows:

- An API write goes straight to the Company only when the Company has the Operations extension **and** its own description says that call proposes an operation: an OpenAPI `202` whose schema has `operation`, poppyseed's `x-poppy-operation: true`, or an MCP tool whose output schema has `operation`. The person then approves the Company's proposal. Any other write waits for the person's approval of exactly what will be sent.
- Sending a file the person attached always waits for them, at every Company. The Operations extension covers what a Company does, not what the agent sends it.
- Every website form submission waits for approval, because the draft gives website actions no approval step (spec issue N43).

In our agent the model has no confirm or cancel tool at all; only the person's card, or a standing permission they set, can approve. The gate above gives the same guarantee for a model-callable tool, as long as the plugin sends a confirm only after `request_tool_approval` returns the person's approval. If standing permissions (Operations 5.1) are added later, ours cover a proposal only when the Company's summary begins with the permission's action and every term is an amount within its limit, a date, or one of the record ids in the draft's example (`order_id`, `item_id`, `replacement_sku`).

**Whose state.** Hermes's trust model is a single tenant per profile ("Within the authorized set, all callers are equally trusted", SECURITY.md §2.6), so the Poppy "User" is the **profile**. Each profile keeps:

- a random User ID per Company issuer;
- a DPoP key per Company;
- Account Tokens.

Under `gateway.multiplex_profiles`, `profile_routes` already map people to profiles. In shared group sessions, sign-in links and operation approvals go to the profile owner's DM, not the group.

**Background reading.** Company replies arrive asynchronously. The first version reads on demand (`poppy_read` with `wait`). A background reader would need a long-lived task per profile *(unverified: which plugin surface, if any, fits; cron is the obvious fallback)*.

### Seam 1: a credential route for plugin-owned OAuth grants

Catalog rule 11 (`plugin-catalog/README.md`) says a plugin "never refreshes, rotates or writes OAuth tokens", and "if Hermes has no route for a credential a plugin needs, ask for one". A Poppy plugin is its own OAuth client with its own grants, so it must store and rotate an Account Token per Company and account, and keep a signing key.

Today:

- `plugin_data_dir` (`plugins/plugin_storage.py`) says "Secrets are deliberately NOT part of this convention".
- `.env`, `auth.json` and `mcp-tokens/` are plaintext with 0600 permissions.
- Only the browser vault (`agent/vault_store.py`) is encrypted at rest.
- Secret sources (`agent/secret_sources/base.py`) are read-only and fetched once at startup, so they can't hold a token that rotates.
- `hermes_cli/auth_oauth_pkce_plugin.py` is for model-provider plugins: a public client, with a loopback redirect, which Poppy forbids (Seam 2).

**Ask:** a profile-scoped `ctx` method to put, get, rotate and delete opaque secrets, sealed like the vault and never logged or shown to the model. Alternatively, a ruling that rule 11 allows a plugin to hold grants it obtained as its own client. #133512 asks for a similar seam for provider OAuth.

### Seam 2: a public HTTPS route, or an honest Device-only mode

Poppy 4.1 says `client_id` is the URL of the agent's metadata document, and that `jwks_uri` and every `redirect_uri` "MUST be HTTPS URLs on the same domain as `client_id`". The Company fetches it, and the client authenticates with `private_key_jwt`.

Hermes's existing CIMD (`website/static/oauth/client-metadata.json`, `token_endpoint_auth_method: "none"`, loopback redirects) works for MCP public clients but **can't** be a Poppy identity:

- one shared document would mean one shared private key for every install;
- Poppy forbids loopback redirects.

There is no generic public route today: dashboard plugin routes sit behind auth, and the public-paths list (`hermes_cli/dashboard_auth/public_paths.py`) is fixed. The options:

1. **The person's own origin** (a VPS, Tailscale Funnel, or a Cloudflare Tunnel). Each install gets its own `client_id` and key. This needs a plugin-registerable, unauthenticated, GET-only route for two documents plus one callback. **Ask:** such a seam, off by default.
2. **A static identity host plus Device Sign-In only.** The client metadata and JWKS go on any HTTPS host the person controls, such as GitHub Pages or their domain. Hermes stays on loopback; Device needs no redirect. Hermes already does device flows (`hermes_cli/auth_device_flow.py`, `tools/mcp_oauth_device.py`). No seam is needed, but there is no Direct sign-in and key rotation is manual.
3. **A Nous-run directory** of per-install documents plus a callback relay. The relay sees only codes that are useless without the install's PKCE verifier, client assertion and DPoP key, but the directory becomes a trust anchor, and running it is a product decision.

Some Companies admit only agents they have listed: print-with-poppy keeps an allowlist of `client_id`s (it added ours on 12 October), and poppy-demo's Northstar accepts only its own caller. Whichever option is chosen, the `client_id` has to stay stable for a Company's operator to add it.

## Security and privacy

- **Nothing secret reaches the model.** Tokens, keys, `state`, verifiers, device codes and credentials never appear in tool results, MEMORY.md, USER.md, `state.db` or logs. The plugin registers redaction patterns (`ctx.register_redaction_patterns`) for `Authorization: DPoP`, DPoP proofs and assertions as defence in depth. SECURITY.md is clear that redaction is a heuristic, not a boundary.
- **DPoP keys** are one per User per Company, never published and never shared across profiles (spec issue N35).
- **Token hosts (spec issue N10, rated Critical).** Session Tokens go only to hosts `poppy.json` lists, or hosts under `organization.domain` or a `poppy_domains` entry. An OpenAPI `servers` entry naming another host is refused before any request.
- **Re-fetching discovery.** The draft never says when an agent must fetch and check `poppy.json` and API descriptions again (spec issue N44). Cache each by its HTTP headers, bounded to the Guides' "at least a minute and at most a day", and validate every fetch as fully as the first.
- **SSRF.** All fetches go through `url_safety` (no private addresses, redirects re-checked), and no redirect is followed with credentials.
- **Exact issuer comparison.** Poppy compares issuers exactly (3.2). The trailing-slash leniency requested for MCP in #132233 must not leak into this path.
- **Consent and phishing (spec issue N14).** Consent pages show a name and logo the agent chooses. Hermes's cards and approval text name the verified `organization.domain`.
- **Mediated Sign-In** (forwarding a password) is off by default. Gateways "never collect secrets in-band", so if it's enabled at all it's CLI-only, through the secure prompt. Spec issue N8: Mediated Sign-In has no consent step.
- **Browser Sessions (§5)** use a fresh browser context per Session, never a real-profile browser. Form submissions need approval, as above (N43).

## Interop and testing

I'd offer the plugin a place in the M×N interop harness in [adewale/dpa](https://github.com/adewale/dpa).

**What the harness is:**

- 8 Personal Agents (ours, Datalayer TypeScript and Python, pi-poppy, poppy-demo's caller, adonis-agora, everruns, Tipping Co's) and 12 Companies: ten other projects' (Datalayer TypeScript and Python, pi-poppy's test Company, poppy-demo's Northstar, poppyseed, Ilmer, print-with-poppy, adonis-agora's AuthKit, everruns, Tipping Co) plus our lenient and strict mocks.
- 52 scenarios. 30 test interop between honest implementations. The other 22 are security scenarios: a malicious agent (8), a malicious Company (10) and network faults injected by the proxy (4).
- A recording TLS proxy, on a Docker network with no route to the internet, and per-cell blame by named attribution rules.
- The last full grid (13 October 2026, every pin at its upstream's head; `docs/interop-results/README.md`): 8 agents × 12 Companies × 30 interop scenarios, 2,880 cells: 1,000 pass, 273 fail, 1,607 unsupported, 0 errors. Every failure is a known upstream or spec failure with a written cause. The same run's security grid passed all 32 of its cells. Since then our agent also passes XR and XT, two malicious-Company scenarios that try to keep it checking for ever (spec issue N46).

**What joining takes:**

- A registry entry with a pinned commit.
- An adapter (`docs/interop-spec.md` §5.2) that serves the identity on port 8080 and a control API on port 8081, driving the plugin's protocol code, never a model.

Our Datalayer Python adapter is a ready template. adewale/dpa also has a second Poppy client in Python, written from the draft for a Hypothesis stateful test of our mock Company (`test/hypothesis/`), which shows one way to drive a Poppy Company from Python tests.

The malicious-agent and fault scenarios run only against our own Companies. Since 13 October the malicious Company may also run against other projects' agents, built at their pinned commits in our own containers and never against a live service (adewale/dpa's SECURITY.md, point 5). The plugin would be no exception. Anything the grid turns up in the plugin stays private and goes to its maintainers first, under that SECURITY.md.

**Lessons from the grid that apply directly:**

- **Recovery is the host's job.** The SDK has no automatic recovery. On `invalid_token` or `invalid_session` (including from the token endpoint during renewal), renew, or start a new Session, and retry once. pi-poppy throws there (spec issue N39), and poppy-demo's caller never handles `invalid_session`.
- **A lost code exchange.** If the answer to the code exchange or the final device poll is lost, the Company has issued an Account Token the agent never saw, and the draft has no way to get it back or revoke it (spec issue N45). Abandon that Session, start a new one, and tell the person the sign-in was interrupted.
- **Assertion `typ` and lifetime.** Send `typ: "JWT"`, a `kid`, and a lifetime of 60 s or less. Strict Companies (our strict mock, poppy-demo's Northstar, Ilmer) refuse an assertion without `typ: "JWT"`; Datalayer's Companies (0.17.0) and print-with-poppy allow up to 120 s. The draft states none of this (spec issue S2). Datalayer's Python agent, as our adapter runs it, already sends `typ: "JWT"` and 60 s.
- **Assertion `aud`.** The draft doesn't say what a client assertion's `aud` is at the token, device authorization and revocation endpoints (spec issue S1), so this is a reading. poppyseed, pi-poppy's Company and print-with-poppy accept only the endpoint the assertion is sent to; Tipping Co accepts only the token endpoint, at revocation too; Datalayer's own Companies at 0.17.0 accept the issuer, the token endpoint or the endpoint called. No one value works everywhere. The endpoint called works at every Company in the grid that checks `aud` except Tipping Co, where sign-out fails, and it's what Datalayer's Python agent sends in our grid.
- **Issuer ≠ origin.** The issuer may be on another host or have a path; use RFC 8414 insertion.
- **Optional members.** Accept `null` as absent. Datalayer's Companies still send `result.data: null` on a cancelled operation (spec issue N41).
- **Signed-out operations.** print-with-poppy, a photo-printing store, proposes every order as an operation in a signed-out Session. If that Session ends first, the draft gives no way to finish the operation (spec issue N19); our reading treats `operation_not_found` as final.
- **`wait` is a hint.** A `POST ?wait` may return `working` with no reply; read again. An empty `200` from revocation is success.
- **Bound the checking.** The draft never says how long a conversation may stay `working` or report `has_more`, or an operation stay `in_progress` (spec issue N46). An agent that takes the Company at its word reads every second for ever; ours did until 13 October. Treat `Retry-After` as the least wait, read a busy conversation with nothing new at the idle pace, read an unchanged operation less often the longer it stays so, and cap the pages read per check. This matters most for a background reader.
- **SDK gaps still present at 0.17.0** (`interop/impls/datalayer-py-agent/README.md` and `docs/poppy-issues.md` in adewale/dpa):
  - Device Sign-In polling (`DeviceSignInClient.poll`) sends one token request and never retries on `use_dpop_nonce`, so Device Sign-In fails at a Company that requires DPoP nonces, such as pi-poppy's and our mocks (RFC 9449 section 8; Poppy 4.3). The TypeScript SDK has the same gap. First found at 0.6.0.
  - Resuming an SSE stream at the latest event raises `stream_unavailable` against Datalayer's own Companies, which close a caught-up stream at once. Our adapter doesn't use the SDK's reconnect and reports zero events instead. First found at 0.6.0.
  - The client refuses the answer to a handoff or a close as `invalid_response` unless it carries `conversation_id`. The draft has the Company return only `status` and `responder` (7.9, 7.12), as our mocks do; Datalayer's own Companies add `conversation_id`, so the client passes there.

## Alternatives Considered

- **A skill only.** CONTRIBUTING says "make it a Tool when it requires end-to-end integration with … auth flows". Poppy needs DPoP, signed assertions and sealed storage. A companion skill could still teach when to use it.
- **The MCP client alone.** It covers a Company's MCP server, but not Sessions, sign-in to the person's account, the Company's agent or operations. Poppy uses MCP for one part.
- **The managed connectors** (`tools/connectors/`, `manage_connections`). These are the nearest analogue, but they go through the Nous Portal Tool Gateway per vendor. Poppy is one protocol for any Company, and the agent holds the grants itself.
- **A core tool.** That is ruled out by the footprint ladder in `AGENTS.md`, and isn't needed.

## Feature Type

Other: a standalone plugin, plus two generic plugin-surface seams.

## Scope

- Each seam: Medium (few files, < 300 lines).
- The plugin: Large, out of tree.

## Contribution

- [ ] I'd like to implement this myself and submit a PR. *(Author to decide. The offer below stands either way.)*

## Additional information

**Related issues:**

- #98958: an agent identity and delegation layer for MCP tool calls. Poppy is a published design for that.
- #75576 and #130295: CIMD for MCP OAuth, including the `client_uri` same-origin rejection, which Poppy's same-domain rule mirrors.
- #133512: no public route for a plugin's OAuth.
- #132233: issuer trailing slash.
- #82416: device auth advertised but not used.

**Open questions for maintainers:**

1. Seam 1: a new `ctx` secret store, or the vault extended?
2. Seam 2: an unauthenticated plugin route, or Device-only for now?
3. Is a profile the right "User", including under multiplexing?
4. Can a plugin opt its results into the untrusted-content framing?
5. Can an approval offer only once/deny?
6. Which surface should host a long-lived background reader?

**Phased plan:**

1. **Signed out.** Discovery, signed-out Sessions and conversations, with no seam needed. Interop scenarios D, S0, N, C and CI.
2. **Sign-in.** Device first, with Seam 1 and an identity hosted per option 2. Then Direct with Seam 2, renewal and rotation, sign-out, APIs and MCP. Scenarios SV, SD, R, SE, SO, AO and AM.
3. **Operations** through the approval gate, file uploads, then browser Sessions. Scenarios O, OX and OU (print-with-poppy's signed-out upload and order).

**Offer of help.** I maintain adewale/dpa and am happy to:

- review the plugin's protocol code;
- write its interop adapter;
- run it against the grid;
- carry Hermes's findings to the spec's authors.

**Prior art:**

- [pi-poppy](https://github.com/richardanaya/pi-poppy): an agent extension; note its loopback `client_id` and plaintext secrets.
- [Datalayer](https://github.com/datalayer/personal-agent-protocol): Python and TypeScript SDKs, 0.20.0 on PyPI on 13 October (our grid runs 0.17.0).
- [everruns](https://github.com/everruns/everruns): Rust, signed-out Sessions only so far, with interop tests against pi-poppy and Datalayer (PR #4531).
- [poppy-demo](https://github.com/irvinebroque/poppy-demo).
- [print-with-poppy](https://github.com/spenciefy/print-with-poppy): a photo-printing store whose orders all go through the Operations extension.
- [adewale/dpa](https://github.com/adewale/dpa): a Personal Agent on Cloudflare Workers (one Durable Object per person running Pi with Claude Sonnet 5.5, on an operator-paid demo lane or the person's own Anthropic or OpenAI key), a mock Company that names 148 checks graded by what each rests on (119 failures, 19 warnings, 10 tentative), a validator with 76 messages, and the interop harness. `docs/spec-issues.md` lists 63 problems in the draft, each with a suggested fix: 5 Critical, 13 High, 30 Medium and 15 Low.

**Caveats.**

- Draft 0.1 will change, possibly incompatibly.
- There are few live Companies yet. None of the hosts adewale/dpa's `docs/ecosystem.md` lists on 12 October 2026 is a large business, and none of the launch partners checked on 11 October served a `poppy.json`.
- adewale/dpa's own agent has not yet been verified against a live Company Agent. print-with-poppy added its `client_id` on 12 October, and the live journey there ran as far as the photo upload's approval card. The order hasn't run live, because the store takes real payments, and the store has no conversations, so it isn't a Company Agent check.
- Nothing here has been tested inside Hermes.
