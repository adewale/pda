# Durable Personal Agent

Sign in with Google or GitHub, then chat with your own Claude Opus 5.5 agent in one conversation that survives reloads, crashes and deploys. Built to v0 of [`durable-personal-agent-spec.md`](durable-personal-agent-spec.md).

Deployed at https://personal-agent.adewale-883.workers.dev. That URL serves the page, but chat needs the two setup steps below.

## Setup still needed

### 1. Pay for Claude on AI Gateway

The Worker calls Claude through the `default` AI Gateway (created automatically on first use). A test call on 9 Oct 2026 reached the gateway and failed with `x-api-key header is required`, because the gateway has no way to pay. Do one of these in the dashboard under **AI → AI Gateway → default**:

- **Unified Billing**: buy credits for the account, or
- **BYOK**: store an Anthropic API key on the gateway under the `default` alias.

### 2. Put Access in front of a custom hostname

Worker-level Access (the one-click toggle on workers.dev) rejects WebSocket upgrades with a 403, so it cannot protect `/ws`. Use a hostname-based Access application instead:

1. Add a Custom Domain to the Worker on a zone in this account (e.g. `agent.example.com`): **Workers & Pages → personal-agent → Settings → Domains & Routes**.
2. In Zero Trust, add **Google** and **GitHub** under **Settings → Authentication → Login methods**. Each needs an OAuth client from Google Cloud and GitHub.
3. Create a **self-hosted** Access application for that hostname, with both login methods and a policy that allows the people you want (the spec's v0 policy is any authenticated identity). Copy its **Application Audience (AUD) tag**.
4. Set the two secrets, then redeploy:

   ```sh
   npx wrangler secret put TEAM_DOMAIN   # https://<team>.cloudflareaccess.com
   npx wrangler secret put POLICY_AUD    # the AUD tag
   ```

The workers.dev URL can stay on: the Worker checks the Access JWT on every `/ws` and `/api/me` request, so a visitor who bypasses Access gets a 401.

## Develop

```sh
npm install --legacy-peer-deps
npm test           # 19 tests in the Workers runtime
npm run typecheck
npm run deploy
```

## Differences from the spec

- `AI_GATEWAY_ID` is `default` rather than `personal-agent`, because the `default` gateway is created on first use and a named one has to be created by hand.
- The `agents/vite` plugin is left out of `vite.config.ts`: it only transforms decorators, which this app does not use, and it needs `@babel/core`.
- There are 19 tests, not 17: two extra cover `/api/me`.
