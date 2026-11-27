# Personal Agent Protocol, Version 1.0: snapshot of 2026-11-19

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-11-19, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-11-19T12:35:31Z | (none shown) | `088f925075767a881c1527ae1f580f9b2e6b373677452d5b84d731419a154546` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-11-19T12:35:31Z | (none shown) | `959f49e0c35d160387ce2fa94242b5c951d1126c4dd18b0d842a210ba513c57e` | [pages/introduction.md](pages/introduction.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-11-19T12:35:32Z | (none shown) | `9759dfa2f094fb2a9487ccdc1070ea66c186da0d631e59327149cbd44ea2cfea` | [pages/changelog.md](pages/changelog.md) |
| [archive](https://personalagentprotocol.org/docs/changelog/archive) | 200 | 2026-11-19T12:35:32Z | (none shown) | `f48dfb20a8a27f1359bea0cf72d82e4b0e976b0ddcec9886ee62a59b21d326bd` | [pages/archive.md](pages/archive.md) |
| [1.0-spec](https://personalagentprotocol.org/docs/1.0/spec) | 200 | 2026-11-19T12:35:32Z | (none shown) | `3b56a466bdf7d3fb78fd55a94ead3de37e03639535bb382fe73d657ac3393ab5` | [pages/1.0-spec.md](pages/1.0-spec.md) |
| [1.0-extensions](https://personalagentprotocol.org/docs/1.0/extensions) | 200 | 2026-11-19T12:35:32Z | (none shown) | `56f85f00b521b7c8ec8c4f4025f3e6f056613338b0cdf947b5d7aac2f35dcec6` | [pages/1.0-extensions.md](pages/1.0-extensions.md) |
| [1.0-browser-control](https://personalagentprotocol.org/docs/1.0/extensions/browser-control) | 200 | 2026-11-19T12:35:33Z | (none shown) | `abff33db0f6428d6d22ff40720afe10f4c1509290d135d61eb0dc7abfa3e5a03` | [pages/1.0-browser-control.md](pages/1.0-browser-control.md) |
| [1.0-disclosures](https://personalagentprotocol.org/docs/1.0/extensions/disclosures) | 200 | 2026-11-19T12:35:33Z | (none shown) | `9d97c5b360f6fe45cbb5e7d4e1024c3c0df2619fc0510d1293f5f57618805b6e` | [pages/1.0-disclosures.md](pages/1.0-disclosures.md) |
| [1.0-links](https://personalagentprotocol.org/docs/1.0/extensions/links) | 200 | 2026-11-19T12:35:33Z | (none shown) | `2e6d8ec7f51a24b6dd8cc05affece0137f61acd6ec09b88fb59db951f272aa3c` | [pages/1.0-links.md](pages/1.0-links.md) |
| [1.0-mediated-sign-in](https://personalagentprotocol.org/docs/1.0/extensions/mediated-sign-in) | 200 | 2026-11-19T12:35:33Z | (none shown) | `ae83095306b25726dc77819809ad76c225839fdb163b0c954d7555ea05e19627` | [pages/1.0-mediated-sign-in.md](pages/1.0-mediated-sign-in.md) |
| [1.0-operations](https://personalagentprotocol.org/docs/1.0/extensions/operations) | 200 | 2026-11-19T12:35:33Z | (none shown) | `c255dc864c0c2756c9410478f83b5b5ace4ba01d3504caf30933148ac8889af7` | [pages/1.0-operations.md](pages/1.0-operations.md) |
| [1.0-ucp](https://personalagentprotocol.org/docs/1.0/extensions/ucp) | 200 | 2026-11-19T12:35:33Z | (none shown) | `32605d41010969582142523532d75a374a349ecb82dd6f32a26bce335abe3e98` | [pages/1.0-ucp.md](pages/1.0-ucp.md) |
| [1.0-guides](https://personalagentprotocol.org/docs/1.0/guides) | 200 | 2026-11-19T12:35:33Z | (none shown) | `8f1908981fa8c6d4e3f177a59387f2d346f33a8f4b3ca6bccd95392c5e240c76` | [pages/1.0-guides.md](pages/1.0-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-11-19T12:35:33Z | (none shown) | `fc66f2017eb8d1ae7a90e5e84b44c166b334012cc9f993a7c335c5ff4a1d0389` | [pages/videos.md](pages/videos.md) |
| [demos](https://personalagentprotocol.org/docs/demos) | 200 | 2026-11-19T12:35:33Z | (none shown) | `6314b40f4d268003ba96621b6d19a45a48a8e499df8ec7dfa7fd6628c120e53a` | [pages/demos.md](pages/demos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-11-19T12:35:33Z | (none shown) | `91d9c3c8a922839a5c3ba03d38e277f3406323efe65230a3d071e4f541d2d873` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-11-19T12:35:33Z | (none shown) | `e9b809e1baf3081b37fec6c15131317f0feb1b3221ffe6c7131376f5081dbe3f` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `87b746bc0cec53e0e68656a1ea875cfc1f1c9817efdd057f2cb33237fab25fd2`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/2oj_mq5ijkt3l.js?dpl=dpl_G8LH4ET5LXMFscajii2MypvDZFGb (HTTP 200, 45492 bytes, SHA-256 `009aed037ec3d18ac83c3974091086745e3dcabc9b6d7117b05d040cf48a47d4`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
