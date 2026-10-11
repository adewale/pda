# Problems in the Personal Agent Protocol specification

Problems we found in [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) Draft 0.1 ("Updated Oct 9, 2026"), its Guides and the Operations extension v1, written so they can go to the spec's authors. Each has a suggested fix and says what our client does meanwhile. [readings.md](readings.md) records, for the S-numbered questions, which reading our client and our strict and lenient mock Companies take, and why.

## How we found them

- **Building a client.** We built a Personal Agent client and a strict mock Company, which records a named violation for each check it makes (`test/mock-company/violations.ts`).
- **Running it under different readings.** Our conformance tests run under six readings of the questions below.
- **Reading other implementations.** We read the other implementations listed in [implementations.md](implementations.md); their issues are in [poppy-issues.md](poppy-issues.md). Their disagreements are often the evidence for an issue here.
- **A discovery-document validator** ([`src/validator/`](../src/validator)).
- **An interop grid.** Our [harness](interop-spec.md) runs agents against Companies from several projects, in containers, through a recording proxy; [a summary of the 11 October run](interop-results/README.md) is committed. Where two implementations that each pass alone fail together, the cause is usually one of the issues here, and the row says "Grid:".
- **A full crawl of the site on 11 October 2026.**
  - The sitemap lists nine pages: home, overview, spec, extensions, Operations, guides, open topics, license, contributions.
  - There's no `llms.txt`, changelog or public source repository; the only copy of the source is in poppyseed.
  - The home page's walkthrough traces exist only in a JavaScript bundle.
  - The spec has 107 sentences with RFC 2119 keywords: Personal Agent 43, Company 51, both 13. About 70 more requirements carry no keyword. Operations has 20, and the Guides about 138 recommendations.

**IDs.** S-numbers came from comparing implementations, N-numbers from the crawl and later work, including the grid. Our tests and docs cite them, so they don't change.

**Severity:**
- **Interop:** two conforming implementations can fail to work together.
- **Security:** a security or privacy risk.
- **Clarity:** underspecified, though implementations mostly agree.
- **Editorial:** examples or cross-references that contradict the text.

## The most important

| ID | Problem | Severity |
| --- | --- | --- |
| [N2](#n2) | Sign-in isn't bound to the Session or the User until the code is exchanged | Security |
| [N4](#n4) | Revoking the old Account Token after a step-up, as 4.4 asks, signs out every other Session | Interop |
| [N9](#n9) | Most `poppy.json` URLs needn't be HTTPS, including the one that receives passwords | Security |
| [N10](#n10) | Which hosts may receive Session Tokens is undefined | Security |
| [N11](#n11) | A shared issuer merges unrelated Companies and shares User IDs between them | Security |
| [N16](#n16) | Three sections disagree on what happens to an open conversation at sign-out | Interop |
| [N19](#n19) | An operation proposed in a signed-out Session can deadlock | Interop |
| [N22](#n22) | No way to offer two versions at once | Interop |
| [S1](#s1) | The client assertion's `aud` is never stated | Interop |
| [S2](#s2) | Whether assertions need `typ`, `kid` and a short lifetime | Interop |
| [N36](#n36) | Whether the issuer may be on another host or path than the Company | Interop |
| [S3](#s3) | Where metadata lives for an issuer with a path | Interop |
| [S23](#s23) | Whether DPoP nonces are per origin or per Company | Interop |

## Discovery and metadata (spec 3)

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="s3"></a>S3 | Interop | **Where metadata lives for an issuer with a path** (3.2). RFC 8414 inserts the well-known segment before the path; the draft only shows an issuer with no path. everruns appends; others insert. | Say "per RFC 8414 §3.1", with a path example. | [Our reading](readings.md#s3) |
| <a id="s7"></a>S7 | Interop | **Trailing slashes.** "Exactly" (3.2) makes `https://a.example` and `https://a.example/` different issuers. Datalayer's client strips the slash. | Keep exact comparison and say so, with this example. | [Our reading](readings.md#s7) |
| <a id="s18"></a>S18 | Clarity | **`web` has no URL** (3.1). `web: {}` and `apis: []` have no stated meaning, and `organization.name` isn't said to be required. Ilmer invents `web.url`. | Add `web.url`; say what empty means; mark `name` required. | The validator warns on a missing `name`. |
| <a id="n9"></a>N9 | Security | **Most URLs needn't be HTTPS.** Only `issuer` and conversation endpoints must be (#fields). These are open: `apis[].url`, `auth.mediated.endpoint` (which receives passwords), `web.browser_session_endpoint`, extension endpoints, and an operation's `url`. None has to be on the Company's hosts, and an off-domain operation `url` can't be a browser join's `return_to`. | Every URL MUST be HTTPS. The mediated endpoint MUST be on the issuer's host or `organization.domain`. | The validator requires HTTPS for every URL in `poppy.json`. |
| <a id="n24"></a>N24 | Editorial | **The metadata examples break RFC 8414.** They omit `response_types_supported`, which RFC 8414 §2 requires. They also don't show `authorization_response_iss_parameter_supported`, `dpop_signing_alg_values_supported` or `token_endpoint_auth_methods_supported`. | Complete the example. | The validator checks the latter three. |
| <a id="n26"></a>N26 | Clarity | **Extension endpoints and `auth`.** The rule for when `auth` is required (3.1) leaves out extension endpoints, which need Session Tokens. | Include them. | n/a |
| <a id="n27"></a>N27 | Clarity | **Subdomains.** `poppy.json` may be on a subdomain (3), but `organization.domain` must equal the host requested. Nothing says how an agent finds `shop.example.com` from `example.com`, and `return_to` can't reach the apex. | Say how discovery reaches a subdomain. | Discover the host the User names. |
| <a id="n36"></a>N36 | Interop | **Issuer and origin.** 3.2 lets domains name an issuer, and its examples put the issuer on the Company's host, but nothing says the issuer may be on another host (`auth.example.com`) or have a path. Grid: poppy-demo's agent requires the issuer to equal the Company's origin, so it fails every scenario at our mock (`auth.…`) and adonis-agora (`…/poppy`). | Say the issuer is any HTTPS URL the Company controls, with an example on another host and one with a path (see S3). | Any issuer the document names, compared exactly. |
| <a id="n37"></a>N37 | Interop | **Redirects at `/.well-known/poppy.json`.** The draft is silent. everruns documents a 302 from the website to its channel; withpoppyseed.dev 308-redirects the apex to `www.`, including its OAuth endpoints. Agents differ on following them, and on which host `organization.domain` must then equal. | Allow a few HTTPS redirects for `poppy.json` only, with `organization.domain` compared to the host the User named; forbid redirects on OAuth endpoints and `client_id`. | Follow up to three HTTPS redirects for `poppy.json`; none for `client_id`; compare `organization.domain` with the host named. |
| <a id="n44"></a>N44 | Security | **When to fetch `poppy.json` and API descriptions again.** The draft says to cache discovery documents by their HTTP caching headers but never says when an agent must fetch and check them again: before every Session, before a sign-in, or only when the cache expires. A Company, or whoever takes over its hosting, can move an endpoint between discovery and a later call (a "rug pull"), and an agent that keeps using a document it validated earlier never sees the move, while one that re-fetches mid-task may see a document it has never checked. The same goes for an OpenAPI description's `servers` and an MCP server's protected resource metadata. | Say an agent MUST NOT use a document past its cache lifetime without fetching and validating it again, that every fetch is validated as discovery is (domain, issuer and token hosts), and give a maximum lifetime. | We cache `poppy.json`, the issuer's metadata and each OpenAPI description by their caching headers, bounded to between a minute and a day, and validate each fetch in full; within that lifetime a moved endpoint isn't seen. Our adversarial `XK` attack was dropped for this reason (see [adversarial-interop.md](adversarial-interop.md#malicious-company-scenarios)). |

## Agent identity and assertions (4.1, 4.2)

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="s1"></a>S1 | Interop | **The client assertion's `aud`** at the token, revocation and device endpoints is never stated. Implementations accept the exact endpoint, the token endpoint, or the issuer. Grid: adonis-agora's agent uses the token endpoint everywhere; poppyseed, poppy-demo, pi-poppy's Company and both Datalayer Companies require the endpoint called, so adonis-agora fails Device Sign-In and sign-out at poppyseed, pi-poppy and Datalayer. | Name it: the endpoint called. | [Our reading](readings.md#s1) |
| <a id="s2"></a>S2 | Interop | **Assertion `typ` and lifetime** are unspecified. Only browser assertions get "60 seconds"; the Guides say "reject a long lifetime" without a number. Strict Companies require `typ: "JWT"`, a `kid` and 60 s or less; others accept 300 s. Grid: pi-poppy's and adonis-agora's agents send no `typ`, so every signed-in or signed-out cell fails at a strict Company (our strict mock, poppy-demo's Northstar, Ilmer), and nothing past the first Session is tested. | State `typ`, `kid` and a maximum. | [Our reading](readings.md#s2) |
| <a id="n25"></a>N25 | Security | **Client and Session assertions can be confused.** Both are signed with the same keys and carry the same `iss` and `aud`; they differ only in `sub`. everruns doesn't check `sub == client_id`. | Give them distinct `typ` values, and require that check. | n/a |
| <a id="s6"></a>S6 | Clarity | **"Same domain"** for `jwks_uri` and `redirect_uris` isn't defined: host, registrable domain, or port too? Redirects on the `client_id` fetch aren't addressed. | Define it; forbid redirects on `client_id`. | Same host or parent/child host; a redirect is an error. |
| <a id="s21"></a>S21 | Clarity | **Local agents.** An HTTPS `client_id` on the same domain as the redirect URIs rules out an agent on someone's laptop unless it has a hosted identity. pi-poppy, poppyseed and Ilmer's tests use loopback `client_id`s. | A short note: hosted identity, or Device Sign-In. | Hosted identity. |
| <a id="n23"></a>N23 | Interop | **The client metadata example has no `grant_types`**, so RFC 7591's default (`authorization_code` only) applies, though the agent uses jwt-bearer, refresh_token and device_code. It also lacks `dpop_bound_access_tokens`. | Add both. | n/a |
| <a id="s19"></a>S19 | Interop | **Algorithms.** Is ES256 required, or only preferred? withpoppyseed.dev advertises RS256 only. | Make ES256 mandatory to implement. | ES256. |
| <a id="n38"></a>N38 | Interop | **Key rotation and JWKS caching.** The Guides describe rotating keys but don't say a new key needs a new `kid`, how long a Company may cache a JWKS, or whether it refetches on an unknown `kid`. Grid: poppy-demo keeps `kid: agent-key-1` across rotations; pi-poppy's Company answers an unknown `kid` with `invalid_client` and doesn't refetch for 60 s; AuthKit caches for 30 s. An agent that rotates is refused for up to a minute. | A new key MUST have a new `kid`; a Company SHOULD refetch once, rate-limited, on an unknown `kid`; state a maximum cache time. | Each key has its own `kid`; the old key stays published until its signatures expire. |

## Sessions and tokens (4.2, 4.3, 4.8)

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="s4"></a>S4 | Interop | **Signed-out `scope`.** "A signed-out token has none" (4.2) conflicts with Companies that gate conversations on `poppy:read`. 4.3 allows `scope` on any token request, yet three Companies reject it on the jwt-bearer grant. | Say what `scope` means there, or forbid it. | [Our reading](readings.md#s4) |
| <a id="n6"></a>N6 | Interop | **Required token response fields aren't listed.** `scope`, `session_id` and `signed_in` aren't marked required, and stock OAuth servers omit `scope` when it's unchanged. `"scope": ""` isn't valid RFC 6749 syntax. | List them; omit `scope` when it's empty. | A missing `scope` is taken as the scope requested (RFC 6749 §5.1), or as the scope already held when none was requested. |
| <a id="s5"></a>S5 | Interop | **Renewing a signed-in Session with an assertion** has no defined error. Companies keep it signed in, silently sign it out, or return `invalid_grant`. | Define the error. | Renew with the Account Token. |
| <a id="n4"></a>N4 | Interop | **Step-up revocation signs out parallel Sessions.** 4.4 says to revoke the replaced Account Token; 4.9 says revoking signs out every Session signed in with it, perhaps including the one just stepped up. Rotation raises the same question, and so do two sign-ins to one account: is a Session signed in "with" a token, with the sign-in it rotated from, or with the account? Our own mock took the widest reading, signing out every Session of the account, until the Hypothesis model (`test/hypothesis`) caught it; it now signs out the Sessions signed in with that token or one it rotated from. | Sign Sessions in to the account grant, which outlives the token that started it, and say revoking one grant leaves others alone. | We revoke, as 4.4 asks. The mock signs out the revoked grant's Sessions only. |
| <a id="n5"></a>N5 | Interop | **Rotation has no recovery.** If the response carrying a rotated token is lost, the retry reuses the old one, and a server following the OAuth security BCP revokes the whole family: the User is silently signed out. | A grace period for reuse, or idempotent retries. | We serialise token use per Company. |
| <a id="n28"></a>N28 | Clarity | **Account Token lifetime.** 4.8 gives `refresh_token_expires_in`, but the Guides say to expire unused tokens sooner, which the agent can't see. | Signal idle expiry. | Treat `invalid_grant` as signed out. |
| <a id="s14"></a>S14 | Interop | **DPoP error status at resource servers** (400 or 401?) isn't stated, and some Companies send no `WWW-Authenticate`. | State it. | Read the header, then the body. |
| <a id="n1"></a>N1 | Interop | **DPoP at the device and revocation endpoints.** "A new proof for every request, including token requests" (#sending-tokens), but the device and sign-out examples carry none, and RFC 9449 doesn't define proofs there. | Proofs only at the token endpoint and resources; Companies MUST ignore them elsewhere. | n/a |
| <a id="s23"></a>S23 | Interop | **Nonces "for that server"** (Guides): per origin, or per Company? | Say per origin. | [Our reading](readings.md#s23) |
| <a id="n35"></a>N35 | Clarity | **One DPoP key per User?** 4.3 says the agent "generates a key pair for each User at each Company", with no keyword, and nothing says whether a Company may refuse a key it has already bound for another User. | Say SHOULD or MUST, and what a Company does with a shared key. | A key per User per issuer. The mock records a shared key but still issues the token. |
| <a id="n39"></a>N39 | Interop | **The error for an ended Session.** 4.2 says an ended Session gets `invalid_session`, but not where: at resources, at the token endpoint on renewal, or both. Grid: Datalayer answers an ended Session with `invalid_token` everywhere; pi-poppy's agent renews on `invalid_token`, gets `invalid_session` from the token endpoint, and gives up instead of starting a new Session. See also S13. | `invalid_session` at both, and say the agent starts a new Session on it. | Start a new Session on `invalid_session` from either; renew on `invalid_token` at a resource. |

## Sign-in (4.4 to 4.9)

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="n2"></a>N2 | Security | **Sign-in isn't bound until the exchange.** `session_id` appears only when the code is exchanged or the device code polled, and the Company checks only the `client_id`, not the User ID. A code can be redeemed into another User's Session of the same agent, and the Account Token records the wrong User. A missing `session_id` is undefined. | Bind `session_id` at the start (authorization or device request, or PAR); check the User ID; define the error. | `state` is single-use, and the code is exchanged into the Session that started the sign-in. |
| <a id="n3"></a>N3 | Interop | **A different account at sign-in.** If the User picks another account during 4.5 to 4.7, the code is already spent, and it's undefined whether an Account Token is issued. There's no account hint. | Issue the Account Token with a new `session_id`. | Start a new Session on `account_mismatch`. |
| <a id="s16"></a>S16 | Clarity | **Approving zero scopes:** signed in with `scope: ""`, or `access_denied`? | `access_denied`. | n/a |
| <a id="n7"></a>N7 | Interop | **Mediated Sign-In's wire contract is incomplete.** Undefined: HTTP status for `failed`, `expired` and `code_required`; the error format for `invalid_scope` (it isn't OAuth here); errors for a missing field, an unknown `sign_in_id`, another Session or an account mismatch; `expires_at` on the first step; `refresh_token_expires_in`. | Define them. | Handle the documented shapes. |
| <a id="n8"></a>N8 | Security | **Mediated Sign-In has no consent step.** No Company page is shown, and nothing requires the agent to get the User's agreement to the scopes. | The agent MUST get consent; Companies SHOULD notify the User. | The User enters credentials on our card, which names the scopes. |
| <a id="n14"></a>N14 | Security | **Phishing on consent.** The consent page shows "the name and logo from its metadata document", which the agent chooses itself; only the Guides add the `client_id` domain. Ops 5.1 shows the Company's self-declared name. | MUST show the `client_id` host, and the Company's domain. | Our cards show the Company's verified `organization.domain` under its name. The consent page is the Company's. |
| <a id="n32"></a>N32 | Editorial | **`iss` on redirects.** The Guides say "Return `iss` in every redirect, success or error (MUST, 4.5)", but 4.5 says it only for success and `access_denied`. | Align them. | We require `iss` on every redirect, and it must equal the issuer. |
| <a id="n45"></a>N45 | Security | **A lost code-exchange answer orphans an Account Token.** If the answer to the code exchange (4.5), or the device-code poll that succeeds (4.6), is lost (a timeout, a dropped connection, a 5xx from a proxy after the Company acted), the Company has signed the Session in and issued an Account Token the agent never received. The code is single-use, so it can't be exchanged again; the agent can't renew that Session, because renewing a signed-in Session needs the Account Token (and S5 leaves an assertion's answer undefined); and it can't revoke the token, because revocation needs the token. The grant stays live until it expires, and the User sees an account connected to an agent that doesn't hold it. The draft has no idempotent exchange and no recovery. See also N5. | Let a retried exchange with the same code, verifier and `session_id` return the same answer for a short window, or let an agent revoke by `session_id` with its client assertion; say a Company ends the Session's grant when that happens. | We abandon that Session (it is never renewed with the assertion) and start a new one; the card says the sign-in was interrupted, and the User signs in again. The orphaned grant is left to expire at the Company. |

## Web browsing (5)

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="n13"></a>N13 | Security | **The browser cookie is a bearer credential.** It isn't bound to a key, lives as long as the Session, and may be `SameSite=None`, so other pages in the agent's browser send it cross-site. `Lax` is enough for the POST, 303 and GET. | Require `Lax`; recommend short lifetimes. | One browser context per Session of each User, replaced with the Session; cookies host-only and sent only to that host, and no other site's pages load in it. |
| <a id="n43"></a>N43 | Security | **Website actions have no approval step.** The Operations extension gives an API write a propose-and-confirm step the User approves, but once the agent's browser joins the Session (5) it can submit any form on the Company's website (place an order, change an address, cancel a plan) and nothing in the draft says which submissions are consequential or that the User must approve them. An agent that gates API writes can be routed around through the website, and a Company can't tell an approved submission from an unapproved one. | Say that a Personal Agent MUST get the User's approval before a website submission that a write through the Company's API would need approved, or let a Company mark forms (or URLs) as consequential, or route them through Operations by returning a proposal instead of acting. | Every form submission waits for the User's approval on a card listing exactly what will be sent, and exactly that is sent; `click` follows links only, so it can't submit a form. |

## APIs (6)

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="n10"></a>N10 | Security | **Which hosts may receive Session Tokens** is undefined. "One DPoP Session Token works at all of a Company's services" (4.3), but an OpenAPI description's `servers` can name any host, and its `securitySchemes` can conflict with Poppy's DPoP rule. | Send tokens only to hosts listed in `poppy.json`, or under `organization.domain` or `poppy_domains`. | We send only to hosts `poppy.json` lists, or under `organization.domain` or a `poppy_domains` entry, and refuse a description whose server is elsewhere. |
| <a id="n17"></a>N17 | Security | **Bearer issuance isn't normative.** Companies must accept Bearer only at MCP servers, but nothing says the token endpoint MUST issue Bearer only for a listed MCP `url`. poppyseed treats any `resource` as a Bearer request, a downgrade. | Require it. | We ask for Bearer only for MCP. |
| <a id="n18"></a>N18 | Clarity | **MCP clients that don't implement Poppy.** Their sign-in "starts a new signed-in Session" with no User ID or `session_id`, and it's unclear whether their refresh tokens are Account Tokens. | Define it. | n/a |
| <a id="s13"></a>S13 | Interop | **API errors for an ended Session.** Section 6 lists only three errors; poppy-demo returns 400 `invalid_session` with no `WWW-Authenticate`. | Add `invalid_session`, or require `invalid_token`. | Start a new Session on either. |
| <a id="s22"></a>S22 | Interop | **Which writes propose operations.** A Company may use operations for some actions and not others. poppyseed marks them with `x-poppy-operation: true`. | Standardise a marker. | Expect a proposal from any write at a Company with operations. |

## Conversations (7)

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="n16"></a>N16 | Interop | **Sign-out vs open conversations.** 4.9: "an open conversation carries on" signed out. 7.11: the same User signed out gets `sign_in_required`. 7.13: another account gets `conversation_not_found`. The Guides: close conversations that used the account. | Pick one. | Follow whichever error comes back. |
| <a id="s8"></a>S8 | Security | **Retries after sign-out.** 7.3 returns "the original response" to a retry; 7.11 requires sign-in. poppy-demo returns the original, which can include account data. So did our mock, for a retried first message, until the Hypothesis model (`test/hypothesis`) caught it. | 7.11 wins. | The mock answers 7.11 first. |
| <a id="s9"></a>S9 | Interop | **Message-id idempotency.** Per conversation? A retry while the first is in flight? What "the original response" includes? May a retry of a conversation's first message go to the conversation it started, instead of starting it again? Grid: Companies split on that. Our mock, both Datalayer Companies and pi-poppy's accept it; poppy-demo, poppyseed, Ilmer and adonis-agora answer `message_id_conflict`. everruns' PR #4531 met it from pi-poppy's agent and changed its Company to accept it, matching a retry on the message alone. And what is "the same content": the same bytes, or the same JSON value? Our mock compared serialisations, so a retry with its members in another order was a `message_id_conflict`, until the Hypothesis model (`test/hypothesis`) caught it. | Define all three, and say the same content is the same JSON value (RFC 8259: members are unordered). | 128-bit ids, reused on retry with the same bytes. The mock compares JSON values. |
| <a id="s10"></a>S10 | Clarity | **Cursor on an empty first read.** `null`, `""` and `start_<id>` all appear. | Define it. | Opaque; store only strings. |
| <a id="n30"></a>N30 | Interop | **SSE.** A stream never conveys the starting `status`. `wait` on a stream, and `Last-Event-ID` with `cursor`, are undefined, as are when headers are sent and how soon an agent reconnects. Grid: adonis-agora sends no headers on an idle resumed stream until an event arrives; Datalayer's Companies close after sending the backlog; Datalayer's TypeScript agent reconnects with no delay, ignoring `retry:`, and gives up after five tries. | Send headers and a status event at once, keep-alive comments while idle; agents honour `retry:`; define `wait` and `Last-Event-ID`. | n/a |
| <a id="s11"></a>S11 | Clarity | **`sign_in_required` has no `scope`.** | Add it. | Request the scopes the task needs. |
| <a id="s12"></a>S12 | Interop | **Direct Conversations.** May the agent send `sender: "agent"` messages? Unsupported ones come back three ways: 400 `invalid_request`, 400 `direct_conversations_not_supported`, or `conversation_not_found`. | One error; say who may send. | Report the error. Only the User's words go there; the mock records the agent's own, first or later. |
| <a id="s15"></a>S15 | Clarity | **`queued` on handoff** is mandatory but impractical without a human queue. | Make it optional. | Don't depend on it. |
| <a id="s17"></a>S17 | Clarity | **"Belongs to that account":** can another User ID signed in to the same account continue a conversation? | Define it. | n/a |
| <a id="n21"></a>N21 | Interop | **No generic error** in 7.13 for a malformed message. Unclear which error means "the parent is itself a Direct Conversation". | Add `invalid_request`; name that case. | Report the error. |
| <a id="n29"></a>N29 | Clarity | **`context`** can't clear a field, and it's unclear whether it carries into Direct or new conversations. | Define both. | Send only what changed. |
| <a id="n40"></a>N40 | Interop | **`wait` is a hint, but examples read like a promise.** 7.3's example returns the Company's reply in the send response. Grid: poppyseed honours `wait` only on `GET …/events`, so an agent that expects the reply from the send never sees it. | Say a Company MAY ignore `wait` and the agent MUST read events for the reply. | Read in the background when the reply isn't in the response. |
| <a id="n31"></a>N31 | Clarity | **Declining `user_requested`** is free text only. | A structured signal. | n/a |

## Operations extension

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="n19"></a>N19 | Interop | **An operation from a signed-out Session can deadlock.** Ops 3.2 limits it to its Session. Sessions end with `invalid_session`, and Ops 6 forbids a new proposal until the operation is final, which `operation_not_found` then prevents. | Bind operations to the User ID, or make `operation_not_found` final. | Stop tracking it, as if final. |
| <a id="n34"></a>N34 | Interop | **Which new proposals Ops 6 forbids.** "MUST NOT ask for a new proposal of the same action until the operation is final" sits in the paragraph about a failed confirm, so it's unclear whether it applies before any confirm. "The same action" isn't defined (3.1 makes a different size a new revision of the same operation), and before a confirm a Company can't tell a forbidden re-ask from a repeat through another channel, which Ops 4 says to answer with the existing operation. | State it for any operation the agent knows of that isn't final, and say a Company returns that operation. | We refuse to repeat the write that proposed an operation we've tried to confirm until it's final. The mock records only that case. |
| <a id="n20"></a>N20 | Interop | **Statuses and errors** are undefined: the HTTP status of confirm, cancel and read (200 or 202 for `in_progress`); the error for a malformed confirm; whether `user_approval_required` carries `operation`. | Define them. | n/a |
| <a id="n41"></a>N41 | Interop | **`null` for an optional member.** Nothing says whether an optional member may be `null` rather than absent, here or in the core protocol. Grid: Datalayer sends `"expires_at": null` on confirm and `"result": {"data": null}` on cancel; pi-poppy rejects both, so it reports a performed operation as failed. | Omit optional members; receivers treat `null` as absent. | Treat `null` as absent. |
| <a id="s20"></a>S20 | Security | **Standing permissions have no checkable action.** There's no standard action field, money has no direction, and an approval can't be proved to the Company. | An action field; signed amounts; a proof of approval. | Match a summary word and `{ amount, currency }`. |

## Versions and extensions

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="n22"></a>N22 | Interop | **Offering two versions at once.** One `protocol_version` per `poppy.json`; client metadata has no version; one entry per extension, so a Company can't offer two major versions during a migration. `version`'s type (a string in the examples) isn't stated. | Allow a list; state the type. | Our validator keeps one profile per major version. |

## Privacy and security considerations

| ID | Severity | Problem | Suggested fix | What we do |
| --- | --- | --- | --- | --- |
| <a id="n11"></a>N11 | Security | **A shared issuer merges Companies.** Domains naming one issuer "are then one Company: the same User IDs" (3.2). A multi-tenant identity provider with one issuer shares User IDs across unrelated Companies, defeating 4.2. | Issuers MUST be per Company (path issuers; see S3). | User IDs per issuer. |
| <a id="n12"></a>N12 | Security | **Signed-out tracking can't be reset.** The User ID is permanent: one sign-in links all earlier signed-out activity, and Account Tokens are tied to it. | A User-controlled reset; Companies MUST NOT rely on permanence. | n/a |
| <a id="n15"></a>N15 | Security | **No prompt-injection considerations.** Company text, data, summaries, API and MCP descriptions and web pages all reach a model. Only Ops 5.1 and 7.11 touch on it. | A Security Considerations section. | Company text is data, never approval; only the page approves. |
| <a id="n42"></a>N42 | Security | **No test mode.** The SSRF rules (Guides) forbid private addresses and loopback, so an implementation can't be tested against another without a relaxation, and each invents its own: poppyseed's `allowInsecureClients`, AuthKit's `allowInsecureClientIds` (which also allows `http` `client_id`s), pi-poppy's and Datalayer's private-address settings. Broad switches like these are easy to leave on in production. | A Guides note: a test mode limited to a named reserved suffix (such as `.test`), HTTPS only, off by default. | Our harness names `*.interop.test` and needed no relaxation for our client; see [interop-spec.md](interop-spec.md) §3. |

## Editorial

| ID | Problem | Suggested fix |
| --- | --- | --- |
| <a id="n33"></a>N33 | **Inconsistent examples.** Ops 4.3 reuses `evt_c2` and `msg_r2Kq` from 7.5 with different content. Money appears as `70`, `{amount: "70.00", currency}` and `{amount: 48}`. The order is `#1042` in 7.3 but `ord_7Hk2` elsewhere. Ops §9 cites "section 3" for `extension_required` (it's 3.3). §6 uses `invalid_token` for a missing token, where RFC 6750 sends no error code. | Align them. |

## Adversarial interop coverage

Which attack exercises which issue, and its status, is kept in one place: the attack tables of [adversarial-interop.md](adversarial-interop.md#malicious-company-scenarios). The issues they cite:

- [N10](#n10): `XH`.
- [N44](#n44): `XK`, dropped.
- [S1](#s1): `YA`.
- [N2](#n2): `YF`.
- [S8](#s8): `YO`.
- [S17](#s17): `YU`.
- [N14](#n14): `XP` and `YC`.
- [N15](#n15): `XJ`.

## Open topics, with our view

- **Payments.** Ops already covers approval. A payment extension could sit on Ops, with amounts in a standard `{amount: string, currency}`, which would also fix S20 and N33.
- **Push notifications.** We poll every 30 seconds to 15 minutes. Suggest a `notification_uri` in client metadata, receiving signed, content-free "events available" pings, after which the agent reads with its cursor.
- **Attachments.** HTTPS URLs on the Company's hosts, fetched with DPoP, with a declared type and size. Forms go through Ops or `url`.
- **Missing from the list:**
  - version negotiation (N22);
  - a security considerations section (N15);
  - resetting a User ID (N12);
  - a shared conformance suite (see [interop-testing.md](interop-testing.md));
  - delegation, such as family accounts.
