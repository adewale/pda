# Personal Agent Protocol, Draft 0.2: snapshot of 2026-10-18

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-10-18, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-10-18T19:51:22Z | (none shown) | `38dc2a7ab674e0db150fae15cd8997ed691e101f944be3c1204ec0606c98f55d` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-10-18T19:51:22Z | (none shown) | `cd5f41af3778e0766f59b5274a3e1383b397ed3798c611568825336d7c2dc709` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-10-18T19:51:22Z | (none shown) | `8c1eba4ac317e788a182404008f80fb0b19ae925ba979e52e90c5b4b6481e574` | [pages/path-to-1.md](pages/path-to-1.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-10-18T19:51:22Z | (none shown) | `f3941ae9f6ce1cb18173ed95768399da4706b19aa3e3a3c41732fd5ce9ff90d3` | [pages/changelog.md](pages/changelog.md) |
| [spec](https://personalagentprotocol.org/docs/0.2/spec) | 200 | 2026-10-18T19:51:22Z | (none shown) | `ffeee670621dbc5ecf0ff885d24df750fcda48a3aeb4b26bb155bbb15e7e4ce9` | [pages/spec.md](pages/spec.md) |
| [extensions](https://personalagentprotocol.org/docs/0.2/extensions) | 200 | 2026-10-18T19:51:22Z | (none shown) | `9e495281e772cb4db58ed13150e27f8ab81dfc6087f72b8d8aec3eb5404c0e2d` | [pages/extensions.md](pages/extensions.md) |
| [operations](https://personalagentprotocol.org/docs/0.2/extensions/operations) | 200 | 2026-10-18T19:51:23Z | (none shown) | `6352e784d300f8d75d939a7a4b714cbd107aaf15d73921a51078e50b0339ebb2` | [pages/operations.md](pages/operations.md) |
| [guides](https://personalagentprotocol.org/docs/0.2/guides) | 200 | 2026-10-18T19:51:23Z | (none shown) | `41a1328f12c437b6bde24ba3f3058e6a71541dc86f87651d2fc12eb8c31dcea9` | [pages/guides.md](pages/guides.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-10-18T19:51:23Z | (none shown) | `b91950320b0ec8263c42923c0fcc0d44ccf8bbb6b8acf29de0de8ea9508c55d3` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-10-18T19:51:23Z | (none shown) | `de7b7f906aa580d9f7506caa24165cc344dc84e0cb688459503124552a7a9538` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `b3188bfdf7474ed0ed8c59428626ee4f4f7eb4c0ff92b787a572664c08ceb82d`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/0qkudk97oqgt0.js?dpl=dpl_PAomwB1rP3SD6upeJ4jpydeqoNvP (HTTP 200, 40311 bytes, SHA-256 `b41b15a8777b0c7ac4dccbf4d0240f853222180ff7eff68251befa2361d760d4`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
