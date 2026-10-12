# Datalayer's conformance cases, run against our agent

Datalayer's SDK ([datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), BSD-3-Clause) keeps its Poppy conformance cases as language-neutral JSON in `protocol/fixtures/conformance/` (`id`, `kind`, `role`, `requirements`, `check`, `input`, `expect`). `run.mjs` runs the ones that apply to a Personal Agent against our `src/validator` and `src/poppy`, under Node, without changing either. It's the one-sided vector lane of [the interop spec](../../../docs/interop-spec.md#11-one-sided-vectors).

```sh
npm ci
node interop/vectors/datalayer/run.mjs              # fetch the cases at the pinned commit, run, print
node interop/vectors/datalayer/run.mjs --verbose    # also list the Company-role cases
node interop/vectors/datalayer/run.mjs --json out.json
node interop/vectors/datalayer/run.mjs --cases <clone>/protocol/fixtures/conformance
```

- **Pinned:** commit `0c048aa7fef8d98bbc23de5474220b6e7206384a` (v0.10.0, 12 October 2026), the same commit as the four Datalayer adapters. The cases are fetched from raw.githubusercontent.com into `node_modules/.cache/datalayer-conformance/<commit>/`, not vendored. That commit has 124 cases, the same five files byte for byte as the previous pin, `12d71877` (v0.6.0).
- **Outcomes:** `pass`; `fail` with a category: `our-bug` (exit status 1), `reading` (we and Datalayer read the draft differently) or `harness`; `n/a` with the reason.
- **Loading our code:** `src/` is written for workerd and Vite, so the script transpiles it with the repo's own TypeScript, resolves extensionless imports, stubs `cloudflare:workers`, and gives `PoppyClient` an in-memory host: `node:sqlite` for its SQL, an in-memory `CompanyLimiter`, a generated ES256 key, and a fake Company at `shop.example` whose token endpoint issues tokens without checking them.

## How each `check` maps onto our code

Datalayer's TypeScript runner (`src/__tests__/conformance-fixtures.test.mjs`) decides each `check` with one SDK function. Ours:

| `check` | Cases | Ours |
| --- | --- | --- |
| `discovery_document` | 5 | `validateText("poppy", …)`, judged by the report's `refused` (whether our client would use the document), since Datalayer's `valid` is whether its agent uses it; the validator's own verdict (`outcome`, severities) is noted, not judged. For `known_api_types` and `conversation_endpoint`, `discover()` with OAuth metadata the script adds, since the cases give only `poppy.json`. `extra` (unknown fields kept) can only be checked as "accepted": we ignore unknown fields rather than carry them. |
| `discovery` | 11 | `discover()` for the refusal or result, on the case's fixed responses, and `validateCompany()` for the reason: the report must agree our client refuses (`refused`), and one of the messages it refuses over (`refuses`, whatever their severity) must be the one Datalayer's error code maps to. The `slow-metadata` trickle is stretched by 5 s / 0.3 s, because our limit is a fixed 5 s, and the fake network honours the request's `AbortSignal` while streaming, as `fetch` does. |
| `extension_negotiation` | 2 | `discover()`: the extensions our `Company` keeps. Only cases whose agent supports exactly our `SUPPORTED_EXTENSIONS` apply. |
| `extension_names` | 1 | `validateText()`: `extension-name` is invalid; otherwise a name with `/` is third-party, without is plain. |
| `extension_required` | 1 | `callOpenApi()` against an API that answers 403 `extension_required`. |
| `conversation_page` | 1 | `readConversation()` on the page; the message is kept, the unknown event skipped, the cursor saved. |
| `operation` | 1 | `handleProposal()`. |
| `message_context` | 1 | We never parse a received `context`; we send our own. Locale and time zone are filtered by two regular expressions inline in `src/poppy/capability.ts` (not importable under Node), so the script reads those expressions from the source and applies them. |
| `strict_json` | 1 | Both `src/poppy/json.ts` (`parseStrictJson` must throw) and `src/validator/json.ts` (`parseJson` must report the duplicate). |
| `rate_limited` | 1 | `client.token()` (a Session request) and `readConversation()`, each against a 429 with `Retry-After: 30`: one attempt, `rate_limited` with 30 s, the read rescheduled 30 s later. |
| `url_safety` | 7 | `n/a` for the six negatives: a Worker never sees DNS answers; Cloudflare's `fetch` resolves and refuses private addresses itself. As a supplement the script checks the same addresses as IP-literal URLs, which we refuse. The positive case passes by name. |
| `pinned_connect` | 1 | `n/a`: Datalayer marks it Python-only, and a Worker can't pin a connection. |
| none (Company role) | 91 | `n/a`: they test a Company, driven by Datalayer's agent (scenario steps, or a mutated assertion or DPoP proof the Company must refuse). Run them against a Company with Datalayer's `pap company verify`. |

## Results at the pinned commit

124 cases: 24 pass, 2 fail (both `reading`), 98 n/a (91 Company-role, 7 DNS-level SSRF and pinning). Run on 12 October at `0c048aa`; the script exits 0. The cases didn't change with the pin: the old pin's cases, run with `--cases`, give the same counts.

Under the conformance levels ([conformance-levels.md](../../../docs/conformance-levels.md)) a message's severity is the validator's verdict on the draft, and whether our client refuses a document is separate (`refuses` per message, `refused` on the report). The discovery cases test what an agent does, so they are judged by refusal. Judged by severity instead, four cases read as readings though both sides behave alike: `security.discovery-redirect-limit`, `security.oversized-metadata` and `security.slow-metadata`, which our client refuses over Guides-based messages that are warnings, and `protocol.unknown-api-type`, which our client uses (skipping the `graphql` API, as expected) while the validator calls the 0.1 document invalid, because 0.1 says each API's `type` "MUST be one of" `openapi` and `mcp`.

| Case | Outcome | Why |
| --- | --- | --- |
| `protocol.third-party-extension-name` | fail, reading | Datalayer calls `Gift Wrap!` an invalid name; our validator calls it a plain name the protocol doesn't define, a warning. The draft (3.3) says "anyone else MUST start an extension's name with a domain they control" but defines no syntax for plain names. `localhost/x` is invalid for both. |
| `security.metadata-not-json` | fail, reading | Datalayer refuses `text/html` for its Content-Type. We refuse this case too, but because the body isn't JSON: our client doesn't refuse a wrong Content-Type (`http-content-type` is a warning that doesn't refuse), and the Guides' "Fetching metadata safely" asks for size, redirect and time limits, not a content type. So a JSON body served as `text/html` is one we'd use and Datalayer wouldn't. |

Fixed since the first run: `security.slow-metadata` used to be refused by a `TimeoutError` escaping `validateCompany()` (a body that stalled past the limit threw instead of becoming `http-failed`); `fetchDocument()` now holds one deadline over the response and its body. `protocol.extension-required-error`: the `PoppyError` now carries the extension as `detail.extension`, not only in its message.
