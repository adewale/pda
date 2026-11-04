# Personal Agent Protocol, Draft 0.3: snapshot of 2026-11-03

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-11-03, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-11-03T20:16:22Z | (none shown) | `f0669dfe10dec00f5d24fbfc25e210d9a4e69dac8ac4e8c930294185374602b7` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-11-03T20:16:22Z | (none shown) | `b9d0bf1be3906dc656409bea1df382cd0163eb2849cf4d2e847e6d48f5dfa71d` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-11-03T20:16:22Z | (none shown) | `14b6896718d8b980fafb9da513ff1d072e18a1fef675b932cd48fc0f3383f17e` | [pages/path-to-1.md](pages/path-to-1.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-11-03T20:16:22Z | (none shown) | `56b9b32bd08df078f06206bc460f102a37bc0fa8ad7c79dafe825d651a02e694` | [pages/changelog.md](pages/changelog.md) |
| [0.3-spec](https://personalagentprotocol.org/docs/0.3/spec) | 200 | 2026-11-03T20:16:22Z | (none shown) | `d0308a6fac516055ae39cb129f80c587c3d54927478d25de98c0c2e8e6198f43` | [pages/0.3-spec.md](pages/0.3-spec.md) |
| [0.3-extensions](https://personalagentprotocol.org/docs/0.3/extensions) | 200 | 2026-11-03T20:16:22Z | (none shown) | `a27e55e8e81a14bbfdf592ffd447aeb0a2a1bcde5bc008f1bb145674333d8e71` | [pages/0.3-extensions.md](pages/0.3-extensions.md) |
| [0.3-disclosures](https://personalagentprotocol.org/docs/0.3/extensions/disclosures) | 200 | 2026-11-03T20:16:23Z | (none shown) | `8806d6b500b00f5a19bdf74d4c4754f815ee830911d0d004c64f95229b7647d7` | [pages/0.3-disclosures.md](pages/0.3-disclosures.md) |
| [0.3-links](https://personalagentprotocol.org/docs/0.3/extensions/links) | 200 | 2026-11-03T20:16:23Z | (none shown) | `9961408722ba214d67b1849731a0b051bd5e1236501a486ea468cd2098fdbf42` | [pages/0.3-links.md](pages/0.3-links.md) |
| [0.3-mediated-sign-in](https://personalagentprotocol.org/docs/0.3/extensions/mediated-sign-in) | 200 | 2026-11-03T20:16:23Z | (none shown) | `cca432e387bd294b8e29b36592ece2cd23a648c91d5b0f699f6e9a6944a188af` | [pages/0.3-mediated-sign-in.md](pages/0.3-mediated-sign-in.md) |
| [0.3-operations](https://personalagentprotocol.org/docs/0.3/extensions/operations) | 200 | 2026-11-03T20:16:23Z | (none shown) | `1c6fbb4cc3d44953e74dd1e57f3f40993737ca522b2eddb2faf19de3fc93911d` | [pages/0.3-operations.md](pages/0.3-operations.md) |
| [0.3-ucp](https://personalagentprotocol.org/docs/0.3/extensions/ucp) | 200 | 2026-11-03T20:16:23Z | (none shown) | `ced8ac9506d1581b62de5a4a7df2ffcbcbcef9d6550ebc9573eb250bc41d7e55` | [pages/0.3-ucp.md](pages/0.3-ucp.md) |
| [0.3-guides](https://personalagentprotocol.org/docs/0.3/guides) | 200 | 2026-11-03T20:16:23Z | (none shown) | `7e8e646b243a650215f6a94fda638e74cda55b6b94c57c9c290b8b06c4f3b9ce` | [pages/0.3-guides.md](pages/0.3-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-11-03T20:16:23Z | (none shown) | `ea9d32930fbaf5f004594561345086cef29c17e7952f9beb3ab1cb7492be592c` | [pages/videos.md](pages/videos.md) |
| [demos](https://personalagentprotocol.org/docs/demos) | 200 | 2026-11-03T20:16:23Z | (none shown) | `b14c12950de55eb2d4e448bdcf28ea1762e5173f2a35f86009438a92800ed517` | [pages/demos.md](pages/demos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-11-03T20:16:23Z | (none shown) | `08731f952e77afa057fcd112f28ce988c1cc3f85f67545aaa43971bfdb1d3fd4` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-11-03T20:16:23Z | (none shown) | `8258f35dbadc06349d74a4320398586dbd1f17d1860f3f4a19cff995a45fb614` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `b9064ccaede041fdfff389e53c08b0de9a8c2000c2c63e3afaea7adebb983602`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/0n6w1vrdljvbs.js?dpl=dpl_BL7aQGeU8hhuh97J8WYsRMqqc1ev (HTTP 200, 41830 bytes, SHA-256 `7e3066454d14ea2c4c180d048c903d3a137fa04db26af79d1dc3efe5fa503797`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
