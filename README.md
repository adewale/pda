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

The `ALLOWLIST` var in [`wrangler.jsonc`](wrangler.jsonc) decides. Edit it and run `npm run deploy`; someone you remove is locked out on their next request.

```jsonc
"ALLOWLIST": {
  "emails": ["adewale@gmail.com"],                         // Google accounts with this verified email
  "domains": ["sierra.ai"],                                // anyone in this Google Workspace
  "github": { "adewale": 43644, "ToddKerpelman": 4397978 } // login: numeric id
}
```

- **GitHub accounts** are matched by numeric id, because logins can change hands. Get one with `gh api users/<login> --jq .id`.
- **Emails and domains** apply to Google sign-in only.
- **A domain** matches Google Workspace accounts only, not a personal Google account that uses a work address.
- **Google and GitHub** sign-ins are separate agents.

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
- **Settings** has your account, the theme, the model and the agent's public identity.

## Develop

**Prerequisites:**

- Node.js 22.18 or later, with npm.
- A Cloudflare account with Wrangler signed in (`npx wrangler login`).
- To deploy your own copy: Google and GitHub OAuth apps, and AI Gateway billing ([setup guide](docs/setup.md)).

```sh
npm install --legacy-peer-deps   # agents declares many optional peers
npm test                         # three suites: Workers, durability, page
npm run typecheck
npm run check:docs               # every test the spec's Appendix A names exists
npm run deploy
```

CI runs typecheck, the tests and the docs check on every push (`.github/workflows/ci.yml`).

**What the tests cover:**

- **Sign-in:** app sign-in against fake Google and GitHub that check PKCE and can refuse: a wrong audience, issuer or expiry, an unverified email, a broken GitHub profile. Also the allowlist on every route.
- **The agent:** the durable conversation, including after a crash. That test has its own runtime, so it can't reset objects other tests are using.
- **Poppy:** conformance tests against a strict mock Company.
  - Each of the mock's checks has an id and a test that proves it fires.
  - An after-each hook fails any test that triggers a check it didn't declare.
  - Sign-in, Sessions and sign-out also run under six readings of the draft's open questions.
  - A frozen clock makes Retry-After, device polling and slow operations instant.
- **Validator:** fixtures declared as data, with a test that every message has one. They include the spec's own examples and poppy-demo's live documents.
- **JSON parsers:** property tests against `JSON.parse`.
- **Page:** the four places, the needs-you tray, cards, the Activity log (no secrets ever reach it), the sign-in page and the Browser Rendering adapter, in happy-dom.

The model, Google, GitHub and Companies are faked; nothing calls the network.

## Cloudflare services

| Service | Used for |
| --- | --- |
| Workers and Static Assets | Routes, sign-in, the chat page, the validator |
| Durable Objects (SQLite) | One agent per person; per-company rate limits |
| AI Gateway (`AI` binding) | Claude Opus 5.5 |
| Browser Rendering | Browsing a company's website in the agent's Session |
| Rate Limiting | The validator's URL checks |

**Cost:** Claude calls are paid through AI Gateway, with Unified Billing or your own Anthropic key. We haven't checked whether the rest fits the Workers free plan.

## Other implementations

Poppy implementations we know of, as of 11 Oct 2026. All were days old.

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
| [dirnbauer/webconsulting-typo3-lab](https://github.com/dirnbauer/webconsulting-typo3-lab) | Minimal signed-out Company (the extension itself is private) | PHP |

[`docs/poppy-issues.md`](docs/poppy-issues.md) lists the issues we found in them and in the specification, and what we changed in our own client as a result.

## Limitations

- **Chat sign-in isn't live** until the Google and GitHub OAuth apps are registered and AI Gateway billing is set up; see [`docs/setup.md`](docs/setup.md). The validator works without either.
- **No real company tested yet.** The Poppy client has run only against our mock Company; the live Companies above are signed-out or demos.
- **Fake browser only.** Website browsing has been tested with a fake browser, not Browser Rendering.
- **Validator limits:**
  - It checks documents, not behaviour: it can't tell whether a token endpoint works.
  - It checks the host name, not the IP address a name resolves to, so it can't refuse a name that points at a private address. The Guides ask for that check.
  - "Same domain" for an agent's `jwks_uri` accepts the same host or a parent or child host, because the spec doesn't define it.
- **Not built yet:** memory, skills and a daily message cap (milestone 2).

## Project layout

```text
src/index.ts        Worker routes (chat, sign-in, Poppy identity, validator)
src/agent.ts        The per-person Durable Object
src/ui/             The page: Chat, Activity, Companies, Settings
src/poppy/          The Poppy client, its tools, its UI messages and the Activity log
src/validator/      The validator: parser, primitives, profiles, fetch, HTTP, HTML
scripts/            The validator CLI and the secrets generator
test/               Tests and the mock Company
docs/               Setup guide; issues in other implementations and the spec
```

## Support, contributing and license

- **Support:** this is a private repository for its collaborators. Report problems with [GitHub issues](https://github.com/adewale/dpa/issues).
- **Contributing:** pull requests should keep `npm test` and `npm run typecheck` passing. A new Poppy feature needs a test, and a check in the mock Company where the spec has a MUST.
- **License:** no license has been chosen yet. Files copied from Cloudflare's `agents` examples keep their MIT license; see [`NOTICE.md`](NOTICE.md).
