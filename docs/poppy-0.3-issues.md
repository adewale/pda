# Issues in Personal Agent Protocol draft 0.3

From the [Poppy Demo Agent](https://github.com/adewale/pda) project, which implements a Personal Agent and a strict mock Company for Poppy 0.3, and only 0.3 since 28 October.

These are issues in the upstream text. The [PDA conformance review](poppy-0.3-conformance.md) records local implementation fixes and the disposition or mitigation of all 43 audit entries; a local mitigation does not close an upstream issue.

**What we read.** Draft 0.3 as published on 28 October 2026, retrieved at 17:48 UTC:
- the [specification](https://personalagentprotocol.org/docs/0.3/spec);
- the [Operations extension](https://personalagentprotocol.org/docs/0.3/extensions/operations), version 2;
- the [Mediated Sign-In extension](https://personalagentprotocol.org/docs/0.3/extensions/mediated-sign-in);
- the [guides](https://personalagentprotocol.org/docs/0.3/guides);
- the 0.3 [changelog](https://personalagentprotocol.org/docs/changelog);
- the walkthroughs on the home page.

Quotations are verbatim from those pages' Markdown, and section numbers are the specification's unless marked otherwise. Three people read the text independently, and each issue below was checked against it before it went in. Where an issue was already in 0.2, the entry says so.

**Two causes behind several issues.** A delegation doesn't name the User it may sign for (§5.2, §10.7). And with blind signing, which §10.7 recommends, every User of a Personal Agent can get its signatures. Issues 1, 2, 7, 9 and 16 follow from one or both.

| Severity | Issues |
| --- | --- |
| High | 1 to 3 |
| Medium | 4 to 18 |
| Low | 19 to 39 |
| Found while implementing | 40 to 43, and notes on 11, 12 and 14 |

## High

### 1. A copied access token works without the Personal Agent's key in three cases

*Security, contradiction. §4.5, §5.2, §5.3, §7, §10.7, changelog.*

**What the text says.** §5.2: "so a copied access token is useless without the Personal Agent's key (5.3)". The changelog adds "even as a Bearer token".

**Why it doesn't hold.**
- **MCP servers.** The rule that enforces it applies only "at every endpoint that accepts the Session header" (§5.3), and §7 allows "except that an MCP server MAY ignore the Session header". At such a server, a copied token works on its own.
- **Unlisted services.** "By default, one access token works at all of a Company's services" (§4.5), including services that never see the header.
- **Other Users.** §10.7 itself says "another User can make the Session JWT that has to go with it". What the attacker needs is a delegation, not "the Personal Agent's key". Every User has one when "delegated keys stay on the User's device", or when the agent signs blindly.

**Suggestion.** State the guarantee as it is: a copied token needs a valid delegation, and only at services that check the Session header. Either require MCP servers that take a Personal Agent's tokens to check the header, or require those tokens to be DPoP-bound.

### 2. Anyone who holds a delegation can act as any User while signed out

*Security, contradiction. §5.1, §5.2, §8.2, §10.7.*

**What the text says.**
- §10.7: "whoever holds a delegated key can sign Session JWTs for any User ID they know until the delegation expires, and act as that User while signed out".
- §5.2 says the opposite: "so a leaked one exposes only that User at one Company (10.7)".
- The verification steps in §5.2 never compare a delegation with `sub`, so using each key for one User ID is a rule the Personal Agent follows but no Company can check.

**Why it matters.**
- A signed-out conversation "belongs to the Personal Agent's `client_id` and the User ID that started it" (§8.2).
- User IDs must be stable and opaque (§5.1), but not unguessable or secret. They also travel in `sub` to every API host the Company lists.
- With blind signing, every User of a Personal Agent can get delegations. So a User who learns another User's ID at a Company can read and continue that User's signed-out conversations there.

**Suggestion.** Bind each delegation to one User ID, for example with a claim the Company checks against `sub`. Or require User IDs to be unguessable and handled as secrets, and correct the sentence in §5.2.

### 3. Operations can perform an action twice

*Security. Operations 6 and 7, guides.*

**What the text says.**
- An approval is accepted when "The `revision` is one the Company returned for this operation, it hasn't expired" (Operations).
- But the Company need only remember a performed operation "at least until the approved revision's `expires_at`" (Operations).
- The guides go further: "Keep your record of a performed operation until its approved revision expires, and no longer than you need to".

**Why it matters.** Suppose a Company returns revision 1 and then revision 2, with a later expiry, under one `operation_id`. Revision 1 is approved and performed, and the Company forgets the operation when revision 1 expires. An approval of revision 2 then passes every check, and the action runs again.

**Suggestion.** Remember a performed operation until the latest `expires_at` of any revision issued for its `operation_id`, and say so in the guides too.

## Medium

### 4. A copied browser-join request can join another browser

*Security. §5.3, §6, §10.6.*

**What the text says.**
- The Session JWT covers the method and URL ("`htm` and `htu` are the request's method and URL"), not the body.
- Replay rejection is optional: "A Company MAY reject a reused `jti`, as RFC 9449 §11.1 allows for DPoP proofs". The acceptance window is the Company's choice.
- §6 says "only the Personal Agent can authorize it, so no one else can make a browser join the Session".

**Why it matters.** Someone who sees one request to `{browser_session_endpoint}/authorize`, for example in a proxy's or the Company's own logs, can resend its headers within the window with a code from their own browser. That browser then gets a cookie for the User's Session, signed in if the original request was. The cookie lasts as long as the Session.

**Suggestion.** Require `jti` replay rejection at `/authorize`, or carry the code in a signed claim of the Session JWT.

### 5. Removing a key doesn't revoke the delegations Companies have cached

*Security, contradiction. §5.2, §10.7.*

**What the text says.** §10.7: "Removing a key from `jwks_uri` revokes every delegation it signed, once Companies' caches of the key set expire". But §5.2 lets a resource "MAY cache a verified delegation until it expires", which can be up to 24 hours, whatever the key set's cache says.

**Suggestion.** Limit a cached delegation to the cache lifetime of the key that signed it, or change §10.7 to say revocation takes up to 24 hours.

### 6. DPoP keys can link a User across Companies

*Privacy. §4.5, §5.2, changelog.*

**What the text says.** The changelog removes the rule to "use a separate DPoP key for each User ID". Yet §5.2 warns of exactly this for delegated keys: "Companies could match a User across Companies by the key's thumbprint".

**Why it matters.** A Personal Agent that reuses one DPoP key across Companies lets them match its Users, which the delegated-key design was built to prevent.

**Suggestion.** Restore the rule for DPoP keys: one per User ID.

### 7. Blind-signed client assertions have no enforced lifetime

*Security. §4.1, §10.7.*

**What the text says.** §4.1: "The Personal Agent MUST make them short-lived" and "The Company MAY reject a reused `jti`, as RFC 7523 §3 allows". Under blind signing, §10.7 says the Personal Agent "MUST NOT rely on a signature by a key in its `jwks_uri` to mean its own systems approved what it signed".

**Why it matters.** A device can mint a client assertion with any `exp` and reuse it at the token endpoint. Delegations are capped at 24 hours; client assertions aren't.

**Suggestion.** Give client assertions a maximum lifetime that Companies check, as delegations have, and require `jti` replay rejection.

### 8. The blind-signing privacy claim is stronger than the design

*Privacy. §4.1, §4.2, §5.3, §10.7.*

**What the text says.** §10.7: "Blind signing, below, closes both gaps".

**Why it doesn't hold.** The Personal Agent's own servers can still learn which Companies a User works with:
- `redirect_uris` must be on the agent's own domain ("Each entry MUST be an HTTPS URL on the same domain as `client_id`"), so its server receives each Direct Sign-In redirect, with `iss`;
- every Company fetches the agent's client metadata and key set from its server, which can be matched in time with the User's signing requests;
- the agent can give each User a different blind key, and nothing asks a device to check that its key is the published one.

**Suggestion.** Narrow the claim to what blind signing hides, and list these channels.

### 9. One User can get every User's agent revoked

*Security. §5.4, §10.7.*

**What the text says.** Under blind signing, any User of a Personal Agent can produce assertions and delegations that break its MUSTs. A Company "MAY revoke a `client_id` that doesn't follow it" (§5.4), which cuts off every User. §10.7 offers only that the agent "limits how many signatures each User can get".

**Suggestion.** Say what a Company should do instead of revoking the `client_id` when the misbehaviour can come from one User, for example refusing that User ID.

### 10. The device sign-in host check fails on shared provider hosts

*Security. §3.2, §4.3. Also in 0.2.*

**What the text says.**
- §3.2 endorses providers that give each Company its own issuer, "such as `https://auth.provider.example/shop-a`, even when they share servers".
- §4.3 checks only that "the link's host is the host of the Company's issuer". A link to the same provider's page for another Company passes. §4.3 names exactly that as the risk: "Otherwise a Company could pass off another Company's sign-in page as its own".
- §4.3 also shows two links, `verification_uri` and `verification_uri_complete`, but says "MUST check that the link's host", in the singular.

**Suggestion.** Check the full URL against the issuer's own prefix when the issuer has a path, and require the check on both links.

### 11. `invalid_session` covers failures that need different recoveries

*Interop. §5.3, §7, guides.*

**What the text says.**
- §7 says `invalid_session` covers "The Session header is missing or fails a check (5.3), the Company refuses the `client_id` (4.1) or an account change (5.4), or the Session has ended (5.5)".
- It gives one recovery: "The Personal Agent starts a new Session once".
- The guides say otherwise: "For any other `invalid_session`, fix the JWT rather than starting over".

**Why it matters.** A new Session doesn't fix an expired delegation or clock skew, and it throws away the Session's cart and browser cookie. The agent can't tell the cases apart, because `error_description` is free text.

**Suggestion.** Separate codes, or a defined set of `error_description` values, each with its recovery.

### 12. A signed-out approval can't follow its conversation into a new Session

*Interop. Operations 3, §8.2, §8.11.*

**What the text says.** Operations: "An operation returned in a signed-out Session can be approved only in that Session". But §8.11 lets the agent "continue it in a new Session, as long as the request matches the conversation's owner".

**Why it matters.** An `approval` message sent from the conversation's new Session is quietly treated as having no approval.

**Suggestion.** Tie a signed-out operation in a conversation to the conversation's owner, not to the Session.

### 13. Nothing stops the model from writing an approval

*Security. Operations 5 and 6, §6, §10.2.*

**What the text says.**
- Operations requires only that the Personal Agent "MUST take the User's answer through its own interface".
- The approval travels in places a model can write: a conversation message's `approval` field, the `Poppy-Approval` header, or MCP `_meta`.
- Only the guides say "Don't have the model write the request again".
- The browser-session code, a less consequential value, must be sent "in software its model can't read (10.2)".

**Suggestion.** Make it a MUST that code outside the model attaches the approval and resends the approved request.

### 14. The guides' `Idempotency-Key` advice loops on Operations

*Interop, contradiction. Guides, Operations 6.*

**What the text says.** The guides tell agents to "reuse the same key when you retry the same request", and Companies to "return the original response for a repeated key". Operations says "An `Idempotency-Key` sent with the first request doesn't carry over".

**Why it matters.** An agent that follows the guides sends the approved retry with the original key, and gets the original `approval_required` back.

**Suggestion.** Say in the guides that a retry with an approval is a new request with a new key.

### 15. The guides' stateless revision leaves out who may approve

*Security. Guides, Operations 3 and 6.*

**What the text says.** The guides compute the revision as "an HMAC-SHA256 over the `operation_id`, the method, URL, and canonical body or the tool's arguments, the `summary`, the `terms`, and the expiry". Operations requires "The Session can approve the operation (3)".

**Why it matters.** For a signed-out request that looks the same in every Session, such as a checkout, the HMAC verifies in any Session. A Company that follows the guides can't enforce Operations 3.

**Suggestion.** Include the Session ID, or the account when signed in, in the HMAC.

### 16. Another User can finish someone's Mediated Sign-In

*Security. Mediated Sign-In 4, §10.7.*

**What the text says.** "Only the `client_id` that started a sign-in can finish it". Nothing requires `sign_in_id` to be unguessable; the example is `sgn_3Hq8`.

**Why it matters.** Under blind signing, every User of the agent can authenticate as that `client_id`. Another User who learns the `sign_in_id`, after the victim has received the one-time code, can finish the sign-in and receive the account's tokens.

**Suggestion.** Require `sign_in_id` to be unguessable, and bind the sign-in to the User ID or the client assertion's `jti` that started it.

### 17. Mediated Sign-In's settings are per domain, but its grant is per issuer

*Interop. §3.2, Mediated Sign-In 2.*

**What the text says.**
- Documents of one Company "MUST have the same `auth`. Other fields MAY differ by domain" (§3.2).
- The extension's `fields` and `scopes` live in `extensions`, not `auth`.
- The Company "MUST NOT grant scopes beyond those requested and listed here".

**Why it matters.** Two domains of one Company can list different scopes for the same token endpoint, and the endpoint can't know which document the agent read.

**Suggestion.** Require the extension's entry to be the same on every domain that names the issuer, as for `auth`.

### 18. An alternative's `web` link can point at any host

*Security. §9.2, §4.3.*

**What the text says.** §9.2 requires an `openapi` or `mcp` reference to name a listed API ("Personal Agents MUST ignore one that doesn't"). But a `web` reference is just "A page the User can open, on the Company's website or in its app", with no host check.

**Why it matters.** A Company can send its Users to another Company's look-alike page under its own name. §4.3 closes the same hole for sign-in links: "Otherwise a Company could pass off another Company's sign-in page as its own".

**Suggestion.** Apply §4.3's host check to `web` references, and have the agent show the Company's name and domain with the link.

## Low

### 19. The walkthroughs show the previous design

*Editorial. Home page.*

**What the walkthroughs show.**
- **No Session header.** No request carries `Poppy-Session`, and the session token is a JWT about which the walkthrough says "Atlas signs this JWT with its published agent key." §5.2 now forbids that ("including one signed directly with a key from `jwks_uri`").
- **Mediated Sign-In.** Credentials are posted as JSON to `https://auth.laurelfiber.example/poppy/sign-in`. The extension says "Personal Agents MUST NOT send credentials anywhere other than the `token_endpoint` of the Company's issuer".
- **The browser join.** The form has `token` and `proof` fields. §6 says "The access token never passes through the browser".
- **Operations.** The jacket walkthrough says both sides list Operations version 2, but the exchange happens after a plain message, with no `approval_required`.

**Suggestion.** Regenerate the walkthroughs from the 0.3 text.

### 20. §10.2's MUST list is shorter than the rest of the text

*Security. §6, §10.2, Mediated Sign-In 2 and 6.*

**What the text says.**
- §10.2 requires keeping these out of model context: "access tokens (4.5), refresh tokens (4.4), Session JWTs (5.2), private keys", authorization codes, PKCE verifiers and device codes. For "every other secret" it is a SHOULD.
- §6 expects the browser-session code to be handled "in software its model can't read (10.2)", but the code falls under the SHOULD.
- Mediated Sign-In protects a `secret` field only from being "never shown back to the User, written to logs, or sent anywhere else". Its MUST against model context applies only "After a sign-in ends", so a password can sit in model context during the sign-in.
- Client assertions and DPoP proofs aren't on the list either, though they can be replayed within their lifetimes (issue 7).

**Suggestion.** Add browser-session codes, credentials in Mediated Sign-In, client assertions and DPoP proofs to the MUST.

### 21. Who owns a conversation once it uses an account

*Clarity. §8.2, §8.11, §8.13.*

**What the text says.**
- §8.2: "Once it uses the User's account, it belongs to that account instead". The same paragraph still rejects requests from "any other `client_id`, User, or account".
- §8.13 returns `conversation_not_found` for one that "belongs to a different Personal Agent, User, or account (8.2)".
- §8.11 gives a challenge only "for the same User without an access token for that account".

**Why it matters.** A request from the same User with a token for a different account fits both the challenge and `conversation_not_found`. It's also unclear whether another User ID signed in to the same account may continue the conversation. The latter question was open in 0.2 too.

**Suggestion.** Say who owns the conversation after it uses an account, and which error each mismatch gets.

### 22. Does fetching excluded tasks need the Session header?

*Clarity. §5.2, §9.1.*

**What the text says.** The header goes on "every request to a Company's APIs, conversations, and other endpoints this protocol or an extension defines" (§5.2). The excluded-tasks document is fetched "with a GET and no token" (§9.1).

**Suggestion.** Say whether that fetch is exempt.

### 23. Automatic SSE reconnects resend a stale Session JWT

*Interop. §5.2, §8.6.*

**What the text says.** "A Session JWT is fresh for each request" (§5.2). The reconnect rule relies on "SSE clients add it to the URL the stream was first opened with" (§8.6), that is, on a client repeating the original request with its original headers.

**Why it matters.** The reconnect carries the first request's `iat` and `jti`, which a Company may reject.

**Suggestion.** Say that the Personal Agent reconnects with a new Session JWT, and so can't rely on a client's automatic reconnection.

### 24. A request with no Session header

*Clarity. §5.3, §7.*

**What the text says.** §7 lists a missing header under `invalid_session`. §5.3 requires rejection only for "a request that carries an access token it issued to a Personal Agent but no Session header".

**Suggestion.** Say whether a signed-out request without the header gets `invalid_session`, or is served as an anonymous visitor.

### 25. Clock skew, and the thumbprint's hash

*Clarity. §5.2, §5.3.*

**What the text says.**
- A delegation is checked only to have not expired, with "its `exp` is at most 24 hours after its `iat`": no allowance for skew, and no check that `iat` isn't in the future.
- The Session JWT's acceptance window is the Company's choice, and the agent can't learn it.
- "`kid` is the delegated key's JWK thumbprint" names no hash function. RFC 7638 leaves the hash to the application; the example uses SHA-256.

**Suggestion.** State a skew allowance and SHA-256.

### 26. A forgotten Session restarts silently

*Clarity. §5.5.*

**What the text says.** "A Company can forget an ended Session, so a request with its `sid` can start a new Session instead".

**Why it matters.** The agent keeps treating it as the old Session, cart and all. It has no signal that a new Session started, and no way to learn how long Sessions last.

**Suggestion.** Signal a newly started Session, for example in a response header.

### 27. MCP servers that ignore the Session header

*Clarity. §7, Operations 8.1.*

**What the text says.** Such a server "can't take signed-out calls from Personal Agents" (§7), but nothing tells the agent which kind of server it is calling, or which error it gets. Two statements also assume every request carries a Session:
- §7: "the Company always knows a request comes from a Personal Agent, which one, and for which User";
- Operations 8.1: "with a valid Session JWT for a specific Session".

**Suggestion.** Have such servers say so in their protected resource metadata, and qualify both statements.

### 28. A Company with no sign-in still needs an authorization server

*Clarity. §3.2, §5.4. Also in 0.2.*

**What the text says.**
- A Company with APIs, conversations or feedback "or an extension that uses the issuer MUST have one" (§3.2).
- Its metadata must include a token endpoint and a revocation endpoint, and `grant_types_supported` "MUST include `refresh_token` (4.4)".
- Yet "A Company that offers no sign-in type offers only signed-out Sessions" (§5.4), and §4 says "Signed-out requests need nothing from it".

**Suggestion.** Require those fields only when the Company offers a sign-in type.

### 29. The website cookie can outlive the access token

*Clarity. §6.*

**What the text says.** The cookie "MUST act for the account and scopes authorized in step 2" until sign-out, and "MUST NOT outlive the Session". Nothing ties it to the lifetime of the access token that authorized it.

**Why it matters.** An access token that lasts minutes becomes a website cookie that lasts as long as the Session, with the same scopes.

**Suggestion.** Bound the cookie's account access by the token's lifetime, or say the difference is intended.

### 30. Scope descriptions and scope hints disagree

*Clarity, contradiction. §4.7, guides.*

**What the text says.** The Company must describe each scope "so the Personal Agent can choose the ones a task needs", but "A scope with no entry has no hints, and a Personal Agent can't tell what it allows". The guides then tell agents to "Treat a scope without hints as `irreversible` with personal data".

**Why it matters.** A well-described read-only scope without hints ends up treated as if it could cancel orders.

**Suggestion.** Change the sentence to: A scope with no entry has no hints; the Personal Agent judges it from its description.

### 31. Two places to describe a scope, with no precedence

*Clarity. §3.1, §3.2, §4.7.*

**What the text says.** `auth.scopes` is for scopes no OpenAPI description describes ("For scopes no OpenAPI description describes"), but both can describe one scope. §3.2 also requires `auth` to be the same across domains, while OpenAPI descriptions may differ by domain.

**Suggestion.** Name which description wins, or require them to agree.

### 32. A Company message's author picture can be on any host

*Privacy. §8.4.*

**What the text says.** "`image` is the URL of the author's picture", with no limit on its host.

**Why it matters.** An agent that shows the picture tells whoever serves it when the User read the message, and from where.

**Suggestion.** Keep the image on `organization.domain`, or have the agent fetch and serve it itself.

### 33. No error for a parent that is itself a Direct Conversation

*Clarity. §8.10.*

**What the text says.** The parent must be open, belong to the same owner, "and not be a Direct Conversation itself". The errors listed don't cover the last condition. Also open in 0.2.

**Suggestion.** Name the error, probably `invalid_request`.

### 34. The RFC 10027 MUST can't be checked

*Clarity. §4.3.*

**What the text says.** "MUST follow the best practices in RFC 10027 (BCP 247) §2". RFC 10027 §2 asks implementers for a risk assessment and a choice of mitigations, which no one can observe on the wire.

**Suggestion.** State the Personal Agent's rules directly in §4.3:
- use Direct Sign-In when the User can receive its redirect;
- never use Device Sign-In on the User's own device, as RFC 10027 §6.2.1.5 says.

Make the Company side a SHOULD.

### 35. The guides allow closing conversations at sign-out

*Contradiction. Guides, §5.5.*

**What the text says.** The guides say "or close them if your policy is to clear everything at sign-out". §5.5 says "A conversation stays open, so the User can sign in again and continue it".

**Suggestion.** Align them.

### 36. The guides' example operation ID isn't a valid ID

*Editorial. Guides, Operations 3.*

**What the text says.** The guides suggest "such as `exchange:ord_7Hk2:itm_4Qa`". Operations says an `operation_id` "has the same characters as the IDs in" §8.2, which allows only letters, digits, `-` and `_`.

**Suggestion.** Use underscores, or a hash.

### 37. Refresh responses

*Editorial. §4.4, §4.7.*

**What the text says.** §4.7: "Sign-in and refresh (4.4) return the same token fields: an access token (4.5) and a refresh token". But §4.4 says "A Company MAY return a new refresh token" on refresh.

**Suggestion.** Make the refresh token optional in the refresh response.

### 38. Citations

*Editorial. §7, §11.*

- **A section number.** The 401 row cites "as RFC 6750 §3.1 describes" for the `scope` attribute. RFC 6750 defines the attribute in §3; §3.1 is its error codes.
- **Missing references.** §11 leaves out RFC 3339, RFC 4648, RFC 5646, the server-sent events standard, draft-ietf-wimse-aims, and the JOSE RFCs behind `ES256` and `PS384`, though the body cites them all.
- **Unused references.** RFC 9111 and RFC 6265bis are listed but never cited.

**Suggestion.** Cite §3 of RFC 6750, and make §11 match the body.

### 39. Smaller slips

*Editorial.*

- §5.3: "An unknown `sid` starts a signed-out Session", even when the request carries an access token and is signed in.
- §4.1 sends a refused `client_id` to "or `invalid_session` at a resource (5.3)", but §5.3 doesn't mention refusal; only §7's table does.
- The paragraph on second accounts in §10.4 has nothing to do with "Token and assertion audiences".
- §7's table follows "Other errors have a JSON body", but `extension_required` is "In the `WWW-Authenticate` header".
- Operations' examples reuse the specification's `evt_c4` and `msg_r2Kq` for different content, though they say they continue its example.

**Suggestion.** Fix each in place; none changes behaviour.

## Found while implementing

We implemented the 28 October text in our client and mock Company after the issues above were written. These four are new; each was checked against the text as the others were.

### 40. Nothing says which writes need approval, so a careful agent asks the User twice

**Withdrawn, 29 October.** This described our extra policy that every write needed a separate confirmation click. Operations 2 deliberately lets the Company choose which actions need confirmation, and the guides discourage confirmation of routine changes the User already requested. The normal flow sends the task request first and asks when the Company returns its terms. [Decision 38](decisions.md#38-task-requests-use-the-companys-approval-boundary) replaces our blanket preliminary card. The original argument is retained below as history, not an outstanding protocol defect.

*Original assessment: Interop, safety. Operations (introduction, 4).*

**What the text says.** "Operations add no endpoints. A Company chooses which actions need approval." A Company that doesn't ask performs the write at once.

**Why it matters.** An agent can't tell, before it sends a write, whether the Company will ask the User. If it sends every write straight away, a write the Company doesn't ask about is done on the model's word alone. So an agent that never acts without the User asks first on its own card, and then the Company asks again with `approval_required`: two approvals for one action, the second with the terms the User needed for the first. Operations version 1 let a description say a write proposes an operation; version 2 has no equivalent.

**Suggestion.** A marker the agent can read before it sends: an OpenAPI extension on the operation and an MCP tool annotation saying the Company always answers with `approval_required`. An agent could then skip its own card for those writes, knowing nothing is done until the User approves the Company's terms.

### 41. An OpenAPI description can't say which security scheme takes the Company's access tokens

*Interop. §7, §4.5, §4.7.*

**What the text says.** §7: "Every listed API MUST accept the Session header (5.2) and the Company's access tokens (4.5)". §4.7 describes scopes "in the scopes of an OAuth 2.0 security scheme in an OpenAPI description it lists". Nothing says how a description marks the scheme the Poppy access token goes in.

**Why it matters.** Companies that add Poppy to an existing API keep their own schemes beside it. Print with Poppy's store describes a Bearer `guest` scheme for its own guest tokens next to the DPoP one. Both are HTTP `bearer`-style schemes, so an agent can't tell which operations take its access token and which want a credential from the Company's own sign-in. Our client reads any OAuth 2.0 or HTTP `Bearer`/`DPoP` scheme as one that takes it, which counts `guest` too.

**Suggestion.** Name the scheme: for example, an OAuth 2.0 scheme whose flows point at the issuer's endpoints, or an extension field on the scheme such as `x-poppy: true`.

### 42. "Each code works once", but the browser-join code is used twice

*Editorial. §6.*

**What the text says.** Step 1's requirements: "The Company MUST make the code unguessable and short-lived, and each code works once." The code is then sent by the Personal Agent in step 2 ("hasn't been authorized before") and by the browser in step 3 ("hasn't been submitted before").

**Why it matters.** Read alone, step 1's sentence lets a Company spend the code at step 2, so step 3 always fails. Steps 2 and 3 say what is meant.

**Suggestion.** "each code can be authorized once and submitted once".

### 43. The issuer isn't asked to say it sends `iss`

*Editorial. §4.2, RFC 9207.*

**What the text says.** §4.2: "The redirect back carries the Company's issuer in `iss` (RFC 9207)… The Personal Agent MUST check that `iss` exactly matches the issuer". The metadata members the text lists don't include `authorization_response_iss_parameter_supported`.

**Why it matters.** RFC 9207 §3 has an authorization server that sends `iss` advertise it with that member. Without it, a validator can't tell a Company that forgot `iss` from one that sends it, before a sign-in fails.

**Suggestion.** Require `authorization_response_iss_parameter_supported: true` in the issuer's metadata.

### What implementing confirmed

- **11.** A Company that refuses our `client_id` answers `invalid_session` at a resource (§4.1), and §7's one recovery has us start a new Session, which is refused the same way. One wasted request on each try, and nothing tells the agent that a new Session won't help.
- **12.** The same gap shows up after a Company ends a signed-out Session: an approval of its operation can't be sent on the new Session, so the User's approval is lost and they have to ask again. Our client tells them so instead of sending it unapproved.
- **14.** Our approved retry carries a new `Idempotency-Key`, as Operations says. An agent that follows the guides' advice to reuse the key gets the first `approval_required` back.

