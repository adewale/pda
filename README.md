# Poppy Demo Agent

**A Personal Agent for [Poppy](https://personalagentprotocol.org/), the Personal Agent Protocol, built alongside the tools we used to test it: a validator, a strict mock Company, an interop harness, and written-up spec issues for each draft.** It is for the draft's authors and for people implementing either side of the protocol.

Poppy is a draft standard. PDA speaks **0.3 alone**, as upstream published it on its site on 28 October 2026; it dropped 0.1 and 0.2 the same day ([decision 37](docs/decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles)), and the change is unreleased on the `poppy-0.3` branch ([changelog](CHANGELOG.md), [plan and status](docs/poppy-0.3-plan.md#then-03-as-rewritten-on-28-october)). This project's agent runs on Cloudflare Workers with one Durable Object per person and Claude Sonnet 5.5 through Pi. It finds a Company that publishes `poppy.json`, names a Session on every request with a signed `Poppy-Session` header, has you sign in on the Company's own page when it needs your account, talks to the Company's agent, calls its APIs, and asks you on the page before an action that changes your account. The status is alpha. At 0.1 and 0.2 the deployed agent signed in and out at one live Company, Alpine Retail, a colleague's test store (13 and 14 October), and got as far as asking to upload a photo at print-with-poppy's live store (12 October) ([live evidence](docs/live-0.2-testing.md)). The [current verification report](docs/poppy-0.3-conformance.md#current-verification) records the 0.3 checks, independent demo evidence and live limits.

## Components and supported Poppy versions

The implementation follows the text of **28 October 2026** ([snapshot](spec/draft-0.3-retrieved-2026-10-28/README.md)), which upstream hasn't committed yet. [spec/upstream.json](spec/upstream.json) pins the snapshot's hashes, and `npm run spec:drift` says when the site changes. The [conformance review](docs/poppy-0.3-conformance.md) lists local fixes, verification limits and the disposition of all 43 upstream audit issues; the changelog ledger does not certify full conformance.

| Component | Poppy versions | What it does |
| --- | --- | --- |
| [PDA application and client](pda-spec.md) | 0.3 | Signs in to Companies, uses their APIs and conversations, and asks for approval before account changes, then for the Company's terms when it asks (Operations 2) |
| [Document validator](docs/validator.md) | 0.3 | Checks Company discovery, OAuth and protected resource metadata, client metadata and keys. One library backs the web form, HTTP API and CLI |
| [Reference/mock Company](interop/README.md#the-fake-implementations) | 0.3 | Serves Company endpoints and records violations. Tests select lenient, strict, deliberately flawed or adversarial behavior |
| [Fake test Personal Agents](interop/README.md#the-fake-implementations) | 0.3 | Exercise Companies with lenient, strict or sloppy behavior; the restored malicious agent sends mutated 0.3 requests to our own mocks |
| [Interop harness](docs/interop-spec.md) | 0.3 | Runs agent/Company pairs in isolated containers, records exchanges and reports failures by protocol rule. Its 0.1 and 0.2 peers and lanes are retired ([§14](docs/interop-spec.md#14-retired-with-01-and-02)) |
| Independent client tests | 0.3 | A [Python client and Hypothesis model](test/hypothesis/README.md) of the mock, written apart from `src/poppy` so a misreading both share can show |
| [Specification snapshots and the requirement ledger](docs/poppy-0.3-upgrade.md) | 0.3 | Preserve upstream text, and give each of 0.3's changelog entries a disposition with its code and evidence |

PDA uses the document validator during discovery, and the fake agents wrap PDA's client. The [ecosystem map](docs/ecosystem.md#current-ecosystem) records observation dates and tested revisions separately for source reviews, grids and live journeys.

## See it work: ordering a print

[print-with-poppy](https://github.com/spenciefy/print-with-poppy) is a photo-printing store built for agents, and it was our demo because its code isn't ours. It moved to 0.3 on 28 October (`b340741`), and on 29 October our validator found printwithpoppy.com's documents valid at 0.3. Our agent hasn't run the journey there at 0.3 yet: the store admits only agents on its allowlist, and it takes real payments. Until then the journey runs against our mock Company's print shop, which describes its API as print-with-poppy's store does (`test/print-journey.test.ts`).

| Step | You or the agent | Spec | On the page | Status |
| --- | --- | --- | --- | --- |
| 1 | You attach a photo and ask: "Print this as a 6×4 at the print shop" | | Chat, with the photo | Works in tests |
| 2 | The agent fetches `poppy.json`, the domain's protected resource metadata and the OAuth metadata, and the validator checks them | §3 | Activity: discovery and its verdict | Works in tests |
| 3 | Every request names its Session in a `Poppy-Session` header, signed with a delegated key; signed out, that's all it carries | §5.2 | Activity: the Session | Works in tests |
| 4 | It reads the store's OpenAPI catalog and asks before sending your photo; you approve, and it uploads the photo | §7 | A card showing the photo | Works in tests |
| 5 | It asks before placing the order; you approve, and the store answers `approval_required` with its price and terms | Operations 2, §4 | Our card, then an approval card with the store's terms and total | Works in tests |
| 6 | You approve the terms; the agent sends the same order with `Poppy-Approval`, and the store returns the order and its checkout link | Operations 2, §6 | A receipt with the store's answer | Works in tests |

Every step's exchanges also appear in Activity's protocol log, with their spec sections, and can be copied as text for an interop report.

At 0.2, on 12 October, the owner's deployed agent got as far as step 4 at printwithpoppy.com, which takes real payments: it started a signed-out Session, read the catalogue and asked to send a 3.7 MB photo ([what happened](docs/poppy-issues.md#print-with-poppy-spenciefyprint-with-poppy)).

## What you can do with it

**Get things done at companies that support Poppy**

- Ask whether a company supports Poppy, and the agent checks its setup is valid before using it.
- Talk to the company's own agent: "Ask Manzanita whether the Stormline jacket comes in medium." It can ask for a person there, or hand the conversation to you so you talk to them yourself.
- Sign in on the company's own page when a task needs your account. The agent never sees your password.
- Look things up and make changes through the company's APIs: "What's the status of my last order?"
- Place orders and changes with the company's price and terms in front of you, approved by you first: "Print this photo as a 6×4 at print-with-poppy."
- Use the company's website when it has no API. A form is sent only after you approve exactly what it sends.

**Everyday help**

- Read a web page you point it at: "What does this article say?" It sends nothing about you, only the address. A page that needs JavaScript, such as a timetable or a shop built as an app, it loads in a fresh browser in Cloudflare's Browser Run that only reads, up to 10 pages an hour.
- Remember things you tell it: "Remember I'm vegetarian." See and delete User-supplied notes in Settings; the agent can remove its own deductions.
- Dates, time zones and sums: "What date is 90 days from today?", "What time is it in Tokyo?", "What's 15% of €84.20?"
- Reminders: "Remind me at 5pm to call the bank." It shows in the chat at that time, and on your phone or laptop if you turn on notifications in Settings.
- Tasks on a schedule: "Every weekday at 9, check whether my print order has shipped." The agent does it in the background and tells you; anything it would change still waits for your approval. Settings lists every reminder and task, with Cancel.

**You stay in control**

- Nothing that changes your account happens until you approve it on a card.
- A write waits for your approval on our own card, and when the company asks, for your approval of its exact terms as well.
- Activity shows what the agent did, where and with what access, and every protocol exchange behind it.
- Your photos leave the agent only in an upload you approved, to the one company it names.

**Pay for the model your way:** the operator's daily demo allowance if you're on its list, or your own Anthropic or OpenAI key.

**Your data** stays in your own agent's storage; [the privacy policy](https://poppydemoagent.dev/privacy) says what is kept and for how long.

Signing in for the first time, with a run-through that checks each part works: [docs/using.md](docs/using.md). Which of these is a Poppy feature and which is ours, each tool the model can call, and what needs your approval: [docs/capabilities.md](docs/capabilities.md).

## For implementers: test against us

- **The validator** checks a Company's `poppy.json` and OAuth metadata, or an agent's client metadata and keys, from a web form, an HTTP API, a CLI or a library. Its severities follow each requirement's basis: a broken MUST is an error, a departed SHOULD a warning ([conformance-levels.md](docs/conformance-levels.md)). Reference: [docs/validator.md](docs/validator.md).

  ```sh
  curl -s https://poppydemoagent.dev/validator/api \
    -H 'Content-Type: application/json' \
    -d '{"url": "your-company.example"}' | jq '{outcome, counts}'
  ```

- **Our agent as your peer.** Its `client_id` is `https://poppydemoagent.dev/poppy/client.json`. A Company that keeps an allowlist can add it, and we'll point the agent at you; Appendix A of [the spec](pda-spec.md) lists every requirement it implements and the test that checks it.
- **The interop harness** (`interop/`) pairs registered agents and Companies in containers with no internet access, through a recording proxy, and attributes failures by named rules. Since 28 October it speaks 0.3. Its first 0.3 run, on 29 October, passed every cell our agent ran against both of our mocks (68, none failed) and against our malicious Company (8), and brought print-with-poppy back at its 0.3 commit, the one other project that implements the 28 October text ([results](docs/interop-results/README.md)). The historical snapshot from **13 October 2026**, at 0.1, covered nine other projects and 2,880 cells over 30 scenarios: 1,000 pass, 273 fail and 1,607 unsupported, with PDA passing 213 of its 214 cells. [interop/README.md](interop/README.md) says how to add yours, and [docs/interop-spec.md](docs/interop-spec.md) defines the scenarios, attribution rules and isolation.
- **Adversarial testing.** A malicious Company attacks our agent: oversized documents, nonce loops, forged messages and more ([docs/adversarial-interop.md](docs/adversarial-interop.md)). The malicious agent now exercises the 0.3 wire and actual effect counts. What an attack finds in another project's code goes to its maintainers privately first ([SECURITY.md](SECURITY.md)).
- **Official Company kit.** The [pinned 0.3 validator and manual checklist review](docs/company-kit-review.md) check our mock and hosted dummy Company's handlers independently. Raw failures, inconclusive results and skipped features remain visible. Earlier community-validator and Datalayer cross-checks remain [dated 0.1/0.2 evidence](docs/interop-testing.md#validator-cross-check).
- **Findings in your code** go to you privately first, as [SECURITY.md](SECURITY.md) describes. Nothing is posted to another project without the owner's approval.
- **What we need from you, and what we never do:** [docs/testing-with-us.md](docs/testing-with-us.md), the page to send a maintainer whose Company or agent we test: the identities to register, what the offline grid needs from your code, test accounts for signed-in tests.

## For the draft's authors: what we found

- **[Issues in 0.3](docs/poppy-0.3-issues.md):** the current list, written to send to the spec's authors: 39 problems from reading the 28 October text (3 High, 15 Medium, 21 Low), and 4 more found while implementing it. The plan to keep up with weekly versions: [docs/poppy-0.3-plan.md](docs/poppy-0.3-plan.md); the ledger of 0.3's changelog entries: [docs/poppy-0.3-upgrade.md](docs/poppy-0.3-upgrade.md). An earlier review of the pre-rewrite 0.3 text is [docs/spec-issues-0.3.md](docs/spec-issues-0.3.md).
- **[Spec issues in Draft 0.1](docs/spec-issues.md):** the October record, 64 problems found by comparing implementations, crawling the site and running the grid, each with a severity (5 Critical, 13 High, 31 Medium, 15 Low), a suggested fix, and what we did meanwhile.
- **[Readings](docs/readings.md):** where the draft is ambiguous, the reading we chose and why: strict where security depends on it, lenient where it doesn't.
- **[Grounding](spec/grounding.md):** every claim we make about the draft, quoted against a stored copy of its text.
- **[Conformance levels](docs/conformance-levels.md):** how our mock, validator and grid grade a broken MUST, a departed SHOULD and one of our readings.
- **[Ecosystem map](docs/ecosystem.md):** every Poppy implementation we know of, what it does, and how it scores in our grid. The detailed survey behind it, with licences, maturity and what we learned from each project, is [implementations.md](docs/implementations.md).
- **[Interop results](docs/interop-results/README.md):** the state of M×N interop: the public grid snapshot of every agent against every Company, with pass, fail and unsupported counts for each pair, and attribution where the evidence establishes a side.
- **[Issues in other implementations](docs/poppy-issues.md):** what the grid and code reading found in other projects, reported to their maintainers privately first.

- **[Proposals](docs/proposals/README.md):** drafts for adding Poppy to OpenClaw and Hermes Agent, to submit once this agent has worked against a live Company.
- **[Conformance testing history](docs/conformance-testing-history.md):** the precedents this approach borrows from, such as the Feed Validator, the OpenID Foundation's suite and web-platform-tests.

None of this has been sent to the draft's authors yet. They take feedback by email, as described on the draft's [Path to 1.0](https://personalagentprotocol.org/docs/path-to-1#feedback) page.

## How it's built

- **One agent per person.** Each Google or GitHub sign-in gets its own Durable Object running Pi, with its conversation, Poppy state, tokens and keys in its own SQLite. One person's agent can't read another's, and work survives crashes and deploys.
- **Approval stays on the page.** Company text reaches the model labelled as information, never as approval. A write waits for your approval of exactly what will be sent. When the Company then asks for approval (Operations 2's `approval_required`), its terms go on a card of their own, checked against the request, and only your approval of them sends the request again with `Poppy-Approval`. Sending your photo or file always waits for you.
- **Secrets stay out of the model.** Access tokens, delegated keys and DPoP keys live only in memory; refresh tokens and pasted model keys are sealed with AES-GCM and bound to their row; the model's tools never take or return a credential.
- **General tools beside Poppy.** `read_url` reads one public page with no cookies or credentials, renders a page that needs JavaScript in Browser Run, where the page can send only GET and HEAD requests to public hosts, and hands it to a reader with no tools, so the agent gets an answer about the page, labelled untrusted, never the page itself; `remember`, `recall` and `forget` keep short notes in the agent's own SQLite, never secrets; `now`, `date_math` and `calculate` do time zones, calendar arithmetic and exact decimal sums. All are ours, in `src/tools/`; Browser Run is the only service they use beyond the page itself.
- **Reminders and tasks on the agent's own alarm.** `remind_me`, `schedule_task`, `list_scheduled` and `cancel_scheduled` keep rows in the agent's SQLite, and the Durable Object's alarm runs each on time, with no page open. A reminder makes no model call; a task is a background turn with no extra powers, metered like any other. Only a turn the User's own message started can set or cancel one. Notifications go by Web Push, encrypted for each browser, only to the browsers' own push services.
- **Two ways to pay for the model.** An operator-paid demo through AI Gateway, capped per person and per domain before every call, or your own Anthropic or OpenAI key, sent straight to the vendor. Compaction keeps each request under about 200k tokens.
- **Regular tests run offline.** Five suites run with the model, the vendors, Google, GitHub and every Company faked, and every Poppy test fails if the strict mock Company records a violation or a warning. A second client in Python drives stateful Hypothesis tests of the mock, because a misreading our client and mock share is invisible to both.

The design is [pda-spec.md](pda-spec.md); how to use the agent and check it works is [docs/using.md](docs/using.md); each capability and tool, and where it comes from, is [docs/capabilities.md](docs/capabilities.md); why it is built this way is [docs/decisions.md](docs/decisions.md).

## Status and limitations

- **Live:** https://poppydemoagent.dev. Anyone with a Google or GitHub account can sign in (sign-up has been open since 15 October); the operator pays for the model only for the people on its demo list, and everyone else adds their own Anthropic or OpenAI key in Settings. The validator at `/validator`, open to anyone, and the privacy policy at `/privacy`. Web Push and Browser Run are switched on there. Which parts have been checked live, and which haven't, is [deployment-tasks.md §2](docs/deployment-tasks.md#2-live-checks).
- **One live Company at 0.3, not yet used.** printwithpoppy.com has declared 0.3 since 28 October, and its documents pass our validator; the agent hasn't been run there at 0.3. Of the 33 public Companies we check, it is the only one whose documents pass at 0.3 (29 October): the rest declare 0.1 or 0.2, which the agent refuses, or follow an earlier 0.3 draft ([ecosystem](docs/ecosystem.md#current-ecosystem)). At 0.2, on 12 October, print-with-poppy's store got as far as the upload's approval card.
- **Not tried live:** the demo lane has answered through the live gateway, but its gateway-side spend rules, a turn after a compaction, reminders and tasks firing, notifications on real devices, and a Browser Run render are tested only against fakes so far ([deployment-tasks.md](docs/deployment-tasks.md#2-live-checks)).
- **JavaScript:** `read_url` renders a page that needs it in Browser Run, signed out and read only. Browsing a Company's site in a Session (`poppy_browse`) still runs no JavaScript, so a site that needs it to show a page or send a form can't be used there.
- **Not built:** skills, web search, reminders by email, and "delete my agent" (today the operator deletes an agent by hand when asked, as the privacy policy promises).
- Everything still open is in [TODO.md](TODO.md).

Release notes and migration instructions: [CHANGELOG.md](CHANGELOG.md). Exact upstream inputs: [spec/upstream.json](spec/upstream.json). Upgrade procedure: [docs/upgrading.md](docs/upgrading.md).

## Run it yourself

Node.js 24 or later:

```sh
npm install --legacy-peer-deps   # agents declares many optional peers
npm test                         # five suites + documentation references; no external network
npm run typecheck
npm run check:docs               # standalone reference check; already included in npm test
npm run validate -- example.com  # the validator CLI
npm run interop -- --agents pda --companies lenient-company   # the grid, in Docker
```

To deploy your own copy, follow [docs/setup.md](docs/setup.md) in the order [docs/deployment-tasks.md](docs/deployment-tasks.md) gives.

## Project layout

```text
src/index.ts        Worker routes (chat, sign-in, Poppy identity, validator)
src/agent.ts        The per-person Durable Object
src/model-*.ts      Who pays for each model call: own keys (sealed), the demo and its caps
src/poppy/          The Poppy client, its tools, the fetch-based browser and the Activity log
src/tools/          The general tools: read_url, memory, time and maths, reminders and tasks
src/schedules.ts    Reminders and scheduled tasks on the Durable Object's alarm
src/web-push.ts     Web Push: VAPID, payload encryption, the push-service allowlist
src/ui/             The page: Chat, Activity, Companies, Settings
src/validator/      The validator: parser, primitives, profiles, fetch, HTTP, HTML
scripts/            The validator CLI, the deploy check, the docs check, the spec snapshot
test/               The suites, the fakes, the mock Company, the Hypothesis client
interop/            The interop runner, recording proxy, scenarios, adapters and cross-checks
spec/               Dated copies of the draft, and what each of our claims rests on
docs/               The user guide, decisions, capabilities, setup, spec issues, readings, interop, the ecosystem map, proposals
```

## Security, contributing and licence

- **Security:** report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes.
- **Contributing:** keep `npm test` (including its documentation reference check) and `npm run typecheck` passing. A new Poppy feature needs a test, and a check in the mock Company where the draft states a requirement. `git config core.hooksPath .githooks` turns on a pre-push typecheck.
- **Support:** report problems in [GitHub issues](https://github.com/adewale/pda/issues).
- **Licence:** [Apache License 2.0](LICENSE), the licence of the Poppy draft itself. Files copied from Cloudflare's `agents` examples keep their MIT licence, and the stored copies of the draft in `spec/` keep the draft's Apache 2.0 licence; see [NOTICE.md](NOTICE.md).
