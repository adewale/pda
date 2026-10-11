# Datalayer's conformance cases, run against our agent

Datalayer's SDK ([datalayer/personal-agent-protocol](https://github.com/datalayer/personal-agent-protocol), BSD-3-Clause) keeps its Poppy conformance cases as language-neutral JSON in `protocol/fixtures/conformance/` (`id`, `kind`, `role`, `requirements`, `check`, `input`, `expect`). `run.mjs` runs the ones that apply to a Personal Agent against our `src/validator` and `src/poppy`, under Node, without changing either. It's the one-sided vector lane of [the interop spec](../../../docs/interop-spec.md#11-one-sided-vectors).

```sh
npm ci
node interop/vectors/datalayer/run.mjs              # fetch the cases at the pinned commit, run, print
node interop/vectors/datalayer/run.mjs --verbose    # also list the Company-role cases
node interop/vectors/datalayer/run.mjs --json out.json
node interop/vectors/datalayer/run.mjs --cases <clone>/protocol/fixtures/conformance
```

- **Pinned:** commit `12d71877d477b93f3ee68ebdc542560ba85997b9` (11 October 2026). The cases are fetched from raw.githubusercontent.com into `node_modules/.cache/datalayer-conformance/<commit>/`, not vendored. That commit has 124 cases, not the 125 our docs mention.
- **Outcomes:** `pass`; `fail` with a category: `our-bug` (exit status 1), `reading` (we and Datalayer read the draft differently) or `harness`; `n/a` with the reason.
- **Loading our code:** `src/` is written for workerd and Vite, so the script transpiles it with the repo's own TypeScript, resolves extensionless imports, stubs `cloudflare:workers`, and gives `PoppyClient` an in-memory host: `node:sqlite` for its SQL, an in-memory `CompanyLimiter`, a generated ES256 key, and a fake Company at `shop.example` whose token endpoint issues tokens without checking them.

## How each `check` maps onto our code

Datalayer's TypeScript runner (`src/__tests__/conformance-fixtures.test.mjs`) decides each `check` with one SDK function. Ours:

| `check` | Cases | Ours |
| --- | --- | --- |
| `discovery_document` | 5 | `validateText("poppy", …)`; for `known_api_types` and `conversation_endpoint`, `discover()` with OAuth metadata the script adds, since the cases give only `poppy.json`. `extra` (unknown fields kept) can only be checked as "accepted": we ignore unknown fields rather than carry them. |
| `discovery` | 11 | `validateCompany()` for the reason (Datalayer's error codes mapped to our message ids) and `discover()` for the refusal or result, on the case's fixed responses. The `slow-metadata` trickle is stretched by 5 s / 0.3 s, because our limit is a fixed 5 s, and the fake network honours the request's `AbortSignal` while streaming, as `fetch` does. |
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

124 cases: 24 pass, 2 fail (both `reading`), 98 n/a (91 Company-role, 7 DNS-level SSRF and pinning).

| Case | Outcome | Why |
| --- | --- | --- |
| `protocol.third-party-extension-name` | fail, reading | Datalayer calls `Gift Wrap!` an invalid name; our validator calls it a plain name the protocol doesn't define, a warning. The draft (3.3) says "anyone else MUST start an extension's name with a domain they control" but defines no syntax for plain names. `localhost/x` is invalid for both. |
| `security.metadata-not-json` | fail, reading | Datalayer refuses `text/html` for its Content-Type. We refuse this case too, but because the body isn't JSON: a wrong Content-Type is only a warning for us (`http-content-type`), and the Guides' "Fetching metadata safely" asks for size, redirect and time limits, not a content type. |

Passing with a note:

- `security.slow-metadata`: refused, but by a `TimeoutError` that escapes `validateCompany()`. `fetchDocument()` in `src/validator/fetch.ts` catches failures of the `fetch` call, not of reading the body, so a body that stalls past the limit throws instead of becoming an `http-failed` message. `discover()` still refuses the Company; the validator's CLI and web page would report an exception rather than a result.
- `protocol.extension-required-error`: our `PoppyError` names the extension only in its message; there's no structured field.
