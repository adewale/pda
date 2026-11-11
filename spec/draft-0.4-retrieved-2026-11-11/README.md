# Personal Agent Protocol, Version 0.4: snapshot of 2026-11-11

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-11-11, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-11-11T07:04:14Z | (none shown) | `e6831b1e771746bcb53f4646ed99f9cd30c962af937e1dd8983d86a5a7414acf` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-11-11T07:04:14Z | (none shown) | `8bc0225a5dd569bf8ed4ea5d100684900c2c130b402488185579a37f231c5f58` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-11-11T07:04:14Z | (none shown) | `b6d979a46ab8b804952fc348ef5048d1d1d1fd591ad77ecc3dafc6753e03a2b2` | [pages/path-to-1.md](pages/path-to-1.md) |
| [roadmap](https://personalagentprotocol.org/docs/roadmap) | 200 | 2026-11-11T07:04:14Z | (none shown) | `1046d4aff2d59c9da172bfeb96e3ed4c872f03b92743c3b58865ebdc8c225ac6` | [pages/roadmap.md](pages/roadmap.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-11-11T07:04:14Z | (none shown) | `5938399f31dda622eea4ad629cfa28b874020b61e7c2167cba7a2da4f803a458` | [pages/changelog.md](pages/changelog.md) |
| [0.4-spec](https://personalagentprotocol.org/docs/0.4/spec) | 200 | 2026-11-11T07:04:14Z | (none shown) | `5e097668b4ea6674ef9b2dc19cb99d370a55a86ccbb2e2d841d92d08062f3394` | [pages/0.4-spec.md](pages/0.4-spec.md) |
| [0.4-extensions](https://personalagentprotocol.org/docs/0.4/extensions) | 200 | 2026-11-11T07:04:14Z | (none shown) | `8276a8130419d17126648031a98ddc0501e6687315907d0a6d816b01635bba26` | [pages/0.4-extensions.md](pages/0.4-extensions.md) |
| [0.4-browser-control](https://personalagentprotocol.org/docs/0.4/extensions/browser-control) | 200 | 2026-11-11T07:04:14Z | (none shown) | `fe657ed14b8b1664f0af0d8a8d77830e378a3e8e164cf92931df2d55439fb43f` | [pages/0.4-browser-control.md](pages/0.4-browser-control.md) |
| [0.4-disclosures](https://personalagentprotocol.org/docs/0.4/extensions/disclosures) | 200 | 2026-11-11T07:04:15Z | (none shown) | `30f44c81463df318b19d3736f7e73a130c210b0dbee92dea0222bb7a8eb072a8` | [pages/0.4-disclosures.md](pages/0.4-disclosures.md) |
| [0.4-links](https://personalagentprotocol.org/docs/0.4/extensions/links) | 200 | 2026-11-11T07:04:15Z | (none shown) | `57f1b182a263da47d75d83f508b780b192330deb355704b3c208c69285fd415b` | [pages/0.4-links.md](pages/0.4-links.md) |
| [0.4-mediated-sign-in](https://personalagentprotocol.org/docs/0.4/extensions/mediated-sign-in) | 200 | 2026-11-11T07:04:15Z | (none shown) | `03b8176d8555a6dc4e48bfaf6987a956286147ea32a688bf819992d057606f74` | [pages/0.4-mediated-sign-in.md](pages/0.4-mediated-sign-in.md) |
| [0.4-operations](https://personalagentprotocol.org/docs/0.4/extensions/operations) | 200 | 2026-11-11T07:04:15Z | (none shown) | `e27ff4d1b1be3802dab2ac1a4f8cab046945ead2986e5f63380111658aa6edc1` | [pages/0.4-operations.md](pages/0.4-operations.md) |
| [0.4-ucp](https://personalagentprotocol.org/docs/0.4/extensions/ucp) | 200 | 2026-11-11T07:04:15Z | (none shown) | `ffbda9e558d9d6d904ae946d7ff07dbddf19fa903533f6c956048d1ed8836307` | [pages/0.4-ucp.md](pages/0.4-ucp.md) |
| [0.4-guides](https://personalagentprotocol.org/docs/0.4/guides) | 200 | 2026-11-11T07:04:15Z | (none shown) | `b015466279a170af042b627a7ba65b0e55f1267663ae8412fe45b78113dc96df` | [pages/0.4-guides.md](pages/0.4-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-11-11T07:04:15Z | (none shown) | `04a04d2b2a94798b54a14424c2e85c2bee1267948607784b5bea00fb30d78d31` | [pages/videos.md](pages/videos.md) |
| [demos](https://personalagentprotocol.org/docs/demos) | 200 | 2026-11-11T07:04:15Z | (none shown) | `70c54ee8509a759f97059f1c79319392d2b0c53c9d7eb1a1476c70ffcfead128` | [pages/demos.md](pages/demos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-11-11T07:04:15Z | (none shown) | `6ffe6f5140227a5657457800549e6137dc5d9728b619ae0f44320fa3bbbf9eda` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-11-11T07:04:15Z | (none shown) | `e65c8d296b07a73d6d86244c4a1660d8a96f290eb43f709a82bcdd92d347466c` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `ff3111313799cda21dda6610bd148ff2e7c9560b6a84b3159f0a60de011db25e`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/1276uvgha-d_5.js?dpl=dpl_4tTVSzjpXjDtydRqvFVb27mBuZz9 (HTTP 200, 45309 bytes, SHA-256 `217f27d388e67f5461d0e57cc30a80b3bce8d1d32b8f05f724a86427d4e318b3`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
