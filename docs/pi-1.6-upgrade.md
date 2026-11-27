# pi 1.6.1 and agents 0.34.1: the upgrade

Back to the [README](../README.md) · Why: [decision 57](decisions.md#57-pi-161-and-agents-0341-a-forward-only-storage-and-the-watch-transport)

This is the plan for moving PDA from pi 1.3.0 and `agents` 0.28.1 to pi 1.6.1 and `agents` 0.34.1, and the record of how it went. It was written on 27 November 2026, before the work started, and the [status](#status) section is updated as each step lands.

## Why now

- pi-ai 1.6.1 lists `gemini-4-hydrogen` in its Google catalog, so the Gemini own-key lane ([adewale/pda#74](https://github.com/adewale/pda/pull/74)) can use pi's own model entry instead of keeping one in our code. 1.6.0 lists it too but fails `xhigh` thinking on it before the request is sent; 1.6.1 fixes that.
- `agents` supports one pi minor at a time: 0.29 pins pi `~1.3.0`, 0.30 to 0.32 `~1.4.0`, 0.33 `~1.5.0`, 0.34.1 `~1.6.1`. pi-durable pins pi-ai, chord, pi-codemode, pi-telemetry and (new) pi-schema to its own exact version. The whole family moves together, or not at all.
- Each further pi minor we skip makes the next move larger.

## What changes, and what doesn't

### Storage: forward only

- **Same tables.** `agents` 0.28.1 kept pi's tables under `pi_` with its own identifier-rewriting adapter; 0.34.1 uses pi's own Durable Object adapter with `prefix: "pi_"`. Both name every table `pi_<name>` (`pi_entries`, `pi_tasks`, `pi_durable_schema`, …). Our own tables are untouched.
- **The transcript is not rewritten.** The one SQL migration (schema version 2, pi 1.4.0) rebuilds `pi_tasks` to allow a `sleeping` status, copying its rows. `pi_entries`, which holds every message, is unchanged. Some of pi's stored documents move to new versions (`pi.live` 3, `pi.tool` 4, `pi.generation` 3), converted as they are read.
- **No rollback.** pi 1.3.0 refuses a database at schema version 2 ("schema version 2 is newer than supported version 1"), so once an agent opens on the new code, the old Worker can't open that agent's pi at all. A bad deploy is fixed by deploying forward.
- **A one-time cost per agent.** The first wake on the new code copies the agent's task rows inside a transaction: extra rows written and a slower first turn, once.

### Code

| Area | Change |
| --- | --- |
| Dependencies | `@earendil-works/pi-ai`, `pi-durable`, `chord`, `pi-telemetry` `~1.6.1`; new `pi-schema` `~1.6.1`; `agents` 0.34.1 |
| Example copies | `src/protocol.ts`, `sockets.ts`, `view.ts`, `transcript.ts` re-synced byte for byte from Cloudflare's example, which now uses `session.watch()`; its `mirror.ts` (the client's copy of the session) joins them, unchanged |
| Page transport | `src/use-pi-session.ts` keeps its outbox, auth checks and Poppy frames and follows the session with the example's `PiSessionMirror`: a `watch` on each open, a view and pi's operations, and `entries` pages for earlier messages and gaps |
| History | `src/history.ts`'s `history.before` frames and `src/ui/history.ts`'s snapshot handling give way to pi's `ConversationTranscript`, which pages entries before the view's window, summaries included |
| Turn log | `src/agent-log.ts` follows the root session with `session.watch()` and reads runs, rounds, retries, compactions and failures from `pi.live` instead of from agent events |
| pi hooks and options | The summarizer returns `{ kind: "decline" }` and `{ kind: "summary", summary }`; `onReport` takes one tagged `Report`; the factory passes `onWake`, so an agent hibernates while pi's tasks sleep |
| Tool schemas | `Type` and `TSchema` come from `typebox`, which pi-ai no longer re-exports |

### Behaviour

- **Partial answers are stored later.** Streamed text and running tool output reach storage with the next commit that reads `pi.live` (the end of the answer, a tool settling, the run ending). The page still sees each token at once; a crash mid-answer loses more of the partial than before.
- **No resend after a crash.** A model request in flight when the host died counts as a failed attempt under the retry settings, instead of being sent again on open.
- **The restart limit ends a task** visibly, instead of parking it.
- **The view is a window** of the newest 50 to 100 entries. The page pages older ones in as before, now through pi.
- **A new `User-Agent`** on own-key calls: `pi/<version> (<platform>; <runtime>; <arch>)`.
- **Open tabs** at deploy time speak the old socket protocol and need a reload.

## Steps

1. **Baseline.** On main, Node 24, `npm ci --legacy-peer-deps`: `npm run typecheck` and `npm test`, so a later failure can be pinned on the upgrade.
2. **Dependencies.** Bump the family and `agents` together; `npm install --legacy-peer-deps`; regenerate nothing else.
3. **Compile errors first.** `npm run typecheck`, then fix each error: the example copies, the transport, the turn log, hooks, options and schemas.
4. **Tests.** The Workers suite, the durability suite, the page tests, interop and properties. Tests change only where the wire or pi's API changed; a test that asserted behaviour stays asserting it.
5. **Specialist checks.** `npm run check:docs`, `check:spec`, `test:properties`, `check:approval-crashes`, `npm run build` (bundle size).
6. **Record.** Decision 57, this document's status, the spec's dependency table and example commit, and the live checks in [deployment-tasks](deployment-tasks.md).
7. **Deploy (owner).** Not part of this change: on the hosted test pair first, then production, with the roll-forward rule above.

## Merging beside the Gemini lane

The upgrade lands first, on its own. The Gemini lane ([adewale/pda#74](https://github.com/adewale/pda/pull/74)) then rebases onto it: it drops its catalog entry for `gemini-4-hydrogen`, converts its messages to `src/diagnostic.ts`'s `Problem`s ([decision 54](decisions.md#54-every-diagnostic-says-what-was-expected-and-what-was-got)), and takes the next free decision number.

## Status

- [x] Plan written (this document).
- [x] Baseline on main (`7fa66e0`), Node 24: typecheck clean; `npm test` 1,843 Workers tests (1 skipped), 3 durability, 334 page, 468 interop, 210 property, all passing.
- [x] Dependencies: pi-ai, pi-durable, chord, pi-telemetry and pi-schema 1.6.1, `agents` 0.34.1, one copy of each.
- [x] Code: as in the table above. Two changes the plan didn't foresee:
  - **The demo model's name.** `agents` now runs a gateway model through `env.AI.run` and names it as AI Gateway's catalog does, `anthropic/claude-sonnet-5.5`; under the old `DEMO_MODEL_ID` every demo call failed. `withVendorCompat` had to map the dotted id back to Anthropic's, or the demo lane would have stopped asking Anthropic to drop stale thinking blocks without any test failing but the one that checks the request.
  - **A runtime table.** The schema test skips `_cf_METADATA`, the runtime's own table, which an object may not read and the new `agents` makes the runtime create.
- [x] Tests: `npm test` 1,861 Workers tests (1 skipped; the 18 new ones are pi 1.6's storage conformance cases, run on both storages), 3 durability, 334 page (the history tests rewritten for the new module, and three new ones for loading earlier entries, filling a reconnect's gap, and stopping after a failed page, which fail without the loading), 468 interop, 210 property, all passing.
- [x] Specialist checks: typecheck, `check:docs`, `check:spec`, `check:approval-crashes` (16 scenarios), `test:tooling` (37), `npm run build`. The Worker bundle grows from 4.77 MB to 5.25 MB (about 1.11 MB to 1.22 MB gzipped).
- [ ] Not run here: `npm run interop` (needs Docker) and `test:hypothesis` (no protocol or mock change).
- [ ] Deploy and live checks (owner): [deployment-tasks](deployment-tasks.md#remaining-live-checks).
