# Personal Agent Protocol, Draft 0.4: snapshot of 2026-11-09

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-11-09, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-11-09T18:51:38Z | (none shown) | `a3c3ab1f0fa9fe7d35701dd3177752e30463849b71122b912f955c1936c4ac99` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-11-09T18:51:38Z | (none shown) | `4823858d1f719a6674e51d006982deb3e814369ecc1f3249d25856243dda009d` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-11-09T18:51:38Z | (none shown) | `732b29f7aab49db4b229f57554856c3500a7f39930da00caa6dc5f7769c08206` | [pages/path-to-1.md](pages/path-to-1.md) |
| [roadmap](https://personalagentprotocol.org/docs/roadmap) | 200 | 2026-11-09T18:51:38Z | (none shown) | `9f1ae0844ba19ba3a937e40b47d9373412cfe9cef7ea73477cc7938260775e1b` | [pages/roadmap.md](pages/roadmap.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-11-09T18:51:38Z | (none shown) | `19ec510da62b6057dc5b7e086fdb7f7a81df73f35eab12661bbe40693f1034cf` | [pages/changelog.md](pages/changelog.md) |
| [0.4-spec](https://personalagentprotocol.org/docs/0.4/spec) | 200 | 2026-11-09T18:51:38Z | (none shown) | `427233b7c9edccfbf6d15ebcb3f13edee447592e8b0eda43b165663b4edb487d` | [pages/0.4-spec.md](pages/0.4-spec.md) |
| [0.4-extensions](https://personalagentprotocol.org/docs/0.4/extensions) | 200 | 2026-11-09T18:51:38Z | (none shown) | `d3bbe88e8ecf929afefc981ce1fdb8a21dc19600c20c50d740b79be81792c197` | [pages/0.4-extensions.md](pages/0.4-extensions.md) |
| [0.4-disclosures](https://personalagentprotocol.org/docs/0.4/extensions/disclosures) | 200 | 2026-11-09T18:51:38Z | (none shown) | `8d11d504cda500cc8c959e37f8217c65cd2686a9d62264b6a40931a5b7cd54e4` | [pages/0.4-disclosures.md](pages/0.4-disclosures.md) |
| [0.4-links](https://personalagentprotocol.org/docs/0.4/extensions/links) | 200 | 2026-11-09T18:51:38Z | (none shown) | `1fe850f8bd0ce9b7e326504254353c535c2a7dd0d1372c4f3a0797674de4c499` | [pages/0.4-links.md](pages/0.4-links.md) |
| [0.4-mediated-sign-in](https://personalagentprotocol.org/docs/0.4/extensions/mediated-sign-in) | 200 | 2026-11-09T18:51:38Z | (none shown) | `17c1a995ae2999ae0b5cc293b36f722409623b7790bc6dd4091a49b3b0bf0e9f` | [pages/0.4-mediated-sign-in.md](pages/0.4-mediated-sign-in.md) |
| [0.4-operations](https://personalagentprotocol.org/docs/0.4/extensions/operations) | 200 | 2026-11-09T18:51:39Z | (none shown) | `73c34ae4c347efdcf6cf9d2341a70cd641945b3528364999b60550cc2c32cd8e` | [pages/0.4-operations.md](pages/0.4-operations.md) |
| [0.4-ucp](https://personalagentprotocol.org/docs/0.4/extensions/ucp) | 200 | 2026-11-09T18:51:39Z | (none shown) | `3fe6f08a8bc109f937700b4e664cc16f7f7b4302210e73647dc4638730b4f87a` | [pages/0.4-ucp.md](pages/0.4-ucp.md) |
| [0.4-guides](https://personalagentprotocol.org/docs/0.4/guides) | 200 | 2026-11-09T18:51:39Z | (none shown) | `3a980686099f62bc2d0715f7bd8abfa52a84432436dbc5157f115175a95f4c68` | [pages/0.4-guides.md](pages/0.4-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-11-09T18:51:39Z | (none shown) | `3513c73b677c4c936b3f4265c6b31862f32384da07d9d84039822124db34d89e` | [pages/videos.md](pages/videos.md) |
| [demos](https://personalagentprotocol.org/docs/demos) | 200 | 2026-11-09T18:51:39Z | (none shown) | `82f52d20af41c00682015abcfdf2d0ab1b50aa92356053d759f445fd0995cfe0` | [pages/demos.md](pages/demos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-11-09T18:51:39Z | (none shown) | `c51006a56d1a02c50ec978075ab9b2f0849f771aa5e54a5d6f96795392501d42` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-11-09T18:51:39Z | (none shown) | `f8ac1a1b9f14c1cdc28f133813c9389fc1b0ef3191b6056166337bf7193f3e7d` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `a1a4efdbde62bdd9a1476fd99ee4aa33034794afaefed0665e27b1d3bba601dc`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/0blbmlfgog2ij.js?dpl=dpl_AyGhgzqJ8Q5FnifHcAFFSqegPBwg (HTTP 200, 44986 bytes, SHA-256 `3340f754fc14d32219688b4a57da59e95fce04ccc14282fe104c7e3ebd7371a1`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
