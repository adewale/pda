# [Feature]: Poppy (Personal Agent Protocol) support: a standalone plugin, plus two generic plugin seams it needs

> **Draft for a GitHub issue on [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), using its `feature_request.yml` template. Not posted.**
>
> - Hermes was researched against `main` at `97a9ae8e` (11 October 2026) and rechecked at `6e7b83a2` (13 October 2026), 542 commits later; paths are relative to that tree. Every cited file, hook and quote is still there. What moved: catalog rule 10 (a plugin's dependencies now install inside Hermes's exact pins), and `hermes plugins validate` now warns on imports of core modules the plugin docs don't name, `tools.url_safety` among them. The linked issues were rechecked the same day: #75576 is closed as completed, #130295 as not planned, and the other four are open. Facts about Poppy, Datalayer's SDK and the interop grid were brought to the 28 October 2026 text of Poppy 0.3 on 29 October 2026, from adewale/pda's docs; the Hermes research keeps its dates. Section numbers are the 0.3 specification's unless they name an extension.
> - Items marked *(unverified)* are inferences from code or docs that I haven't run.
> - CONTRIBUTING.md suggests GitHub Discussions for design proposals, so this may fit better there, with a short linked issue for the two seams.

## Problem or Use Case

[Personal Agent Protocol](https://personalagentprotocol.org/) ("Poppy", draft 0.3, the text on its site on 28 October 2026) is an open protocol for a person's own agent to deal with businesses. The protocol's site names no author and speaks as "we" ("So we built Personal Agent Protocol"); [Sierra's announcement](https://sierra.ai/blog/poppy) says the work is led by Sierra and Meta, with 35 named design partners. A business ("Company") publishes `/.well-known/poppy.json`, and a personal agent can then:

- work there signed out, with a Session header it signs for every request, so the Company knows which agent is asking and for which person, under a per-Company pseudonym (5.2);
- sign the person in on the Company's own page (Direct), with a link and code (Device), or, through a transitional extension, by forwarding credentials (Mediated), with scopes the person chooses and can revoke;
- talk to the Company's agent, and call its OpenAPI or MCP APIs with OAuth access tokens, DPoP-bound when the Company chooses (4.5);
- when an action has a business effect (an order, a refund, a booking), receive the Company's exact terms, which the person approves before the Company performs it (the Operations extension).

Today Hermes users who want their agent to act at a business can browse anonymously, or hand over a password or browser profile with full access. Poppy defines a middle ground: scoped and revocable.

Why now:

- Poppy is a moving draft. 0.1 was published on 9 October and 0.2 on 24 October, and the 0.3 text on the site was rewritten on 28 October; the changelog still calls 0.3 "In progress". 0.3 is compatible with neither earlier draft. The spec says "Any part of it can change before a stable version, including in ways that aren't backward compatible", and its [Path to 1.0](https://personalagentprotocol.org/docs/path-to-1) page says "other gaps will come up as people implement the protocol" and that "Feedback is welcome from anyone, whether or not you're a partner." Its open topics include **self-hosted personal agents**: how one "that runs on the user's own devices, such as a desktop app, a phone app, or a browser extension, identifies itself and signs in without a server that learns which companies each user works with".
- On 29 October 2026, adewale/pda read the head of every project its grid used to pin (`docs/ecosystem.md`, `docs/implementations.md`). Only one of them implements the 28 October text: print-with-poppy, a photo-printing store (a Company). Datalayer's SDKs, whose Python side this plan first rested on, follow an earlier 0.3 draft (see below). On 12 October the survey found no Poppy issue, pull request or proposal in Hermes Agent or the eight other agent frameworks it searched; the one framework that had one, OpenAgents, closed it as not planned. A search of Hermes's issues, pull requests and Discussions on 13 October found none either.
- Hermes's experience would reach the spec while it can still change, particularly what a self-hosted agent needs to host its identity, which Hermes already met with MCP CIMD (#75576, #130295).

## Proposed Solution

Following CONTRIBUTING.md ("Third-Party Product Integrations: Ship as a Standalone Plugin"; "These do not land in this repo"; "widen the generic plugin surface"), the proposal has two parts:

- a **standalone plugin**, `hermes-poppy`, in its own repository, installable with `hermes plugins install owner/repo`, and later offered to the catalog;
- **two small generic seams in Hermes** that it can't work without, each useful beyond Poppy.

### The plugin

**Packaging and dependency.**

- `plugin.yaml` declares `provides_tools`, `provides_hooks`, `config_schema` (a signing key as a `secret`), and `python_dependencies`.
- **Datalayer's SDK doesn't speak the 28 October text yet.** The first version of this draft built the plugin on Datalayer's [`personal-agent-protocol`](https://github.com/datalayer/personal-agent-protocol) Python SDK (BSD-3-Clause, on PyPI). Its head on 29 October (`a3713e3`, 27 October; 0.27.0 on PyPI and npm by 28 October) follows an earlier 0.3 draft, with Session Keys and Session Tokens, which the 28 October text replaced with the Session header and delegated keys. An agent built on it can't use a Company built for the 28 October text, and adewale/pda's grid no longer pins it. So there are two routes:
  1. The SDK moves to the 28 October text first, and the plugin depends on it as planned. At 0.1, on 13 October, our grid drove its Python agent (0.17.0) through 28 of the grid's 30 interop scenarios against twelve Companies, so it has implemented nearly all of an earlier text before.
  2. The plugin carries its own Poppy client, in the plugin's repository. adewale/pda's `test/hypothesis/poppy_client.py` is a Python client written from the 28 October text, for stateful tests of our mock Company. It isn't a library, but it covers the whole wire (discovery, the Session header with delegated keys, the three sign-in types, refresh and revocation, conversations, Operations 2, MCP and the browser join) with httpx, PyJWT and cryptography alone.
  The tools, hooks and seams below are the same either way.
- `PyJWT[crypto]` and `cryptography` are already core Hermes dependencies (`pyproject.toml`), so nothing heavy is added for JOSE. Catalog rule 10 (`plugin-catalog/README.md`, changed on 12 October) installs a plugin's dependencies inside Hermes's exact pins. With a protocol whose text changed incompatibly twice in October, the plugin needs the tight floor and upper bound that rule asks for, whichever client it uses.
- Outbound HTTP would go through Hermes's `create_ssrf_safe_async_client()` (`tools/url_safety.py`), passed to the client. Since 12 October `hermes plugins validate` warns on that import, because the plugin docs don't name `tools.url_safety` (`hermes_cli/plugin_validate_private_imports.py`). Either Hermes documents it for plugins, or the plugin carries its own address checks.

**Tools.** They are registered with `ctx.register_tool` in a `poppy` toolset, so `hermes tools` and `platform_toolsets` control them. They take a `domain` and return JSON, and never take or return tokens, keys, codes or credentials.

| Tool | Does |
| --- | --- |
| `poppy_discover(domain)` | Fetches `poppy.json`, the domain's protected resource metadata and the issuer's RFC 8414 metadata, and checks the link between domain and issuer in both directions (3, 3.2). Returns the organization, sign-in types (from `grant_types_supported`), scopes with their hints, APIs, Company agent, excluded tasks and extensions. |
| `poppy_sign_in(domain, scopes, reason)` | Uses a stored refresh token that covers the scopes. Otherwise it starts Direct sign-in (a link) or Device sign-in (a link and code), sent to the person, and returns "waiting for the person". Working signed out needs no call: the plugin signs a Session header for each request, and the Company starts the Session at the first one (5.3). |
| `poppy_status(domain?)` | Sessions, accounts and granted scopes, open conversations, and every approval waiting for the person. No token values. |
| `poppy_message` / `poppy_read` / `poppy_handoff` / `poppy_close` | Conversations with the Company's agent. The message id is fixed per call, so a retry never posts twice (8.3). |
| `poppy_api_describe` / `poppy_api_call` | OpenAPI operations, with the Session header, and an access token when signed in (DPoP-bound when the Company binds its tokens). A `multipart/form-data` operation takes files by reference to something the person attached, never as bytes in a tool argument. |
| `poppy_mcp_list` / `poppy_mcp_call` | The Company's MCP server, with an access token requested for its `url` as the `resource` and used only there (section 7). |
| `poppy_approve(domain, operation_id)` | Asks to send the person's approval of the Company's terms for an operation. Always gated by the person (below). There is no cancel tool: Operations 2 has nothing to send for a decline. |
| `poppy_sign_out(domain)` | Revokes every refresh token held for the account (4.6, 5.5). It only reduces access. |

**Company content is untrusted.** Company messages, API results, operation summaries and MCP tool descriptions go back as data, in the same `<untrusted_tool_result>` framing Hermes gives MCP and browser results (`agent/tool_dispatch_helpers.py`), *(unverified: whether a plugin can opt into it)*. Company MCP servers go through `poppy_mcp_call`, not `mcp_servers`, so the Company's tool descriptions never become first-class tools.

**Approvals.** Under Operations 2, a Company that wants approval refuses the request and returns the operation: a plain-language `summary`, optionally JSON `terms`, and an `expires_at` (Operations 3, 4). The agent then sends the same request again with the approval (Operations 6). A `pre_tool_call` hook returns `{"action": "approve", ...}` for `poppy_approve`, and for the writes listed below. That reaches `request_tool_approval` (`tools/approval.py`): "the SAME human gate as Tier-2 dangerous shell patterns … so the LLM cannot skip it", with Telegram buttons, `/approve` and `/deny` in the gateway. Any non-interactive context without an approval bridge fails closed. Cron follows `approvals.cron_mode`, which is `deny` by default; an operator who sets `approve` would let a cron job approve a Company's terms, which Operations 5 forbids ("MUST take the User's answer through its own interface"), so the plugin should refuse `poppy_approve` in cron itself.

- The reason text is built by plugin code from the stored operation: the Company's `summary` **verbatim**, with any links, images or HTML shown as text (Operations 3), the Company's name and verified `organization.domain`, the account and the expiry. When the operation has `terms`, the plugin checks them against the summary and against what it asked for, and points out any difference (Operations 5, a SHOULD).
- Plugin code, never the model, sends the approval: exactly the request that returned the operation, with the same method, URL and body or tool arguments, plus the `Poppy-Approval` header, MCP `_meta`, or a conversation message's `approval` field (Operations 6). Only the guides say "Don't have the model write the request again" (issue 13 in adewale/pda's `docs/poppy-0.3-issues.md`).
- `rule_key` includes the operation id and revision, so an "always" can't approve a different operation. "Always" shouldn't be offered at all: the agent "MUST NOT approve one on the User's behalf, even when the User said earlier that they would approve something like it" (Operations 5).
- If the approved request fails or gets no answer, Operations 7 has the agent send it again with the same approval, and not ask the person about a new operation for the same action until it knows whether the first was performed. Our agent is stricter about resending: it never resends, and tells the person the action may or may not have happened.
- Asks for Hermes: a way to offer only once/deny for these, and a review of whether `register_approval_transport` is the better fit.

Having the Operations extension doesn't make every write at a Company safe to send. "A Company chooses which actions need approval" (Operations 1), and one that doesn't ask performs the write at once. Operations version 1 let an API description mark the writes that propose an operation; version 2 has no such marker (issue 40). The rules our agent follows:

- Every API write, every MCP tool the server doesn't mark `readOnlyHint: true`, and every file upload waits for the person's approval of exactly what will be sent. If the Company then answers `approval_required`, its terms go on a second approval, and only that one sends `Poppy-Approval`. That is two approvals for one action, until the draft gives agents a marker.
- Sending a file the person attached always waits for them, at every Company. The Operations extension covers what a Company does, not what the agent sends it.
- Every website form submission waits for approval. Operations 4 asks for approval only through APIs, MCP and conversations, so the draft gives website actions no approval step.

In our agent the model has no approval tool at all; only the person's card can approve. The gate above gives the same guarantee for a model-callable tool, as long as the plugin sends an approval only after `request_tool_approval` returns the person's approval.

**Whose state.** Hermes's trust model is a single tenant per profile ("Within the authorized set, all callers are equally trusted", SECURITY.md §2.6), so the Poppy "User" is the **profile**. Each profile keeps:

- a random User ID per Company issuer (5.1);
- delegated keys that sign its Session JWTs, each used for one User ID only (5.2);
- a DPoP key per Company, when the Company binds its tokens;
- refresh tokens.

Under `gateway.multiplex_profiles`, `profile_routes` already map people to profiles. In shared group sessions, sign-in links and approvals go to the profile owner's DM, not the group.

**Background reading.** Company replies arrive asynchronously, and so do terms a Company Agent proposes in a message (Operations 4). The first version reads on demand (`poppy_read` with `wait`). A background reader would need a long-lived task per profile *(unverified: which plugin surface, if any, fits; cron is the obvious fallback)*. So would renewing delegations, which last at most 24 hours (5.2).

### Seam 1: a credential route for plugin-owned OAuth grants

Catalog rule 11 (`plugin-catalog/README.md`) says a plugin "never refreshes, rotates or writes OAuth tokens", and "if Hermes has no route for a credential a plugin needs, ask for one". A Poppy plugin is its own OAuth client with its own grants, so it must store a refresh token per Company and account, replace it when the Company rotates it (4.4: the agent "MUST use the new one from then on"), and keep a signing key.

Today:

- `plugin_data_dir` (`plugins/plugin_storage.py`) says "Secrets are deliberately NOT part of this convention".
- `.env`, `auth.json` and `mcp-tokens/` are plaintext with 0600 permissions.
- Only the browser vault (`agent/vault_store.py`) is encrypted at rest.
- Secret sources (`agent/secret_sources/base.py`) are read-only and fetched once at startup, so they can't hold a token that rotates.
- `hermes_cli/auth_oauth_pkce_plugin.py` is for model-provider plugins: a public client. A Poppy agent "is a confidential OAuth client" (section 4) that authenticates with `private_key_jwt` (4.1).

**Ask:** a profile-scoped `ctx` method to put, get, rotate and delete opaque secrets, sealed like the vault and never logged or shown to the model. Alternatively, a ruling that rule 11 allows a plugin to hold grants it obtained as its own client. #133512 asks for a similar seam for provider OAuth.

### Seam 2: a public HTTPS route, or a static identity host

Poppy 4.1 says a `client_id` "MUST be an HTTPS URL that returns its metadata document", that `jwks_uri` "MUST be an HTTPS URL on the same domain as `client_id`", and that each redirect URI is one too, "or a loopback redirect URI for an app on the User's computer". The Company fetches the document, without following redirects (5.3), and the client authenticates with `private_key_jwt`.

Hermes's existing CIMD (`website/static/oauth/client-metadata.json`, `token_endpoint_auth_method: "none"`, loopback redirects) works for MCP public clients but **can't** be a Poppy identity, because one shared document would mean one shared private key for every install. Its loopback redirects are no longer the obstacle: 0.3 allows them.

There is no generic public route today: dashboard plugin routes sit behind auth, and the public-paths list (`hermes_cli/dashboard_auth/public_paths.py`) is fixed. The options:

1. **The person's own origin** (a VPS, Tailscale Funnel, or a Cloudflare Tunnel). Each install gets its own `client_id` and key. This needs a plugin-registerable, unauthenticated, GET-only route for two documents plus one callback. **Ask:** such a seam, off by default.
2. **A static identity host.** The client metadata and JWKS go on any HTTPS host the person controls, such as GitHub Pages or their domain. Hermes stays on loopback. The document can list a loopback redirect URI, whose port may vary (4.2), so Direct Sign-In works when the person's browser runs on Hermes's machine, and Device Sign-In, which needs no redirect, covers other devices. Hermes already does device flows (`hermes_cli/auth_device_flow.py`, `tools/mcp_oauth_device.py`). No seam is needed, but Direct Sign-In from a phone isn't possible and key rotation is manual.
3. **A Nous-run directory** of per-install documents plus a callback relay. The relay sees only codes that are useless without the install's PKCE verifier and client assertion, but the directory becomes a trust anchor, and running it is a product decision.

The spec lists self-hosted personal agents among its open topics (Path to 1.0), so the answer may change before 1.0.

Some Companies admit only agents they have listed: "A Company decides which Personal Agents it accepts" (4.1), and print-with-poppy's store keeps an allowlist of `client_id`s. Whichever option is chosen, the `client_id` has to stay stable for a Company's operator to add it.

## Security and privacy

- **Nothing secret reaches the model.** 10.2 requires keeping access tokens, refresh tokens, Session JWTs, private keys, authorization codes, PKCE verifiers and device codes out of model context, and recommends the same for every other secret. The plugin keeps them all, `state`, browser-session codes, one-time codes and Mediated credentials included, out of tool results, MEMORY.md, USER.md, `state.db` and logs; the MUST list leaves several out (issue 20). The plugin registers redaction patterns (`ctx.register_redaction_patterns`) for the `Authorization`, `Poppy-Session` and `DPoP` headers, which the guides say to redact, and for Session JWTs, delegations and client assertions, as defence in depth. SECURITY.md is clear that redaction is a heuristic, not a boundary.
- **Keys.** The key in `jwks_uri` signs only client assertions and delegations, and "a leaked one exposes every User" (10.7). Each delegated key signs for one User ID only (5.2). DPoP keys are one per User per Company, never shared across profiles: 0.3 dropped the rule of a separate DPoP key for each User ID, and one key across Companies lets them match a User (issue 6).
- **Token hosts.** The Session header and access tokens go only to hosts `poppy.json` lists for a service, or hosts at or under `organization.domain` or a URL in the issuer's `protected_resources`. The draft doesn't say which hosts may receive them: by default "one access token works at all of a Company's services" (4.5), and an OpenAPI `servers` entry can name any host. A description that names another host is refused before any request.
- **Re-fetching discovery.** The specification never says when an agent must fetch and check `poppy.json` and API descriptions again. The guides say to cache by HTTP headers, "within bounds you set, such as at least a minute and at most a day". Validate every fetch as fully as the first.
- **SSRF.** All fetches go through `url_safety` (no private addresses, redirects re-checked), as section 3 requires, and no token, Session JWT, assertion or credential is sent to a redirect's new URL (section 3).
- **Exact issuer comparison.** Poppy compares issuers exactly, character for character (3.2), and the `iss` on a Direct Sign-In redirect the same way (4.2). The trailing-slash leniency requested for MCP in #132233 must not leak into this path.
- **Consent and phishing.** A consent page shows a name and logo the agent chooses; the guides ask Companies to show the `client_id`'s domain too. The agent MUST show the Company's `organization.name` and domain with a Device Sign-In link (4.3) and when it asks for Mediated credentials (Mediated Sign-In 6). Hermes's cards and approval text name the verified `organization.domain`.
- **Mediated Sign-In** (forwarding a password) is off by default; the spec calls it transitional and plans to retire it (Mediated Sign-In 1). Gateways "never collect secrets in-band", so if it's enabled at all it's CLI-only, through the secure prompt, and the credentials go only to the issuer's `token_endpoint` (Mediated Sign-In 6). The extension's MUST against keeping them in model context covers only the time "After a sign-in ends" (issue 20), so the plugin keeps them out throughout.
- **Browser Sessions (section 6)** use a fresh browser context per Session, never a real-profile browser. The join code is read from the Company's page in that browser and authorized by plugin code the model can't read (section 6). Form submissions need approval, as above.

## Interop and testing

I'd offer the plugin a place in the M×N interop harness in [adewale/pda](https://github.com/adewale/pda).

**What the harness is:**

- Since 28 October it speaks only the 28 October text, so it holds our own implementations: our agent, and three profiles of it (`lenient-personal-agent`, `strict-personal-agent`, and `sloppy-personal-agent`, which makes mistakes real agents made), against our mock Company as `lenient-company`, `strict-company` and `evil-company`. Every other project's adapter, Datalayer's two among them, spoke 0.1 or 0.2 and was retired that day (`docs/interop-spec.md` §14). print-with-poppy's came back on 29 October at `b340741`, the first other project on the 28 October text, and our agent passes all ten scenarios the store claims there, the photo upload and its order among them. The adversarial Personal Agent waits for a port to 0.3.
- 44 scenarios. 32 test interop between honest implementations, 8 have the malicious Company attack the agent, and 4 inject network faults through the proxy.
- A recording TLS proxy, on a Docker network with no route to the internet, and per-cell blame by named attribution rules.
- The first 0.3 grid (29 October 2026; `docs/interop-results/README.md`): our agent passed all 68 cells it ran against our two honest mocks (20 unsupported, 0 errors) and all 8 against `evil-company`, among them XR, a conversation that never stops saying there is more to read. All four agent profiles against both mocks: 248 pass, 32 fail, 72 unsupported, 0 errors; the 32 failures are the sloppy agent's, by design, whose client assertions name the token endpoint as `aud`, which 4.1 forbids.
- At 0.1, on 13 October, the same harness ran 8 Personal Agents against 12 Companies from ten projects. Some of the lessons below come from that run; I've kept only those that still apply at 0.3.

**What joining takes:**

- A registry entry with a pinned commit.
- An adapter (`docs/interop-spec.md` §5.2) that serves the identity on port 8080 and a control API on port 8081, driving the plugin's protocol code, never a model.

adewale/pda's Python client in `test/hypothesis/`, written from the 28 October text and driving five Hypothesis stateful tests of our mock Company, shows one way to drive a Poppy Company from Python tests.

The fault scenarios run only against our own implementations. Since 13 October the malicious Company may also run against other projects' agents, built at their pinned commits in our own containers and never against a live service (adewale/pda's SECURITY.md, point 5). The plugin would be no exception. Anything the grid turns up in the plugin stays private and goes to its maintainers first, under that SECURITY.md.

**Lessons that apply directly**, from the 0.1 grid and from implementing the 28 October text:

- **Recovery is the plugin's job.** On `invalid_token`, refresh (4.4), or continue signed out if refresh fails (5.5). On `invalid_session`, start a new Session with a new `sid`, once (section 7). That one code covers a Session header that failed a check, a refused `client_id`, a refused account change and an ended Session, and the guides say to fix the JWT instead for anything but an ended Session; the agent can't tell which it got (issue 11).
- **A new Session JWT for every request.** Each covers one method and URL (5.2), so a retry needs a new one, and so does an SSE reconnect, which an SSE client's automatic reconnection doesn't give it (issue 23). The header never goes to the OAuth endpoints or to website pages (5.2).
- **The client assertion's `aud` is the issuer.** 4.1 settles what 0.1 left open: it "MUST be the Company's issuer, as a single string", at every OAuth endpoint, and Companies must reject anything else, the token endpoint URL included. At 0.1 no one value worked at every Company in the grid.
- **Assertion headers and lifetime.** 4.1 asks only that client assertions be short-lived, with `iat` and an unguessable `jti`; the guides say `exp` at most five minutes after `iat`. Send `typ: "JWT"`, a `kid` and a lifetime of 60 s: our strict mock refuses anything else, as the strictest Companies did at 0.1. Session JWTs and delegations have their own `typ` values, `poppy-session+jwt` and `pap-delegation+jwt`, which 5.2 requires.
- **Issuer ≠ origin.** The issuer comes from the domain's protected resource metadata (3.2) and may be on another host or have a path; use RFC 8414 insertion, and key User IDs and refresh tokens by the full issuer.
- **Optional members.** Accept `null` as absent. The draft doesn't say, and at 0.1 one project's Companies sent `null` where another project's agent rejected it.
- **Signed-out approvals stay in their Session.** "An operation returned in a signed-out Session can be approved only in that Session" (Operations 3). If the Company ends that Session, the approval can't follow to a new one (issue 12); our agent tells the person and sends nothing. Our mock's print shop, modelled on print-with-poppy's store, proposes its order this way (scenario OU).
- **A new `Idempotency-Key` on the approved request.** The first request's key "doesn't carry over" (Operations 6). An agent that reuses it, as the guides' retry advice suggests, gets the first `approval_required` back (issue 14).
- **`wait` is a hint.** A Company may answer a read or a `POST ?wait` early, or cap `wait` (8.5), so read again from the cursor. An empty `200` from revocation is success (RFC 7009 §2.2).
- **Bound the checking.** Nothing in the draft bounds how long a conversation may stay `working` or report `has_more`, and while `has_more` is `true` the agent "reads again right away" (8.5). An agent that takes the Company at its word reads every second for ever; ours did, at 0.1, until 13 October. Treat `Retry-After` as the least wait, read a busy conversation with nothing new at the idle pace, and cap the pages read per check. This matters most for a background reader.

## Alternatives Considered

- **A skill only.** CONTRIBUTING says "make it a Tool when it requires end-to-end integration with … auth flows". Poppy needs a Session JWT signed for every request, client assertions and sealed storage. A companion skill could still teach when to use it.
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
2. Seam 2: an unauthenticated plugin route, or a static identity host for now?
3. Is a profile the right "User", including under multiplexing?
4. Can a plugin opt its results into the untrusted-content framing?
5. Can an approval offer only once/deny?
6. Which surface should host a long-lived background reader?

**Phased plan:**

1. **Signed out.** Discovery, the Session header with delegated keys, signed-out Sessions and conversations, with no seam needed. Interop scenarios D, S0, CM, C and CI. Before this, choose the client: Datalayer's SDK if it has moved to the 28 October text, or the plugin's own.
2. **Sign-in.** Device first, with Seam 1 and an identity hosted per option 2, and Direct through a loopback redirect when the browser is on Hermes's machine. Then Direct from other devices with Seam 2, refresh and rotation, sign-out, APIs and MCP. Scenarios SV, SD, R, N, SE, SO, AO and AM.
3. **Operations** through the approval gate, file uploads, then browser Sessions. Scenarios O, OX, OU (print-with-poppy's signed-out upload and order) and W.

**Offer of help.** I maintain adewale/pda and am happy to:

- review the plugin's protocol code;
- write its interop adapter;
- run it against the grid;
- carry Hermes's findings to the spec's authors.

**Prior art:**

- [print-with-poppy](https://github.com/spenciefy/print-with-poppy): a photo-printing store, on the 28 October text since `b340741`, with Operations 2 and Mediated Sign-In 1.
- [Datalayer](https://github.com/datalayer/personal-agent-protocol): Python and TypeScript SDKs, 0.27.0 on PyPI and npm by 28 October, on the earlier 0.3 draft (above).
- [pi-poppy](https://github.com/richardanaya/pi-poppy) (an agent extension; at 0.1, note its loopback `client_id` and plaintext secrets), [poppy-demo](https://github.com/irvinebroque/poppy-demo) and [everruns](https://github.com/everruns/everruns): 0.1 only; everruns refuses 0.3.
- [adewale/pda](https://github.com/adewale/pda): a Personal Agent on Cloudflare Workers (one Durable Object per person running Pi with Claude Sonnet 5.5, on an operator-paid demo lane or the person's own Anthropic or OpenAI key), a mock Company that names 148 checks on 29 October 2026, graded by what each rests on (122 failures, 19 warnings, 7 tentative), a validator with 79 messages, and the interop harness. `docs/poppy-0.3-issues.md` lists 43 problems in the 28 October text, each with a suggested fix: 3 High, 15 Medium, 21 Low, and 4 found while implementing it.

**Caveats.**

- Draft 0.3 will change, possibly incompatibly, as 0.2 and 0.3 did.
- There are few live Companies yet. On 29 October adewale/pda's validator found one public host of 33, printwithpoppy.com, on the 28 October text; none of the launch partners checked on 11 October served a `poppy.json`.
- Datalayer's Python SDK doesn't yet speak the 28 October text (Packaging, above).
- At 0.3 adewale/pda's own agent has run against a live Company only as far as discovery: printwithpoppy.com passes its validator, and our agent's discovery there, on 29 October; at 0.1, on 12 October, the live journey there ran as far as the photo upload's approval card, after the store added our `client_id`. The order hasn't run live, because the store takes real payments, and at 0.1 the store had no conversations, so it wasn't a Company Agent check. At 0.1, on 13 and 14 October, the agent held conversations with the Company Agent of Alpine Retail, a colleague's test Company, which now declares 0.2.
- Nothing here has been tested inside Hermes.
