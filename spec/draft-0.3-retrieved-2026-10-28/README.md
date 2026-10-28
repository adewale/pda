# Personal Agent Protocol, Draft 0.3: snapshot of 2026-10-28

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-10-28, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-10-28T17:48:10Z | (none shown) | `586bc87abaee2edd91a2a1072e13cce54436c3813caf0fe05cffe373514b2ccd` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-10-28T17:48:10Z | (none shown) | `81e2cabc0db474bad05bb7a3b8d3bc747d4af6326966af055c5b3598cbe4a072` | [pages/introduction.md](pages/introduction.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-10-28T17:48:10Z | (none shown) | `008cfc2a4e31b7aedcb5c266a208518b37f354d0e8cb9a045a0e89075964f5d5` | [pages/path-to-1.md](pages/path-to-1.md) |
| [changelog](https://personalagentprotocol.org/docs/changelog) | 200 | 2026-10-28T17:48:10Z | (none shown) | `f9634e7f3be3f100b9ea714ea1ecada5170c5b8fce59dad2afb6e48a94a9f828` | [pages/changelog.md](pages/changelog.md) |
| [0.3-spec](https://personalagentprotocol.org/docs/0.3/spec) | 200 | 2026-10-28T17:48:11Z | (none shown) | `8fd7a63ac4975e2ae0c7b2e99537d35c43cd125a39f363c23c882fab27902276` | [pages/0.3-spec.md](pages/0.3-spec.md) |
| [0.3-extensions](https://personalagentprotocol.org/docs/0.3/extensions) | 200 | 2026-10-28T17:48:11Z | (none shown) | `e89c86eaf54acbe8d21a6d3b9d48280b3594eb7ec3dce82af619024a6ae862b5` | [pages/0.3-extensions.md](pages/0.3-extensions.md) |
| [0.3-operations](https://personalagentprotocol.org/docs/0.3/extensions/operations) | 200 | 2026-10-28T17:48:11Z | (none shown) | `76cde0c2939576c35c808e57df86fb5596501f047d1127205337bcf48d06a4eb` | [pages/0.3-operations.md](pages/0.3-operations.md) |
| [0.3-mediated-sign-in](https://personalagentprotocol.org/docs/0.3/extensions/mediated-sign-in) | 200 | 2026-10-28T17:48:11Z | (none shown) | `0a55eb786f2916e0022b640a27fd151e2b26b5d3c250a5c3cc6fee3edb0b180e` | [pages/0.3-mediated-sign-in.md](pages/0.3-mediated-sign-in.md) |
| [0.3-guides](https://personalagentprotocol.org/docs/0.3/guides) | 200 | 2026-10-28T17:48:11Z | (none shown) | `bdc6cdb00b22165aedda497b26c04dca0f2684f0e87c47887bf110837b2cd72d` | [pages/0.3-guides.md](pages/0.3-guides.md) |
| [videos](https://personalagentprotocol.org/docs/videos) | 200 | 2026-10-28T17:48:11Z | (none shown) | `63a3eccff45b33e9357929cb093bb550fbf7882cce1243c9835530aac7e43fb1` | [pages/videos.md](pages/videos.md) |
| [demos](https://personalagentprotocol.org/docs/demos) | 200 | 2026-10-28T17:48:11Z | (none shown) | `ddf4f8cda3aa3aea85cce627293d4f456f33c846e40efc64310ee0fa63ba6bf8` | [pages/demos.md](pages/demos.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-10-28T17:48:11Z | (none shown) | `56e6c04c034c9eb5b9d63dac09b9bc3c6a1c0fe98fe884ea1644e0306a5bbf81` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-10-28T17:48:11Z | (none shown) | `88989b63b05fba48a2c233bbd2722ca3b1b10b0e315967b623015a41bc871ccc` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `201c07be15fde259a6a5f80d53960a279524c715a08a006aa2c4703733eea4c8`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/0n6w1vrdljvbs.js?dpl=dpl_9ygLS8FV61umS1nuY9Z3NLmCRMsj (HTTP 200, 41830 bytes, SHA-256 `7e3066454d14ea2c4c180d048c903d3a137fa04db26af79d1dc3efe5fa503797`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
