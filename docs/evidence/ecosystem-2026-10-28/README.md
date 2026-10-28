# Ecosystem evidence — 28 October 2026

The [refresh report](../../ecosystem-refresh-2026-10-28.md) interprets these observations. Source and discovery receipts name their individual observation times and revisions; the local grid receipts name the exact implementation commits. None establishes a live sign-in or purchase.

## Browser evidence

`before.png` renders `docs/ecosystem.md` from base commit `c3eabd00e398f2934a462d44c38640c2cfd8cfff`. `after.png`, `mobile.png` and `mobile-landscape.png` render this refresh's Markdown. Both use the unchanged production About/ecosystem renderer and the same isolated app-smoke fixture, including its signed-cookie verifier and synthetic identity/provider. The capture flag fixes the desktop viewport to 1280 × 900; phone and landscape viewports are 375 × 812 and 812 × 375.

Inspect the observation date, source revision and discovery counts. The [visual receipt](visual-receipt.json) binds the Markdown inputs and PNGs by SHA-256. [Browser checks](browser-checks.json) cover public navigation, fragment targets, table scrolling, viewport overflow, authentication and chat recovery. There were no uncaught browser errors. Screenshots do not verify live OAuth or a real model.

To reproduce, use Node 24 and Chromium (or set `PDA_ACCEPTANCE_CHROMIUM`), then run at each data revision:

```sh
npm ci --legacy-peer-deps
node scripts/app-smoke.mjs --ecosystem-viewport --output /tmp/ecosystem-browser.json
```

For the baseline, use the base Markdown with this branch's capture flag; that flag changes screenshot dimensions only. No application renderer or layout code changed in this PR.

## Other receipts

- `survey.json` and `survey.md`: 23 repository heads, release/directory/search observations and 33 public discovery checks. Reviewed follow-up pin changes are separate from the pins read at survey start.
- `grid-smoke-receipt.json`: rebuilt Datalayer 0.26.0/PDA/mock three-by-three smoke grid; 18 passes.
- `grid-receipt.json`: same images across thirty honest scenarios; 211 passes, 7 previously public unexempted failures, 52 unsupported. The runner exits 1. Raw traces remain local. The SDKs name full reviewed commits; own-code manifests retain `c3eabd0-dirty`. Their executable build inputs match the base commit, as explained in the refresh report.
- `spec-drift.txt`: actual upstream comparison, including the removed browser-assertion schema. Drift is expected and exits 1; it does not change the adopted specification.
