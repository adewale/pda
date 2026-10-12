# Deployment tasks

Everything left to deploy the agent and verify it, in order. Each item is **Owner** (done in a dashboard, a terminal or a document, with no code change) or **Code** (a change in this repository). [setup.md](setup.md) has the how-to for each configuration step; this file is the checklist and the record of what's done. The spec's [Status](../durable-personal-agent-spec.md#status) table holds the current state.

Back to the [README](../README.md) · Why it's built this way: [decisions.md](decisions.md)

## 1. Configuration and accounts

- [ ] **Owner. Create `deployment.local.json`** from `deployment.example.json` ([setup §1](setup.md#1-say-who-the-deployment-is-for)). It is untracked; `npm run deploy` stops without it. What each field decides:
  - `OWNERS`: the operators, always let in and always on the demo, whatever the other lists say. It must name someone, or every route but the validator refuses.
  - `SIGNIN_ALLOWLIST`: who else may sign in while `SIGNUP` is `allowlist` (the committed value). With `SIGNUP=open` anyone with a Google or GitHub account may.
  - `DEMO_ALLOWLIST`: who else the operator pays model calls for, up to the daily caps. Everyone not on it, and not an owner, needs their own key.
  - `PUBLIC_ORIGIN`: where the agent's Poppy identity lives. It becomes the `client_id` every Company knows the agent by, forever (item "The final domain" below).
  - `POPPY_LOGO_URI`: the logo Companies show on their consent pages, normally `<origin>/logo.svg`.
  - Optionally any other declared var, such as `DEMO_GATEWAY_ID` (next item).
- [x] **Owner. `DEMO_GATEWAY_ID`.** The template says `demo`; the live deployment's `deployment.local.json` sets `"DEMO_GATEWAY_ID": "dpa-gateway"`, the gateway the owner created on 12 October ([setup §3](setup.md#3-the-demo-optional-claude-on-your-bill-capped)).
- [ ] **Owner. The Cloudflare dashboard** ([setup §3](setup.md#3-the-demo-optional-claude-on-your-bill-capped)):
  - [x] a gateway (`dpa-gateway`) with Unified Billing; [ ] Authentication on and logging off or minimal, unconfirmed (Wrangler's login token can't read AI Gateway settings);
  - [x] credits loaded ($100 on 12 October); [ ] auto top-up confirmed off;
  - [x] a spend limit (the owner added one on 12 October); [ ] spend rules as a backstop to the agent's own caps: one split by `metadata.u`, one by `metadata.d`, and a pooled daily cap;
  - [ ] the account's credit limit;
  - [ ] no provider keys (BYOK) stored on any gateway;
  - [ ] no API tokens with "AI Gateway Run".
- [ ] **Owner. OAuth apps** ([setup §4 and §5](setup.md#4-a-github-oauth-app)).
  - [x] GitHub: configured for the live deployment; the live redirect to GitHub checks out (spec, Status).
  - [x] Google: registered on 12 October; its two secrets are set in the dashboard, `SIGNIN_PROVIDERS` lists both providers again, and the live `/auth/google` redirects to Google with the right client and callback. The consent screen links `<origin>/privacy`.
- [ ] **Owner. Secrets**, set in the owner's own terminal with `wrangler secret put`, so no value passes through anyone else ([setup §2](setup.md#2-secrets)). `SESSION_SECRET`, `POPPY_SIGNING_JWKS` and `TOKEN_ENC_KEY` are set on the live deployment; `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set (the redirect to GitHub reads both); Google's two were added in the dashboard on 12 October.
- [ ] **Owner. The final domain for `client_id`**, before registering at any Company. Changing `PUBLIC_ORIGIN` later makes the agent a new Personal Agent to every Company (spec, "Our agent's identity"). Open question: will Companies accept a `workers.dev` host? For a custom domain: attach it in the dashboard (a `routes` entry in the committed `wrangler.jsonc` would name the deployer's host, which `test/template.test.ts` refuses), set `PUBLIC_ORIGIN` and `POPPY_LOGO_URI` to it, and change both OAuth apps' callback URLs.
- [ ] **Owner. `npm run deploy`.** It builds, checks the build names an owner and an origin, then deploys.

## 2. Live checks

From the spec's Model access, "Check live", and the parts tested only in fakes or happy-dom. Each is **Owner** to run; any that fails becomes **Code**.

- [x] Own keys: pi-ai's Anthropic and OpenAI SDKs streaming in workerd with a real key of each (12 October: the owner's OpenAI key, and an Anthropic key created inside a workspace; an organisation-wide Anthropic key needs a workspace ID, which Settings now takes).
- [x] The key checks: a pasted key is checked with the vendor's free list-models call (`GET /v1/models`) before it is sealed, and a refused key shows the vendor's reason (12 October).
- [x] The demo: Claude Sonnet 5.5 through the AI binding on Unified Billing, through `dpa-gateway` (12 October, after credits were loaded). Every demo call carries the `anthropic-beta` header the compaction fix adds, so the gateway passes it through.
- [ ] The demo after a compaction (preserved thinking): in a conversation that has thinking turns, go past 184k tokens of context (or send a request the model calls too long) so a summary is placed, then send one more turn. It should answer, not fail with a 400 about thinking blocks or signatures. The header half is shown by the plain demo call above; the summary-then-turn half is still untried. The demo request now asks Anthropic to drop stale thinking blocks (`block_binding`, beta `thinking-binding-controls-2026-08-01`), which works only if AI Gateway passes the `anthropic-beta` header and the body through unchanged; a 400 naming an unknown field or beta means it doesn't ([decisions §23](decisions.md#23-compaction-a-budget-our-summarizer-the-page)). The own-key Anthropic lane sends the same request straight to Anthropic, so check it once with a real key too.
- [ ] The gateway metadata (`u`, `d`) reaches the spend rules; the 429 they return; how far a burst overshoots.
- [ ] Settings in a real browser: the key panel (paste, remove), the demo meter, and the needs-key banner.
- [ ] The Content-Security-Policy doesn't break the deployed page: the theme script, the WebSocket, images, the validator's pages.
- [ ] Sign-in end to end: GitHub works (the owner signs in with it); Google works end to end (the owner signed in on 12 October); still to try: a `sierra.ai` Workspace account, and someone not on a list being refused.
- [ ] If a "Deploy to Cloudflare" button is added: how it handles the deployer's vars.

## 3. Then

- [ ] **Owner. Try the agent against a live Company Agent.** It hasn't run against one yet; Spot publishes valid discovery but isn't in the grid ([ecosystem.md](ecosystem.md#companies-you-can-reach)). Check discovery, a Session, sign-in, a conversation, and the website through the fetch-based browser. Anything it finds is **Code**.
- [ ] **Owner. Update and submit the OpenClaw and Hermes proposals**, after that check ([proposals/README.md](proposals/README.md) lists what to fold in first). Nothing is posted without the owner.
- [ ] **Owner. Run the live lane**: `npm run interop -- --lane live` (our agent against `ilmer-live` and `poppyseed-live`, signed-out scenarios only, one request a second).
- [ ] **Code. The adapters not yet run:** build `everruns-agent` and `everruns-company` (they need more Docker disk; see Environment cleanup), then add them to `interop/registry.json`; `typo3-dirnbauer-company` needs the private extension first.

## 4. Environment cleanup

On the machine that ran the interop grid. **Owner**; check `docker images` before removing anything.

- [ ] Remove the Docker images that are ours to remove: those named `ib-*`, and the `:adv` and `:audit` tags of `poppy-interop/*`. For example `docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^ib-|:(adv|audit)$' | xargs docker rmi`. The runner never removes images itself.
- [ ] Grow colima's disk, which filled during the grid and kept everruns out: `colima stop`, then `colima start --disk <GiB>` with a larger size (colima grows a disk, it doesn't shrink one).
- [ ] Remove the swap file added to the colima VM for everruns' build: `colima ssh -- sudo sh -c 'swapoff /swapfile-interop && rm /swapfile-interop'`.
