# PR 36 conformance evidence

These raw Chromium captures exercise the built application, its authenticated WebSocket, the real Poppy client and a strict mock Company. They replace supplied-state screenshots as the evidence for the approval interaction. [Problem inventory and upstream-audit reconciliation](../../poppy-0.3-conformance.md).

## User approval through to the Company's result

The same action stays unperformed after the first click, when the Company's exact terms arrive. The second click approves those terms; the mock performs once. Reloading retains **Done** on the original tool step and in Activity. The receipt records both actual browser WebSocket decisions, stored approval states and Company effect counts.

| Company terms, before execution | Original request, after approval and reload |
| --- | --- |
| ![OpenAPI exchange terms waiting for the User before any Company effect](api-before-desktop.png) | ![The original OpenAPI exchange request shows Done after the Company performed once and the page reloaded](api-after-desktop.png) |
| ![MCP exchange terms waiting on a narrow screen before any Company effect](mcp-before-mobile.png) | ![The original MCP exchange shows Done on mobile after approval and reload](mcp-after-mobile.png) |

## Lost answer and User-checked outcome

The mock performs the action and its response is lost. The original request remains **Outcome unknown**, and another proposal is blocked. The harness ages its receipt by two hours and reloads Chromium; the User's reconciliation choices remain available. Clicking **I checked: it happened** records the User's report over the WebSocket. The action is not sent again: the Company has one exchange request and one effect before and after reconciliation. Raw status/result remain uncertain in storage; the derived transcript and Activity attribute the checked outcome to the User.

| Uncertain outcome after reload | User-checked outcome after reload |
| --- | --- |
| ![An aged uncertain receipt remains visible with explicit User choices to record a checked outcome](unknown-before-desktop.png) | ![The original request shows the outcome reported by the User, with no second Company write](unknown-after-desktop.png) |

## Reproduce

From the repository root after installing its pinned dependencies, with Chromium available:

```sh
node scripts/app-smoke.mjs --approval-journey --output /tmp/pr36-conformance-browser.json
```

The default run builds production assets. `--skip-build` is only for local debugging. The checked-in `browser-smoke.json` records `builtThisRun: true`, the assertions and the selected screenshot names. The fixture is `test/browser/approval-journey-worker.ts`; the browser driver is `scripts/app-approval-journey.mjs`. Both are test-only. Production authentication verification, routes, UI and tool execution remain in use.

Independent checks include Worker approval/recovery tests, API/MCP lifecycle regressions and the page tests in `test/ui/outcome-resolution.test.tsx`. The Docker security lanes separately check mutated credentials, consumed authorization codes and actual action counts.

## Verification results

On 29 October 2026, Node 24.19.0:

- `npm test`: 1,971 passed and one skipped across 100 files. Workers: 1,155 passed/one skipped; durability: 3; UI: 247; interop: 376; properties: 190. Documented test/scenario references also passed.
- The independent Python client: `npm run test:hypothesis`, 18 passed in 78.72 seconds.
- Docker, PDA against both own Company profiles: 72 passed, including the restored replay scenario. The default cross-product reports 32 unsupported adversarial combinations; the explicit CI lanes select only applicable cells and reject skips with `--require-supported`.
- Docker, malicious Company against PDA: eight passed; malicious agent against both own Companies: 16 passed. The separate replay-only run passed both cells. No check failure or warning appeared in these runs.
- Docker, independent print-with-poppy at `b340741d696d867ff3190c10c1f1d1e0c368e846`: all ten supported scenarios passed, with no failures, unsupported cells or check warnings. Its builder uses the pinned slim runtime base with temporary build tools; runtime source, dependencies and commit stay unchanged.
- The production build and actual Chromium approval/recovery journeys passed. The earlier fixed-state screenshots are not substituted for these interactions.

`validation.json` records per-run counts, pins and hashes of the local result files. `browser-smoke.json` records assertions and hashes of the raw images and capture fixtures. Before-fix checks also demonstrated regression failures for outcome holds, the API 202 branch, MCP cache binding, metadata recovery, malformed issuers and missing scope hints; redirect-mode mutations leaked to the test sink and failed the transport controls.

The separate [hosted pair](../../../test/hosted/README.md) passed both upload dry-runs and local workerd consent/security checks. Credentials are still required for an actual deployment and live journey. The Company is an ephemeral strict mock: the live evidence checker rejects a run if its instance changes and resets its counters.

## Limits

Identity, model, Company authorization decisions and Company payment execution are synthetic. These captures establish the local interaction and effects, not live OAuth, arbitrary model behavior or external payments. The User's checked outcome is supplied from known mock state; production relies on the User checking with the Company. The earlier supplied-state captures remain historical evidence under `../pr-36-audit/`.
