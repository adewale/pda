# Deployment tasks

Everything left to deploy the agent and verify it, in order. Each item is **Owner** (done in a dashboard, a terminal or a document, with no code change) or **Code** (a change in this repository). [setup.md](setup.md) has the how-to for each configuration step; this file is the checklist and the record of what's done. This file owns deployed state and outstanding live checks; [protocol verification](poppy-0.3-conformance.md#current-verification) owns the recorded protocol evidence.

Back to the [README](../README.md) · Why it's built this way: [decisions.md](decisions.md)

## 1. Configuration and accounts

- [x] **Owner. Create `deployment.local.json`** from `deployment.example.json` ([setup §1](setup.md#1-say-who-the-deployment-is-for)). It is untracked; `npm run deploy` stops without it. Done for the live deployment. What each field decides:
  - `OWNERS`: the operators, always let in and always on the demo, whatever the other lists say. It must name someone, or every route but the validator refuses.
  - `SIGNIN_ALLOWLIST`: who else may sign in while `SIGNUP` is `allowlist` (the committed value). With `SIGNUP=open` anyone with a Google or GitHub account may. The live deployment set `"SIGNUP": "open"` in its `deployment.local.json` on 15 October: anyone may sign in, and only `OWNERS` and `DEMO_ALLOWLIST` get the demo, so a stranger's model calls go on their own key. What the operator still pays for per person is storage, Worker requests and `read_url`'s Browser Run renders (10 an hour per agent); the spend limits and budget alert below matter more with it open.
  - `DEMO_ALLOWLIST`: who else the operator pays model calls for, up to the daily caps. Everyone not on it, and not an owner, needs their own key.
  - `PUBLIC_ORIGIN`: where the agent's Poppy identity lives. It becomes the `client_id` every Company knows the agent by, forever (item "The final domain" below).
  - `POPPY_LOGO_URI`: the logo Companies show on their consent pages, normally `<origin>/logo.svg`.
  - Optionally any other declared var, such as `DEMO_GATEWAY_ID` (next item).
- [x] **Owner. `DEMO_GATEWAY_ID`.** The template says `demo`; the live deployment's `deployment.local.json` sets `"DEMO_GATEWAY_ID": "dpa-gateway"`, the gateway the owner created on 12 October ([setup §3](setup.md#3-the-demo-optional-claude-on-your-bill-capped)).
- [ ] **Owner. The Cloudflare dashboard** ([setup §3](setup.md#3-the-demo-optional-claude-on-your-bill-capped)):
  - [x] a gateway (`dpa-gateway`) with Unified Billing; [ ] Authentication on and logging off or minimal, unconfirmed (Wrangler's login token can't read AI Gateway settings);
  - [x] credits loaded (12 October); [ ] auto top-up confirmed off;
  - [x] a spend limit (the owner added one on 12 October); [ ] spend rules as a backstop to the agent's own caps: one split by `metadata.u`, one by `metadata.d`, and a pooled daily cap;
  - [ ] the account's credit limit;
  - [ ] no provider keys (BYOK) stored on any gateway;
  - [ ] no API tokens with "AI Gateway Run".
  - [ ] a budget alert on the account (**Manage Account** > **Billing** > **Billable Usage** > **Set Budget Alert**). It only emails, once per billing cycle, when projected monthly spend crosses the threshold; it stops nothing. Not confirmed on 13 October: Wrangler's login token can't read Notifications.
  - [ ] before 1 December 2026, when Workers Logs and AI Gateway logs move to Cloudflare Observability pricing (per GB ingested and stored, in one account-wide allowance), look at a month's ingestion. With gateway logging off or minimal, the wide events are almost all of it.
- [x] **Owner. OAuth apps** ([setup §4 and §5](setup.md#4-a-github-oauth-app)).
  - [x] GitHub: configured for the live deployment; the live redirect to GitHub checks out (spec, Status).
  - [x] Google: registered on 12 October; its two secrets are set in the dashboard, `SIGNIN_PROVIDERS` lists both providers again, and the live `/auth/google` redirects to Google with the right client and callback. The consent screen links `<origin>/privacy`.
- [x] **Owner. Secrets**, set in the owner's own terminal with `wrangler secret put`, so no value passes through anyone else ([setup §2](setup.md#2-secrets)). `SESSION_SECRET`, `POPPY_SIGNING_JWKS` and `TOKEN_ENC_KEY` are set on the live deployment; `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set (the redirect to GitHub reads both); Google's two were added in the dashboard on 12 October; `WEB_PUSH_VAPID_JWK`, for notifications, is set on the live deployment. Anyone deploying their own copy sets it with `node scripts/poppy-secrets.mjs vapid-key | npx wrangler secret put WEB_PUSH_VAPID_JWK`; without it, notifications are simply off.
- [ ] **Owner. The final domain for `client_id`: `poppydemoagent.dev`**, the only host people are sent to. Switched on 15 October: the agent's `client_id` is now `https://poppydemoagent.dev/poppy/client.json` (it was `https://personal-agent.adewale-883.workers.dev/poppy/client.json`, which print-with-poppy allowlisted on 12 October), so it is a new Personal Agent to every Company (spec, "Our agent's identity").
  - [ ] Before the switch, sign out of each Company on the Companies page, so the revocations go out under the old `client_id`. Not done before the switch: the refresh tokens issued to the old `client_id` stay live at their Companies until they expire, since the agent now signs as the new one.
  - [x] `poppydemoagent.dev` attached to the `personal-agent` Worker in the dashboard (15 October; a `routes` entry in the committed `wrangler.jsonc` would name the deployer's host, which `test/template.test.ts` refuses). The Worker's name stays.
  - [x] `PUBLIC_ORIGIN` and `POPPY_LOGO_URI` set to the new domain in `deployment.local.json`, and deployed (15 October).
  - [x] The `workers.dev` host sends people on: every page and API path answers 308 with the same path and query on `PUBLIC_ORIGIN` (`canonicalRedirect` in `src/index.ts`; the page's own paths run the Worker first so they can be redirected). `/poppy/*` is never redirected: the identity documents are served only on `PUBLIC_ORIGIN`, so the old `client_id` now answers 404, and a Company's callback to the old host fails, as an unfinished sign-in would anyway.
  - [x] The OAuth apps: Google's client lists `https://poppydemoagent.dev/auth/google/callback`, and the GitHub OAuth App's one callback URL is `https://poppydemoagent.dev/auth/github/callback` (`callbackUrl` in `src/oauth.ts` builds it from the request's origin). Sign-in on the new domain works (the owner, 15 October). Still to check on Google's consent screen: the app domain, privacy link and authorized domains name the new domain.
  - [x] Tell print-with-poppy the switch has happened. Done by 24 October: its production store and Cloudflare sandbox list `https://poppydemoagent.dev/poppy/client.json` (`wrangler.jsonc`), its Agent Sandbox registers that and the interop identity `https://poppydemoagent.dev/poppy/interop/client.json`, and its sandbox guide names both (`docs/SANDBOX.md` at `3360d8b`).
  - [ ] Tell Todd (Alpine) the switch has happened. Alpine accepts the interop identity on the new domain (the live lane, 24 October); the deployed agent's `https://poppydemoagent.dev/poppy/client.json` hasn't signed in there since the move.
  - [ ] Everyone signs in again (the session cookie belonged to the old host), signs in again at each Company (its tokens were issued to the old `client_id`), turns notifications on again (a push subscription belongs to the origin's service worker), and on an iPhone adds the app to the Home Screen again.
  - [x] The live lane against Alpine again, with the interop identity on the new domain: D, S0, N and C pass for `pda` and the lenient and strict fakes (24 October; [live-0.2-testing.md](history/live-0.2-testing.md#live-tests--24-october-2026-the-identity-on-poppydemoagentdev)). Print with Poppy's sandbox opens a signed-out Session for it too.
  - [ ] Tell Todd (Alpine) that the live lane's conversation scenario is now `CL` in place of `C`: the same message, now labelled as a test, and a "Thanks", then the conversation is closed ([live-0.2-testing.md](history/live-0.2-testing.md)).
  - [ ] Once nothing links to the `workers.dev` host any more, turn it off for the Worker in the dashboard; `canonicalRedirect` can then go.

- [x] **Owner. `npm run deploy`.** Recorded deployment on 6 November: commit `0539f98423e00911944347ba659cb0dbba65941f`, Worker version `1696070b-d8f2-4c80-adb8-33d643878d43`, 100% of traffic. [Public verification receipt](evidence/deployment-2026-11-06/receipt.json) from `npm run check:live` records the served commit, a clean build, the protocol pin, public pages and identity documents, Google/GitHub start redirects and the anonymous boundary. This does not verify signed-in journeys, model calls, device notifications, Browser Run or independent MCP interoperability. Later source changes require their own deployment and evidence. The [4 November receipt](evidence/deployment-2026-11-04/receipt.json) records the deployment before it, `f7fac68`.

- [ ] **Owner. Back up `TOKEN_ENC_KEY`** in a password manager or equivalent private store; losing it loses sealed refresh tokens and model keys.

## Repeatable release preflight

Commit the intended source, run the offline checks and build, then deploy that exact state. After promotion, run:

```sh
npm run check:live -- --origin https://your-deployment.example --expected-commit <source-sha> --output /tmp/pda-public-preflight.json
```

`/api/build-info` exposes the source revision, dirty-tree flag, Worker version and protocol pin. The checker rejects a mismatched or dirty build, checks public pages and identity documents, checks the anonymous data boundary, and inspects OAuth start redirects without following them. It sends no model request or Company action. Its receipt explicitly says public HTTP only.

For authenticated and service acceptance, use the dedicated identity and bounded sandbox journey below. Run [the isolated hosted pair](../test/hosted/README.md) for real OAuth/model integration, then verify the production-only gateway, Browser Run and real-device paths separately. An unavailable identity, compatible independent MCP server or device remains an explicit limit, not a passed check. Key changes follow [key rotation and recovery](key-rotation.md).

## 2. Live checks

The checklist below distinguishes observed live behavior from local tests. An unchecked item is not established by serving its static assets or by passing against a fake.

### 1 November 2026: public deployment preflight

Observed from source checkout `c3f6d1e` at approximately 07:32 UTC. The served deployment did not expose a commit through these checks, so this is not proof that the checkout is deployed. Requests were anonymous, redirects were inspected without completing OAuth, and no Company action, model call or payment was made.

| Surface | Observed result | Limit |
| --- | --- | --- |
| `https://poppydemoagent.dev/` and `/privacy` | Both HTTP 200 with a Content-Security-Policy header | Browser rendering and authenticated page behavior remain unchecked |
| `/api/me` | HTTP 401 without a session | Establishes only the anonymous authentication boundary |
| `/api/sign-in-options`, `/auth/github` | GitHub and Google offered; GitHub start returns 303 to github.com with state and the expected callback | No GitHub login or callback was completed |
| `/poppy/client.json`, `/poppy/jwks.json` | HTTP 200, expected client/key URLs, Operations 2, two public keys and no private `d` member | Does not exercise signing or a Company account |
| `/sw.js`, `/manifest.webmanifest` | HTTP 200 with the expected JavaScript/manifest content types | Does not establish notification permission, push delivery or background execution |
| Print with Poppy production and sandbox discovery | Initial bounded GETs to both `/.well-known/poppy.json` documents returned 200 and declared 0.3 | Version declaration alone does not establish the exact draft, authentication, or simulated payment/fulfillment |
| Full sandbox document validation | Indeterminate: the CLI's address-pinned transport could not fetch through this environment; later public metadata requests returned 403. The deployed validator API also returned 403 (`error code: 1010`) | No full document-validation pass or Company journey is claimed; do not weaken address checks or access controls to obtain one |

**Blocked protected checks:** `wrangler whoami` reports unauthenticated; the environment has no configured Cloudflare identity, private deployment/test settings, or connected browser. No model key or authenticated test account is available. Gateway spend/retention settings, compaction, reminders/tasks, device push and Browser Run therefore remain open below. Configure access through the environment/browser connection, not by pasting credentials into a report or chat.

**Next bounded run:** use a dedicated test identity on the intended deployment and verify the deployed commit first. Confirm a compatible sandbox explicitly simulates payment and fulfillment before any write. Run one approve/decline/reload/refresh/sign-out journey; one compaction-followed-by-answer; one reminder/task with tabs closed; one notification on each available device; and one Browser Run read whose test page attempts a POST that its server must not receive. Verify the gateway metadata/429 backstop through the account's authenticated settings and a controlled test budget, without draining a production allowance. Record pass/fail, deployed commit and actual limitation here. The stock [isolated hosted pair](../test/hosted/README.md) covers real OAuth/model and dummy operations, but disables the demo gateway and Browser Run; it cannot certify those services or real-device push by itself.

### Remaining live checks

Each requires the configured deployment/account or a real device; local failures become code work.

- [x] Own keys: pi-ai's Anthropic and OpenAI SDKs streaming in workerd with a real key of each (12 October: the owner's OpenAI key, and an Anthropic key created inside a workspace; an organisation-wide Anthropic key needs a workspace ID, which Settings now takes).
- [x] The key checks: a pasted key is checked with the vendor's free list-models call (`GET /v1/models`) before it is sealed, and a refused key shows the vendor's reason (12 October).
- [x] The demo: Claude Sonnet 5.5 through the AI binding on Unified Billing, through `dpa-gateway` (12 October, after credits were loaded). Every demo call carries the `anthropic-beta` header the compaction fix adds, so the gateway passes it through.
- [ ] The demo after a compaction (preserved thinking): in a conversation that has thinking turns, go past 184k tokens of context (or send a request the model calls too long) so a summary is placed, then send one more turn. It should answer, not fail with a 400 about thinking blocks or signatures. The header half is shown by the plain demo call above; the summary-then-turn half is still untried. The demo request now asks Anthropic to drop stale thinking blocks (`block_binding`, beta `thinking-binding-controls-2026-08-01`), which works only if AI Gateway passes the `anthropic-beta` header and the body through unchanged; a 400 naming an unknown field or beta means it doesn't ([decisions §23](decisions.md#23-compaction-a-budget-our-summarizer-the-page)). The own-key Anthropic lane sends the same request straight to Anthropic, so check it once with a real key too.
- [ ] The gateway metadata (`u`, `d`) reaches the spend rules; the 429 they return; how far a burst overshoots.
- [ ] Settings in a real browser: the key panel (paste, remove), the demo meter, and the needs-key banner.
- [ ] Memory: "Remember I'm vegetarian" is listed in Settings → Memory as "You said", and the agent still knows it after the next `npm run deploy` (and, for the spec's own test, a week later). Delete it in Settings, and "Forget everything" with two or three notes saved; they leave Settings and `recall` finds none (the conversation itself still holds what was said).
- [ ] Photo attachments: attach a photo; the agent describes it, and it is still shown after a reload. Paste one and drop one too. Check a photo ticked in the composer for a selected Company uploads there without a redundant consent click, while an unticked or earlier photo requires disclosure consent. The 12 October upload card is historical behavior, not the current acceptance criterion.
- [ ] Reminders and scheduled tasks: one of each. "Remind me in 5 minutes to stretch", then close every tab: the "Reminder: …" card is in Needs you at its time (within a few seconds). "In 10 minutes, tell me the time in Tokyo": it runs on time, says "Your scheduled task ran", and Activity's log has the run. For a person on the demo, the run counts against their daily allowance in Settings → Model; with the allowance used up (or `DEMO_DAILY_USD_PER_USER` set to 0 on a test deploy) the run fails at once with a notice, and three such runs pause the task. Settings → Scheduled lists and cancels both.
- [ ] Web Push (`WEB_PUSH_VAPID_JWK` is set): turn notifications on in Chrome or Firefox on a desktop (FCM, Mozilla), Chrome on Android (FCM), and on an iPhone from the app added to the Home Screen (Apple); Safari on a Mac and Edge on Windows (WNS) if to hand. A reminder arrives on each with the page closed, and opens the app when clicked. Check each push service answers 201 (the agent keeps the last status per device), and that `/sw.js` and `/manifest.webmanifest` are served with the page's CSP allowing them.
- [ ] The Content-Security-Policy doesn't break the deployed page: the theme script, the WebSocket, images, the validator's pages.
- [ ] The 3 November protocol refresh, after deploying it:
  - The deployed validator reports a signed-out Company with no OAuth issuer, whose `/.well-known/oauth-protected-resource` is a 404, as valid with the `prm-no-issuer` note, as in the reported case.
  - The agent calls that Company's MCP API signed out.
  - A Company still on the 29 October text (`pap_dlg`) refuses PDA's Session JWTs until it updates. Record which live Companies have moved.
- [ ] Operator signatures (`POPPY_OPERATOR_KEY` is set):
  - `/.well-known/http-message-signatures-directory` serves one Ed25519 key with its possession proof.
  - One Company edge that verifies Web Bot Auth accepts a signed request. Record the product and draft revision it implements.
- [ ] Sign-in end to end: GitHub works (the owner signs in with it); Google works end to end (the owner signed in on 12 October); still to try: a `sierra.ai` Workspace account, and someone not on a list being refused.
- [ ] If a "Deploy to Cloudflare" button is added: how it handles the deployer's vars.
- [ ] Browser Run for `read_url` ([setup §6](setup.md#6-browser-run-on-by-default)): the deploy accepts the `browser` binding (the account is on Workers Paid; Browser Run appears under **Compute → Browser Run**); a page that needs JavaScript (a single-page app) is rendered and its tool line says "rendered in Browser Run"; an ordinary article isn't; a page of the owner's own, on a public host, whose script posts a form or sends a `fetch` POST on load is still read, the model's result counts the refused requests, and the page's server receives no POST; the Runs tab shows the browser closing within seconds of each render, never left open. Tested only against a fake browser so far, so this also checks that `@cloudflare/puppeteer` 1.4.0's request interception, `Page.setDownloadBehavior` and `Network.setBlockedURLs` behave in Browser Run as they do in Chrome.
- [ ] Logs ([setup §8](setup.md#8-logs-and-diagnostics)): after the deploy (which adds the `CF_VERSION_METADATA` binding and turns invocation logs off), send a chat message and open **Observability** for the Worker. `kind = "turn"` shows one event with your `agent_id`, the lane and the model call's cost; `request_id = "<its cf-ray>"` shows the `/ws` request and the turn; `version_id` and `commit` match the deploy. No event or line carries a `/auth/…/callback?code=` URL. Then press **Copy diagnostics** in Activity and check the text starts with the same agent id.
- [ ] Company selection: list a Company in the composer, send, reload, and open the app on a second device. The list is still shown, and a follow-up reaches that Company without retyping it. Clear the list and send again: the agent is refused and asks you to add the domain.
- [ ] Your data, on a dedicated test identity, never an agent you want to keep. **Download my data** gives a file with no refresh token, push address or sign-in link. **Delete my agent** at a Company that revokes signs out every device. At a Company that won't revoke (a test Company, or an account signed in before the 15 October `client_id` switch if one is left), Settings lists it with its reason and the chat stays connected. **Keep my agent** leaves the agent and its data working, signed out of the Companies it could reach. **Delete anyway** erases the agent. Record what that Company then shows, and which refusal it gave: a Company that answers 200 for another client's token looks revoked to us.
- [ ] The privacy page: `/privacy` loads signed out, names the deployment and its origin, links `PRIVACY_CONTACT`, and is the page Google's consent screen links to. Its text matches what the code does today (photos, memory, reminders and tasks, push subscriptions, Browser Run, the operator's logs); bump `PRIVACY_UPDATED` in `src/privacy.ts` whenever it changes.

## 3. Then

- [ ] **Owner. Verify the corrected 0.3 flow on the intended deployment.** The 29 October diagnostics establish authenticated API and conversation use at Cliffside Retail and Print with Poppy on `4c92a2d`, and exposed approval/checkout defects. After deployment, first verify the chosen sandbox supports the pinned protocol and explicitly simulates payment and fulfillment. Then verify discovery, sign-in, one conversation, approve and decline, reload, refresh and sign-out with synthetic accounts and a sandbox operation. Do not use a real checkout to satisfy this check. Record the deployed commit and outcome here. Existing local evidence is in [current verification](poppy-0.3-conformance.md#current-verification).
- [ ] **Owner. Verify a Company website through the fetch-based browser.** No live result is recorded. Use an authorized test environment.
- [ ] **Owner. Submit plugin proposals when ready**, after the live Company Agent verification above. [Parked drafts](proposals/README.md) link to dated research; refresh host API details once before submitting. No recurring recount or research refresh is required.
- [ ] **Owner. Run a live interop lane only against a peer compatible with the current pin**, and only the registry's allowed read-only scenarios. Historical 0.1/0.2 live peers are not a current run instruction.

[Earlier deployment and live-check history](https://github.com/adewale/pda/blob/289c6592c6f6e629b1d525247f3c4e2243662bc2/docs/deployment-tasks.md#3-then) is frozen at its original revision.
