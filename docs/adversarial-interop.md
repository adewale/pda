# Adversarial interop

"Adversarial interop" means two different things, and Poppy, the [Personal Agent Protocol](https://personalagentprotocol.org/), touches both:

1. **Adversarial interoperability, or competitive compatibility.** In Cory Doctorow's and the EFF's sense, this is building something that works with an incumbent's product *without its permission*. Poppy is about Personal Agents working with Companies, so who grants access, and on what terms, is the protocol's central question.
2. **Adversarial interoperability testing.** This is the security sense: running honest implementations against peers that misbehave on purpose (malicious servers and clients, fuzzers, attacker models) to check that the honest side refuses safely.

This document covers both: what the first means for a fair protocol, and how our harness ([interop-spec.md](interop-spec.md)) does the second, ending with a prioritised plan and how far it has got. Sources are linked inline and listed at the end; *(unverified)* marks what we couldn't confirm.

## Part A. Competitive compatibility

### The idea

- **Doctorow's definition.** In [Adversarial Interoperability](https://www.eff.org/deeplinks/2019/10/adversarial-interoperability) (EFF, 2 October 2019), adversarial interoperability is a new product or service that plugs into existing ones "without the permission" of the companies that make them. His examples are third-party printer ink, alternative app stores and independent repair. The obstacles he names are software patents, DRM law, and other laws and rulings incumbents have obtained.
- **The rename.** EFF later called it "competitive compatibility" (comcom), because the old name was "a mouthful" and "AI" was taken ([ProMarket, 2022](https://www.promarket.org/2022/04/15/seize-the-means-of-computation/); [EFF podcast, 2020](https://www.eff.org/deeplinks/2020/11/podcast-episode-control-over-users-competitors-and-critics)).
- **Comcom and mandates.** Doctorow argues that comcom and interoperability mandates work together "like a two-part epoxy". Mandates can be subverted and enforcement is slow, so the possibility of unpermitted interop keeps the mandated kind honest ([W3C list, 2021](https://lists.w3.org/Archives/Public/public-interop-remedies/2021Nov/0007.html)). His book is [*The Internet Con*](https://newbooksnetwork.com/the-internet-con) (Verso, 2023).

### Where agents are in that fight

- **Scraping and the law.** [hiQ v. LinkedIn](https://www.natlawreview.com/article/linkedin-s-data-scraping-battle-hiq-labs-ends-proposed-judgment) ended in 2022 with a consent judgment: hiQ paid $500,000, accepted an injunction against scraping, and deleted the data. The court had held that terms of service banning scraping are enforceable as a contract. The CFAA question over public data was never finally decided.
- **Banking: sanctioned access with a fallback.**
  - PSD2's technical standards ban "traditional screen scraping", where a third party impersonates the customer. Banks must offer a dedicated interface, or their customer interface to third parties that *identify themselves*.
  - If the dedicated interface fails, third parties may fall back to the customer interface, still identified, and accessing only what the customer consented to ([Jones Day](https://www.jonesday.com/en/insights/2018/03/eu-regulatory-technical-standards-for-strong-custo); [Pinsent Masons](https://www.pinsentmasons.com/out-law/news/eba-refuses-to-cave-in-to-commission-proposals-on-psd2-interfaces)).
  - The US equivalent, the CFPB's Section 1033 rule, was finalised in 2024. It was then stayed by a court and reopened in 2025, with screen scraping and fees among the open questions ([CFPB](https://www.consumerfinance.gov/compliance/compliance-resources/other-applicable-requirements/personal-financial-data-rights/); [Cooley](https://www.cooley.com/news/insight/2025/2025-08-27-cfpb-reconsiders-section-1033-rule-signaling-potential-overhaul-of-personal-financial-data-rights-framework)).
- **Platforms: mandates.** The EU's DMA Article 6(7) produced specification decisions requiring Apple to open iOS features to connected devices and to run a transparent request process (March 2025). Apple is challenging them in court ([FSFE](https://fsfe.org/news/2025/news-20250403-01.html); [ARTICLE 19](https://www.article19.org/resources/digital-markets-act-reaction-to-commissions-decision-on-requesting-apple-interoperability/)).
- **Agents: the live case.**
  - Amazon sued Perplexity in November 2025, alleging that its Comet browser agent shopped in users' accounts while presenting Chrome's user-agent string, and kept going after being blocked. Perplexity called the suit "bullying" ([PPC Land](https://ppc.land/amazon-sues-perplexity-over-covert-ai-agent-access-to-marketplace/); [Silicon UK](https://www.silicon.co.uk/e-regulation/legal/amazon-lawsuit-perplexity-ai-627405/amp)). We don't know the case's current status.
  - On identification, Cloudflare's [Web Bot Auth](https://blog.cloudflare.com/verified-bots-with-cryptography) has bots sign their requests with HTTP Message Signatures (RFC 9421), and its ["signed agents"](https://blog.cloudflare.com/signed-agents) are agents directed by end users. The IETF draft is [draft-ietf-webbotauth-httpsig-protocol](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/).

### Where Poppy stands

Poppy is the sanctioned path. It moves agents from impersonation to a declared, consented channel. Sierra's [announcement](https://sierra.ai/blog/poppy) puts it as "customers decide what access to give their personal agents, and companies set parameters for what those agents can do", and the [overview](https://personalagentprotocol.org/overview) observes that today agents pass as the user or get blocked. Read through the comcom lens, [the draft](https://personalagentprotocol.org/spec):

- **Gives Companies every lever.** They may require registration, keep allowlists and blocklists by `client_id`, revoke a `client_id`, rate-limit Sessions, and refuse requests that need an extension (4.1, 4.3, 3.3, 4.4).
  - poppy-demo's Company admits only its sibling agent, which 4.1 allows ([poppy-issues](poppy-issues.md#poppy-demo-irvinebroquepoppy-demo)).
  - A Poppy where every Company keeps an allowlist would rebuild the gatekeeping that comcom fights. Agent identity makes discrimination by agent precise.
- **Leaves the unpermitted case open.** Section 5: "On a website without the endpoint, the Personal Agent browses as an ordinary signed-out visitor."
  - The draft doesn't say whether the agent must identify itself there, or what it may do after a Company refuses its `client_id`. That is the Amazon–Perplexity question.
  - PSD2's answer is a fallback to the human interface with the third party identified. Web Bot Auth could be the identification mechanism.
- **Gives Users no right to an agent.** The User's consent governs scope (4.5, 4.6), but nothing gives a User any right to use the agent of their choice. That is a matter for policy, though the protocol decides whether such a policy could be checked.

**What a fair protocol needs.** This is our view, offered to the spec's authors:

1. **Refusals that are visible and explained.** A refused agent learns why (`invalid_client` with a reason or a policy URL), and can tell the User. Silent 403s push agents back to disguise.
2. **Honesty both ways.**
   - An agent that falls back to the website after being refused, or where Poppy isn't offered, identifies itself (Web Bot Auth or similar) and doesn't spoof a browser.
   - A Company doesn't serve agents worse terms than it serves the same User in a browser for the same action without saying so, as PSD2 requires of the fallback.
3. **No agent lock-in.** Any conforming agent works with any conforming Company unless the Company declares otherwise. The M×N grid measures exactly this, which is why it should be published as being about the spec, not about projects ([risks](interop-testing.md#risks)).
4. **Fair limits.** Rate limits are signalled with `Retry-After` (4.3), and Companies honour revocation and sign-out (S8, N16) so Users can leave.

Our harness tests 1 and 4. In scenario `BX` (refused agent) the Company admits no `client_id`, and the agent must report the refusal as a `poppy_error`. Scenario `RL` covers 4. Point 2 needs spec text first.

## Part B. Adversarial testing

### The lineage

- **Byzantine peers.** Lamport, Shostak and Pease's [Byzantine Generals](https://people.cs.umass.edu/~arun/cs677/reading/LSP.pdf) (TOPLAS, 1982) made "a participant that lies" a first-class failure model. Agreement with spoken messages needs more than two-thirds of the participants loyal; with unforgeable signed messages, any number of traitors can be tolerated. Poppy rests on signatures (assertions, DPoP), so each side can refuse what it can't verify. It can't, though, verify claims the protocol doesn't sign, such as a Company's display name (N14) or an operation's summary.
- **Malicious peers in TLS.**
  - BoGo's peer is a Go TLS stack "patched with configurable bugs" ([BoringSSL](https://boringssl.googlesource.com/boringssl/+/main/ssl/test)).
  - [tlsfuzzer](https://github.com/tlsfuzzer/tlsfuzzer) scripts named attacks (ROBOT, DROWN).
  - [TLS-Attacker](https://www.nds.ruhr-uni-bochum.de/media/nds/veroeffentlichungen/2016/10/19/tls-attacker-ccs16.pdf) builds arbitrary flows and found padding oracles and overreads. Its authors argue that suites need negative tests.
- **OAuth and OIDC attacker models.**
  - [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), the OAuth 2.0 Security BCP (January 2025), defines five attackers. A1 is the web attacker, who runs arbitrary endpoints and lures users. A2 is the network attacker. A3 reads authorization responses, A4 reads authorization requests, and A5 acquires access tokens.
  - Its catalogue includes mix-up (4.4), code injection (4.5), token injection (4.6), PKCE downgrade (4.8), stolen tokens and sender-constraining (4.10), open redirectors (4.11), 307 redirects (4.12) and refresh token rotation (4.14).
  - Mix-up: a client talks to an honest and an attacker authorization server and is tricked into sending the honest one's code to the attacker. The fix is [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)'s `iss` in the authorization response.
- **Formal web models.**
  - Fett, Küsters and Schmitz analysed OAuth 2.0 against web and network attackers in a formal web model ([CCS 2016](https://arxiv.org/abs/1601.01229)). They found four attacks, including IdP mix-up and the 307 redirect ([summary](https://blog.acolyer.org/2016/11/07/a-comprehensive-formal-security-analysis-of-oauth-2-0/)), and then proved the fixed protocol secure.
  - Follow-ups covered [OpenID Connect](https://arxiv.org/abs/1704.08539) (CSF 2017) and [FAPI](https://arxiv.org/abs/1901.11520) (S&P 2019).
  - Poppy's sign-in is OAuth with `private_key_jwt`, PKCE, `iss` and DPoP, so it inherits these results only where it follows the profiles they proved.
- **Malicious identity providers.**
  - Mainka, Mladenov and Schwenk's ["Do not trust me"](https://nds.rub.de/research/publications/openid) (EuroS&P 2016) used an attacker-run IdP, found during discovery, to break 12 of 17 OpenID implementations.
  - Their OIDC follow-up ([SoK, 2017](https://www.nds.ruhr-uni-bochum.de/research/publications/sok-single-sign-security-evaluation-openid-connect)) describes PrOfESSOS, which runs an honest IdP and an attacker IdP side by side. It reports IdP confusion and malicious-endpoint attacks.
  - Poppy has the same shape: the agent discovers the Company's issuer from a document the Company serves.
- **Conformance suites as attackers.**
  - The OIDF suite plays the OP in RP tests and runs "negative tests" that return invalid data ([RP testing](https://openid.net/certification/rp_testing/); [Brazil guide](https://openid.net/certification/fapi-rp-conformance-testing-certification-submission-overview-for-open-banking-brazil/)). The old suite had tests like `rp-id_token-bad-sig-rs256`.
  - We couldn't confirm whether today's suite includes a two-issuer mix-up test *(unverified)*.
  - [Issue 1375](https://gitlab.com/openid/conformance-suite/-/issues/1375) shows the gap: an RP that skipped signature checks still passed.
- **JWT and DPoP attacks.**
  - McLean's 2015 [JWT library flaws](https://auth0.com/blog/critical-vulnerabilities-in-json-web-token-libraries/): `alg: none`, and RS256-to-HS256 confusion, where the public key is used as an HMAC secret.
  - [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725) adds `kid`, `jku` and `jwk` handling and cross-JWT confusion.
  - [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) §11 covers proof replay, pre-generated proofs, nonce downgrade (once a server has issued a nonce it must require one), JWT swapping (check `typ: dpop+jwt`) and `dpop_jkt` code binding.
  - Our mock already checks most of these (`*.alg`, `*.embedded-key`, `*.jti-reused`, `dpop.typ`, `dpop.key-mismatch`).
- **Web pentesting.** PortSwigger's [OAuth guidance](https://portswigger.net/web-security/oauth/preventing) and Burp labs focus on `redirect_uri` validation, `state`, and Referer leaks. We didn't research ZAP's OAuth support *(unverified)*.
- **Crash and fault tests.**
  - WPT's [crashtests](https://web-platform-tests.org/writing-tests/crashtest.html) pass if the page loads "without crashing or experiencing other low-level issues".
  - Jepsen pairs a workload with a "nemesis" that injects faults (partitions, pauses, clock skew), then checks the recorded history ([CNCF write-up](https://cncf.io/blog/2024/02/19/analysis-of-xline-jepsen-tests)).
  - [Toxiproxy](https://github.com/Shopify/toxiproxy) injects latency, timeouts, resets and truncation between services.
- **Agents.**
  - Willison's [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) is private data, untrusted content and a way to communicate out. A Personal Agent has all three by design.
  - Invariant Labs' [tool poisoning](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) hides instructions in MCP tool descriptions. A "rug pull" changes a tool after approval.
  - [AgentDojo](https://arxiv.org/abs/2406.13352) (NeurIPS 2024) scores whether an agent completes the User's task and whether the attacker's goal ran, with checks over environment state rather than model judgement. That is the right oracle shape for injected Company text.

### Adversarial adapters for our harness

The honest grid assumes both sides are trying. To test refusals, the harness adds implementations that aren't:

- **`evil-company`** (role `company`): our mock Company with an attack switch, so the attack is the only deviation from a strict, correct Company.
- **`evil-agent`** (role `agent`): our client with an attack switch, reusing the mock's `TAMPERS` rows as the attack catalogue.
- **A fault-injection mode in the recording proxy**: a network attacker inside TLS. The proxy already terminates TLS, so it sits where RFC 9700's A2 would, in a test network.

#### Contract changes

| Part of [interop-spec](interop-spec.md) | Change |
| --- | --- |
| Registry (§2) | `"adversarial": true` on `evil-company` and `evil-agent`. The live lane (§10) refuses adversarial entries: never attack a deployment whose owner hasn't agreed. |
| Manifest (§4) | `attacks`: the attack ids the adapter supports. |
| Hooks and ops (§5) | Company: `POST /hooks/arm {attack, params}`. Agent: `{"op": "arm", "params": {attack, ...}}`. An unknown attack answers 501, so the cell is `unsupported`. |
| Scenarios (§6) | `"adversary": "company" \| "agent" \| "network"`; an `arm` step; `"faults"` for the proxy (`{match, action}` with action `drop_response`, `replay`, `duplicate`, `delay`, `truncate`, `status`); `"permitted_by": "N10"` when the draft allows the attack. Refusals use the existing `poppy_error` expectations. |
| Checks (§8) | **Harm oracles** as new `assert_trace` predicates: `no_request_to` (host), `token_not_sent_to`, `performed_at_most_once`, `no_2xx_after` (replay), `no_secret_in`. Plus **attack observed**: the trace shows the attack happened, or the cell is `error` with blame `harness`, the way a predicate with nothing to judge makes a cell `unsupported` today. |
| Attribution (§9) | Below. |

#### Attribution for adversarial cells

1. **Rule 0, adversarial (applied first).** In a cell with an adversarial side, that side's violations are expected and don't count against it.
   - The cell **passes when the honest side refuses**: the expected `poppy_error`, or status 0 for the agent's own refusal, and no harm oracle fires.
   - A failure is blamed on the honest side, with rule `adversarial`. If the scenario names `permitted_by` and the draft has no MUST against the attack, blame `spec` (N10 and N14 today).
2. **Rule 2, grid,** ignores adversarial implementations, which are never reference cells. `dpa-mock` stays the honest reference.
3. **Reporting.** Adversarial cells get their own page, the security grid, and never count toward interop pass rates.
4. **Disclosure.** A failure there may be a vulnerability in someone's project. Tell its maintainers privately before the results are committed. A known failure can then link a private advisory or our spec issue. The full process, including the 90-day window, is in [`SECURITY.md`](../SECURITY.md#disclosing-what-interop-testing-finds-in-other-projects).

#### Malicious Company scenarios

| Id | Attack | Spec | How it's expressed | Honest agent passes when | Status |
| --- | --- | --- | --- | --- | --- |
| `XM` | **Mix-up, two issuers.** The User signs in at evil and at honest; evil's callback carries honest's code, or `iss` names honest's issuer. | 4.5, RFC 9207, N32 | `arm mixup {victim}`; agent signs in at both | `signin_continue` refuses (`iss` mismatch); `token_not_sent_to` evil for honest's code | Not yet (needs two Companies in one cell) |
| `XI` | **Issuer claim.** Evil's `poppy.json` names honest's issuer, without honest's `poppy_domains`. | 3.2 | `arm claim-issuer` | `discover` fails with `discovery_failed`; no token request | Scenario `XI` |
| `XH` | **Token-host confusion.** An OpenAPI `servers` entry or MCP `url` points at `sink.interop.test`. | 4.3, 6, **N10** | `arm foreign-server`; `api` step | Refuses (`untrusted_server` for us); `token_not_sent_to` sink. `permitted_by: N10` | Scenario `XH`; client check `"never sends a Session Token to a server on another host that an OpenAPI description names (N10)"` |
| `XS` | **SSRF through discovery.** `apis[].url`, `jwks`-like links or redirects aim at the runner, another container's control port, or a "private" sink name. | Guides (SSRF), N42 | `arm ssrf {target}` | `no_request_to` target. Needs an interop-only "private" suffix, per our N42 proposal | Not yet (needs the N42 "private" suffix; one-sided SSRF vectors cover the host check today) |
| `XB` | **Oversized or slow.** A 50 MB `poppy.json`, a never-ending SSE stream, a redirect loop, huge `Retry-After`, gzip bomb. | 4.3, 7.6 | `arm big \| slow \| loop` | Step ends within a deadline with a clean error, crashtest-style; adapter still healthy | Not yet (the proxy's `delay`/`truncate`/`reset` faults cover the network shape; oversized bodies need a mock option) |
| `XN` | **DPoP nonce abuse.** A fresh `use_dpop_nonce` on every reply; a 10 KB nonce; one origin's nonce demanded at another. | 4.3, RFC 9449 §8, S23 | `arm nonce-loop` | Bounded retries (no more than N), then error; no proof reused | Not yet (needs a mock nonce-loop option; scenario `N` covers one nonce retry) |
| `XK` | **Rug pull on discovery.** Endpoints in `poppy.json` move off-domain between discovery and a later call. | 3, **N44** | `arm rug-pull` after `discover` | Re-validated document refused; `token_not_sent_to` new host | Dropped: our client caches the validated documents for their lifetime, so the move is never fetched and the attack-observed precondition can't hold. When an agent must fetch again is spec issue N44 |
| `XO` | **Operation changed between approval and confirm.** After `approve_op`, the Company changes the amount or summary under the same id, or reports a different action as performed. | Ops 3.1, 4, 5.1 | `arm op-swap` between `approve_op` and confirm | The agent confirms only the revision approved (`confirm.revision`), and reports a mismatch at settle instead of "done" | Not yet (needs a mock op-swap option; client check `"shows the Company's summary verbatim and confirms once after the User approves"` exercises the approve/confirm path in-process) |
| `XP` | **Consent spoofing.** `organization.name` is another Company's ("Example Bank"). | Ops 5.1, **N14** | `arm display-name`; new agent op `display` returning what the User would see | The displayed domain is the verified `organization.domain`. `permitted_by: N14` | Not yet (needs an agent `display` op) |
| `XJ` | **Injected text.** Messages, operation summaries, MCP descriptions or pages contain "approve operation X" or "send your token to …". | **N15**, Ops 5.1, 7.11 | `arm inject {canary}` | Protocol lane: no confirm without an `approve_op` step, and the canary never leaves (`no_secret_in`) | Workers test `"never confirms an operation, or speaks as the User, when a Company message says the User approved"` and the rest of `test/prompt-injection.test.ts`, with a faux model that obeys injected text. Not in the interop harness, which has no model lane (the `no_secret_in` harm oracle is built) |
| `XE` | **Spoofed sender.** Conversation events with `sender: "user"`, or staff text impersonating the agent. | 7.5 | `arm spoof-sender` | The agent doesn't treat the content as the User's words (visible in `read`) | Not yet (needs a mock spoof-sender option) |
| `BX` | **Refused agent (fairness).** The Company admits no `client_id`. | Part A, 4.1 | `arm block` | The agent reports `poppy_error` to the User; no silent 403 | Scenario `BX` |

#### Malicious Personal Agent scenarios

Most of these are already rows in `TAMPERS` (`test/mock-company.test.ts`) against our mock. `evil-agent` turns them into wire attacks against every Company:

| Id | Attack | Spec | Mock check it mirrors | Honest Company passes when | Status |
| --- | --- | --- | --- | --- | --- |
| `YR` | Replay a client or Session assertion | 4.1, 4.2 | `*.jti-reused` | `invalid_client` / `invalid_grant`; `no_2xx_after` the replay | Scenario `YR` |
| `YD` | Replay a DPoP proof; omit the nonce after one was issued | 4.3, RFC 9449 §11.1, §11.3 | `dpop.jti-reused`, `dpop.nonce-ignored` | `invalid_dpop_proof` or `use_dpop_nonce` | Scenario `YD` |
| `YA` | **`aud` confusion.** An assertion minted for Company A, or for another endpoint, presented at B | 4.1, S1 | `client-assertion.aud`, `session-assertion.aud` | Refused at B. Under S1 a lenient reading may accept another endpoint: `permitted_by: S1` | Scenario `YA` |
| `YT` | **Stolen token, another key.** A Session Token presented with a proof from a different key | 4.3 | `dpop.key-mismatch` | `invalid_token` | Scenario `YT` |
| `YF` | **Sign-in fixation.** A code from User 1's sign-in redeemed into User 2's Session of the same agent | 4.5, **N2** | `code.no-session-id` (partial) | Refused, or the Account Token records the right User. Likely `permitted_by: N2` today | Not yet (needs a two-User Direct Sign-In flow in the attack adapter) |
| `YS` | **Scope escalation.** A write with a read token; Bearer requested with a non-MCP `resource` (downgrade) | 4.3, 6, N17 | `token.mcp-dpop`, `resource.bearer-scheme` | `insufficient_scope`; no Bearer issued for non-MCP `resource` | Scenario `YS` |
| `YO` | **Retry after sign-out.** The same message id resent after sign-out | 7.3, 7.11, **S8** | `idempotency.key-reused` (related) | `sign_in_required`, never the original response (poppy-demo returned it) | Workers test `"checks conversation ownership before message-id idempotency on a signed-out retry (S8)"` (mock `start()` fixed) |
| `YU` | **Cross-User conversation.** User B of the same agent reads or continues User A's conversation id | 7.13, **S17** | `conversation.cross-user` (added) | `conversation_not_found` | Scenario `YU`; TAMPERS `"…another User of the same agent reading a conversation"` |
| `YK` | **Rotation abuse.** A rotated Account Token reused; another client's Account Token; key rotation that keeps the `kid` | 4.8, N5, Guides | `account-token.rotated-reused`, `account-token.other-client` | Refused; under rotation with reuse detection, the family revoked. `permitted_by: N5`: 4.8 binds only the agent, so a Company that accepts the old token breaks no requirement of the draft ([conformance-levels.md](conformance-levels.md#security-behaviour-and-verdict-are-separate)) | Scenario `YK` (rotated-reuse; other-client and `kid` reuse not yet) |
| `YC` | **Consent phishing.** Client metadata `client_name` and logo copy another agent's | 4.5, **N14** | none | Consent page shows the `client_id` host. Checked by the consent hook or Playwright reading the page | Not yet (needs a consent-page reader) |
| `YM` | **Mediated credential stuffing**; operations confirmed twice or without approval | 4.7, Ops | `exchange.performed-twice`, `confirm.approved-by` | 429 with `Retry-After`; performed once | Not yet (needs an attack for repeated confirms over the wire) |

#### The fault-injection proxy

A `faults` list on a scenario lets the proxy act as the network adversary and as Jepsen's nemesis, with no new adapter, against any pair of our own implementations:

- **`replay`**: resend an honest request verbatim, later, from the proxy. This tests a Company's `jti` and DPoP replay defences against an honest agent (A5-style).
- **`drop_response`**: drop the response to a token request. N5: the agent retries with the old Account Token. Does a Company with reuse detection sign the User out?
- **`duplicate`**: send a POST twice. This tests message-id and confirm idempotency (S9, Ops `O2`).
- **`delay`, `truncate`, `reset`, `status:503`**: test SSE resume (N30), `Retry-After`, and that the agent gives up cleanly.

Injected exchanges are marked in the HAR (`_interop.injected`), and checks skip them, so an injected request is never blamed on the agent.

## Prioritised plan

Restricted to our own project: the adversarial sides (`evil-agent`, `evil-company`) and the fault proxy run only against our `owner: "self"` implementations, on the local lane, never live. No flag lifts this; see [`SECURITY.md`](../SECURITY.md) and [`interop-spec.md`](interop-spec.md) §13.

1. **Proxy `replay` and `duplicate`** against the existing grid (scenarios `N`, `C`, `CI`, `O`). No new adapter. **Done:** scenarios `NREP` (replay), `CDUP`/`CIDUP`/`ODUP` (duplicate), `adversary: "network"`, injected exchanges marked and skipped.
2. **The contract and attribution changes:** the `adversarial` registry flag, `arm`, `faults`, `permitted_by`, harm oracles, the attack-observed precondition, rule 0, the security grid page, and live-lane exclusion. **Done:** registry `owner`/`adversarial`, manifest `attacks`, `arm`/`attack` ops and the `arm` hook, harm-oracle `assert_trace` predicates, rule 0, the security grid, the own-project refusal and `--image-tag`; unit-tested in `interop/test/adversarial.test.ts`.
3. **`evil-agent` from `TAMPERS`:** YR, YD, YA, YT, YS and YK first; then YO (S8), YU (S17) and YF (N2). **Done:** `YR`, `YD`, `YA`, `YT`, `YS`, `YK`, `YU` (with a new `conversation.cross-user` mock check and TAMPERS row); YO handled by fixing the mock's `start()` ownership gate (Workers test). **Not yet:** YF (two-User Direct Sign-In), YM (repeated confirms over the wire).
4. **`evil-company` core:** XM, XI, XH (N10), XB and XN. **Done:** `XH` (N10) and `XI`. **Dropped:** `XK`, which our client never observes because it caches the validated documents (N44). **Not yet:** XM (two Companies in one cell), XB/XN (mock oversized/nonce-loop options). XS needs the N42 "private" suffix.
5. **Operations and consent:** XO, XP and YC (N14), adding a `display` op for agents and a consent-page reader for Companies. **Not yet.**
6. **Injected text:** XJ, then a model lane for N15. **Done in the Workers suite:** `test/prompt-injection.test.ts` injects instructions through a Company message, an operation summary and an MCP tool description, and a faux model obeys them; nothing is confirmed or sent as the User. **Not yet in the interop harness**, which has no model lane (the `no_secret_in` harm oracle is built).
7. **Fairness:** the `block_agent` hook and the `BX` refused-agent scenario. **Done:** the `arm block` hook and scenario `BX`. Spec text for refusal reasons and honest fallback browsing still needs the draft's authors.
8. **Disclosure process** before any adversarial result is committed. **Done:** [`SECURITY.md`](../SECURITY.md); spec-permitted attacks go to the authors as N-numbered issues in [`spec-issues.md`](spec-issues.md).

## What our own project can and can't test

What adversarial testing restricted to our own project covers, and what it misses by design:

- **Can test, over the wire:** our client's refusals of a malicious Company (`evil-company`: XH/N10, XI), our mock's refusals of a malicious agent (`evil-agent`: YR, YD, YA, YT, YS, YK, YU), both sides' resilience to a network adversary (the fault proxy: replay, duplicate, and the timing faults), and fairness (BX). The harm oracles (`token_not_sent_to`, `no_request_to`, `no_2xx_after`, `no_secret_in`, `performed_at_most_once`) judge the trace, not either side's opinion.
- **Can't test here:**
  - **Other projects' defences.** Running `evil-agent`/`evil-company` against a third-party implementation is forbidden (the own-project rule): a real refusal there may be a vulnerability, which goes through disclosure first. So our grid says nothing about whether *their* client refuses *our* malicious Company, only about ours.
  - **Prompt injection over the wire.** The interop harness drives protocol code with no model, so it has no model lane. Prompt injection is tested in the Workers suite instead (`test/prompt-injection.test.ts`): a faux model that obeys any instruction it reads can't confirm an operation, speak as the User or send a credential, because no tool can. A real model's susceptibility (the lethal trifecta, AgentDojo) isn't measured.
  - **Live deployments.** The live lane never runs adversarial cells. We never attack a public deployment, so these results come only from containers on the private network.

## Sources

- Competitive compatibility: [EFF, Adversarial Interoperability (2019)](https://www.eff.org/deeplinks/2019/10/adversarial-interoperability); [EFF podcast (2020)](https://www.eff.org/deeplinks/2020/11/podcast-episode-control-over-users-competitors-and-critics); [Doctorow on W3C list (2021)](https://lists.w3.org/Archives/Public/public-interop-remedies/2021Nov/0007.html); [ProMarket (2022)](https://www.promarket.org/2022/04/15/seize-the-means-of-computation/); [The Internet Con](https://newbooksnetwork.com/the-internet-con)
- Law and policy: [hiQ v. LinkedIn settlement](https://www.natlawreview.com/article/linkedin-s-data-scraping-battle-hiq-labs-ends-proposed-judgment); [PSD2 RTS (Jones Day)](https://www.jonesday.com/en/insights/2018/03/eu-regulatory-technical-standards-for-strong-custo); [PSD2 fallback (Pinsent Masons)](https://www.pinsentmasons.com/out-law/news/eba-refuses-to-cave-in-to-commission-proposals-on-psd2-interfaces); [CFPB 1033](https://www.consumerfinance.gov/compliance/compliance-resources/other-applicable-requirements/personal-financial-data-rights/); [Cooley on 1033](https://www.cooley.com/news/insight/2025/2025-08-27-cfpb-reconsiders-section-1033-rule-signaling-potential-overhaul-of-personal-financial-data-rights-framework); [FSFE on DMA 6(7)](https://fsfe.org/news/2025/news-20250403-01.html); [ARTICLE 19 on DMA](https://www.article19.org/resources/digital-markets-act-reaction-to-commissions-decision-on-requesting-apple-interoperability/); [Amazon v. Perplexity (PPC Land)](https://ppc.land/amazon-sues-perplexity-over-covert-ai-agent-access-to-marketplace/); [Silicon UK](https://www.silicon.co.uk/e-regulation/legal/amazon-lawsuit-perplexity-ai-627405/amp)
- Agent identity: [Cloudflare verified bots](https://blog.cloudflare.com/verified-bots-with-cryptography); [Cloudflare signed agents](https://blog.cloudflare.com/signed-agents); [draft-ietf-webbotauth-httpsig-protocol](https://datatracker.ietf.org/doc/draft-ietf-webbotauth-httpsig-protocol/)
- Poppy: [spec](https://personalagentprotocol.org/spec); [overview](https://personalagentprotocol.org/overview); [Sierra announcement](https://sierra.ai/blog/poppy); our [spec-issues.md](spec-issues.md), [poppy-issues.md](poppy-issues.md), [interop-spec.md](interop-spec.md)
- Security testing: [Byzantine Generals](https://people.cs.umass.edu/~arun/cs677/reading/LSP.pdf); [BoGo](https://boringssl.googlesource.com/boringssl/+/main/ssl/test); [tlsfuzzer](https://github.com/tlsfuzzer/tlsfuzzer); [TLS-Attacker](https://www.nds.ruhr-uni-bochum.de/media/nds/veroeffentlichungen/2016/10/19/tls-attacker-ccs16.pdf); [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html); [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207); [Fett et al. CCS 2016](https://arxiv.org/abs/1601.01229); [summary](https://blog.acolyer.org/2016/11/07/a-comprehensive-formal-security-analysis-of-oauth-2-0/); [OIDC analysis](https://arxiv.org/abs/1704.08539); [FAPI analysis](https://arxiv.org/abs/1901.11520); [Do not trust me](https://nds.rub.de/research/publications/openid); [SoK SSO](https://www.nds.ruhr-uni-bochum.de/research/publications/sok-single-sign-security-evaluation-openid-connect); [OIDF RP testing](https://openid.net/certification/rp_testing/); [OIDF Brazil RP guide](https://openid.net/certification/fapi-rp-conformance-testing-certification-submission-overview-for-open-banking-brazil/); [OIDF issue 1375](https://gitlab.com/openid/conformance-suite/-/issues/1375); [McLean JWT](https://auth0.com/blog/critical-vulnerabilities-in-json-web-token-libraries/); [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725); [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html); [PortSwigger OAuth](https://portswigger.net/web-security/oauth/preventing); [WPT crashtests](https://web-platform-tests.org/writing-tests/crashtest.html); [Jepsen (CNCF)](https://cncf.io/blog/2024/02/19/analysis-of-xline-jepsen-tests); [Toxiproxy](https://github.com/Shopify/toxiproxy)
- Agents: [Lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/); [Tool poisoning](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks); [AgentDojo](https://arxiv.org/abs/2406.13352)
