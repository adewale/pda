# Personal Agent Protocol, Draft 0.1: snapshot of 2026-10-13

A copy of [personalagentprotocol.org](https://personalagentprotocol.org) as published on 2026-10-13, so that what we say about the specification can be checked against the text it was written against. Made by `scripts/spec-snapshot.mjs --save`; `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

## Attribution and license

The Personal Agent Protocol specification and documentation, including their examples, are © their authors and licensed under the [Apache License 2.0](https://personalagentprotocol.org/license); a copy of the license is in [LICENSE](LICENSE). This is a copy of that work, changed only in form:

- `pages/*.md` is each page's own Markdown copy where the page publishes one (`<link rel="alternate" type="text/markdown">`), unchanged; for the other pages it is converted from the page's HTML.
- `html/*.html` is each page's content element, with the site's classes, styles, icons, buttons and scripts removed, kept for its section anchors.
- `pages/walkthroughs.md` is the home page's worked examples, read from the data in its JavaScript bundle and written out as text.

The license doesn't cover the names Personal Agent Protocol and Poppy, the logo, or the design of the site, so none of the site's stylesheets, scripts, images or full page bodies are stored here: each page body and the walkthrough bundle is recorded by its SHA-256 below and in `manifest.json`. The names are used only to say where this came from. The companies in the examples are fictional.

## Pages

| Page | HTTP | Retrieved (UTC) | "Updated" shown | SHA-256 of the body | Text |
| --- | --- | --- | --- | --- | --- |
| [home](https://personalagentprotocol.org/) | 200 | 2026-10-13T14:51:51Z | (none shown) | `eff8aa875797c4d4725e19eda21c800d9bd527f6923a00124f5439787dac9ea4` | [pages/home.md](pages/home.md) |
| [introduction](https://personalagentprotocol.org/docs/introduction) | 200 | 2026-10-13T14:51:51Z | Oct 12, 2026 | `223477d74659eed6ea8102b4962c1d9b789d1bd98a06b496604b40795c1e08bf` | [pages/introduction.md](pages/introduction.md) |
| [spec](https://personalagentprotocol.org/docs/spec) | 200 | 2026-10-13T14:51:51Z | Oct 12, 2026 | `40a163ab19079eb027969a18b66e419a0845bd1c2090358b6c4123cb197afdf3` | [pages/spec.md](pages/spec.md) |
| [extensions](https://personalagentprotocol.org/docs/extensions) | 200 | 2026-10-13T14:51:52Z | Oct 12, 2026 | `cd00dbc065a7ef3684acd711b61a1e394884fa48aa3d8ac95548477262da3fcc` | [pages/extensions.md](pages/extensions.md) |
| [operations](https://personalagentprotocol.org/docs/extensions/operations) | 200 | 2026-10-13T14:51:52Z | Oct 12, 2026 | `ddd064031616d51dee8cc8b8fc92551fd65c1bb7e7e18ad9b09a9afdad5d5fd7` | [pages/operations.md](pages/operations.md) |
| [guides](https://personalagentprotocol.org/docs/guides) | 200 | 2026-10-13T14:51:52Z | Oct 12, 2026 | `bfbc57a000177a49381ae3bd964abcb16a6bba09e80fa40ea6ba6d76b007a242` | [pages/guides.md](pages/guides.md) |
| [path-to-1](https://personalagentprotocol.org/docs/path-to-1) | 200 | 2026-10-13T14:51:52Z | Oct 12, 2026 | `6c4aae7c7b18b790c3e515caa5bedb625dfcc65ffc72f802477d78e448d79891` | [pages/path-to-1.md](pages/path-to-1.md) |
| [license](https://personalagentprotocol.org/license) | 200 | 2026-10-13T14:51:52Z | (none shown) | `53c7ca7030b2f9ec6e36e59fee693a326c23c34c62e9babf48df4314888dffc9` | [pages/license.md](pages/license.md) |
| [contributions](https://personalagentprotocol.org/license/contributions) | 200 | 2026-10-13T14:51:52Z | (none shown) | `aa42ad6b57c41a8a27829277d62b00896e78556b1837a583080235d2ec0300e6` | [pages/contributions.md](pages/contributions.md) |

The sitemap (https://personalagentprotocol.org/sitemap.xml) had SHA-256 `3bb07738b162cc2a37e3b675068aed88ceb82d84862154c4b86bb4bbcd14f77f`. The home page's walkthroughs live only in the JavaScript bundle https://personalagentprotocol.org/_next/static/chunks/1-7e6oz3cj7or.js?dpl=dpl_GyAhdUmCcAFykAgsuavmxJmMWy2a (HTTP 200, 39991 bytes, SHA-256 `84a80b600aa317f4bc5eddcf14a3cda8471e4096ed16b8c9db4653db09d81596`).

Each page's `Last-Modified`, `ETag` and `Age` headers, the hashes of the Markdown and content HTML, and the RFC 2119 keyword counts are in `manifest.json`. A page body changes with every deployment of the site, because its asset URLs carry a deployment id; the Markdown is what to compare.
