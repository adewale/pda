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
```

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
