# [Feature]: Poppy (Personal Agent Protocol) support: a standalone plugin, plus two generic plugin seams it needs

> **Draft for a GitHub issue on [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), using its `feature_request.yml` template. Not posted.**
>
> - Researched against `main` at `97a9ae8e` (11 October 2026). Paths are relative to that tree.
> - Items marked *(unverified)* are inferences from code or docs that I haven't run.
> - CONTRIBUTING.md suggests GitHub Discussions for design proposals, so this may fit better there, with a short linked issue for the two seams.

## Problem or Use Case

[Personal Agent Protocol](https://personalagentprotocol.org/) ("Poppy", Draft 0.1, published by [Sierra](https://sierra.ai/blog/poppy) on 9 October 2026, with Meta among its partners) is an open protocol for a person's own agent to deal with businesses. A business ("Company") publishes `/.well-known/poppy.json`, and a personal agent can then:

- start a signed-out Session as itself;
- sign the person in on the Company's own page (Direct), with a link and code (Device), or by forwarding credentials (Mediated), with scopes the person chooses and can revoke;
- talk to the Company's agent, and call its OpenAPI or MCP APIs with DPoP-bound tokens;
- receive proposed **operations** (an order, a refund, a booking) that the person approves before anything happens.

Today Hermes users who want their agent to act at a business can browse anonymously, or hand over a password or browser profile with full access. Poppy is the scoped, revocable middle.

Why now:

- The draft is five days old and asks for implementers.
- About ten implementations exist, all days old. None is a widely used personal agent, and none is in Python except Datalayer's SDK.
- Hermes's experience would shape the spec while it can still change, particularly what a self-hosted agent needs to host its identity, which Hermes already met with MCP CIMD (#75576, #130295).

## Proposed Solution

Following CONTRIBUTING.md ("third-party product integrations … do not land in this repo"; "widen the generic plugin surface"), the proposal has two parts:

- a **standalone plugin**, `hermes-poppy`, in its own repository, installable with `hermes plugins install owner/repo`, and later offered to the catalog;
- **two small generic seams in Hermes** that it can't work without, each useful beyond Poppy.

### The plugin

**Packaging and dependency.**
- `plugin.yaml` declares `provides_tools`, `provides_hooks`, `config_schema` (a signing key as a `secret`), and `python_dependencies`.
- The plugin uses Datalayer's [`personal-agent-protocol`](https://github.com/datalayer/personal-agent-protocol) Python SDK (BSD-3-Clause, on PyPI; 0.8.0 on 11 October), the most complete Poppy client. It covers discovery, Sessions, Direct, Device and Mediated sign-in, Account Tokens, conversations with SSE, OpenAPI and MCP, browser Sessions and Operations.
- `PyJWT[crypto]` and `cryptography` are already core Hermes dependencies (`pyproject.toml`), so nothing heavy is added for JOSE.
- The SDK's HTTP and URL-safety policies are replaceable. The plugin would pass Hermes's `create_ssrf_safe_async_client()` (`tools/url_safety.py`).

**Tools.** They are registered with `ctx.register_tool` in a `poppy` toolset, so `hermes tools` and `platform_toolsets` control them. They take a `domain` and return JSON, and never take or return tokens, keys, codes or credentials.

| Tool | Does |
| --- | --- |
| `poppy_discover(domain)` | Validates `poppy.json` and the issuer's RFC 8414 metadata. Returns the organization, sign-in types and scopes, APIs, Company agent and extensions. |
| `poppy_sign_in(domain, scopes, reason)` | Uses a stored Account Token that covers the scopes. Otherwise it starts Direct sign-in (a link) or Device sign-in (a link and code), sent to the person, and returns "waiting for the person". A signed-out Session starts on first use. |
| `poppy_status(domain?)` | Sessions, accounts and granted scopes, and open conversations. No token values. |
| `poppy_message` / `poppy_read` / `poppy_handoff` / `poppy_close` | Conversations with the Company's agent. The message id is fixed per call, so a retry never posts twice. |
| `poppy_api_describe` / `poppy_api_call` | OpenAPI operations, with a DPoP Session Token. |
| `poppy_mcp_list` / `poppy_mcp_call` | The Company's MCP server, with a Bearer token minted for its `url` only. |
| `poppy_operation(domain, id)` | Reads a proposed operation. |
| `poppy_confirm(domain, id)` / `poppy_cancel(domain, id)` | Asks to confirm or cancel. Always gated by the person (below). |
| `poppy_sign_out(domain)` | Revokes the Account Token. It only reduces access. |

**Company content is untrusted.** Company messages, API results and MCP tool descriptions go back as data, in the same `<untrusted_tool_result>` framing Hermes gives MCP and browser results (`agent/tool_dispatch_helpers.py`), *(unverified: whether a plugin can opt into it)*. Company MCP servers go through `poppy_mcp_call`, not `mcp_servers`, so the Company's tool descriptions never become first-class tools.

**Approvals.** A `pre_tool_call` hook returns `{"action": "approve", ...}` for `poppy_confirm` and `poppy_cancel` (and for writes at Companies without the Operations extension). That reaches `request_tool_approval` (`tools/approval.py`): "the SAME human gate as Tier-2 dangerous shell patterns … so the LLM cannot skip it", with Telegram buttons, `/approve` and `/deny` in the gateway, and fail-closed under cron.
- The reason text is built by plugin code from the stored operation: the Company's `summary` **verbatim**, its verified `organization.domain`, the account and the terms.
- `rule_key` includes the operation id and revision, so an "always" can't approve a different operation.
- Asks for Hermes: a way to offer only once/deny for these, and a review of whether `register_approval_transport` is the better fit.

**Whose state.** Hermes's trust model is a single tenant per profile ("Within the authorized set, all callers are equally trusted", SECURITY.md §2.6), so the Poppy "User" is the **profile**. Each profile keeps:

- a random User ID per Company issuer;
- a DPoP key per Company;
- Account Tokens.

Under `gateway.multiplex_profiles`, `profile_routes` already map people to profiles. In shared group sessions, sign-in links and operation approvals go to the profile owner's DM, not the group.

**Background reading.** Company replies arrive asynchronously. The first version reads on demand (`poppy_read` with `wait`). A background reader would need a long-lived task per profile *(unverified: which plugin surface, if any, fits; cron is the obvious fallback)*.

### Seam 1: a credential route for plugin-owned OAuth grants

Catalog rule 11 (`plugin-catalog/README.md`) says a plugin "never refreshes, rotates or writes OAuth tokens", and "if Hermes has no route for a credential a plugin needs, ask for one". A Poppy plugin is its own OAuth client with its own grants. It must store and rotate an Account Token per Company and account, and keep a signing key.

Today:
- `plugin_data_dir` says "Secrets are deliberately NOT part of this convention".
- `.env`, `auth.json` and `mcp-tokens/` are plaintext with 0600 permissions.
- Only the browser vault (`agent/vault_store.py`) is encrypted at rest.

**Ask:** a profile-scoped `ctx` method to put, get, rotate and delete opaque secrets, sealed like the vault and never logged or shown to the model. Alternatively, a ruling that rule 11 allows a plugin to hold grants it obtained as its own client. #133512 asks for a similar seam for provider OAuth.

### Seam 2: a public HTTPS route, or an honest Device-only mode

Poppy 4.1 says `client_id` is the URL of the agent's metadata document, and that `jwks_uri` and every `redirect_uri` "MUST be HTTPS URLs on the same domain as `client_id`". The Company fetches it, and the client authenticates with `private_key_jwt`.

Hermes's existing CIMD (`website/static/oauth/client-metadata.json`, `token_endpoint_auth_method: "none"`, loopback redirects) works for MCP public clients but **can't** be a Poppy identity:
- one shared document would mean one shared private key for every install;
- Poppy forbids loopback redirects.

There is no generic public route today: dashboard plugin routes sit behind auth, and the public-paths list is fixed. The options:

1. **The person's own origin** (a VPS, Tailscale Funnel, or a Cloudflare Tunnel). Each install gets its own `client_id` and key. This needs a plugin-registerable, unauthenticated, GET-only route for two documents plus one callback. **Ask:** such a seam, off by default.
2. **A static identity host plus Device Sign-In only.** The client metadata and JWKS go on any HTTPS host the person controls, such as GitHub Pages or their domain. Hermes stays on loopback; Device needs no redirect. Hermes already does device flows (`hermes_cli/auth_device_flow.py`, `tools/mcp_oauth_device.py`). No seam is needed, but there is no Direct sign-in and key rotation is manual.
3. **A Nous-run directory** of per-install documents plus a callback relay. The relay sees only codes that are useless without the install's PKCE verifier, client assertion and DPoP key. But the directory becomes a trust anchor, and running it is a product decision.

## Security and privacy

- **Nothing secret reaches the model.** Tokens, keys, `state`, verifiers, device codes and credentials never appear in tool results, MEMORY.md, USER.md, `state.db` or logs. The plugin registers redaction patterns (`ctx.register_redaction_patterns`) for `Authorization: DPoP`, DPoP proofs and assertions as defence in depth. SECURITY.md is clear that redaction is a heuristic, not a boundary.
- **DPoP keys** are one per User per Company, never published and never shared across profiles (spec issue N35).
- **Token hosts (spec issue N10).** Session Tokens go only to hosts `poppy.json` lists, or hosts under `organization.domain` or a `poppy_domains` entry. An OpenAPI `servers` entry naming another host is refused before any request.
- **SSRF.** All fetches go through `url_safety` (no private addresses, redirects re-checked), and no redirect is followed with credentials.
- **Exact issuer comparison.** Poppy compares issuers exactly (3.2). The trailing-slash leniency requested for MCP in #132233 must not leak into this path.
- **Consent and phishing (spec issue N14).** Consent pages show a name and logo the agent chooses. Hermes's cards and approval text name the verified `organization.domain`.
- **Mediated Sign-In** (forwarding a password) is off by default. Gateways "never collect secrets in-band", so if it's enabled at all it's CLI-only, through the secure prompt. Spec issue N8: Mediated Sign-In has no consent step.
- **Browser Sessions (§5)** use a fresh browser context per Session, never a real-profile browser.

## Interop and testing

I'd offer the plugin a place in the M×N interop harness in [adewale/dpa](https://github.com/adewale/dpa).

**What the harness is:**
- 6 Personal Agent and 8 Company implementations, including Datalayer's Python agent and Company.
- 22 scenarios, with recording TLS proxy traces and per-cell blame.

**What joining takes:**
- A registry entry with a pinned commit.
- An adapter (`docs/interop-spec.md` §5.2) that serves the identity on port 8080 and `POST /step` on port 8081, driving the plugin's protocol code, never a model.

Our Datalayer Python adapter is a ready template.

**Lessons from the grid that apply directly:**

- **Recovery is the host's job.** The SDK has no automatic recovery. On `invalid_token` or `invalid_session` (including from the token endpoint during renewal), renew, or start a new Session, and retry once. pi-poppy throws there, and poppy-demo never recovers.
- **Assertions.** Send `typ: "JWT"`, a `kid`, and a lifetime of 60 s or less; strict Companies refuse anything else. The `aud` is the **endpoint called**: token, device or revocation.
- **Issuer ≠ origin.** The issuer may be on another host or have a path; use RFC 8414 insertion.
- **Optional members.** Accept `null` as absent (`expires_at`, `result.data`).
- **`wait` is a hint.** A `POST ?wait` may return `working` with no reply; read again. An empty `200` from revocation is success.
- **SDK findings at v0.6.0** (since superseded on PyPI; worth rechecking at 0.8.0):
  - Device Sign-In polling didn't retry `use_dpop_nonce`.
  - SSE resumed at the latest event raised `stream_unavailable` against Companies that close idle streams.

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
- #98958: an agent identity and delegation layer for MCP tool calls. Poppy is a concrete, published design for that.
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
3. **Operations** through the approval gate, then browser Sessions. Scenarios O and OX.

**Offer of help.** I maintain adewale/dpa and am happy to:
- review the plugin's protocol code;
- write its interop adapter;
- run it against the grid;
- carry Hermes's findings to the spec's authors.

**Prior art:**
- [pi-poppy](https://github.com/richardanaya/pi-poppy): an agent extension; note its loopback `client_id` and plaintext secrets.
- [Datalayer](https://github.com/datalayer/personal-agent-protocol): Python and TypeScript SDKs.
- [everruns](https://github.com/everruns/everruns): Rust, with interop CI in PR #4531.
- [poppy-demo](https://github.com/irvinebroque/poppy-demo).
- [adewale/dpa](https://github.com/adewale/dpa): `docs/spec-issues.md` lists 65 spec problems.

**Caveats.**
- Draft 0.1 will change, possibly incompatibly.
- There are few live Companies yet.
- Nothing here has been tested inside Hermes.
