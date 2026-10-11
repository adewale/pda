# Durable Personal Agent

**Your own AI agent that can deal with companies for you, plus a validator that checks companies and agents are set up to work together.**

Sign in with Google or GitHub and chat with your own Claude Opus 5.5 agent. It keeps one conversation that survives reloads, crashes and deploys. It's also a Personal Agent for the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy), a draft standard for AI agents acting for people at companies. The agent can:

- find a company that supports the protocol;
- have you sign in on the company's own page;
- talk to the company's agent, and use its APIs and website;
- ask you before anything that changes your account.

It runs on Cloudflare Workers, with one Durable Object per person.

The **Poppy Validator** checks the documents that make this work: a company's `poppy.json` and OAuth server metadata, and an agent's client metadata and keys. Use it as a web form, an HTTP API, a CLI or a library. Our agent uses it too, so it only ingests documents that pass.

- **Live:** https://personal-agent.adewale-883.workers.dev (chat), https://personal-agent.adewale-883.workers.dev/validator (validator)
- **Status:** alpha. Poppy is Draft 0.1, published 9 Oct 2026, and may change incompatibly. Chat sign-in isn't live yet (see [Limitations](#limitations)); the validator is.
- **Design:** [`durable-personal-agent-spec.md`](durable-personal-agent-spec.md)

## Contents

- [Quick start: validate a company](#quick-start-validate-a-company)
- [The validator](#the-validator)
- [The agent](#the-agent)
- [Develop](#develop)
- [Cloudflare services](#cloudflare-services)
- [Other implementations](#other-implementations)
- [Limitations](#limitations)
- [Project layout](#project-layout)
- [Support, contributing and license](#support-contributing-and-license)

## Quick start: validate a company

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

## The validator

It follows the lessons of the W3C Feed Validator:

- **Severity.** An `error` breaks a MUST in the spec, so conforming agents refuse the document. A `warning` is a SHOULD, or something that stops some agents working with it. An `info` is harmless, such as a field this version doesn't define.
- **Explanations.** Each of the 71 messages has a stable id and a page saying what it means and how to fix it ([all messages](https://personal-agent.adewale-883.workers.dev/validator/messages)).
- **Outcome.** A report is `valid`, `invalid`, or `indeterminate` when a document couldn't be fetched.
- **Location.** Each message gives a JSON Pointer, a line and column when known, and the section of the spec it comes from.

A domain checks the company's `poppy.json`, then its OAuth server metadata, including whether the metadata's `issuer` and `poppy_domains` match. A URL is taken as a Personal Agent's `client_id`, which checks the client metadata and the key set at its `jwks_uri`.

### CLI

Needs Node.js 22.18 or later, which runs TypeScript directly.

```sh
npm run validate -- poppy-receiver.roundtrip.workers.dev
```

```text
https://poppy-receiver.roundtrip.workers.dev/.well-known/oauth-authorization-server:1:1: info [metadata-iss-parameter] authorization_response_iss_parameter_supported isn't true. at /authorization_response_iss_parameter_supported (RFC 9207 §3)
valid (Draft 0.1): 0 errors, 0 warnings, 1 info
```

More ways to run it:

```sh
npm run validate -- https://personal-agent.adewale-883.workers.dev/poppy/client.json   # an agent
npm run validate -- ./poppy.json --domain example.com                                   # a local file
cat jwks.json | npm run validate -- --kind jwks -                                        # standard input
npm run validate -- example.com --json                                                  # the JSON report
```

- **Exit status:** `0` valid, `1` invalid, `2` couldn't check.
- **`--strict`:** warnings fail too.
- `--help` lists every option.

### HTTP API and form

| Request | Answer |
| --- | --- |
| `GET /validator` | The form: paste a document, or give a domain or URL |
| `GET /validator?url=example.com` | The results page, so you can link to it |
| `POST /validator/api` with `{"url": "example.com"}` | The JSON report |
| `POST /validator/api` with `{"document": "…", "kind": "poppy", "domain": "example.com"}` | The JSON report for a pasted document |
| `GET /validator/messages` | What each message means, and the report's format |

- **`kind`:** `poppy`, `oauth-metadata`, `client-metadata` or `jwks`.
- **Access:** the API accepts requests from any origin and uses no cookies.
- **Limits:** URL checks are limited to 20 a minute per address, and documents to 100 KB.

### Library

```ts
import { validateCompany } from "./src/validator/index.ts";

const report = await validateCompany((request) => fetch(request), "poppy-receiver.roundtrip.workers.dev");
console.log(report.outcome, report.counts); // valid { error: 0, warning: 0, info: 1 }
```

Other functions:

- `validateText(kind, text, options)` checks one document.
- `validateClient(fetcher, url)` checks an agent.
- `validateTarget(fetcher, input)` works out which check to run from what you give it.

`src/validator/` doesn't use Worker APIs, so the same code runs in the Worker, in Node and in the tests.

### Spec versions

Rules live in one profile per major protocol version, built from shared primitives such as HTTPS URL, scope and host-name checks.

- `poppy.json` declares its version in `protocol_version`, which picks the profile.
- A newer minor version is checked with the newest rules, and its new fields are ignored, as the spec says.
- An unknown major version is reported, not guessed at.

To support a new version, add `src/validator/profiles/draft-N.ts`: reuse the rule functions that still apply, replace the ones that changed, and register it in `profiles/index.ts`. Older profiles stay, so documents that still declare an old version are checked by its rules.

## The agent

### Who can sign in

Your own `deployment.local.json` decides; it is untracked, so the repository names nobody. Copy [`deployment.example.json`](deployment.example.json), fill it in, and run `npm run deploy`, which stops if the file is missing. Someone you remove is locked out on their next request.

```jsonc
{
  "OWNERS": { "emails": ["you@example.com"], "github": { "your-login": 1234567 } },  // always in, always on the demo
  "SIGNIN_ALLOWLIST": {                                     // who may sign in while SIGNUP is "allowlist"
    "emails": ["friend@example.com"],                       // Google accounts with this verified email
    "domains": ["your-company.example"],                    // anyone in this Google Workspace
    "github": { "their-login": 7654321 }                    // login: numeric id
  },
  "DEMO_ALLOWLIST": { "emails": [], "domains": [], "github": {} },  // who you pay model calls for
  "PUBLIC_ORIGIN": "https://personal-agent.your-subdomain.workers.dev",
  "POPPY_LOGO_URI": "https://personal-agent.your-subdomain.workers.dev/logo.svg"
}
```

- **`SIGNUP`** in `wrangler.jsonc` is `allowlist`. Set it to `open` to let anyone with a Google or GitHub account in; they then need their own model key unless they are on `DEMO_ALLOWLIST`.
- **GitHub accounts** are matched by numeric id, because logins can change hands. Get one with `gh api users/<login> --jq .id`.
- **Emails and domains** apply to Google sign-in only.
- **A domain** matches Google Workspace accounts only, not a personal Google account that uses a work address.
- **Google and GitHub** sign-ins are separate agents.

### Who pays for the model

- **Your own key, first.** Paste an Anthropic or OpenAI key in Settings, or connect OpenRouter. The agent checks it with the vendor, encrypts it, and sends it only to that vendor, never through the deployment's AI Gateway. It is never shown again. Whoever runs the deployment can technically read it, so prefer a spend-limited key; an OpenRouter key with a credit limit is safest.
- **A refused key stops the agent.** A 401 marks the key invalid and the agent stops calling the model until you add another; it never falls back to the demo.
- **The demo,** for `OWNERS` and `DEMO_ALLOWLIST`: the operator pays through an AI Gateway on Unified Billing, up to `DEMO_DAILY_USD_PER_USER` per person and `DEMO_DAILY_USD_PER_DOMAIN` per Google Workspace domain each UTC day. The agent checks both before every call, background work included; Settings shows today's spend.
- **Otherwise the agent needs a key** and makes no model calls. Updates from Companies wait until it has one.

### How sign-in works

- **Providers.** Sign-in is Google or GitHub OAuth with PKCE, run inside the Worker. Cloudflare Access isn't used.
- **Session.** Afterwards the Worker sets a signed `__Host-session` cookie: HttpOnly, Secure, SameSite=Lax, valid for 30 days.
- **Your agent.** Each person gets their own Durable Object running Pi through Cloudflare's Agents SDK, with Claude through AI Gateway.

### What the agent does with companies

The Poppy client in `src/poppy/` implements every part of Draft 0.1 that a Personal Agent needs, plus the Operations extension. Appendix A of the [spec](durable-personal-agent-spec.md) maps each requirement to the code and the test that checks it.

**Your secrets stay away from the model.** It never sees tokens, keys or passwords. It also can't approve an action by itself: approval comes from a button on the page, or a standing permission you set.

### The app

The app has four places:

- **Chat** opens with a pinned **Needs you** tray: approvals, sign-ins, invitations to talk to a company yourself. The tray's count also shows in the tab title. Each company action in the conversation reads as one line, such as "Read your orders at Manzanita · API · view access".
- **Activity** shows what's in progress, each item with a way to stop it, and a log of everything the agent did at companies: where, how, with what access, who decided, and the result.
- **Companies** lists your connected accounts, the access each has, and the standing permissions you've given.
- **Settings** has your account, your model key or the demo with today's spend, the theme and the agent's public identity. While the agent can't call a model, a banner on every page says why.

## Develop

**Prerequisites:**

- Node.js 22.18 or later, with npm.
- A Cloudflare account with Wrangler signed in (`npx wrangler login`).
- To deploy your own copy: a `deployment.local.json`, Google and GitHub OAuth apps, and, for the demo, an AI Gateway on Unified Billing ([setup guide](docs/setup.md)).

```sh
npm install --legacy-peer-deps   # agents declares many optional peers
npm test                         # five suites: Workers, durability, page, interop harness, properties
npm run typecheck
npm run check:docs               # every test the spec's Appendix A names exists
npm run interop                  # the interop grid in Docker (interop/README.md)
npm run deploy
```

**Before a push.** `.githooks/pre-push` runs `npm run typecheck` (about 5 seconds) and stops the push if it fails; CI runs the rest. Turn it on once per clone with `git config core.hooksPath .githooks`; `git push --no-verify` skips it.

CI runs typecheck, the tests and the docs check on pushes to `main` and on pull requests (`.github/workflows/ci.yml`). The interop grid for our agent against our mock Company runs there too, when a change touches the Poppy client, the validator, the mock Company, `interop/` or the dependencies (`.github/workflows/interop.yml`).

**What the tests cover:**

- **Sign-in:** app sign-in against fake Google and GitHub that check PKCE and can refuse: a wrong audience, issuer or expiry, an unverified email, a broken GitHub profile. Also the allowlist on every route.
- **Model access:** against fake Anthropic, OpenAI and OpenRouter. A key never appears in a response, frame, transcript, Activity row, log or storage in the clear; a sealed key opens only in its own agent; an own key beats the demo; the demo's caps are enforced before the call, per person and per domain, background turns included; a 401 stops calls with no fallback; OpenRouter's sign-in checks `state` and the PKCE verifier. Another test fails if an author host or identity enters the template.
- **The agent:** the durable conversation, including after a crash. That test has its own runtime, so it can't reset objects other tests are using.
- **Poppy:** conformance tests against a strict mock Company.
  - Each of the mock's checks has an id and a test that proves it fires.
  - An after-each hook fails any test that triggers a check it didn't declare.
  - Sign-in, Sessions and sign-out also run under six readings of the draft's open questions.
  - A frozen clock makes Retry-After, device polling and slow operations instant.
- **Validator:** fixtures declared as data, with a test that every message has one. They include the spec's own examples and poppy-demo's live documents.
- **JSON parsers:** property tests against `JSON.parse`.
- **Page:** the four places, the needs-you tray, cards, the Activity log (no secrets ever reach it), and the sign-in page, in happy-dom.
- **Browsing:** the production fetch-based browser, against the mock Company's website and stub fetchers: the Session join, a cookie jar per User and Session, redirects, size and time limits, forms, and the approval a form needs.
- **Interop harness:** its scenario interpreter, trace checks, attribution and report, in Node.

The model vendors, Google, GitHub and Companies are faked; nothing calls the network.

**Interop.** `npm run interop` runs every agent against every Company in containers, over HTTPS through a recording proxy, and writes a grid with each failure blamed on a side by a named rule ([`interop/README.md`](interop/README.md), [`docs/interop-spec.md`](docs/interop-spec.md)). Our agent there is `src/poppy` driven directly, with no model; our Company is the mock, registered twice: lenient as the reference, and strict. Adapters for seven other projects let their agents and Companies meet ours and each other's. Docker is needed.

## Cloudflare services

| Service | Used for |
| --- | --- |
| Workers and Static Assets | Routes, sign-in, the chat page, the validator |
| Durable Objects (SQLite) | One agent per person; per-company rate limits |
| AI Gateway (`AI` binding) | The demo: Claude Opus 5.5, paid by the operator |
| Rate Limiting | The validator's URL checks |

**Cost:** the operator pays for demo calls through AI Gateway's Unified Billing, capped per person and per domain each day; everyone else pays their vendor with their own key. Every agent created also costs the operator storage, more so with `SIGNUP=open`. We haven't checked whether the rest fits the Workers free plan.

## Other implementations

Poppy implementations we know of, as of 11 Oct 2026. All were days old. [`docs/implementations.md`](docs/implementations.md) has the full survey: licences, maturity, live deployments, validators, and related projects that aren't implementations.

| Project | Side | Language |
| --- | --- | --- |
| [datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol) | SDK for both sides, with reference Companies | Python, TypeScript |
| [akshay5995/poppyseed](https://github.com/akshay5995/poppyseed) ([withpoppyseed.dev](https://withpoppyseed.dev)) | Company library for Next.js, with a conformance suite | TypeScript |
| [DavideCarvalho/adonis-agora-authkit](https://github.com/DavideCarvalho/adonis-agora-authkit) | Company OAuth server for AdonisJS | TypeScript |
| [DavideCarvalho/adonis-agora-agent](https://github.com/DavideCarvalho/adonis-agora-agent) | Company conversations, and a Personal Agent library | TypeScript |
| [irvinebroque/poppy-demo](https://github.com/irvinebroque/poppy-demo) | Demo Company and Personal Agent on Workers | TypeScript |
| [richardanaya/pi-poppy](https://github.com/richardanaya/pi-poppy) | Personal Agent extension for the pi coding agent | TypeScript |
| [everruns/everruns](https://github.com/everruns/everruns) | Both sides, signed-out only | Rust |
| [rbirkby/Ilmer.org](https://github.com/rbirkby/Ilmer.org) ([poppy.ilmer.org](https://poppy.ilmer.org/.well-known/poppy.json)) | Signed-out Company on Workers | TypeScript |
| [futurebasicsrepo-client-hub-api `spot/`](https://github.com/futurebasicsrepo/futurebasicsrepo-client-hub-api/pull/160) ([spotmeplease.com](https://spotmeplease.com/.well-known/poppy.json)) | Company: a cart-approval and payment product, MCP with Bearer tokens | JavaScript |
| [introspection-js-sdk `examples/pap-travel`](https://github.com/introspection-org/introspection-js-sdk/pull/441) | Demo of both sides (pull request open) | TypeScript |
| [dirnbauer/webconsulting-typo3-lab](https://github.com/dirnbauer/webconsulting-typo3-lab) | Minimal signed-out Company (the extension itself is private) | PHP |

[`docs/poppy-issues.md`](docs/poppy-issues.md) lists the issues we found in them and what we changed in our own client as a result. [`docs/spec-issues.md`](docs/spec-issues.md) lists 65 problems in the specification itself, with suggested fixes ([`docs/readings.md`](docs/readings.md) records which reading we chose for each open question, and why), [`docs/interop-testing.md`](docs/interop-testing.md) designs testing every agent against every Company, [`interop/`](interop/README.md) runs it, and [`docs/interop-results/`](docs/interop-results/README.md) summarises the last full grid (a snapshot; the full results aren't committed). [`docs/conformance-testing-history.md`](docs/conformance-testing-history.md) traces where pirate testing and interop runners came from, [`docs/adversarial-interop.md`](docs/adversarial-interop.md) designs deliberately misbehaving peers, and [`docs/proposals/`](docs/proposals/) holds unposted drafts proposing Poppy support in OpenClaw and Hermes Agent.

## Limitations

- **Chat sign-in isn't live** until the Google and GitHub OAuth apps are registered and AI Gateway billing is set up; see [`docs/setup.md`](docs/setup.md). The validator works without either.
- **No production Company tested yet.** The Poppy client has run against our mock and, in the [interop grid](docs/interop-results/README.md), against the Companies of six other projects, which are SDKs, demos or signed-out. No business has published `poppy.json`.
- **No JavaScript in browsing.** The agent browses a company's website with its own fetch-based browser: plain HTTPS requests, pages read as text, links and forms. A site that needs JavaScript to show its pages or send its forms can't be browsed. The browser has been tested against the mock Company's website, not a real one.
- **Validator limits:**
  - It checks documents, not behaviour: it can't tell whether a token endpoint works.
  - It checks the host name, not the IP address a name resolves to, so it can't refuse a name that points at a private address. The Guides ask for that check.
  - "Same domain" for an agent's `jwks_uri` accepts the same host or a parent or child host, because the spec doesn't define it.
- **Not built yet:** memory and skills (milestone 2).
- **Model keys and the demo aren't tried live yet:** the vendors, Unified Billing, the gateway's spend rules and OpenRouter's sign-in are faked in the tests (the spec's Model access lists what to check).

## Project layout

```text
src/index.ts        Worker routes (chat, sign-in, Poppy identity, validator)
src/agent.ts        The per-person Durable Object
src/model-*.ts      Who pays for each model call: own keys (sealed), the demo and its caps
deployment.*.json   The deployer's own vars: an example here, the real ones untracked
src/ui/             The page: Chat, Activity, Companies, Settings
src/poppy/          The Poppy client, its tools, its UI messages and the Activity log
src/validator/      The validator: parser, primitives, profiles, fetch, HTTP, HTML
scripts/            The validator CLI and the secrets generator
test/               Tests and the mock Company
interop/            The interop runner, recording proxy, scenarios, adapters, and a runner for Datalayer's vectors
docs/               Setup guide; spec problems; issues in other implementations; interop design and harness spec
```

## Support, contributing and license

- **Support:** this is a private repository for its collaborators. Report problems with [GitHub issues](https://github.com/adewale/dpa/issues).
- **Security:** report a vulnerability privately, as [`SECURITY.md`](SECURITY.md) describes. It also sets out how we disclose what interop and adversarial testing finds in other projects: to their maintainers, privately, first.
- **Contributing:** pull requests should keep `npm test` and `npm run typecheck` passing. A new Poppy feature needs a test, and a check in the mock Company where the spec has a MUST.
- **License:** no license has been chosen yet. Files copied from Cloudflare's `agents` examples keep their MIT license; see [`NOTICE.md`](NOTICE.md).
