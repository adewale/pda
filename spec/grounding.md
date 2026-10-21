# Grounding: our claims against the text of Draft 0.1

**Historical baseline, checked 17 October:** this file grounds the 9/12 October snapshots, not the subsequently revised draft. [Official commits on 15–16 October](https://github.com/personal-agent-protocol/personal-agent-protocol/commits/95fcbf22c5991a0090061aed3dbeb68c0ea575e0/) change wire requirements. Client and Session assertions now target the issuer; browser assertions still target their browser endpoint. Other changes are described in [the ecosystem map](../docs/ecosystem.md#current-ecosystem--21-october-2026). The old verdicts and keyword counts below need reconciliation before being used as current-spec claims. No new local snapshot or conformance migration is implied by this source survey.

What the Personal Agent Protocol (Poppy) says, quoted, for every claim we make about it: the spec issues in [docs/spec-issues.md](../docs/spec-issues.md), the readings in [docs/readings.md](../docs/readings.md), the rows of Appendix A in [pda-spec.md](../pda-spec.md#appendix-a-personal-agent-requirements), the mock Company's checks, the validator's messages, and the section numbers our code cites.

The text is the snapshot in [draft-0.1-2026-10-12/](draft-0.1-2026-10-12/README.md), retrieved on 13 October 2026. The rows below were written against the earlier snapshot, [draft-0.1-2026-10-09/](draft-0.1-2026-10-09/README.md) (retrieved 12 October), and every quotation in them is also in the newer one, word for word ([below](#has-the-spec-changed-since-9-and-11-october)). Quotations are verbatim from its `pages/*.md`, with "…" for omissions; Guides quotations show code as backticks. Anchors are the site's: `spec#sending-tokens` is <https://personalagentprotocol.org/docs/spec#sending-tokens>, `ops#confirm` is the Operations page, `guides#agent-dpop` the Guides. The anchors for each section are in the snapshot's `html/*.html`.

**Verdicts** for the spec issues:
- **Still applies:** the text says what the issue says it does, and the problem stands.
- **Partly addressed:** the text already covers part of the problem; the issue's row now says which part.
- **Fixed:** the text has changed and the problem is gone. None had changed at the 13 October baseline; this verdict does not cover the later revisions.
- **Misread:** the issue misstated the text.

The six misread issues, S6, S15, S21, N36, N37 and N38, were withdrawn from docs/spec-issues.md on 12 October, which leaves it 62 (20 S, 42 N). Their rows stay below, with the counts as they were, as the record of why: each quotes the text that answers the issue. S6 was misread only in part; the rest of its row, that "same domain" is undefined, is our reading in readings.md.

**Basis** for a requirement or a check:
- **MUST**, **MUST NOT**, **SHOULD**, **MAY**: the RFC 2119 keyword the sentence uses.
- **No keyword:** the text describes the behaviour in plain words ("the Personal Agent starts a new Session").
- **Guides:** a recommendation in the Guides, which say each item is "a recommendation, in the sense of SHOULD".
- **RFC:** a normative reference the spec incorporates, such as RFC 9449 for DPoP.
- **Reading** or **issue:** our own answer to a question the text leaves open, with its id in readings.md or spec-issues.md.

## Has the spec changed since 9 and 11 October?

Not in any wire rule. The site was updated on 12 October (below), and that update changed the documentation around the specification, not the specification's requirements.

Up to the evening of 12 October, every page was as it was when it was last deployed, between 9 October 23:08 and 10 October 13:52 UTC, which is before our crawl of 11 October:

- Every page showed "Updated Oct 9, 2026", and the sitemap listed the same nine pages: home, overview, spec, extensions, Operations, guides, open topics, license, contributions.
- Each response's `Last-Modified` is between Fri, 09 Oct 2026 23:08:24 GMT (the spec) and Sat, 10 Oct 2026 13:52:43 GMT (contributions), and each came from the CDN's cache (`x-vercel-cache: HIT`) with an `Age` of 34 to 49 hours, so the same bytes had been served since then. The spec page's `Age` of 176,194 seconds puts its cached copy at 9 October 23:08 UTC.
- The counts we recorded on 11 October come out the same (next section).
- Checked again on the evening of 12 October with `node scripts/spec-snapshot.mjs`: every page's body and text were the same as the snapshot's.
- No later text contradicts a quotation in our docs: where a row misstated the text, it misstated the text of 9 October (the "misread" verdicts below).

We have no copy of the 11 October crawl to compare byte for byte; from 12 October, `node scripts/spec-snapshot.mjs` compares the live site with the newest snapshot.

### The 12 October update

On 13 October `node scripts/spec-snapshot.mjs` found the site changed, and `--save` stored [draft-0.1-2026-10-12/](draft-0.1-2026-10-12/README.md). It is still Draft 0.1. Every docs page (Introduction, spec, Extensions, Operations, Guides, Path to 1.0) now shows "Updated Oct 12, 2026". What changed:

- **Spec.** One sentence in section 1: "Areas it doesn't cover yet are listed in Open topics" now ends "listed in Path to 1.0", linking to `/docs/path-to-1#open-topics` instead of `/docs/open-topics`. Nothing else on the page changed; its 107 keyword sentences are the same sentences.
- **Extensions, Operations, Guides.** The date only. Their text and content HTML are byte for byte the same as in the 9 October snapshot.
- **Overview** is renamed **Introduction** (`/docs/introduction`); only its heading changed. `/docs/overview` redirects there (308).
- **Open topics** is gone; `/docs/open-topics` redirects (308) to the "Open topics" section of a new page, **Path to 1.0** (`/docs/path-to-1`). The three topics (payments, push notifications, attachments) are worded as before. The old page's opening, "Every part of it can still change, including the parts the specification already covers", is gone; Path to 1.0 says instead "Until 1.0, a revision can break compatibility with earlier drafts."
- **Path to 1.0** is new. It says how the draft gets to 1.0 (anyone can implement it; the authors implement it with design partners; the spec changes with what they learn), what feedback they want (privacy and security, gaps, simplification, broadly useful extensions), and how to send it: inline comments on the site, exported, or an "agent kit" of the docs with an `AGENTS.md` that tells an agent how to write feedback, either kind emailed to feedback-personal-agent-protocol@sierra.ai and licensed under the [contribution terms](https://personalagentprotocol.org/license/contributions). It lists 43 design partners that agreed to be named (3 personal agents, 21 Companies, 19 technology providers) and how to become one. The agent kit is a download button, not a page, so the snapshot doesn't hold it.
- **Home.** The links to "Read the docs" go to Introduction, and the closing paragraph now points to Path to 1.0 instead of describing what a Company starts with. The walkthroughs are unchanged.
- **License, contributions.** Unchanged.

Every quotation in this file, and in the docs it grounds, was checked by script against both snapshots: each one in the 9 October text is in the 12 October text too. The one quotation in our docs that had left the site, the old Open topics opening in `docs/proposals/`, now quotes the spec and Path to 1.0 instead.

## Counts

Recounted from the 9 October snapshot by `keywordSentences` in [scripts/spec-snapshot.mjs](../scripts/spec-snapshot.mjs): a sentence counts if it has a BCP 14 keyword in capitals outside code, and the sentence that defines the keywords doesn't count. Each table cell is a sentence of its own. The counts are in each snapshot's `manifest.json`, and the 12 October snapshot's are the same.

| Page | Keyword sentences | Keywords | Recorded 11 October |
| --- | --- | --- | --- |
| Specification | 107 | MUST 57, MUST NOT 15, SHOULD 13, SHOULD NOT 1, MAY 30 | 107 |
| Operations extension | 20 | MUST 9, MUST NOT 6, SHOULD 3, MAY 3 | 20 |
| Guides | 18 sentences that restate a spec MUST; 138 bullet points, the recommendations | MUST 15, MUST NOT 5 | "about 138 recommendations" |
| Introduction (was Overview), Extensions, Path to 1.0 (was Open topics), home | 0 | | |

**Which party.** On 11 October we split the spec's 107 as Personal Agent 43, Company 51, both 13. Recounting by the party each sentence binds or permits (its subject, or who acts) gives Personal Agent 45, Company 55, both 7, listed [at the end](#the-107-keyword-sentences). The total is the same; the split is a judgement, so the docs now give only the total.

**Requirements without a keyword.** We had said "about 70" further requirements carry no keyword. That count can't be reproduced from the text without a rule for what counts as a requirement, so the docs no longer give a number. 4.4's "the Personal Agent starts a new Session" on `account_mismatch` is one: see [Appendix A](#appendix-a) and [the mock's checks](#mock-company-checks).

## Spec issues S1–S23

Anchors: `spec#…` is /docs/spec, `ops#…` is /docs/extensions/operations, `guides#…` is /docs/guides.

| ID | Section (anchor) | What the text says | Verdict | Note |
| --- | --- | --- | --- | --- |
| S1 | 4.1 (`spec#agent-identity`); 4.2 (`spec#starting-sessions`); Guides (`guides#both-signing`) | "The Personal Agent authenticates at the token endpoint with a client assertion signed by a key from `jwks_uri`" (4.1). For the *Session* assertion only: "`aud` is the Company's `token_endpoint`, as a single string rather than an array" (4.2). Guides: "Check `aud`, `exp`, and `iat`." Absent: any `aud` for the client assertion at the token, device or revocation endpoint (searched "aud", "client assertion", "audience" in spec, Ops, Guides). | still applies | RFC 7523 §3 lets `aud` be the token endpoint URL or the issuer, so the draft's silence leaves both. The 4.2 rule for the Session assertion is often read across to the client assertion; the issue could say so. |
| S2 | 4.2 (`spec#starting-sessions`); 5 (`spec#web-browsing`); Guides (`guides#both-signing`, `guides#both-key-rotation`) | "The assertion is short-lived: one minute in this example." (4.2). Browser assertion only: "`exp` is no more than 60 seconds after `iat`." (5). Guides: "reject assertions that claim a long lifetime"; "Give every key a `kid`." Absent: a header `typ` for client or Session assertions (only `dpop+jwt` and `poppy-browser+jwt` appear); a maximum lifetime for them. | still applies | The issue's quotation "reject a long lifetime" isn't verbatim; the Guides say "reject assertions that claim a long lifetime". The Guides do recommend a `kid` on every key (and a refetch on an unknown `kid`), so `kid` is covered as a Guides recommendation, not a requirement; `typ` and the number are not. |
| S3 | 3.2 (`spec#oauth-server`) | "The issuer MUST publish OAuth Authorization Server Metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414))"; the only example is "GET https://auth.example.com/.well-known/oauth-authorization-server". Absent: an issuer with a path, or the words "path"/"insert" (searched). | still applies | The normative RFC 8414 reference already implies insertion (RFC 8414 §3.1), so this is a missing example and pointer rather than a gap in the rule; the issue's facts are right. |
| S4 | 4.2 (`spec#starting-sessions`); 4.3 (`spec#sending-tokens`) | "`scope` is a space-separated string of the account scopes granted (4.4). A signed-out token has none." (4.2); "Any token request MAY include `scope`, to ask for fewer scopes than the Session has" (4.3). | still applies | Quotes match the issue. |
| S5 | 4.2 (`spec#starting-sessions`) | "A signed-in Session is renewed with the Account Token instead (4.8)." Absent: what a Company returns when a signed-in Session is renewed with an assertion (the 4.2 error table has `invalid_grant`, `invalid_session`, `account_mismatch`, none named for this). | still applies | The renewal rule has no keyword; it's a description. |
| S6 | 4.1 (`spec#agent-identity`); Guides (`guides#company-agents`) | "`jwks_uri` and every entry in `redirect_uris` MUST be HTTPS URLs on the same domain as `client_id`." Guides: "Fetch the `client_id` URL without following redirects." | misread (in part) | "Same domain" is still undefined. But the row says "Redirects on the `client_id` fetch aren't addressed", and the Guides do address them (a recommendation, not a MUST); 4.1's "`client_id` MUST equal the URL the document was fetched from" also bears on it. |
| S7 | 3.2 (`spec#oauth-server`); 4.5 (`spec#direct-sign-in`) | "MUST check that its `issuer` exactly matches `auth.issuer`" (3.2); "MUST check that `iss` exactly matches the `auth.issuer`" (4.5). | still applies | The text is unambiguous (exact). The issue is that implementations normalise anyway, and it asks for an example; its Interop severity rests on what implementations do, not on an ambiguity. |
| S8 | 7.3 (`spec#sending-messages`); 7.11 (`spec#conversation-sign-in`) | "it returns the original response and doesn't add the message again" (7.3); "a request on it from a token for the same User that isn't signed in to that account, for example after signing out (4.9), gets `sign_in_required`." (7.11) | still applies | Quotes match. |
| S9 | 7.3 (`spec#sending-messages`) | "MUST make it unique for the User"; "Because the ID is unique for the User rather than for one conversation, the Company can recognize a retried first message and return the conversation it already started." Absent: a retry while the first is in flight; what "the original response" holds; what "the same content" means (bytes or JSON value); whether a retried first message may go to `{id}/messages` (searched "in flight", "same content", "original response"). | partly addressed | The row's first question, "Per conversation?", is answered by 7.3: ids are unique per User, not per conversation. The other questions stand. |
| S10 | 7.5 (`spec#reading-events`) | "`cursor` is the last event returned, or the request's cursor if there were none." and "Without a `cursor`, the read starts at the beginning of the conversation." | still applies | On a first read with no events there is no request cursor, so the value is undefined. The `null`/`""`/`start_<id>` spellings are implementations', as the row implies. |
| S11 | 6 (`spec#apis`); 7.5 (`spec#reading-events`); 7.11 (`spec#conversation-sign-in`) | `sign_in_required`: "The request needs a signed-in token." `insufficient_scope`: "The response names them in the `scope` attribute." Event `authorization`: "`error`, and `scope` when needed". | still applies | 7.5's "when needed" could be read to allow `scope` on `sign_in_required`; nothing says it does. |
| S12 | 7.10 (`spec#direct-conversations`); 7.8 (`spec#human-or-ai`) | "The Personal Agent sends the User's messages as written, with `sender: \"human\"` (7.8), and shows the Company's replies to the User." (no keyword). Absent: whether `sender: "agent"` messages may be sent there, and an error for a Company without Direct Conversations (searched "not_supported", "unsupported"). | still applies | The 7.8 MUST covers mislabelling ("`human` only when it carries the User's own words"), not the agent's own `agent`-labelled words. |
| S13 | 6 (`spec#apis`); 4.2 (`spec#starting-sessions`) | Section 6's table lists `invalid_token`, `sign_in_required`, `insufficient_scope`. 4.2: "If it has ended, the Company returns `invalid_session`, and the Personal Agent starts a new Session." | still applies | `invalid_session` is defined only for the token endpoint. |
| S14 | 4.3 (`spec#sending-tokens`); 4.2 error table; Guides (`guides#agent-dpop`) | "Failed checks return `invalid_dpop_proof` or `use_dpop_nonce` with the `WWW-Authenticate: DPoP` header." (4.3). The 4.2 table gives both 400 (token endpoint). The Guides' resource example: "HTTP/1.1 401 Unauthorized" with "WWW-Authenticate: DPoP error=\"use_dpop_nonce\"". | partly addressed | 4.3 does say the `WWW-Authenticate: DPoP` header goes with failed checks (no keyword), so a Company sending none departs from the text rather than exposing a gap. The Guides example shows 401 for `use_dpop_nonce` at a resource (as RFC 9449 §9 does); the status for `invalid_dpop_proof` at a resource is unstated in Poppy (RFC 9449 §7.1 says 401). |
| S15 | 7.9 (`spec#handoff`); 7.7 (`spec#status`) | "The Company returns HTTP 202 with `status` and `responder`, and the status becomes `queued` while it finds someone." and "If no one is available, the status goes back to `idle` with `responder` still `agent`, and the Company Agent says why in a message." | misread | `queued` carries no keyword (it isn't "mandatory" in RFC 2119 terms), and the text does cover a Company with no one to hand to: `queued`, then `idle` with a message. What's left is whether such a Company may skip `queued` altogether. |
| S16 | 4.5 (`spec#direct-sign-in`); 4.6 (`spec#device-sign-in`) | "lets the User approve some or all of them, or decline." and "If the User declines, the redirect carries `error=access_denied` and `iss` instead." (4.5); "the User approves some or all of them, or declines." (4.6) | partly addressed | "Some or all … or decline" implies approving none is declining, hence `access_denied`, but the text never says so, and Mediated Sign-In has no consent step at all. |
| S17 | 7.2 (`spec#conversation-requests`); 7.11 | "Once it uses the User's account, it belongs to that account instead. Any Session that matches can continue it" (7.2); 7.11: "a request on it from a token for the same User that isn't signed in to that account". | still applies | The row's quoted phrase "belongs to that account" is close but not verbatim ("it belongs to that account instead"). Whether `client_id` still counts after "instead" is also open; 7.2's "The Company MUST reject requests from any other `client_id`, User, or account" lists all three. |
| S18 | 3.1 (`spec#fields`) | `organization` "Yes" "Display name and domain."; `web`: "The Company's website. The optional `browser_session_endpoint` is where the Personal Agent's browser joins a Session (section 5)." Absent: `web.url`, a meaning for `web: {}` or `apis: []`, a per-member requirement on `name` (searched "web.url", "empty", "name"). | still applies | `organization` is required and described as "Display name and domain", which suggests but doesn't state that `name` is required. |
| S19 | Guides (`guides#both-signing`) | "Support ES256 and RS256, and sign with ES256 when you can." | partly addressed | The Guides answer "required or preferred": both should be supported, ES256 preferred for signing, as a recommendation. Nothing makes ES256 mandatory to implement, and a Company offering RS256 only departs from the Guides, not the spec. The spec itself names no algorithm beyond the examples (ES256). |
| S20 | Ops 5.1 (`ops#approval`); Ops 3 (`ops#operations`); Ops 8 (`ops#proof`) | "A standing permission MUST cover the Company, the account, the action, and every term of the revision, and still be in effect." `terms`: "The Company defines its keys". Ops 8: "It doesn't prove that the User saw the terms or approved them." | still applies | Ops 8 acknowledges the proof gap by design and points to a website approval; the missing action field and money direction stand. |
| S21 | Guides (`guides#agent-native-apps`); 4.1 | "Keep the key on your server, and have the app ask the server to sign assertions for the signed-in user." and "use an HTTPS link the app claims, such as an iOS universal link or an Android app link, or use device sign-in." | misread | The note the issue asks for ("hosted identity, or Device Sign-In") is already in the Guides, under "Native and distributed apps". What remains is only that the spec text (4.1) doesn't point to it. |
| S22 | Ops 1 (`ops#intro`); Ops 4.1 (`ops#binding-openapi`) | "a Company can use it for some actions and not others"; "The Company SHOULD say in its OpenAPI description which endpoints return operations." | partly addressed | There is a SHOULD for OpenAPI descriptions, but no standard marker (hence poppyseed's `x-poppy-operation`), and nothing for MCP tools or conversations. |
| S23 | Guides (`guides#agent-dpop`) | "On `use_dpop_nonce`, take the nonce from the `DPoP-Nonce` header, keep it for that server, and retry once with a new proof that includes it." | still applies | Quote matches ("for that server"). RFC 9449 §8–9 nonces are per server (authorization or resource server), which supports per origin. |

Counts: still applies 15 (S1, S2, S3, S4, S5, S7, S8, S10, S11, S12, S13, S17, S18, S20, S23); partly addressed 5 (S9, S14, S16, S19, S22); misread 3 (S6 in part, S15, S21); fixed 0.

## Readings

The last column records the grounding pass of 12 October. `docs/readings.md` has been corrected since where it said otherwise, at least for S6 (it now cites the Guides) and S15 (it no longer calls 7.9 a MUST), so read that file for the current wording.

| Reading | Section (anchor) | The ambiguous passage(s), verbatim | Does readings.md describe it correctly? |
| --- | --- | --- | --- |
| S1 client assertion `aud` | 4.1 (`spec#agent-identity`), 4.2 (`spec#starting-sessions`) | "The Personal Agent authenticates at the token endpoint with a client assertion signed by a key from `jwks_uri` (`private_key_jwt`, [RFC 7523](https://www.rfc-editor.org/rfc/rfc7523))." and, for the Session assertion, "`aud` is the Company's `token_endpoint`, as a single string rather than an array, so the assertion can't be used at another Company." | Yes. |
| S2 assertion `typ`, `kid`, lifetime | 4.2, 5, Guides (`guides#both-signing`, `guides#both-key-rotation`) | "The assertion is short-lived: one minute in this example."; "`exp` is no more than 60 seconds after `iat`." (browser only); "reject assertions that claim a long lifetime"; "Give every key a `kid`." | Yes. It could cite the Guides' "Give every key a `kid`" as the basis for the strict mock's `kid` check, and 5's "A Session assertion isn't accepted here, and a browser assertion isn't accepted at the token endpoint." as the basis for `session-assertion.browser-typ`. |
| S3 metadata location for an issuer with a path | 3.2 (`spec#oauth-server`) | "The issuer MUST publish OAuth Authorization Server Metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414))" with the only example "GET https://auth.example.com/.well-known/oauth-authorization-server". | Yes ("RFC 8414, which the draft builds on, has one answer" is accurate: 3.2 cites it normatively). |
| S4 `scope` on a signed-out Session request | 4.2, 4.3 (`spec#sending-tokens`) | "A signed-out token has none." and "Any token request MAY include `scope`, to ask for fewer scopes than the Session has". | Yes. |
| S23 DPoP nonce scope | Guides (`guides#agent-dpop`); 4.3 | "keep it for that server, and retry once with a new proof that includes it"; 4.3: "A Company MAY require proofs to include a nonce it issued, as RFC 9449 describes" and "Personal Agents MUST support nonces." | Yes. `dpop.nonce-ignored`'s basis is 4.3's "MUST support nonces" read with RFC 9449, which readings.md could say. |
| S5 renewing a signed-in Session | 4.2 | "A signed-in Session is renewed with the Account Token instead (4.8)." | Yes ("the draft defines no error" is right). |
| S6 "same domain" | 4.1; Guides (`guides#company-agents`) | "`jwks_uri` and every entry in `redirect_uris` MUST be HTTPS URLs on the same domain as `client_id`."; Guides: "Fetch the `client_id` URL without following redirects." | Mostly. The mocks' refusal of a redirect on the `client_id` fetch has a textual basis (the Guides, a recommendation) that readings.md doesn't cite; it should, since spec-issues.md S6 said redirects "aren't addressed". |
| S7 trailing slashes | 3.2; 4.5 | "MUST check that its `issuer` exactly matches `auth.issuer`"; "MUST check that `iss` exactly matches the `auth.issuer` of the Company it started sign-in with." | Yes; "Compares exactly" is what the text says, not only a reading. |
| S8 retry after sign-out | 7.3; 7.11 | "it returns the original response and doesn't add the message again"; "for example after signing out (4.9), gets `sign_in_required`." | Yes. |
| S9 message-id idempotency | 7.3 | "MUST make it unique for the User"; "If the Company has already accepted a message with that ID and the same content, it returns the original response"; "the Company can recognize a retried first message and return the conversation it already started." | Yes ("per `client_id` and User ID, not per conversation" follows 7.3). |
| N4 which Sessions a revoked token signs out | 4.4 (`spec#sign-in`); 4.9 (`spec#sign-out`) | "The new Account Token replaces the old one, which the Personal Agent SHOULD revoke (4.9)."; "The Company revokes the Account Token and signs out every Session signed in with it." | Yes, though "as 4.4 asks" is a SHOULD; saying "as 4.4 recommends (SHOULD)" would be more exact. |
| S10 cursor on an empty first read | 7.5 | "`cursor` is the last event returned, or the request's cursor if there were none." | Yes. |
| S11 `sign_in_required` without `scope` | 6; 7.5 | "The request needs a signed-in token."; "`error`, and `scope` when needed". | Yes. |
| S12 who may write in a Direct Conversation | 7.10; 7.8 | "The Personal Agent sends the User's messages as written, with `sender: \"human\"` (7.8)"; 7.8: "`human` only when it carries the User's own words." | Partly. The "Why" says "Text attributed to the User that the User didn't write is impersonation", but `direct.agent-words` and `direct.agent-words-later` record the agent's own words sent *as `agent`*, which aren't attributed to the User. Mislabelling would break 7.8's MUST; agent-labelled words in a Direct Conversation break only our reading of 7.10's description (no keyword). The basis should say so. |
| S13/S14 errors for an ended Session, DPoP error location | 6; 4.2; 4.3 | "If it has ended, the Company returns `invalid_session`"; "Failed checks return `invalid_dpop_proof` or `use_dpop_nonce` with the `WWW-Authenticate: DPoP` header." | Yes. |
| S15 `queued` on handoff | 7.9 | "the status becomes `queued` while it finds someone"; "If no one is available, the status goes back to `idle`". | No: it said the mock "Says `queued` (the spec's MUST)". 7.9 has no keyword there; it's a description. |
| S16 approving zero scopes | 4.5; 4.6 | "lets the User approve some or all of them, or decline." | Yes (undecided). Could note "some … or decline" suggests `access_denied`. |
| S17 another User ID on the same account | 7.2 | "Once it uses the User's account, it belongs to that account instead. Any Session that matches can continue it" and "The Company MUST reject requests from any other `client_id`, User, or account." | Yes; the quoted "belongs to that account" is a fair paraphrase of "it belongs to that account instead". |
| S18 `web` without a URL, missing `name` | 3.1 | `organization`: "Display name and domain."; `web`: "The Company's website. The optional `browser_session_endpoint` is where the Personal Agent's browser joins a Session (section 5)." | Yes. |
| S19 algorithms | Guides (`guides#both-signing`) | "Support ES256 and RS256, and sign with ES256 when you can." | Yes in effect; the mocks' acceptance of both and the client's ES256-only signing are exactly the Guides' recommendation, which readings.md could cite instead of "since RS256 is as sound". |
| S20 standing permissions | Ops 5.1 | "A standing permission MUST cover the Company, the account, the action, and every term of the revision, and still be in effect." | Yes. |
| S21 local agents | 4.1; Guides (`guides#agent-native-apps`) | "A Personal Agent's `client_id` MUST be an HTTPS URL that returns its metadata document."; Guides: "Keep the key on your server, and have the app ask the server to sign assertions". | Yes (`client-metadata.not-https` rests on 4.1's MUST). |
| S22 which writes propose operations | Ops 1; Ops 4.1 | "a Company can use it for some actions and not others"; "The Company SHOULD say in its OpenAPI description which endpoints return operations." | Yes; could cite the Ops 4.1 SHOULD. |

## Spec issues N1–N45

Anchors as for S1–S23, plus `home` for the home page walkthrough (in its JavaScript bundle). "Absent" lists the terms searched for in spec, Operations and Guides.

Verdicts: 34 still apply, 8 partly addressed, 3 misread, 0 fixed.

| ID | Section (anchor) | What the text says | Verdict | Note |
| --- | --- | --- | --- | --- |
| N1 | 4.3 (`spec#sending-tokens`); 4.6 (`spec#device-sign-in`); 4.9 (`spec#sign-out`) | "It keeps the private key to itself and signs a new proof for every request, including token requests." The device request (`POST https://auth.example.com/oauth/device`) and revocation request (`POST https://auth.example.com/oauth/revoke`) examples carry no `DPoP` header. | still applies | |
| N2 | 4.5 (`spec#direct-sign-in`); 4.6 (`spec#device-sign-in`) | "It adds one thing: the Personal Agent sends `session_id` when it exchanges the code" … "checks that the Session belongs to the same `client_id`." Absent: a User ID check at the exchange, `session_id` at the authorization or device request, an error for a missing `session_id` (searched "session_id", "User ID", "PAR"). | still applies | 4.6 states no Session check at all on the poll. |
| N3 | 4.4 (`spec#sign-in`) | "Once it has been, it can't switch to another: the Company returns `account_mismatch`, and the Personal Agent starts a new Session." Absent: what happens when the account is chosen during 4.5–4.7 after the code is issued; an account hint (searched "hint", "login_hint", "account_mismatch"). | still applies | |
| N4 | 4.4 (`spec#sign-in`); 4.9 (`spec#sign-out`) | "The new Account Token replaces the old one, which the Personal Agent SHOULD revoke (4.9)." / "The Company revokes the Account Token and signs out every Session signed in with it." | still applies | The revocation is a SHOULD, not a MUST; the row says "4.4 says to revoke". |
| N5 | 4.8 (`spec#account-tokens`) | "A Company MAY return a new Account Token in `refresh_token`. The Personal Agent then MUST use the new one from then on." Absent: reuse grace, idempotent retry (searched "grace", "retry", "rotat"). | still applies | |
| N6 | 4.2 (`spec#starting-sessions`) | "`scope` is a space-separated string of the account scopes granted (4.4). A signed-out token has none." The example has `"scope": ""`. No field is marked required. | still applies | |
| N7 | 4.7 (`spec#mediated-sign-in`) | "the Company signs in the Session and returns `complete` with the same fields as the response in 4.4". Absent: HTTP statuses for `failed`, `expired`, `code_required`; error body for `invalid_scope` here; errors for a missing field, unknown `sign_in_id` (searched "status", "400", "sign_in_id"). | still applies | `refresh_token_expires_in` is covered: "the same fields as the response in 4.4", which lists it "if the Company sets one". The row lists it as undefined. |
| N8 | 4.7 (`spec#mediated-sign-in`); Guides (`guides#company-mediated`) | Absent in the spec: agent consent to scopes in Mediated Sign-In (searched "consent", "approve" in 4.7). Guides: "Tell the user, for example by email, when a personal agent signs in." | partly addressed | The Guides already recommend the Company-side notification the fix asks for (SHOULD level). The agent-side consent is still absent. |
| N9 | 3.1 (`spec#fields`); 3 (`spec#discovery`); 5 (`spec#web-browsing`) | "`issuer` is the Company's OAuth issuer identifier, an HTTPS URL." / "each with a `type` and HTTPS `endpoint`". Absent for `apis[].url`, `auth.mediated.endpoint`, `web.browser_session_endpoint`, extension `endpoint`, operation `url` (searched "HTTPS"). | still applies | Elsewhere the text requires HTTPS for the `poppy.json` URL and its redirects (3), `return_to` (5) and the agent's own `client_id`, `jwks_uri`, `redirect_uris` (4.1); 7.2 says conversations "use JSON over HTTPS". None of those covers the fields listed. |
| N10 | 4.3 (`spec#sending-tokens`) | "By default, one DPoP Session Token works at all of a Company's services, except MCP (above)." Absent: which hosts are the Company's services; OpenAPI `servers` or `securitySchemes` (searched "host", "servers", "securitySchemes"). | still applies | |
| N11 | 3.2 (`spec#oauth-server`) | "Several domains MAY name the same issuer … and they are then one Company: the same User IDs (4.2), Sessions, and Account Tokens apply to all of them." | still applies | |
| N12 | 4.2 (`spec#starting-sessions`) | "The ID is stable, so the Company sees the same User across Sessions." Absent: any reset (searched "reset", "rotate"). | still applies | |
| N13 | 5 (`spec#web-browsing`) | "MUST be `Secure` and `HttpOnly`, and use `SameSite=Lax` or `None`, not `Strict`." / "MUST NOT outlive the Session." | still applies | Guides (`guides#company-browsing`): "Limit the cookie to the hosts personal agents need". |
| N14 | 4.5 (`spec#direct-sign-in`); Guides (`guides#company-consent`); Ops 5.1 (`ops#approval`) | "The Company's page shows which Personal Agent is asking, using the name and logo from its metadata document." Guides: "Show the personal agent's name and logo, and the domain of its `client_id`." Ops: "The Personal Agent MUST show the User the Company's name and the revision's `summary`". | still applies | |
| N15 | Ops 5.1 (`ops#approval`); 7.11 (`spec#conversation-sign-in`) | "It MUST NOT treat text from the Company, such as a conversation message, as the User's approval." / "Sending a message does not authorize the requested account action." Absent: a security considerations section, "prompt injection" (searched "injection", "Security Considerations"). | still applies | Other text that bears on it: Ops 4.3 "A message doesn't confirm an operation, whatever it says"; 7.6 "It MUST NOT act on text from a `text-delta` event"; Guides "Never expose private keys to a model", "Don't rely on the model to decide". The row's "only Ops 5.1 and 7.11" is too narrow. |
| N16 | 4.9 (`spec#sign-out`); 7.11 (`spec#conversation-sign-in`); 7.13 (`spec#conversation-errors`); Guides (`guides#company-conversations`) | "so a cart or an open conversation carries on" / "Once a conversation has used the User's account, a request on it from a token for the same User that isn't signed in to that account … gets `sign_in_required`." / "belongs to a different Personal Agent, User, or account (7.2)" / Guides: "When a session signs out, close its conversations that used the account". | still applies | 4.9 and 7.11 can be read together (7.11 narrows to conversations that used the account); the Guides' "close" is the real divergence, since a closed conversation answers `conversation_closed`. |
| N17 | 4.3 (`spec#sending-tokens`) | "For MCP, the Personal Agent requests a Session Token without a proof, and the Company issues a `Bearer` token." / "Companies MUST accept Bearer Session Tokens only on their MCP APIs (section 6)". Absent: a rule that the token endpoint issues Bearer only for a listed MCP `url`. | still applies | |
| N18 | 6 (`spec#apis`) | "the Company treats that sign-in as starting a new signed-in Session." Absent: User ID, `session_id`, whether those refresh tokens are Account Tokens. | still applies | |
| N19 | Ops 3.2 (`ops#ownership`); Ops 6 (`ops#tracking`) | "An operation proposed in a signed-out Session can be used only in that Session. The Company returns `operation_not_found` to anyone else." / "It MUST NOT ask for a new proposal of the same action until the operation is final." | still applies | |
| N20 | Ops 5.2 (`ops#confirm`); Ops 7 (`ops#cancelling`); Ops 9 (`ops#errors`) | "Otherwise it returns `in_progress` with a `Retry-After` header" (no status); cancel has no response status; "the current operation in `operation` where noted." | still applies | `user_approval_required` isn't "noted" as carrying the operation (only `terms_changed` is), so by Ops 9's own rule it doesn't; the row lists that as undefined. |
| N21 | 7.10 (`spec#direct-conversations`); 7.13 (`spec#conversation-errors`) | "The parent conversation MUST be open, belong to the same owner (7.2), and not be a Direct Conversation itself. … Otherwise the Company returns `conversation_not_found`, `conversation_closed`, or `direct_conversation_open`." 7.13 has no `invalid_request`. | still applies | Four conditions, three errors. |
| N22 | 3.1 (`spec#fields`); 3.3 (`spec#extensions`); 4.1 (`spec#agent-identity`) | "The protocol version the document follows, as `major.minor`." / "Each entry has a `version`, the extension's major version." Absent: a version in client metadata; a list of versions; `version`'s JSON type (examples use `"1"`). | still applies | |
| N23 | 4.1 (`spec#agent-identity`) | The client metadata example has `client_id`, `client_name`, `logo_uri`, `jwks_uri`, `redirect_uris`, `token_endpoint_auth_method`, `extensions`; no `grant_types`, no `dpop_bound_access_tokens`. | still applies | |
| N24 | 3.2 (`spec#oauth-server`) | The metadata example has `issuer`, `token_endpoint`, `revocation_endpoint`, `authorization_endpoint`, `device_authorization_endpoint`, `poppy_domains`. "The metadata MAY have other fields, which Personal Agents ignore." | still applies | The home walkthrough's metadata also omits `response_types_supported`. |
| N25 | 4.1 (`spec#agent-identity`); 4.2 (`spec#starting-sessions`); 5 (`spec#web-browsing`) | "The same keys sign its Session assertions (4.2)." / "checks that the assertion's `iss` is the authenticated `client_id`". 5 separates only browser assertions: "A Session assertion isn't accepted here, and a browser assertion isn't accepted at the token endpoint." | still applies | |
| N26 | 3.1 (`spec#fields`); Ops 2 (`ops#support`) | `auth` is required "If `agent`, `apis`, or `web.browser_session_endpoint` is present". Ops: "The endpoint accepts DPoP Session Tokens (spec 4.3)." | still applies | |
| N27 | 3 (`spec#discovery`); 3.1 (`spec#fields`); 5 (`spec#web-browsing`) | "`{domain}` is the Company's domain or a subdomain it controls." / "`domain` MUST match the host of the well-known URL the Personal Agent requested, ignoring a leading `www.`." / `return_to` "MUST be an HTTPS URL on the Company's `organization.domain` or one of its subdomains." | still applies | The row says "must equal the host requested"; the text ignores a leading `www.`. |
| N28 | 4.4 (`spec#sign-in`); Guides (`guides#company-lifetimes`) | "`refresh_token_expires_in` is the Account Token's lifetime in seconds, if the Company sets one." Guides: "expire ones that go unused sooner." | still applies | `refresh_token_expires_in` is in 4.4, not 4.8 as the row says. |
| N29 | 7.4 (`spec#message-fields`) | "Any message can carry `context`, and fields it leaves out keep their previous values." Absent: clearing a field; carrying into Direct or new conversations. | still applies | |
| N30 | 7.6 (`spec#streaming`); Guides (`guides#company-conversations`) | "Changes to `status` and `responder` arrive as `state` events." / "The Personal Agent reconnects with `Last-Event-ID` set to the last event it handled, in place of `cursor`." Guides: "On a stream with nothing to send, send an SSE comment every 15 to 30 seconds, so proxies don't close it". | partly addressed | Keep-alive comments are already a Guides recommendation, and 7.6 says `Last-Event-ID` replaces `cursor` on reconnect. Still absent: a starting status, `wait` on a stream, a request with both, when headers are sent, reconnect delay (searched "retry", "headers"). |
| N31 | 7.10 (`spec#direct-conversations`) | "If they decline or aren't available, it says so in the conversation." | still applies | |
| N32 | 4.5 (`spec#direct-sign-in`); Guides (`guides#company-consent`) | "If the User declines, the redirect carries `error=access_denied` and `iss` instead." Guides: "Return `iss` in every redirect, success or error (MUST, [4.5])". | still applies | |
| N33 | 7.3, 7.5 (`spec#sending-messages`, `spec#reading-events`); Ops 3, 4.3, 9; 6 (`spec#apis`); home | 7.5: `"id": "evt_c2"` … `"id": "msg_r2Kq"` "I can do that. The insulated version would be warmer."; Ops 4.3: same IDs, "I can exchange it for the insulated version for $70 more."; 7.5 `"price_difference": 70`; Ops 3 `{ "amount": "70.00", "currency": "USD" }`; home: `"fare_estimate": { "amount": 48, "currency": "USD" }`; 7.3 "order #1042"; Ops 9 "(spec section 3)"; 6 "`invalid_token` \| 401 \| The token is missing or expired." | still applies | Every example holds. `{amount: 48}` is in the home page walkthrough, not the spec. |
| N34 | Ops 6 (`ops#tracking`); Ops 3.1 (`ops#revisions`); Ops 4 (`ops#proposing`) | "If a confirm request fails or times out, the Personal Agent retries it or reads the operation, with the same operation ID. It MUST NOT ask for a new proposal of the same action until the operation is final." / "the Company SHOULD return the existing operation instead of proposing a new one." | still applies | |
| N35 | 4.3 (`spec#sending-tokens`); Guides (`guides#agent-dpop`) | "The Personal Agent generates a key pair for each User at each Company, and MAY use a new one for each Session." Guides: "Generate a DPoP key pair for each user at each company". | partly addressed | No keyword in 4.3, as the row says, but the Guides make it a recommendation (SHOULD in the Guides' sense). A Company's handling of a shared key is still absent. |
| N36 | 3 (`spec#discovery`); 3.1 (`spec#fields`); 3.2 (`spec#oauth-server`) | The example `poppy.json` for `"domain": "example.com"` has `"issuer": "https://auth.example.com"`, and the metadata example is `GET https://auth.example.com/.well-known/oauth-authorization-server`. The home walkthrough uses `https://auth.manzanitasupply.example` for `manzanitasupply.example`. | misread | The row says the examples put the issuer on the Company's host and nothing says it may be on another; the examples put it on another host. An agent requiring issuer = Company origin contradicts the draft's own examples. Still absent: an issuer with a path (S3) or on a host outside `organization.domain`. |
| N37 | 3 (`spec#discovery`); 3.1 (`spec#fields`); Guides (`guides#both-fetching`, `guides#company-agents`) | "The well-known URL MAY redirect to where the document is hosted … Personal Agents MUST follow redirects, and every redirect MUST be to an HTTPS URL." / "After a redirect, the host the document is served from does not count." Guides: "a few redirects at most"; "Fetch the `client_id` URL without following redirects." | misread | The draft isn't silent: redirects are allowed, agents MUST follow them, HTTPS only, and `organization.domain` is compared with the host requested. Agents that refuse to follow break a MUST. Still absent: a number, and redirects on OAuth metadata and endpoints. |
| N38 | Guides (`guides#both-key-rotation`, `guides#both-fetching`) | "Give every key a `kid`." / "Companies refetch `jwks_uri` when they see an unknown `kid`, with a rate limit so a stream of bad assertions can't trigger a fetch each time." / "Cache according to HTTP caching headers, within bounds you set, such as at least a minute and at most a day." | misread | The Guides do say a Company refetches on an unknown `kid` (rate-limited) and bound caching, which is most of the suggested fix. Still absent: that a new key needs a new `kid`. pi-poppy's and AuthKit's behaviour departs from the Guides. |
| N39 | 4.2 (`spec#starting-sessions`); 6 (`spec#apis`) | "The Company decides how long a Session lasts. If it has ended, the Company returns `invalid_session`, and the Personal Agent starts a new Session." (in the renewal paragraph; the token endpoint's error table lists `invalid_session`). Section 6 lists only `invalid_token`, `sign_in_required`, `insufficient_scope`. | partly addressed | The token endpoint case is stated, including that the agent starts a new Session, so Datalayer's `invalid_token` there and pi-poppy giving up both depart from 4.2. What a resource returns is still undefined (S13). |
| N40 | 7.3 (`spec#sending-messages`); 7.5 (`spec#reading-events`); home | "The Company accepts the message, then responds as a read of the conversation's events from that cursor would (7.5), holding the request for up to `wait` seconds." / "It MAY return sooner, or cap `wait`." | partly addressed | 7.3's example shows only the request; the replies-in-the-response examples are in the home walkthrough. 7.5 already lets a Company return sooner or cap `wait`, so it's a hint. Still absent: that the agent must read events for a reply it didn't get. A send that doesn't answer as a read would (poppyseed) departs from 7.3. |
| N41 | Ops 3 (`ops#operations`) | `"confirmation": null, "result": null` for required members. Absent: whether an optional member may be `null` (searched "null", "absent", "omit"). | still applies | |
| N42 | Guides (`guides#both-fetching`) | "Reject loopback, private, and link-local addresses unless you've configured them on purpose." | partly addressed | The Guides already allow a deliberate configuration; they name no test mode or reserved suffix. The row says they "forbid" private addresses. |
| N43 | 5 (`spec#web-browsing`); Ops 1, 4.4 (`ops#intro`, `ops#binding-web`) | Ops: "whether it came up in an API call, an MCP tool, a conversation, or a web page." / "If the website also lets the Session confirm or cancel it, that is the same operation … and the Personal Agent's duties in 5.1 apply however it confirms." Absent in 5: approval for form submissions (searched "form", "approv", "consequential"). | partly addressed | A Company can already route website actions through Operations, and then 5.1's approval applies on the website. A website submission outside Operations still has no approval step. |
| N44 | 3 (`spec#discovery`); 3.2 (`spec#oauth-server`); Guides (`guides#both-fetching`) | "Personal Agents SHOULD cache the document according to its HTTP caching headers." Guides: "Cache according to HTTP caching headers, within bounds you set, such as at least a minute and at most a day. The upper bound means a removed key stops being trusted." | partly addressed | The Guides already give a maximum lifetime (a day). Still absent: validating every fetch in full, and a MUST against use past the lifetime. |
| N45 | 4.5 (`spec#direct-sign-in`); 4.6 (`spec#device-sign-in`) | "Errors follow OAuth 2.0, such as `invalid_grant` for an expired or reused code." Absent: idempotent exchange, revoke by `session_id` (searched "retry", "idempot", "session_id"). | still applies | |

## Appendix A

Each row of Appendix A in `pda-spec.md`, against Draft 0.1 and Operations v1 as retrieved on 12 October 2026; the same text is in the 12 October update ([pages/spec.md](draft-0.1-2026-10-12/pages/spec.md), [pages/operations.md](draft-0.1-2026-10-12/pages/operations.md), [pages/guides.md](draft-0.1-2026-10-12/pages/guides.md)). "Keyword" is the RFC 2119 keyword the text uses for the Personal Agent's part. "Matches" is whether the row's wording, as now edited, says the same: keyword strength, scope and section. Rows marked "edited" were corrected in this pass.

### Specification

| § | Row (short) | Text, verbatim | Keyword in text | Row matches? | Note |
| --- | --- | --- | --- | --- | --- |
| 3 (#discovery) | Follow redirects; HTTPS only | "Personal Agents MUST follow redirects, and every redirect MUST be to an HTTPS URL." | MUST | Yes | |
| 3, 3.2 | Cache `poppy.json` and metadata | 3: "Personal Agents SHOULD cache the document according to its HTTP caching headers." 3.2: "Personal Agents SHOULD cache it according to its HTTP caching headers." | SHOULD | Yes (edited) | Row named only `poppy.json`; the test already covered the metadata. The minute-to-day bounds are the Guides' ("at least a minute and at most a day"). |
| 3.1 (#fields) | Major version; ignore unknown fields | "A Personal Agent MUST NOT use a document whose major version it doesn't support." / "…which use the document and ignore fields they don't recognize." (3.3: "MUST ignore … fields they don't recognize") | MUST NOT; MUST (3.3) | Yes | |
| 3.1 | `organization.domain` = requested host | "`domain` MUST match the host of the well-known URL the Personal Agent requested, ignoring a leading `www.`. After a redirect, the host the document is served from does not count." | MUST (on the document) | Yes (edited "must" → MUST) | The MUST binds the Company's document; the agent's check follows from it. |
| 3.2 (#oauth-server) | Check `issuer` and `poppy_domains` | "the Personal Agent fetches the metadata and MUST check that its `issuer` exactly matches `auth.issuer` and that `poppy_domains` includes `organization.domain`." | MUST | Yes | |
| 3.2 | Domains naming one issuer are one Company | "Several domains MAY name the same issuer … and they are then one Company: the same User IDs (4.2), Sessions, and Account Tokens apply to all of them." | MAY (Company); none for the agent | Yes (edited: marked no keyword) | |
| 3.3 (#extensions) | Ignore unsupported extensions; list ours | "Personal Agents and Companies MUST ignore extensions they don't support and fields they don't recognize" / "A Personal Agent lists the extensions it supports the same way, in `extensions` in its client metadata document (4.1)." | MUST; none | Yes | Listing has no keyword. |
| 3.3 | Handle `extension_required` | "A Company MAY refuse a request it handles only with an extension the Personal Agent doesn't list. It returns `extension_required` (HTTP 403) with the extension's name in `extension`." | MAY (Company); none for the agent | Yes | |
| 4.1 (#agent-identity) | `client_id` HTTPS, equals URL | "A Personal Agent's `client_id` MUST be an HTTPS URL that returns its metadata document." / "`client_id` MUST equal the URL the document was fetched from." | MUST | Yes | |
| 4.1 | `jwks_uri`, `redirect_uris`; public keys only | "`jwks_uri` and every entry in `redirect_uris` MUST be HTTPS URLs on the same domain as `client_id`. The key set contains only public keys." | MUST; none (public keys) | Yes | "Same domain" undefined (S6). |
| 4.1 | `private_key_jwt`; DPoP keys separate | "The Personal Agent authenticates at the token endpoint with a client assertion signed by a key from `jwks_uri` (`private_key_jwt`…)." / "Its DPoP keys (4.3) are separate and aren't published." | none | Yes | |
| 4.1 | Handle `invalid_client` | "A Company that requires registration rejects an unregistered Personal Agent with the OAuth `invalid_client` error (HTTP 401) when it starts a Session." | none | Yes | |
| 4.2 (#starting-sessions) | Stable User ID per Company | "The Personal Agent MUST give each of its Users a User ID for each Company, where a Company is identified by its `auth.issuer` (3.2). The ID is stable…" | MUST (stability descriptive) | Yes | |
| 4.2 | No personal information | "It MUST NOT contain or be derived from personal information, such as an email address, phone number, or name, even with a keyed hash." | MUST NOT | Yes | |
| 4.2 | Session assertion claims | "`aud` is the Company's `token_endpoint`, as a single string rather than an array" / "The assertion is short-lived" / "`jti` is a unique ID for the assertion, with at least 128 random bits." | none | Yes | Row claims no keyword. |
| 4.2 | Don't depend on token contents | "Personal Agents MUST NOT depend on their contents; everything they need is in the response." | MUST NOT | Yes | |
| 4.2 | Renew with `session_id`; `invalid_session` → new Session | "the Personal Agent sends the same request with fresh assertions and the `session_id`" / "If it has ended, the Company returns `invalid_session`, and the Personal Agent starts a new Session." | none | Yes | The `invalid_token` case in its test is our reading of N39. |
| 4.3 (#sending-tokens) | `Authorization: DPoP` and a proof | "API calls and conversations MUST carry the Session Token in the `Authorization` header with the `DPoP` scheme, together with a DPoP Proof" | MUST | Yes | MCP is the stated exception (Bearer). |
| 4.3 | New proof per request; `ath`; `htu` | "signs a new proof for every request, including token requests" / "`ath` … Proofs sent to the token endpoint don't have one." / "`htm` and `htu` are the request's HTTP method and URL, without the query or fragment." | none | Yes | |
| 4.3 | Key pair per User per Company | "The Personal Agent generates a key pair for each User at each Company, and MAY use a new one for each Session." | none (N35) | Yes | |
| 4.3 | Support nonces | "Personal Agents MUST support nonces." | MUST | Yes | |
| 4.3 | MCP Bearer with `resource` | "sends the request that renews the Session's token … without the `DPoP` header, and MUST include `resource` set to the MCP server's `url` from `poppy.json`" | MUST | Yes | |
| 4.3 | Tokens for an entry's `resource` | "Any token request MAY include … `resource` (RFC 8707)" / "accepts a token at such a service only if it was issued for that `resource`." | MAY | Yes | |
| 4.3 | Narrower tokens for lookups | 4.3: "Any token request MAY include `scope`, to ask for fewer scopes than the Session has". Guides (#agent-choosing-sign-in): "For a task that only looks things up, request a read-only session token from a broader account token" | MAY; Guides | Yes | Row cites Guides. |
| 4.3 | Tokens only to the Company's hosts | absent: no rule on which hosts receive Session Tokens (searched 3, 4.3, 6 for "host", "servers"). 4.3: "one DPoP Session Token works at all of a Company's services" | none | Yes | Row says "our reading; N10". |
| 4.3 | Token on every request | "Personal Agents MUST send a Session Token on every API and conversation request, and MUST NOT leave it out to appear to the Company as a person on their own." | MUST, MUST NOT | Yes | |
| 4.3 | Newest token | "Whenever the Personal Agent gets a new Session Token for a Session, it MUST use the new token from then on." | MUST | Yes | |
| 4.3 | No tokens in URLs | "Personal Agents MUST NOT send tokens in a URL" | MUST NOT | Yes | |
| 4.3 | Wait `Retry-After` on 429 | "The Personal Agent MUST wait at least that long before sending the request again." | MUST | Yes | 503 is the Guides' (#both-retries). |
| 4.4 (#sign-in) | Direct/Device only when the User signs in | "a Personal Agent MUST use direct or Device Sign-In only when the User signs in themselves." | MUST | Yes | |
| 4.4 | `scope` on every sign-in request | "Each sign-in request MUST include `scope` as a space-separated string" | MUST | Yes | |
| 4.4 | Check the granted `scope` | "The User may have approved fewer scopes than requested, so the Personal Agent checks `scope` before continuing." | none | Yes | An omitted `scope` is our reading (N6, RFC 6749 §5.1). |
| 4.4 | Revoke replaced Account Token | "The new Account Token replaces the old one, which the Personal Agent SHOULD revoke (4.9)." | SHOULD | Yes | |
| 4.4 | Check for a covering token | "Before starting a new sign-in, the Personal Agent SHOULD check whether it already holds an Account Token that covers the task (4.8)." | SHOULD | Yes | |
| 4.4 | `account_mismatch` → new Session | "A Session is signed in to at most one account. Once it has been, it can't switch to another: the Company returns `account_mismatch`, and the Personal Agent starts a new Session." 4.2 table: "The Session is signed in to a different account than the one requested. Start a new Session (4.4)." | none | Was overstated; yes (edited) | See Mismatches 1. |
| 4.5 (#direct-sign-in) | `state`, PKCE, `iss`, `session_id` | "The Personal Agent creates a random `state` and a PKCE code verifier" / "MUST check that `iss` exactly matches the `auth.issuer` of the Company it started sign-in with" / "It then sends the code to the `token_endpoint` with … the `session_id`" | MUST (`iss`); none otherwise | Yes (edited) | S256 appears only in the example (`code_challenge_method=S256`) and the Guides ("Use PKCE with `code_challenge_method=S256`"). |
| 4.5 | `redirect_uri` exact; `access_denied` | "`redirect_uri` MUST exactly match an entry in the Personal Agent's `redirect_uris` (4.1). If the User declines, the redirect carries `error=access_denied` and `iss` instead." | MUST (passive) | Yes | |
| 4.2, 4.5 | Lost code-exchange answer | "Errors follow OAuth 2.0, such as `invalid_grant` for an expired or reused code." The rest is absent (searched 4.5, 4.6 for "retry", "lost", "again"). | none | Yes (edited: marked our handling of N45) | |
| 4.6 (#device-sign-in) | Show `user_code` and link; `device_code` private | "The Personal Agent shows the User `verification_uri` and `user_code`, or `verification_uri_complete` as a link or QR code. It keeps `device_code` private." | none | Yes (edited) | "HTTPS on the Company's hosts only" is ours. |
| 4.6 | Poll at `interval`; `slow_down`; stop | "Every `interval` seconds, the Personal Agent asks the `token_endpoint`" / "`slow_down` to ask the Personal Agent to wait longer" / "The Personal Agent stops asking after either." | none | Yes (edited) | +5 s is RFC 8628 §3.5 and Guides (#agent-direct-device). |
| 4.7 (#mediated-sign-in) | Protect secret fields | "`secret` marks a value the Personal Agent MUST protect: never shown back to the User, written to logs, or sent anywhere else." | MUST | Yes | |
| 4.7 | Credentials only to the endpoint | "Personal Agents MUST NOT send credentials to any endpoint other than the Company's `auth.mediated.endpoint`." | MUST NOT | Yes | |
| 4.7 | Only the code, same Session | "submits only the code, not the credentials again, with a Session Token for the same Session" / "Only the Session that started a sign-in can finish it." | none | Yes | |
| 4.7 | Handle the four statuses | Status table: `complete`, `code_required`, `failed`, `expired` | none | Yes | |
| 4.8 (#account-tokens) | Use a rotated Account Token | "A Company MAY return a new Account Token in `refresh_token`. The Personal Agent then MUST use the new one from then on." | MUST | Yes | |
| 4.8 | Account Tokens as secrets | "Personal Agents MUST store Account Tokens as secrets, and MUST NOT put them in model context, conversation messages, logs, or URLs." | MUST, MUST NOT | Yes | |
| 4.8 | Narrow `scope`; `invalid_grant` | "`scope` MAY ask for fewer scopes than the Account Token has … It can't ask for more." / "the Company returns `invalid_grant`. The Session continues signed out" | MAY; none | Yes | |
| 4.9 (#sign-out) | Revoke to sign out | "The Personal Agent revokes its Account Token at the Company's `revocation_endpoint` (RFC 7009), with its client assertion" | none | Yes | |
| 4.9 | Detect disconnection | "The Personal Agent finds out when a request fails with `invalid_token` or `sign_in_required`, or the token endpoint returns `invalid_grant` for the Account Token. It then continues signed out." | none | Yes | |
| 5 (#web-browsing) | Join before browsing | "When it does, the Personal Agent MUST join its browser to a Session before browsing the Company's website." | MUST | Yes | |
| 5 | Browser assertion fields | "with `typ` set to `poppy-browser+jwt` in its header" / "`exp` is no more than 60 seconds after `iat`." | none for the agent (the Company MUST check) | Yes | `alg`, a published `kid` and no embedded key are the Guides' (#both-signing, #both-key-rotation); "`iat` not in the future" is ours. |
| 5 | `return_to` | "It MUST be an HTTPS URL on the Company's `organization.domain` or one of its subdomains." | MUST | Yes (edited: scope) | Row said "the Company's domain". |
| 5 | Assertion in the body | "The assertion MUST go in the request body, never in the URL." / "as a form POST, as a top-level navigation" | MUST (body); none (navigation) | Yes (edited) | Row put MUST on the navigation too. |
| 5 | Only from our browser | "The Personal Agent MUST post browser assertions only from a browser it controls, never from the User's own browser" | MUST | Yes | |
| 5 | Context per Session; cookies | Guides (#agent-browsing): "Use a separate browser storage context, with its own cookies and local storage, for each session. Never share one across users." | Guides | Yes (edited) | Host-only, HTTPS-only cookies are ours (N13). |
| 5 | Company domains only; no sign-in pages; limits | absent in the spec. Guides (#agent-direct-device): "Open the authorization URL in the user's own browser, not in a browser you automate." | Guides / ours | Yes (edited: marked our rules) | |
| 5 | Pages as text to the model | absent | ours | Yes (edited) | |
| 5 | Forms only on approval | absent (searched 5 for "form", "submit", "approve") | ours | Yes (edited: N43) | |
| 6 (#apis) | Skip unknown API types; DPoP/Bearer | "Personal Agents SHOULD skip API types they don't recognize" / "Every listed API MUST accept Session Tokens as described in 4.3: DPoP for OpenAPI, and Bearer for MCP." | SHOULD; MUST (Company) | Yes (edited: SHOULD) | |
| 6 | Handle the three errors | Error table: `invalid_token`, `sign_in_required`, `insufficient_scope` with "The Personal Agent gets a new one", "uses its Account Token … or signs in", "uses an eligible sign-in type" | none | Yes | |
| 6 | OpenAPI path templates | absent: "The protocol leaves each API's schema to that API." | ours (OpenAPI) | Yes (edited) | |
| 6 | Refused write keeps the code | absent | ours | Yes (edited) | |
| 7.1 (#conversation-protocols) | Skip unfamiliar protocols | "It skips unfamiliar types." | none | Yes | |
| 7.2 (#conversation-requests) | Company ids opaque | "Beyond these rules, the side that chooses an ID decides its format, and the other side MUST NOT depend on it." | MUST NOT | Yes (edited: MUST NOT) | |
| 7.2 | Message id format (new row) | "Conversation IDs, message IDs, and event IDs are strings of 1 to 256 characters from the URL-safe base64 alphabet … They SHOULD start with a short prefix for their kind, such as `cnv_`, `msg_`, or `evt_`." | none (format); SHOULD (prefix) | Added | Mock `message.id`. |
| 7.3 (#sending-messages) | Unique message id; retry same | "The Personal Agent chooses each message's `id`, and MUST make it unique for the User. To retry a message, it sends it again with the same ID." | MUST | Yes | |
| 7.3 | `wait` is a hint | 7.3: "holding the request for up to `wait` seconds"; 7.5: "It MAY return sooner, or cap `wait`." | MAY (Company) | Yes (moved after the other 7.3 row) | Ignoring `wait` entirely is our reading (N40). |
| 7.4 (#message-fields) | One of `text`/`data`/`context`; no JSON | "A message MUST have at least one of `text`, `data`, or `context`." / "Personal Agents and Company Agents SHOULD NOT put JSON or other markup in `text`." | MUST; SHOULD NOT | Yes (edited: SHOULD NOT) | We refuse JSON: stricter than the text, by choice. |
| 7.4 | Context fields; share only what's needed | "When a Personal Agent shares one of these facts, it MUST use the field and format defined here" / "Personal Agents SHOULD share only what the task needs." | MUST; SHOULD | Yes (edited: SHOULD) | |
| 7.5 (#reading-events) | Skip unknown event types | "Personal Agents MUST skip event types they don't recognize" | MUST | Yes | |
| 7.5 | Cursors; order; `has_more` | "Cursors are opaque, so the Personal Agent MUST NOT compare or sort them." / "handles events in order and saves the cursor after them" / "skips event IDs it has already handled" / "When `has_more` is `true`, the Personal Agent reads again right away." | MUST NOT; none | Yes | |
| 7.5 | `cursor_expired` | "The Personal Agent then reads from the beginning and SHOULD tell the User that part of the conversation is missing." | SHOULD | Yes (edited: SHOULD) | |
| 7.6 (#streaming) | `Last-Event-ID`; `text-delta`; comments | "The Personal Agent reconnects with `Last-Event-ID` set to the last event it handled, in place of `cursor`." / "It MUST NOT act on text from a `text-delta` event." | none; MUST NOT | Yes | Comments are SSE's; keep-alives are the Guides' (#company-conversations). |
| 7.7 (#status) | Track `status`, `responder`, `sender` | "Every successful response … MUST include `status` and `responder`." / "Each Company message MUST also include `sender`" | MUST (Company) | Yes | |
| 7.8 (#human-or-ai) | `sender` | "the Personal Agent MUST set each message's `sender`: `agent` when the Personal Agent wrote it, and `human` only when it carries the User's own words." | MUST | Yes | |
| 7.9 (#handoff) | Handoff `{}` after a summary | "The Personal Agent asks for a person at the Company with an empty JSON object" / Guides (#agent-conversations): "Before asking for a person, send a short message that sums up the problem" | none; Guides | Yes | |
| 7.10 (#direct-conversations) | Only with the User's agreement | "The Personal Agent asks the User. If they agree, it starts a Direct Conversation as above." / "Only the Personal Agent starts Direct Conversations, so the User decides when they're brought in." | none | Yes | |
| 7.10 | User's words as written | "The Personal Agent sends the User's messages as written, with `sender: \"human\"` (7.8)" | none (7.8 MUST) | Yes | Keeping the model's words out is our reading of S12. |
| 7.11 (#conversation-sign-in) | `authorization` events | "The Personal Agent responds as it would to that error, with its Account Token (4.8) or by signing in (4.4). It then continues the same conversation with the new token." | none | Yes | |
| 7.12 (#closing) | Close with `{}` | "The Personal Agent closes a conversation it's done with by sending an empty JSON object to its `close` URL." | none | Yes | Guides: "Close a conversation when the task is done". |
| 7.13 (#conversation-errors) | Every error code | Error table (six codes); 7.11: "gets `sign_in_required`" | none | Yes | |

### Operations extension v1

| § | Row (short) | Text, verbatim | Keyword in text | Row matches? | Note |
| --- | --- | --- | --- | --- | --- |
| 2 (#support) | List `operations` v1 | "A Personal Agent that supports operations lists the extension in its client metadata document (spec 4.1)" | none | Yes | |
| 4 (#proposing), 4.3 | Proposals from three channels; a message never confirms | "A message doesn't confirm an operation, whatever it says, even when it carries the User's own words. The Personal Agent confirms at the operations endpoint." | none | Yes | |
| 4.4 (#binding-web) | Website and endpoint are one operation | "If the website also lets the Session confirm or cancel it, that is the same operation … the Personal Agent's duties in 5.1 apply however it confirms." | none | Yes | |
| 5.1 (#approval) | Approval for the exact revision | "Before confirming, the Personal Agent MUST have the User's approval for the revision it confirms" | MUST | Yes | |
| 5.1 | Show name and `summary`; own interface | "The Personal Agent MUST show the User the Company's name and the revision's `summary`, and MUST take the User's answer through its own interface." | MUST | Yes | The verified domain is ours (N14). |
| 5.1 | Company text isn't approval | "It MUST NOT treat text from the Company, such as a conversation message, as the User's approval." | MUST NOT | Yes | |
| 5.1 | Standing permissions | "A standing permission MUST cover the Company, the account, the action, and every term of the revision, and still be in effect." / table: "Not allowed when `user_approval_required` is `true`." | MUST; none (table) | Yes (edited: "still be in effect") | |
| 5.2 (#confirm) | Confirm; handle errors | "The Personal Agent confirms with the revision the User approved and how it was approved" | none | Yes | |
| 6 (#tracking) | Same id; no new proposal | "If a confirm request fails or times out, the Personal Agent retries it or reads the operation, with the same operation ID. It MUST NOT ask for a new proposal of the same action until the operation is final." | MUST NOT | Yes (edited: scope) | The MUST NOT sits in the failed-confirm bullet (N34). |
| 6 | `result.summary` | "The Personal Agent presents it to the User as the Company's account of what happened." | none | Yes | |
| 7 (#cancelling) | Withdrawn approval | "If the User withdraws their approval before the Personal Agent has confirmed, the Personal Agent doesn't confirm. If it has already confirmed, it cancels." | none | Yes | |

### Mismatches

1. **4.4 `account_mismatch` → new Session (no keyword).** The text: "Once it has been, it can't switch to another: the Company returns `account_mismatch`, and the Personal Agent starts a new Session." 4.2's table: "Start a new Session (4.4)." There is no MUST. Commit `990286a` ("Poppy: test the last "not yet" rows of Appendix A…") rewrote the row to list three new tests and "Mock", under the appendix heading "Every MUST and MUST NOT…", and added `session.account-mismatch-reused` in `test/mock-company/core.ts` `signIn`: a Session that already got `account_mismatch` and asks again to sign in to another account records "Session … asked again to sign in to another account after account_mismatch (4.4: start a new Session)"; its catalog text reads "…instead of a new Session (4.4)". The check fires in strict and lenient profiles alike. It asks only for what the text describes, and retrying the same Session can only fail again, so a correct agent never trips it. Even so, it is a MUST-strength check without a MUST. Row edited to say "no keyword … the mock's check is our reading".
2. **5 `return_to` scope.** The row said "the Company's domain"; the text allows "`organization.domain` or one of its subdomains". Edited.
3. **5 top-level navigation.** The row put MUST on "as a top-level navigation"; only "in the request body, never in the URL" is a MUST. Edited.
4. **7.4 JSON in `text`.** The row read as a MUST; the text is "SHOULD NOT". We refuse JSON in `text`, and the mock records `message.json-in-text`, which is stricter than the text. Row edited; the mock's basis is under [Mock Company checks](#mock-company-checks).
5. **6, 7.4 (sharing), 7.5 (`cursor_expired`).** SHOULDs listed without the keyword under a "MUST and MUST NOT" heading. Edited to say SHOULD.
6. **3.1 domain.** Lower-case "must" where the text says MUST. Edited.
7. **Ops 6.** The row stated the MUST NOT without the scope the text gives it (a failed or timed-out confirm; N34). Edited.
8. **Rows that aren't in the text** (no fault, now marked): Session Tokens only to the Company's hosts (N10, already marked); the lost-code-exchange row (N45); device link hosts; S256 (example and Guides only); browser cookies host-only; browsing limits and sign-in pages; pages as text; forms only on approval (N43); OpenAPI path templates; a refused write's error code. The 7.3 `wait` row was out of order (after 7.5); moved.
9. **Appendix intro.** It promised only MUSTs, MUST NOTs and followed SHOULDs, yet most rows restate keyword-less behaviour. It now says the column uses a keyword only where the text does, and links `spec/grounding.md`.

No row cites a wrong section number.

### Missing rows

Every Personal Agent MUST and MUST NOT in spec.md and operations.md has a row, with these exceptions:

- **7.2 message id format** (1 to 256 base64url characters; `msg_` prefix SHOULD): no keyword on the format, but the mock checks it (`message.id`). Row added, "Checked by: Mock".
- **3.3 "Anyone else MUST start an extension's name with a domain they control".** Applies only to someone defining an extension; we define none (our client metadata lists only `operations`). Not applicable; no row.
- **4.8 "The Session MUST belong to the same `client_id` and User ID as the Account Token, and be signed out or signed in to the same account."** Passive, so it binds both sides; for the agent it means renewing only a Session of the Account Token's own User. Covered in practice by the 4.4 row and the mock's `account-token.other-client`, but there is no mock check that the Session's User ID matches the Account Token's. A gap: listed, no row added.
- **7.10 "The parent conversation MUST be open, belong to the same owner (7.2), and not be a Direct Conversation itself."** Passive; the Company enforces it with errors, and the 7.10 rows cover handling them. No separate row.
- **3.2 SHOULD cache the metadata.** Folded into the 3 caching row (edited).

### For the owner

**Resolved** on 12 October 2026 by [docs/conformance-levels.md](../docs/conformance-levels.md):

- `session.account-mismatch-reused` rests on a normative statement without a keyword (a Rule). Under RFC 8174 that is still normative, so it stays a violation in both profiles.
- `message.json-in-text` rests on a SHOULD NOT, so it is a warning: recorded, never a cell failure. Our own client is still held to it by the strict conformance tests.

The questions as asked:

- Should `session.account-mismatch-reused` stay a violation in both profiles, or move to the strict profile only, or become a recorded note, given that the text has no keyword? The behaviour is what the text describes, and our client follows it either way.
- `message.json-in-text` enforces a SHOULD NOT as a violation; same question.

## Mock Company checks

Every id in `test/mock-company/violations.ts` (144 ids; the brief said 143), with what it rests on in the Draft 0.1 snapshot (`spec.md`, `operations.md`) and the Guides. Basis, as the descriptions now say: **MUST** (the draft's MUST, MUST NOT or a required field), **RFC** (a requirement of a standard the draft names), **Rule** (stated as how the protocol works, no RFC 2119 keyword), **SHOULD**, **Guides** (a recommendation only), **Reading** (our answer to an open question, docs/readings.md).

Counts: Guides 16, Rule 47, RFC 19, MUST 51, Reading 10, SHOULD 1.

In the Profile column, "both" means the strict mock (conformance tests, `pda-mock-strict`) and the lenient reference (`pda-mock`, `strictAssertions: false`) both record it. In the Note column, "refuses" means the request fails as well as (or instead of) being recorded, and "records" means the request goes on.

| id | Basis | Text, verbatim (section) | Profile | Note |
| --- | --- | --- | --- | --- |
| `client-assertion.jti-missing` | Guides (Signing and verifying JWTs) | Guides #both-signing: "Make each `jti` at least 128 random bits." Spec 4.1 names no claims for the client assertion; RFC 7523 §3: jti MAY. | both | refuses (invalid_client) |
| `client-assertion.jti-weak` | Guides (Signing and verifying JWTs) | Guides #both-signing: "Make each `jti` at least 128 random bits." | both; pda-mock doesn't report it | records |
| `client-assertion.jti-reused` | Rule (4.2: the Company "rejects a reused jti"; RFC 7523 3 lets a server refuse replays) | 4.2 #starting-sessions: "The Company verifies both assertions … rejects a reused `jti`" (no keyword; "both" may mean the Session assertion and the client assertion) | both | refuses |
| `session-assertion.jti-missing` | Rule (4.2) | 4.2: "`jti` is a unique ID for the assertion, with at least 128 random bits. The Company rejects one it has already seen" | both | refuses |
| `session-assertion.jti-weak` | Rule (4.2) | 4.2: "with at least 128 random bits" | both | records |
| `session-assertion.jti-reused` | Rule (4.2) | 4.2: "The Company rejects one it has already seen, so a copied assertion can't be used again." | both | refuses |
| `dpop.jti-missing` | RFC (RFC 9449 4.2) | RFC 9449 §4.2 (jti required). 4.3: "`jti` is a unique ID for the proof." | both | refuses |
| `dpop.jti-weak` | Guides (Signing and verifying JWTs; RFC 9449 4.2 suggests 96 bits or more) | Guides #both-signing: "Make each `jti` at least 128 random bits." RFC 9449 §4.2 suggests at least 96 bits or a UUIDv4. | both; pda-mock doesn't report it | records; an RFC 9449-conforming 96-bit jti trips it |
| `dpop.jti-reused` | MUST (4.3) | 4.3 #sending-tokens: "On every request, it MUST check that: … It hasn't accepted the same `jti` within that window." | both | refuses |
| `browser-assertion.jti-missing` | Rule (5, jti as in 4.2) | 5 #web-browsing: "`iss`, `sub`, `iat`, and `jti` are as in 4.2." | both | refuses (page 400, no id recorded for the refusal itself) |
| `browser-assertion.jti-weak` | Rule (5, jti as in 4.2) | 5: "`iss`, `sub`, `iat`, and `jti` are as in 4.2" + 4.2: "with at least 128 random bits" | both | records |
| `browser-assertion.jti-reused` | MUST (5) | 5: "The Company MUST check that: … It hasn't accepted the same `jti` before." | both | refuses |
| `client-assertion.alg` | Guides (Signing and verifying JWTs; S19) | Guides #both-signing: "Support ES256 and RS256, and sign with ES256 when you can." (S19) | both | refuses: a Guides-only refusal |
| `client-assertion.embedded-key` | Guides (Signing and verifying JWTs, addressed to Companies: ignore such keys) | Guides #both-signing: "Ignore `jku`, `x5u`, and any key embedded in an assertion." (addressed to Companies; nothing forbids an agent sending one) | both; pda-mock doesn't report it | records |
| `client-assertion.typ` | Reading (S2) | absent: no `typ` for client or Session assertions anywhere (searched "typ" in spec 4.1, 4.2 and the Guides). S2. | strict only | refuses, strict only |
| `client-assertion.kid` | Reading (S2) | Guides #both-key-rotation: "Give every key a `kid`." Requiring the header `kid` to name a published key is S2. | strict only | refuses, strict only |
| `client-assertion.signature` | RFC (RFC 7523 3) | 4.1 #agent-identity: "authenticates at the token endpoint with a client assertion signed by a key from `jwks_uri` (`private_key_jwt`, RFC 7523)"; RFC 7523 §3: the JWT MUST be signed | both | refuses |
| `client-assertion.iat-exp-missing` | RFC (RFC 7523 3 for exp; iat is ours) | RFC 7523 §3: exp MUST; iat MAY. The spec names no claims for the client assertion. | both | refuses: iat required by us only |
| `client-assertion.lifetime` | Reading (S2; Guides: reject a long lifetime) | Guides #both-signing: "reject assertions that claim a long lifetime" (no number). 60 s / 300 s are S2. | both (60 s strict, 300 s lenient) | refuses; strict 60 s, lenient 300 s |
| `session-assertion.alg` | Guides (Signing and verifying JWTs; S19) | Guides #both-signing: "Support ES256 and RS256" (S19) | both | refuses: a Guides-only refusal |
| `session-assertion.embedded-key` | Guides (Signing and verifying JWTs, addressed to Companies: ignore such keys) | Guides #both-signing: "Ignore `jku`, `x5u`, and any key embedded in an assertion." | both; pda-mock doesn't report it | records |
| `session-assertion.typ` | Reading (S2) | absent (S2): 4.2 sets no header `typ`. | strict only | refuses, strict only |
| `session-assertion.kid` | Reading (S2) | Guides: "Give every key a `kid`." + S2 | strict only | refuses, strict only |
| `session-assertion.signature` | Rule (4.2; RFC 7523 3) | 4.2: "The assertion is a short-lived JWT signed with a key from its `jwks_uri`"; "The Company verifies both assertions against the Personal Agent's `jwks_uri`" | both | refuses |
| `session-assertion.iat-exp-missing` | Rule (4.2; RFC 7523 3 for exp) | 4.2: "`iat` and `exp` are when the assertion was issued and when it expires"; RFC 7523 §3: exp MUST | both | refuses |
| `session-assertion.lifetime` | Reading (S2; 4.2: "short-lived") | 4.2: "The assertion is short-lived: one minute in this example." (no number required; S2) | both (60 s strict, 300 s lenient) | refuses; strict 60 s, lenient 300 s |
| `client-assertion.missing` | Rule (4.1, 4.2, 4.6, 4.9) | 4.1: "authenticates at the token endpoint with a client assertion"; 4.2: "Like every token request, it also carries the Personal Agent's client assertion (4.1)"; 4.6, 4.9 "with its client assertion" | both | refuses |
| `client-assertion.not-jwt` | RFC (RFC 7523 3) | RFC 7523 §2.2, §3 | both | refuses |
| `client-assertion.wrong-typ` | Rule (5: a browser assertion isn't accepted at the token endpoint; N25 for DPoP proofs) | 5: "A Session assertion isn't accepted here, and a browser assertion isn't accepted at the token endpoint." DPoP proof as client assertion: N25. | both | refuses |
| `client-assertion.aud-array` | Reading (S1; 4.2 asks a single string only of the Session assertion) | absent for the client assertion (S1); 4.2 says "as a single string rather than an array" of the Session assertion only. RFC 7519 allows an array. | both | refuses: our reading |
| `client-assertion.aud` | RFC (RFC 7523 3; which value is S1) | RFC 7523 §3: the server "MUST reject any JWT that does not contain its own identity as the intended audience". Which value: S1 (absent in the spec). | both | refuses; lenient set by default, exact as a profile |
| `client-assertion.iss-sub` | RFC (RFC 7523 3, RFC 7521 5.2) | RFC 7523 §3 (sub MUST be the client_id for client authentication); RFC 7521 §5.2 | both | refuses |
| `session-assertion.missing` | RFC (RFC 7523 2.1) | 4.2: "requests a Session Token … with the JWT bearer grant (RFC 7523)"; RFC 7523 §2.1 assertion parameter | both | refuses |
| `session-assertion.not-jwt` | RFC (RFC 7523 2.1) | RFC 7523 §2.1 | both | refuses |
| `session-assertion.browser-typ` | Rule (5) | 5: "a browser assertion isn't accepted at the token endpoint" | both | refuses |
| `session-assertion.aud` | Rule (4.2) | 4.2: "`aud` is the Company's `token_endpoint`, as a single string rather than an array" | both | refuses |
| `session-assertion.iss` | Rule (4.2) | 4.2: "`iss` is the Personal Agent's `client_id` (4.1)."; "checks that the assertion's `iss` is the authenticated `client_id`" | both | refuses |
| `session-assertion.sub` | Rule (4.2; RFC 7523 3) | 4.2: "`sub` is the User ID for this Company" | both | refuses |
| `user-id.personal` | MUST NOT (4.2) | 4.2: "It MUST NOT contain or be derived from personal information, such as an email address, phone number, or name, even with a keyed hash." | both | records |
| `client-metadata.not-url` | MUST (4.1) | 4.1: "A Personal Agent's `client_id` MUST be an HTTPS URL that returns its metadata document." | both | refuses |
| `client-metadata.not-https` | MUST (4.1) | 4.1: "`client_id` MUST be an HTTPS URL" | both | refuses |
| `client-metadata.fetch-status` | MUST (4.1; Guides: fetch it without following redirects) | 4.1: "MUST be an HTTPS URL that returns its metadata document"; Guides #company-agents: "Fetch the `client_id` URL without following redirects." | both | refuses; redirect refusal is Guides |
| `client-metadata.not-json` | MUST (4.1) | 4.1: "returns its metadata document" | both | refuses |
| `client-metadata.client-id-mismatch` | MUST (4.1) | 4.1: "`client_id` MUST equal the URL the document was fetched from." | both | refuses |
| `client-metadata.jwks-uri` | MUST (4.1; "same domain" read as the same host) | 4.1: "`jwks_uri` and every entry in `redirect_uris` MUST be HTTPS URLs on the same domain as `client_id`." Same host = S6. | both | refuses |
| `client-metadata.redirect-uris` | MUST (4.1; "same domain" read as the same host) | 4.1 (same sentence) | both | refuses |
| `client-metadata.auth-method` | Rule (4.1) | 4.1: "(`private_key_jwt`, RFC 7523)" and the example's `"token_endpoint_auth_method": "private_key_jwt"` | both | records |
| `client-metadata.jwks-status` | Rule (4.1) | 4.1: "Companies fetch it … to get the keys it signs with" | both | refuses |
| `client-metadata.jwks-empty` | Rule (4.1) | 4.1 (as above) | both | refuses |
| `client-metadata.jwks-private` | Rule (4.1: "The key set contains only public keys") | 4.1: "The key set contains only public keys." (no keyword) | both | refuses |
| `client-metadata.key-without-kid` | Guides (Rotating keys) | Guides #both-key-rotation: "Give every key a `kid`." | both; pda-mock doesn't report it | records |
| `dpop.missing` | MUST (4.3) | 4.3: "API calls and conversations MUST carry the Session Token in the `Authorization` header with the `DPoP` scheme, together with a DPoP Proof" | both | refuses |
| `dpop.multiple` | RFC (RFC 9449 4.3) | RFC 9449 §4.3 (check 1: not more than one DPoP header) | both | refuses |
| `dpop.not-jwt` | RFC (RFC 9449 4.2) | RFC 9449 §4.2 | both | refuses |
| `dpop.typ` | RFC (RFC 9449 4.2) | RFC 9449 §4.2; 4.3's example `"typ": "dpop+jwt"`; Guides #company-dpop: "Check that `typ` is `dpop+jwt`" | both | refuses |
| `dpop.alg` | Guides (Signing and verifying JWTs; S19) | Guides #both-signing (ES256, RS256); RFC 9449 §4.3 lets a server refuse algorithms by local policy | both | refuses: a Guides-only refusal |
| `dpop.no-jwk` | RFC (RFC 9449 4.2) | RFC 9449 §4.2; 4.3: "A proof is a JWT with the public key in its header" | both | refuses |
| `dpop.private-jwk` | RFC (RFC 9449 4.2) | RFC 9449 §4.2 (MUST NOT contain a private key); Guides #company-dpop | both | refuses |
| `dpop.signature` | MUST (4.3) | 4.3: "The proof's signature verifies with the key in its header." | both | refuses |
| `dpop.htm` | MUST (4.3) | 4.3: "`htm` and `htu` match the request." | both | refuses |
| `dpop.htu` | MUST (4.3) | 4.3: "`htm` and `htu` match the request."; "without the query or fragment" | both | refuses |
| `dpop.iat` | MUST (4.3) | 4.3: "`iat` is within the Company's acceptance window, such as one minute." | both | refuses |
| `dpop.ath-at-token-endpoint` | Rule (4.3) | 4.3: "Proofs sent to the token endpoint don't have one." | both | refuses |
| `dpop.ath` | MUST (4.3) | 4.3: "`ath` matches the Session Token." | both | refuses |
| `dpop.nonce-ignored` | Guides (DPoP keys and proofs: keep the nonce for that server; 4.3 only says MUST support nonces; S23) | 4.3: "Personal Agents MUST support nonces."; Guides #agent-dpop: "take the nonce from the `DPoP-Nonce` header, keep it for that server, and retry once" | both | records, then use_dpop_nonce (only with requireNonce) |
| `dpop.key-mismatch` | MUST (4.3) | 4.3: "That key is the one the Session Token is bound to." | both | refuses |
| `dpop.key-shared` | Rule (4.3: a key pair for each User at each Company; N35) | 4.3: "The Personal Agent generates a key pair for each User at each Company, and MAY use a new one for each Session." (no keyword; N35) | both | records |
| `resource.no-token` | MUST (4.3) | 4.3: "Personal Agents MUST send a Session Token on every API and conversation request" | both | refuses |
| `resource.bearer-scheme` | MUST (4.3, 6) | 4.3: "Companies MUST accept Bearer Session Tokens only on their MCP APIs (section 6), and MUST require DPoP everywhere else." | both | refuses |
| `resource.bearer-token-as-dpop` | MUST (4.3) | 4.3 (same sentence); a Bearer token has no key to prove | both | refuses |
| `resource.stale-token` | MUST (4.3) | 4.3: "Whenever the Personal Agent gets a new Session Token for a Session, it MUST use the new token from then on." | both | records |
| `mcp.not-bearer` | MUST (4.3, 6) | 6: "Every listed API MUST accept Session Tokens as described in 4.3: DPoP for OpenAPI, and Bearer for MCP." | both | refuses |
| `mcp.wrong-token` | MUST (4.3, 6) | 6: "It MUST accept only tokens issued for its `url` (4.3)."; 4.3: "MUST include `resource` set to the MCP server's `url`" | both | refuses |
| `mcp.accept` | RFC (MCP 2025-06-18 Streamable HTTP, which spec 6 names) | MCP 2025-06-18 Streamable HTTP (client MUST Accept both); spec 6 names that version | both | records |
| `rate-limit.retry-after-ignored` | MUST (4.3) | 4.3: "The Personal Agent MUST wait at least that long before sending the request again." Only the same request (method and URL) counts. | both | refuses (429) |
| `rate-limit.shared-limit-ignored` | Guides (Rate limits) | Guides #both-rate-limits: "keep track of limits for each company and share them across your tasks and users, rather than letting each task find the limit on its own." 4.3's MUST names only "the request". | both | refuses (429: the Company's limit still holds) |
| `secret.password` | MUST NOT (4.7) | 4.7: "Personal Agents MUST NOT send credentials to any endpoint other than the Company's `auth.mediated.endpoint`."; "`secret` marks a value the Personal Agent MUST protect" | both | records |
| `secret.one-time-code` | Guides (Handling secrets; 4.7: submit only the code) | Guides #both-secrets: "These are secrets: … one-time sign-in codes"; 4.7: "submits only the code" | both | records |
| `secret.account-token` | MUST (4.8) | 4.8: "MUST NOT put them in model context, conversation messages, logs, or URLs"; "Companies MUST accept an Account Token only at their `token_endpoint` and `revocation_endpoint`" | both | records |
| `secret.token-in-url` | MUST NOT (4.3) | 4.3: "Personal Agents MUST NOT send tokens in a URL, and Companies MUST NOT accept them from one." | both | refuses |
| `form.not-form` | RFC (RFC 6749 4.1.3, RFC 7009 2.1, RFC 8628 3.1) | RFC 6749 §4.1.3, RFC 7009 §2.1, RFC 8628 §3.1 (form encoding stated as the format); every spec example uses it | both | refuses |
| `token.no-dpop` | Rule (4.2, 4.3) | 4.2: "Like every token request, it also carries … a DPoP Proof (4.3)"; 4.3: "signs a new proof for every request, including token requests" | both | refuses |
| `token.mcp-dpop` | Rule (4.3) | 4.3: "For MCP, the Personal Agent requests a Session Token without a proof, and the Company issues a `Bearer` token." | both | records |
| `token.signed-in-renewed-with-assertion` | Rule (4.2; S5) | 4.2: "A signed-in Session is renewed with the Account Token instead (4.8)." (S5: no error defined) | both | records, issues a signed-out token |
| `account-token.other-client` | MUST (4.8) | 4.8: "Companies MUST accept an Account Token … only from the `client_id` it was issued to" | both | refuses |
| `account-token.rotated-reused` | MUST (4.8) | 4.8: "A Company MAY return a new Account Token in `refresh_token`. The Personal Agent then MUST use the new one from then on." | both | refuses |
| `session.account-mismatch-reused` | Rule (4.4: "the Personal Agent starts a new Session", no keyword) | 4.4 #sign-in: "Once it has been, it can't switch to another: the Company returns `account_mismatch`, and the Personal Agent starts a new Session." 4.2's table: "Start a new Session (4.4)." No RFC 2119 keyword. | both | refuses (account_mismatch again) |
| `signin.no-scope` | MUST (4.4) | 4.4: "Each sign-in request MUST include `scope` as a space-separated string" | both | refuses (invalid_scope) |
| `authorize.redirect-uri` | MUST (4.5) | 4.5: "`redirect_uri` MUST exactly match an entry in the Personal Agent's `redirect_uris` (4.1)." | both | refuses |
| `authorize.no-state` | Rule (4.5; RFC 6749 recommends state) | 4.5: "The Personal Agent creates a random `state` and a PKCE code verifier"; RFC 6749 §4.1.1 state RECOMMENDED | both | refuses |
| `authorize.no-pkce` | Rule (4.5; RFC 7636 4.2 for S256) | 4.5: "Direct Sign-In is the OAuth 2.0 authorization code flow with PKCE"; example `code_challenge_method=S256`; RFC 7636 §4.2 (S256 MUST if capable); Guides #agent-direct-device | both | refuses |
| `authorize.secret-in-url` | MUST NOT (4.3 for tokens; Guides for assertions) | 4.3: "Personal Agents MUST NOT send tokens in a URL"; assertions: Guides #both-secrets | both | records |
| `code.reused` | RFC (RFC 6749 4.1.2) | RFC 6749 §4.1.2: "The client MUST NOT use the authorization code more than once." | both | refuses |
| `code.redirect-uri` | RFC (RFC 6749 4.1.3) | RFC 6749 §4.1.3: redirect_uri values "MUST be identical" | both | refuses |
| `code.pkce` | RFC (RFC 7636 4.5, 4.6) | RFC 7636 §4.5, §4.6 | both | refuses |
| `code.no-session-id` | Rule (4.5) | 4.5: "It adds one thing: the Personal Agent sends `session_id` when it exchanges the code" | both | refuses |
| `device.polled-after-final` | Rule (4.6) | 4.6: "The Personal Agent stops asking after either." (access_denied, expired_token); after success: no text | both | refuses |
| `device.polled-after-expiry` | Rule (4.6) | 4.6: "The Personal Agent stops asking after either." | both | refuses |
| `device.too-fast` | RFC (RFC 8628 3.5) | RFC 8628 §3.5: on slow_down "the interval MUST be increased by 5 seconds for this and all subsequent requests"; Guides #agent-direct-device | both | refuses (slow_down) |
| `device.no-session-id` | Rule (4.6) | 4.6: the polling request's example carries `session_id`; 4.4: "a signed-in Session Token for the current Session" (example only) | both | refuses |
| `mediated.missing-field` | Rule (4.7) | 4.7: "The Personal Agent sends every field in `credentials` to `auth.mediated.endpoint`" | both | records |
| `mediated.credentials-with-code` | Rule (4.7) | 4.7: "submits only the code, not the credentials again" | both | records |
| `mediated.code-other-session` | Rule (4.7) | 4.7: "with a Session Token for the same Session"; "Only the Session that started a sign-in can finish it." | both | records, then 404 |
| `browser-assertion.in-url` | MUST (5) | 5: "The assertion MUST go in the request body, never in the URL." | both | refuses |
| `browser-assertion.not-post` | Rule (5) | 5: "send the assertion to the endpoint as a form POST, as a top-level navigation" | both | refuses |
| `browser-assertion.content-type` | Rule (5) | 5 (same); example `Content-Type: application/x-www-form-urlencoded` | both | refuses |
| `browser-assertion.missing` | Rule (5) | 5 (as above) | both | refuses |
| `browser-assertion.not-jwt` | Rule (5) | 5: "It is a JWT signed with a key from the Personal Agent's `jwks_uri`" | both | refuses |
| `browser-assertion.typ` | MUST (5) | 5: "The Company MUST check that: The signature verifies with a key from the `iss` client's `jwks_uri`, and `typ` is `poppy-browser+jwt`." | both | refuses |
| `browser-assertion.alg` | Guides (Signing and verifying JWTs; S19) | Guides #both-signing (ES256, RS256) | both | refuses: a Guides-only refusal |
| `browser-assertion.embedded-key` | Guides (Signing and verifying JWTs, addressed to Companies: ignore such keys) | Guides #both-signing: "Ignore `jku`, `x5u`, and any key embedded in an assertion." | both; pda-mock doesn't report it | records |
| `browser-assertion.kid` | Reading (S2) | Guides: "Give every key a `kid`." + S2 | strict only | refuses, strict only |
| `browser-assertion.iat-exp-missing` | MUST (5) | 5: "`aud` is its endpoint, the assertion hasn't expired, and `exp` is no more than 60 seconds after `iat`." (Company MUST check) | both | refuses |
| `browser-assertion.iat-future` | Guides (Signing and verifying JWTs: a small clock skew) | Guides #both-signing: "Check `aud`, `exp`, and `iat`. Allow a small clock skew, such as 30 seconds" | both | refuses: a Guides-only refusal |
| `browser-assertion.no-iss` | MUST (5) | 5: "The signature verifies with a key from the `iss` client's `jwks_uri`" | both | refuses |
| `browser-assertion.unknown-agent` | MUST (5) | 5 (same check) | both | refuses |
| `browser-assertion.signature` | MUST (5) | 5 (same check) | both | refuses |
| `browser-assertion.aud` | MUST (5) | 5: "`aud` is its endpoint" | both | refuses |
| `browser-assertion.lifetime` | MUST (5) | 5: "`exp` is no more than 60 seconds after `iat`" | both | refuses |
| `browser-assertion.session` | MUST (5) | 5: "The Session is active and belongs to the same `client_id` and User." | both | refuses |
| `browser-assertion.return-to-not-url` | MUST (5) | 5: "`return_to` … MUST be an HTTPS URL on the Company's `organization.domain` or one of its subdomains." | both | refuses |
| `browser-assertion.return-to-off-domain` | MUST (5) | 5 (same); "`return_to` is on its own domain." | both | refuses |
| `idempotency.key-reused` | Guides (Retries) | Guides #both-retries: "reuse the same key when you retry the same request"; Companies "reject a repeated key with a different body" | both | refuses (409) |
| `exchange.performed-twice` | Guides (Retries; Ops 1 and 6: at most once) | Guides #both-retries (Idempotency-Key); Ops 1: "Retrying after a timeout never performs the action twice."; Ops 6: "The Company MUST perform each operation at most once" (a Company MUST; the agent-side duty is Guides or Ops 6's MUST NOT, see proposal.while-open) | both | records (harm oracle) |
| `message.missing` | Rule (7.3) | 7.3: the request body `{ "message": … }` | both | refuses |
| `message.id` | MUST (7.4: required; 7.2: 1 to 256 base64url characters) | 7.4: `id` Req. Yes; 7.2: "strings of 1 to 256 characters from the URL-safe base64 alphabet" (no keyword) | both | refuses |
| `message.sender` | MUST (7.4, 7.8) | 7.4: `sender` Req. Yes; 7.8: "the Personal Agent MUST set each message's `sender`" | both | refuses |
| `message.empty` | MUST (7.4) | 7.4: "A message MUST have at least one of `text`, `data`, or `context`." | both | refuses |
| `message.text-type` | Rule (7.4) | 7.4: "`text` … The message in natural language." | both | refuses |
| `message.json-in-text` | SHOULD NOT (7.4) | 7.4: "Personal Agents and Company Agents SHOULD NOT put JSON or other markup in `text`." | both; pda-mock doesn't report it | records |
| `message.data-type` | Rule (7.4) | 7.4: "`data` … A JSON object" | both | refuses |
| `message.context-type` | Rule (7.4) | 7.4: `context` "Facts about the User's situation"; examples are objects | both | refuses |
| `message.id-reused` | MUST (7.3: unique for the User) | 7.3: "The Personal Agent chooses each message's `id`, and MUST make it unique for the User."; "If the content is different, the Company returns `message_id_conflict`." | both | refuses (409) |
| `context.locale` | MUST (7.4) | 7.4: "When a Personal Agent shares one of these facts, it MUST use the field and format defined here: `locale` is a language tag such as `en-US` (RFC 5646)" | both | records |
| `context.time-zone` | MUST (7.4) | 7.4 (same MUST): "`time_zone` is an IANA time zone name" | both | records |
| `context.user-available` | MUST (7.4) | 7.4 (same MUST): "`user_available` is `true` if the User can answer questions right now" | both | records |
| `direct.agent-words` | Reading (S12; 7.10: the User's messages, as written, as human) | 7.10: "The Personal Agent sends the User's messages as written, with `sender: \"human\"` (7.8)"; whether `agent` messages may go there is S12 | both | records |
| `direct.agent-words-later` | Reading (S12; 7.10) | 7.10 (same); S12 | both | records |
| `conversation.cross-user` | Rule (7.2: a conversation belongs to the User that started it; 7.13; S17) | 7.2: "A conversation belongs to the Personal Agent's `client_id` and the User ID that started it. … The Company MUST reject requests from any other `client_id`, User, or account." (a Company MUST; the agent side has no keyword); 7.13; S17 | both | refuses (404) |
| `handoff.body` | Rule (7.9) | 7.9: "The Personal Agent asks for a person at the Company with an empty JSON object" | both | records |
| `close.body` | Rule (7.12) | 7.12: "by sending an empty JSON object to its `close` URL" | both | records |
| `confirm.approved-by` | Rule (Ops 5.1, 5.2) | Ops 5.2: "The Personal Agent confirms with the revision the User approved and how it was approved"; 5.1's two `approved_by` values | both | refuses (400) |
| `confirm.revision` | Rule (Ops 5.1, 5.2) | Ops 5.2 (same); 5.1: "An approval covers one revision." | both | refuses (400) |
| `proposal.while-open` | MUST NOT (Ops 6; recorded only after a confirm, N34) | Ops 6: "If a confirm request fails or times out, the Personal Agent retries it or reads the operation … It MUST NOT ask for a new proposal of the same action until the operation is final." (scope: N34) | both | records, returns the open operation |
| `confirm.standing-permission-overrides-user` | Rule (Ops 3, 5.1: "Not allowed when user_approval_required is true") | Ops 5.1: "`standing_permission` … Not allowed when `user_approval_required` is `true`." (no keyword; the Company returns `user_approval_required`) | both | refuses (403) |

### Mismatches

The old catalog claimed, in its header and in the CLAUDE.md wording, that every check is a protocol MUST. 77 of 144 rest on less than the draft's or an RFC's MUST:

- **No keyword ("Rule"), 47.** The draft states these as how the protocol works, without RFC 2119 words. Most are uncontroversial wire facts (the code exchange carries `session_id`, handoff and close bodies are `{}`, a browser join is a form POST). They are requirements of the protocol, so both profiles keep them, but none is a MUST. The one a recent change treated as a MUST:
  - `session.account-mismatch-reused`: 4.4 says "the Company returns `account_mismatch`, and the Personal Agent starts a new Session", with no keyword. Description and recorded detail now say "no RFC 2119 keyword" (detail was "(4.4: start a new Session)", read as an instruction).
- **Guides only, 16.** `client-assertion.jti-missing`, `client-assertion.jti-weak`, `dpop.jti-weak`, the three `.alg`, the three `.embedded-key`, `client-metadata.key-without-kid`, `dpop.nonce-ignored`, `secret.one-time-code`, `browser-assertion.iat-future`, `idempotency.key-reused`, `exchange.performed-twice`. Group comment "APIs (6)" over the last two was wrong: neither is in spec 6.
- **SHOULD, 1.** `message.json-in-text` (7.4 SHOULD NOT).
- **Readings, 10.** S2 (`.typ` ×2, `.kid` ×3, both `.lifetime`), S1 (`client-assertion.aud-array`), S12 (`direct.agent-words`, `direct.agent-words-later`). Also partly readings, though their base is a MUST or Rule: S6 in `client-metadata.jwks-uri`/`.redirect-uris` (same host), S1 in `client-assertion.aud` (which value), S5 in `token.signed-in-renewed-with-assertion`, S17 in `conversation.cross-user`, N34 in `proposal.while-open` (recorded only after a confirm), N35 in `dpop.key-shared`.
- **Weaker than an RFC says it.** `dpop.jti-weak` asks 128 bits (Guides); RFC 9449 §4.2 suggests at least 96. An RFC-conforming agent with 96-bit jtis is recorded.
- **Section citations corrected.** `conversation.cross-user` cited 7.13 (the error) for the ownership rule, which is 7.2 (the comment in conversations.ts too). core.ts's "Sign-out takes effect right away (4.9)" is a 4.9 SHOULD; now says so. Every other group and per-id section citation matched the snapshot.

### What changed

- `test/mock-company/violations.ts`: every description now starts with its basis and section (`MUST (4.3): …`, `Rule (4.5): …`, `Guides (Retries): …`, `Reading (S2), strict Company only: …`); the header explains the convention and the profiles; new `Basis`, `basisOf(id)` and `STRICT_ONLY`; group comments for writes and Operations fixed. No id renamed or removed.
- `test/mock-company/core.ts`, `conversations.ts`: the citations above; `session.account-mismatch-reused`'s detail says there's no keyword.
- `test/mock-company/index.ts`: exports `basisOf`, `STRICT_ONLY`, `Basis`.
- Profile handling, interop only: `interop/impls/shared/mock-hooks.ts` `violationsBody(state, profile)` adds each violation's `basis` and, for `"lenient"`, leaves out `STRICT_ONLY`; `interop/impls/pda-mock/adapter.ts` passes its `PROFILE` (and its doc comment says so). The Hypothesis launcher keeps the default (strict: everything). `STRICT_ONLY` is the seven record-only checks whose sole basis is a SHOULD or a Guides recommendation and which give no one more access: `client-assertion.jti-weak`, `dpop.jti-weak`, the three `.embedded-key`, `client-metadata.key-without-kid`, `message.json-in-text`. Before, the lenient reference failed a grid cell for any of them (cli.ts makes every reported violation an error).
- Tests: `test/mock-company.test.ts` "says what each check rests on, and leaves out of the lenient profile only SHOULDs and Guides" (every description parses; `STRICT_ONLY` ⊆ SHOULD/Guides; S2 ids say "strict Company only"); the account-mismatch row's detail regex. `interop/test/mock-hooks.test.ts`: `basis` in the body, a lenient-filter test, and the source check accepts `violationsBody(await mock.state(), PROFILE)`.
- Typecheck clean; Workers suite 657 passed (1 skipped); interop suite 110 passed.
- `interop/vectors/` has only the Datalayer runner and there's no `interop:vectors` script in package.json, so nothing to regenerate.

### For the owner

**Resolved** on 12 October 2026 by [docs/conformance-levels.md](../docs/conformance-levels.md). The basis now sets the level, and `STRICT_ONLY` is gone:

- **Violations.** 117 checks rest on MUST, RFC or Rule.
- **Warnings.** 17 checks rest on SHOULD or the Guides.
- **Tentative.** 10 checks rest on our readings. They are recorded as warnings.
- **Refusals stay.** The Guides-only refusals and the readings that refuse in both profiles keep refusing, because that is the mock's own protection. Their records are warnings, and in the grid a failure they cause is blamed at warning level (rule `warning`, or the spec for a reading), never as a violation.
- **The runner** now derives each Company-recorded check's severity from its `basis`.
- **The ids stay as they are.**

The questions as asked:

- **Guides-only refusals in both profiles.** These refuse the request, not just record it, so the lenient filter can't help: `client-assertion.jti-missing` (RFC 7523 makes jti optional; OIDC Core 9's private_key_jwt requires it), `client-assertion.alg`, `session-assertion.alg`, `dpop.alg`, `browser-assertion.alg` (ES256/RS256 only; an ES384 agent is conforming), `browser-assertion.iat-future`, and `client-assertion.iat-exp-missing`'s `iat` half (RFC 7523 requires only `exp`). Decide whether the lenient profile should accept them.
- **Readings that refuse in both profiles.** `client-assertion.aud-array` (RFC 7519 allows an array; the single-string rule is 4.2's, for the Session assertion), and the S2 lenient 300 s cap (`.lifetime`), which readings.md declares. Fine as declared readings; listed so they're a choice, not an accident.
- **Kept in both profiles though Guides-only, as security-relevant** (readings.md's rule): `exchange.performed-twice` (a harm oracle), `idempotency.key-reused`, `secret.one-time-code`, `dpop.nonce-ignored` (only with `requireNonce`). Say if any should join `STRICT_ONLY`.
- **cli.ts (outside that pass).** It turns every reported Company violation into an error. Now that `/violations` carries `basis`, it could make SHOULD/Guides/Reading ones warnings (as §8 does for S2) instead of the adapter leaving them out.
- **readings.md**: its "Lenient mock" row now says it also doesn't report `STRICT_ONLY` in the grid (done).
- **CLAUDE.md** said "where the protocol has a MUST, a mock check with an id"; 47 checks rest on no-keyword rules, 16 on the Guides. Now "where the protocol states a requirement", with the basis convention (done).
- **No ids to delete.** Candidates if you want the catalog to be MUST-only: the 7 in `STRICT_ONLY`; we'd keep them as strict-profile checks.

## Code citations

Swept `src/poppy/`, `src/validator/`, `scripts/poppy-validate.ts`, `interop/runner/` (not `cli.ts`, `docker.ts`), `interop/scenarios/`, `interop/impls/pda-agent/`, `interop/impls/pda-mock/` and `interop/vectors/datalayer/` against the snapshot (Draft 0.1, Operations v1, Guides, all "Updated Oct 9, 2026" when swept; their text is the same in the 12 October update). About 160 comments or messages cite a Poppy section, Ops section, the Guides, or an RFC as the spec's requirement; the interop runner's "spec section N" / "spec §N" citations (about 25) refer to `docs/interop-spec.md` and all point at the right section. Only the wrong or questionable ones are listed; every other citation names the right section and the code does what the text says.

| File:line | Cites | Correct? | Behaviour matches text? | Note |
| --- | --- | --- | --- | --- |
| src/poppy/client.ts:310 | "spec 3, step 4" | No: section 3 has no steps | Yes | Now "spec 3 and 3.2: SHOULD cache by HTTP caching headers; the bounds are the Guides'". Fixed. |
| src/poppy/client.ts:545 | "must never be renewed with the Session assertion (4.2)" | Overstated: 4.2 says "A signed-in Session is renewed with the Account Token instead (4.8)", no keyword | Yes | Reworded as our practice, citing 4.2 and S5. Fixed. |
| src/poppy/signin.ts:307 | "the assertion mustn't be used for a signed-in Session (4.2)" | Overstated, as above | Yes | Reworded, citing 4.2 and S5. Fixed. |
| src/poppy/client.ts:1017 | `invalid_session` from a resource "(spec 6)" | No: section 6 lists only `invalid_token`, `sign_in_required`, `insufficient_scope` | Yes (our reading) | Now cites spec-issues S13, N39. Fixed. |
| src/poppy/browser.ts:19 | "a 429 or 503 must be waited out (spec 4.3)" | Half: 4.3's MUST is for 429 only; 503 is the Guides ("Wait at least as long as `Retry-After` says on a 429 (MUST, 4.3) or a 503") | Yes | Split the two. Fixed. |
| src/poppy/jwt.ts:23 | "short-lived: one minute (spec 4.2; Guides)" | Loose: 4.2 says "one minute in this example"; the Guides give no number; only 5 caps browser assertions at 60 s | Yes | Reworded with S2. Fixed. |
| src/poppy/signin.ts:8 | "Guides: keep device flows short" | Loose: the Guides tell Companies "Keep `expires_in` short, such as 10 minutes" | Yes | Reworded. Fixed. |
| src/validator/validate.ts:14, src/poppy/discovery.ts:108, src/validator/html.ts:98, :179 | "invalid: the documents break a MUST"; "An error breaks a MUST in the specification" | No: several errors rest on the Guides or our reading (below) | n/a | Reworded to say an error is what our client refuses, mostly a MUST, otherwise a limit or reading the message names. Fixed. |
| interop/runner/checks.ts:217 and its catalog row | `token.unlisted-host` "(spec 4.3)" | No: 4.3 and 6 don't say which hosts may receive Session Tokens (N10, our reading) | n/a | Comment and `what` now say "our reading, N10". Severity stays `error`: for the owner. |
| interop/runner/checks.ts `redirect.credentials-followed` | "(Guides)" | Yes, but severity `error` against a header saying "a MUST broken is an error" | n/a | `what` now says "(Guides, not a MUST)"; header lists both exceptions. Severity: for the owner. |
| interop/scenarios/YS.json | `requirements: ["6", "N17"]` | No: N17 is a spec issue, not a section, and the attack (a DPoP token presented as Bearer outside MCP) breaks 4.3: "Companies MUST accept Bearer Session Tokens only on their MCP APIs … and MUST require DPoP everywhere else" | n/a | Now `["4.3", "6"]` (the report prints these as "Spec …"). `docs/adversarial-interop.md:149` mapped YS to "4.4, 6, N17"; it now says "4.3, 6, N17" (below). |
| interop/impls/pda-agent/attacks.ts:137 | aud confusion "(4.1; client-assertion.aud)" | Loose: 4.1 says nothing about a client assertion's `aud` (S1) | Yes: another Company's `aud` fails under every reading | Left; RFC 7523 §3 is the real basis. |
| interop/impls/pda-agent/attacks.ts:156, scenario YK | rotated Account Token reused "(4.8)" | Loose: 4.8 binds the agent ("MUST use the new one"); nothing says the Company rejects the old one (N5) | n/a | Left; the harm oracle rests on the OAuth security BCP, not the draft. For the owner. |
| interop/runner/har.ts:20, :38 | fault-injection proxy "(spec §6)" | Partly: interop-spec §3 defines fault injection, §6 the `faults` field | n/a | Left. |

## Validator

Basis key: **MUST** (keyword in the draft or Ops), **Req.** (a required field or a "Required" endpoint), **def.** (definitional text without a keyword), **RFC** (an RFC the draft builds on, quoted rule), **SHOULD**, **Guides** (a recommendation), **ours** (no text; our reading or a spec issue).

| Message id | Rule | Basis | Severity | Matches? |
| --- | --- | --- | --- | --- |
| http-not-https | Fetch documents over HTTPS | MUST: "A Company MUST publish its `poppy.json` document at `https://{domain}/.well-known/poppy.json` over HTTPS" (3); "`client_id` MUST be an HTTPS URL" and "`jwks_uri` … MUST be HTTPS URLs" (4.1); issuer "an HTTPS URL" (3.1) | error | Yes |
| http-non-public-host | Never fetch loopback/private/link-local/single-label hosts | Guides: "Reject loopback, private, and link-local addresses unless you've configured them on purpose" (Fetching metadata safely) | error | Stronger than text; explain now says so |
| http-redirect-not-https | Every redirect HTTPS | MUST: "every redirect MUST be to an HTTPS URL" (3) | error | Yes |
| http-too-many-redirects | At most 3 redirects | Guides: "a few redirects at most"; 3 says "Personal Agents MUST follow redirects", no limit | error | Stronger than text; explain now says so |
| http-redirect-not-allowed | No redirect at a `client_id` URL | Guides: "Fetch the `client_id` URL without following redirects"; MUST: "`client_id` MUST equal the URL the document was fetched from" (4.1); S6 | error | Partly (Guides + MUST); explain now says so |
| http-status | 200 | MUST publish (3) | error | Yes |
| http-failed | Reachable within 5 s | Guides: "a timeout of a few seconds" | error (indeterminate) | Yes: makes the report indeterminate, not invalid |
| http-too-large | ≤ 100 KB | Guides: "a response size such as 100 KB" | error | Stronger than text; explain now says so |
| http-content-type | `application/json` | RFC 8259 §11 (media type); the draft says nothing | warning | Yes |
| http-no-cache-headers | Caching headers | SHOULD: "Personal Agents SHOULD cache the document according to its HTTP caching headers" (3, 3.2) | info | Yes |
| http-cache-bounded | 60 s to 1 day | Guides: "at least a minute and at most a day" | info | Yes |
| not-utf8 | UTF-8 | RFC 8259 §8.1: "MUST be encoded using UTF-8"; Guides: "Encode JSON as UTF-8" | error | Yes; ref changed from the Guides to RFC 8259 §8.1 |
| json-bom | No BOM | RFC 8259 §8.1: "Implementations MUST NOT add a byte order mark" (receivers MAY ignore one) | warning | Yes |
| json-syntax | Well-formed JSON | RFC 8259 | error | Yes |
| json-duplicate-member | No duplicate names | Guides: "reject objects with duplicate member names"; RFC 8259 §4: names SHOULD be unique | error | Stronger than text (our client refuses them); explain now says so |
| missing-member | Required members | Req.: `protocol_version`, `organization` "Yes" (3.1); `auth` required "If `agent`, `apis`, or `web.browser_session_endpoint` is present"; `token_endpoint`, `revocation_endpoint` "Required", `authorization_endpoint`/`device_authorization_endpoint` "Required if …" (3.2); def. for `issuer`, `scopes`, `endpoint`, `fields`, `name`/`label`, `type`, `url`, extension `version` ("Each entry has a `version`", 3.3), `client_id`, `jwks_uri` (4.1); MUST for `poppy_domains` (3.2) | error | Yes |
| wrong-type | JSON types | def. (3.1, 3.2, 4.1 examples and descriptions) | error | Yes |
| not-a-url | Absolute URL | def. | error | Yes |
| not-https-url | Every URL HTTPS | MUST/def. only for `auth.issuer` (3.1), `agent.protocols[].endpoint` ("HTTPS `endpoint`", 3.1), `client_id`, `jwks_uri`, `redirect_uris` (4.1), `return_to` (5); RFC 6749 §3.1/3.2, RFC 8628 §3.1, RFC 7009 §2 for OAuth endpoints. **Ours (N9)** for `apis[].url`, `auth.mediated.endpoint`, `web.browser_session_endpoint`, extension endpoints, `logo_uri` | error | Stronger than text for the N9 members; explain now names which are the draft's and which are ours |
| url-has-fragment | No `#fragment` | RFC 6749 §3.1 (authorization endpoint), §3.1.2 (redirect URI), RFC 8414 §2 (issuer); applied to every URL | error | Stronger than text for non-OAuth URLs; explain now says so |
| unknown-member | Report unknown members | MUST: "Personal Agents and Companies MUST ignore … fields they don't recognize" (3.3) | info | Yes |
| version-format | `major.minor` | def.: "as `major.minor`" (3.1) | error | Yes |
| version-unsupported-major | Known major | MUST NOT: "A Personal Agent MUST NOT use a document whose major version it doesn't support" (3.1) | error | Yes |
| version-newer-minor | Newer minor | def.: "A newer minor version doesn't break older Personal Agents" (3.1) | info | Yes |
| domain-invalid | Bare host name | def.: `domain` matches "the host of the well-known URL" (3.1) | error | Yes |
| organization-domain-mismatch | Domain equals requested host, ignoring `www.` | MUST: "`domain` MUST match the host of the well-known URL the Personal Agent requested, ignoring a leading `www.`. After a redirect, the host the document is served from does not count." (3.1) | error | Yes (`bareHost` strips one `www.` and case) |
| organization-name-missing | `name` present | def.: "Display name and domain" (3.1); S18 | warning | Yes |
| auth-required | `auth` when needed | Req.: "If `agent`, `apis`, or `web.browser_session_endpoint` is present" (3.1) | error | Yes (extension endpoints not covered, N26) |
| nothing-offered | One of agent/apis/web | Req.: "One of `agent`, `apis`, or `web`" (3.1) | error | Yes |
| website-only | No `auth` | def.: "a Company without it can only be browsed as an ordinary website" (3.1) | info | Yes |
| signed-out-only | No sign-in type | def.: "A Company that lists none offers only signed-out Sessions" (4.4) | info | Yes |
| issuer-query | No query in issuer | RFC 8414 §2: issuer "has no query or fragment components"; 3.2 "MUST publish … (RFC 8414)" | error | Yes |
| scope-syntax | Scope tokens | RFC 6749 §3.3; 4.4: "following OAuth scope syntax" | error | Yes |
| scope-reserved | No other `poppy:` scopes | def.: "Names starting with `poppy:` are reserved for this protocol" (4.4) | error | Yes (no keyword, but unambiguous) |
| scope-undescribed | Custom scope described | MAY + def.: "Companies MAY define their own scopes … and describe each one in `auth.custom_scopes`" (4.4); `custom_scopes` "Req. No" (3.1) | warning | Yes |
| scope-unoffered | Described scope offered | ours | info | Yes |
| scopes-empty | Non-empty `scopes` | ours | warning | Yes |
| scope-duplicate | No duplicate scope | ours | warning | Yes |
| mediated-fields-empty | Non-empty `fields` | ours (4.7 says only "`auth.mediated.fields` lists the ones the Company needs") | error | Stronger than text; explain now says so. For the owner |
| mediated-field-duplicate | Unique `name` | def.: "`name` is the key the Personal Agent sends" (4.7); keys in `credentials` are unique | error | Yes |
| mediated-secret-missing | `secret` present | def. (example; "`secret` marks a value …", 4.7) | warning | Yes |
| mediated-looks-secret | Secret-looking field marked | ours (heuristic) | warning | Yes |
| resource-invalid | RFC 8707 resource | RFC 8707 §2: absolute URI, "MUST NOT include a fragment"; 3.1 "MAY include a `resource`" | error | Yes |
| no-poppy-protocol | A `poppy` entry | def.: "The currently defined protocol is:", with `poppy` its only row (7.1) | warning | Yes; explain no longer says "every Personal Agent implements" it |
| protocol-type-unknown | Unknown protocol | def.: "It skips unfamiliar types" (7.1) | info | Yes |
| api-type-unknown | `openapi` or `mcp` | MUST: "Each API's `type` MUST be one of these" (6); SHOULD: "Personal Agents SHOULD skip API types they don't recognize" | info | **Weaker than text** (a Company MUST). Explain now quotes both; severity for the owner |
| api-description-missing | `description` present | def.: "Each has a `type` …, a `url`, and a short `description`" (3.1) | warning | Weaker than text (reads as required); acceptable |
| mcp-resource-mismatch | MCP `resource` = `url` | MUST: "MUST include `resource` set to the MCP server's `url`" (4.3); "It MUST accept only tokens issued for its `url`" (6) | warning | Yes |
| extension-name | Domain prefix | MUST: "Anyone else MUST start an extension's name with a domain they control" (3.3) | error | Yes |
| extension-plain-unknown | Plain name defined | def. + MUST as above (3.3) | warning | Weaker than text, for forward compatibility; acceptable |
| extension-version-unknown | Known version | MUST ignore unsupported extensions (3.3) | info | Yes |
| metadata-issuer-mismatch | Exact issuer | MUST: "MUST check that its `issuer` exactly matches `auth.issuer`" (3.2) | error | Yes |
| metadata-domain-missing | `poppy_domains` lists the domain | MUST: "`poppy_domains` in it MUST list every domain whose `poppy.json` names the issuer" (3.2) | error | Yes (case-insensitive, DNS) |
| metadata-auth-method | `private_key_jwt` advertised | def. (4.1 `private_key_jwt`); RFC 8414 optional field | warning | Yes |
| metadata-signing-alg | ES256/RS256 advertised | Guides: "Support ES256 and RS256" | warning | Yes |
| metadata-grant-type | Needed grants advertised | def. (4.2, 4.5, 4.6, 4.8 name the grants); RFC 8414 optional | warning | Yes |
| metadata-dpop-alg | ES256 for DPoP | Guides ("sign with ES256 when you can"); RFC 9449 §5.1 | warning | Yes |
| metadata-pkce | S256 advertised | def.: "authorization code flow with PKCE" (4.5); Guides "Accept PKCE with `S256` only" | warning | Yes |
| metadata-iss-parameter | `authorization_response_iss_parameter_supported` | def.: the redirect carries "its `auth.issuer` in `iss` (RFC 9207)" (4.5) | info | Yes |
| client-id-mismatch | `client_id` = fetched URL | MUST (4.1) | error | Yes |
| client-other-domain | Same domain | MUST: "`jwks_uri` and every entry in `redirect_uris` MUST be HTTPS URLs on the same domain as `client_id`" (4.1); "same domain" is our reading (S6) | error | Yes |
| client-auth-method | `private_key_jwt` declared | def. (4.1 example and text); RFC 7591 §2 default otherwise; no MUST | error | Stronger than text; explain now says so. For the owner |
| client-no-redirects | `redirect_uris` | def. (4.1, 4.5) | info | Yes |
| jwks-empty | At least one key | def.: assertions are "signed by a key from `jwks_uri`" (4.1) | error | Yes |
| jwks-private-key | Public keys only | def.: "The key set contains only public keys" (4.1) | error | Yes |
| jwks-key-type | EC P-256 or RSA | Guides: "Support ES256 and RS256" | error | Stronger than text; explain now says so. For the owner |
| jwks-rsa-small | RSA ≥ 2048 | RFC 7518 §3.3: "A key of size 2048 bits or larger MUST be used with these algorithms"; Guides | error | Yes; ref changed from the Guides to RFC 7518 §3.3 |
| jwks-alg | alg ES256/RS256 | Guides | warning | Yes |
| jwks-no-kid | kid present | Guides: "Give every key a `kid`" | warning | Yes |
| jwks-kid-duplicate | Unique kids | RFC 7517 §4.5: "SHOULD use distinct `kid` values"; Guides | error | Stronger than text; explain now says so. For the owner |
| jwks-use | `use: sig` | RFC 7517 §4.2 | warning | Yes |

Anchors: every `ref` the validator emits (`spec#discovery`, `#fields`, `#oauth-server`, `#extensions`, `#sign-in`, `#mediated-sign-in`, `#conversation-protocols`, `#apis`, `#sending-tokens`, `#starting-sessions`, `#direct-sign-in`, `#agent-identity`, `#web-browsing`; `guides#both-fetching`, `#company-agents`, `#both-transport`, `#both-signing`, `#both-key-rotation`; `operations#support`) exists in the snapshot.

### Mismatches

1. `not-https-url` (error) enforces HTTPS on `apis[].url`, `auth.mediated.endpoint`, `web.browser_session_endpoint`, extension endpoints and `logo_uri`, which Draft 0.1 doesn't require (N9). The explain said "Every endpoint and URL in these documents must be HTTPS"; it now names which members are the draft's and which are ours.
2. Errors grounded in the Guides only, not a MUST: `http-non-public-host`, `http-too-many-redirects`, `http-too-large`, `http-redirect-not-allowed` (plus a 4.1 MUST), `jwks-key-type`. Explains now say so.
3. Errors grounded in a SHOULD or nothing: `json-duplicate-member` (Guides; RFC 8259 SHOULD), `jwks-kid-duplicate` (RFC 7517 SHOULD), `client-auth-method` (no MUST), `mediated-fields-empty` (ours), `url-has-fragment` for non-OAuth URLs. Explains now say so.
4. `api-type-unknown` is info, but section 6 makes the type a Company MUST ("Each API's `type` MUST be one of these").
5. `messages.ts`'s header, the messages page and the form page said every error "breaks a MUST in the specification"; reworded. `README.md:74` said the same ("An `error` breaks a MUST"); see For the owner below.
6. Refs: `not-utf8` now cites RFC 8259 §8.1 (MUST) rather than the Guides; `jwks-rsa-small` cites RFC 7518 §3.3 (MUST).
7. Runner: `token.unlisted-host` cited 4.3 for our N10 reading; `redirect.credentials-followed` is a Guides item; both are `error`s under a header that said only MUSTs are. Citation and header fixed; severities unchanged. `YS.json` cited N17 as a spec requirement; now 4.3, 6.

No behaviour in `src/poppy` contradicts an unambiguous MUST; no behaviour was changed. Validator severities were left as they were, since each error feeds our client's ingest decision (`discover` refuses a Company on any error).

### For the owner

**Resolved** on 12 October 2026 by [docs/conformance-levels.md](../docs/conformance-levels.md). Every message names its basis, and its severity follows from it, so "invalid" means "breaks Draft 0.1 or an RFC it builds on". A separate `refuses` flag, and the report's `refused`, say what our client refuses. Our client therefore refuses the same documents as before, apart from the two changes listed in the policy.

- **The Guides and reading errors** became warnings that our client still refuses. For the N9 members, `not-https-url-unstated` is now a separate message.
- **`api-type-unknown`** is an error in a document whose minor version the validator knows; our client tolerates it and skips the API. In a newer minor version it is information, `api-type-newer`.
- **Runner severities.** `token.unlisted-host` and `redirect.credentials-followed` are warnings.
- **The runner checks on readings** are warnings, and a failure they cause is the spec's: `client-assertion.lifetime`, `.alg`, `.aud-array` and `.jti-missing`.
- **YK** is `permitted_by: N5`.

The questions as asked:

- Severity of the Guides- or reading-based validator errors (item 2 and 3 above): keep them as errors (our client refuses such documents, which is a deliberate hardening), or make them warnings so the report's "invalid" means "breaks Draft 0.1". `not-https-url` for the N9 members is the security-relevant one; we'd keep it an error and say so on the messages page (done).
- `api-type-unknown`: info today; the text makes it a Company MUST, but agents SHOULD skip it. A warning would be more faithful without changing what our client ingests.
- Runner severities: `token.unlisted-host` (N10 reading) and `redirect.credentials-followed` (Guides) are `error`; under the header's own rule they'd be warnings. Changing them changes grid attribution, so not done.
- Runner checks sharing mock ids rest on readings too: `client-assertion.lifetime` (300 s: no number in the text), `client-assertion.alg` (Guides), `client-assertion.aud-array` and `client-assertion.jti-missing` (4.2 says these for the Session assertion only; RFC 7523 makes a client assertion's `jti` optional).
- YK (reuse a rotated Account Token): the harm oracle expects the Company to refuse the old token, which the draft doesn't require (4.8 binds only the agent; N5).
- `docs/adversarial-interop.md` mapped YS to "4.4, 6, N17"; it now says "4.3, 6, N17", as the scenario does. `README.md` and the design spec said every `error` breaks a MUST; both now name the exceptions (done).
- `package.json` has no `interop:vectors` script (the exported vectors were removed in `a654175`); no fixture changed here, so none was needed.

## The 107 keyword sentences

The specification's sentences with an RFC 2119 keyword, as `keywordSentences` in [scripts/spec-snapshot.mjs](../scripts/spec-snapshot.mjs) finds them in [pages/spec.md](draft-0.1-2026-10-12/pages/spec.md) (the same 107 as on 9 October), with the party each binds or permits by our reading. A sentence that binds the Company's document, such as 3.1's `organization.domain`, counts as the Company's; one whose subject is both, or anyone, counts as both.

| # | Section | Binds | Sentence |
| --- | --- | --- | --- |
| 1 | 3. Discovery | Company | A Company MUST publish its `poppy.json` document at `https://{domain}/.well-known/poppy.json` over HTTPS, where `{domain}` is the Company's domain or a subdomain it controls. |
| 2 | 3. Discovery | Company | The well-known URL MAY redirect to where the document is hosted, so a Company can host it somewhere else, such as with a provider. |
| 3 | 3. Discovery | Personal Agent | Personal Agents MUST follow redirects, and every redirect MUST be to an HTTPS URL. |
| 4 | 3. Discovery | Personal Agent | Personal Agents SHOULD cache the document according to its HTTP caching headers. |
| 5 | 3.1 Fields | Personal Agent | A Personal Agent MUST NOT use a document whose major version it doesn't support. |
| 6 | 3.1 Fields | Company | Display name and domain. `domain` MUST match the host of the well-known URL the Personal Agent requested, ignoring a leading `www.`. |
| 7 | 3.1 Fields | Company | An entry MAY include a `resource` to require tokens issued for it (4.3). |
| 8 | 3.1 Fields | Company | An entry MAY include a `resource` to require tokens issued for it (4.3). |
| 9 | 3.2 OAuth server | Company | Several domains MAY name the same issuer, such as a Company with a domain for each country, and they are then one Company: the same User IDs (4.2), Sessions, and Account Tokens apply to all of them. |
| 10 | 3.2 OAuth server | Company | The issuer MUST publish OAuth Authorization Server Metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)), and `poppy_domains` in it MUST list every domain whose `poppy.json` names the issuer. |
| 11 | 3.2 OAuth server | Personal Agent | Before using a Company's `poppy.json`, the Personal Agent fetches the metadata and MUST check that its `issuer` exactly matches `auth.issuer` and that `poppy_domains` includes `organization.domain`. |
| 12 | 3.2 OAuth server | Company | The metadata MAY have other fields, which Personal Agents ignore. |
| 13 | 3.2 OAuth server | Personal Agent | Personal Agents SHOULD cache it according to its HTTP caching headers. |
| 14 | 3.3 Extensions | Both | Anyone else MUST start an extension's name with a domain they control, such as `example.com/gift-wrap`. |
| 15 | 3.3 Extensions | Both | - Personal Agents and Companies MUST ignore extensions they don't support and fields they don't recognize, so either side can work with the other under this specification alone. |
| 16 | 3.3 Extensions | Company | - A Company MAY refuse a request it handles only with an extension the Personal Agent doesn't list. |
| 17 | 4. Sessions and authorization | Company | Companies MAY limit what a Personal Agent can do in a Session, signed in or out. |
| 18 | 4.1 Agent identity | Personal Agent | A Personal Agent's `client_id` MUST be an HTTPS URL that returns its metadata document. |
| 19 | 4.1 Agent identity | Personal Agent | - `client_id` MUST equal the URL the document was fetched from. |
| 20 | 4.1 Agent identity | Personal Agent | - `jwks_uri` and every entry in `redirect_uris` MUST be HTTPS URLs on the same domain as `client_id`. |
| 21 | 4.1 Agent identity | Company | Companies MAY require Personal Agents to register ahead of time. |
| 22 | 4.1 Agent identity | Company | Companies MAY keep allowlists or blocklists of Personal Agents by `client_id`, and MAY revoke a `client_id` that misuses the protocol. |
| 23 | 4.1 Agent identity | Company | Companies MAY rate-limit Session creation by `client_id`. |
| 24 | 4.1 Agent identity | Company | A Company that doesn't require registration MAY also limit how many new `client_id` values it accepts. |
| 25 | 4.2 Starting a Session | Personal Agent | The Personal Agent MUST give each of its Users a User ID for each Company, where a Company is identified by its `auth.issuer` (3.2). |
| 26 | 4.2 Starting a Session | Personal Agent | It MUST NOT contain or be derived from personal information, such as an email address, phone number, or name, even with a keyed hash. |
| 27 | 4.2 Starting a Session | Company | The Company chooses the value, and it MUST be greater than 0. |
| 28 | 4.2 Starting a Session | Company | Session Tokens SHOULD last hours, not days. |
| 29 | 4.2 Starting a Session | Personal Agent | Personal Agents MUST NOT depend on their contents; everything they need is in the response. |
| 30 | 4.2 Starting a Session | Company | A Company MAY include its own Session credentials in a token so its existing systems can read them. |
| 31 | 4.2 Starting a Session | Company | If it does, it MUST encrypt the token. |
| 32 | 4.3 Using Session Tokens | Personal Agent | API calls and conversations MUST carry the Session Token in the `Authorization` header with the `DPoP` scheme, together with a DPoP Proof ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)): |
| 33 | 4.3 Using Session Tokens | Personal Agent | The Personal Agent generates a key pair for each User at each Company, and MAY use a new one for each Session. |
| 34 | 4.3 Using Session Tokens | Company | On every request, it MUST check that: |
| 35 | 4.3 Using Session Tokens | Company | A Company MAY require proofs to include a nonce it issued, as RFC 9449 describes, so proofs can't be made in advance. |
| 36 | 4.3 Using Session Tokens | Personal Agent | Personal Agents MUST support nonces. |
| 37 | 4.3 Using Session Tokens | Personal Agent | To get one for an existing Session, the Personal Agent sends the request that renews the Session's token (4.2, or 4.8 for a signed-in Session) without the `DPoP` header, and MUST include `resource` set to the MCP server's `url` from `poppy.json`, as MCP authorization requires. |
| 38 | 4.3 Using Session Tokens | Company | Companies MUST accept Bearer Session Tokens only on their MCP APIs (section 6), and MUST require DPoP everywhere else. |
| 39 | 4.3 Using Session Tokens | Personal Agent | **Narrower tokens.** Any token request MAY include `scope`, to ask for fewer scopes than the Session has, and `resource` ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)), to ask for a token for one service. |
| 40 | 4.3 Using Session Tokens | Company | - Companies MUST accept the token in the `Authorization` header without requiring cookies. |
| 41 | 4.3 Using Session Tokens | Personal Agent | - Personal Agents MUST send a Session Token on every API and conversation request, and MUST NOT leave it out to appear to the Company as a person on their own. |
| 42 | 4.3 Using Session Tokens | Personal Agent | - Whenever the Personal Agent gets a new Session Token for a Session, it MUST use the new token from then on. |
| 43 | 4.3 Using Session Tokens | Both | - Personal Agents MUST NOT send tokens in a URL, and Companies MUST NOT accept them from one. |
| 44 | 4.3 Using Session Tokens | Personal Agent | The Personal Agent MUST wait at least that long before sending the request again. |
| 45 | 4.4 Signing in | Personal Agent | The types work on trust: a Personal Agent MUST use direct or Device Sign-In only when the User signs in themselves. |
| 46 | 4.4 Signing in | Company | Companies MAY revoke the `client_id` of a Personal Agent that doesn't (4.1). |
| 47 | Scopes | Company | - Companies MAY define their own scopes, such as `addresses`, and describe each one in `auth.custom_scopes`. |
| 48 | Scopes | Company | - A Company MAY leave out `poppy:read` and `poppy:write` and offer only its own, narrower scopes, if broad access doesn't meet its security needs. |
| 49 | Scopes | Company | The Company MUST NOT grant scopes beyond those requested and allowed for the type used. |
| 50 | Scopes | Personal Agent | - Each sign-in request MUST include `scope` as a space-separated string, following [OAuth scope syntax](https://www.rfc-editor.org/rfc/rfc6749#section-3.3). |
| 51 | Scopes | Personal Agent | The new Account Token replaces the old one, which the Personal Agent SHOULD revoke (4.9). |
| 52 | How sign-in is remembered | Personal Agent | Before starting a new sign-in, the Personal Agent SHOULD check whether it already holds an Account Token that covers the task (4.8). |
| 53 | 4.5 Direct Sign-In | Company | The Company sends the User back.** The Company redirects the browser to `redirect_uri` with a one-time `code`, the same `state`, and its `auth.issuer` in `iss` ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)). `redirect_uri` MUST exactly match an entry in the Personal Agent's `redirect_uris` (4.1). |
| 54 | 4.5 Direct Sign-In | Personal Agent | The Personal Agent exchanges the code.** The Personal Agent checks `state`, and MUST check that `iss` exactly matches the `auth.issuer` of the Company it started sign-in with. |
| 55 | 4.6 Device Sign-In | Company | Opening the link MUST NOT approve the request by itself. |
| 56 | 4.7 Mediated Sign-In | Personal Agent | - `secret` marks a value the Personal Agent MUST protect: never shown back to the User, written to logs, or sent anywhere else. |
| 57 | 4.7 Mediated Sign-In | Company | A Company that offers Mediated Sign-In MUST rate-limit attempts, MUST NOT return credentials in any response, and SHOULD require a one-time code when a sign-in looks unusual. |
| 58 | 4.7 Mediated Sign-In | Personal Agent | Personal Agents MUST NOT send credentials to any endpoint other than the Company's `auth.mediated.endpoint`. |
| 59 | 4.8 Account Tokens | Company | - Companies MUST accept an Account Token only at their `token_endpoint` and `revocation_endpoint`, and only from the `client_id` it was issued to, authenticated by its client assertion. |
| 60 | 4.8 Account Tokens | Company | - The Session MUST belong to the same `client_id` and User ID as the Account Token, and be signed out or signed in to the same account. |
| 61 | 4.8 Account Tokens | Personal Agent | - `scope` MAY ask for fewer scopes than the Account Token has, for example read-only access for a task that only looks things up. |
| 62 | 4.8 Account Tokens | Company | A Company MAY return a new Account Token in `refresh_token`. |
| 63 | 4.8 Account Tokens | Personal Agent | The Personal Agent then MUST use the new one from then on. |
| 64 | 4.8 Account Tokens | Personal Agent | - Personal Agents MUST store Account Tokens as secrets, and MUST NOT put them in model context, conversation messages, logs, or URLs. |
| 65 | 4.9 Signing out | Company | A Company MAY end the Sessions instead, if its policy is to clear everything at sign-out. |
| 66 | 4.9 Signing out | Company | Companies SHOULD check on each request whether the Session is still signed in, so sign-out takes effect right away. |
| 67 | 4.9 Signing out | Company | A Company that doesn't SHOULD use much shorter Session Token lifetimes, such as a few minutes. |
| 68 | 5. Web browsing | Personal Agent | When it does, the Personal Agent MUST join its browser to a Session before browsing the Company's website. |
| 69 | 5. Web browsing | Personal Agent | It MUST be an HTTPS URL on the Company's `organization.domain` or one of its subdomains. |
| 70 | 5. Web browsing | Personal Agent | The assertion MUST go in the request body, never in the URL. |
| 71 | 5. Web browsing | Personal Agent | The Personal Agent MUST post browser assertions only from a browser it controls, never from the User's own browser, which would then be using the Personal Agent's Session. |
| 72 | 5. Web browsing | Company | The Company checks it and sets a cookie.** The Company MUST check that: |
| 73 | 5. Web browsing | Company | - MUST follow the Session's current state: when the Session signs in or out, or its scopes change, the website reflects it on the next request. |
| 74 | 5. Web browsing | Company | - MUST NOT outlive the Session. |
| 75 | 5. Web browsing | Company | - MUST be `Secure` and `HttpOnly`, and use `SameSite=Lax` or `None`, not `Strict`. |
| 76 | 5. Web browsing | Personal Agent | The Personal Agent MAY post a new browser assertion at any time, for example when the website no longer recognizes the Session. |
| 77 | 6. APIs | Company | Each API's `type` MUST be one of these: |
| 78 | 6. APIs | Personal Agent | Personal Agents SHOULD skip API types they don't recognize, so later versions can add types. |
| 79 | 6. APIs | Company | Every listed API MUST accept Session Tokens as described in 4.3: DPoP for OpenAPI, and Bearer for MCP. |
| 80 | 6. APIs | Company | A listed MCP server MUST accept Session Tokens as its access tokens and enforce their scopes. |
| 81 | 6. APIs | Company | It MUST accept only tokens issued for its `url` (4.3). |
| 82 | 6. APIs | Company | MCP clients find where to get a token from the server's protected resource metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), and its `authorization_servers` MUST include `auth.issuer`. |
| 83 | 7.2 Requests | Company | The Company MUST reject requests from any other `client_id`, User, or account. |
| 84 | 7.2 Requests | Both | They SHOULD start with a short prefix for their kind, such as `cnv_`, `msg_`, or `evt_`. |
| 85 | 7.2 Requests | Both | Beyond these rules, the side that chooses an ID decides its format, and the other side MUST NOT depend on it. |
| 86 | 7.3 Sending messages | Personal Agent | **Message IDs.** The Personal Agent chooses each message's `id`, and MUST make it unique for the User. |
| 87 | 7.4 Message fields | Both | A message MUST have at least one of `text`, `data`, or `context`. |
| 88 | 7.4 Message fields | Both | Personal Agents and Company Agents SHOULD NOT put JSON or other markup in `text`. |
| 89 | 7.4 Message fields | Personal Agent | When a Personal Agent shares one of these facts, it MUST use the field and format defined here: |
| 90 | 7.4 Message fields | Personal Agent | `context` MAY include other fields, such as accessibility needs or preferred units. |
| 91 | 7.4 Message fields | Company | The Company Agent interprets them as it sees fit, and a Company MAY ignore them. |
| 92 | 7.4 Message fields | Personal Agent | Personal Agents SHOULD share only what the task needs. |
| 93 | 7.5 Reading events | Personal Agent | Personal Agents MUST skip event types they don't recognize, so later versions and extensions can add types. |
| 94 | 7.5 Reading events | Personal Agent | Cursors are opaque, so the Personal Agent MUST NOT compare or sort them. |
| 95 | 7.5 Reading events | Company | It MAY return sooner, or cap `wait`. |
| 96 | 7.5 Reading events | Company | - Every successful read MUST include `cursor`, `has_more`, `status`, and `responder`, even with no events. `cursor` is the last event returned, or the request's cursor if there were none. |
| 97 | 7.5 Reading events | Personal Agent | The Personal Agent then reads from the beginning and SHOULD tell the User that part of the conversation is missing. |
| 98 | 7.6 Streaming | Company | A Company MAY stream events with server-sent events ([SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)). |
| 99 | 7.6 Streaming | Company | The Company MAY close a stream at any time, for example when the Session Token expires. |
| 100 | 7.6 Streaming | Company | While the Company Agent writes a message, the Company MAY send pieces of its text as `text-delta` events, with no SSE `id`: |
| 101 | 7.6 Streaming | Personal Agent | It MUST NOT act on text from a `text-delta` event. |
| 102 | 7.7 Status and responder | Company | Every successful response to a `POST` or a read MUST include `status` and `responder`. |
| 103 | 7.7 Status and responder | Company | Each Company message MUST also include `sender`, with `agent` or `human`, to identify who wrote it. |
| 104 | 7.8 Human or AI | Personal Agent | On the Personal Agent's side, the Personal Agent MUST set each message's `sender`: `agent` when the Personal Agent wrote it, and `human` only when it carries the User's own words. |
| 105 | 7.10 Direct Conversations | Company | The parent conversation MUST be open, belong to the same owner (7.2), and not be a Direct Conversation itself. |
| 106 | 7.11 Sign-in during a conversation | Company | It SHOULD also ask in a message, so a User in a Direct Conversation sees the request: |
| 107 | 7.11 Sign-in during a conversation | Personal Agent | The Personal Agent MAY switch to a new Session Token partway through a conversation, after signing in, renewing, or signing out, or continue it in a new Session, as long as the token matches the conversation's owner (7.2). |
