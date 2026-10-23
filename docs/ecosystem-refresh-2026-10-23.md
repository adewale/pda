# Ecosystem refresh — 23 October 2026

The current map was rechecked against public source revisions, release registries, directories and discovery documents. The largest new observations are Archon's directory entry and test identity, direct confirmation of Print with Poppy's production/sandbox 0.2 declarations, Alpine Retail's 0.2 declaration, and four 0.1 addresses that fail their declared profile's domain rule. The specification remains at `39b35bd`; Datalayer remains at 0.26.0.

This is a source and document refresh. No third-party code, Sessions, conversations, sign-ins, API operations or purchases were run. The 21 October live results and 17 October grid retain their dates and revisions. No adapter pin changed, and no findings were sent to another project.

## Repositories and packages

Seventeen public repository heads were read, including the official repository, implementations, tools, a community list and the new Archon test identity. The [source receipt](evidence/ecosystem-2026-10-23/sources.json) records full revisions, commit dates and incremental comparisons. A commit date is not the date we checked it.

| Repository | Head read on 23 October | Last commit date |
| --- | --- | --- |
| personal-agent-protocol/personal-agent-protocol | [`39b35bd`](https://github.com/personal-agent-protocol/personal-agent-protocol/tree/39b35bdf240fc07f157d6ca4e29b5a41d4b36b5d) | 2026-10-19 |
| datalayer/personal-agent-protocol | [`0ff43c5`](https://github.com/datalayer/personal-agent-protocol/tree/0ff43c55cc303c3165cb2d5841eca026e1c7c699) | 2026-10-22 |
| spenciefy/print-with-poppy | [`e4aef11`](https://github.com/spenciefy/print-with-poppy/tree/e4aef115b5c240082149bcb354bae19ef5ef148e) | 2026-10-22 |
| richardanaya/pi-poppy | [`11ea106`](https://github.com/richardanaya/pi-poppy/tree/11ea10630180740f16ccd507b8f90f69870c7e32) | 2026-10-10 |
| irvinebroque/poppy-demo | [`02a9b30`](https://github.com/irvinebroque/poppy-demo/tree/02a9b304e92fdfee465c57f2822742eecac8bdc8) | 2026-10-09 |
| akshay5995/poppyseed | [`69f9233`](https://github.com/akshay5995/poppyseed/tree/69f9233242f46db943b79008a668d7e79aa8b733) | 2026-10-15 |
| everruns/everruns | [`8a7fc2f`](https://github.com/everruns/everruns/tree/8a7fc2f11c393ddfa379be4ac61373cdb7863f30) | 2026-10-23 |
| DavideCarvalho/adonis-agora-agent | [`e5c84f6`](https://github.com/DavideCarvalho/adonis-agora-agent/tree/e5c84f6a0c75f8b568650bd0d3bf3023e64d7756) | 2026-10-23 |
| DavideCarvalho/adonis-agora-authkit | [`3077535`](https://github.com/DavideCarvalho/adonis-agora-authkit/tree/3077535a4ff99ef74c814b686ee27b2cebdff09b) | 2026-10-23 |
| rbirkby/Ilmer.org | [`86713f0`](https://github.com/rbirkby/Ilmer.org/tree/86713f0d06c86068b41c367c6c2af61f37e27e15) | 2026-10-20 |
| timothyohare/personal-agent-protocol | [`fb7b4e6`](https://github.com/timothyohare/personal-agent-protocol/tree/fb7b4e64ad343d9406055a995f4beb06269c1ce6) | 2026-10-12 |
| ketanbj/openavt | [`9e99b62`](https://github.com/ketanbj/openavt/tree/9e99b622515b20d1b8d5405be229c7199d73dd60) | 2026-10-12 |
| allowfy/allowfy-check | [`11137ad`](https://github.com/allowfy/allowfy-check/tree/11137ada084f3689d73d2ae23f2c00958a7022e2) | 2026-10-20 |
| ora/poppy-ax | [`f6b5cc3`](https://github.com/ora/poppy-ax/tree/f6b5cc3c0d8d8e680f0d2429eac31ea9a6214cb6) | 2026-10-21 |
| akshay5995/poppy-agent-demo | [`a5c0bdc`](https://github.com/akshay5995/poppy-agent-demo/tree/a5c0bdc34f423ee924216f4268eb28d704dfa731) | 2026-10-16 |
| JaviChulvi/awesome-poppy | [`68d554b`](https://github.com/JaviChulvi/awesome-poppy/tree/68d554bb80468502fa93c630a19be3c9f395a427) | 2026-10-20 |
| Flaxscrip/poppy-test-agent | [`7012e74`](https://github.com/Flaxscrip/poppy-test-agent/tree/7012e7447b0cb06d90b54785e821e503f32e20cd) | 2026-10-23 |

The three moved heads were compared with the preceding observations:

- **Everruns:** 19 commits and 224 changed paths since `9adc3ef`. Shared MCP catalog code changed, but every one of the 46 Poppy-named tree entries has the same hash at both revisions. This does not prove that shared-runtime changes cannot affect Poppy. The receipt retains both tree hashes per entry.
- **Adonis agent:** 15 commits and 44 changed paths since `51df9f1`, covering the shared agent loop, history/AI SDK, timestamps and dependencies. No Poppy-named source path appears in that complete incremental comparison.
- **Adonis AuthKit:** 16 commits and 16 changed paths since `75156d6`, covering releases, dependencies and CI; no Poppy source path appears in that complete incremental comparison.

All three comparisons are below GitHub's 300-file cap. Their results are incremental observations since 21 October, not a fresh test against the retained grid pins.

The registries still list `@datalayer/personal-agent-protocol` on npm and `personal-agent-protocol` on PyPI at **0.26.0**, and `poppyseed` at **0.1.1**. Datalayer's revision-pinned conformance report still lists **99 pass, 0 fail, 0 skip for each of four language pairings**. Those are its own published results, not new PDA results. The public-source receipt records response hashes for the registries and directory pages.

GitHub repository searches since 21 October found a specification fork and the new `Flaxscrip/poppy-test-agent` identity. The latter's README explicitly describes public client metadata and a public key for running the official validator against Archon Herald. It is not a runnable client. npm's first 20 results for `personal-agent-protocol` retained the known SDK, NestJS port and Poppyseed; the crates.io query returned no results. This bounded search is not an exhaustive census.

## Specification and discussions

The official repository still resolves to [`39b35bdf240fc07f157d6ca4e29b5a41d4b36b5d`](https://github.com/personal-agent-protocol/personal-agent-protocol/tree/39b35bdf240fc07f157d6ca4e29b5a41d4b36b5d), the revision already pinned in PDA. The live changelog still calls 0.2 a draft in progress.

The snapshot command reports differences against its newest **website** manifest, which is the 12 October 0.1 snapshot retrieved on 13 October. Those differences include the already-known 0.2 page reorganization; they do not mean the official source changed since yesterday. The [comparison output](evidence/ecosystem-2026-10-23/spec-site-comparison.txt) names its baseline. This refresh does not replace the separately imported, hash-verified 19 October 0.2 source or its grounding.

Newly relevant discussions are [OAuth/AIMS alignment #35](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/35), the [23 October task-grant revision #28](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/28), and device-local [key custody #31](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/31) and [redirect constraints #33](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/33). The OAuth proposal would change names, metadata and authorization flows, including removing Mediated Sign-In; its comments debate device-grant policy. These remain proposals, not adopted rules.

The GitHub connector could not list Sierra's organization repositories because of SSO, and the public API request returned 403. The public repository page was available through a web result crawled on 22 October, but this is not a fresh, complete 23 October organization inventory. No new absence claim about Sierra's runtime reference implementation is inferred from that blocked API request.

## Directories

[PAP Checker](https://papchecker.com/sites) lists **16 sites out of 80 checked**, including `archon.technology` (archon.social), first seen 23 October, with Direct and Device Sign-In. Its Print with Poppy entry still says 0.1. Today's direct document reads establish 0.2 at the production and sandbox hosts; a directory row can lag a deployment. Northlight Flowers is also directly document-validated today. Ferretería Andes' former tunnel is absent from the current directory and was not fetched.

[poppy.md](https://poppy.md/implementations), marked checked 23 October, also describes Print with Poppy's 0.2 discovery and the directory's new Archon entry. Its discovery-only scope is retained here; its listing is not evidence of a working ordering flow. Awesome Poppy remains at `68d554b`, whose last change added Allowfy Check.

## Public discovery checks

PDA's `validateTarget` library checked **28 addresses sequentially** through Node 24's environment HTTP proxy with TLS verification. The transport was `fetch` through that proxy, not the CLI's direct DNS-pinned HTTPS fetcher. The validator fetched only public discovery and issuer metadata documents, including its bounded redirects and metadata-location fallbacks. It did not fetch the advertised OpenAPI/MCP APIs, start Sessions or submit sign-in fields.

There were **23 valid, 4 invalid and 1 indeterminate** results. Nine documents declare 0.2, eighteen declare 0.1, and Intercom returned no document. Each was checked against its declared profile at PDA source `fc5f7f9bcf664cd71bfdd281ce7e532f869720bc`. “Valid” means no document-validation errors; warnings and informational findings remain recorded. It does not mean a complete protocol implementation works.

The [sanitized result file](evidence/ecosystem-2026-10-23/discovery.json) records the observation time, profile/revision, diagnostic ids and text, final URLs, response metadata, canonical parsed-JSON hashes and requested URLs. It excludes document bodies. Hashes are of parsed JSON serialized with sorted keys, UTF-8, no extra whitespace and unescaped Unicode; they are not response-byte hashes.

| Address | Declared profile | Result | Errors / warnings / info |
| --- | --- | --- | --- |
| printwithpoppy.com | 0.2 | valid | 0 / 0 / 3 |
| sandbox.printwithpoppy.com | 0.2 | valid | 0 / 0 / 2 |
| archon.technology | 0.2 | valid | 0 / 0 / 0 |
| flowers.papsandbox.com | 0.2 | valid | 0 / 0 / 0 |
| crosswalk.to | 0.2 | valid | 0 / 0 / 1 |
| stacktr.ee | 0.2 | valid | 0 / 3 / 2 |
| www.planmyvisit.to | 0.2 | valid | 0 / 0 / 1 |
| saferate.com | 0.2 | valid | 0 / 0 / 0 |
| ample.computer | 0.1 | invalid | 1 / 0 / 0 |
| withpoppyseed.dev | 0.1 | valid | 0 / 0 / 0 |
| poppy-receiver.roundtrip.workers.dev | 0.1 | valid | 0 / 0 / 1 |
| tilopay.shop | 0.1 | invalid | 1 / 0 / 1 |
| tilopay.tilopay.shop | 0.1 | invalid | 1 / 0 / 1 |
| emorahealth.com | 0.1 | valid | 0 / 0 / 1 |
| rentourbins.com | 0.1 | valid | 0 / 0 / 2 |
| neutral-state-jev-dub-bench.vercel.app | 0.1 | valid | 0 / 0 / 0 |
| neutral-state-jev-os-bench.vercel.app | 0.1 | valid | 0 / 0 / 0 |
| ax-air.com | 0.1 | valid | 0 / 0 / 2 |
| notjustabank.com | 0.1 | invalid | 1 / 1 / 2 |
| spotmeplease.com | 0.1 | valid | 0 / 0 / 0 |
| poppy.ilmer.org | 0.1 | valid | 0 / 0 / 4 |
| www.ilmer.org | 0.1 | valid | 0 / 0 / 5 |
| salespeak.ai | 0.1 | valid | 0 / 0 / 1 |
| www.alpine-retail.com | 0.2 | valid | 0 / 0 / 0 |
| windomsports.com | 0.1 | valid | 0 / 3 / 2 |
| getvibe.dev | 0.1 | valid | 0 / 0 / 2 |
| origin-platform-labs.netlify.app | 0.1 | valid | 0 / 0 / 1 |
| intercom.io | None returned | indeterminate | 1 / 0 / 0 |

The four invalid addresses all declare **0.1**, whose organization-domain rule compares with the requested host: Ample redirects to `api.ample.computer`, both Tilopay addresses name `tilo.shop`, and Not Just a Bank names `bank.notjustabank.com`. These are verdicts for the named requests and declared profiles; they do not prove that every service on those issuers is unusable. Intercom redirects to `www.intercom.com`, where the discovery path returns 404; the validator reports **indeterminate**, not a successful check.

Stacktree's three warnings concern missing `private_key_jwt`, JWT bearer grant and device grant declarations in OAuth metadata. Windom Sports' three warnings concern missing `private_key_jwt`, JWT bearer grant and refresh-token declarations. Not Just a Bank also offers an undescribed custom scope. These observations do not establish when those documents changed.

To repeat the same read-only library check through an environment proxy, from the repository root:

```sh
node --use-env-proxy --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { validateTarget } from './src/validator/index.ts';
const input = JSON.parse(readFileSync('docs/evidence/ecosystem-2026-10-23/discovery.json', 'utf8'));
for (const { host } of input.results) {
  const report = await validateTarget(request => fetch(request), host);
  console.log(JSON.stringify({ host, report }));
}
JS
```

A repeat is a new observation: public deployments and registry responses can change after this report. Keep those new dates separate from the archived results here.
