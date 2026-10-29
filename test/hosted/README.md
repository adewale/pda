# Isolated hosted PDA and dummy Company

This pair is prepared for a separate Cloudflare deployment. Nothing here deploys automatically. The PDA runs `src/index.ts`, including its real GitHub OAuth and signed-cookie verifier. It starts with no seeded User, no synthetic model, no paid demo lane and no Browser Run binding. After signing in, the allowlisted User adds their own model key in Settings.

The Company uses the existing strict protocol handlers and dummy jacket/order data. It offers OpenAPI, MCP, Operations 2 and password-checked Direct Sign-In on one HTTPS origin; no custom DNS is needed with two `workers.dev` addresses. It offers no administration, fault-injection, reset or direct-approval HTTP API. A separate control secret permits only bounded evidence counters.

The strict mock keeps Company state in memory. Its instance ID changes after eviction/restart, and its accounts, issued tokens and counters reset. This is an interactive smoke test, not a durable Company. `hosted-check finish` fails if the instance changed. Do not treat a run across an instance change as evidence; begin a fresh Company sign-in and baseline.

## Missing inputs

- A Cloudflare account ID, a Workers subdomain, and an authenticated Wrangler session or account-scoped API token with Workers deployment, Durable Objects and asset upload permissions. This workspace currently has no authenticated Cloudflare identity.
- A separate GitHub OAuth App, its client ID/secret, and the test User's GitHub login and numeric ID. Set its callback to `<PDA_ORIGIN>/auth/github/callback`. The production OAuth application is not reused.
- Two unused isolated Worker names: `pda-hosted-<label>` and `pda-dummy-<label>`, and their HTTPS origins. A privacy contact is required by the real PDA.
- A User-supplied Anthropic or OpenAI model key, entered in the hosted PDA after real sign-in. No key is seeded or copied from production.

## Prepare and review

From the repository root, using Node 24 and the checked-in dependencies:

```sh
umask 077
cp test/hosted/settings.example.json test/hosted/settings.local.json
chmod 600 test/hosted/settings.local.json
# Edit the private settings file with the inputs above. Never paste it into logs.
node scripts/hosted-prepare.mjs --settings test/hosted/settings.local.json
```

The default command builds separate frontend assets and dry-runs both Worker uploads. It never deploys. Generated config and secrets go under the gitignored `test/hosted/local/<label>/`, with directory mode 0700 and file mode 0600. A new pair gets independent signing keys, session/encryption keys, Company password and Company control secret. They are never printed. An existing label cannot be rebound to another account, origin or User. Validation errors omit private input values.

`--prepare-only` writes the private files without building. Empty settings, mismatched origins/names and missing OAuth inputs fail before preparation. The checked-in unconfigured Company returns 503 until both origins and both Company secrets exist; the PDA's production checks refuse missing deployment/auth settings.

## Deploy only after review

These commands are for the operator after credentials are supplied. Set `PDA_TEST_DIR` to the generated directory; never select the production Wrangler config.

```sh
PDA_TEST_DIR=test/hosted/local/<label>
npx wrangler whoami
npx wrangler deploy --config "$PDA_TEST_DIR/company.wrangler.json"
npx wrangler secret bulk "$PDA_TEST_DIR/company.secrets.json" --config "$PDA_TEST_DIR/company.wrangler.json"
npx wrangler deploy --config "$PDA_TEST_DIR/pda.wrangler.json"
npx wrangler secret bulk "$PDA_TEST_DIR/pda.secrets.json" --config "$PDA_TEST_DIR/pda.wrangler.json"
```

The initial deployments have no uploaded secrets and cannot authorize access. Uploading secrets creates the configured versions. Do not run `npm run deploy`, which targets the ordinary project deployment. Never upload the local settings or secrets to GitHub. Read the generated Company password locally when the consent form asks for it; use only that dummy password.

## Live browser check

Open the separate PDA origin in Chromium. Sign in through GitHub and confirm an unlisted identity cannot enter. Add your own model key in Settings. Then record a baseline immediately before the Company journey:

```sh
node --use-env-proxy scripts/hosted-check.mjs start "$PDA_TEST_DIR"
```

Ask to exchange the Stormline Jacket (order `ord_7Hk2`, item `itm_4Qa`) for `stormline-insulated-m` at the separate Company domain, using OpenAPI. Follow the Company's Direct Sign-In link, enter its generated dummy password, and approve that account access. Click the PDA's local approval, inspect the Company's exact terms, and click its separate terms approval. The original transcript and Activity should settle Done, including after reload. Capture the actual URL, terms and resulting original transcript in screenshots.

```sh
node --use-env-proxy scripts/hosted-check.mjs finish "$PDA_TEST_DIR" 1
```

The read-only receipt requires the same Company instance, zero strict protocol violations/warnings, and exactly one action since the baseline. It does not prove the browser steps occurred; screenshots and browser observation provide that evidence. Repeat with MCP in a fresh pair or a different dummy action to avoid reusing an already-exchanged item. Company, API and payment results are dummy data; real GitHub and model-provider services are external. No real payment integration is present.

## Teardown

Remove the User's test model key in the PDA's Settings before deleting the isolated deployments.

```sh
npx wrangler delete --config "$PDA_TEST_DIR/pda.wrangler.json"
npx wrangler delete --config "$PDA_TEST_DIR/company.wrangler.json"
```

Delete the separate GitHub OAuth App and remove the local generated directory and settings after retaining only nonsecret evidence. Confirm both isolated Workers and their associated Durable Object storage were removed in Cloudflare. Production Worker names, namespaces, credentials and data are never part of these commands.

## Local verification

```sh
node test/hosted/company-security.node.mjs
npm run typecheck
```

The local check bundles the Company with Wrangler and runs it in workerd. It checks missing-secret refusal, discovery on one origin, password/CSRF/origin checks, simultaneous consent replay, code/PKCE/client assertion/DPoP exchange, an actual delegated Session API approval and dummy effect, MCP initialization, authenticated bounded counters, and the live verifier's changed-instance rejection. These are local security checks; they do not establish a hosted GitHub login or live model result. Both upload dry-runs were also exercised with disposable synthetic deployment settings, then those generated files were removed. Real hosting remains pending the inputs above.
