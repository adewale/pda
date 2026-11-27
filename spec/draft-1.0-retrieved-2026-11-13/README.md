# Personal Agent Protocol, Draft 1.0: snapshot of 2026-11-13

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-11-13, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-11-13T15:48:00Z | (none shown) | `d67a00f41c473be5acdb6e1bc93ec120576627b9db85ef408a440371e911021f` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-11-13T15:48:00Z | (none shown) | `750860b2336d2c6004ac66eb1368f05ad7da76204ea70295054099bcfb1f8d14` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-11-13T15:48:00Z | (none shown) | `22a1bcb97e9e085ba1161706ef8ae2d57520f84abe37ce74b67ab48e980ff9fb` | [pages/path-to-1.md](pages/path-to-1.md) |
| [roadmap](https://personalagentprotocol.org/docs/roadmap) | 200 | 2026-11-13T15:48:00Z | (none shown) | `02520dce90c98f4f9c42c69a3aa946e7269fbbdb2d09991b59ef7695fcc240a1` | [pages/roadmap.md](pages/roadmap.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-11-13T15:48:00Z | (none shown) | `de399c478d7727c4515a930643b5273bd5c24ff567ff908cfb53c360ce043277` | [pages/changelog.md](pages/changelog.md) |
| [1.0-spec](https://personalagentprotocol.org/docs/1.0/spec) | 200 | 2026-11-13T15:48:00Z | (none shown) | `ce6ebbafdfde6dfc85749303d95a398ca755a839fd54ee2dea1509bd4320f194` | [pages/1.0-spec.md](pages/1.0-spec.md) |
| [1.0-extensions](https://personalagentprotocol.org/docs/1.0/extensions) | 200 | 2026-11-13T15:48:01Z | (none shown) | `76f681bb8b021039e0dbb586ff197356b35f8dd264c38d1ad9c1b887fd54c072` | [pages/1.0-extensions.md](pages/1.0-extensions.md) |
| [1.0-browser-control](https://personalagentprotocol.org/docs/1.0/extensions/browser-control) | 200 | 2026-11-13T15:48:01Z | (none shown) | `1a0069096e315c50f9a4fd51d856d9a5ef1f4b4ebf169fa636db46121bbe8d39` | [pages/1.0-browser-control.md](pages/1.0-browser-control.md) |
| [1.0-disclosures](https://personalagentprotocol.org/docs/1.0/extensions/disclosures) | 200 | 2026-11-13T15:48:01Z | (none shown) | `b8227fc1f77465612bf5da1d7da5f2582a10e81a6ad2fa8834b4d78e8a005f46` | [pages/1.0-disclosures.md](pages/1.0-disclosures.md) |
| [1.0-links](https://personalagentprotocol.org/docs/1.0/extensions/links) | 200 | 2026-11-13T15:48:01Z | (none shown) | `7a593ea9615a16b4caccd1199b28e08d59cb675ae0aafff26b9975a9eb269934` | [pages/1.0-links.md](pages/1.0-links.md) |
| [1.0-mediated-sign-in](https://personalagentprotocol.org/docs/1.0/extensions/mediated-sign-in) | 200 | 2026-11-13T15:48:02Z | (none shown) | `5c95db9af86833a6bfe2e486447044166a3be3e7f4e30b08d3bcf63eab35bb01` | [pages/1.0-mediated-sign-in.md](pages/1.0-mediated-sign-in.md) |
| [1.0-operations](https://personalagentprotocol.org/docs/1.0/extensions/operations) | 200 | 2026-11-13T15:48:02Z | (none shown) | `075a9d8fbeef391575219e8e2c46e4c3aecb7608bdca06cf305b2922ce2c5129` | [pages/1.0-operations.md](pages/1.0-operations.md) |
| [1.0-ucp](https://personalagentprotocol.org/docs/1.0/extensions/ucp) | 200 | 2026-11-13T15:48:02Z | (none shown) | `805ed458862abfcd4437925fb99313e0d8d30ca6de7ffa614d8a65e0420ca4b4` | [pages/1.0-ucp.md](pages/1.0-ucp.md) |
| [1.0-guides](https://personalagentprotocol.org/docs/1.0/guides) | 200 | 2026-11-13T15:48:02Z | (none shown) | `4752ab73fcd7b8660d7c4528295c39019975f97039461a4ef77f2d322eb3dd83` | [pages/1.0-guides.md](pages/1.0-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-11-13T15:48:03Z | (none shown) | `8372fe3a134bee6dc4a3a2bc98353fa149783bc7db5c3a2bcabe850bdb2d6924` | [pages/videos.md](pages/videos.md) |
| [demos](https://personalagentprotocol.org/docs/demos) | 200 | 2026-11-13T15:48:03Z | (none shown) | `8250f8a78eeef52120c1a0c47d6381954748d89e38f2973c73578891befb50c7` | [pages/demos.md](pages/demos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-11-13T15:48:03Z | (none shown) | `a1c85f1dc0c5a2b945ed787476c06134858037c69775e7de47f3a0d45f9c8e14` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-11-13T15:48:03Z | (none shown) | `5f79c541a554b2924221426d10aeb8e403905dcc71d242018000a41664bd6328` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `a430b443172152d5eadb95e0e0ead274f05bda1205ce43a2b231e7f7dc334030`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/2oj_mq5ijkt3l.js?dpl=dpl_Bw33UwM3Y4zDvPH9JN3rAnn4RBAx (HTTP 200, 45492 bytes, SHA-256 `009aed037ec3d18ac83c3974091086745e3dcabc9b6d7117b05d040cf48a47d4`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
