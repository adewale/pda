# TODO

Everything left open. **Owner** items need a decision or an account; **Code** items need a change here. Deployment steps and live checks are in [docs/deployment-tasks.md](docs/deployment-tasks.md), in order.

## Decisions for the owner

- [ ] **A license.** None is chosen ([README](README.md#security-contributing-and-licence)). It blocks making the repository public, which the proposals and the interop harness's reuse depend on.
- [ ] **Make the repository public, or not.** The proposals and `docs/interop-results/` link into it.
- [ ] **The final domain for `client_id`**, before any Company registers the agent; it can't change afterwards ([deployment-tasks](docs/deployment-tasks.md#1-configuration-and-accounts)).
- [x] **CI's runner image.** Pinned to `ubuntu-26.04` on 12 October (the LTS `ubuntu-latest` becomes on 19 October); CI and interop both passed on it at `fdb1a07`.
- [ ] **A known-good Company to verify against.** Chosen: print-with-poppy's hosted demo, the demo journey below. It needs the store to allowlist our `client_id`. Deploying our own mock as an example Company stays the fallback if that doesn't happen.
- [ ] **Approval to file upstream bug reports**, found by the grid ([poppy-issues.md](docs/poppy-issues.md)): poppy-demo's hard-coded scopes; Datalayer's `session_id` on refresh, its API 403s without `WWW-Authenticate` (both still so at 0.10.0, `0c048aa`), and both SDKs requiring `conversation_id` in handoff and close answers; adonis-agora's `aud`; everruns' duplicate migration (fixed upstream since) and, privately under SECURITY.md, its Company's unchecked client assertion `sub` and its discovery documents built from the request's `Host` and cached publicly. Nothing is posted without the owner.
- [ ] **Send the spec issues to the draft's authors** ([spec-issues.md](docs/spec-issues.md), [readings.md](docs/readings.md)), once grounded against the current text. Fold in first the four questions the Hypothesis client raised ([test/hypothesis/README.md](test/hypothesis/README.md)).
- [ ] **Submit the OpenClaw and Hermes proposals** after the agent works against a live Company Agent ([proposals/README.md](docs/proposals/README.md) lists what to fold in first).

## Operations

- [ ] **Owner. Back up `TOKEN_ENC_KEY`** (for example in a password manager). Losing it loses every sealed Account Token and model key ([setup](docs/setup.md)).
- [ ] **Code. A runbook for rotating `POPPY_SIGNING_JWKS`**, and for a leaked signing key: add the new key, publish both, switch the signer, retire the old `kid` after Companies' caches expire, and give every new key a new `kid`.
- [ ] **Owner. Spending alerts:** a Cloudflare billing notification, and provider-side limits and alerts on any funded key. Done so far: $100 of credits and a spend limit on `dpa-gateway`.
- [ ] **Owner. Check `dpa-gateway`'s settings in the dashboard:** Authenticated Gateway on with no tokens, logging off or short retention, caching off, auto top-up off. Wrangler's login token can't read AI Gateway settings, so this can't be checked from here.
- [ ] **Owner. The privacy contact.** `/privacy` names `https://github.com/adewale`; set `PRIVACY_CONTACT` in `deployment.local.json` to an email address instead if you prefer, and redeploy.
- [ ] **Owner. Read the monthly dependency report.** `.github/workflows/deps.yml` runs `npm run deps:check` on the 1st (report only, no pull requests); it fails only on a high or critical audit finding.
- [ ] **Owner. Allow or deny npm install scripts.** npm warned about seven dependency install scripts (`workerd`, `esbuild`, `koffi`, `protobufjs`, `fsevents`, `core-js-pure`, `@google/genai`). Unverified: the `npm install-scripts approve|deny` command we noted doesn't exist in npm 11.12.1 (checked 12 October), which runs every script (`ignore-scripts=false`). The dependency audit's advice: `workerd` and `esbuild` are harmless to allow (they place native binaries that also arrive as optional packages); the other five do nothing we need (a banner, a warning, a no-op, a prebuilt binary).
- [ ] **Owner. Node 26** becomes LTS on 28 October 2026; Node 24.21.0 (now used everywhere: `.nvmrc`, CI, the Docker images) is supported until April 2028. Move after 28 October, or stay.

## Product

- [x] **Code. Give compaction a budget.** Done: a summary from 150k tokens, a hard limit at 184k, our summarizer keeping Company text apart, `poppy_status` listing everything open, the summary shown as a notice ([decisions §23](docs/decisions.md#23-compaction-a-budget-our-summarizer-the-page)). What's left is the live check of a demo-lane turn after a compaction (preserved thinking), in [deployment-tasks §2](docs/deployment-tasks.md#2-live-checks).
- [ ] **Code. "Delete my agent" and data export.** Now owed: `/privacy` (12 October) promises deletion within 30 days of a request, and today only the operator could do it, by hand. Build it before the policy is tested: revoke every Account Token at its Company, then delete the Durable Object's storage (memories, photos and keys included).
- [x] **Code. Memory, and the other general tools.** Built: `read_url`, `remember`, `recall`, `forget`, `now`, `date_math`, `calculate`, with Settings' Memory section ([decisions §27](docs/decisions.md#27-general-tools-beside-poppy-read_url-memory-time-and-maths)).
- [ ] **Code. Skills and the rest of milestone 2** ([spec, Build plan](durable-personal-agent-spec.md#build-plan)).
- [ ] **Code. More general tools:** web search (needs a provider and a key the operator pays for), and reminders (a durable job that tells the User at a time).
- [ ] **Code. Keep the User's time zone in storage.** The page sends it on connect and the agent holds it in memory, so after an eviction `now` answers in UTC until the page reconnects.
- [ ] **Owner. Try `read_url` and memory live:** a real page or two (one large, one that redirects), and "remember I'm vegetarian" across a week and a redeploy.
- [x] **Code. Hide Google sign-in while it isn't configured.** `SIGNIN_PROVIDERS` lists the providers a deployment offers. Google was registered on 12 October and the live deployment offers both; the owner signed in with Google.
- [ ] **Code. Check the `pi report` log line** (`src/agent.ts`, `console.warn("pi report", error)`) can't carry request details or keys into Workers logs.
- [ ] **Code. A sign-in finished by recovery doesn't run the after-sign-in step**, so operations approved while waiting on it wait for the next sign-in.
- [ ] **Code. A user guide to verifying the agent works:** sign in, add a key, chat, check a Company with the validator, connect to a Company, read Activity.
- [ ] **Code. The protocol log's gaps** ([decisions §25](docs/decisions.md#25-a-protocol-view-in-activity)): the OpenAPI description and MCP protected-resource metadata fetches (`apis.ts` fetches them with `fetchJson`, not the client) and website pages other than their 429 and 503 answers aren't logged; nor is the Direct Sign-In callback's `iss` check, only the sign-in's status change after it.
- [ ] **Owner. Browser Run (formerly Browser Rendering): deferred.** No Poppy Company needs JavaScript yet. Revisit when one does; the approval work is intercepting every request a page's own script sends. A cheaper first step: measure how often `read_url` gets an empty JavaScript shell, then decide on Browser Run's page-to-Markdown action as its fallback (within the free 10 browser-hours a month).
- [ ] **Code. Check the protocol view in a real browser** at phone width and in dark mode (tested in happy-dom only), and with a print ordered from print-with-poppy, the demo journey.

### The demo journey: "print this photo as a 6×4" at print-with-poppy

Built and passing in the grid (scenario OU, against the store at its pinned commit in demo mode) and in `test/print-journey.test.ts`. Left for the live journey:

- [ ] **Owner. Ask print-with-poppy to allowlist our `client_id`.** The store admits only agents its operator lists in `AGENT_CLIENT_IDS`, by exact `client_id` (`https://<PUBLIC_ORIGIN>/poppy/client.json`); until then its token endpoint answers `invalid_client` ("must register its HTTPS metadata URL"), which the agent reports as "hasn't approved this agent yet". Settle the final domain first, since the allowlisted URL can't change.
- [ ] **Owner. Confirm the store is in demo mode** (`GET /api/catalog` says `mode: "demo"`) before a live run, so nothing is charged or printed; outside demo mode an approved order is a real Stripe checkout the User pays.
- [ ] **Owner. Try it live once both are done**, on the deployed agent with a real photo: the two cards (sending the photo, then the order's terms), the receipt's checkout link.
- [x] **Code. Activity lists an operation the Company no longer has (N19) as still open.** Fixed: Activity's log says it may have happened or wasn't done, and neither Activity's in-progress list nor `poppy_status` lists it.
- [ ] **Code. HEIC photos** aren't taken; most browsers convert them for a file picker whose `accept` list leaves HEIC out, but a pasted or dropped HEIC is refused. Fix: the page already re-encodes photos to JPEG through a canvas, and Safari decodes HEIC, so convert there and ask for a JPEG where the browser can't.

## Testing and interop

- [x] **Grounding questions decided by a policy**, [docs/conformance-levels.md](docs/conformance-levels.md): a check's basis sets its level in the mock, the validator and the grid; YK is `permitted_by: N5`. **Owner:** review its judgement calls. The full grid ran again under it on 12 October with every cell's outcome unchanged ([interop-results](docs/interop-results/README.md)).
- [ ] **Owner. Re-check the spec** with `node scripts/spec-snapshot.mjs` before sending issues to its authors or submitting the proposals.
- [x] **Code. Scenarios `H`, `DC`, `W`, `O2`, `CM`:** written and run on 12 October, each derived from the draft section it targets; results and the two bugs they found in our browser in [interop-testing.md](docs/interop-testing.md#h-dc-w-o2-and-cm-12-october).
- [ ] **Code. Attacks not yet built:** `XM` (needs a two-Company cell), `XS` (needs N42's private test suffix), `YF` (a code only returns through the consent hook) and `YC` (needs a consent-page reader). Built: `XB`, `XN`, `XO`, `XP`, `XE`, `YM` ([adversarial-interop.md](docs/adversarial-interop.md)).
- [x] **Code. The Hypothesis client's gaps** are closed: the Operations extension, MCP, browsing, handoff and Direct Conversations, rate limits and Device Sign-In polling each have a state machine ([test/hypothesis/README.md](test/hypothesis/README.md)). They found five mock bugs, now fixed with tests, and four questions for the draft's authors (listed in that README). By the owner's decision (12 October 2026) the client is now an occasional local check, run after a draft change or a large mock change, not expanded further; what it leaves out is listed in that README.
- [x] **Code. The grid's rate-limit check** now reads 4.3 as the mock does: the same request sent again inside a `Retry-After` fails (`rate-limit.retry-after-ignored`, MUST); a different request to that Company is the Guides' warning (`rate-limit.shared-limit-ignored`).
- [ ] **Owner then Code. The adapters not yet run:** typo3 (needs the private extension) and the live lane, kept until our own side is verified ([deployment-tasks](docs/deployment-tasks.md#3-then)). everruns ran on 12 October, both sides, at `f470ad7` ([interop-testing.md](docs/interop-testing.md#everruns-joins-the-grid)); its cells aren't yet in a full grid run.

## Open questions in the spec

- [ ] Eviction: whether idle agents stay resident, and how often DPoP keys and tokens are renewed as a result.
- [ ] Push notifications are an open topic in the draft, so the agent polls.
- [ ] Standing permissions need a checkable action field (we now require the summary to begin with the permission's action, and every term to be an amount within its limit, a date or a plain identifier); DPoP nonces per server; a standard marker for writes that propose (we now put on our own card any write whose description doesn't declare a proposal); local Personal Agents. All in the [spec's Open questions](durable-personal-agent-spec.md#open-questions-and-risks).

## Environment (this machine)

- [ ] **Owner. Docker:** colima's disk is grown (157 GB). Still to remove: our leftover `ib-*` images and the `poppy-interop/*:tg1` images the scenario work left. The colima swap file (`/swapfile-interop`) stays: rebuilding the everruns images needs it switched on (`colima ssh -- sudo swapon /swapfile-interop`), or the Rust build runs out of memory ([deployment-tasks §4](docs/deployment-tasks.md#4-environment-cleanup)).
- [ ] **Owner. Old git worktrees** from earlier sessions in `.claude/worktrees/`.
- [ ] **Owner. The pre-push hook** is on only in this clone; a fresh clone needs `git config core.hooksPath .githooks`.
