# Durable Personal Agent

**A Personal Agent for [Poppy](https://personalagentprotocol.org/), the Personal Agent Protocol, built alongside the tools we used to test it: a validator, a strict mock Company, an interop harness that runs other projects' code, and 62 written-up spec issues.** It is for the draft's authors and for people implementing either side of the protocol.

Poppy is a draft standard, published as Draft 0.1 on 9 October 2026, for AI agents acting for people at companies. This project's agent runs on Cloudflare Workers with one Durable Object per person and Claude Sonnet 5.5 through Pi. It finds a Company that publishes `poppy.json`, starts a Session, has you sign in on the Company's own page when it needs your account, talks to the Company's agent, calls its APIs, and asks you on the page before an action that changes your account. The status is alpha. The agent has run only against our mock and other projects' demos and SDKs, and never against a live Company. The one deployed product we know of that publishes `poppy.json`, [Spot](docs/ecosystem.md#companies-you-can-reach), isn't in the grid.

## See it work: ordering a print from print-with-poppy

[print-with-poppy](https://github.com/spenciefy/print-with-poppy) is a photo-printing store built for agents. We use it as the demo because its code isn't ours: our agent has to work with someone else's reading of the draft. It runs in its own demo mode, so an order never prints a photo or charges a card.

| Step | You or the agent | Spec | On the page | Status |
| --- | --- | --- | --- | --- |
| 1 | You attach a photo and ask: "Print this as a 6×4 at print-with-poppy" | | Chat, with the photo | Works in tests |
| 2 | The agent fetches `poppy.json` and the OAuth metadata, and the validator checks both | §3 | Activity: discovery and its verdict | Works in the grid |
| 3 | It starts a signed-out Session: a signed client assertion, then a DPoP-bound Session Token | §4.1–4.3 | Activity: the Session | Works in the grid |
| 4 | It reads the store's OpenAPI catalog and asks before sending your photo; you approve, and it uploads the photo | §6 | A card showing the photo | Works in the grid |
| 5 | It places the order; the store proposes an operation with its price and terms | Operations v1 | An approval card with the store's summary | Works in the grid |
| 6 | You approve; the agent confirms, and the store returns checkout and order-status links | Operations §4 | A receipt with the links | Works in the grid |

Every step's exchanges also appear in Activity's protocol log, with their spec sections, and can be copied as text for an interop report.

"Works in the grid" means our agent passes that part against the store's pinned code in our [interop harness](#for-implementers-test-against-us), offline, in scenario `OU`; "works in tests" means against our mock Company. The journey hasn't run live yet: the live store accepts our agent only once its maintainer adds our `client_id` to its allowlist.

## What you can do with it

**Get things done at companies that support Poppy**

- Ask whether a company supports Poppy, and the agent checks its setup is valid before using it.
- Talk to the company's own agent: "Ask Manzanita whether the Stormline jacket comes in medium." It can ask for a person there, or hand the conversation to you so you talk to them yourself.
- Sign in on the company's own page when a task needs your account. The agent never sees your password.
- Look things up and make changes through the company's APIs: "What's the status of my last order?"
- Place orders and changes with the company's price and terms in front of you, approved by you first: "Print this photo as a 6×4 at print-with-poppy."
- Use the company's website when it has no API. A form is sent only after you approve exactly what it sends.

**Everyday help**

- Read a web page you point it at: "What does this article say?" It sends nothing about you, only the address.
- Remember things you tell it: "Remember I'm vegetarian." Ask it to forget one, or see and delete every note in Settings.
- Dates, time zones and sums: "What date is 90 days from today?", "What time is it in Tokyo?", "What's 15% of €84.20?"

**You stay in control**

- Nothing that changes your account happens until you approve it on a card.
- Standing permissions let small repeat actions through without asking each time, within limits you set.
- Activity shows what the agent did, where and with what access, and every protocol exchange behind it.
- Your photos leave the agent only in an upload you approved, to the one company it names.

**Pay for the model your way:** the operator's daily demo allowance if you're on its list, or your own Anthropic or OpenAI key.

**Your data** stays in your own agent's storage; [the privacy policy](https://personal-agent.adewale-883.workers.dev/privacy) says what is kept and for how long.

Which of these is a Poppy feature and which is ours, each tool the model can call, and what needs your approval: [docs/capabilities.md](docs/capabilities.md).

## For implementers: test against us

- **The validator** checks a Company's `poppy.json` and OAuth metadata, or an agent's client metadata and keys, from a web form, an HTTP API, a CLI or a library. Its severities follow each requirement's basis: a broken MUST is an error, a departed SHOULD a warning ([conformance-levels.md](docs/conformance-levels.md)). Reference: [docs/validator.md](docs/validator.md).

  ```sh
  curl -s https://personal-agent.adewale-883.workers.dev/validator/api \
    -H 'Content-Type: application/json' \
    -d '{"url": "your-company.example"}' | jq '{outcome, counts}'
  ```

- **Our agent as your peer.** Its `client_id` is `https://personal-agent.adewale-883.workers.dev/poppy/client.json`. A Company that keeps an allowlist can add it, and we'll point the agent at you; Appendix A of [the spec](durable-personal-agent-spec.md) lists every requirement it implements and the test that checks it.
- **The interop harness** (`interop/`) runs every agent against every Company in containers with no internet access, through a recording proxy, and blames each failure on a side by a named rule. It runs seven other projects today. The latest grid has 1,800 cells over 30 scenarios: 849 pass, 171 fail and 780 unsupported. Every failure is a known upstream or spec one, and our agent passes every cell it runs. [docs/ecosystem.md](docs/ecosystem.md#scorecard) scores each implementation; [interop/README.md](interop/README.md) says how to add yours, and [docs/interop-spec.md](docs/interop-spec.md) defines the scenarios, the attribution rules and the isolation.
- **Adversarial testing.** A malicious agent and a malicious Company attack our own implementations, and only ours: oversized documents, nonce loops, terms swapped at confirm, forged messages and more ([docs/adversarial-interop.md](docs/adversarial-interop.md)).
- **Cross-checks.** Our validator runs against two other open validators on the same 107 documents ([the tool](interop/vectors/validators/README.md), [results](docs/interop-testing.md#validator-cross-check)), and our client against Datalayer's language-neutral conformance cases ([results](interop/vectors/datalayer/README.md)). A second client, written in Python from the draft's text, drives stateful property tests of our mock Company ([test/hypothesis](test/hypothesis/README.md)).
- **Findings in your code** go to you privately first, as [SECURITY.md](SECURITY.md) describes. Nothing is posted to another project without the owner's approval.

## For the draft's authors: what we found

- **[Spec issues](docs/spec-issues.md):** 62 problems in Draft 0.1, found by comparing implementations, crawling the site and running the grid. Each has a severity (5 Critical, 13 High, 29 Medium, 15 Low), a suggested fix, and what we do meanwhile.
- **[Readings](docs/readings.md):** where the draft is ambiguous, the reading we chose and why: strict where security depends on it, lenient where it doesn't.
- **[Grounding](spec/grounding.md):** every claim we make about the draft, quoted against a stored copy of its text.
- **[Conformance levels](docs/conformance-levels.md):** how our mock, validator and grid grade a broken MUST, a departed SHOULD and one of our readings.
- **[Ecosystem map](docs/ecosystem.md):** every Poppy implementation we know of, what it does, and how it scores in our grid. The detailed survey behind it, with licences, maturity and what we learned from each project, is [implementations.md](docs/implementations.md).
- **[Interop results](docs/interop-results/README.md):** the state of M×N interop: the latest grid of every agent against every Company, with pass, fail and unsupported counts for each pair, and every failure with the rule that blamed it on a side.
- **[Issues in other implementations](docs/poppy-issues.md):** what the grid and code reading found in other projects, reported to their maintainers privately first.

- **[Proposals](docs/proposals/README.md):** drafts for adding Poppy to OpenClaw and Hermes Agent, to submit once this agent has worked against a live Company.
- **[Conformance testing history](docs/conformance-testing-history.md):** the precedents this approach borrows from, such as the Feed Validator, the OpenID Foundation's suite and web-platform-tests.

None of this has been sent to the draft's authors yet.

## How it's built

- **One agent per person.** Each Google or GitHub sign-in gets its own Durable Object running Pi, with its conversation, Poppy state, tokens and keys in its own SQLite. One person's agent can't read another's, and work survives crashes and deploys.
- **Approval stays on the page.** Company text reaches the model labelled as information, never as approval. A write waits for your approval of exactly what will be sent, unless the Company has the Operations extension and its own API description says that call only proposes an operation (an OpenAPI `202` carrying `operation`, or an MCP tool whose output declares one). Then you approve the Company's proposal and its terms instead. Sending your photo or file always waits for you. A standing permission covers a proposal only when the Company's summary begins with the permission's action and every term is an amount within its limit, a date, or one of the record ids in the draft's example (`order_id`, `item_id`, `replacement_sku`); anything else comes to you.
- **Secrets stay out of the model.** Session Tokens and DPoP keys live only in memory; Account Tokens and pasted model keys are sealed with AES-GCM and bound to their row; the model's tools never take or return a credential.
- **General tools beside Poppy.** `read_url` reads one public page as untrusted text with no cookies or credentials; `remember`, `recall` and `forget` keep short notes in the agent's own SQLite, never secrets; `now`, `date_math` and `calculate` do time zones, calendar arithmetic and exact decimal sums. All are ours, in `src/tools/`, with no third-party service.
- **Two ways to pay for the model.** An operator-paid demo through AI Gateway, capped per person and per domain before every call, or your own Anthropic or OpenAI key, sent straight to the vendor. Compaction keeps each request under about 200k tokens.
- **Everything is tested offline.** Five suites run with the model, the vendors, Google, GitHub and every Company faked, and every Poppy test fails if the strict mock Company records a violation or a warning. A second client in Python drives a stateful Hypothesis test of the mock, because a misreading our client and mock share is invisible to both.

The design is [durable-personal-agent-spec.md](durable-personal-agent-spec.md); each capability and tool, and where it comes from, is [docs/capabilities.md](docs/capabilities.md); why it is built this way is [docs/decisions.md](docs/decisions.md).

## Status and limitations

- **Live:** https://personal-agent.adewale-883.workers.dev, with sign-in limited to an allowlist, and the validator at `/validator`, open to anyone. GitHub sign-in works; Google sign-in isn't registered yet.
- **Never run against a live Company.** Spot publishes valid discovery but has no Operations and isn't in the grid; everything else we know of is a demo or an SDK.
- **Not tried live:** the demo lane's gateway and its spend limits are faked in the tests ([deployment-tasks.md](docs/deployment-tasks.md)).
- **Browsing runs no JavaScript,** so a site that needs it to show a page or send a form can't be browsed.
- **Not built:** skills, web search and reminders.
- Everything still open is in [TODO.md](TODO.md).

## Run it yourself

Node.js 24 or later:

```sh
npm install --legacy-peer-deps   # agents declares many optional peers
npm test                         # five suites; nothing calls the network
npm run typecheck
npm run check:docs               # every test the docs name exists
npm run validate -- example.com  # the validator CLI
npm run interop -- --agents dpa --companies dpa-mock   # the grid, in Docker
```

To deploy your own copy, follow [docs/setup.md](docs/setup.md) in the order [docs/deployment-tasks.md](docs/deployment-tasks.md) gives.

## Project layout

```text
src/index.ts        Worker routes (chat, sign-in, Poppy identity, validator)
src/agent.ts        The per-person Durable Object
src/model-*.ts      Who pays for each model call: own keys (sealed), the demo and its caps
src/poppy/          The Poppy client, its tools, the fetch-based browser and the Activity log
src/tools/          The general tools: read_url, memory, time and maths
src/ui/             The page: Chat, Activity, Companies, Settings
src/validator/      The validator: parser, primitives, profiles, fetch, HTTP, HTML
scripts/            The validator CLI, the deploy check, the docs check, the spec snapshot
test/               The suites, the fakes, the mock Company, the Hypothesis client
interop/            The interop runner, recording proxy, scenarios, adapters and cross-checks
spec/               A dated copy of the draft, and what each of our claims rests on
docs/               Decisions, capabilities, setup, spec issues, readings, interop, the ecosystem map, proposals
```

## Security, contributing and licence

- **Security:** report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes.
- **Contributing:** keep `npm test`, `npm run typecheck` and `npm run check:docs` passing. A new Poppy feature needs a test, and a check in the mock Company where the draft states a requirement. `git config core.hooksPath .githooks` turns on a pre-push typecheck.
- **Support:** this is a private repository for its collaborators; report problems in [GitHub issues](https://github.com/adewale/dpa/issues).
- **Licence:** none chosen yet. Files copied from Cloudflare's `agents` examples keep their MIT licence; see [NOTICE.md](NOTICE.md).
