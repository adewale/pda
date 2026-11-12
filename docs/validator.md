# The Poppy Validator

The validator checks Poppy 0.4 at the reviewed [11 November 2026 snapshot](../spec/draft-0.4-retrieved-2026-11-11/README.md), as published on 10 November and pinned in [spec/upstream.json](../spec/upstream.json), and no other version. `poppy.json` names its version, and one that names any other, 0.3 and earlier included, is refused (`version-unsupported`) before its issuer is used. A domain is checked the way our agent chooses: the newest version it speaks, from `poppy.json` or its `supported_versions` on the same host, without following a redirect off it, and the linked document is checked too, so a Company whose `poppy.json` is still 0.3 but links a 0.4 document is checked by that document. Versionless documents (protected resource, OAuth and client metadata, key sets), and a document that names no usable version, are checked as 0.4. Reports carry `protocolVersion` and `specificationRevision`. A new version adds a profile beside 0.4's; [upgrading.md](upgrading.md) owns that procedure. The deployed validator can lag this unreleased branch.

The 0.4 profile has 0.4's rules, with messages that link to the 0.4 pages: extensions as lists of version entries, `tasks.endpoint`, `web.disabled` and `web.unscoped`, website operations and Browser Control only with browser join, `poppy:browser-sign-in` among the issuer's or the protected resource metadata's `scopes_supported`, and Direct Sign-In preferred. For a Company moving from 0.3, it notes the members that moved to `tasks.endpoint` and reports an extension written as 0.3's single object. Where the official company kit's offline check is silent on a rule the pinned text states, the validator keeps it ([0.4 upgrade, F7](poppy-0.4-upgrade.md)).


The validator checks the documents a Personal Agent and a Company exchange before they talk: a Company's `poppy.json` and OAuth server metadata, and an agent's client metadata and key set. Our agent runs every document through it and uses only the ones it passes. It is also a web form, an HTTP API, a CLI and a library, at https://poppydemoagent.dev/validator.

- **Severity.** Each message names its basis, and its severity follows from it ([docs/conformance-levels.md](conformance-levels.md)). An `error` breaks a MUST, an RFC's MUST or a rule the draft states without a key word, and only errors make a document invalid. A `warning` departs from a SHOULD, the Guides or our reading of an open question. An `info` is harmless. What our own client refuses is reported separately (`refused`, and `refuses` on each message): it also refuses a few warnings that guard against hostile documents (the Guides' fetch limits, duplicate members, a fragment where no rule forbids one, spec-issues N9; HTTPS everywhere is the draft's own MUST), and tolerates a few errors it has a safe fallback for.
- **Explanations.** Each message has a stable id and a page saying what it means and how to fix it ([all messages](https://poppydemoagent.dev/validator/messages)).
- **Outcome.** `valid`, `invalid`, or `indeterminate` when fetching failed or a resource allowance prevented checks.

A domain checks the Company's `poppy.json`, the domain's protected resource metadata, which names the issuer, and the issuer's OAuth server metadata; a URL is taken as a Personal Agent's `client_id`, which checks its client metadata and key set.

```sh
npm run validate -- https://poppydemoagent.dev/poppy/client.json   # an agent
npm run validate -- ./poppy.json --domain example.com                                   # a local file
cat jwks.json | npm run validate -- --kind jwks -                                        # standard input
npm run validate -- example.com --json                                                  # the JSON report
```

Exit status `0` valid, `1` invalid, `2` couldn't check; `--strict` fails on warnings too; `--help` lists every option.

| Request | Answer |
| --- | --- |
| `GET /validator?url=example.com` | The results page, so you can link to it |
| `POST /validator/api` with `{"url": "example.com"}` | The JSON report |
| `POST /validator/api` with `{"document": "…", "kind": "poppy", "domain": "example.com"}` | The JSON report for a pasted document (`kind`: `poppy`, `protected-resource`, `oauth-metadata`, `client-metadata` or `jwks`) |
| `GET /validator/messages` | What each message means, and the report's format |

The API accepts any origin and uses no cookies. Input checks and URL fetches have separate per-address admission quotas; URL fetches are limited to 20 a minute. HTTP request bodies, including ignored JSON fields and multipart files, are read up to 200 KB with a 10-second deadline before parsing; streamed submissions need no `Content-Length`. Documents are capped at 100 KB. HTTP JSON input is also bounded to 64 nesting levels and 20,000 structural tokens; forms take at most 64 fields. Oversized or overly complex input returns `413`, a stalled body `408`, and a quota refusal `429`.

As a library, `validateCompany`, `validateClient`, `validateText` and `validateTarget` in `src/validator/` run in the Worker, Node and the tests alike; the HTTP envelope and admission limits belong to the HTTP handler.

The shared parser also limits cumulative JSON-pointer strings used for source locations to one million UTF-16 code units (roughly 2 MB of pointer characters). It checks each projected escaped path before allocating it. This prevents a long ancestor member name from being copied into thousands of child locations despite a small document. The allowance is an implementation policy, not a protocol or JSON syntax requirement: library and fetched-document reports use `json-resource-limit`, `indeterminate`, and `refused: true`; pasted HTTP documents return `413`. The allowance bounds location strings, not every allocation made by validation.

How it compares with the two other open validators is in [interop-testing.md](history/interop-testing.md#validator-cross-check). How its rules are versioned is in [the spec](../pda-spec.md).
