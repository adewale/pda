# Durable Personal Agent

**Your own AI agent that can deal with companies for you, plus a validator that checks companies and agents are set up to work together.**

Sign in with Google or GitHub and chat with your own Claude Opus 5.5 agent. It keeps one conversation that survives reloads, crashes and deploys. It is also a reference Personal Agent for the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy), a draft standard for AI agents acting for people at companies: it finds a company that supports the protocol, has you sign in on the company's own page, talks to the company's agent and uses its APIs and website, and asks you before anything that changes your account. It runs on Cloudflare Workers, with one Durable Object per person.

The **Poppy Validator** checks the documents that make this work: a company's `poppy.json` and OAuth server metadata, and an agent's client metadata and keys. It is a web form, an HTTP API, a CLI and a library, and our agent uses it to decide which documents to trust.

## Status

Alpha. Poppy is Draft 0.1, published 9 October 2026, and may change incompatibly.

- **Live:** https://personal-agent.adewale-883.workers.dev (chat; sign-in is allowlisted) and https://personal-agent.adewale-883.workers.dev/validator (public).
- **Sign-in:** GitHub is configured; Google isn't registered yet. The demo lane's gateway has no credits yet, so model calls need your own key until it does.
- **Tested** against fakes, a strict mock Company, and other projects' implementations in containers; **not yet** against a production Company, because none has published `poppy.json`.
- **What's left** to deploy and check is in [`docs/deployment-tasks.md`](docs/deployment-tasks.md).

## Read next

- [`durable-personal-agent-spec.md`](durable-personal-agent-spec.md): what is built and how, with Appendix A mapping every Poppy requirement to the code and the test that checks it.
- [`docs/decisions.md`](docs/decisions.md): why it's built that way, and what was considered instead.
- [`docs/setup.md`](docs/setup.md) and [`docs/deployment-tasks.md`](docs/deployment-tasks.md): deploying your own copy.

## Quick start

Check a live company from your terminal:

```sh
curl -s https://personal-agent.adewale-883.workers.dev/validator/api \
  -H 'Content-Type: application/json' \
  -d '{"url": "poppy-receiver.roundtrip.workers.dev"}' | jq '{outcome, counts}'
```

```json
{
  "outcome": "valid",
  "counts": { "error": 0, "warning": 0, "info": 1 }
}
```

Or open https://personal-agent.adewale-883.workers.dev/validator?url=poppy-receiver.roundtrip.workers.dev to see the same report as a page.

Work on the code (Node.js 24 or later, the LTS line `.nvmrc` names):

```sh
npm install --legacy-peer-deps   # agents declares many optional peers
npm test                         # five suites; nothing calls the network
npm run typecheck
npm run check:docs               # every test the docs name exists
npm run deps:check               # outdated packages and npm audit; fails only on high or critical
npm run validate -- poppy-receiver.roundtrip.workers.dev   # the validator CLI
```

Deploy your own: [`docs/setup.md`](docs/setup.md), in the order [`docs/deployment-tasks.md`](docs/deployment-tasks.md) gives.

## What we built and why

- **One agent per person.** Each signed-in identity gets its own Durable Object running Pi, holding its conversation, tokens and keys in its own SQLite, so one person's agent can't reach another's and work survives crashes and deploys.
- **Sign-in and allowlists.** Google and GitHub OAuth in the Worker, because Cloudflare Access rejects the chat's WebSocket; `OWNERS`, `SIGNIN_ALLOWLIST` and `SIGNUP` say who may sign in, from an untracked file, so a fork names nobody.
- **The Poppy client** (`src/poppy/`): discovery through the validator, Sessions with DPoP, all three sign-in types and Account Tokens, so the agent can act at a Company as the protocol intends, with every Personal Agent MUST mapped to a test.
- **Conversations** with a Company's agent, read in the background with streaming, handoff to a person and Direct Conversations, because the Company Agent is how most tasks will get done.
- **APIs and operations with approval.** OpenAPI and MCP calls, and the Operations extension; nothing that changes your account happens without your approval on the page or a standing permission you set, because Company text can't be trusted to ask.
- **Website browsing** on a fetch-based browser with no JavaScript, for Companies whose site is the only way in; every form it would send waits for your approval of exactly what it sends.
- **The page:** Chat with a "needs you" tray, Activity, Companies and Settings, so you can see what the agent did, where, with what access, and who decided.
- **Model access in two lanes:** an operator-paid demo on AI Gateway, capped per person and per domain before every call, and your own Anthropic or OpenAI key, sent straight to the vendor, so the operator's bill has a ceiling and nobody else pays for your use.
- **The discovery validator**, with stable message ids, explanations and an `indeterminate` outcome, because implementations needed a shared answer to "is this document right?" (the W3C Feed Validator's lesson).
- **The strict mock Company** (`test/mock-company/`), because no real Company exists: it checks everything our client sends, every check has a named violation and a test proving it fires, and every Poppy test must leave none.
- **The interop harness** (`interop/`): every agent against every Company in containers, through a recording proxy, with each failure blamed on a side by a named rule; and **adversarial testing**, malicious peers run only against our own implementations, because passing our own mock proves only our own reading.
- **Five test suites and a second client.** Workers, durability, page, interop and property tests ([the spec's table](durable-personal-agent-spec.md#testing-and-conformance)), plus an independent Python client driving a Hypothesis stateful test of the mock, because a misreading our client and mock share is invisible to both.
- **[Spec issues](docs/spec-issues.md) and [readings](docs/readings.md):** the draft's problems with suggested fixes, and the reading we chose for each open question and why, so they can go to the draft's authors.
- **[Proposals](docs/proposals/)** for Poppy support in OpenClaw and Hermes Agent, unposted drafts, because a protocol needs more than one Personal Agent.

## The validator

- **Severity.** An `error` breaks a MUST, so conforming agents refuse the document; a `warning` is a SHOULD or an interoperability hazard; an `info` is harmless.
- **Explanations.** Each message has a stable id and a page saying what it means and how to fix it ([all messages](https://personal-agent.adewale-883.workers.dev/validator/messages)).
- **Outcome.** `valid`, `invalid`, or `indeterminate` when a document couldn't be fetched.

A domain checks the company's `poppy.json` and its OAuth server metadata; a URL is taken as a Personal Agent's `client_id`, which checks its client metadata and key set.

```sh
npm run validate -- https://personal-agent.adewale-883.workers.dev/poppy/client.json   # an agent
npm run validate -- ./poppy.json --domain example.com                                   # a local file
cat jwks.json | npm run validate -- --kind jwks -                                        # standard input
npm run validate -- example.com --json                                                  # the JSON report
```

Exit status `0` valid, `1` invalid, `2` couldn't check; `--strict` fails on warnings too; `--help` lists every option.

| Request | Answer |
| --- | --- |
| `GET /validator?url=example.com` | The results page, so you can link to it |
| `POST /validator/api` with `{"url": "example.com"}` | The JSON report |
| `POST /validator/api` with `{"document": "…", "kind": "poppy", "domain": "example.com"}` | The JSON report for a pasted document (`kind`: `poppy`, `oauth-metadata`, `client-metadata` or `jwks`) |
| `GET /validator/messages` | What each message means, and the report's format |

The API accepts any origin and uses no cookies; URL checks are limited to 20 a minute per address, documents to 100 KB. As a library, `validateCompany`, `validateClient`, `validateText` and `validateTarget` in `src/validator/` run in the Worker, Node and the tests alike. How rules are versioned is in the spec.

## Limitations

- **No production Company tested yet.** The client has run against our mock and the Companies of six other projects, which are SDKs, demos or signed-out.
- **No JavaScript in browsing.** A site that needs JavaScript to show its pages or send its forms can't be browsed.
- **Model lanes not tried live:** the vendors, Unified Billing and the gateway's spend rules are faked in the tests ([deployment-tasks.md](docs/deployment-tasks.md), "Live checks").
- **The validator** checks documents, not behaviour, and checks host names, not the addresses they resolve to.
- **Not built:** memory and skills (milestone 2).

## Other implementations

[`docs/implementations.md`](docs/implementations.md) surveys every public Poppy implementation we found on 11 October 2026: Datalayer's SDK, poppyseed, pi-poppy, adonis-agora, poppy-demo, everruns, Ilmer and others, with licences, maturity and live deployments. The ones our harness runs are in [`interop/registry.json`](interop/registry.json): six other projects, plus everruns' adapters (written, not yet run) and a README for a TYPO3 Company whose extension is private. What we found in them is in [`docs/poppy-issues.md`](docs/poppy-issues.md), and a snapshot of the last full grid in [`docs/interop-results/`](docs/interop-results/README.md).

## Project layout

```text
src/index.ts        Worker routes (chat, sign-in, Poppy identity, validator)
src/agent.ts        The per-person Durable Object
src/model-*.ts      Who pays for each model call: own keys (sealed), the demo and its caps
src/poppy/          The Poppy client, its tools, the fetch-based browser and the Activity log
src/ui/             The page: Chat, Activity, Companies, Settings
src/validator/      The validator: parser, primitives, profiles, fetch, HTTP, HTML
scripts/            The validator CLI, the deploy check, the docs check, the secrets generator
test/               The suites, the fakes, the mock Company, the Hypothesis client
interop/            The interop runner, recording proxy, scenarios and adapters
docs/               Decisions, setup and deployment tasks, spec issues and readings, interop, proposals
deployment.*.json   The deployer's own vars: an example here, the real ones untracked
```

## Support, contributing and license

- **Support:** this is a private repository for its collaborators. Report problems with [GitHub issues](https://github.com/adewale/dpa/issues).
- **Security:** report a vulnerability privately, as [`SECURITY.md`](SECURITY.md) describes. It also sets out how we disclose what interop and adversarial testing finds in other projects: to their maintainers, privately, first.
- **Contributing:** keep `npm test`, `npm run typecheck` and `npm run check:docs` passing. A new Poppy feature needs a test, and a check in the mock Company where the spec has a MUST. `git config core.hooksPath .githooks` turns on a pre-push typecheck.
- **License:** no license has been chosen yet. Files copied from Cloudflare's `agents` examples keep their MIT license; see [`NOTICE.md`](NOTICE.md).
