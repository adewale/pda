# Contradictions and issues in Poppy draft 0.3

Every problem we know of in [Personal Agent Protocol](https://personalagentprotocol.org/) draft 0.3 as rewritten on 28 October 2026, retrieved at 17:48 UTC and stored in [`spec/draft-0.3-retrieved-2026-10-28/`](../spec/draft-0.3-retrieved-2026-10-28/README.md). The draft is "In progress", and upstream's repository (`a95b757`) still has the earlier text. Line numbers are in that snapshot's `pages/` files: **spec** is `0.3-spec.md`, **Ops** is the Operations extension (version 2), **MSI** is the Mediated Sign-In extension, **guides** and **walkthroughs** are those pages. Every quotation was checked to occur exactly once on its line.

The rewrite replaced most of the design the earlier list ([spec-issues-0.3.md](spec-issues-0.3.md), T-numbers) was written against. Findings here take **R-numbers**. Where one carries over an earlier finding, it says so. Earlier findings the rewrite resolved are listed at the end.

Found by three reads of the text: ours, and two by reviewers given only the spec pages. Every finding from them was checked against the text before it went in. Nothing here has been sent to the draft's authors; that needs the owner's approval ([SECURITY.md](../SECURITY.md)).

| Severity | IDs |
| --- | --- |
| High | R1, R2, R3, R4 |
| Medium | R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18 |
| Low | R19 to R38 |

## High

**R1. "A copied access token is useless without the Personal Agent's key" isn't true.** Security, contradiction.
- *Claim:* "so a copied access token is useless without the Personal Agent's key (5.3)" (spec 455), and the changelog adds "even as a Bearer token".
- *Against it:*
  - **MCP servers.** The defence applies only "at every endpoint that accepts the Session header" (spec 540), but "except that an MCP server MAY ignore the Session header" (spec 684), and MCP tokens are usually Bearer.
  - **Other services.** "By default, one access token works at all of a Company's services" (spec 324), including ones that never see the header.
  - **Other Users of the same agent.** Under blind signing, "another User can make the Session JWT that has to go with it" (spec 1308). It takes a delegation, not "the Personal Agent's key", and 10.7 suggests delegated keys can "stay on the User's device" (spec 1302).
- *Fix:* state the guarantee as it is: a copied token needs a valid delegation, at services that check the header.

**R2. Any holder of a delegation can act as any User while signed out.** Security.
- "whoever holds a delegated key can sign Session JWTs for any User ID they know until the delegation expires, and act as that User while signed out" (spec 1298).
- Signed-out state belongs to the agent and the User ID: a conversation "belongs to the Personal Agent's `client_id` and the User ID that started it" (spec 752).
- User IDs need only be "stable" and "opaque" (spec 400). They aren't required to be unguessable or kept secret, and they go to every API host on every request (`sub`).
- With blind signing, which 10.7 recommends, every User of the agent can get delegations. So another User who learns a User ID can read that User's signed-out conversations and use their cart.
- *Fix:* bind a delegation to the User ID it may sign for, or require User IDs to be unguessable and treated as secrets.

**R3. The delegated key's blast radius contradicts itself.** Security, contradiction.
- "so a leaked one exposes only that User at one Company (10.7)" (spec 461), against R2's quote from 10.7. Nothing in the verification steps (spec 516) ties a delegation to a `sub`. "One User ID per key" is a rule for the Personal Agent that no Company can check.

**R4. Operations can perform an action twice.** Interop and security, Operations.
- The Company must remember a performed operation only "at least until the approved revision's `expires_at`" (Ops 259). Yet another revision of the same `operation_id` passes if "The `revision` is one the Company returned for this operation, it hasn't expired" (Ops 251).
- So if revision 1 is approved and performed, and the record is dropped when revision 1 expires, an approval of a later-expiring revision 2 runs the action again.
- The guides make it worse: "Keep your record of a performed operation until its approved revision expires, and no longer than you need to" (guides 410).
- *Fix:* remember it until the last `expires_at` of any revision issued for that `operation_id`.

## Medium

**R5. A replayed Session JWT at `/authorize` joins someone else's browser.** Security.
- The JWT covers method and URL, not the body ("`htm` and `htu` are the request's method and URL", spec 449); replay rejection is optional ("A Company MAY reject a reused `jti`, as RFC 9449 §11.1 allows for DPoP proofs", spec 542); and the acceptance window is the Company's choice.
- So whoever copies one request's headers within the window can authorize their own browser's code and get a signed-in cookie that lasts as long as the Session. That contradicts "only the Personal Agent can authorize it, so no one else can make a browser join the Session" (spec 582).
- *Fix:* require `jti` replay rejection at `{browser_session_endpoint}/authorize`, or put the code in the signed JWT.

**R6. Removing a key doesn't revoke cached delegations.** Security, contradiction.
- "Removing a key from `jwks_uri` revokes every delegation it signed, once Companies' caches of the key set expire" (spec 1300), but a resource "MAY cache a verified delegation until it expires" (spec 523), up to 24 hours, whatever the key set's cache says.

**R7. DPoP keys can link a User across Companies again.** Security.
- The rule that DPoP keys are per User ID was removed (changelog: "use a separate DPoP key for each User ID" is among the "DPoP rules Poppy added to RFC 9449 [that] are removed"). The spec now says a request carries the Session JWT and "a DPoP proof, each signed with its own key" (spec 455). The spec itself warns that a shared key lets "Companies could match a User across Companies by the key's thumbprint" (spec 527).
- *Fix:* restore the rule for DPoP keys.

**R8. Blind-signed client assertions have no enforced lifetime.** Security.
- "The Personal Agent MUST make them short-lived" and "The Company MAY reject a reused `jti`, as RFC 7523 §3 allows" (spec 259). Under blind signing the agent "MUST NOT rely on a signature by a key in its `jwks_uri` to mean its own systems approved what it signed" (spec 1306). So a device can mint a client assertion with any `exp` and reuse it at the token endpoint. Delegations are capped at 24 hours; client assertions aren't.

**R9. The blind-signing privacy claim is overstated.** Privacy.
- "Blind signing, below, closes both gaps" (spec 1302). But the agent's own server still learns the Company:
  - `redirect_uris` are on the agent's own domain ("Each entry MUST be an HTTPS URL on the same domain as `client_id`", spec 255), so its server receives the Direct Sign-In redirect, with `iss`;
  - each Company fetches the agent's client metadata and key set from its server, timed with the User's signing requests;
  - the agent can give different Users different blind keys, and nothing requires a device to check that its key is the published one.

**R10. One User can get the whole agent revoked.** Security.
- Under blind signing any User can break the agent's MUSTs, and a Company "MAY revoke a `client_id` that doesn't follow it" (spec 552), cutting off every User. 10.7 offers only "limits how many signatures each User can get" (spec 1308).

**R11. Device Sign-In's host check fails on shared provider hosts.** Security. Carries over from 0.2.
- Providers may host Companies as "such as `https://auth.provider.example/shop-a`, even when they share servers" (spec 162), but the check is only that "the link's host is the host of the Company's issuer" (spec 308). A link to the provider's page for another Company passes, which is what the check is meant to stop.

**R12. A Personal Agent can't tell why it got `invalid_session`.** Interop.
- One error covers "The Session header is missing or fails a check (5.3), the Company refuses the `client_id` (4.1) or an account change (5.4), or the Session has ended (5.5)" (spec 714), with one recovery: "The Personal Agent starts a new Session once" (spec 714). That's wrong for an expired delegation or clock skew, and it discards the Session's cart and cookie. The guides say the opposite: "For any other `invalid_session`, fix the JWT rather than starting over" (guides 119).
- *Fix:* distinct codes, or a defined `error_description`.

**R13. Operations: an approval in a conversation can't move with the conversation.** Interop, Operations.
- "An operation returned in a signed-out Session can be approved only in that Session" (Ops 89), but a conversation can "or continue it in a new Session, as long as the request matches the conversation's owner" (spec 1127). An approval sent from the conversation's new Session is silently treated as none.

**R14. Operations: nothing keeps the model from writing an approval.** Security, Operations.
- The rule is only that the agent "MUST take the User's answer through its own interface" (Ops 176). The approval travels in fields the model can write: a message's `approval` next to ""text": "The user approved the exchange."," (Ops 236), a header, or MCP `_meta`. The comparable browser-session code must be sent "in software its model can't read (10.2)" (spec 635). Only the guides say "Don't have the model write the request again" (guides 210).
- *Fix:* a MUST that the approval and the approved request are attached by code outside the model.

**R15. The guides' `Idempotency-Key` advice loops on Operations.** Interop, guides.
- Guides: "reuse the same key when you retry the same request" (guides 60), and Companies "return the original response for a repeated key" (guides 65). Operations: "An `Idempotency-Key` sent with the first request doesn't carry over" (Ops 203). An agent that follows the guides gets the original `approval_required` back.

**R16. The guides' stateless revision recipe ignores who may approve.** Security, guides.
- The guides compute the revision "To avoid storing operations nobody has approved, compute them from the request" (guides 411) from the request, summary, terms and expiry, without the Session or account, while Operations requires "The Session can approve the operation (3)" (Ops 249).

**R17. Mediated Sign-In: one sign-in can be finished by another User.** Security, MSI.
- "Only the `client_id` that started a sign-in can finish it" (MSI 90), but under blind signing every User of the agent can authenticate as that `client_id` (R10). Nothing requires `sign_in_id` to be unguessable. So another User who learns it, after the victim gets the one-time code, can finish the sign-in and receive the account's tokens.

**R18. Mediated Sign-In: settings are per domain, the grant is per issuer.** Interop, MSI.
- Documents of one Company "MUST have the same `auth`. Other fields MAY differ by domain" (spec 160), and the extension's `fields` and `scopes` are in `extensions` (MSI 13), not `auth`. So two domains can list different scopes for one token endpoint, which can't know which document the agent read, while the Company "MUST NOT grant scopes beyond those requested and listed here" (MSI 34).

## Low

**R19. The walkthroughs show the previous design.** Editorial.
- No request carries `Poppy-Session`; the session token is "// Atlas signs this JWT with its published agent key." (walkthroughs 122), which spec 5.2 now forbids.
- Mediated Sign-In posts JSON credentials to `POST https://auth.laurelfiber.example/poppy/sign-in` (walkthroughs 508 and 531), against "Personal Agents MUST NOT send credentials anywhere other than the `token_endpoint` of the Company's issuer" (MSI 108).
- The browser-join form has a token field (`<input type="text" name="token">`, walkthroughs 581 and 1063), against "The access token never passes through the browser" (spec 582).
- The jacket walkthrough says Operations version 2 is in use, but its exchange is done after a plain message, with no `approval_required`.

**R20. Passwords get less protection from the model than device codes.** MSI.
- A `secret` field is protected from being "never shown back to the User, written to logs, or sent anywhere else" (MSI 33), not from model context; the MUST against model context applies only "After a sign-in ends" (MSI 110). Spec 10.2 makes it a SHOULD for "every other secret" (spec 1272).

**R21. The browser-session code is only a SHOULD to keep from the model.** Carries over T15.
- The code is sent in software the model can't read (spec 6, above), but 10.2 lists it under the SHOULD for "every other secret" (R20's quote).

**R22. Who owns an account's conversation.** Carries over T30.
- "Once it uses the User's account, it belongs to that account instead" (spec 752), yet the same paragraph rejects "any other `client_id`, User, or account", and `conversation_not_found` covers one that "belongs to a different Personal Agent, User, or account (8.2)" (spec 1145). The answer to a token for another account is undefined; a challenge is given only "for the same User without an access token for that account" (spec 1131).

**R23. Is the excluded-tasks fetch exempt from the Session header?** Clarity.
- The header goes on "every request to a Company's APIs, conversations, and other endpoints this protocol or an extension defines" (spec 410); the excluded-tasks document is fetched "with a GET and no token" (spec 1191).

**R24. Automatic SSE reconnects resend a stale Session JWT.** Interop.
- "A Session JWT is fresh for each request" (spec 455), but the reconnect rule relies on "SSE clients add it to the URL the stream was first opened with" (spec 963), that is, on a client repeating the original request, with its old `iat` and `jti`.

**R25. Signed-out requests without the header.** Clarity.
- `invalid_session` covers a missing header (R12's quote), but rejection is required only for "a request that carries an access token it issued to a Personal Agent but no Session header" (spec 540). A header-less signed-out request can be refused or served as an anonymous visitor.

**R26. Clock skew and the thumbprint's hash are unspecified.** Clarity.
- The delegation check is only that it "hasn't expired, and its `exp` is at most 24 hours after its `iat`" (spec 519): no skew and no future `iat`. The Session JWT's `iat` window is the Company's choice. And "`kid` is the delegated key's JWK thumbprint" (spec 513) names no hash; RFC 7638 leaves it open, and the example uses SHA-256.

**R27. A forgotten Session restarts silently.** Clarity.
- "A Company can forget an ended Session, so a request with its `sid` can start a new Session instead" (spec 560). The agent keeps believing it's the old Session, and has no signal of a Session's lifetime.

**R28. MCP servers that ignore the header give no signal.** Clarity.
- A server that ignores it "can't take signed-out calls from Personal Agents" (spec 690), but nothing tells the agent which kind of server it's calling, or what error it gets.

**R29. Section 7 overclaims.** Editorial. Carries over T25.
- "the Company always knows a request comes from a Personal Agent, which one, and for which User" (spec 717), against MCP servers that ignore the header (R1). Operations 8.1 says the same of approvals: "with a valid Session JWT for a specific Session" (Ops 269).

**R30. A Company with no sign-in still needs an authorization server.** Clarity. Carries over T12.
- A Company with APIs, conversations or feedback "or an extension that uses the issuer MUST have one" (spec 142), and its metadata needs a token endpoint, a revocation endpoint and `refresh_token` (spec 194), though "A Company that offers no sign-in type offers only signed-out Sessions" (spec 546) and signed-out requests need nothing from it.

**R31. The website cookie outlives the access token.** Clarity.
- The cookie "MUST act for the account and scopes authorized in step 2" (spec 668) until sign-out and "MUST NOT outlive the Session" (spec 669), but nothing ties it to the access token's lifetime. A minutes-long token becomes a cookie that lasts as long as the Session.

**R32. Secrets the MUST list leaves out.** Clarity.
- 10.2's MUST covers "access tokens (4.5), refresh tokens (4.4), Session JWTs (5.2), private keys" (spec 1272), but not client assertions or DPoP proofs, which are replayable within their lifetimes (R8).

**R33. The guides contradict the spec on conversations at sign-out.** Guides.
- "or close them if your policy is to clear everything at sign-out" (guides 385), against "A conversation stays open, so the User can sign in again and continue it" (spec 569).

**R34. The guides' example operation ID isn't a valid ID.** Guides.
- "such as `exchange:ord_7Hk2:itm_4Qa`" (guides 411) has colons; Operations says it "has the same characters as the IDs in" spec 8.2 (Ops 71), which allows only "letters, digits, `-`, and `_`".

**R35. Refresh responses.** Editorial.
- "Sign-in and refresh (4.4) return the same token fields: an access token (4.5) and a refresh token" (spec 361), but "A Company MAY return a new refresh token" (spec 316) on refresh.

**R36. Citations.** Editorial.
- The 401 row cites "as RFC 6750 §3.1 describes" (spec 711) for the `scope` attribute, which RFC 6750 defines in §3; §3.1 is its error codes.
- Section 11 leaves out RFC 3339, RFC 4648, RFC 5646, the SSE standard, draft-ietf-wimse-aims and the JOSE RFCs behind `ES256` and `PS384`, all cited in the body. RFC 9111 and RFC 6265bis are listed but never cited.

**R37. Editorial slips.**
- "An unknown `sid` starts a signed-out Session" (spec 536) even when the request carries an access token and is signed in.
- A refused `client_id` points to "or `invalid_session` at a resource (5.3)" (spec 262), but 5.3 doesn't mention refusal; only the section 7 table does.
- The paragraph on second accounts (spec 1282) sits under 10.4, "Token and assertion audiences".
- Section 7's table follows "Other errors have a JSON body" but lists `extension_required` "In the `WWW-Authenticate` header. The request needs an extension" (spec 715).
- Operations' examples reuse the spec's `evt_c4` and `msg_r2Kq` for different content (Ops 150).

**R38. Still open from the earlier list.** These quotes are unchanged in the rewrite:
- **T38.** An alternative's `web` link can point at any host.
- **T39.** A Company message's author picture can be on any host.
- **T40.** Scope descriptions contradict scope hints: "A scope with no entry has no hints, and a Personal Agent can't tell what it allows" (spec 349).
- **T20.** Two places describe a scope, with no precedence.
- **T21.** 4.3 checks "the link's host" but shows two links.
- **T31.** No error for a parent that is itself a Direct Conversation.
- **T35.** The RFC 10027 MUST can't be checked.

## Resolved by the rewrite

The earlier list's findings about Session Keys and the JWT bearer grant (T1, T2, T3, T14, T22, T23, T37, T42), Operations version 1 (T24, T36, T43), the overloaded `insufficient_scope` after a disconnection (T34), stateless join codes (T6), `dpop_jkt` (T8) and the `rate_limited` body are gone with the text they were about. Mediated Sign-In's scopes must now be in `scopes_supported` (T13). The rewrite didn't necessarily fix the underlying concern in each case; R1 to R18 are where the new design has its own.
