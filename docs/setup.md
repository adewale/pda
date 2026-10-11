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


## Staging

`wrangler.jsonc` has a `staging` environment: a separate Worker, `personal-agent-staging`, so its Durable Objects, secrets, rate-limit namespace and OAuth apps are its own and nothing it does touches production's agents. Its vars mirror production's, except two placeholders:

- `PUBLIC_ORIGIN` and `POPPY_LOGO_URI` name `https://personal-agent-staging.adewale-883.workers.dev`, the URL workers.dev should give it. Confirm it after the first deploy; the smoke test fails if `client.json` doesn't name the origin it's served on.
- `ALLOWLIST` is empty, so nobody can sign in until you add yourself.

**What you do yourself, once.** Nothing here has been created or deployed for you.

1. **OAuth apps for staging.** A GitHub OAuth app (GitHub allows one callback per app) with callback `https://personal-agent-staging.adewale-883.workers.dev/auth/github/callback`, and a Google client (a new one, or this redirect URI added to production's) with `https://personal-agent-staging.adewale-883.workers.dev/auth/google/callback`. Set up as in sections 2 and 3.
2. **The first deploy:** `npm run deploy:staging`. It builds with `CLOUDFLARE_ENV=staging` and deploys `personal-agent-staging`, creating its Durable Object namespaces.
3. **Secrets, in your own terminal**, new values rather than production's. `--name` names the Worker explicitly, so a secret can't land on production whatever was built last:

   ```sh
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET --name personal-agent-staging
   node scripts/poppy-secrets.mjs signing-keys | npx wrangler secret put POPPY_SIGNING_JWKS --name personal-agent-staging
   node scripts/poppy-secrets.mjs token-key | npx wrangler secret put TOKEN_ENC_KEY --name personal-agent-staging
   npx wrangler secret put GITHUB_CLIENT_ID --name personal-agent-staging
   npx wrangler secret put GITHUB_CLIENT_SECRET --name personal-agent-staging
   npx wrangler secret put GOOGLE_CLIENT_ID --name personal-agent-staging
   npx wrangler secret put GOOGLE_CLIENT_SECRET --name personal-agent-staging
   ```

4. **Your account on the allowlist:** edit `env.staging.vars.ALLOWLIST`, then `npm run deploy:staging` again.
5. **The smoke test:** `npm run smoke -- https://personal-agent-staging.adewale-883.workers.dev`.

## Smoke test

`npm run smoke -- <base-url>` checks a deployed Worker with credential-free GETs only, so it never signs in or changes anything: the page loads; `/auth/google` and `/auth/github` redirect to the provider with `state`, a PKCE S256 challenge and a `__Host-` flow cookie; a callback without a flow is refused; `/api/me`, `/ws` and `/poppy/callback` refuse without a session or with a forged one; `/ws` refuses another origin; the Poppy client metadata names this origin and the JWKS has public keys only; the validator page loads. Missing security headers (HSTS, CSP and others the Worker doesn't set yet) are printed as notes. Exit status is 0 when every check passes, 1 when one fails, 2 when it couldn't run.

- `--providers github` limits the sign-in checks to configured providers. Production has no Google client yet, so `npm run smoke -- https://personal-agent.adewale-883.workers.dev --providers github` is the check that passes there today.
- `test/smoke.test.ts` runs the same checks against the Worker in the test runtime, and against broken answers to prove each check fails.

## Rollback and gradual deployments

Every `wrangler deploy` makes a new version of the Worker: its code, vars and bindings. Run these with `--name personal-agent` (or `--name personal-agent-staging`), so they act on the Worker you mean whatever is in `dist/`.

**Roll back** when a deploy breaks something:

```sh
npx wrangler deployments list --name personal-agent               # what's live, newest first
npx wrangler versions list --name personal-agent                  # recent versions and their ids
npx wrangler rollback <version-id> --name personal-agent --message "why"   # 100% to that version, at once
npm run smoke -- https://personal-agent.adewale-883.workers.dev --providers github
```

- **Durable Object storage isn't rolled back.** Each agent's SQLite stays as the newer version left it, so a version that changed a table's shape needs the older code to read it, or a fix forward.
- **A rollback can't cross a Durable Object migration** (a new `migrations` entry). Ship migrations in a deploy of their own, so there's always a version after them to roll back to.
- **Vars are part of the version**, so rolling back also restores the old `ALLOWLIST`. If you removed someone since, check the allowlist after rolling back. If you rotated a secret since, check that it still works.
- The dashboard does the same: **Workers & Pages → personal-agent → Deployments → ⋯ → Rollback**.

**Gradual deployments** send part of the traffic to a new version first:

```sh
npm run build                                         # production build (no CLOUDFLARE_ENV)
npx wrangler versions upload --message "what changed"  # a new version, not yet serving
npx wrangler versions deploy <new-id>@10% <current-id>@90% --name personal-agent
npm run smoke -- https://personal-agent.adewale-883.workers.dev --providers github
npx wrangler versions deploy <new-id>@100% --name personal-agent   # or roll back
```

- **Each Durable Object runs one version** for the whole split, so one person's agent is on the old or the new code, never both. The Worker's own routes (sign-in, the validator) split per request.
- **A version with a Durable Object migration can't be uploaded**; deploy it with `npm run deploy`.
- Rehearse on staging first: `npm run deploy:staging`, then the smoke test against staging.
