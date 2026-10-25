# Personal Agent Protocol, Draft 0.3: snapshot of 2026-10-25, 06:13 UTC

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-10-25 at 06:13 UTC, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-10-25T06:13:18Z | (none shown) | `2d07c1a3ae327f0e7ec0619f4d29e8e45564be585c16075c28abcd0197b16963` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-10-25T06:13:18Z | (none shown) | `bdedffae57c7224d5b8409123c5beb8520060f95ad4af035e050e14752bfaf80` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-10-25T06:13:19Z | (none shown) | `b316c30824b94d2a67802144de92eadb1138617399d7acc09fc9385ddee3cf1e` | [pages/path-to-1.md](pages/path-to-1.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-10-25T06:13:19Z | (none shown) | `13c3223288d2fdfac295f076c396b8b40e45873ea4852bfab512ba6b76212828` | [pages/changelog.md](pages/changelog.md) |
| [0.3-spec](https://personalagentprotocol.org/docs/0.3/spec) | 200 | 2026-10-25T06:13:19Z | (none shown) | `96c01f38a69fe5097d3eeaa187b151fe2fa1a08292093a0dbfebde6ef782451e` | [pages/0.3-spec.md](pages/0.3-spec.md) |
| [0.3-extensions](https://personalagentprotocol.org/docs/0.3/extensions) | 200 | 2026-10-25T06:13:19Z | (none shown) | `d28c2660c56c3c1b1165262066226f0a1745ccc991a0a49b25619d667725229b` | [pages/0.3-extensions.md](pages/0.3-extensions.md) |
| [0.3-operations](https://personalagentprotocol.org/docs/0.3/extensions/operations) | 200 | 2026-10-25T06:13:19Z | (none shown) | `c443a347f1896770e98ebe72caec9ca15bcedf55fcc28b30a115f7041cb2ad9d` | [pages/0.3-operations.md](pages/0.3-operations.md) |
| [0.3-guides](https://personalagentprotocol.org/docs/0.3/guides) | 200 | 2026-10-25T06:13:19Z | (none shown) | `b4951c083d90275ffceea7ec52223b5db6e5ff2ab275080cc86017a592a816e9` | [pages/0.3-guides.md](pages/0.3-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-10-25T06:13:19Z | (none shown) | `452395ea9b879336e03571eb1d9d0ef08d5bb21dc3f4b0a60b72e2241a3690d6` | [pages/videos.md](pages/videos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-10-25T06:13:19Z | (none shown) | `411bf854784661a674cdd82415fae22e223f732fb1f7752481b0ce7425d6b4a0` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-10-25T06:13:20Z | (none shown) | `d85a64738e29113a556d1347756159bffa1b86268e595385d639ca35ff37aca6` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `c69ae01ffc9379a9e9fbc3c134fa84d977881628dae35c6b4d53c6cb7a5f7b27`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/40alyzmk_xj7d.js?dpl=dpl_5m63ikmp3hdhwCdw1MtQQvw5ND45 (HTTP 200, 40742 bytes, SHA-256 `53294b2f7ac648f9f90ba9835892212bbfc4c2fc4895c7c1e476d86d97740018`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
