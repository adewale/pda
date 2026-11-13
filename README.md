# Poppy Demo Agent

**A Personal Agent for [Poppy](https://personalagentprotocol.org/), the Personal Agent Protocol, built alongside the tools we used to test it: a validator, a strict mock Company, an interop harness, and written-up spec issues for each draft.** It is for the draft's authors and for people implementing either side of the protocol.

Poppy is a draft standard. PDA speaks **0.4**, the 1.0 release candidate published on 10 November 2026 and retrieved on 11 November, and beside it the **1.0 draft** retrieved on 13 November ([decision 51](docs/decisions.md#51-10-beside-04), not yet deployed); it dropped 0.3 on 12 November ([decision 49](docs/decisions.md#49-03-dropped-the-agent-mock-validator-and-interop-speak-04-alone)), and 0.1 and 0.2 on 28 October ([decision 37](docs/decisions.md#37-03-alone-what-dropping-01-and-02-overturns-and-settles)) ([changelog](CHANGELOG.md), [upgrade procedure](docs/upgrading.md)). This project's agent runs on Cloudflare Workers with one Durable Object per person and Claude Sonnet 5.5 through Pi. It finds a Company that publishes `poppy.json`, names a Session on every request with a signed `Poppy-Session` header, has you sign in on the Company's own page when it needs your account, talks to the Company's agent, calls its APIs, and asks you on the page when the Company returns an operation for approval. The status is alpha. At 0.1 and 0.2 the deployed agent signed in and out at one live Company, Alpine Retail, a colleague's test store (13 and 14 October), and got as far as asking to upload a photo at print-with-poppy's live store (12 October) ([live evidence](docs/history/live-0.2-testing.md)). The [current verification report](docs/poppy-0.4-conformance.md#current-verification) records the 0.4 checks and live limits; the [0.3 review](docs/poppy-0.3-conformance.md) keeps 0.3's independent demo evidence.

## Components and supported Poppy versions

The implementation follows the 0.4 text retrieved on **11 November 2026**, matching upstream commit `ed47408` ([snapshot](spec/draft-0.4-retrieved-2026-11-11/README.md)), and the 1.0 draft retrieved on **13 November 2026**, at `bb98332` ([snapshot](spec/draft-1.0-retrieved-2026-11-13/README.md)). [spec/upstream.json](spec/upstream.json) pins the snapshot and its hashes; `npm run spec:drift` reports later changes. The [conformance review](docs/poppy-0.4-conformance.md) distinguishes implementation, independent checks and live verification. The requirement ledger does not certify full conformance.

| Component | Poppy versions | What it does |
| --- | --- | --- |
| [PDA application and client](pda-spec.md) | 0.4, 1.0 | Signs in to Companies, uses their APIs, conversations and websites, and asks for approval of the Company's exact terms when it returns an operation (Operations 3), unless a standing instruction you wrote covers them; selected task photos upload without another permission click; unselected files need disclosure consent |
| [Document validator](docs/validator.md) | 0.4, 1.0 | Checks Company discovery, OAuth and protected resource metadata, client metadata and keys. One library backs the web form, HTTP API and CLI |
| [Reference/mock Company](interop/README.md#the-fake-implementations) | 0.4, 1.0 | Serves Company endpoints and records violations. Tests select lenient, strict, deliberately flawed or adversarial behavior |
| [Fake test Personal Agents](interop/README.md#the-fake-implementations) | 0.4 | Exercise Companies with lenient, strict or sloppy behavior; the restored malicious agent sends mutated 0.4 requests to our own mocks |
| [Interop harness](docs/interop-spec.md) | 0.4 | Runs agent/Company pairs in isolated containers, records exchanges and reports failures by protocol rule. Its 0.1 and 0.2 peers and lanes are retired ([§14](docs/interop-spec.md#14-retired-with-01-and-02)), and its 0.3 pairing with print-with-poppy ([decision 49](docs/decisions.md#49-03-dropped-the-agent-mock-validator-and-interop-speak-04-alone)) |
| Independent client tests | 0.4 | A [Python client and Hypothesis model](test/hypothesis/README.md) of the mock, written apart from `src/poppy` so a misreading both share can show |
| Specification snapshots and the requirement ledgers ([0.4](docs/poppy-0.4-upgrade.md), [1.0](docs/poppy-1.0-upgrade.md)) | 0.4, 1.0 | Preserve upstream text, and give each changelog entry a disposition with its code and evidence; [0.3's](docs/poppy-0.3-upgrade.md) are kept as history |

PDA uses the document validator during discovery, and the fake agents wrap PDA's client. The [ecosystem map](docs/ecosystem.md#current-ecosystem) records observation dates and tested revisions separately for source reviews, grids and live journeys.

## See it work: ordering a print

[print-with-poppy](https://github.com/spenciefy/print-with-poppy) is a photo-printing store built for agents, and it was our demo because its code isn't ours. It moved to 0.3 on 28 October (`b340741`), and on 29 October our validator found printwithpoppy.com's documents valid at 0.3. It moved to 0.4 on 12 November (`ae453ed`): our validator finds its production and sandbox documents valid at 0.4, and it is an interop pairing again ([interop spec §15](docs/interop-spec.md#15-retired-with-03)). At `ae453ed` its API refused our Session JWTs, because it read their delegation from `pap_dlg`, a name from the 28 October text ([details](docs/interop-spec.md#print-with-poppy-delegation)); it reads `poppy_dlg` since `bd1dc43` the same day, and our agent passes all ten of its interop scenarios there and at `20a3d56`, which writes approval amounts in whole units ([results](docs/interop-results/README.md#print-with-poppy-at-04)). Repeatable checks use our strict mock Company's print shop, not a real checkout (`test/print-journey.test.ts`). A real order is not a harmless interface test.

| Step | You or the agent | Spec | On the page | Status |
| --- | --- | --- | --- | --- |
| 1 | You attach a photo, select its Company and upload permission in the composer, and ask: "Print this as a 6×4 at the print shop" | | Chat, with the photo | Works in tests |
| 2 | The agent fetches `poppy.json`, the domain's protected resource metadata and the OAuth metadata, and the validator checks them | §3 | Activity: discovery and its verdict | Works in tests |
| 3 | Every request names its Session in a `Poppy-Session` header, signed with a delegated key; signed out, that's all it carries | §5.2 | Activity: the Session | Works in tests |
| 4 | It reads the store's OpenAPI catalog and uploads the photo you selected for this task, without asking again | §7 | An upload step in the chat | Works in tests |
| 5 | It requests the order; the store answers `approval_required` with its price and terms | Operations 3, §4 | One approval card with the store's terms and total | Works in tests |
| 6 | You approve the terms; the agent sends the same order with `Poppy-Approval`, and the store returns the order and its checkout link | Operations 3, §6 | A receipt with the store's answer | Works in tests |

Every step's exchanges also appear in Activity's protocol log, with their spec sections, and can be copied as text for an interop report.

At 0.2, on 12 October, the owner's deployed agent got as far as step 4 at printwithpoppy.com, which takes real payments: it started a signed-out Session, read the catalogue and asked to send a 3.7 MB photo ([what happened](docs/history/poppy-issues.md#print-with-poppy-spenciefyprint-with-poppy)).

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
- Tasks on a schedule: "Every weekday at 9, check whether my print order has shipped." The agent does it in the background and tells you; a Company's operation still waits for your approval of its exact terms. Settings lists every reminder and task, with Cancel.

**You stay in control**

- Requests run for the task you asked for; routine requests may complete without another click.
- When a Company asks for approval, you see its exact terms and decide on the page. No model tool can approve them.
- Activity shows what the agent did, where and with what access, and every protocol exchange behind it.
- Your agent contacts only the Companies you list in the composer, which stay selected until you change them. Domain names in a message grant nothing.
- Photos explicitly selected for a Company in the composer can upload there for that message without another disclosure click. Prose references alone grant no permission. An unselected saved photo still needs disclosure consent.

**Pay for the model your way:** the operator's daily demo allowance if you're on its list, or your own Anthropic or OpenAI key.

**Your agent's local state** lives in its own storage; task information also goes to the model provider and relevant Companies. [The privacy policy](https://poppydemoagent.dev/privacy) says what is kept and for how long.

Signing in for the first time, with a run-through that checks each part works: [docs/using.md](docs/using.md). Which of these is a Poppy feature and which is ours, each tool the model can call, and what needs your approval: [docs/capabilities.md](docs/capabilities.md).

## For implementers: test against us

- **The validator** checks a Company's `poppy.json` and OAuth metadata, or an agent's client metadata and keys, from a web form, an HTTP API, a CLI or a library. Its severities follow each requirement's basis: a broken MUST is an error, a departed SHOULD a warning ([conformance-levels.md](docs/conformance-levels.md)). Reference: [docs/validator.md](docs/validator.md).

  ```sh
  curl -s https://poppydemoagent.dev/validator/api \
    -H 'Content-Type: application/json' \
    -d '{"url": "your-company.example"}' | jq '{outcome, counts}'
  ```

- **Our agent as your peer.** Its `client_id` is `https://poppydemoagent.dev/poppy/client.json`. A Company that keeps an allowlist can add it, and we'll point the agent at you; Appendix A of [the spec](pda-spec.md) lists every requirement it implements and the test that checks it.
- **The interop harness** (`interop/`) pairs registered agents and Companies in isolated containers, records exchanges and attributes failures by protocol rule. [interop/README.md](interop/README.md) explains how to add a peer. [Current verification](docs/poppy-0.4-conformance.md#current-verification) owns the evidence and limits; [dated grid reports](docs/interop-results/README.md) preserve historical runs.
- **Adversarial testing.** A malicious Company attacks our agent: oversized documents, nonce loops, forged messages and more ([docs/adversarial-interop.md](docs/adversarial-interop.md)). The malicious agent exercises the 0.4 wire and actual effect counts. What an attack finds in another project's code goes to its maintainers privately first ([SECURITY.md](SECURITY.md)).
- **Official Company kit.** The pinned 0.4 kit's validator checks our mock in CI ([current verification](docs/poppy-0.4-conformance.md#current-verification)), and the [manual checklist review](docs/company-kit-review.md) of the 29 October kit checked our mock and hosted dummy Company's handlers independently. Raw failures, inconclusive results and skipped features remain visible. Earlier community-validator and Datalayer cross-checks remain [dated 0.1/0.2 evidence](docs/history/interop-testing.md#validator-cross-check).
- **Findings in your code** go to you privately first, as [SECURITY.md](SECURITY.md) describes. Nothing is posted to another project without the owner's approval.
- **What we need from you, and what we never do:** [docs/testing-with-us.md](docs/testing-with-us.md), the page to send a maintainer whose Company or agent we test: the identities to register, what the offline grid needs from your code, test accounts for signed-in tests.

## For the draft's authors: what we found

The [focused feedback batch](docs/proposals/poppy-feedback.md) is prepared for owner review and has not been sent. The [0.4 issue list](docs/poppy-0.4-issues.md) holds the current findings, and the [0.3 list](docs/poppy-0.3-issues.md) the earlier ones; [readings](docs/readings.md) records our choices where the text is ambiguous. The [requirement ledger](docs/poppy-0.4-upgrade.md#the-11-november-changelog-entry-by-entry) maps upstream changes to implementation and evidence.

The [ecosystem map](docs/ecosystem.md#current-ecosystem) owns dated peer observations. Historical surveys, audits and grid reports remain linked from their respective sources; their counts are not repeated here. [Plugin proposals](docs/proposals/README.md) are parked until submission is scheduled.

## Documentation sources

The [documentation index](docs/README.md) maps each guide and reference to the question it owns, and separates current guidance from [historical reports](docs/history/README.md). Link to the owning source instead of copying its status. Dated reports are frozen evidence; parked proposals are refreshed only immediately before submission.

## How it's built

- **One agent per person.** Each Google or GitHub sign-in gets its own Durable Object running Pi, with its conversation, Poppy state, tokens and keys in its own SQLite. One person's agent can't read another's, and work survives crashes and deploys.
- **Approval stays on the page.** Company text reaches the model labelled as information, never as approval. Task requests run normally; when the Company asks for approval (Operations 3's `approval_required`), its exact terms go on a card, and only your decision, or a standing instruction you wrote on the Companies page that a deterministic check matches to those exact terms, sends the stored request again with `Poppy-Approval`. Selected task photos need no redundant disclosure click; unselected photos and website forms keep local consent cards.
- **Secrets stay out of the model.** Access tokens, delegated keys and DPoP keys live only in memory; refresh tokens and pasted model keys are sealed with AES-GCM and bound to their row; the model's tools never take or return a credential.
- **General tools beside Poppy.** `read_url` reads one public page with no cookies or credentials, renders a page that needs JavaScript in Browser Run, where the page can send only GET and HEAD requests to public hosts, and hands it to a reader with no tools, so the agent gets an answer about the page, labelled untrusted, never the page itself; `remember`, `recall` and `forget` keep short notes in the agent's own SQLite, never secrets; `now`, `date_math` and `calculate` do time zones, calendar arithmetic and exact decimal sums. All are ours, in `src/tools/`; Browser Run is the only service they use beyond the page itself.
- **Reminders and tasks on the agent's own alarm.** `remind_me`, `schedule_task`, `list_scheduled` and `cancel_scheduled` keep rows in the agent's SQLite, and the Durable Object's alarm runs each on time, with no page open. A reminder makes no model call; a task is a background turn with no extra powers, metered like any other. Only a turn the User's own message started can set or cancel one. Notifications go by Web Push, encrypted for each browser, only to the browsers' own push services.
- **Two ways to pay for the model.** An operator-paid demo through AI Gateway, capped per person and per domain before every call, or your own Anthropic or OpenAI key, sent straight to the vendor. Compaction keeps each request under about 200k tokens.
- **Regular tests run offline.** Five suites run with the model, the vendors, Google, GitHub and every Company faked, and every Poppy test fails if the strict mock Company records a violation or a warning. A second client in Python drives stateful Hypothesis tests of the mock, because a misreading our client and mock share is invisible to both.

The design is [pda-spec.md](pda-spec.md); how to use the agent and check it works is [docs/using.md](docs/using.md); each capability and tool, and where it comes from, is [docs/capabilities.md](docs/capabilities.md); why it is built this way is [docs/decisions.md](docs/decisions.md).

## Status and limitations

[Current protocol verification](docs/poppy-0.4-conformance.md#current-verification) distinguishes local, independent-demo and live evidence. [Deployment tasks](docs/deployment-tasks.md) records what is deployed and what remains unverified live, including gateway spend enforcement, compaction, scheduling, notifications and Browser Run. [TODO](TODO.md) owns the product backlog.

Release notes and migration instructions: [CHANGELOG.md](CHANGELOG.md). Exact upstream inputs: [spec/upstream.json](spec/upstream.json). Upgrade procedure: [docs/upgrading.md](docs/upgrading.md).

## Run it yourself

Node.js 24 or later:

```sh
npm install --legacy-peer-deps   # agents declares many optional peers
npm test                         # five offline suites
npm run typecheck
npm run check:docs               # file/scenario links; no dependencies needed
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
- **Contributing:** keep `npm test`, `npm run check:docs` and `npm run typecheck` passing for code changes. Documentation-only changes need `npm run check:docs`. A new Poppy feature needs a test, and a check in the mock Company where the draft states a requirement. `git config core.hooksPath .githooks` turns on a pre-push typecheck.
- **Support:** report problems in [GitHub issues](https://github.com/adewale/pda/issues).
- **Licence:** [Apache License 2.0](LICENSE), the licence of the Poppy draft itself. Files copied from Cloudflare's `agents` examples keep their MIT licence, and the stored copies of the draft in `spec/` keep the draft's Apache 2.0 licence; see [NOTICE.md](NOTICE.md).
