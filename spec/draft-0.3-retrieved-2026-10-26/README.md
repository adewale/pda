# Personal Agent Protocol, Draft 0.3: snapshot of 2026-10-26

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-10-26, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-10-26T18:34:09Z | (none shown) | `96b0260c1c5b39d1a3292db97146f5ae6b86b403e262785eee3a56067a89661e` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-10-26T18:34:09Z | (none shown) | `bb44f363eb4312cf410b0f61d740c680ef10700b5578c10184215d9ee6fca5c7` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-10-26T18:34:10Z | (none shown) | `00008b5b13bc9e4a097c4e5353853672765cd711c88f44da4c4ead961826c9c3` | [pages/path-to-1.md](pages/path-to-1.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-10-26T18:34:10Z | (none shown) | `94011b8264fede309a27ec6fcd3b5cdf74bea6c2ebd9c7eb4c115721ca042102` | [pages/changelog.md](pages/changelog.md) |
| [0.3-spec](https://personalagentprotocol.org/docs/0.3/spec) | 200 | 2026-10-26T18:34:10Z | (none shown) | `727be1008fe9cf06f2c04de56833af93d5ecf9b97fa0cb81e3a3dd56c950c4de` | [pages/0.3-spec.md](pages/0.3-spec.md) |
| [0.3-extensions](https://personalagentprotocol.org/docs/0.3/extensions) | 200 | 2026-10-26T18:34:10Z | (none shown) | `de1f6a93863788373cacb5364cda15048a6e5a8e142ecf59414e93d4a8f9d085` | [pages/0.3-extensions.md](pages/0.3-extensions.md) |
| [0.3-operations](https://personalagentprotocol.org/docs/0.3/extensions/operations) | 200 | 2026-10-26T18:34:10Z | (none shown) | `c43ced3e937f570632b1159a1c0de4fdf4e4a5772f4ce687ffe2e419e6c32cdb` | [pages/0.3-operations.md](pages/0.3-operations.md) |
| [0.3-guides](https://personalagentprotocol.org/docs/0.3/guides) | 200 | 2026-10-26T18:34:10Z | (none shown) | `21a42ccc4ff568703c299e8c0c3ef1498330531088faba959e8129fff68a6356` | [pages/0.3-guides.md](pages/0.3-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-10-26T18:34:10Z | (none shown) | `1caab3644323f1995c8b5a47298b35f5efde82a6a38532aea55f05c919b1754a` | [pages/videos.md](pages/videos.md) |
| [demos](https://personalagentprotocol.org/docs/demos) | 200 | 2026-10-26T18:34:10Z | (none shown) | `626607180a91a76f6a3482d97d6d77b17eecf750f3c74afd57076c118a7a751d` | [pages/demos.md](pages/demos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-10-26T18:34:10Z | (none shown) | `bd4e16c9a0c1406774f9cc2b20ba4a472d733d18d45b3799f4022b7d48b298cc` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-10-26T18:34:10Z | (none shown) | `16891bcffc59c731569916b499e803d2e0cc6351f797f5c9df381f670607c747` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `b27ff388bd99d454eeee699a47000a197c62500546e88bc9d577911be2e845eb`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/09geve91-marl.js?dpl=dpl_fQ4LnC8GXVTtRd8SWVsq1QZAiiVR (HTTP 200, 41274 bytes, SHA-256 `750b6831bd4c77c8e32af4a5f39baa6f85033913af6b59bca3532ff03fd5a9bb`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
