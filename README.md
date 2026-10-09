# Durable Personal Agent

Sign in with Google or GitHub, then chat with your own Claude Opus 5.5 agent in one conversation that survives reloads, crashes and deploys. Built to v0 of [`durable-personal-agent-spec.md`](durable-personal-agent-spec.md).

Deployed at https://personal-agent.adewale-883.workers.dev. Sign-in is built into the Worker (the spec's Option B): Google and GitHub OAuth with PKCE, then an HMAC-signed `__Host-session` cookie (HttpOnly, Secure, SameSite=Lax, 30 days). Cloudflare Access is not used. Anyone with a Google or GitHub account can sign in; a Google and a GitHub sign-in are separate agents.

## Setup still needed

`SESSION_SECRET` is already set on the deployed Worker. Three things remain.

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

Google Cloud console → **APIs & Services**:

1. **OAuth consent screen**: External, app name, support email. Scopes: `openid` and `email` only, which need no Google verification. While the app is in *Testing*, only listed test users can sign in; **Publish** it to let anyone in.
2. **Credentials → Create credentials → OAuth client ID**, type *Web application*, authorized redirect URI `https://personal-agent.adewale-883.workers.dev/auth/google/callback`.

Then run:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Secrets take effect immediately; no redeploy is needed.

## Develop

```sh
npm install --legacy-peer-deps
npm test           # 30 tests in the Workers runtime
npm run typecheck
npm run deploy
```

## Differences from the spec

- Sign-in is Option B (in-Worker Google and GitHub OAuth) from the start, not Cloudflare Access. Access was dropped because Worker-level Access rejects WebSocket upgrades, and a hostname-based Access app needs a custom domain. Agent names are `sha256("<provider>:<id>")` (Google `sub`, GitHub numeric user id) instead of `sha256("access:<sub>")`.
- `AI_GATEWAY_ID` is `default` rather than `personal-agent`, because the `default` gateway is created on first use and a named one has to be created by hand.
- The `agents/vite` plugin is left out of `vite.config.ts`: it only transforms decorators, which this app does not use, and it needs `@babel/core`.
- There is no rate limit or daily cap yet (milestone 2), so any Google or GitHub user who signs in spends the account's Claude credits.
