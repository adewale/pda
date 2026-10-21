# The Poppy Validator

Repository support is explicit for 0.1 and 0.2; 0.2 uses the revision in [the pin](../spec/upstream.json). `poppy.json` selects its own profile. For versionless OAuth metadata, client metadata and JWKS, pass `protocolVersion: "0.2"` to the library; the compatibility default is 0.1. Reports carry `protocolVersion` and `specificationRevision`. Unknown 0.x versions are refused before issuer metadata is fetched. The deployed validator can lag this unreleased branch.


The validator checks the documents a Personal Agent and a Company exchange before they talk: a Company's `poppy.json` and OAuth server metadata, and an agent's client metadata and key set. Our agent runs every document through it and uses only the ones it passes. It is also a web form, an HTTP API, a CLI and a library, at https://poppydemoagent.dev/validator.

- **Severity.** Each message names its basis, and its severity follows from it ([docs/conformance-levels.md](conformance-levels.md)). An `error` breaks a MUST, an RFC's MUST or a rule the draft states without a key word, and only errors make a document invalid. A `warning` departs from a SHOULD, the Guides or our reading of an open question. An `info` is harmless. What our own client refuses is reported separately (`refused`, and `refuses` on each message): it also refuses a few warnings that guard against hostile documents (the Guides' fetch limits, duplicate members, HTTPS everywhere under 0.1, spec-issues N9; HTTPS is a requirement under 0.2), and tolerates a few errors the draft tells readers to tolerate.
- **Explanations.** Each message has a stable id and a page saying what it means and how to fix it ([all messages](https://poppydemoagent.dev/validator/messages)).
- **Outcome.** `valid`, `invalid`, or `indeterminate` when a document couldn't be fetched.

A domain checks the Company's `poppy.json` and its OAuth server metadata; a URL is taken as a Personal Agent's `client_id`, which checks its client metadata and key set.

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
| `POST /validator/api` with `{"document": "…", "kind": "poppy", "domain": "example.com"}` | The JSON report for a pasted document (`kind`: `poppy`, `oauth-metadata`, `client-metadata` or `jwks`) |
| `GET /validator/messages` | What each message means, and the report's format |

The API accepts any origin and uses no cookies; URL checks are limited to 20 a minute per address, documents to 100 KB. As a library, `validateCompany`, `validateClient`, `validateText` and `validateTarget` in `src/validator/` run in the Worker, Node and the tests alike.

How it compares with the two other open validators is in [interop-testing.md](interop-testing.md#validator-cross-check). How its rules are versioned is in [the spec](../pda-spec.md).
