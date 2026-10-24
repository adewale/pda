# Ecosystem page under About

The screenshots show `/about/ecosystem` in the production Vite build, served by local workerd to Chromium. Inspect the About / Ecosystem breadcrumb and the page width at 375 × 812 (portrait) and 812 × 375 (landscape). They show the top of the page; the browser checks also cover table overflow and historical section links farther down.

Regenerate from the repository root with Node 24 and Chromium installed:

```sh
mkdir -p /tmp/pda-ecosystem-smoke
node scripts/app-smoke.mjs --output /tmp/pda-ecosystem-smoke/result.json
```

The runner builds the app unless `--skip-build` is supplied. These captures used `npm run build` followed by the runner with `--skip-build`. `browser-checks.json` records that run's assertions: public links and fragment targets, direct loading and trailing slash, no identity or WebSocket requests on the public pages, no old-route redirect, and the signed-in app smoke checks. External network requests are refused by the local runtime; sign-in cookies and the model are synthetic fixtures. These checks do not establish a deployed release or live OAuth/model behavior.

The old `/ecosystem` path intentionally uses the app's unknown-path fallback. It neither renders the ecosystem map nor redirects to its replacement. Earlier evidence directories retain their original paths because they record previous revisions.
