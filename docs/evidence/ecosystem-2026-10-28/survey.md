# Ecosystem survey — 2026-10-28

Attempted 2026-10-28T09:00:00.195Z; finished 2026-10-28T09:30:00.821Z. Some observations are incomplete; their last known values are not fresh checks.

Public source, release and discovery GETs only; no Sessions, sign-ins, APIs or third-party code execution

Discovery: **23 valid, 3 invalid, 6 unsupported by PDA, 1 indeterminate**. Unsupported profiles are not judged against older rules. These are document observations under PDA's pinned profiles, not sign-in or ordering results.

## Repository observations

Pin values were read at survey start; reviewed follow-up pin changes are recorded separately.

| Repository | Observed head | Changed since prior observation | Grid pins at survey start |
| --- | --- | --- | --- |
| personal-agent-protocol/personal-agent-protocol | [a95b757](https://github.com/personal-agent-protocol/personal-agent-protocol/tree/a95b757872533a6ef1e1a9bcf29802857d2e5ff4) | yes; review comparison | official-validator/agent: 39b35bd |
| datalayer/personal-agent-protocol | [a3713e3](https://github.com/datalayer/personal-agent-protocol/tree/a3713e358dd407080d446c8934250e9cdf684dad) | yes; review comparison | datalayer-ts/agent: 00216eb, datalayer-ts/company: 00216eb, datalayer-py/agent: 00216eb, datalayer-py/company: 00216eb, datalayer-ts-v02/agent: 97c1386, datalayer-ts-v02/company: 97c1386, datalayer-py-v02/agent: 97c1386, datalayer-py-v02/company: 97c1386 |
| spenciefy/print-with-poppy | [4dcb1e8](https://github.com/spenciefy/print-with-poppy/tree/4dcb1e85d062dae0185008dcfbd5d2b81afedcc7) | yes; review comparison | print-with-poppy/company: 3360d8b, print-with-poppy-live/company: unknown, print-with-poppy-sandbox-live/company: unknown |
| richardanaya/pi-poppy | [11ea106](https://github.com/richardanaya/pi-poppy/tree/11ea10630180740f16ccd507b8f90f69870c7e32) | no | pi-poppy/agent: 11ea106, pi-poppy/company: 11ea106 |
| irvinebroque/poppy-demo | [02a9b30](https://github.com/irvinebroque/poppy-demo/tree/02a9b304e92fdfee465c57f2822742eecac8bdc8) | no | poppy-demo/agent: 02a9b30, poppy-demo/company: 02a9b30 |
| akshay5995/poppyseed | [6393dfb](https://github.com/akshay5995/poppyseed/tree/6393dfb0f3ec93a604a6b1885fcdb89a918c3527) | yes; review comparison | poppyseed/company: f479fb6, poppyseed-live/company: f479fb6 |
| everruns/everruns | [f751048](https://github.com/everruns/everruns/tree/f7510487507668c9091f1a759e7ec3f391361921) | yes; review comparison | everruns/agent: aceb2e2, everruns/company: aceb2e2 |
| DavideCarvalho/adonis-agora-agent | [bc09691](https://github.com/DavideCarvalho/adonis-agora-agent/tree/bc096918182cdd70456961a901947330fb0b4627) | yes; review comparison | adonis-agora/agent: e139b95 |
| DavideCarvalho/adonis-agora-authkit | [b2082ec](https://github.com/DavideCarvalho/adonis-agora-authkit/tree/b2082ecc35feceaae01446fc167bfb525ec5947d) | yes; review comparison | adonis-agora/company: fe2a3ff |
| rbirkby/Ilmer.org | [b97f7b7](https://github.com/rbirkby/Ilmer.org/tree/b97f7b76a2b48bd9d810a487ff84ade816fa5ccd) | yes; review comparison | ilmer/company: de0d1ec, ilmer-live/company: de0d1ec |
| timothyohare/personal-agent-protocol | [fb7b4e6](https://github.com/timothyohare/personal-agent-protocol/tree/fb7b4e64ad343d9406055a995f4beb06269c1ce6) | no | tipping-co/agent: fb7b4e6, tipping-co/company: fb7b4e6 |
| ketanbj/openavt | [9e99b62](https://github.com/ketanbj/openavt/tree/9e99b622515b20d1b8d5405be229c7199d73dd60) | no | none |
| allowfy/allowfy-check | [11137ad](https://github.com/allowfy/allowfy-check/tree/11137ada084f3689d73d2ae23f2c00958a7022e2) | no | none |
| ora/poppy-ax | [f6b5cc3](https://github.com/ora/poppy-ax/tree/f6b5cc3c0d8d8e680f0d2429eac31ea9a6214cb6) | no | none |
| akshay5995/poppy-agent-demo | [a5c0bdc](https://github.com/akshay5995/poppy-agent-demo/tree/a5c0bdc34f423ee924216f4268eb28d704dfa731) | no | none |
| JaviChulvi/awesome-poppy | [1c015f9](https://github.com/JaviChulvi/awesome-poppy/tree/1c015f9cbe561b443c11c5b46aa583d9ae1008b1) | yes; review comparison | none |
| Flaxscrip/poppy-test-agent | [7012e74](https://github.com/Flaxscrip/poppy-test-agent/tree/7012e7447b0cb06d90b54785e821e503f32e20cd) | no | none |
| ohartwig/poppy | [465b4fe](https://github.com/ohartwig/poppy/tree/465b4fec644ec24d812574ac9ee981e5d029d1e9) | unknown | none |
| ohartwig/typo3-poppy | [dafdd2b](https://github.com/ohartwig/typo3-poppy/tree/dafdd2b746e438009d3472f669f2515f2a2fa194) | unknown | none |
| ohartwig/sylius-poppy | [39a317b](https://github.com/ohartwig/sylius-poppy/tree/39a317b4199f937694e0007bc762e457189ba5a0) | unknown | none |
| kidkuddy/poppy-cli | [0a6dab5](https://github.com/kidkuddy/poppy-cli/tree/0a6dab5560083824d7ac3908ada84cca6683e1fa) | unknown | none |
| LMol-4/poppykit-client | [39e9fd8](https://github.com/LMol-4/poppykit-client/tree/39e9fd842e6cdcc803f591ea5e372903b48512fa) | unknown | none |
| LMol-4/poppykit-server | [b0df53e](https://github.com/LMol-4/poppykit-server/tree/b0df53e417fd9ddc85dff9d70dc20a4ec049ab25) | unknown | none |

## Packages

| Registry | Package | Observed version |
| --- | --- | --- |
| npm | @datalayer/personal-agent-protocol | 0.27.0 |
| pypi | personal-agent-protocol | 0.27.0 |
| npm | poppyseed | 0.3.1 |

## Public discovery

| Host | Declared profile | Verdict | Errors / warnings / info | Changed documents or diagnostics |
| --- | --- | --- | --- | --- |
| printwithpoppy.com | 0.2 | valid | 0 / 0 / 3 | no |
| sandbox.printwithpoppy.com | 0.2 | valid | 0 / 0 / 2 | no |
| archon.technology | 0.2 | valid | 0 / 0 / 0 | no |
| flowers.papsandbox.com | 0.3 | unsupported | 1 / 0 / 0 | yes |
| crosswalk.to | 0.2 | valid | 0 / 0 / 1 | no |
| stacktr.ee | 0.2 | valid | 0 / 3 / 2 | no |
| www.planmyvisit.to | 0.2 | valid | 0 / 0 / 1 | no |
| saferate.com | 0.2 | valid | 0 / 0 / 0 | no |
| ample.computer | 0.1 | invalid | 1 / 0 / 0 | no |
| withpoppyseed.dev | 0.3 | unsupported | 1 / 0 / 0 | yes |
| poppy-receiver.roundtrip.workers.dev | 0.1 | valid | 0 / 0 / 1 | no |
| tilopay.shop | 0.1 | invalid | 3 / 0 / 1 | yes |
| tilopay.tilopay.shop | 0.1 | invalid | 3 / 0 / 2 | yes |
| emorahealth.com | 0.1 | valid | 0 / 0 / 1 | no |
| rentourbins.com | 0.1 | valid | 0 / 0 / 2 | no |
| neutral-state-jev-dub-bench.vercel.app | 0.1 | valid | 0 / 0 / 0 | no |
| neutral-state-jev-os-bench.vercel.app | 0.1 | valid | 0 / 0 / 0 | no |
| ax-air.com | 0.1 | valid | 0 / 0 / 2 | no |
| notjustabank.com | 0.3 | unsupported | 1 / 0 / 1 | yes |
| spotmeplease.com | 0.1 | valid | 0 / 0 / 0 | no |
| poppy.ilmer.org | 0.1 | valid | 0 / 0 / 4 | no |
| www.ilmer.org | 0.1 | valid | 0 / 0 / 5 | no |
| salespeak.ai | 0.1 | valid | 0 / 0 / 1 | no |
| www.alpine-retail.com | 0.2 | valid | 0 / 0 / 0 | yes |
| windomsports.com | 0.1 | valid | 0 / 3 / 2 | yes |
| getvibe.dev | 0.1 | valid | 0 / 0 / 2 | no |
| origin-platform-labs.netlify.app | 0.1 | valid | 0 / 0 / 1 | no |
| intercom.io | unknown | indeterminate | 1 / 0 / 0 | unknown |
| bank.notjustabank.com | 0.3 | unsupported | 1 / 0 / 1 | unknown |
| food.papsandbox.com | 0.3 | unsupported | 1 / 0 / 0 | unknown |
| poppy.lukemolony.com | 0.2 | valid | 0 / 3 / 1 | unknown |
| stays.papsandbox.com | 0.3 | unsupported | 1 / 0 / 0 | unknown |
| planmyvisit.to | 0.2 | valid | 0 / 0 / 1 | unknown |

## Review leads

Searches are bounded leads; forks and similarly named projects require review. No candidate was added to the interop registry.

- "personal agent protocol" created:&gt;=2026-10-23: 4 matches; first 20 requested.
  - [ohartwig/typo3-poppy](https://github.com/ohartwig/typo3-poppy): Personal Agent Protocol (Poppy) for TYPO3 — read-only mirror
  - [ohartwig/sylius-poppy](https://github.com/ohartwig/sylius-poppy): Personal Agent Protocol (Poppy) for Sylius — read-only mirror
  - [ohartwig/poppy](https://github.com/ohartwig/poppy): Framework-agnostic server core for the Personal Agent Protocol (Poppy) — read-only mirror
  - [kidkuddy/poppy-cli](https://github.com/kidkuddy/poppy-cli): A Personal Agent Protocol (Poppy) CLI and Claude Code skill for testing Companies
- poppy created:&gt;=2026-10-23: 29 matches; first 20 requested.
  - [kutu699/kich-ban-poppy](https://github.com/kutu699/kich-ban-poppy): unknown
  - [proctor18/poppys](https://github.com/proctor18/poppys): unknown
  - [aaronbsloan-rgb/poppyspointe1](https://github.com/aaronbsloan-rgb/poppyspointe1): unknown
  - [aaronbsloan-rgb/poppyspointe](https://github.com/aaronbsloan-rgb/poppyspointe): unknown
  - [ethaantp/Floodgate](https://github.com/ethaantp/Floodgate): Self-hosted period, blood clot, and endometriosis symptom tracker for Poppy
  - [ohartwig/typo3-poppy](https://github.com/ohartwig/typo3-poppy): Personal Agent Protocol (Poppy) for TYPO3 — read-only mirror
  - [quezadamatthew27-bit/poppys-demo-](https://github.com/quezadamatthew27-bit/poppys-demo-): unknown
  - [erikrjohansson/omarchy-cumulus-theme](https://github.com/erikrjohansson/omarchy-cumulus-theme): A summer sky behind towering clouds: painted-sky blue, cloud cream and poppy orange. A dark theme for Omarchy 4.
  - [yumayo/Poppy](https://github.com/yumayo/Poppy): unknown
  - [nikita-podshivalov/poppy_playtime](https://github.com/nikita-podshivalov/poppy_playtime): unknown
  - [ohartwig/sylius-poppy](https://github.com/ohartwig/sylius-poppy): Personal Agent Protocol (Poppy) for Sylius — read-only mirror
  - [ohartwig/poppy](https://github.com/ohartwig/poppy): Framework-agnostic server core for the Personal Agent Protocol (Poppy) — read-only mirror
  - [Ukinachii/Poppy6FanMade](https://github.com/Ukinachii/Poppy6FanMade): unknown
  - [VolodymyrDem/PoppyDesk](https://github.com/VolodymyrDem/PoppyDesk): Your notch, finally useful. A free, modular menu bar app for Mac.
  - [Kittit007/poppy](https://github.com/Kittit007/poppy): unknown
  - [quezadamatthew27-bit/poppy-s-menu](https://github.com/quezadamatthew27-bit/poppy-s-menu): unknown
  - [OatsAndObjects/for-poppy](https://github.com/OatsAndObjects/for-poppy): unknown
  - [stevenjw827-collab/soldiers-1](https://github.com/stevenjw827-collab/soldiers-1): soldiers on a poppy
  - [cmatsuoka/poppy-web](https://github.com/cmatsuoka/poppy-web): Demo for libpoppy with a web UI.
  - [justinnickles/bring-poppy-home](https://github.com/justinnickles/bring-poppy-home): Help bring our lost cat Poppy home (Reno, Caughlin Ranch)

## Specification discussions

Up to 40 updated items since 2026-10-23; proposals and merged specification text require separate review.

- [Extensions proposal: Push notifications extension - let a Company tell the Personal Agent something happened](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/22) (issue, open, 2026-10-27T21:17:43Z).
- [Community demo: Poppy Simulator](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/54) (issue, open, 2026-10-27T21:17:32Z).
- [Question: should an agent ever join the customer's own everyday browser to its session?](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/53) (issue, open, 2026-10-27T19:34:01Z).
- [Links in a company's "alternatives" should only point to that company's own sites](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/52) (issue, open, 2026-10-27T19:32:06Z).
- [Use cases and two design rules for push notifications and attachments](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/51) (issue, open, 2026-10-27T19:29:59Z).
- [Agents should say whether they pass a customer's task to an agent run by another company](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/50) (issue, open, 2026-10-27T19:28:10Z).
- [Let a company mark actions that only the account holder can approve](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/49) (issue, open, 2026-10-27T19:26:37Z).
- [Let a company ask agents to use its online channels instead of phoning, and have agents say they are AI on any call](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/48) (issue, open, 2026-10-27T19:25:25Z).
- [Agents should never type the customer's password or texted code when the company offers its own sign-in page](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/47) (issue, open, 2026-10-27T19:23:46Z).
- [Let a company ask the customer to approve a big change on the company's own page](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/46) (issue, open, 2026-10-27T19:21:05Z).
- [Operations: define the company-hosted approval step for high-impact operations](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/45) (issue, open, 2026-10-27T19:14:28Z).
- [A verified human signal for sessions](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/25) (issue, open, 2026-10-27T19:14:07Z).
- [A live witness for payment records: design and evidence, published](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/44) (issue, open, 2026-10-27T19:06:06Z).
- [Community demo: Datalayer PAP SDK (Manzanita; Ledgerly with Northwind)](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/43) (issue, open, 2026-10-27T17:27:32Z).
- [Evidence for the payments discussion: an agent-paid, witnessed receipt, settled Oct 25, 2026](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/37) (issue, closed, 2026-10-27T16:04:09Z).
- [Agents that run on the user's own computer: signing without the publisher's server](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/42) (issue, open, 2026-10-27T14:00:56Z).
- [Align with OAuth and AIMS terminology](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/35) (issue, closed, 2026-10-27T13:19:22Z).
- [Implementation report: Donna, a personal agent, live on Draft 0.2 since 20 October](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/27) (issue, closed, 2026-10-27T13:12:38Z).
- [Use-case proposal: agentic charitable giving — donation authorization, receipts, and impact evidence (FundGen)](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/20) (issue, closed, 2026-10-27T13:08:04Z).
- [Standard sender name, image and identity on Company messages](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/19) (issue, closed, 2026-10-27T12:40:56Z).
- [7.10: When should an open Direct Conversation close if the User stops using it?](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/41) (issue, open, 2026-10-27T12:18:39Z).
- [7.10: Let the Company send the first message when it asked for the User](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/40) (issue, open, 2026-10-27T12:18:38Z).
- [Operations: \`approved_by: "standing_permission"\` is asserted on trust. Proposal for an optional extension that lets a Company verify it.](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/39) (issue, open, 2026-10-26T04:56:03Z).
- [Operations: standing permissions across multiple confirmations](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/38) (issue, open, 2026-10-25T18:34:58Z).
- [5: A conforming agent can't act in the User's own signed-in browser at any participating Company](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/32) (issue, open, 2026-10-25T18:05:19Z).
- [Use case: creator-priced task marketplaces, evidence-backed completion, and separate settlement](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/23) (issue, open, 2026-10-25T16:38:00Z).
- [Extension proposal: data-handling declarations in poppy.json (training, retention, regions)](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/34) (issue, closed, 2026-10-25T15:32:46Z).
- [cite rfc7523bis and state the intentional departure from its lenient grant-assertion aud rule](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/30) (issue, closed, 2026-10-25T15:17:03Z).
- [4.2: A User can't have more than one agent in the same Personal Agent](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/36) (issue, closed, 2026-10-25T15:13:35Z).
- [Extension proposal: Upstream intent-to-domain discovery prior to poppy.json handoff](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/29) (issue, closed, 2026-10-25T15:13:24Z).
- [Extension proposal: Referral, so a Company can credit the advisor that sent a customer (truefinds.ai/referral)](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/21) (issue, open, 2026-10-25T15:13:04Z).
- [4.1: \`redirect_uris\` must be HTTPS on the \`client_id\` domain, which rules out the redirects desktop apps and browser extensions use](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/33) (issue, closed, 2026-10-25T14:48:12Z).
- [4.1: An agent that runs on the User's own devices can't hold the \`private_key_jwt\` key without a cloud signer that sees every Company](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/31) (issue, open, 2026-10-25T14:45:29Z).
- [Proposal: a "feedback" extension so agents can tell companies where they got stuck](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/9) (issue, closed, 2026-10-24T18:00:00Z).
- [Extension proposal: Task grants, so the User approves one operation on the Company's page (RFC 9396)](https://github.com/personal-agent-protocol/personal-agent-protocol/issues/28) (issue, open, 2026-10-23T12:20:33Z).

## Follow-up

Review relevant upstream changes before moving any adapter pin. Run targeted interoperability checks after reviewing any pin change; keep older grid and live-journey results dated. Source movement and valid metadata do not establish successful protocol behavior.
