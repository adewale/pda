# Personal Agent Protocol, Draft 0.4: snapshot of 2026-11-10

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-11-10, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-11-10T01:00:10Z | (none shown) | `2ec039eb4eabee67bd9b0e6ebe9015b3fef6a063c1c497afc71bcdb1a2c39853` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-11-10T01:00:10Z | (none shown) | `657e75f757659c82202f5bffa9a07e232676a8f3b5b9625a1dfcea78ec95661b` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-11-10T01:00:10Z | (none shown) | `f960a568eb43e30de30aa037d764b36179ed1c9a40a68faf705050dc2af4c9ae` | [pages/path-to-1.md](pages/path-to-1.md) |
| [roadmap](https://personalagentprotocol.org/docs/roadmap) | 200 | 2026-11-10T01:00:10Z | (none shown) | `3465509e525954e781c20eb652a2e40343864f430c0c5f4047a0c27130e8f6dc` | [pages/roadmap.md](pages/roadmap.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-11-10T01:00:10Z | (none shown) | `6e2e0299cefd778ad3cf59abf37e293be8a212957bd884a1a293dc6ff336eb8f` | [pages/changelog.md](pages/changelog.md) |
| [0.4-spec](https://personalagentprotocol.org/docs/0.4/spec) | 200 | 2026-11-10T01:00:10Z | (none shown) | `1114086f671d6ab907bb7075bbba48387707cbcf99ff836f3103e0f52e6a5b90` | [pages/0.4-spec.md](pages/0.4-spec.md) |
| [0.4-extensions](https://personalagentprotocol.org/docs/0.4/extensions) | 200 | 2026-11-10T01:00:10Z | (none shown) | `bbf31033f08173b1b4d5ab1ff6b438a10f9f17b6dd5f0890e1f94e05e7c9a9ec` | [pages/0.4-extensions.md](pages/0.4-extensions.md) |
| [0.4-browser-control](https://personalagentprotocol.org/docs/0.4/extensions/browser-control) | 200 | 2026-11-10T01:00:11Z | (none shown) | `a060916678d3d2700be7a90709200df3d97010b6621aa8c1b66cb4da801e55cc` | [pages/0.4-browser-control.md](pages/0.4-browser-control.md) |
| [0.4-disclosures](https://personalagentprotocol.org/docs/0.4/extensions/disclosures) | 200 | 2026-11-10T01:00:11Z | (none shown) | `c14786733ebb11ce3befebd794659322d3e35e41b06ea0f14457da1f64d8f8eb` | [pages/0.4-disclosures.md](pages/0.4-disclosures.md) |
| [0.4-links](https://personalagentprotocol.org/docs/0.4/extensions/links) | 200 | 2026-11-10T01:00:11Z | (none shown) | `7ae4a6062d22271ad0666747b3a1085ff574fde015c1461783d4f44cacc075c8` | [pages/0.4-links.md](pages/0.4-links.md) |
| [0.4-mediated-sign-in](https://personalagentprotocol.org/docs/0.4/extensions/mediated-sign-in) | 200 | 2026-11-10T01:00:11Z | (none shown) | `a18cfaf8640c9d8a2870720be1ecaa098805065f9d31158f97f4d96be49a0b32` | [pages/0.4-mediated-sign-in.md](pages/0.4-mediated-sign-in.md) |
| [0.4-operations](https://personalagentprotocol.org/docs/0.4/extensions/operations) | 200 | 2026-11-10T01:00:11Z | (none shown) | `c0eb08f8e122431857109836383fe26578536f592cb0da90c6189f235571e328` | [pages/0.4-operations.md](pages/0.4-operations.md) |
| [0.4-ucp](https://personalagentprotocol.org/docs/0.4/extensions/ucp) | 200 | 2026-11-10T01:00:12Z | (none shown) | `3e0e5907bfcd2eabaf00609fd65dc307cc33a02cb724f8d500eb146c935a5240` | [pages/0.4-ucp.md](pages/0.4-ucp.md) |
| [0.4-guides](https://personalagentprotocol.org/docs/0.4/guides) | 200 | 2026-11-10T01:00:12Z | (none shown) | `1de1b44c3ad17f90cfe7ffdc7f8f02e6520173687a7b83de573a2d7828f92670` | [pages/0.4-guides.md](pages/0.4-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-11-10T01:00:12Z | (none shown) | `1224fb159044aeeeaa0663dea84096a4fb04c75c6d66d47132f49212591c80d2` | [pages/videos.md](pages/videos.md) |
| [demos](https://personalagentprotocol.org/docs/demos) | 200 | 2026-11-10T01:00:12Z | (none shown) | `9961386c232e18c639325d8e527c3b54f2e5dc01bf00bd580aac62fff5d53138` | [pages/demos.md](pages/demos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-11-10T01:00:12Z | (none shown) | `0f2c5bd4d2313c995250fbf0e8b96399babcbadbee48c7da075bc10a753747c7` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-11-10T01:00:12Z | (none shown) | `e9ec5979a3f6e695748d2b26d2897bdca247fb8599672c46b2dd8dbd239971b2` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `ff3111313799cda21dda6610bd148ff2e7c9560b6a84b3159f0a60de011db25e`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/1276uvgha-d_5.js?dpl=dpl_FU2CU5iR9sBF9KaGjNHFEaQv3rSa (HTTP 200, 45309 bytes, SHA-256 `217f27d388e67f5461d0e57cc30a80b3bce8d1d32b8f05f724a86427d4e318b3`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
