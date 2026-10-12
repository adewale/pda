# Personal Agent Protocol, Draft 0.1: snapshot of 2026-10-12

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-10-12, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-10-12T00:04:57Z | (none shown) | `6d39a9b99b11f8f54449bbce6d93fd91ede558a3a13fb7f3e46250243633671c` | [pages/home.md](pages/home.md) |
| [overview](https://personalagentprotocol.org/docs/overview) | 200 | 2026-10-12T00:04:58Z | Oct 9, 2026 | `5d12dd01bd4c25912c02489d92ba7f9499a8f61a6029b3f148d9a5e9ff839a09` | [pages/overview.md](pages/overview.md) |
| [spec](https://personalagentprotocol.org/docs/spec) | 200 | 2026-10-12T00:04:58Z | Oct 9, 2026 | `67a7bd817efd438a12d682aab38cc29a155c97299cef930300d79b32d69f1d9a` | [pages/spec.md](pages/spec.md) |
| [extensions](https://personalagentprotocol.org/docs/extensions) | 200 | 2026-10-12T00:04:59Z | Oct 9, 2026 | `1e534d01cec36dff2caa12d2f9237d287d45c717a4aa7ef4a3877c326dbc11bc` | [pages/extensions.md](pages/extensions.md) |
| [operations](https://personalagentprotocol.org/docs/extensions/operations) | 200 | 2026-10-12T00:04:59Z | Oct 9, 2026 | `62abc67a3e37775f8f4753edc7f55c2e703a1f270d36454117da1639f063d63b` | [pages/operations.md](pages/operations.md) |
| [guides](https://personalagentprotocol.org/docs/guides) | 200 | 2026-10-12T00:05:00Z | Oct 9, 2026 | `5caeb900e5bcdc62095fb15c93af836905e953074e183f0a332033da386b5bd9` | [pages/guides.md](pages/guides.md) |
| [open-topics](https://personalagentprotocol.org/docs/open-topics) | 200 | 2026-10-12T00:05:00Z | Oct 9, 2026 | `bda9ca6e1da50fc96ff5d5fb2a2d8ca5fff7cf6e7714a7caef23b51502981379` | [pages/open-topics.md](pages/open-topics.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-10-12T00:04:29Z | (none shown) | `8119169d02c3b2701bce1c8d8ad67f49b53f225467259918f4ea0a89e88eec43` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-10-12T00:05:00Z | (none shown) | `f6f22f53bed1d9e8cab01286752a54d2ef9169efd961d99ab985b9e825322d66` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `7dcbb4713794fe318e187fd3b5dc0276c083160cdb58fc8998ab854006a5c6c1`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/1-7e6oz3cj7or.js?dpl=dpl_6p1W5nYKs9piSN5tAQDmeZfFCQ2B (HTTP 200, 39991 bytes, SHA-256 `84a80b600aa317f4bc5eddcf14a3cda8471e4096ed16b8c9db4653db09d81596`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
