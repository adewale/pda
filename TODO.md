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
- [ ] **Owner. Allow or deny npm install scripts.** Node 24's npm skips dependency install scripts unless approved, and warns about seven (`workerd`, `esbuild`, `koffi`, `protobufjs`, `fsevents`, `core-js-pure`, `@google/genai`); every check passes without them. Decide with `npm install-scripts approve|deny <package>`.
- [ ] **Owner. Node 26** becomes LTS on 28 October 2026; Node 24 (now used) is supported until April 2028.

## Product

- [ ] **Code. Give compaction a budget.** Pi already compacts automatically, but only near the model's 1M-token window, so every turn before that pays for the whole conversation. Proposed: a 180–200k budget, `poppy_status` listing everything open, the summary shown as a notice, and tests. Check live whether the demo lane rejects compacted histories (preserved thinking).
- [ ] **Code. "Delete my agent" and data export** (milestone 2): revoke every Account Token at its Company, then delete the Durable Object's storage. Also a short privacy statement about what each agent stores.
- [ ] **Code. Memory, skills and the rest of milestone 2** ([spec, Build plan](durable-personal-agent-spec.md#build-plan)).
- [ ] **Code. Hide Google sign-in while it isn't configured.** Today `/auth/google` answers a 500.
- [ ] **Code. Check the `pi report` log line** (`src/agent.ts`, `console.warn("pi report", error)`) can't carry request details or keys into Workers logs.
- [ ] **Code. A sign-in finished by recovery doesn't run the after-sign-in step**, so operations approved while waiting on it wait for the next sign-in.
- [ ] **Code. A user guide to verifying the agent works:** sign in, add a key, chat, check a Company with the validator, connect to a Company, read Activity.

## Testing and interop

- [ ] **Owner. Decide the grounding questions** in [spec/grounding.md](spec/grounding.md): which mock checks resting only on a keyword-less rule, the Guides or our readings stay violations in each profile; whether validator errors resting on the Guides or readings become warnings; whether grid attribution treats SHOULD, Guides and reading violations as warnings; and marking scenario YK `permitted_by: N5`.
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
