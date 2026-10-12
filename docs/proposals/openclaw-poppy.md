# [Feature]: Poppy (Personal Agent Protocol) plugin: sign in to companies as the user, scoped and revocable

> **Draft for a GitHub issue on [openclaw/openclaw](https://github.com/openclaw/openclaw), using its `feature_request.yml` template. Not posted.** Researched against `main` at `6f9af588` (11 October 2026). Paths are relative to that tree. Items marked *(unverified)* are inferences from the docs that I haven't tested.

## Summary

Add support for the [Personal Agent Protocol](https://personalagentprotocol.org/) ("Poppy", Draft 0.1, published by [Sierra](https://sierra.ai/blog/poppy) on 9 October 2026, with Meta among its partners) as an OpenClaw plugin. With it, a person's OpenClaw can:

- discover a business that publishes `/.well-known/poppy.json`;
- sign in there **as that person**, on the business's own page, with scopes the person picks and can revoke;
- talk to the business's agent, and call its APIs and MCP server;
- bring proposed actions (an order, a refund, a booking) back to the person for approval in the chat they already use.

## Problem to solve

Today, when OpenClaw acts at a business, it can scrape the site in the managed browser as an anonymous visitor, or be handed the person's password or session and act as them with full access. Either way the business can't tell the agent from the person or limit it, and often blocks it.

Poppy defines the middle ground. The agent has its own identity, a `client_id` URL that serves metadata and a JWKS. Each person gets a separate, revocable, DPoP-bound grant. Writes become **operations** that the person approves.

Why now:

- The draft is five days old and explicitly wants implementers.
- About ten implementations exist, all days old, and none is a widely used personal agent.
- OpenClaw's feedback on what a self-hosted agent needs would shape the spec while it can still change.

One example, discussed below, is how a self-hosted agent gets an HTTPS `client_id`: the same wall #150247 hit for MCP.

## Proposed solution

**Where it lives.** VISION.md says "Core stays lean; optional capabilities should usually ship as plugins", and CONTRIBUTING.md says most features "should be third party plugins instead using our plugin SDK". So the proposal is:

- an external native plugin, `openclaw-poppy`, in its own repository, published to npm and ClawHub;
- no change to core;
- this issue, to check fit and to agree on a few small SDK seams (listed at the end).

**Plugin shape**, from `docs/plugins/sdk-overview.md` and `docs/plugins/sdk-overview/*.md`:

| Need | OpenClaw seam |
| --- | --- |
| Model tools | `api.registerTool`, declared in `openclaw.plugin.json` `contracts.tools` |
| Agent identity: `GET /poppy/client.json` (the `client_id`), `/poppy/jwks.json`, and the Direct Sign-In callback `/poppy/callback` | `api.registerHttpRoute({ auth: "plugin" })` under `gateway.publicOrigin` (`docs/plugins/architecture-internals/gateway-routes.md`, `docs/gateway/config-gateway.md`) |
| Background work: conversation readers (long-poll or SSE from a saved cursor), Device Sign-In polling, operation status | `api.registerService` |
| Human approval of Company operations, and of writes at Companies without the Operations extension | `before_tool_call` returning `requireApproval` with `scope: payment` or `external-post` (`docs/plugins/plugin-permission-requests.md`), routed by `approvals.plugin` to Slack, Discord, Telegram, Matrix and others, or by `/approve` |
| Sign-in links, device codes, operation cards | `MessagePresentation` `url` and `approval` actions (`docs/plugins/message-presentation.md`) |
| Signing out, listing connected Companies | `api.registerCommand` (`/poppy status`, `/poppy signout <domain>`), which bypasses the model |
| Per-user state | `api.runtime.state.openKeyedStore` (`docs/plugins/sdk-runtime/state-and-system.md`), with values sealed by the plugin (see Security) |
| Outbound HTTP | the SSRF-guarded fetch from `openclaw/plugin-sdk/ssrf-runtime` |
| Config | `configSchema`, with a signing key and a sealing key as SecretRefs (`configContracts.secretInputs`) |

**Tools the model gets.** They take a `domain` and return JSON. They never take or return tokens, keys, codes or credentials.

| Tool | Does |
| --- | --- |
| `poppy_discover(domain)` | Validates `poppy.json` and the issuer's RFC 8414 metadata. Returns the organization, sign-in types and scopes, APIs, Company agent, website and extensions. |
| `poppy_sign_in(domain, scopes, reason)` | Uses a stored Account Token if one covers the scopes. Otherwise it starts **Direct** sign-in (a link the person opens), else **Device** (a link and code), and returns "waiting for the person". A signed-out Session needs no call; it starts on first use. |
| `poppy_status(domain?)` | Sessions, accounts and granted scopes, and open conversations. No token values. |
| `poppy_message(domain, text?, data?, conversation?)` / `poppy_read(conversation)` / `poppy_handoff` / `poppy_close` | Conversations with the Company's agent. The message id is fixed per call, so a retry is safe. |
| `poppy_api_describe` / `poppy_api_call` | OpenAPI operations, with a DPoP Session Token. |
| `poppy_mcp_list` / `poppy_mcp_call` | The Company's MCP server, with a Bearer token minted for that server's `url` only. |
| `poppy_operation(domain, id)` | Reads a proposed operation. Reading isn't approving. |
| `poppy_confirm(domain, id)` / `poppy_cancel(domain, id)` | **Asks** to confirm or cancel an operation. A `before_tool_call` hook always answers `requireApproval`. |
| `poppy_sign_out(domain)` | Revokes the Account Token. It only ever reduces access, so the model may call it. |

**Approving** an operation is something only the person can do:

- The model can *ask* to confirm; only the person can approve.
- The approval prompt is built by plugin code from the stored operation, not from the model's arguments. It shows the Company's `summary` **verbatim**, its verified `organization.domain`, the account and the terms (`scope: payment` when there is an amount).
- Only `allow-once` and `deny` are offered. A Poppy approval covers one revision of one operation, so `allow-always` doesn't apply.
- On a timeout, or when there's no route to the person, nothing is confirmed.
- Company text is data and never counts as approval.

**Company MCP servers** go through `poppy_mcp_call` and are deliberately not registered as OpenClaw MCP servers. That keeps the Company's tool names and descriptions out of the model's tool list, where they'd be a prompt-injection surface, and keeps the Poppy-minted, Session-bound Bearer token out of `mcp.servers`. `api.registerMcpServerConnectionResolver` could make them native later (open question 4).

**Whose state.** The Poppy "User" is the person OpenClaw is acting for, taken from host-trusted context (`requesterSenderId`, or the Gateway profile in multi-user mode, `docs/concepts/multi-user.md`), never from a model argument. For each person the plugin keeps:

- a random User ID per Company issuer;
- a DPoP key pair per Company;
- Account Tokens per account.

Plugin storage isn't split per agent automatically, so the plugin keys every record itself.

**The `client_id` problem for self-hosted agents.** Poppy 4.1 says `jwks_uri` and every `redirect_uri` "MUST be HTTPS URLs on the same domain as `client_id`". The Company fetches the document, so a loopback gateway can't be a Poppy agent on its own. pi-poppy hit exactly this. The options:

1. **The gateway's own public origin (recommended first).** `gateway.publicOrigin` through Tailscale Funnel, Cloudflare Tunnel or a VPS. Each install is its own `client_id` with its own key, and the person owns the identity.
   - Costs: the person needs a stable public origin, because changing the domain makes the agent new to every Company.
   - *(Unverified)* whether Funnel's password requirement affects `auth: "plugin"` routes.
2. **A static identity host, used with Device Sign-In only.** The client metadata and JWKS go on any HTTPS host the person controls, such as GitHub Pages or their own domain. The gateway stays on loopback. Device Sign-In needs no redirect.
   - Costs: no Direct Sign-In, and a manual step whenever keys rotate.
3. **A project-run directory**, for example `https://agents.openclaw.ai/<install>/client.json`: per-install documents holding each install's own public key, plus a callback relay.
   - The relay never sees anything usable. A code is useless without the install's PKCE verifier, client assertion and DPoP key.
   - Costs: the directory becomes a trust anchor that could swap keys for every install. Companies would allowlist or block one domain. Someone has to run it. That is a product decision for maintainers, as in #150247.

   #150247's shared document (`token_endpoint_auth_method: "none"`) works for MCP public clients but **cannot** work for Poppy, because Poppy requires `private_key_jwt`, and one shared private key would make every install the same agent.

## Security and privacy

- **No secrets in model context.** Tokens, keys, `state`, PKCE verifiers, device codes and Mediated credentials never reach tool results, transcripts, memory, logs or URLs.
- **Sealing at rest.** The shared secret store is "not encrypted at rest" (`docs/gateway/secrets/secret-store-and-egress.md`). So the plugin seals Account Tokens and pending sign-in state with AES-GCM:
  - the key comes from a SecretRef (env, file, exec, 1Password or Vault);
  - the additional data is `issuer|user_id|account`, so one row can't be swapped for another.
- **DPoP keys.** One per User per Company, never published, and never shared across Users. One key for two Users links them; spec issue N35.
- **Token hosts.** Session Tokens go only to hosts `poppy.json` lists, or hosts under `organization.domain` or a `poppy_domains` entry. The draft doesn't define which hosts may receive them (spec issue N10), and an OpenAPI `servers` entry can name any host. A description that names another host is refused before any request.
- **SSRF.** Discovery, metadata, OpenAPI and MCP fetches go through the guarded fetch:
  - HTTPS only;
  - no private or loopback addresses;
  - size and time limits;
  - duplicate JSON members rejected;
  - no redirects followed with credentials.
- **Consent and phishing (spec issue N14).** Consent pages show a name and logo the agent itself chooses. Every OpenClaw card therefore shows the Company's verified `organization.domain`, not just its self-declared name.
- **Sign-in links.**
  - Direct and Device sign-in happen only in the person's own browser. The agent never automates them.
  - Per-requester MCP OAuth notes that "sign-in links are single-use bearer links: any chat participant who opens one connects their own account" (`docs/cli/mcp/transports.md`). The same applies here, so in group chats sign-in cards should go to the requester privately.
- **Mediated Sign-In** (the agent forwards a password) is off by default. If it is enabled, credentials go only through a masked prompt and never through a chat channel's history. Spec issue N8: Mediated Sign-In has no consent step.
- **The managed browser.** Poppy §5 Sessions use a dedicated profile per Session, never the `user` profile attached to the person's real Chrome.

## Interop and testing

I'd offer the plugin a place in the M×N interop harness in [adewale/dpa](https://github.com/adewale/dpa).

**What's in the harness:**
- 6 Personal Agent and 8 Company implementations: Datalayer TypeScript and Python, pi-poppy, poppy-demo, poppyseed, adonis-agora, Ilmer, and ours.
- 22 scenarios.
- A recording TLS proxy.
- Per-cell blame.

**What joining takes:**
- A registry entry with a pinned commit.
- A small adapter (`docs/interop-spec.md` §5.2). It serves the plugin's identity on port 8080 and `POST /step` on port 8081, and it drives the plugin's protocol code directly, never a model.

**What the grid showed breaks between implementations**, so this plugin can avoid it from day one:

- **Assertion `typ`.** Client and Session assertions without `typ: "JWT"` are refused by strict Companies. Send `typ: "JWT"`, a `kid`, and a lifetime of 60 s or less.
- **`aud` per endpoint.** The `aud` of a client assertion must be **the endpoint it's sent to**: token, device or revocation. Using the token endpoint everywhere fails at poppyseed.
- **Issuer ≠ origin.** `auth.issuer` may be another host (`auth.example.com`) or have a path. Don't assume the issuer is the Company's origin, and find metadata by RFC 8414 insertion.
- **Ended Sessions.** On `invalid_session` (including from the token endpoint during renewal), start a new Session and retry once; don't throw.
- **`null` optional members.** Accept `"expires_at": null` and `"data": null` as absent.
- **`wait` is a hint.** A `POST ?wait` may return early with `status: working`, so read again with `wait`. An empty `200` from revocation is success.

## Alternatives considered

- **Browser automation with the person's cookies.** This is what Poppy replaces: full access, no scopes, no revocation, and blocked by many sites.
- **Generic MCP OAuth.** It covers a Company's MCP server, but not Sessions, the Company's agent, operations or a per-person agent identity. Poppy reuses MCP for the API part.
- **A skill instead of a plugin.** Poppy needs code: JOSE, DPoP, sealed storage, HTTP routes and a background reader. A skill could still teach the model when to use the tools.
- **Wrapping pi-poppy.** It is the closest analogue (a TypeScript pi extension), but it stores secrets in plain text and uses a loopback `client_id` (see `docs/poppy-issues.md` in adewale/dpa).

## Impact

- Who it affects: anyone who uses OpenClaw to deal with businesses.
- What it gives them: scoped, revocable access instead of all or nothing, and approvals in the chat they already use.
- How many Companies they can use today: few. Signed-out conversations work with the live demos.
- Cost to OpenClaw core: none, unless the maintainers want the seams below.

## Evidence/examples

- **Spec:** https://personalagentprotocol.org/docs/spec. Problems found while implementing it are in adewale/dpa `docs/spec-issues.md` (65, with suggested fixes).
- **Prior art:**
  - [pi-poppy](https://github.com/richardanaya/pi-poppy): an agent extension for pi.
  - [Datalayer SDKs](https://github.com/datalayer/personal-agent-protocol): TypeScript and Python, BSD-3-Clause, with a TypeScript client a plugin could use.
  - [everruns](https://github.com/everruns/everruns): Rust, with interop CI against pi-poppy and Datalayer in PR #4531.
  - [poppy-demo](https://github.com/irvinebroque/poppy-demo).
  - [adewale/dpa](https://github.com/adewale/dpa): a Personal Agent on Cloudflare, a strict mock Company with 142 named checks, a document validator, and the interop harness.
- **Related OpenClaw issues:**
  - #150247: publishing a Client ID Metadata Document. Same mechanism; this issue explains why Poppy needs a per-install identity.
  - #138113 and #122034: per-requester MCP OAuth. The same "whose grant is this" question.
  - #116052: pre-registered MCP OAuth clients.

## Do you plan to open a PR for this?

Maybe, with maintainer guidance. The plugin itself would live in its own repository, as VISION.md asks. A PR here would only be for the SDK seams below, and only if you want them.

## Additional information

**Open questions for maintainers:**

1. Which `client_id` option (gateway origin, static host, or a project directory) should the plugin document as the default? Would OpenClaw ever run a directory?
2. Is a `before_tool_call` gate on `poppy_confirm` the intended pattern? Or is there a supported way for a background service to raise an approval itself? Company operations arrive asynchronously, in a conversation event, so the person might rather see the card when the proposal arrives than when the model next acts.
3. Would you accept small SDK seams:
   - a sealed (encrypted) plugin keyed store;
   - a public PKCE and loopback helper (`provider-oauth-runtime` is "Private-local");
   - a requester-private card delivery for sign-in links?
4. Should Company MCP servers become native per-requester servers through `registerMcpServerConnectionResolver`, despite the injection surface?
5. In multi-user mode, is the Gateway profile or `requesterSenderId` the right identity for "the User"?

**Phased plan:**

1. **Signed out.** Discovery and validation, signed-out Sessions, conversations with a background reader, and identity routes. Join the interop grid for D, S0, N, C and CI.
2. **Sign-in.** Direct and Device, Account Tokens sealed at rest, renewal and rotation, sign-out, APIs and MCP. Scenarios SD, SV, R, SE, SO, AO and AM.
3. **Operations.** Approval cards through `requireApproval`, confirm and cancel, then the browser join. Scenarios O and OX.

**Offer of help.** I maintain adewale/dpa and am happy to:
- review the plugin's protocol code;
- write its interop adapter;
- run it against the grid;
- carry what OpenClaw learns back to the spec's authors.

**Caveats.**
- Draft 0.1 will change, possibly incompatibly. Pin the version and keep the protocol code isolated.
- There are few live Companies yet. Early value is mostly signed-out conversations and demos.
- Nothing here has been tested inside OpenClaw.
