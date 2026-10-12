# TODO

Everything left open, in one place. **Owner** items need a decision or an account; **Code** items need a change here. Deployment steps and live checks aren't repeated here; they're in [docs/deployment-tasks.md](docs/deployment-tasks.md), in order.

## Decisions for the owner

- [ ] **A license.** None is chosen ([README](README.md#support-contributing-and-license)). It blocks making the repository public, which the proposals and the interop harness's reuse depend on.
- [ ] **Make the repository public, or not.** The proposals and `docs/interop-results/` link into it.
- [ ] **The final domain for `client_id`**, before any Company registers the agent; it can't change afterwards ([deployment-tasks](docs/deployment-tasks.md#1-configuration-and-accounts)).
- [ ] **CI's runner image.** `ubuntu-latest` moves to Ubuntu 26 from 19 October 2026 (GitHub's notice on our runs): pin `ubuntu-24.04`, or accept the move.
- [ ] **A known-good Company to verify against.** None is documented. Options: deploy our mock Company as an example Company Worker we own, or document the public demo Companies with what our local grid shows works against their code.
- [ ] **Approval to file upstream bug reports**, found by the grid ([poppy-issues.md](docs/poppy-issues.md)): poppy-demo's hard-coded scopes; Datalayer's `session_id` on refresh and its 403s without `WWW-Authenticate`; adonis-agora's `aud`; everruns' duplicate migration. Nothing is posted without the owner.
- [ ] **Send the spec issues to the draft's authors** ([spec-issues.md](docs/spec-issues.md), [readings.md](docs/readings.md)), once grounded against the current text.
- [ ] **Submit the OpenClaw and Hermes proposals** after the agent works against a real Company Agent ([proposals/README.md](docs/proposals/README.md) lists what to fold in first).

## Operations

- [ ] **Owner. Back up `TOKEN_ENC_KEY`** (for example in a password manager). Losing it loses every sealed Account Token and model key ([setup](docs/setup.md)).
- [ ] **Code. A runbook for rotating `POPPY_SIGNING_JWKS`**, and for a leaked signing key: add the new key, publish both, switch the signer, retire the old `kid` after Companies' caches expire (N38).
- [ ] **Owner. Spending alerts:** a Cloudflare billing notification, and provider-side limits and alerts on any funded key.
- [ ] **Owner. Read the monthly dependency report.** `.github/workflows/deps.yml` runs `npm run deps:check` on the 1st (report only, no pull requests); it fails only on a high or critical audit finding.
- [ ] **Owner. Allow or deny npm install scripts.** An npm warned about seven dependency install scripts (`workerd`, `esbuild`, `koffi`, `protobufjs`, `fsevents`, `core-js-pure`, `@google/genai`). Unverified: the `npm install-scripts approve|deny` command we noted doesn't exist in npm 11.12.1 (checked 12 October), which runs every script (`ignore-scripts=false`). The dependency audit's advice: `workerd` and `esbuild` are harmless to allow (they place native binaries that also arrive as optional packages); the other five do nothing we need (a banner, a warning, a no-op, a prebuilt binary).
- [ ] **Owner. Node 26** becomes LTS on 28 October 2026; Node 24 (now used) is supported until April 2028.

## Product

- [x] **Code. Give compaction a budget.** Done: a summary from 150k tokens, a hard limit at 184k, our summarizer keeping Company text apart, `poppy_status` listing everything open, the summary shown as a notice ([decisions §23](docs/decisions.md#23-compaction-a-budget-our-summarizer-the-page)). What's left is the live check of a demo-lane turn after a compaction (preserved thinking), in [deployment-tasks §2](docs/deployment-tasks.md#2-live-checks).
- [ ] **Code. "Delete my agent" and data export** (milestone 2): revoke every Account Token at its Company, then delete the Durable Object's storage. Also a short privacy statement about what each agent stores.
- [ ] **Code. Memory, skills and the rest of milestone 2** ([spec, Build plan](durable-personal-agent-spec.md#build-plan)).
- [ ] **Code. Hide Google sign-in while it isn't configured.** Today `/auth/google` answers a 500.
- [ ] **Code. Check the `pi report` log line** (`src/agent.ts`, `console.warn("pi report", error)`) can't carry request details or keys into Workers logs.
- [ ] **Code. A sign-in finished by recovery doesn't run the after-sign-in step**, so operations approved while waiting on it wait for the next sign-in.
- [ ] **Code. A user guide to verifying the agent works:** sign in, add a key, chat, check a Company with the validator, connect to a Company, read Activity.

### The demo journey: "print this photo as a 6×4" at print-with-poppy

Built and passing in the grid (scenario OU, against the store at its pinned commit in demo mode) and in `test/print-journey.test.ts`. Left for the live journey:

- [ ] **Owner. Ask print-with-poppy to allowlist our `client_id`.** The store admits only agents its operator lists in `AGENT_CLIENT_IDS`, by exact `client_id` (`https://<PUBLIC_ORIGIN>/poppy/client.json`); until then its token endpoint answers `invalid_client` ("must register its HTTPS metadata URL"), which the agent reports as "hasn't approved this agent yet". Settle the final domain first, since the allowlisted URL can't change.
- [ ] **Owner. Confirm the store is in demo mode** (`GET /api/catalog` says `mode: "demo"`) before a live run, so nothing is charged or printed; outside demo mode an approved order is a real Stripe checkout the User pays.
- [ ] **Owner. Try it live once both are done**, on the deployed agent with a real photo: the two cards (sending the photo, then the order's terms), the receipt's checkout link.
- [ ] **Code. Activity lists an operation the Company no longer has (N19) as still open**, because `src/poppy/activity.ts` reads the operation's own state; the card, the model and the confirm path already treat it as final. Left while that file is being changed elsewhere.
- [ ] **Code. HEIC photos** aren't taken; most browsers convert them for a file picker whose `accept` list leaves HEIC out, but a pasted or dropped HEIC is refused.

## Testing and interop

- [x] **Grounding questions decided by a policy**, [docs/conformance-levels.md](docs/conformance-levels.md): a check's basis sets its level in the mock, the validator and the grid; YK is `permitted_by: N5`. **Owner:** review its judgement calls, and rerun the full grid under it (some third-party cells may change rule, or newly fail on validator errors that were warnings).
- [ ] **Owner. Re-check the spec** with `node scripts/spec-snapshot.mjs` before sending issues to its authors or submitting the proposals.
- [ ] **Code. Scenarios not yet written:** `H`, `DC`, `W`, `O2`, `CM` ([interop-testing.md](docs/interop-testing.md)).
- [ ] **Code. Attacks not yet built:** `XM`, `XS` (needs N42's private test suffix), `XB`, `XN`, `XO`, `XE`, `XP`, `YF`, `YC`, `YM` ([adversarial-interop.md](docs/adversarial-interop.md)).
- [ ] **Code. The Hypothesis client's gaps:** the Operations extension, MCP, browsing, handoff and Direct Conversations, rate limits, Device Sign-In polling ([test/hypothesis/README.md](test/hypothesis/README.md)).
- [ ] **Owner then Code. The adapters not yet run:** everruns (needs Docker disk), typo3 (needs the private extension), and the live lane, kept until our own side is verified ([deployment-tasks](docs/deployment-tasks.md#3-then)).

## Open questions in the spec

- [ ] Eviction: whether idle agents stay resident, and how often DPoP keys and tokens are renewed as a result.
- [ ] Push notifications are an open topic in the draft, so the agent polls.
- [ ] Standing permissions need a checkable action field; DPoP nonces per server; writes at Companies with the Operations extension; local Personal Agents. All in the [spec's Open questions](durable-personal-agent-spec.md#open-questions-and-risks).

## Environment (this machine)

- [ ] **Owner. Docker:** remove our leftover images and grow colima's disk; remove the colima swap file ([deployment-tasks §4](docs/deployment-tasks.md#4-environment-cleanup)).
- [ ] **Owner. Old git worktrees** from earlier sessions in `.claude/worktrees/`.
- [ ] **Owner. The pre-push hook** is on only in this clone; a fresh clone needs `git config core.hooksPath .githooks`.
