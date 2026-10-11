# Durable Personal Agent

Sign in with Google or GitHub, then chat with your own Claude Opus 5.5 agent in one conversation that survives reloads, crashes and deploys. The agent is also a Personal Agent for [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) Draft 0.1: it can find a company, sign you in on the company's own page, talk to the company's agent, use its APIs and website, and ask you before anything that changes your account. Design: [`durable-personal-agent-spec.md`](durable-personal-agent-spec.md).

Deployed at https://personal-agent.adewale-883.workers.dev. Sign-in is built into the Worker (the spec's Option B): Google and GitHub OAuth with PKCE, then an HMAC-signed `__Host-session` cookie (HttpOnly, Secure, SameSite=Lax, 30 days). Cloudflare Access is not used. Only people on the allowlist can sign in; a Google and a GitHub sign-in are separate agents.

## Who can sign in

The `ALLOWLIST` var in [`wrangler.jsonc`](wrangler.jsonc) decides; edit it and run `npm run deploy`. Someone removed is locked out on their next request.

```jsonc
"ALLOWLIST": {
  "emails": ["adewale@gmail.com"],          // Google accounts with this verified email
  "domains": ["sierra.ai"],                 // anyone in this Google Workspace
  "github": { "adewale": 43644, "ToddKerpelman": 4397978 }  // login: numeric id
}
```

GitHub accounts are matched by numeric id, since logins can change hands; get one with `gh api users/<login> --jq .id`. Emails and domains apply to Google sign-in; a domain matches Google Workspace accounts only, not a personal Google account that uses a work address.

## Setup still needed

`SESSION_SECRET`, `POPPY_SIGNING_JWKS` and `TOKEN_ENC_KEY` are already set on the deployed Worker (the last two with `scripts/poppy-secrets.mjs`). Three things remain.

### 1. Pay for Claude on AI Gateway

The Worker calls Claude through the `default` AI Gateway (created automatically on first use). A test call on 9 Oct 2026 reached the gateway and failed with `x-api-key header is required`, because the gateway has no way to pay. In the dashboard under **AI → AI Gateway → default**, either buy **Unified Billing** credits or store an Anthropic API key (**BYOK**) under the `default` alias.

### 2. A GitHub OAuth app

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

- Homepage URL: `https://personal-agent.adewale-883.workers.dev`
- Authorization callback URL: `https://personal-agent.adewale-883.workers.dev/auth/github/callback`

Then generate a client secret and run:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

### 3. A Google OAuth client

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

## Develop

```sh
npm install --legacy-peer-deps
npm test           # 107 tests in the Workers runtime, including Poppy conformance
npm run typecheck
npm run deploy
```

## Spec

[`durable-personal-agent-spec.md`](durable-personal-agent-spec.md) is the design, rewritten on 11 Oct 2026 against Personal Agent Protocol Draft 0.1. Its Status section says what is built; its Build plan says what is next. Decisions that differ from earlier drafts (app sign-in without Cloudflare Access, the `default` gateway, no `agents/vite` plugin) are recorded there.
