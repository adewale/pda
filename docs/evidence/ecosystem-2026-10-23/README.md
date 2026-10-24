# 23 October ecosystem evidence

The [refresh report](../../ecosystem-refresh-2026-10-23.md) explains the source checks, directory observations, all 28 discovery verdicts and their limits.

- `discovery.json`: dated public-document results, profile/revision, diagnostics, public request URLs and parsed-document hashes. No Session or account data was collected.
- `sources.json`: 17 checked repository heads, three incremental comparisons, Everruns' unchanged Poppy tree hashes and dated public discussions.
- `public-source-receipt.json`: registry and directory response hashes; it also records the unsuccessful Sierra public-API request. Raw downloaded pages are not committed.
- `spec-site-comparison.txt`: comparison with the older 0.1 website snapshot. The separately imported 0.2 official source is still at the same revision; these are cumulative site differences, not changes since 22 October.
- `live-companies-before.png` and `live-companies-after.png`: the same summary row in the production app at 1280 × 900, comparing the 22 October data with the 23 October refresh. Inspect the change from source/deployment notes to dated document observations, while the older Session claims stay explicitly dated.
- `mobile-portrait.png` and `mobile-landscape.png`: the refreshed `/about/ecosystem` page at 375 × 812 and 812 × 375. Inspect the About breadcrumb, update date and page width.
- `browser-checks.json` and `visual-receipt.json`: actual browser outcomes, source/data provenance, viewport sizes and image hashes.

The renderer code is unchanged between captures. The new data was captured from the working tree before committing; its input blob matches the recorded head data commit. Both captures used the existing app-smoke setup with synthetic identity/model fixtures, local workerd and the production Vite renderer. The desktop evidence is a direct element screenshot of the row whose first cell is “Live Companies”; the mobile evidence is a viewport screenshot at the top of the page. Images were not edited.

To reproduce the app and mobile checks from the repository root with Node 24 and Chromium installed:

```sh
mkdir -p /tmp/pda-ecosystem-smoke
node scripts/app-smoke.mjs --output /tmp/pda-ecosystem-smoke/result.json
```

For this managed environment, Wrangler's logs/config were directed to writable temporary directories. That changes neither the renderer nor the assertions. External network requests are refused by the local app-smoke runtime. The document survey is a separate read-only network run, reproduced in the refresh report. Neither the screenshots nor that survey establish new live ordering, sign-in or Session interoperability, and no deployment was made.
