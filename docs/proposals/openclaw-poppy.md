# [Feature]: Poppy (Personal Agent Protocol) plugin: sign in to companies as the user, scoped and revocable

> **Draft for a GitHub issue on [openclaw/openclaw](https://github.com/openclaw/openclaw), using its `feature_request.yml` template. Not posted.** OpenClaw was researched against `main` at `6f9af588` (11 October 2026) and checked again at `a1e82826` (13 October 2026); paths are relative to that tree. Every file, seam and quote cited here is still there and still says the same. In between, the cited docs changed wording and gained paragraphs on things this draft doesn't use (secret egress for setup jobs, keyed-store expiry, loopback MCP callbacks), and the new plugin docs (`sdk-gateway-ingress.md`, `mcp-relay.md`) don't change anything here. Facts about Poppy, its implementations and the interop grid were brought to the 28 October 2026 text of Poppy 0.3 on 29 October 2026, from adewale/pda's docs; the OpenClaw research keeps its dates. Section numbers are the 0.3 specification's unless they name an extension. Items marked *(unverified)* are inferences from the docs that I haven't tested.

## Summary

Add support for the [Personal Agent Protocol](https://personalagentprotocol.org/) ("Poppy", draft 0.3, the text on its site on 28 October 2026) as an OpenClaw plugin. The protocol's site names no author and speaks as "we" ("So we built Personal Agent Protocol"); [Sierra's announcement](https://sierra.ai/blog/poppy) says the work is led by Sierra and Meta, with 35 named design partners. With the plugin, a person's OpenClaw can:

- discover a business that publishes `/.well-known/poppy.json`;
- sign in there **as that person**, on the business's own page, with scopes the person picks and can revoke;
- talk to the business's agent, and call its APIs and MCP server;
- bring actions that need approval (an order, a refund, a booking) back to the person, with the business's exact terms, in the chat they already use.

## Problem to solve

Today, when OpenClaw acts at a business, it can scrape the site in the managed browser as an anonymous visitor, or be handed the person's password or session and act as them with full access. Either way the business can't tell the agent from the person or limit it, and often blocks it.

Poppy defines the middle ground. The agent has its own identity, a `client_id` URL that serves metadata and a JWKS. It signs a `Poppy-Session` header for every request, so the business knows which agent each request comes from and for which person, under a per-business pseudonym, whether or not they are signed in (5.2). Account access is plain OAuth: each person gets a separate, revocable grant with the scopes they approved (section 4). With the Operations extension, the business can refuse an action until the person approves its exact terms.

Why now:

- Poppy is a moving draft. 0.1 was published on 9 October and 0.2 on 24 October, and the 0.3 text on the site was rewritten on 28 October; the changelog still calls 0.3 "In progress". 0.3 is compatible with neither earlier draft: it replaced Session Tokens with a Session header the agent signs, and Operations version 1 with version 2. The spec says "Any part of it can change before a stable version, including in ways that aren't backward compatible", and its [Path to 1.0](https://personalagentprotocol.org/docs/path-to-1) page says "other gaps will come up as people implement the protocol" and that "Feedback is welcome from anyone, whether or not you're a partner." Its open topics include **self-hosted personal agents**: how one "that runs on the user's own devices, such as a desktop app, a phone app, or a browser extension, identifies itself and signs in without a server that learns which companies each user works with".
- On 29 October 2026, adewale/pda read the head of every project its grid used to pin (`docs/ecosystem.md`, `docs/implementations.md`). Only one of them implements the 28 October text: print-with-poppy, a photo-printing store (a Company), at `b340741`. Datalayer's SDKs, poppyseed and the specification's own repository follow an earlier 0.3 draft, with Session Keys and Session Tokens, which can't work with a Company built for the 28 October text; everruns speaks 0.1; pi-poppy, poppy-demo, Ilmer, adonis-agora and Tipping Co had no code for either 0.3 text. So of the Personal Agents it read, ours is the only one on the 28 October text. On 12 October the same survey found no Poppy issue, pull request or proposal in OpenClaw or the eight other agent frameworks it searched; the one framework that had one, OpenAgents, closed it as not planned. A search of OpenClaw's issues and pull requests on 13 October found none either.
- OpenClaw's feedback on what a self-hosted agent needs would reach the spec while it can still change. One example, discussed below, is how a self-hosted agent gets an HTTPS `client_id`: the same wall #150247 hit for MCP, and one of the spec's own open topics.

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
| Background work: conversation readers (long-poll or SSE from a saved cursor), Device Sign-In polling, new delegations before the old ones expire | `api.registerService` |
| Human approval of every API write, MCP tool call that can change something, file upload and website form submission, and of a Company's terms when it asks for them (see Approving) | `before_tool_call` returning `requireApproval` with a `scope` of kind `payment` or `external-post` (`docs/plugins/plugin-permission-requests.md`), routed by `approvals.plugin` to Slack, Discord, Telegram, Matrix and others, or by `/approve` |
| Sign-in links, device codes, approval cards | `MessagePresentation` `url` and `approval` actions (`docs/plugins/message-presentation.md`) |
| Signing out, listing connected Companies | `api.registerCommand` (`/poppy status`, `/poppy signout <domain>`), which bypasses the model |
| Per-user state | `api.runtime.state.openKeyedStore` (`docs/plugins/sdk-runtime/state-and-system.md`), with values sealed by the plugin (see Security) |
| Outbound HTTP | the SSRF-guarded fetch from `openclaw/plugin-sdk/ssrf-runtime` |
| Config | `configSchema`, with a signing key (for client assertions and delegations) and a sealing key as SecretRefs (`configContracts.secretInputs`) |

**Tools the model gets.** They take a `domain` and return JSON. They never take or return tokens, keys, codes or credentials.

| Tool | Does |
| --- | --- |
| `poppy_discover(domain)` | Fetches `poppy.json`, the domain's protected resource metadata and the issuer's RFC 8414 metadata, and checks the link between domain and issuer in both directions (3, 3.2). Returns the organization, sign-in types (from `grant_types_supported`), scopes with their hints, APIs, Company agent, website, excluded tasks and extensions. |
| `poppy_sign_in(domain, scopes, reason)` | Uses a stored refresh token if one covers the scopes. Otherwise it starts **Direct** sign-in (a link the person opens), else **Device** (a link and code), and returns "waiting for the person". Working signed out needs no call: the plugin signs a Session header for each request, and the Company starts the Session at the first one (5.3). |
| `poppy_status(domain?)` | Sessions, accounts and granted scopes, open conversations, and every approval waiting for the person. No token values. |
| `poppy_message(domain, text?, data?, conversation?)` / `poppy_read(conversation)` / `poppy_handoff` / `poppy_close` | Conversations with the Company's agent. The message id is fixed per call, so a retry is safe (8.3). |
| `poppy_api_describe` / `poppy_api_call` | OpenAPI operations, with the Session header, and an access token when signed in (DPoP-bound when the Company binds its tokens, 4.5). A `multipart/form-data` operation takes files by reference to something the person attached, never as bytes in a tool argument. |
| `poppy_mcp_list` / `poppy_mcp_call` | The Company's MCP server, with an access token requested for that server's `url` as its `resource` and used only there (section 7). |
| `poppy_approve(domain, operation_id)` | **Asks** to send the person's approval of the Company's terms for an operation. A `before_tool_call` hook always answers `requireApproval`. There is no cancel tool: Operations 2 has nothing to send for a decline, so a declined approval is simply never sent. |
| `poppy_sign_out(domain)` | Revokes every refresh token held for the account, which is what signing out is (4.6, 5.5). It only ever reduces access, so the model may call it. |

**Approving** is something only the person can do. Under Operations 2, a Company that wants approval refuses the request and returns the operation: its terms in a plain-language `summary`, optionally as JSON `terms`, with an `expires_at` (Operations 3, 4). The agent then sends the same request again with the approval (Operations 6).

- The model can *ask* to approve; only the person can approve. The Personal Agent "MUST take the User's answer through its own interface" and "MUST NOT treat text from the Company, such as a conversation message, as the User's approval" (Operations 5).
- The approval prompt is built by plugin code from the stored operation, not from the model's arguments. It shows the Company's `summary` **verbatim**, with any links, images or HTML shown as text (Operations 3), the Company's name and verified `organization.domain`, the account, and when the terms expire. A `scope` of kind `payment` is used when the terms have an amount. When the operation has `terms`, the plugin checks them against the summary and against what it asked for, and points out any difference (Operations 5, a SHOULD).
- Plugin code, never the model, sends the approval: exactly the request that returned the operation, with the same method, URL and body or the same tool arguments, plus the approval in the `Poppy-Approval` header, in MCP `_meta`, or in a conversation message's `approval` field (Operations 6). Only the guides say "Don't have the model write the request again" (issue 13 in adewale/pda's `docs/poppy-0.3-issues.md`).
- Only `allow-once` and `deny` are offered. An approval covers one revision of one operation, and Operations 5 rules out standing approval: the agent "MUST NOT approve one on the User's behalf, even when the User said earlier that they would approve something like it". So `allow-always` doesn't apply.
- On a timeout, or when there's no route to the person, nothing is sent.
- If the approved request fails or gets no answer, Operations 7 has the agent send it again with the same approval, and not ask the person about a new operation for the same action until it knows whether the first was performed. Our agent is stricter about resending: it never resends, and tells the person the action may or may not have happened.
- Company text is data and never counts as approval.

**Which writes need the person first.** Having the Operations extension doesn't make every write at a Company safe to send. "A Company chooses which actions need approval" (Operations 1), and one that doesn't ask performs the write at once. Operations version 1 let an API description mark the writes that propose an operation; version 2 has no such marker (issue 40). The rules our agent follows:

- Every API write, every MCP tool the server doesn't mark `readOnlyHint: true`, and every file upload waits for the person's approval of exactly what will be sent. If the Company then answers `approval_required`, its terms go on a second card, and only that card sends the approval. That is two approvals for one action, until the draft gives agents a marker.
- Sending a file the person attached always waits for them, at every Company. The Operations extension covers what a Company does, not what the agent sends it.
- Every website form submission waits for approval. Operations 4 asks for approval only through APIs, MCP and conversations, so the draft gives website actions no approval step.

**Company MCP servers** go through `poppy_mcp_call` and are deliberately not registered as OpenClaw MCP servers. That keeps the Company's tool names and descriptions out of the model's tool list, where they'd be a prompt-injection surface, and keeps the access token issued for that server out of `mcp.servers`. `api.registerMcpServerConnectionResolver` could make them native later (open question 4).

**Whose state.** The Poppy "User" is the person OpenClaw is acting for, taken from host-trusted context (`requesterSenderId`, or the Gateway profile in multi-user mode, `docs/concepts/multi-user.md`), never from a model argument. For each person the plugin keeps:

- a random User ID per Company issuer (5.1);
- delegated keys that sign their Session JWTs, each used for one User ID only (5.2);
- a DPoP key per Company, when the Company binds its tokens;
- refresh tokens per account;
- the Session IDs of their open Sessions.

Plugin storage isn't split per agent automatically, so the plugin keys every record itself.

**The `client_id` problem for self-hosted agents.** Poppy 4.1 says a `client_id` "MUST be an HTTPS URL that returns its metadata document", that `jwks_uri` "MUST be an HTTPS URL on the same domain as `client_id`", and that each redirect URI is one too, "or a loopback redirect URI for an app on the User's computer". The Company fetches the document, without following redirects (5.3), so a loopback gateway can't be a Poppy agent on its own, even though Direct Sign-In may now return to it. At 0.1, pi-poppy hit exactly this: its default client metadata is served on localhost. The options:

1. **The gateway's own public origin (recommended first).** `gateway.publicOrigin` through Tailscale Funnel, Cloudflare Tunnel or a VPS. Each install is its own `client_id` with its own key, and the person owns the identity.
   - Costs: the person needs a stable public origin, because changing the domain makes the agent new to every Company.
   - *(Unverified)* whether Funnel's password requirement affects `auth: "plugin"` routes.
2. **A static identity host.** The client metadata and JWKS go on any HTTPS host the person controls, such as GitHub Pages or their own domain. The gateway stays on loopback. The document can list a loopback redirect URI, whose port may vary (4.2), so Direct Sign-In works when the person's browser runs on the gateway's machine, and Device Sign-In, which needs no redirect, covers their other devices.
   - Costs: no Direct Sign-In from another device, and a manual step whenever keys rotate (the guides: publish a new key before signing with it).
3. **A project-run directory**, for example `https://agents.openclaw.ai/<install>/client.json`: per-install documents holding each install's own public key, plus a callback relay.
   - The relay never sees anything usable. A code is useless without the install's PKCE verifier and client assertion.
   - Costs: the directory becomes a trust anchor that could swap keys for every install. Companies would allowlist or block one domain. Someone has to run it. That is a product decision for maintainers, as in #150247.

   #150247's shared document (`token_endpoint_auth_method: "none"`) works for MCP public clients but **cannot** work for Poppy. A Personal Agent "is a confidential OAuth client" (section 4) that authenticates with `private_key_jwt` (4.1), and one shared private key would make every install the same agent.

Some Companies admit only agents they have listed: "A Company decides which Personal Agents it accepts" (4.1), and print-with-poppy's store keeps an allowlist of `client_id`s. Whichever option is chosen, the `client_id` has to stay stable for a Company's operator to add it.

## Security and privacy

- **No secrets in model context.** 10.2 requires keeping access tokens, refresh tokens, Session JWTs, private keys, authorization codes, PKCE verifiers and device codes out of model context, and recommends the same for every other secret. The plugin treats them all alike: `state`, browser-session codes, one-time codes and Mediated credentials never reach tool results, transcripts, memory, logs or URLs either. The MUST list leaves several of these out (issue 20).
- **Sealing at rest.** The shared secret store is "not encrypted at rest" (`docs/gateway/secrets/secret-store-and-egress.md`), and the guides say to encrypt refresh tokens at rest. So the plugin seals refresh tokens and pending sign-in state with AES-GCM:
  - the key comes from a SecretRef (env, file, exec, 1Password or Vault);
  - the additional data is `issuer|user_id|account`, so one row can't be swapped for another.
  Access tokens and delegated keys stay in memory.
- **Signing keys.** The key in `jwks_uri` signs only client assertions and delegations, and "a leaked one exposes every User" (10.7), so it stays a SecretRef. Each delegated key signs Session JWTs for one User ID only (5.2), and its delegation lasts at most 24 hours (5.2); the guides suggest a few hours. DPoP keys, when a Company binds its tokens, are one per User per Company and never shared: 0.3 dropped the rule of a separate DPoP key for each User ID, and one key across Companies lets them match a User (issue 6).
- **Token hosts.** The Session header and access tokens go only to hosts `poppy.json` lists for a service, or hosts at or under `organization.domain` or a URL in the issuer's `protected_resources`. The draft doesn't say which hosts may receive them: by default "one access token works at all of a Company's services" (4.5), and an OpenAPI `servers` entry can name any host. A description that names another host is refused before any request.
- **Re-fetching discovery.** The specification never says when an agent must fetch and check `poppy.json` and API descriptions again. The guides say to cache by HTTP headers, "within bounds you set, such as at least a minute and at most a day". Validate every fetch as fully as the first.
- **Bounded checking.** Nothing in the draft bounds how long a conversation may say `working` or report `has_more`, and while `has_more` is `true` the agent "reads again right away" (8.5). A background reader that takes the Company at its word reads every second for ever; ours did, at 0.1, until 13 October. Treat `Retry-After` as the least wait, drop a busy conversation with nothing new to the idle pace after a while, and cap the pages read per check. Our malicious Company's XR scenario checks this.
- **SSRF.** Discovery, metadata, OpenAPI and MCP fetches go through the guarded fetch:
  - HTTPS only (section 3);
  - no private, loopback or link-local addresses (section 3);
  - size and time limits (the guides);
  - duplicate JSON members rejected (the guides);
  - no token, Session JWT, assertion or credential sent to a redirect's new URL (section 3).
- **Consent and phishing.** A consent page shows a name and logo the agent itself chooses; the guides ask Companies to show the `client_id`'s domain too, because "The personal agent chooses its own name". The other way round, the agent MUST show the Company's `organization.name` and domain with a Device Sign-In link (4.3) and when it asks for Mediated credentials (Mediated Sign-In 6). Every OpenClaw card therefore shows the Company's verified `organization.domain`, not just its self-declared name.
- **Sign-in links.**
  - Direct and Device sign-in happen only in the person's own browser: a Personal Agent "MUST use Direct or Device Sign-In only when the User signs in themselves" (5.4). The agent never automates them.
  - A Device Sign-In link is shown only if its host is the issuer's or a protected resource's, or a subdomain of either (4.3). On a provider that hosts several Companies on one host, that check also passes another Company's page (issue 10).
  - Per-requester MCP OAuth notes that "sign-in links are single-use bearer links: any chat participant who opens one connects their own account" (`docs/cli/mcp/transports.md`), and that "a requester-private sign-in handoff is tracked as follow-up work". The same applies here, so in group chats sign-in cards should go to the requester privately.
- **Mediated Sign-In** (the agent forwards a password) is off by default. The spec calls the extension transitional and plans to retire it (Mediated Sign-In 1). If it is enabled, credentials go only through a masked prompt, never through a chat channel's history, and only to the issuer's `token_endpoint` (Mediated Sign-In 6). Its MUST against keeping them in model context covers only the time "After a sign-in ends" (issue 20), so the plugin keeps them out throughout.
- **The managed browser.** Browsing in a Session (section 6) uses a dedicated profile per Session, never the `user` profile attached to the person's real Chrome; the guides say "Never share one across users". The browser joins the Session with a code the plugin reads from the Company's page in that browser and authorizes in its own request, in code the model can't read (section 6). Form submissions need approval, as above.

## Interop and testing

I'd offer the plugin a place in the M×N interop harness in [adewale/pda](https://github.com/adewale/pda).

**What's in the harness:**

- Since 28 October it speaks only the 28 October text, so it holds our own implementations: our agent, and three profiles of it (`lenient-personal-agent`, `strict-personal-agent`, and `sloppy-personal-agent`, which makes mistakes real agents made), against our mock Company as `lenient-company`, `strict-company` and `evil-company`. Every other project's adapter spoke 0.1 or 0.2 and was retired that day (`docs/interop-spec.md` §14). print-with-poppy's came back on 29 October at `b340741`, the first other project on the 28 October text, and our agent passes all ten scenarios the store claims there, the photo upload and its order among them. The adversarial Personal Agent waits for a port to 0.3.
- 44 scenarios. 32 test interop between honest implementations, 8 have the malicious Company attack the agent, and 4 inject network faults through the proxy.
- A recording TLS proxy, on a Docker network with no route to the internet, and per-cell blame by named attribution rules.

**What the first 0.3 grid found** (29 October 2026; `docs/interop-results/README.md`): our agent passed all 68 cells it ran against our two honest mocks (20 unsupported, 0 errors) and all 8 against `evil-company`, XR among them. All four agent profiles against both mocks: 248 pass, 32 fail, 72 unsupported, 0 errors. The 32 failures are the sloppy agent's, by design: its client assertions name the token endpoint as `aud`, which 4.1 forbids. Running it also found bugs in our agent, its adapter and the scenarios, each fixed before those counts.

At 0.1, on 13 October, the same harness ran 8 Personal Agents against 12 Companies from ten projects. Some of the lessons below come from that run; I've kept only those that still apply at 0.3.

**What joining takes:**

- A registry entry with a pinned commit.
- A small adapter (`docs/interop-spec.md` §5.2). It serves the plugin's identity on port 8080 and a control API on port 8081, and it drives the plugin's protocol code directly, never a model.

The network-fault scenarios run only against our own implementations. Since 13 October, with the repository owner's approval, the malicious-Company scenarios may also run against other projects' agents, built at their pinned commits and run in our containers on the isolated network, never against a live deployment. What they find stays out of the committed results until that project's maintainers have heard privately, under adewale/pda's SECURITY.md. The plugin would be treated the same way, and so would anything else the grid turns up in it.

**What to get right from day one**, from the 0.1 grid and from implementing the 28 October text:

- **The client assertion's `aud` is the issuer.** 4.1 settles what 0.1 left open: it "MUST be the Company's issuer, as a single string", at every OAuth endpoint, and Companies must reject anything else, the token endpoint URL included. At 0.1 no one value worked at every Company in the grid. The Session JWT's `aud` is the issuer too (5.2).
- **Assertion headers and lifetime.** 4.1 asks only that client assertions be short-lived, with `iat` and an unguessable `jti`; the guides say `exp` at most five minutes after `iat`. Send `typ: "JWT"`, a `kid` and a lifetime of 60 s: our strict mock refuses anything else, as the strictest Companies did at 0.1. Session JWTs and delegations have their own `typ` values, `poppy-session+jwt` and `pap-delegation+jwt`, which 5.2 requires.
- **`client_id` at the token endpoint.** RFC 7521 4.2 lets an agent leave it out when the assertion names the client, but at 0.1 every Company from another project in the grid but one refused a token request without it (`invalid_client`). Send it, as the Mediated Sign-In examples do.
- **Optional discovery members.** A Company needs only one of `agent`, `apis` and `web` (3.1), and an `authorization_endpoint` only if it offers Direct Sign-In (3.2). At 0.1, two agents in the grid failed by requiring members like these.
- **Issuer ≠ origin.** The issuer comes from the domain's protected resource metadata (3.2), and may be another host (`auth.example.com`) or have a path (`https://auth.provider.example/shop-a`). Find its metadata by RFC 8414 insertion, compare it character for character, and key User IDs and refresh tokens by the full issuer, as the guides say.
- **`invalid_session`.** It covers a Session header that failed a check, a refused `client_id`, a refused account change and an ended Session (section 7). The one recovery the spec gives is a new Session with a new `sid`, once; the guides say to fix the JWT instead for anything but an ended Session, and the agent can't tell which it got (issue 11).
- **A new Session JWT for every request.** Each covers one method and URL (5.2), so a retry needs a new one, and so does an SSE reconnect, which an SSE client's automatic reconnection doesn't give it (issue 23). The header never goes to the OAuth endpoints or to website pages (5.2).
- **Signed-out approvals stay in their Session.** "An operation returned in a signed-out Session can be approved only in that Session" (Operations 3). If the Company ends that Session, the approval can't follow to a new one (issue 12); our agent tells the person and sends nothing. Our mock's print shop, modelled on print-with-poppy's store, proposes its order this way (scenario OU).
- **A new `Idempotency-Key` on the approved request.** The first request's key "doesn't carry over" (Operations 6). An agent that reuses it, as the guides' retry advice suggests, gets the first `approval_required` back (issue 14).
- **`null` optional members.** Accept `null` as absent. The draft doesn't say, and at 0.1 one project's Companies sent `null` where another project's agent rejected it.
- **`wait` is a hint.** A Company may answer a read or a `POST ?wait` early, or cap `wait` (8.5), so read again from the cursor. An empty `200` from revocation is success (RFC 7009 §2.2).

## Alternatives considered

- **Browser automation with the person's cookies.** This is what Poppy replaces: full access, no scopes, no revocation, and blocked by many sites.
- **Generic MCP OAuth.** It covers a Company's MCP server, but not Sessions, the Company's agent, operations or a per-person agent identity. Poppy reuses MCP for the API part.
- **A skill instead of a plugin.** Poppy needs code: JOSE, a Session JWT signed for every request, sealed storage, HTTP routes and a background reader. A skill could still teach the model when to use the tools.
- **Wrapping pi-poppy.** It was the closest analogue (a TypeScript pi extension), but it has no code for 0.3, and at 0.1 it stored secrets in plain text and used a loopback `client_id` (see `docs/poppy-issues.md` in adewale/pda).

## Impact

- Who it affects: anyone who uses OpenClaw to deal with businesses.
- What it gives them: scoped, revocable access instead of all or nothing, and approvals in the chat they already use.
- How many Companies they can use today: almost none. On 29 October 2026 adewale/pda's validator checked the 33 public hosts in its records (`docs/ecosystem.md`). One, printwithpoppy.com, speaks the 28 October text and passes; 23 declare 0.1 or 0.2; seven declare 0.3 but follow the earlier draft, with no protected resource metadata; two didn't serve a document. None of the launch partners checked on 11 October served a `poppy.json`.
- The fullest journey is print-with-poppy's: a signed-out Session, a photo upload, then an order that needs the person's approval. The store moved to the 28 October text on 28 October, with Operations 2 and Mediated Sign-In 1, and admits only agents on its allowlist, which listed our current `client_id` by 24 October. At 0.1, on 12 October, our agent ran the journey live as far as the photo upload's approval card. At 0.3 nothing but discovery has run there yet, and the order has never run live, because the store takes real payments. Its Agent Sandbox (sandbox.printwithpoppy.com) still declared 0.2 on 29 October.
- At 0.3 our agent has run against one live Company, as far as discovery: printwithpoppy.com, on 29 October. Nothing past discovery has run live, because the store admits only agents on its allowlist and takes real payments. At 0.1, on 13 and 14 October, it held conversations with the Company Agent of Alpine Retail, a colleague's test Company, and signed in and out there; Alpine now declares 0.2, which our agent no longer speaks.
- Cost to OpenClaw core: none, unless the maintainers want the seams below.

## Evidence/examples

- **Spec:** https://personalagentprotocol.org/docs/0.3/spec, with the [Operations](https://personalagentprotocol.org/docs/0.3/extensions/operations) and [Mediated Sign-In](https://personalagentprotocol.org/docs/0.3/extensions/mediated-sign-in) extensions. adewale/pda's `docs/poppy-0.3-issues.md` lists 43 problems in the 28 October text, each with a suggested fix: 3 High, 15 Medium, 21 Low, and 4 found while implementing it.
- **Prior art:**
  - [print-with-poppy](https://github.com/spenciefy/print-with-poppy): a photo-printing store, on the 28 October text since `b340741`, with Operations 2 and Mediated Sign-In 1.
  - [Datalayer SDKs](https://github.com/datalayer/personal-agent-protocol): TypeScript and Python, BSD-3-Clause, 0.27.0 on npm and PyPI by 28 October. They follow the earlier 0.3 draft, with Session Keys and Session Tokens, so a plugin couldn't use them with a Company on the 28 October text yet.
  - [pi-poppy](https://github.com/richardanaya/pi-poppy) (an agent extension for pi), [poppy-demo](https://github.com/irvinebroque/poppy-demo) and [everruns](https://github.com/everruns/everruns): 0.1 only; everruns refuses 0.3.
  - [adewale/pda](https://github.com/adewale/pda): a Personal Agent on Cloudflare Workers, one Durable Object per person running Pi with Claude Sonnet 5.5, on an operator-paid demo lane or the person's own Anthropic or OpenAI key. Its Activity view has a protocol log that shows each exchange with the spec section it follows, with no secrets in it. The repository also has a mock Company that names 148 checks (29 October 2026), graded by what each rests on: 122 failures (a MUST, an RFC's MUST, or a rule the draft states without a key word), 19 warnings (a SHOULD or the Guides) and 7 tentative (our reading of an open question). It also has a validator with 79 messages, the interop harness, and a second Poppy client in Python, ported to 0.3 on 29 October, that drives five Hypothesis stateful tests of the mock.
- **Related OpenClaw issues** (states on 13 October 2026):
  - #150247 (open): publishing a Client ID Metadata Document. Same mechanism; this issue explains why Poppy needs a per-install identity.
  - #138113 (open) and #122034 (closed as completed on 12 August 2026): per-requester MCP OAuth. The same "whose grant is this" question.
  - #116052 (open): pre-registered MCP OAuth clients.

## Do you plan to open a PR for this?

Maybe, with maintainer guidance. The plugin itself would live in its own repository, as VISION.md asks. A PR here would only be for the SDK seams below, and only if you want them.

## Additional information

**Open questions for maintainers:**

1. Which `client_id` option (gateway origin, static host, or a project directory) should the plugin document as the default? Would OpenClaw ever run a directory?
2. Is a `before_tool_call` gate on `poppy_approve` the intended pattern? Or is there a supported way for a background service to raise an approval itself? A Company's terms arrive in its answer to a write, or later in a conversation message, so the person might rather see the card when the terms arrive than when the model next acts. Our agent takes the second route: the model has no approval tool, and only the person's card can approve.
3. Would you accept small SDK seams:
   - a sealed (encrypted) plugin keyed store;
   - a public PKCE and loopback helper (`provider-oauth-runtime` is "Private-local");
   - a requester-private card delivery for sign-in links?
4. Should Company MCP servers become native per-requester servers through `registerMcpServerConnectionResolver`, despite the injection surface?
5. In multi-user mode, is the Gateway profile or `requesterSenderId` the right identity for "the User"?

**Phased plan:**

1. **Signed out.** Discovery and validation, the Session header with delegated keys, signed-out Sessions, conversations with a background reader, and identity routes. Join the interop grid for D, S0, CM, C and CI.
2. **Sign-in.** Direct and Device, refresh tokens sealed at rest, rotation, sign-out, APIs and MCP. Scenarios SD, SV, R, N, SE, SO, AO and AM.
3. **Operations.** Approval cards through `requireApproval`, the approved request sent again, file uploads, then the browser join. Scenarios O, OX, OU (print-with-poppy's signed-out upload and order) and W.

**Offer of help.** I maintain adewale/pda and am happy to:

- review the plugin's protocol code;
- write its interop adapter;
- run it against the grid;
- carry what OpenClaw learns back to the spec's authors.

**Caveats.**

- Draft 0.3 will change, possibly incompatibly, as 0.2 and 0.3 did. Pin the text and keep the protocol code isolated.
- There are few live Companies yet: one public host speaks the 28 October text. Early value is mostly demos.
- At 0.3 our own agent has run against a live Company only as far as discovery (printwithpoppy.com).
- Nothing here has been tested inside OpenClaw.
