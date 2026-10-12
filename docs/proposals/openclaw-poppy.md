# [Feature]: Poppy (Personal Agent Protocol) plugin: sign in to companies as the user, scoped and revocable

> **Draft for a GitHub issue on [openclaw/openclaw](https://github.com/openclaw/openclaw), using its `feature_request.yml` template. Not posted.** OpenClaw was researched against `main` at `6f9af588` (11 October 2026), and paths are relative to that tree. Facts about Poppy and its implementations were last brought up to date on 12 October 2026, from adewale/dpa's docs. Items marked *(unverified)* are inferences from the docs that I haven't tested.

## Summary

Add support for the [Personal Agent Protocol](https://personalagentprotocol.org/) ("Poppy", Draft 0.1, published 9 October 2026) as an OpenClaw plugin. The protocol's site names no author and speaks as "we" ("So we built Personal Agent Protocol"); [Sierra's announcement](https://sierra.ai/blog/poppy) says the work is led by Sierra and Meta, with 35 named design partners. With the plugin, a person's OpenClaw can:

- discover a business that publishes `/.well-known/poppy.json`;
- sign in there **as that person**, on the business's own page, with scopes the person picks and can revoke;
- talk to the business's agent, and call its APIs and MCP server;
- bring proposed actions (an order, a refund, a booking) back to the person for approval in the chat they already use.

## Problem to solve

Today, when OpenClaw acts at a business, it can scrape the site in the managed browser as an anonymous visitor, or be handed the person's password or session and act as them with full access. Either way the business can't tell the agent from the person or limit it, and often blocks it.

Poppy defines the middle ground. The agent has its own identity, a `client_id` URL that serves metadata and a JWKS. Each person gets a separate, revocable, DPoP-bound grant. Writes become **operations** that the person approves.

Why now:

- Draft 0.1 is the only version, and its open-topics page says "Every part of it can still change, including the parts the specification already covers" and that "other gaps will come up as people implement the protocol."
- On 12 October 2026, adewale/dpa's survey (`docs/implementations.md`) listed 13 implementations, each "at most a few days old". On the Personal Agent side they are Datalayer's SDK, adonis-agora's agent library and its NestJS port, pi-poppy (an extension for the pi coding agent), poppy-demo's caller, everruns's signed-out-only `poppy_client`, a scripted demo in an open pull request, print-with-poppy's reference script, and ours. The survey found no Poppy issue, pull request or proposal in OpenClaw or the eight other agent frameworks it searched; the one framework that had one, OpenAgents, closed it as not planned.
- OpenClaw's feedback on what a self-hosted agent needs would reach the spec while it can still change. One example, discussed below, is how a self-hosted agent gets an HTTPS `client_id`: the same wall #150247 hit for MCP.

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
| Human approval of Company operations, of other API writes, of file uploads and of website form submissions (see Approving) | `before_tool_call` returning `requireApproval` with `scope: payment` or `external-post` (`docs/plugins/plugin-permission-requests.md`), routed by `approvals.plugin` to Slack, Discord, Telegram, Matrix and others, or by `/approve` |
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
| `poppy_status(domain?)` | Sessions, accounts and granted scopes, open conversations, and every open operation and approval. No token values. |
| `poppy_message(domain, text?, data?, conversation?)` / `poppy_read(conversation)` / `poppy_handoff` / `poppy_close` | Conversations with the Company's agent. The message id is fixed per call, so a retry is safe. |
| `poppy_api_describe` / `poppy_api_call` | OpenAPI operations, with a DPoP Session Token. A `multipart/form-data` operation takes files by reference to something the person attached, never as bytes in a tool argument. |
| `poppy_mcp_list` / `poppy_mcp_call` | The Company's MCP server, with a Bearer token minted for that server's `url` only. |
| `poppy_operation(domain, id)` | Reads a proposed operation. Reading isn't approving. |
| `poppy_confirm(domain, id)` / `poppy_cancel(domain, id)` | **Asks** to confirm or cancel an operation. A `before_tool_call` hook always answers `requireApproval`. |
| `poppy_sign_out(domain)` | Revokes the Account Token. It only ever reduces access, so the model may call it. |

**Approving** is something only the person can do:

- The model can *ask* to confirm; only the person can approve.
- The approval prompt is built by plugin code from the stored operation, not from the model's arguments. It shows the Company's `summary` **verbatim**, its verified `organization.domain`, the account and the terms (`scope: payment` when there is an amount).
- Only `allow-once` and `deny` are offered. A Poppy approval covers one revision of one operation, so `allow-always` doesn't apply. If standing permissions (Operations 5.1) are added later, the narrow rule we use is a fair starting point: a permission covers a proposal only when the Company's summary begins with the permission's action and every term is an amount within its limit, a date, or one of the record ids in the draft's example (`order_id`, `item_id`, `replacement_sku`).
- On a timeout, or when there's no route to the person, nothing is confirmed.
- Company text is data and never counts as approval.

**Which writes need the person first.** Having the Operations extension doesn't make every write at a Company safe to send, because a Company may use operations "for some actions and not others" (Operations 1), and the draft defines no marker for the writes that propose one (spec issue S22). The rules our agent follows:

- An API write goes straight to the Company only when the Company has the Operations extension **and** its own description says that call proposes an operation: an OpenAPI `202` whose schema has `operation`, poppyseed's `x-poppy-operation: true`, or an MCP tool whose output schema has `operation`. The person then approves the Company's proposal. Any other write waits for the person's approval of exactly what will be sent.
- Sending a file the person attached always waits for them, at every Company. The Operations extension covers what a Company does, not what the agent sends it.
- Every website form submission waits for approval, because the draft gives website actions no approval step (spec issue N43).

**Company MCP servers** go through `poppy_mcp_call` and are deliberately not registered as OpenClaw MCP servers. That keeps the Company's tool names and descriptions out of the model's tool list, where they'd be a prompt-injection surface, and keeps the Poppy-minted, Session-bound Bearer token out of `mcp.servers`. `api.registerMcpServerConnectionResolver` could make them native later (open question 4).

**Whose state.** The Poppy "User" is the person OpenClaw is acting for, taken from host-trusted context (`requesterSenderId`, or the Gateway profile in multi-user mode, `docs/concepts/multi-user.md`), never from a model argument. For each person the plugin keeps:

- a random User ID per Company issuer;
- a DPoP key pair per Company;
- Account Tokens per account.

Plugin storage isn't split per agent automatically, so the plugin keys every record itself.

**The `client_id` problem for self-hosted agents.** Poppy 4.1 says `jwks_uri` and every `redirect_uri` "MUST be HTTPS URLs on the same domain as `client_id`". The Company fetches the document, so a loopback gateway can't be a Poppy agent on its own. pi-poppy hit exactly this: its default client metadata is served on localhost. The options:

1. **The gateway's own public origin (recommended first).** `gateway.publicOrigin` through Tailscale Funnel, Cloudflare Tunnel or a VPS. Each install is its own `client_id` with its own key, and the person owns the identity.
   - Costs: the person needs a stable public origin, because changing the domain makes the agent new to every Company.
   - *(Unverified)* whether Funnel's password requirement affects `auth: "plugin"` routes.
2. **A static identity host, used with Device Sign-In only.** The client metadata and JWKS go on any HTTPS host the person controls, such as GitHub Pages or their own domain. The gateway stays on loopback. Device Sign-In needs no redirect.
   - Costs: no Direct Sign-In, and a manual step whenever keys rotate.
3. **A project-run directory**, for example `https://agents.openclaw.ai/<install>/client.json`: per-install documents holding each install's own public key, plus a callback relay.
   - The relay never sees anything usable. A code is useless without the install's PKCE verifier, client assertion and DPoP key.
   - Costs: the directory becomes a trust anchor that could swap keys for every install. Companies would allowlist or block one domain. Someone has to run it. That is a product decision for maintainers, as in #150247.

   #150247's shared document (`token_endpoint_auth_method: "none"`) works for MCP public clients but **cannot** work for Poppy, because Poppy requires `private_key_jwt`, and one shared private key would make every install the same agent.

Some Companies admit only agents they have listed. print-with-poppy keeps an allowlist of `client_id`s, and poppy-demo's Northstar accepts only its own caller. Whichever option is chosen, the `client_id` has to stay stable for a Company's operator to add it.

## Security and privacy

- **No secrets in model context.** Tokens, keys, `state`, PKCE verifiers, device codes and Mediated credentials never reach tool results, transcripts, memory, logs or URLs.
- **Sealing at rest.** The shared secret store is "not encrypted at rest" (`docs/gateway/secrets/secret-store-and-egress.md`). So the plugin seals Account Tokens and pending sign-in state with AES-GCM:
  - the key comes from a SecretRef (env, file, exec, 1Password or Vault);
  - the additional data is `issuer|user_id|account`, so one row can't be swapped for another.
- **DPoP keys.** One per User per Company, never published, and never shared across Users. One key for two Users links them; spec issue N35.
- **Token hosts.** Session Tokens go only to hosts `poppy.json` lists, or hosts under `organization.domain` or a `poppy_domains` entry. The draft doesn't define which hosts may receive them (spec issue N10, rated Critical), and an OpenAPI `servers` entry can name any host. A description that names another host is refused before any request.
- **Re-fetching discovery.** The draft never says when an agent must fetch and check `poppy.json` and API descriptions again (spec issue N44). Cache each by its HTTP headers, bounded to the Guides' "at least a minute and at most a day", and validate every fetch as fully as the first.
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
- **The managed browser.** Poppy §5 Sessions use a dedicated profile per Session, never the `user` profile attached to the person's real Chrome. Form submissions need approval, as above (N43).

## Interop and testing

I'd offer the plugin a place in the M×N interop harness in [adewale/dpa](https://github.com/adewale/dpa).

**What's in the harness:**

- 6 Personal Agents (ours, Datalayer TypeScript and Python, pi-poppy, poppy-demo's caller, adonis-agora) and 10 Companies: seven other projects' (Datalayer TypeScript and Python, pi-poppy's test Company, poppy-demo's Northstar, poppyseed, Ilmer, print-with-poppy, adonis-agora's AuthKit) plus our lenient and strict mocks.
- 39 scenarios. 25 test interop between honest implementations. The other 14 are security scenarios: a malicious agent (7), a malicious Company (3) and network faults injected by the proxy (4).
- A recording TLS proxy, on a Docker network with no route to the internet, and per-cell blame by named attribution rules.

**What the last full grid found** (12 October 2026, 24 interop scenarios; `docs/interop-results/README.md`): 1,440 cells, 683 pass, 137 fail, 620 unsupported, 0 errors. Every failure is a known upstream or spec failure with a written cause. The security grid, run apart, passed 25 of 25 cells.

**What joining takes:**

- A registry entry with a pinned commit.
- A small adapter (`docs/interop-spec.md` §5.2). It serves the plugin's identity on port 8080 and a control API on port 8081, and it drives the plugin's protocol code directly, never a model.

The security scenarios run only against our own implementations, never against another project's, and the plugin would be no exception. Anything the interop grid turns up in the plugin would go to its maintainers privately first, under adewale/dpa's SECURITY.md.

**What the grid showed breaks between implementations**, so this plugin can avoid it from day one:

- **Assertion `typ`.** Client and Session assertions without `typ: "JWT"` are refused by strict Companies (our strict mock, poppy-demo's Northstar, Ilmer). Send `typ: "JWT"`, a `kid`, and a lifetime of 60 s or less. The strict Companies allow 60 s, Datalayer 0.10.0 and print-with-poppy 120 s, and our lenient mock 300 s. The draft states none of this (spec issue S2).
- **Assertion `aud`.** The draft doesn't say what a client assertion's `aud` is at the token, device authorization and revocation endpoints (spec issue S1), so this is a reading. poppyseed and pi-poppy's Company accept only the endpoint the assertion is sent to; Datalayer's Companies at 0.10.0 accept the issuer, the token endpoint or the endpoint called. The safe choice is the endpoint called, which every Company in the grid that checks `aud` accepts. adonis-agora's agent sends the token endpoint everywhere, and fails Device Sign-In and sign-out at poppyseed and pi-poppy's Company.
- **Issuer ≠ origin.** `auth.issuer` may be another host (`auth.example.com`) or have a path. Don't assume the issuer is the Company's origin, and find metadata by RFC 8414 insertion. poppy-demo's caller assumes the origin and fails at every such Company.
- **Ended Sessions.** On `invalid_session` (including from the token endpoint during renewal), start a new Session and retry once; don't throw. pi-poppy throws there (spec issue N39).
- **A lost code exchange.** If the answer to the code exchange or the final device poll is lost, the Company has issued an Account Token the agent never saw, and the draft has no way to get it back or revoke it (spec issue N45). Abandon that Session, start a new one, and tell the person the sign-in was interrupted.
- **`null` optional members.** Accept `null` as absent. Datalayer's Companies still send `result.data: null` on a cancelled operation, which pi-poppy rejects (spec issue N41).
- **Signed-out operations.** print-with-poppy, a photo-printing store, proposes every order as an operation in a signed-out Session. If that Session ends first, the draft gives no way to finish the operation (spec issue N19); our reading treats `operation_not_found` as final.
- **`wait` is a hint.** A `POST ?wait` may return early with `status: working`, so read again with `wait`. An empty `200` from revocation is success; poppy-demo's caller parses it as JSON and throws at poppyseed.

## Alternatives considered

- **Browser automation with the person's cookies.** This is what Poppy replaces: full access, no scopes, no revocation, and blocked by many sites.
- **Generic MCP OAuth.** It covers a Company's MCP server, but not Sessions, the Company's agent, operations or a per-person agent identity. Poppy reuses MCP for the API part.
- **A skill instead of a plugin.** Poppy needs code: JOSE, DPoP, sealed storage, HTTP routes and a background reader. A skill could still teach the model when to use the tools.
- **Wrapping pi-poppy.** It is the closest analogue (a TypeScript pi extension), but it stores secrets in plain text and uses a loopback `client_id` (see `docs/poppy-issues.md` in adewale/dpa).

## Impact

- Who it affects: anyone who uses OpenClaw to deal with businesses.
- What it gives them: scoped, revocable access instead of all or nothing, and approvals in the chat they already use.
- How many Companies they can use today: few. Of the hosts adewale/dpa's `docs/ecosystem.md` lists on 12 October 2026, none is a large business. Spot, a cart-approval service, is the one deployed product; the others are demos, a local-history archive, a lab behind a login, and hosts seen only in another checker's directory. None of the launch partners checked on 11 October served a `poppy.json`. The fullest journey available is print-with-poppy's, in its demo mode: a signed-out Session, a photo upload, then an order proposed as an operation and approved. Our agent completes it against the store's pinned code in our grid (scenario OU), but not yet live, because the live store admits only agents on its allowlist.
- Cost to OpenClaw core: none, unless the maintainers want the seams below.

## Evidence/examples

- **Spec:** https://personalagentprotocol.org/docs/spec. adewale/dpa `docs/spec-issues.md` lists 62 problems found while implementing it, each with a suggested fix: 5 Critical, 13 High, 29 Medium and 15 Low. Six earlier entries were withdrawn as our own misreadings.
- **Prior art:**
  - [pi-poppy](https://github.com/richardanaya/pi-poppy): an agent extension for pi.
  - [Datalayer SDKs](https://github.com/datalayer/personal-agent-protocol): TypeScript and Python, BSD-3-Clause, 0.10.0 on npm and PyPI on 12 October, with a TypeScript client a plugin could use.
  - [everruns](https://github.com/everruns/everruns): Rust, signed-out Sessions only so far, with interop tests against pi-poppy and Datalayer (PR #4531).
  - [poppy-demo](https://github.com/irvinebroque/poppy-demo).
  - [print-with-poppy](https://github.com/spenciefy/print-with-poppy): a photo-printing store whose orders all go through the Operations extension.
  - [adewale/dpa](https://github.com/adewale/dpa): a Personal Agent on Cloudflare Workers, one Durable Object per person running Pi with Claude Sonnet 5.5, on an operator-paid demo lane or the person's own Anthropic or OpenAI key. Its Activity view has a protocol log that shows each exchange with the spec section it follows, with no secrets in it. The repository also has a mock Company that names 147 checks, graded by what each rests on: 119 failures (a MUST, an RFC's MUST, or a rule the draft states without a key word), 18 warnings (a SHOULD or the Guides) and 10 tentative (our reading of an open question), a validator with 76 messages, the interop harness, and a second Poppy client in Python that drives a Hypothesis stateful test of the mock.
- **Related OpenClaw issues:**
  - #150247: publishing a Client ID Metadata Document. Same mechanism; this issue explains why Poppy needs a per-install identity.
  - #138113 and #122034: per-requester MCP OAuth. The same "whose grant is this" question.
  - #116052: pre-registered MCP OAuth clients.

## Do you plan to open a PR for this?

Maybe, with maintainer guidance. The plugin itself would live in its own repository, as VISION.md asks. A PR here would only be for the SDK seams below, and only if you want them.

## Additional information

**Open questions for maintainers:**

1. Which `client_id` option (gateway origin, static host, or a project directory) should the plugin document as the default? Would OpenClaw ever run a directory?
2. Is a `before_tool_call` gate on `poppy_confirm` the intended pattern? Or is there a supported way for a background service to raise an approval itself? Company operations arrive asynchronously, in a conversation event, so the person might rather see the card when the proposal arrives than when the model next acts. Our agent takes the second route: the model has no confirm or cancel tool, and only the person's card (or a standing permission they set) can approve.
3. Would you accept small SDK seams:
   - a sealed (encrypted) plugin keyed store;
   - a public PKCE and loopback helper (`provider-oauth-runtime` is "Private-local");
   - a requester-private card delivery for sign-in links?
4. Should Company MCP servers become native per-requester servers through `registerMcpServerConnectionResolver`, despite the injection surface?
5. In multi-user mode, is the Gateway profile or `requesterSenderId` the right identity for "the User"?

**Phased plan:**

1. **Signed out.** Discovery and validation, signed-out Sessions, conversations with a background reader, and identity routes. Join the interop grid for D, S0, N, C and CI.
2. **Sign-in.** Direct and Device, Account Tokens sealed at rest, renewal and rotation, sign-out, APIs and MCP. Scenarios SD, SV, R, SE, SO, AO and AM.
3. **Operations.** Approval cards through `requireApproval`, confirm and cancel, file uploads, then the browser join. Scenarios O, OX and OU (print-with-poppy's signed-out upload and order).

**Offer of help.** I maintain adewale/dpa and am happy to:

- review the plugin's protocol code;
- write its interop adapter;
- run it against the grid;
- carry what OpenClaw learns back to the spec's authors.

**Caveats.**

- Draft 0.1 will change, possibly incompatibly. Pin the version and keep the protocol code isolated.
- There are few live Companies yet. Early value is mostly signed-out conversations and demos.
- Nothing here has been tested inside OpenClaw.
