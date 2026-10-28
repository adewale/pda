# Personal Agent Protocol, Draft 0.3: snapshot of 2026-10-25, 01:47 UTC

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-10-25, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

The draft changed four hours later: five more changelog entries, a new section 8, and `sign_in_required` replaced by `insufficient_scope`, in the spec and in Operations v1. That text is in [../draft-0.3-retrieved-2026-10-25T0613Z](../draft-0.3-retrieved-2026-10-25T0613Z/README.md).

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-10-25T01:47:07Z | (none shown) | `684edb9a226fb40b590323fbb2c95151ea3c6872fe8390da68d03579279c0167` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-10-25T01:47:07Z | (none shown) | `36e4a4b79017660739c70a4fc550e1e36bab5de46430bfe951bdf08c3e9eddd1` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-10-25T01:47:07Z | (none shown) | `82054fcbb874fe9afa4100580ff9d5ee1ad09497589c817d989c218fa30496f8` | [pages/path-to-1.md](pages/path-to-1.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-10-25T01:47:07Z | (none shown) | `5b71bcd95800bb54df6092e26a9a91f5089b71e8fe7c1650e2ba7af8687a2c69` | [pages/changelog.md](pages/changelog.md) |
| [0.3-spec](https://personalagentprotocol.org/docs/0.3/spec) | 200 | 2026-10-25T01:47:07Z | (none shown) | `d2ef0492d6ba3d14d9bff9e0654f95da06f69407907877ea07a7cd479b5ef798` | [pages/0.3-spec.md](pages/0.3-spec.md) |
| [0.3-extensions](https://personalagentprotocol.org/docs/0.3/extensions) | 200 | 2026-10-25T01:47:07Z | (none shown) | `83d5869cf00a09f2db38a7a029e5fdfba8bfc8f888483698f61e5071896fa325` | [pages/0.3-extensions.md](pages/0.3-extensions.md) |
| [0.3-operations](https://personalagentprotocol.org/docs/0.3/extensions/operations) | 200 | 2026-10-25T01:47:07Z | (none shown) | `201907d64c5a64b359cf10b8dbea7ede8fac03cdb862361f8ad69d080f10de28` | [pages/0.3-operations.md](pages/0.3-operations.md) |
| [0.3-guides](https://personalagentprotocol.org/docs/0.3/guides) | 200 | 2026-10-25T01:47:07Z | (none shown) | `f9cb9e7886044b464176256b4cddcd79e8f4975f86e807d702a0ca3ec66e4bd5` | [pages/0.3-guides.md](pages/0.3-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-10-25T01:47:07Z | (none shown) | `33b54caf53bcee230eeff9427ac04e15f2ec4861065f89ebf0bc0635d6b2ae23` | [pages/videos.md](pages/videos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-10-25T01:47:07Z | (none shown) | `2de403ce025e5b39cc29fb94022c1e8a7803c3ab607ac57d49ac72b2ce3c62ff` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-10-25T01:47:07Z | (none shown) | `84e33d29c03ba5612c3f08015264714770aa01a4ab065af2e54c40e5113a06fb` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `c69ae01ffc9379a9e9fbc3c134fa84d977881628dae35c6b4d53c6cb7a5f7b27`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/1s10qk7r3-1if.js?dpl=dpl_52dhzhfWrNJoYPYtgJBo6pERgcDA (HTTP 200, 40712 bytes, SHA-256 `b75d0ce420ea1a72b83181abc47784467f2e1658dd200b3488bb9b8f433ebc38`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
