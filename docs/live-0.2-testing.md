# Live Poppy 0.2 tests — 21 October 2026

PDA's actual client accepted discovery and opened reusable signed-out Sessions at Crosswalk, Stacktree, PlanMyVisit and Safe Rate. Stacktree and Safe Rate allowed MCP tool listing. Crosswalk and PlanMyVisit required sign-in for listing; those checks are unsupported, not passes or protocol failures. The final matrix has **10 pass, 0 fail, 2 unsupported, 0 error**.

| Company | Discovery | Signed-out Session and reuse | Signed-out MCP tools |
| --- | --- | --- | --- |
| Crosswalk | Pass | Pass | Sign-in required |
| Stacktree | Pass | Pass | Pass |
| PlanMyVisit by Autoura | Pass | Pass | Sign-in required |
| Safe Rate | Pass | Pass | Pass |

PlanMyVisit also passed the existing C conversation scenario. A separate clearly identified test conversation passed send, read and close; it asked only for a brief acknowledgement, with no bookings, plans or account changes. The original C scenario does not close its conversation; no close is claimed for that first run.

[Sanitized per-cell evidence](interop-results/2026-10-21-live-0.2.json) retains each attempt and the paths to gitignored raw results. Session IDs, token bodies, private keys and account data are not copied into this report. The live lane does not record network traffic: these are real endpoint/step outcomes, not packet-level verification of every assertion or DPoP field.

## Test setup and corrected assumptions

The existing runner synthesized 0.1 manifests for every live peer. Live entries now name the expected version; a discovery mismatch stops a cell before Session authentication. The old entries retain their 0.1 default. Four separate 0.2 entries preserve the older peers.

The new ML scenario lists MCP tools through `src/poppy/apis.ts`; it never calls a tool. A `sign_in_required` or `insufficient_scope` response means this signed-out scenario cannot exercise listing and is reported as unsupported. Other errors remain failures.

This workspace had no deployment credentials or existing test identity. The run used a separate locally held signing key, with only its public metadata and JWKS published on a test branch. GitHub's raw endpoint serves JSON as text/plain. The first run passed Sessions at Crosswalk and Stacktree, while PlanMyVisit and Safe Rate refused the identity; Safe Rate explicitly reported a non-JSON metadata response. Serving the same public key through a static JSON CDN resolved both refusals. This was a test-identity hosting problem, not evidence of broken Company authentication.

The final identity is `https://cdn.jsdelivr.net/gh/adewale/pda@poppy-live-json-20261021/poppy/interop/client.json`. It has no redirect URI and cannot complete Direct Sign-In. Its key is separate from the production client's, and no application deployment was changed. A static host may have a path prefix; the adapter resolves `jwks.json` beside its `client_id`.

The proxy-only execution environment mounted its configured CA read-only and enabled Node's environment proxy support. Certificate verification remained enabled.

## Reproduce the signed-out run

Use Node 24 and Docker. Configure a public test identity as described in [the live-lane setup](../interop/README.md#the-live-lanes-identity). Keep the matching private key in gitignored `interop/.live-identity.json`; the public key on the test branch cannot sign requests by itself.

```sh
npm run interop -- --lane live --agents pda \
  --companies crosswalk-live,stacktree-live,planmyvisit-live,saferate-live \
  --scenarios D,S0,ML --no-retry
```

A proxy-based environment additionally supplies `--set pda:NODE_OPTIONS=--use-env-proxy` and its configured CA via `CODEX_PROXY_CERT`. Run the local D/S0/ML cells against lenient-company, strict-company and lenient-company-v02 before using a changed adapter live: all nine cells passed.

## Regression checks

The full suite passes: **1,750 tests and one intentional skip**, across 77 files. Type checking passes. The harness suite includes 254 checks, with regressions for live version attribution, refusing a mismatch before Session authentication, and matching a static-host identity to its sibling JWKS. The version-attribution regression fails when the old hard-coded 0.1 behavior is restored. Snapshot integrity checks pass.

## Remaining account checks

A Stacktree Device Sign-In challenge requested only `poppy:read`. Completing authentication needs the User's test account. Authenticated reads, revocation, account switching, write approvals and sandbox purchases have not been established by this run. The static identity has no Direct Sign-In callback; test that journey with a deployed staging app and test account.

No adversarial traffic, personal data, purchases or paid model calls from PDA were used. PlanMyVisit may use its own model to answer test greetings. No findings were posted to another project.

# Live tests — 23 October 2026: Alpine Retail and Print with Poppy

Our agent's client through the live lane, signed out, one request a second. The identity was a fresh test key, its public half on the `poppy-live-json-20261023` branch served through jsDelivr (`https://cdn.jsdelivr.net/gh/adewale/pda@poppy-live-json-20261023/poppy/interop/client.json`); its private key stayed on the runner. The validator CLI checked each host first.

| Company | Validator (0.2) | D | S0 | N | C |
| --- | --- | --- | --- | --- | --- |
| Alpine Retail (`www.alpine-retail.com`) | Valid, no messages | Pass | Pass | Pass | Pass |
| Print with Poppy (`printwithpoppy.com`, real payments) | Valid, 3 info | Pass | not run | not run | not run |
| Print with Poppy Agent Sandbox (`sandbox.printwithpoppy.com`) | Valid, 2 info | Pass | **Fail**: `invalid_client`, "This agent must register its HTTPS metadata URL before opening a session." | n/a | n/a |

- **Alpine now declares 0.2**, and accepted 0.2's issuer audience on both assertions. C sent "Hello", read its Company Agent's reply, and sent a second message; the scenario doesn't close the conversation. This is Alpine's first 0.2 run; its earlier runs were 0.1 (13 and 14 October). Its registry entry now names 0.2.
- **Print with Poppy admits registered agents only**, so our fresh test identity was refused, as expected. Its source at `e4aef11` already allowlists `https://poppydemoagent.dev/poppy/client.json` for the production store and for its Cloudflare sandbox (`pwp-cf-sandbox.spencersyen.workers.dev`), in `wrangler.jsonc`. `sandbox.printwithpoppy.com` still runs on Railway (its `docs/CLOUDFLARE-CUTOVER.md`), whose allowlist is deployment config we can't see; its [sandbox guide](https://github.com/spenciefy/print-with-poppy/blob/e4aef115b5c240082149bcb354bae19ef5ef148e/docs/SANDBOX.md) still names DPA's old `client_id`, `https://personal-agent.adewale-883.workers.dev/poppy/client.json`, which has answered 404 since the switch on 15 October. Whether the deployed agent can open a Session there is untested. (On 24 October the sandbox opened a Session for the interop identity on `poppydemoagent.dev`; [below](#live-tests--24-october-2026-the-identity-on-poppydemoagentdev).) The live store was only discovered: nothing was ordered or sent past discovery.
- Results are in the gitignored `interop/results/` runs of 23 October; no tokens or traffic are copied here. No findings were posted to another project.

## The fake agents live, 23 October

The lenient and strict fake agents (interop-spec §2.1) now run in the live lane with the same test identity; the sloppy one never does. The first attempt ran them as plain `pda`: the live lane didn't pass a registry entry's `env`, so neither container got its `INTEROP_AGENT_PROFILE`. Fixed (`liveAgentEnv` in `interop/runner/cli.ts`, with a test), then run again, signed out, one request a second:

| Company | Scenarios | Lenient | Strict |
| --- | --- | --- | --- |
| Alpine Retail | D, S0, N | 3 pass | 3 pass |
| Crosswalk, PlanMyVisit | D, S0, ML | 2 pass, ML unsupported (sign-in) | 2 pass, ML unsupported |
| Safe Rate | D, S0, ML | 3 pass | 3 pass |
| Stacktree | D, S0, ML | 3 pass | **refused at discovery**: its server metadata lists neither `private_key_jwt` nor the JWT bearer grant (`validator.metadata-auth-method`, `validator.metadata-grant-type`). Both rest on our reading, so the cells are blamed on the spec (rule `reading`), not on Stacktree. |
| Print with Poppy (store) | D | pass | pass |

The strict agent is the only source of checks in a live cell, since the live lane records nothing. Stacktree is the first live Company it refused; `pda` and the lenient agent tolerate those warnings.

**A mistake in that run.** S0 and ML were also run against `print-with-poppy-live`, whose notes allow discovery only. The store got two signed-out token requests from the test identity and refused both (`invalid_client`: unregistered agent); nothing past that was sent, and nothing was ordered. The registry now enforces such limits: `liveScenarios` (interop-spec §2) gives the store `D` only and Alpine Retail the four scenarios its developer agreed to, and any other scenario is unsupported before a request is made.

# Live tests — 24 October 2026: the identity on poppydemoagent.dev

The live lane signed as the deployed Worker's own interop test client, `https://poppydemoagent.dev/poppy/interop/client.json` (key `interop-2026-10-13`, the private half in the runner's gitignored `interop/.live-identity.json`), not a static-hosted one. Signed out, one request a second, all three agents that may run live:

| Company | Scenarios | pda | Lenient | Strict |
| --- | --- | --- | --- | --- |
| Print with Poppy Agent Sandbox (`sandbox.printwithpoppy.com`) | D, S0 | 2 pass | 2 pass | 2 pass |
| Alpine Retail | D, S0, N, C | 4 pass | 4 pass | 4 pass |

18 pass, 0 fail, with no checks failed or warned.

- **The sandbox opens a Session for our agent's domain.** It refused two identities before with the same `invalid_client`, "This agent must register its HTTPS metadata URL before opening a session.": 23 October's jsDelivr-hosted test key, and, in this day's first run, the interop client on the old `workers.dev` host, whose `/poppy/*` has answered 404 since 15 October. It accepted the one on `poppydemoagent.dev`. Whether it admits that `client_id` by name, by host, or because its metadata could be fetched, we can't see. The production client, `/poppy/client.json`, wasn't tried. Nothing past a signed-out Session was sent; the sandbox's payments are simulated in any case.
- **Alpine accepts the interop identity on the new domain**, with all four of the scenarios its developer agreed to (`liveScenarios`). Its earlier runs used the `workers.dev` identity (13 and 14 October) and a jsDelivr one (23 October).
- **Why the first run failed.** `interop/.live-identity.json` was made on 13 October and still named the `workers.dev` `client_id`; `scripts/interop-live-identity.mjs` only warns when `PUBLIC_ORIGIN` differs, and the runner signed with the stale name. The key was already the one the Worker serves, so only the file's `client_id` changed. A runner that moved domains checks that the `live identity:` line the runner prints names `PUBLIC_ORIGIN`.
- Results are in the gitignored `interop/results/` runs of 24 October (`c7aa1c`, `ac6137`, `fa4be4`, `3e86d5`); no tokens or traffic are copied here. No findings were posted to another project.
