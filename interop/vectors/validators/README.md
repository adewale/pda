# The validator cross-check

Our discovery document validator (`src/validator`) against independent ones, over the same `poppy.json` documents: two community validators for Draft 0.1, and the official Company validator for Draft 0.2. A validator is neither a Personal Agent nor a Company, so it has no place in the grid; this is its one-sided lane, beside [Datalayer's conformance cases](../datalayer/README.md).

```sh
npm ci
node interop/vectors/validators/run.mjs               # fetch, run all four, print
node interop/vectors/validators/run.mjs --verbose     # also each validator's findings where they differ
node interop/vectors/validators/run.mjs --json out.json
```

- **The other validators**, fetched at pinned commits from GitHub's tarballs into `node_modules/.cache/validator-xcheck/`, not vendored:
  - [tusharck/poppy-validator](https://github.com/tusharck/poppy-validator) at `d2220bfefb519f603bc2de6a4c5a63db04c660d3` (MIT, Python): 64 rules, each with a spec section and a basis.
  - [habib-analyst/poppy-sidecar](https://github.com/habib-analyst/poppy-sidecar) at `858db66bcaa0cd26b3dbfec16ea5a8fb2055b8ef` (MIT, Python): a generator and a 25-check validator.
- **Where they run:** only in Docker, with `--network none`, as `nobody`, their source mounted read-only and imported from the tree, never installed. The image (`Dockerfile`) is `python:3.12-slim` pinned by digest, plus poppy-validator's one dependency at the versions in its `uv.lock`; poppy-sidecar has none. Both run in file mode: no OAuth cross-check, no live checks.
- **The official Company validator**, from the verified snapshot in [`spec/`](../../../spec/upstream.json) (not fetched), runs unmodified as its CLI, `check --file <doc> --json` (schema and field rules, no network; `run_official.mjs`). It runs only in Docker, with `--network none`, as `nobody`, the snapshot mounted read-only, on the Node image its interop identity host pins ([`interop/impls/official-validator/Dockerfile`](../../impls/official-validator/Dockerfile)). It checks Draft 0.2, so it judges only the documents that declare 0.2. Its file mode has no serving domain.
- **Ours** runs in this process through `validateText`, in file mode, so nothing is fetched: as served from each document's domain against the Python validators, and with no domain against the official one. It needs Node 24 or later, which runs `src/validator`'s TypeScript as it is.
- **The corpus** (`corpus.mjs`): 107 documents, the original 0.1 set: the `poppy.json` fixtures of `test/validator.test.ts`, restated; one probe per rule the validators were found to read differently; poppy-validator's own fixtures; and poppy-sidecar's generated examples. Each is checked as served from a given domain. Then, for 0.2: the stored 0.2 specification's example, and a 0.2 twin of every document that declares 0.1 (the same document, `protocol_version` "0.2"). With the two originals that already declare 0.2, 99 documents declare 0.2 (96 twins).
- **The verdict** is "valid": no error-severity finding. Ours is graded by [the conformance levels](../../../docs/conformance-levels.md), so a warning our client still refuses (such as a plain `http` API URL) counts as valid here.
- **Output:** for 0.1, agreement for each pair and for all three, then every document where they differ; for 0.2, agreement between ours and the official validator, then every difference. Information only: the exit status is 0 unless the harness failed (a fetch, the build or the container). Behind a TLS-intercepting proxy, set `CODEX_PROXY_CERT` (as for the interop runner) and the image build gets the system CA bundle as a secret.

Each difference is judged by hand against the stored drafts ([0.1](../../../spec/draft-0.1-2026-10-12/pages/spec.md), [0.2](../../../spec/draft-0.2-2026-10-19/pages/spec.md)) in [interop-testing.md](../../../docs/interop-testing.md#validator-cross-check). To move a pin, change `PINS` in `run.mjs` (and the dependency versions in the `Dockerfile` if poppy-validator's `uv.lock` changed), run it, and update that table. The official validator moves with the snapshot (`npm run spec:import`).

## Results

**Draft 0.2, 24 October 2026**, 99 documents: ours and the official validator give the same verdict on 75. Ours is stricter on 13, under six rules (an issuer with a query or fragment, an unparseable URL, a reserved `poppy:` scope, an extension name without a domain, `operations` without its endpoint, a mediated field listed twice). The official validator is stricter on 11: an API type other than `openapi` or `mcp` (3, where 0.2 section 6 still says MUST and ours gives only `info`), and what its JSON Schema asks beyond the text (empty `scopes`, `protocols` or `fields`, an integer extension `version`, a blank `organization.name`; 8). [The table](../../../docs/interop-testing.md#draft-02-ours-against-the-official-validator).

**Draft 0.1**, rerun on 24 October with the same counts as at `cb39236` (12 October 2026), 107 documents. Same verdict: ours and poppy-validator on 92, ours and poppy-sidecar on 77, poppy-validator and poppy-sidecar on 78, all three on 70. The 15 documents where ours and poppy-validator still differ fall under nine rules: an issuer with a query or fragment, reserved `poppy:` scopes, scope syntax, a mediated field listed twice, `operations` without its endpoint, an unparseable `resource`, a trailing dot on the domain (each an error in ours), and an empty `agent.protocols` and a plain unknown extension name (each an error in theirs).
