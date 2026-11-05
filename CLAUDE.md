# Working on PDA

Read the design sections relevant to your change in [pda-spec.md](pda-spec.md). Use this guide to find them; reading the whole design is not a prerequisite for a small change.

## Find the right source

| Change | Start here |
| --- | --- |
| Worker, sign-in, per-person agent | `src/index.ts`, `src/oauth.ts`, `src/session.ts`, `src/agent.ts`; design: Architecture and Signing in |
| Poppy client or approval flow | `src/poppy/`; design: Poppy client; [operation authorization](docs/operation-authorization.md) |
| API internals, card components or data controls | [Implementation boundaries](docs/architecture.md); preserve public exports and executor initialization |
| Validator or mock checks | `src/validator/`, `test/mock-company/`; [Company testing](docs/company-testing.md), [conformance levels](docs/conformance-levels.md) |
| Chat, Activity, Settings | `src/ui/`, `src/poppy-ui.tsx`; design: Chat transport and UI |
| Tools, schedules, model access | `src/tools/`, `src/schedules.ts`, `src/model-router.ts`; corresponding design sections |
| Interop | [interop/README.md](interop/README.md), [harness contract](docs/interop-spec.md) |
| Deployment | [setup](docs/setup.md), [deployment state and live checks](docs/deployment-tasks.md) |
| Protocol refresh | [upgrade procedure](docs/upgrading.md), `spec/upstream.json` |

The design owns architecture and requirements. [Decisions](docs/decisions.md) preserve rationale, including superseded choices. [Verification](docs/poppy-0.3-conformance.md#current-verification) owns protocol verification status; deployment-tasks owns deployed state and live checks; [TODO](TODO.md) owns remaining product work. Link to these sources instead of copying their status into other documents. Dated reports and evidence are frozen records; update the current source, not the old report. Proposals are parked until submission is scheduled; do not refresh their statistics.

## Commands

Use Node 24 (`.nvmrc`) and `npm ci --legacy-peer-deps`.

- `npm test`: five offline Vitest projects. Use a targeted Vitest command during development; run the full suite for code changes.
- `npm run typecheck`: types; the optional `.githooks/pre-push` runs this too.
- `npm run check:docs`: dependency-free documentation file/scenario references, independent of test titles.
- `npm run check:spec`: pinned specification integrity and generated requirement ledger.
- `npm run test:properties`: ordinary property cases; deep runs stay local.
- `npm run test:hypothesis`: occasional independent Python check after protocol or major mock changes; not a feature-by-feature maintenance obligation.
- `npm run check:approval-crashes`: actual process termination and replay checks.
- `npm run interop -- --agents pda --companies lenient-company`: Docker grid.
- `npm run deploy`: configured build and deploy; see deployment-tasks before promotion.

CI runs documentation references on every PR. Runtime checks run for code/config changes; specialist checks run when their inputs change. Main runs the full CI workflow. No CI workflow deploys. Monthly dependency checks report findings without automatic PRs.

## Invariants to preserve

- No authentication bypass, including development and tests. Identity, Company, account and approval authority come from trusted state, never model arguments.
- Only the person's interface can approve a Company's exact terms. Task-selected photos need no extra disclosure click; unselected files and website forms retain local consent. Preserve unknown-outcome holds and durable replay/notification state.
- Credentials never reach models, tools, transcripts or logs. Use `src/log.ts`, its safe constructors and redaction; no other source `console` calls. Decode boundary data and SQL rows through the existing decoders.
- Poppy tests fail on unexpected strict-mock violations or warnings. A new protocol check needs its stable id/basis in `violations.ts` and a negative `TAMPERS` case; [Company testing](docs/company-testing.md) explains why. Keep independent oracles independent.
- Whole-runtime Durable Object resets belong only in `test/durability/`. Ordinary tests fake external services. Interop-only fault injection stays in adapters.
- `src/protocol.ts`, `src/sockets.ts`, `src/view.ts` and `src/transcript.ts` are unchanged Cloudflare example copies; re-sync instead of editing them.
- Deployment identities stay in untracked `deployment.local.json`; never commit private configuration. Regenerate `env.d.ts` after changing Wrangler bindings. Preserve pinned Docker digests.
- Ambiguous protocol readings belong in [readings](docs/readings.md), distinguishing requirements from recommendations and local policy. Use the pinned text, never dynamic rules at runtime.
- Findings in others' code follow [SECURITY.md](SECURITY.md): private disclosure first, and owner approval before any external post or email. Preparing a draft does not authorize sending it.
