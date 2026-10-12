# Setting up a deployment

How to configure and deploy your own copy. The order to do it in, what each setting decides, and what to check afterwards are in [deployment-tasks.md](deployment-tasks.md); this file is the how-to its items link to.

Below, `<origin>` is your deployment's address, such as `https://personal-agent.<your-subdomain>.workers.dev`.

Back to the [README](../README.md).

## 1. Say who the deployment is for

The committed `wrangler.jsonc` names nobody: `OWNERS`, `SIGNIN_ALLOWLIST`, `DEMO_ALLOWLIST`, `PUBLIC_ORIGIN` and `POPPY_LOGO_URI` are empty, and every route but the validator answers with a config error until they are set. Keep your values in `deployment.local.json`, which git ignores:

```sh
cp deployment.example.json deployment.local.json   # then edit it
npm run deploy                                     # builds, checks the build is configured, deploys
```

```jsonc
{
  "OWNERS": { "emails": ["you@example.com"], "github": { "your-login": 1234567 } },
  "SIGNIN_ALLOWLIST": { "emails": ["friend@example.com"], "domains": ["your-company.example"], "github": { "their-login": 7654321 } },
  "DEMO_ALLOWLIST": { "emails": [], "domains": [], "github": {} },
  "PUBLIC_ORIGIN": "https://personal-agent.your-subdomain.workers.dev",
  "POPPY_LOGO_URI": "https://personal-agent.your-subdomain.workers.dev/logo.svg"
}
```

- **Emails** match Google accounts with that verified email; **domains** match Google Workspace accounts of that domain (not a personal account using a work address). Neither applies to GitHub.
- **GitHub accounts** are `login: numeric id`, and only the id is checked, because logins change hands. Find one with `gh api users/<login> --jq .id`.
- **Any other var** `wrangler.jsonc` declares can be overridden here too, such as `"DEMO_GATEWAY_ID": "default"` (section 3) or `"SIGNUP": "open"`. A name the template doesn't declare is refused.

`vite` lays the file over the template's vars; `scripts/check-deployment.ts` stops the deploy before anything is uploaded if the build still says nobody owns it. So deploying from a checkout without the file fails instead of replacing your production values.

`PUBLIC_ORIGIN` is your Poppy `client_id`'s home forever; see the spec's "Our agent's identity" before changing it.

## 2. Secrets

Run these in your own terminal, so the values are never shown or logged anywhere else:

```sh
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
node scripts/poppy-secrets.mjs signing-keys | npx wrangler secret put POPPY_SIGNING_JWKS
node scripts/poppy-secrets.mjs token-key    | npx wrangler secret put TOKEN_ENC_KEY
node scripts/poppy-secrets.mjs vapid-key    | npx wrangler secret put WEB_PUSH_VAPID_JWK
```

`WEB_PUSH_VAPID_JWK` is optional: it turns on notifications for reminders and scheduled tasks (Web Push). It is a P-256 private key as a JWK; the Worker derives the public key browsers subscribe with, and the VAPID contact is your `PRIVACY_CONTACT`. Without it, Settings doesn't offer notifications and everything else works. Replacing it ends every device's subscription, so each person turns notifications on again; there is nothing to rotate on a schedule.

`TOKEN_ENC_KEY` seals Account Tokens and people's model keys. To rotate it, put the old value in `TOKEN_ENC_KEY_PREVIOUS` and a new one in `TOKEN_ENC_KEY`; values are sealed again under the new key as they are used. Rotating without the previous key means everyone pastes their model key again and signs in to Companies again.

Secrets take effect immediately; no redeploy is needed.

## 3. The demo (optional): Claude on your bill, capped

The demo lane calls Claude through the AI Gateway named by `DEMO_GATEWAY_ID` (`demo` in `wrangler.jsonc`). Until a gateway named `demo` exists, set `"DEMO_GATEWAY_ID": "default"` in `deployment.local.json` to use the account's default gateway, and switch back once `demo` is set up. In the dashboard, **AI → AI Gateway**:

1. Create a gateway named `demo`, with **Authentication** on.
2. Choose **Unified Billing**, load credits, and leave **auto top-up** off. Store no provider keys (BYOK) on any gateway: own keys never go through a gateway ([decisions §14](decisions.md#14-own-keys-pasted-sent-straight-to-the-vendor)).
3. Add **spend limits** as a backstop to the agent's own caps: one split by `metadata.u` (per agent), one split by `metadata.d` (per Workspace domain, `personal` for everyone else), and a pooled daily limit.
4. Set the account's credit limit.
5. Don't create API tokens with **AI Gateway Run**: they can spend this gateway's credit too.

The agent's own caps are `DEMO_DAILY_USD_PER_USER` and `DEMO_DAILY_USD_PER_DOMAIN`. Without a demo, set both to `0`: everyone then needs their own key.

## 4. A GitHub OAuth app

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

- Homepage URL: `<origin>`
- Authorization callback URL: `<origin>/auth/github/callback`

Then generate a client secret and run:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

## 5. A Google OAuth client

In the Google Cloud console's **Google Auth Platform** (https://console.cloud.google.com/auth/overview), in a project of its own:

1. **Get started**: app name, support email, audience **External**, contact email. Under **Branding**, the application home page is `<origin>` and the privacy policy is `<origin>/privacy`, which the Worker renders from the template's text and your `PRIVACY_CONTACT` (an email address or an `https://` URL, in `deployment.local.json`). The policy promises to delete a person's data within 30 days of a request.
2. Leave the logo empty (a logo triggers brand verification). The app asks only for `openid` and `email`, which need no Google verification.
3. **Audience**: while the app is in *Testing*, only listed test users can sign in; **Publish app** to let anyone in.
4. **Clients → Create client**, type *Web application*, authorized redirect URI `<origin>/auth/google/callback`. Copy the client secret when it is shown.

Then run:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

A deployment can run with only one provider: list the ones it offers in `SIGNIN_PROVIDERS`, for example `"SIGNIN_PROVIDERS": ["github"]` in `deployment.local.json`. A provider left out has no button on the sign-in page, and its routes answer 404. A provider listed without its client's secrets answers a 500 naming the missing setting.

## 6. Browser Run (on by default)

`read_url` renders pages that need JavaScript in Cloudflare Browser Run, through the `BROWSER` binding in `wrangler.jsonc`. There is nothing to create or set: the binding needs no API token, and Workers Paid includes 10 browser hours a month and 10 concurrent browsers (averaged over the month); beyond that Cloudflare charges $0.09 a browser hour and $2 a concurrent browser. Each agent renders at most 10 pages an hour, each in at most 20 seconds. On Workers Free, Browser Run allows 10 browser minutes a day, so renders fail once they are used up and `read_url` falls back to the plain read.

To switch it off, set `"BROWSER_RUN": "off"` in `deployment.local.json` and redeploy. `read_url` then reads every page without JavaScript and tells the model when a page needed it. Usage shows in the dashboard under **Compute → Browser Run**. In `npm start` the binding is remote, so renders during development run in Browser Run and count against the same allowance.

## 7. Switches and costs

### Switches

Every way to turn something off, in one place. A var goes in `deployment.local.json` and takes effect at the next `npm run deploy`; a secret takes effect as soon as it is set or deleted.

| To stop | Set | What happens |
| --- | --- | --- |
| Rendering pages in Browser Run | `"BROWSER_RUN": "off"` | `read_url` reads every page without JavaScript and tells the model when a page needed it ([section 6](#6-browser-run-on-by-default)). |
| The demo: model calls you pay for | `"DEMO_DAILY_USD_PER_USER": 0` and `"DEMO_DAILY_USD_PER_DOMAIN": 0` | Either cap at 0 refuses every demo call before it is made, because nobody's spend is below 0. Everyone then needs their own key, and a scheduled task with no key fails its run; three failures in a row pause it. |
| One sign-in provider | `"SIGNIN_PROVIDERS": ["github"]` or `["google"]` | The sign-in page has no button for the other, and its `/auth/` routes answer 404. At least one must be listed. |
| New people | `"SIGNUP": "allowlist"` (the committed value) | Only `OWNERS` and `SIGNIN_ALLOWLIST` sign in. Taking someone off a list shuts them out at their next request after the redeploy. Their agent stops too: it makes no model call for them, on the demo or their own key, and each reminder or scheduled task pauses when it comes due ("this account can no longer sign in") with no notification. Company messages wait unread by the model. Nothing is deleted: put them back on the list, and their next sign-in starts the paused items again and hands the waiting messages to the model. Someone still allowed to sign in but taken off `DEMO_ALLOWLIST` keeps everything, on their own key or with "needs a key". |
| Notifications | `npx wrangler secret delete WEB_PUSH_VAPID_JWK` | Settings stops offering notifications and the agent sends none. Reminders still show in the chat. Subscriptions stay in each agent's storage, unused. Putting the same key back brings them back; a new key means each person turns notifications on again ([section 2](#2-secrets)). |

`OWNERS` can't be emptied: every route but the validator then answers with a config error. The validator has no switch; its URL checks are rate limited (below).

### What a deployment costs

These are Cloudflare's published prices on the day this was written; check the linked pages before relying on them. The live deployment runs on Workers Paid.

- **Workers Paid:** a minimum of $5 a month per account, which covers Workers, Durable Objects and the allowances below ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). On Workers Free, Durable Objects still work, with daily limits, and Browser Run gives 10 browser minutes a day.
- **Durable Objects:** each person's agent is one SQLite-backed Durable Object, and so are `DomainBudget` and `CompanyLimiter`. Workers Paid includes 5 GB-month of stored data, then $0.20 a GB-month; 50 million rows written a month, then $1.00 a million; 25 billion rows read, then $0.001 a million; 1 million requests (alarm invocations count), then $0.15 a million; and 400,000 GB-s of duration, then $12.50 a million GB-s ([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). The largest thing an agent stores is photos: at most 100 MiB, each deleted after 30 days. Every person who signs in gets an agent, so `SIGNUP=open` costs storage for each one, even when they bring their own key.
- **The demo lane:** model calls through AI Gateway are paid from credits you load, at the provider's own token prices, and Unified Billing adds a 5% fee to every credit purchase, so $100 of credit costs $105 ([Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), [AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)). The agent's caps bound a day's spend: at most `DEMO_DAILY_USD_PER_USER` a person, and at most `DEMO_DAILY_USD_PER_DOMAIN` for each Google Workspace domain, with everyone on a personal Google account or GitHub sharing one more budget of that size (`personal`). A cap is checked before each call, so the call that crosses it is paid in full. Own-key calls go straight to Anthropic or OpenAI and cost you nothing.
- **Browser Run:** Workers Paid includes 10 browser hours a month and 10 concurrent browsers (averaged over the month); beyond that, $0.09 a browser hour and $2.00 for each concurrent browser over 10 ([Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/)). Each agent renders at most 10 pages an hour, each in at most 20 seconds, so one agent can use about 3.3 browser minutes an hour at most. There is no limit across the deployment: `BROWSER_RUN=off` is the brake.
- **Scheduled tasks:** each run is a model call like a chat message, paid on the person's own key or under the demo's daily caps, never beyond them. An agent keeps at most 20 reminders and tasks waiting, none more often than daily. A reminder makes no model call.
- **Web Push:** free. The browsers' own push services (Google, Mozilla, Apple, Microsoft) carry each notification; the agent's request to them is an outbound request from the Durable Object.
- **The validator:** open to anyone. A check of a pasted document runs in the Worker; a URL check also fetches from the network, so each client address gets 20 URL checks a minute (the `VALIDATOR_LIMITER` rate-limit binding in `wrangler.jsonc`). Each check is an ordinary Worker request.
- **Workers Logs:** every request, agent turn, job and page action writes one event (one log event each), unsampled. Until 1 December 2026, Workers Paid includes 20 million log events a month, then $0.60 a million, kept 7 days ([Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)); from 1 December 2026, logs and traces share Cloudflare Observability's allowance, 50 GB of ingestion and 10 GB-month of storage a billing cycle on Paid, then $0.25 a GB and $0.10 a GB-month ([Observability pricing](https://developers.cloudflare.com/observability/pricing/)). An event is a few kilobytes, so a personal deployment stays far inside either. Workers Traces is off (section 8).

## 8. Logs and diagnostics

The agent writes one structured event per unit of work to Workers Logs: `http` for each request, `turn` for each agent turn, `job` for each background job, `ws` for each page action that does something. The [spec's Observability section](../durable-personal-agent-spec.md#observability) lists every field; [decisions §30](decisions.md#30-logging-one-wide-event-per-unit-of-work-and-diagnostics-the-user-can-copy) says why. They record when and how each agent worked (which Companies, which tools, model usage and cost, what failed and with which code), never what anyone said, and no token, key, code, email or URL query. Workers Logs keeps them 7 days on Workers Paid.

**Querying.** In the dashboard, **Workers & Pages → Observability**, pick this Worker and write a query in the search bar, or build it in the Query Builder beside it:

- Every turn of one agent today (set the time range to today): `kind = "turn" AND agent_id = "<agent id>"`. The agent id is on the second line of the person's diagnostics, and on every event of theirs.
- Tool calls refused at Print with Poppy: `kind = "turn" AND regex(tool_outcomes, ":refused@https://[^ ]*printwithpoppy\.com")`.
- Everything one request did, across the Worker and the agent: `request_id = "<cf-ray>"`.
- What failed: `level = "error"`, grouped by `kind` and `error.code`.
- Demo spend today by budget: `kind = "turn" AND lane = "demo"`, the sum of `model_calls.cost_usd` grouped by `budget_pool`.
- What a deploy changed: group by `commit`, or filter on `version_id`.

**Settings** (`wrangler.jsonc`, committed): logs on and unsampled (`head_sampling_rate: 1`); invocation logs off, because each records the request's full URL and the sign-in callbacks carry a one-time code in theirs; traces off, because spans record URLs and query strings. Per-request CPU and wall time are still in the dashboard's metrics.

**A read-only token for an assistant (optional).** To let a coding assistant or a script query the logs (the [Workers Observability API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/), or the Cloudflare API MCP server), create an API token under **My Profile → API Tokens** with only **Account → Workers Observability → Read** for this account; on an account that uses Workers roles, the **Metadata Read-Only** role scoped to this Worker instead. It can read events and nothing else: no secret, no Durable Object, no deploy. Give it an expiry, and revoke it when the work is done.

**Diagnostics from a person.** When someone reports a problem, ask them to press **Copy diagnostics** on their Activity page and paste the text to you. It holds their agent's newest 200 events and its Poppy protocol log, the same redacted fields as the logs, so you can debug without opening the logs or seeing their conversation.
