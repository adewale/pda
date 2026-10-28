# Contradictions and issues in Poppy draft 0.3

Every open problem we know of in [Personal Agent Protocol](https://personalagentprotocol.org/) draft 0.3, its guides, its Operations extension, its home-page walkthroughs and its official Company kit. The text is the site as of 18:34 UTC on 26 October 2026, unchanged through 28 October, stored in [`spec/draft-0.3-retrieved-2026-10-26/`](../spec/draft-0.3-retrieved-2026-10-26/README.md); upstream's repository has the same text at commit `a95b757`. Line numbers are in that snapshot's `pages/` files: **spec** is `0.3-spec.md`, **Ops** is `0.3-operations.md`, **guides** is `0.3-guides.md`, **walkthroughs** is `walkthroughs.md`. Kit paths are in upstream's `kit/company/` at `a95b757`.

IDs are the ones in [spec-issues-0.3.md](spec-issues-0.3.md), which keeps the history of each finding: when it was found, the earlier text it quoted, and our reading. T4, T9, T10 and T17 were fixed upstream and aren't repeated here; there is no T19. The second part lists the problems from our Draft 0.1 catalogue that 0.3 still has.

0.3 is "In progress", so any of these can be fixed at any time. Nothing here has been sent to the draft's authors; that needs the owner's approval ([SECURITY.md](../SECURITY.md)).

**Open:** 40 new in 0.3 (1 High, 12 Medium, 27 Low), and 43 from the Draft 0.1 catalogue (28 open, 14 partly answered, 1 worse).

| Severity | IDs |
| --- | --- |
| High | T2 |
| Medium | T1, T3, T11, T15, T24, T27, T28, T34, T36, T38, T43, T45 |
| Low | T5, T6, T7, T8, T12, T13, T14, T16, T18, T20, T21, T22, T23, T25, T26, T29, T30, T31, T32, T33, T35, T37, T39, T40, T41, T42, T44 |

## Part 1. New in 0.3

### Session Keys and tokens

**T2. Sign-in with a Session Key that names no Session.** High, Interop.
- *Problem:* nothing says the key in a code exchange or device poll must already name a Session. If it doesn't, one Company starts a Session with no User ID and another refuses.
- *Text:* the code exchange "checks that the key's Session belongs to the same" (spec 609) and the device poll "signs in that key's Session" (spec 664) presuppose a Session; 4.10 says "A proof from a new key starts a Session, and a proof from a known key renews it or signs it in" (spec 835); only the assertion (4.2) carries a User ID.
- *Fix:* the key MUST name a Session started with the JWT bearer grant; an unknown key gets `invalid_grant`.

**T1. After `invalid_grant`, may the key be used again?** Medium, Interop.
- *Problem:* one rule retires the key, another reuses it.
- *Text:* "After `invalid_grant` on a Session Key, the Personal Agent MUST NOT use that key again" (spec 370); "To tell them apart, the Personal Agent renews the Session with its assertion" (spec 794); the guides: "On `invalid_grant` for an account token, delete it and continue signed out" (guides 144).
- *Fix:* the key is finished only when the JWT bearer grant signed with it returns `invalid_grant`.

**T3. Renewing a signed-in Session with the assertion.** Medium, Interop.
- *Problem:* the token is signed out, but whether the Session stays signed in, and what its browser cookie shows, is unsaid.
- *Text:* "this grant always returns signed-out tokens" (spec 350) against "Each Session Token reflects the Session as it was when the token was issued" (spec 563).
- *Fix:* say the Session's state is unchanged and the token is signed out, or refuse the request.

**T22. A Bearer-only MCP server needs two requests to start, unstated.** Low, Clarity.
- *Text:* the Company rejects "any other token request for one that doesn't, with `invalid_target`" (spec 451), so the Session must start without `resource` and then exchange.
- *Fix:* say so in the Token Exchange paragraph.

**T23. "Use the new token" against tokens that coexist.** Low, Clarity.
- *Text:* "Whenever the Personal Agent gets a new Session Token for a Session, it MUST use the new token from then on" (spec 495) against "A Session can have a token for each MCP server and one for its other APIs at the same time" (spec 453).
- *Fix:* per Session and `resource`.

**T37. "The grant says whether a token is signed in" skips Token Exchange.** Low, Clarity.
- *Text:* "The grant says whether a token is signed in" (spec 350); Token Exchange returns a token "with the subject token's scopes, or fewer" (spec 475) for either state.
- *Fix:* its token is signed in exactly when the subject token is.

**T42. A renewal with a different Agent ID has no answer.** Low, Clarity.
- *Text:* "when the Personal Agent renews the Session, it MUST send the same Agent ID" (spec 290); the Session record (spec 559) doesn't hold an Agent ID.
- *Fix:* store it; refuse a mismatch with `invalid_grant`.

**T14. The stated reason for a key per Session.** Low, Editorial.
- *Text:* "so Companies can't link Sessions or Users by their keys" (spec 406), though Sessions of one User share a User ID by design.
- *Fix:* give the real reasons: the key names the Session, and anonymous Sessions stay unlinked.

**T32. Token endpoint codes the table doesn't list.** Low, Editorial.
- *Text:* the table is introduced as "Errors use the OAuth error response, with these codes" (spec 374) but omits `authorization_pending`, `slow_down`, `access_denied`, `expired_token` and `invalid_scope`, which the same endpoint returns.

### Sign-in

**T11. Step-up revocation signs out the User's other Sessions.** Medium, Interop.
- *Text:* the replaced Account Token "which the Personal Agent SHOULD revoke (4.9)" (spec 537); revoking "signs out every Session signed in with it" (spec 815) and the Company "SHOULD also invalidate the Session Tokens issued under the same sign-in" (spec 817).
- *Fix:* have the Company retire a superseded Account Token itself without signing anything out, or drop the SHOULD.

**T5. The decline redirect drops `state`.** Low, Interop.
- *Text:* "If the User declines, the redirect carries `error=access_denied` and `iss` instead" (spec 589); RFC 6749 §4.1.2.1 requires `state`, and step 4 checks it.

**T8. `dpop_jkt` is a MUST, then a MAY.** Low, Editorial.
- *Text:* "The Personal Agent MUST include `dpop_jkt` in the URL" (spec 569) and then it "MAY instead push the request with a proof signed with the Session Key" (spec 585).
- *Fix:* "MUST bind the code to the Session Key", by either means.

**T16. Required pushed authorization requests aren't addressed.** Low, Clarity.
- *Text:* "`pushed_authorization_request_endpoint` accepts pushed authorization requests" (spec 193) is optional, but an issuer with RFC 9126's `require_pushed_authorization_requests` refuses the URL that 4.5 shows first.

**T21. 4.6 checks one link but shows two.** Low, Editorial.
- *Text:* the agent shows "`verification_uri` and `user_code`, or `verification_uri_complete`" and then "MUST check that the link's host" (spec 644).
- *Fix:* check both URLs.

**T35. The RFC 10027 MUST can't be checked.** Low, Clarity.
- *Text:* "MUST follow the best practices in RFC 10027 (BCP 247) §2" (spec 615); RFC 10027 §2 is a risk assessment and a choice of mitigations for "implementers", and its §6.2.1.5 says not to use the device grant on the same device, which 4.6 doesn't say.
- *Fix:* state the agent's rules directly (Direct Sign-In when it can, never Device Sign-In on the User's own device).

### Sign-out and Account Tokens

**T34. A disconnection at the Company looks like a scope request.** Medium, Interop.
- *Text:* `insufficient_scope` is "also the answer to a request that needs the User's account" (spec 960); a disconnection shows as "finds out when a request fails with `invalid_token` or `insufficient_scope`" (spec 823); and the agent "SHOULD NOT sign in to that account again unless the User asks, even when a request gets `insufficient_scope`" (spec 829).
- *Fix:* a distinct signal, or the test: if the named scopes are all ones the agent was granted, the Session was signed out at the Company.

**T28. Expired and revoked Account Tokens look the same.** Medium, Interop.
- *Text:* both get `invalid_grant` (spec 794); after expiry the User signs in again, after a disconnection the agent "SHOULD NOT sign in to that account again". The guides' `refresh_token_expires_in` (guides 268) helps only for a token that reached its stated lifetime.
- *Fix:* a distinct error, or ask the User before any sign-in after `invalid_grant`.

**T26. The summary tables against the text.** Low, Editorial.
- *Text:* the Account Token is "It is used only at the Company's token endpoint" (spec 34), but 4.8 also accepts it at the "`token_endpoint` and `revocation_endpoint`, and only from the" (spec 790); sign-out "The Account Token is revoked, and Sessions continue signed out" (spec 248), but "A Company MAY end the Sessions instead" (spec 815).

### Browser join (section 5)

**T15. The browser-session code is only a SHOULD to keep from the model.** Medium, Security.
- *Text:* the agent signs "in software its model can't read (9.2)" (spec 895), but 9.2's MUST list omits the code and covers it under "SHOULD keep every other secret out of model context too" (spec 1522). The consent-phishing defence in 9.6 depends on it.
- *Fix:* add the browser-session code to 9.2's MUST list.

**T6. Stateless codes can't be single-use.** Low, Clarity.
- *Text:* the Company may "or make them stateless" (spec 879) yet MUST check the code "hasn't been used. A code is used by the first request" (spec 900). The guides concede it: "still remember used codes until they expire" (guides 332).

**T27. "The Session's scopes" are undefined.** Medium, Clarity.
- *Text:* "The website applies the Session's scopes" (spec 922), but the Session record (spec 559) holds no scopes, and a token may hold fewer than its Account Token.
- *Fix:* the scopes of the most recent signed-in token issued for the Session.

**T29. A failed join has no error code, and one failure repeats forever.** Low, Clarity.
- *Text:* the Company "returns an error page, with HTTP 400" (spec 904) and the agent starts again; an unknown Session Key (spec 902) fails every time.
- *Fix:* a machine-readable code, or renew the Session after a second 400.

### Discovery, metadata and scopes

**T12. A Company with no sign-in must still advertise refresh and revocation.** Low, Clarity.
- *Text:* `grant_types_supported` "MUST include `urn:ietf:params:oauth:grant-type:jwt-bearer` (4.2) and `refresh_token` (4.8)" (spec 190) and the revocation endpoint is "Required", though "A Company that offers none offers only signed-out Sessions" (spec 502).

**T13. Mediated scopes needn't be in `scopes_supported`.** Low, Clarity.
- *Text:* the agent "requests only scopes from that list" (spec 518), and "Mediated Sign-In can grant only the scopes in" `auth.mediated.scopes` (spec 531); nothing makes the second a subset of the first. Also "The Company MUST describe each scope in `scopes_supported`" (spec 520) includes scopes offered only to other clients.

**T20. Two places to describe a scope, no precedence.** Low, Clarity.
- *Text:* `auth.scopes` is for "For scopes no OpenAPI description describes" (spec 143), but both can describe one scope, and OpenAPI descriptions may differ by domain while `auth` may not.

**T40. Descriptions against hints.** Low, Clarity.
- *Text:* scopes are described "so the Personal Agent can choose the ones a task needs" (spec 520), but "A scope with no entry has no hints, and a Personal Agent can't tell what it allows" (spec 527); the guides: "Treat a scope without hints as `irreversible` with personal data" (guides 151).

**T33. The example metadata lacks Token Exchange.** Low, Editorial.
- *Text:* the Token Exchange example targets "&resource=https%3A%2F%2Fmcp.example.com%2Fmcp" (spec 469), which needs the token exchange grant, but the example metadata's `grant_types_supported` (spec 169) doesn't list it.

### Conversations

**T30. An account's conversation from the same User signed in to another account.** Low, Clarity.
- *Text:* "Once it uses the User's account, it belongs to that account instead" (spec 998); such a request "that isn't signed in to that account gets `insufficient_scope`" (spec 1377); and `conversation_not_found` covers one that "belongs to a different Personal Agent, User, or account (7.2)" (spec 1391).

**T31. No error for a parent that is itself a Direct Conversation.** Low, Clarity.
- *Text:* the parent must "and not be a Direct Conversation itself" (spec 1334), and the three errors listed don't cover it.

**T25. Section 6 overclaims.** Low, Editorial.
- *Text:* "the Company always knows a request comes from a Personal Agent" (spec 963), against a plain MCP client's Session, which "Such a Session has no User ID" (spec 937).

**T39. An author picture can be on any host.** Low, Security.
- *Text:* "`image` is the URL of the author's picture" (spec 1137); nothing limits its host, so showing it tells a third party who read the message and when.
- *Fix:* keep it on `organization.domain`, or have the agent proxy it.

### Tasks a Company doesn't offer (section 8)

**T38. An alternative's `web` link can point at any host.** Medium, Security.
- *Text:* a `web` reference is "A page the User can open, on the Company's website or in its app" (spec 1470); only API references are checked: "Personal Agents MUST ignore one that doesn't" (spec 1472). 4.6 closes the same hole for sign-in links: "Otherwise a Company could pass off another Company's sign-in page as its own" (spec 644).
- *Fix:* apply 4.6's host check to `web` references.

### Operations

**T36. Operations changed incompatibly under the same version.** Medium, Interop.
- *Text:* Ops is still "This page defines version 1" (Ops 20) but its 3.2 now says "gets `insufficient_scope` (spec section 6)" (Ops 109), where 0.2 said `sign_in_required`, and its example uses ""author": { "type": "agent" }" (Ops 183); spec 3.3: "Changes that implementations can safely ignore keep the version, and incompatible changes get a new one" (spec 216).
- *Fix:* version extensions with the protocol before 1.0, or call this version 2.

**T43. After sign-out, Operations says cancel and forbids it.** Medium, Interop.
- *Text:* "To stop it, the Personal Agent cancels it (section 7)" (Ops 263); a signed-out Session "A signed-out Session of the same Personal Agent and User gets `insufficient_scope`" (Ops 109); and the agent "SHOULD NOT sign in to that account again unless the User asks" (spec 4.9).
- *Fix:* let a signed-out Session of the same agent and User cancel.

**T24. Who may stop a confirmed operation after sign-out.** Medium, Interop.
- *Text:* "Once confirmed, the operation continues even if the Session Token expires or the User signs out" (Ops 263) against "the Company MAY stop work in progress that uses the account, or let it finish" (spec 819).

### Security considerations, references and 4.10

**T41. 4.10's list of OAuth additions is incomplete.** Low, Editorial.
- *Text:* it offers "What a Company's authorization server needs beyond the specifications listed" (spec 833) but omits the issuer-only `aud` (spec 328), the five-minute `exp` (spec 329), mandatory `dpop_jkt` (spec 404), token-endpoint replay rejection (spec 401), mandatory ES256 (spec 196) and the `rate_limited` body (spec 498).

**T7. RFCs cited but not in section 10.** Low, Editorial.
- *Text:* RFC 7638 (spec 406) and RFC 9126 (spec 585) are missing from the references; RFC 3339, 4648 and 5646 too. RFC 9111 and RFC 7519 are listed but never cited.
- *Also:* 4.2 cites 4.4 for anonymous IDs, which 4.4 doesn't mention: "MUST NOT sign in with a Session that uses it (4.4)" (spec 288); section 5 cites RFC 9449 §8, the authorization server's nonce, where §9, the resource server's, fits.

### Guides and walkthroughs

**T18. A guide misses 4.9's new SHOULD.** Low, Editorial.
- *Text:* "If you can't, keep session tokens to a few minutes" (guides 264) presents the fallback as the rule; 4.9 now puts invalidating Session Tokens first.

**T44. The walkthroughs break two rules they illustrate.** Low, Editorial.
- *Text:* both browser joins answer 303 with only the Session cookie (walkthroughs 589 and 1069), though the Company "clears the cookie from step 1, and responds with `303 See Other`" (spec 904); the Mediated Sign-In `complete` response (walkthroughs 540) has no `Cache-Control: no-store`, which "Send `Cache-Control: no-store` on every response that carries a token or code" (guides 25) asks for.

### The official Company kit

**T45. The kit disagrees with the text it checks.** Medium, Interop.
- **Loopback redirect URIs fail:** `schemas/client-metadata.schema.json` lines 19–21 and 34 hold `redirect_uris` to `^https://`, against "or a loopback redirect URI for an app on the User's computer" (spec 274).
- **ES256 for MCP isn't checked:** `validate/checks/mcp.ts` line 191 treats any array in `dpop_signing_alg_values_supported` as DPoP support, against "An MCP server that supports DPoP MUST list `ES256`" (spec 455).
- **Case ignored across the whole URL:** `validate/checks/discovery.ts` line 522 lowercases both sides, against "comparing the strings exactly except that the host is compared ignoring case" (spec 158).
- **The `poppy:` prefix isn't checked** anywhere, against "Names starting with `poppy:` are reserved for this protocol" (spec 516).
- **A follow-up message's 202 needn't carry `conversation_id`:** `schemas/conversation-response.schema.json` line 7, against "which returns HTTP 202 with the same fields" (spec 1039).
- **The author `id` gets a format the spec doesn't give it:** `schemas/message.schema.json` line 18, against "`id` is a stable ID for the author, chosen by the Company" (spec 1135).
- **A feedback alternative isn't checked like an excluded task's:** `validate/checks/feedback.ts` line 26, against "An `openapi` or `mcp` reference MUST name an API listed in the Company's `poppy.json`" (spec 1472).
- **Smaller:** `cursor` may be `null` on any read; the Mediated Sign-In `scope` isn't held to OAuth syntax; the browser join (spec 878) has no check, and `validate/run.ts` lines 27–32 don't list it as unchecked.

## Part 2. Still open from the Draft 0.1 catalogue

Problems first recorded against Draft 0.1 in [spec-issues.md](spec-issues.md) that 0.3 hasn't resolved, graded in [spec-issues-0.3.md](spec-issues-0.3.md#the-01-catalogue-in-02-and-03). Rechecked against the 26 October text: no grade changes.

| ID | Finding | Severity | In 0.3 | What the 0.3 text says |
| --- | --- | --- | --- | --- |
| [N10](spec-issues.md#n10) | Which hosts may receive Session Tokens | Critical | Open | One DPoP Session Token still "works at all of a Company's services" (4.3), and nothing limits an OpenAPI description's `servers`. Our host rule stays our own. |
| [N45](spec-issues.md#n45) | A lost code-exchange answer orphans an Account Token | High | Open | Session Keys don't help: the code is single-use and revocation still needs the token the agent never got. |
| [N43](spec-issues.md#n43) | Website actions outside Operations have no approval step | High | Open |  |
| [N25](spec-issues.md#n25) | Client and Session assertions can be confused | High | Open | Both name the issuer since 0.2; neither has its own `typ`, and nothing requires the client assertion's `sub` to be the `client_id`. |
| [N5](spec-issues.md#n5) | Account Token rotation has no recovery | High | Open |  |
| [S22](spec-issues.md#s22) | Which writes propose operations | High | Open | Operations 4.1 still defines no marker. |
| [S20](spec-issues.md#s20) | Standing permissions have no checkable action | High | Open | Operations unchanged on this. |
| [N8](spec-issues.md#n8) | Mediated Sign-In has no consent step | High | Partly | The agent MUST show the Company's name and domain when it asks for credentials (0.2). Nothing requires the User to agree to the scopes. |
| [N14](spec-issues.md#n14) | Consent pages show the agent's self-declared name | High | Partly | Agents MUST show the Company's name and domain at Device and Mediated Sign-In (0.2). Showing the `client_id` domain on the consent page is still only in the guides. |
| [N13](spec-issues.md#n13) | The browser cookie is a bearer credential | High | Partly | 0.2 required `SameSite=Lax` or `None`. 0.3 requires `Secure` and `HttpOnly`, recommends `__Host-`, allows `Strict`, and requires nothing about `SameSite`. |
| [S2](spec-issues.md#s2) | Assertion `typ`, `kid` and lifetime | High | Partly | At most five minutes (0.2). `typ` and `kid` are still unstated. |
| [S8](spec-issues.md#s8) | Retries after sign-out return the original response | High | Partly | 4.9's "After sign-out" (0.2) has the Company answer a signed-out token on anything that used the account with an error; 7.3 still says a retry returns "the original response", and neither says which wins. |
| [N4](spec-issues.md#n4) | Step-up revocation signs out parallel Sessions | Medium | Worse | 0.3 also invalidates their Session Tokens at once ([T11](#t11)). |
| [N46](spec-issues.md#n46) | Nothing bounds how long a Company may keep an agent checking | Medium | Open |  |
| [N44](spec-issues.md#n44) | When to fetch discovery documents again | Medium | Open | The cache bounds are still only in the guides. |
| [N41](spec-issues.md#n41) | `null` for an optional member | Medium | Open |  |
| [N42](spec-issues.md#n42) | No bounded test mode | Medium | Open | "Unless they were configured to on purpose" became normative in 0.2 section 3, still unbounded. |
| [N34](spec-issues.md#n34) | Which new proposals Operations 6 forbids | Medium | Open |  |
| [N23](spec-issues.md#n23) | The client metadata example has no `grant_types` | Medium | Open |  |
| [N19](spec-issues.md#n19) | An operation proposed signed-out can deadlock | Medium | Open | Operations 3.2 still limits it to its Session, and Sessions still end. |
| [N20](spec-issues.md#n20) | Operations statuses and errors | Medium | Open | Confirm, cancel and read still have no stated HTTP status. |
| [N22](spec-issues.md#n22) | No way to offer two versions at once | Medium | Open | Sharper now: 0.3 breaks 0.2, and a document has one `protocol_version`, so a Company can't serve 0.2 and 0.3 agents from one `poppy.json`. |
| [S23](spec-issues.md#s23) | DPoP nonces per origin or per Company | Medium | Open |  |
| [S13](spec-issues.md#s13) | API errors for an ended Session | Medium | Open | As N39. |
| [S9](spec-issues.md#s9) | Message-id idempotency | Medium | Open | In-flight retries, retries to `{id}/messages`, and "the same content" are still undefined. |
| [S12](spec-issues.md#s12) | Direct Conversations: who sends, which error | Medium | Open |  |
| [N47](spec-issues.md#n47) | A refused revocation leaves a grant live | Medium | Partly | S1's fix removes the commonest refusal. What an agent does when revocation fails, and revocation without the token, are still undefined. |
| [N39](spec-issues.md#n39) | The error for an ended Session at a resource | Medium | Partly | The token endpoint says `invalid_grant` (0.3; `invalid_session` in 0.2). A resource's answer is still unstated. |
| [N40](spec-issues.md#n40) | `wait` is a hint, but examples read like a promise | Medium | Partly | A capped `wait` is held for the cap (0.2). Still not said that the agent reads events when a send returns no reply. |
| [N30](spec-issues.md#n30) | Server-sent events | Medium | Partly | `Last-Event-ID` wins over `cursor` (0.2). The starting status, `wait` on a stream and `retry:` are still undefined. |
| [N21](spec-issues.md#n21) | No generic conversation error | Medium | Partly | `invalid_request` (0.2). A parent that is itself a Direct Conversation still has no error ([T31](#t31)). |
| [N12](spec-issues.md#n12) | Signed-out tracking can't be reset | Medium | Partly | Anonymous browsing IDs (0.2). The regular User ID still can't be reset. |
| [S19](spec-issues.md#s19) | Is ES256 required? | Medium | Partly | Companies MUST accept ES256 DPoP proofs (0.2). Assertion algorithms are only in the guides. |
| [S5](spec-issues.md#s5) | Renewing a signed-in Session with an assertion | Medium | Partly | The token is signed out (06:13); the Session's state is still open ([T3](#t3)). |
| [N24](spec-issues.md#n24) | The metadata example breaks RFC 8414 | Low | Open | Still no `response_types_supported`. |
| [N26](spec-issues.md#n26) | `auth` isn't required for extension endpoints | Low | Open | 3.1's condition still leaves extensions out. |
| [N28](spec-issues.md#n28) | Account Token idle expiry is invisible | Low | Open | See [T28](#t28). |
| [N29](spec-issues.md#n29) | `context` can't clear a field | Low | Open |  |
| [N31](spec-issues.md#n31) | Declining `user_requested` is free text only | Low | Open |  |
| [S18](spec-issues.md#s18) | `web` has no URL | Low | Open |  |
| [S10](spec-issues.md#s10) | The cursor on an empty first read | Low | Open | With no events and no request cursor, `cursor` is still undefined. |
| [S17](spec-issues.md#s17) | Can another User ID continue an account's conversation? | Low | Open | See [T30](#t30). |
| [N33](spec-issues.md#n33) | Inconsistent examples | Low | Partly | The Operations event ID is its own (0.2). Order `#1042` against `ord_7Hk2`, and `invalid_token` for a missing token, remain. |
