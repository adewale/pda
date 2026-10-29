# Personal Agent Protocol, Draft 0.3: snapshot of 2026-10-29

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-10-29, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-10-29T16:27:08Z | (none shown) | `78500e50a9ba76442c9eba3f426d8c968ef17473c6490b1acdf0d94202043ffd` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-10-29T16:27:08Z | (none shown) | `9a7955675c5f308cb1f9a4249cfddc6d9f716754cb6ba47d57b8b437572fc1ca` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-10-29T16:27:08Z | (none shown) | `1cad5e97bb5625053acdc09df2e2dc09107a49f7f48576b2b9f43b25d414c25f` | [pages/path-to-1.md](pages/path-to-1.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-10-29T16:27:08Z | (none shown) | `82b51701f89c1969655f8ec6557ca9c79254a867e79c4e909c79a2e90f792413` | [pages/changelog.md](pages/changelog.md) |
| [0.3-spec](https://personalagentprotocol.org/docs/0.3/spec) | 200 | 2026-10-29T16:27:08Z | (none shown) | `ab7410c933c297f2d013522bfa636918c9b3bbb7ab656e2ecdd6d291daceb02b` | [pages/0.3-spec.md](pages/0.3-spec.md) |
| [0.3-extensions](https://personalagentprotocol.org/docs/0.3/extensions) | 200 | 2026-10-29T16:27:09Z | (none shown) | `a47f87ea00beab1544d3f27b89ba5291bf42fed28808bb078fcadaba67570205` | [pages/0.3-extensions.md](pages/0.3-extensions.md) |
| [0.3-operations](https://personalagentprotocol.org/docs/0.3/extensions/operations) | 200 | 2026-10-29T16:27:09Z | (none shown) | `271e6188f4e032f2d751f57293845136d64c676660c9fadb40f8086675d85785` | [pages/0.3-operations.md](pages/0.3-operations.md) |
| [0.3-mediated-sign-in](https://personalagentprotocol.org/docs/0.3/extensions/mediated-sign-in) | 200 | 2026-10-29T16:27:09Z | (none shown) | `769fc3dd23de63447e4f1179ae2ceaed975496cd87481ff6bc7c56b0ef86f634` | [pages/0.3-mediated-sign-in.md](pages/0.3-mediated-sign-in.md) |
| [0.3-guides](https://personalagentprotocol.org/docs/0.3/guides) | 200 | 2026-10-29T16:27:09Z | (none shown) | `511be9edc2a82d8a2ddddc180501c990ab4015821a8f90a04430b95798d608de` | [pages/0.3-guides.md](pages/0.3-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-10-29T16:27:09Z | (none shown) | `7ed180d1c5eed0b1169aa8609c180b9a6b640942eb0fef59a8ec66eb03ddcb9f` | [pages/videos.md](pages/videos.md) |
| [demos](https://personalagentprotocol.org/docs/demos) | 200 | 2026-10-29T16:27:10Z | (none shown) | `223a5f59d14adea69346c8838d2579eb8b6f69a7a1774ac1a980298a6cc562e3` | [pages/demos.md](pages/demos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-10-29T16:27:10Z | (none shown) | `5f9f991250fb671e858a87c4cecfa82e0dc0717aa980214e8943b7771217fdb9` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-10-29T16:27:10Z | (none shown) | `9509d88007393eb33afdd8f0d06981dc7aea042c12010cdf412131afae64af5f` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `201c07be15fde259a6a5f80d53960a279524c715a08a006aa2c4703733eea4c8`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/0n6w1vrdljvbs.js?dpl=dpl_6esbNCz7MtAbHKMS68eBnBqYnkrN (HTTP 200, 41830 bytes, SHA-256 `7e3066454d14ea2c4c180d048c903d3a137fa04db26af79d1dc3efe5fa503797`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
