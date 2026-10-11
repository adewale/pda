# Setting up a deployment

`SESSION_SECRET`, `POPPY_SIGNING_JWKS` and `TOKEN_ENC_KEY` are already set on the deployed Worker (the last two with `scripts/poppy-secrets.mjs`). Three things remain.

Back to the [README](../README.md).

## 1. Pay for Claude on AI Gateway

The Worker calls Claude through the `default` AI Gateway (created automatically on first use). A test call on 9 Oct 2026 reached the gateway and failed with `x-api-key header is required`, because the gateway has no way to pay. In the dashboard under **AI → AI Gateway → default**, either buy **Unified Billing** credits or store an Anthropic API key (**BYOK**) under the `default` alias.

## 2. A GitHub OAuth app

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

- Homepage URL: `https://personal-agent.adewale-883.workers.dev`
- Authorization callback URL: `https://personal-agent.adewale-883.workers.dev/auth/github/callback`

Then generate a client secret and run:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

## 3. A Google OAuth client

In the Google Cloud console's **Google Auth Platform** (https://console.cloud.google.com/auth/overview), in a project of its own:

1. **Get started**: app name, support email, audience **External**, contact email.
2. Leave the logo empty (a logo triggers brand verification). The app asks only for `openid` and `email`, which need no Google verification.
3. **Audience**: while the app is in *Testing*, only listed test users can sign in; **Publish app** to let anyone in.
4. **Clients → Create client**, type *Web application*, authorized redirect URI `https://personal-agent.adewale-883.workers.dev/auth/google/callback`. Copy the client secret when it is shown.

Then run:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Secrets take effect immediately; no redeploy is needed.

