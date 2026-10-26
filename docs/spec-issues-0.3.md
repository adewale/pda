# Problems in Personal Agent Protocol draft 0.3

A review of [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) **draft 0.3** for bugs, contradictions and inconsistencies, read on 25 October 2026 from the site's own Markdown. The draft changed while we read it, so there are three snapshots: [01:47 UTC](../spec/draft-0.3-retrieved-2026-10-25/README.md) and [06:13 UTC](../spec/draft-0.3-retrieved-2026-10-25T0613Z/README.md) on 25 October, and [18:34 UTC on 26 October](../spec/draft-0.3-retrieved-2026-10-26/README.md), when upstream's repository also had the 0.3 text, at commit `a95b757`. Line numbers for T1 to T33 are in the 01:47 snapshot's `pages/`; T34 to T38 and every "06:13" note in the 06:13 snapshot's; T39 and every "26 October" note in the 26 October snapshot's. Draft 0.3 is "in progress" and its changelog "grows until 0.3 is published": between the two snapshots it gained five entries, a new section 8 and a renamed error, and fixed T4. Check the live text before citing a finding.

The 0.1 catalogue is [spec-issues.md](spec-issues.md), with S- and N-numbered IDs. 0.3 findings take **T-numbers**, so the three catalogues never collide. Kinds and severities are the 0.1 catalogue's: Interop, Security, Clarity, Editorial; Critical, High, Medium, Low. What has to change in our code is in [poppy-0.3-upgrade.md](poppy-0.3-upgrade.md), not here.

None of this has been sent to the draft's authors. The project now has a public [repository and issue tracker](https://github.com/personal-agent-protocol/personal-agent-protocol/issues) as well as the feedback address; sending anything needs the owner's approval ([SECURITY.md](../SECURITY.md)).

## How we read it

- The whole of `0.3-spec.md` (1,423 lines, 182 RFC 2119 keyword sentences), the 0.3 section of the changelog, the 0.3 guides, Operations v1 and the Extensions page.
- A line-by-line diff of the 0.2 spec, guides and Operations against 0.3, to see what moved and what the changelog leaves out.
- Every RFC number and section the new text cites, checked against the RFC Editor's text: RFC 10027 exists (Best Current Practice for Security of Cross-Device Flows, cited correctly for consent phishing); RFC 9700 §4.7 is Cross-Site Request Forgery and §2.3 is Access Token Privilege Restriction, both cited correctly; RFC 9728 §2, §3.3, §4 and §5.1 are what 3.2, 4.3 and 6 say they are; RFC 8414 §2 is quoted exactly; RFC 9449 §4.3, §5, §5.1, §7.1, §8, §10, §10.1 and §11.1 are the right sections; RFC 7009 §2.1 and RFC 8628 §3.5 are right; draft-ietf-wimse-aims exists (revision 00), its §8 and §10.4.2 not checked.
- A search of every 0.3 page, including the home page's walkthroughs, for the constructs 0.3 removes: `session_id`, `signed_in`, `invalid_session`, `poppy_domains`, `custom_scopes`, `auth.direct`, `auth.device`, `poppy:read`, `poppy:write`, the browser assertion and `return_to`. None remains anywhere. Operations v1 is unchanged from 0.2 apart from its links and still agrees with the 0.3 spec.
- The frozen 0.2, published 24 October, is identical in text to our 19 October pin apart from relative links, so nothing here is a change we missed in 0.2.
- A second, independent read of the same four pages by a reviewer given no other context, whose findings were checked against the text before being merged. Where both reads found the same thing it is listed once.
- A third sweep on 26 October: every earlier finding checked against the new text by its quoted phrase, and the 31 upstream commits since our 0.2 pin read by title. Fixed since 06:13: [T9](#t9), [T10](#t10) and [T17](#t17); [T28](#t28) is partly answered in the guides. One correction to our own reading: the line above says RFC 9449 §7.1 is cited correctly, but 4.3's rule on a DPoP token sent with the `Bearer` scheme is §7.2, and upstream fixed the citation (line 453).
- A second sweep at 06:13: a diff of every page against the 01:47 snapshot (120 changed lines in the spec, 22 in the guides, 4 in Operations, 6 in the walkthroughs), each earlier finding checked against the new text, and RFC 10027 §2, §4.1.1 and §6.2.1.5, which the new 4.6 cites, checked against the RFC. Operations v1 is no longer unchanged: its 3.2 and 5.2 now say `insufficient_scope` where they said `sign_in_required` ([T36](#t36)).

38 findings. Four are fixed upstream: T4 at 06:13 on 25 October, and T9, T10 and T17 by 26 October. The 34 open ones by severity: 0 Critical, 1 High, 10 Medium, 23 Low. Of the five Critical findings in the 0.1 catalogue, 0.3 resolves four (N2 by `dpop_jkt`, N9 by HTTPS everywhere, N11 by one issuer per Company, N17 by Token Exchange); N10, which hosts may receive a Session Token, is still open. How every 0.1 finding fares in 0.2 and 0.3 is [the last section](#the-01-catalogue-in-02-and-03).

## The most important

| ID | Problem | Kind | Severity |
| --- | --- | --- | --- |
| [T2](#t2) | A code exchange or device poll with a Session Key the Company doesn't know has no defined outcome, and a Session it started would have no User ID | Interop | High |
| [T1](#t1) | 4.2 forbids ever using a key again after `invalid_grant`; 4.8 tells the Personal Agent to use it again to tell an ended Session from a revoked Account Token | Interop | Medium |
| [T3](#t3) | Renewing a signed-in Session with the assertion returns a signed-out token, though tokens "reflect the Session as it was when the token was issued" | Interop | Medium |
| [T34](#t34) | With `sign_in_required` folded into `insufficient_scope`, a disconnection made at the Company looks like a request for more scopes | Interop | Medium |
| [T36](#t36) | Operations changed an error code under the same version 1, which 3.3 says needs a new version | Interop | Medium |
| [T38](#t38) | An alternative's `web` reference can point at any host, the hole 4.6 closes for device sign-in links | Security | Medium |

All three still stand on 26 October, and T36 has a second instance: Operations 4.3 now uses `author` where it used `sender`, still as version 1.
| [T11](#t11) | Revoking the old Account Token after a step-up still signs out every other Session, and 0.3 now also invalidates their Session Tokens at once | Interop | Medium |
| [T15](#t15) | The browser-session code is a secret the guides list and section 5 keeps from the model, but 9.2 leaves it at SHOULD | Security | Medium |
| [T27](#t27) | "The Session's scopes", which the website applies, are nowhere defined: the Session record holds no scopes and a narrowed token has fewer | Clarity | Medium |
| [T28](#t28) | An expired and a revoked Account Token both return `invalid_grant`, and the spec prescribes opposite behaviour for each | Interop | Medium |
| [T24](#t24) | Operations says a confirmed operation continues after sign-out; 4.9 says the Company may stop it | Interop | Medium |

## By area

| Area | Issues |
| --- | --- |
| Discovery and metadata (3) | [T12](#t12), [T13](#t13), [T16](#t16), [T20](#t20), [T33](#t33) |
| Sessions and tokens (4.2, 4.3, 4.8) | [T1](#t1), [T3](#t3), [T4](#t4) (fixed), [T14](#t14), [T22](#t22), [T23](#t23), [T26](#t26), [T27](#t27), [T28](#t28), [T32](#t32), [T37](#t37) |
| Sign-in and sign-out (4.4 to 4.9) | [T2](#t2), [T5](#t5), [T8](#t8), [T9](#t9), [T11](#t11), [T21](#t21), [T34](#t34), [T35](#t35) |
| Tasks a Company doesn't offer (8) | [T38](#t38) |
| Web browsing (5, 9.6) | [T6](#t6), [T15](#t15), [T29](#t29) |
| APIs and conversations (6, 7) | [T25](#t25), [T30](#t30), [T31](#t31) |
| Operations extension | [T24](#t24), [T36](#t36) |
| Conversations, 26 October (7.4) | [T39](#t39) |
| Security considerations and references (9, 10) | [T7](#t7), [T10](#t10) |
| Guides | [T17](#t17), [T18](#t18) |

## Contradictions and gaps

<a id="t1"></a>**T1. After `invalid_grant`, may the Session Key be used again?** Interop, Medium.

4.2 (line 345): "After `invalid_grant` on a Session Key, the Personal Agent MUST NOT use that key again, and starts a new Session with a new key." 4.8 (line 752), on an Account Token request with an existing Session's key: "`invalid_grant` can also mean the Session has ended. To tell them apart, the Personal Agent renews the Session with its assertion (4.2): `invalid_grant` there means the Session has ended." The second sentence requires a token request with the key the first sentence forbids. The same over-broad rule catches 4.5 (line 573: `invalid_grant` "for an expired or reused code, or a proof from a different key") and 4.6 (line 622: `invalid_grant` "to a poll with any other key"), where the key is fine and the code is the problem.

*Fix.* Scope the rule: a Session Key is finished when the **JWT bearer grant** signed with it returns `invalid_grant`, because that is the request that can only mean the Session ended or belongs to someone else. `invalid_grant` for an Account Token, an authorization code or a device code says nothing about the key. Then 4.8's disambiguation is consistent.

The guides take the other side: line 144, "On `invalid_grant` for an account token, delete it and continue signed out", throws away an Account Token that 4.8 says may still be valid. And the 4.2 table (line 354) makes `invalid_grant` also mean an assertion that is "missing, expired, reused, revoked, or malformed", so read literally a clock-skewed assertion or a reused `jti` on a renewal ends a healthy Session, with its cart and browser cookie.

*Our reading.* The 4.8 procedure, since it is the only way to tell the two cases apart: after `invalid_grant` on an Account Token request, renew with the assertion; retire the key only when that renewal also fails.

<a id="t2"></a>**T2. Direct and Device Sign-In with a key that names no Session.** Interop, High.

Nothing says a Session Key used in a code exchange or a device poll must already name a Session. 4.5 (line 571) says the Company "checks that the key's Session belongs to the same `client_id`" and 4.6 (line 622) "signs in that key's Session", both presupposing one exists. 4.2 says a key the Company doesn't know starts a new Session, and section 5 (line 846) generalises that to the whole token endpoint: "Unlike at the token endpoint, a key the Company doesn't know is an error, not a new Session." 4.8 (line 729) explicitly lets an Account Token with a new key "start a new Session that is already signed in". But a Session started by a code exchange has no User ID: the only request that carries one is the Session assertion (4.2), and the Session record 4.4 describes (line 521) holds "the `client_id`, the User ID, and the account". Two conforming Companies can differ: one starts a Session with no User ID, another returns `invalid_grant`; a Personal Agent that makes the Session Key when sign-in begins, which 4.5 nowhere forbids, gets either.

*Fix.* State in 4.5 and 4.6 that the Session Key MUST name a Session the Personal Agent has started with the JWT bearer grant (4.2), so the Company knows its User ID, and that a key it doesn't know gets `invalid_grant`. 4.8 is the one grant that may start a Session with a new key, because the Account Token's record carries the User ID.

*Our reading.* Start the Session (4.2) before any sign-in, as we already do; never exchange a code with a key the Company hasn't seen.

*26 October: sharper.* The new 4.10 (line 835) generalises again: "A proof from a new key starts a Session, and a proof from a known key renews it or signs it in (4.3)." 4.5 and 4.6 still presuppose the Session exists.

<a id="t3"></a>**T3. Renewing a signed-in Session with the assertion.** Interop, Medium.

4.2 (line 343): the Company "returns a new signed-out Session Token for it. A signed-in Session is renewed with the Account Token instead (4.8)." 4.4 (line 525): "Each Session Token reflects the Session as it was when the token was issued." If the Session is signed in, a token issued for it should be signed in by 4.4; by 4.2 it is signed out. Four readings are possible: the request errors; it returns a signed-in token (and "instead" is advice); it returns a signed-out token and the Session stays signed in, so the browser's cookie (section 5, "MUST follow the Session's current state") is signed in while the API token isn't; or it signs the Session out. The text existed in 0.2, but 0.3 makes it sharper by naming the Session by its key, so the request can't be told apart from a renewal of a signed-out Session.

*Fix.* Say which: the simplest is that a JWT bearer request for a signed-in Session returns a token reflecting the Session, signed in, with its current scopes, and that 4.8 is how the Personal Agent gets one when the Session Token has expired and it wants to be sure the Account Token is still good.

*Our reading.* Renew a signed-in Session only with the Account Token (4.8), never with the assertion, so we never depend on the answer.

*06:13: partly answered.* 4.2 (line 328) now says "this grant always returns signed-out tokens", so the token is signed out. Whether the Session stays signed in, and so what its browser cookie shows, is still open, and the sentence still sits beside 4.4's "Each Session Token reflects the Session as it was when the token was issued" (line 528).

<a id="t4"></a>**T4. `"scope": ""`.** Interop, Medium.

4.2 (lines 319 and 325): `scope` "is always present. A signed-out token has none", shown as `"scope": ""`. RFC 6749 §3.3 defines `scope = scope-token *( SP scope-token )`, at least one token; an empty string isn't a value of the parameter. RFC 6749 §5.1 lets a server omit `scope` when it equals what was requested, which it does for a signed-out start that requests none. An authorization server built on a standard library will omit the field or refuse to emit an empty one, and a Personal Agent that follows 4.2 literally then treats the response as malformed, or as signed in.

*Fix.* Either let `scope` be absent or empty for a signed-out token, with "present and non-empty" the signed-in signal, or state that the protocol departs from RFC 6749 here and why.

*Our reading.* Treat absent and empty `scope` alike as signed out; log nothing about which form arrived.

*06:13: fixed.* The signed-out response now has no `scope` (line 328: "There's no `scope`, because a Session started with the assertion is signed out"), and a sign-in leaves it out "only when the Company granted exactly the scopes requested", citing RFC 6749 §5.1 (line 504). The changelog gives our reason: "an empty `scope` isn't valid OAuth". [T37](#t37) is what the new rule leaves.

<a id="t5"></a>**T5. The decline redirect drops `state`.** Interop, Low.

4.5 (line 551): on success the redirect carries "a one-time `code`, the same `state`, and its `auth.issuer` in `iss`"; "If the User declines, the redirect carries `error=access_denied` and `iss` instead." RFC 6749 §4.1.2.1 makes `state` REQUIRED in the error redirect when the request had one, and 4.5 step 4 has the Personal Agent "check `state`" before anything else. As written, a Personal Agent can't tell which sign-in was declined.

*Fix.* "carries `error=access_denied`, the same `state`, and `iss`".

<a id="t6"></a>**T6. Stateless codes that MUST be single-use.** Clarity, Low.

Section 5 step 1 (line 823) lets the Company "keep the code and cookie on its servers, or make them stateless, for example by putting a keyed hash of the code and its expiry in the cookie". Step 3 (line 844) MUST check that the code "hasn't been used. A code is used by the first request that sends it, whatever the result." A fully stateless Company can't make the second check; the guides (line 293) quietly concede this: "still remember used codes until they expire". The spec should say so itself.

*Fix.* "or keep only the used codes, for example by putting a keyed hash of the code and its expiry in the cookie and remembering each code the first time it is submitted".

<a id="t11"></a>**T11. Step-up still signs out every other Session, and now invalidates their tokens.** Interop, Medium.

4.4 (line 499): when a task needs more scopes "The new Account Token replaces the old one, which the Personal Agent SHOULD revoke (4.9)." 4.9 (line 773): "The Company revokes the Account Token and signs out every Session signed in with it", and new in 0.3 (line 775) it "SHOULD also invalidate the Session Tokens issued under the same sign-in, so sign-out takes effect right away." A User with two tasks running in two Sessions, one of which steps up, has the other Session signed out and its Session Token invalidated in the middle of its work. That is 0.1's N4, and 0.3 makes the effect immediate. It is also undefined whether the stepped-up Session itself is "signed in with" the old token: its record (4.4) holds the account, not the Account Token, so a Company that tracks tokens per Session may sign it out too.

*Fix.* Either have the Company retire the superseded Account Token itself when a sign-in for the same `client_id`, User ID and account returns a new one, without signing anything out, or say that revoking a superseded Account Token doesn't sign out Sessions whose account is still covered by a current one, or drop the SHOULD revoke.

*Our reading.* Keep revoking the old token (the SHOULD), but only after every Session that holds a token from it has been renewed under the new one, and expect `invalid_token` in flight.

<a id="t22"></a>**T22. Starting a Session for a Bearer-only MCP server takes two requests, unstated.** Clarity, Low.

4.3 (line 425) says for a DPoP MCP server the Personal Agent "sends the request that starts a Session (4.2, 4.8) or renews its token" with `resource`; for one that doesn't support DPoP it rejects "any other token request for one that doesn't, with `invalid_target`" (line 426). So a Personal Agent whose first need at a Company is a Bearer-only MCP server must start a Session without `resource`, then exchange. 4.2's start request shows no `resource`, and nothing says the exchange is the second step of a start.

*Fix.* One sentence in 4.3's Token Exchange paragraph: "A Personal Agent that needs only such a server still starts the Session with the JWT bearer grant and no `resource`, then exchanges."

<a id="t23"></a>**T23. "MUST use the new token from then on" versus tokens that coexist.** Clarity, Low.

4.3 (line 470): "Whenever the Personal Agent gets a new Session Token for a Session, it MUST use the new token from then on." The same section (line 428) says "A Session can have a token for each MCP server and one for its other APIs at the same time", and 4.4 (line 525) allows one task to hold a signed-out token after another signed in. The rule is per Session and `resource`, and should say so.

<a id="t27"></a>**T27. What "the Session's scopes" are.** Clarity, Medium.

Section 5 (lines 862 and 866): the cookie "MUST follow the Session's current state: when the Session signs in or out, or its scopes change", and "The website applies the Session's scopes, as the Company's APIs do." 4.3 (line 466) lets a token request ask for "fewer scopes than the Session has". But the Session record in 4.4 (line 521) holds "the `client_id`, the User ID, and the account", no scopes: scopes are on the Account Token record and on each token. When a Session is signed in through 4.8 with `scope=orders%3Aread` from an Account Token that has `orders:write` too, one Company's website applies the Account Token's scopes and another's the narrowed token's. The APIs have no such question, because each request carries a token.

*Fix.* Define the Session's scopes: the scopes of the most recent signed-in token issued for it is the reading that keeps 4.4's "each Session Token reflects the Session" true.

<a id="t28"></a>**T28. An expired Account Token and a revoked one look the same and call for opposite behaviour.** Interop, Medium.

4.8 (line 752): "When the Account Token has expired or been revoked, the Company returns `invalid_grant`. The Session continues signed out, and the User signs in again when a task needs the account." 4.9 (line 787): after the User disconnects the Personal Agent, it "SHOULD NOT sign in to that account again unless the User asks". `refresh_token_expires_in` tells the Personal Agent when expiry is due, but a Company may expire a token early ("expire ones that go unused sooner", guides), and nothing in the response says which happened. A Personal Agent that follows 4.8 re-prompts a User who disconnected it; one that follows 4.9 never re-prompts a User whose token merely expired.

*Fix.* Return `invalid_grant` with an `error_description` the spec defines, or a distinct code, for a revoked Account Token; or say that after `invalid_grant` on an Account Token the Personal Agent asks the User before any new sign-in, whatever the cause.

*Our reading.* Ask the User before signing in again after any `invalid_grant` on an Account Token, which is what the 4.9 SHOULD requires in the case the Personal Agent can't rule out.

*26 October: partly answered.* The guides now ask Companies to "Send `refresh_token_expires_in` when an account token has a lifetime... the lifetime lets the personal agent tell the user which happened". That works for a token that reached its stated lifetime, not for one the Company expired early for being unused, which the same guides recommend, and it is a guide, not the spec.

<a id="t32"></a>**T32. Token endpoint codes the table doesn't list.** Editorial, Low.

The 4.2 table is introduced "with these codes" (lines 351–359) and lists seven. 4.6 (line 624) returns `authorization_pending`, `slow_down`, `access_denied` and `expired_token` from the same endpoint; 4.4 (line 497) rejects unavailable scopes with `invalid_scope`, which a sign-in request to the token endpoint (4.6 step 1 is the device authorization endpoint, but 4.8's `scope` is at the token endpoint) can hit; and 4.8 (line 750) says a request for more scope than the Account Token has "can't ask for more" without naming the error.

## Discovery and scopes

<a id="t33"></a>**T33. The example metadata contradicts the Token Exchange example.** Editorial, Low.

The 4.3 Token Exchange example (line 444) exchanges for `resource=https://mcp.example.com/mcp`, which 4.3 allows only for an MCP server that doesn't support DPoP; a Company that lists one "MUST support the token exchange grant, and list `urn:ietf:params:oauth:grant-type:token-exchange` in `grant_types_supported`". The 3.2 example metadata for the same Company (lines 148–153) lists four grants and not that one.

<a id="t12"></a>**T12. Grants and endpoints required of a Company with no sign-in.** Clarity, Low.

3.2 (line 169): `grant_types_supported` "MUST include `urn:ietf:params:oauth:grant-type:jwt-bearer` (4.2) and `refresh_token` (4.8)", and (line 168) `revocation_endpoint` is "Required". 4.4 (line 477): "A Company that offers none offers only signed-out Sessions." Such a Company never issues an Account Token, so it must advertise a grant and an endpoint nothing will use. Harmless, but a validator that follows 3.2 fails a Company that has nothing to revoke.

*Fix.* "`refresh_token` if the Company offers any type of sign-in", and the same for `revocation_endpoint`.

<a id="t13"></a>**T13. Which scopes need a description, and where Mediated Sign-In's scopes come from.** Clarity, Low.

4.4 (line 494): "The Company MUST describe each scope in `scopes_supported`". 3.2 lets the list include scopes the Company offers only to other clients (it "MAY leave out" them; it needn't). An issuer shared with a mobile app then has to describe every scope the app uses, in `auth.scopes`, for Personal Agents that can't request them. Separately, 4.4 (line 493) says the Personal Agent "requests only scopes from that list" and (line 496) "Mediated Sign-In can grant only the scopes in `auth.mediated.scopes`", so `auth.mediated.scopes` must be a subset of `scopes_supported` for Mediated Sign-In to be usable at all. Nothing requires it, and the validator's check for it has no basis.

*Fix.* "MUST describe each scope in `scopes_supported` that a Personal Agent can request", and in 3.1: "`scopes` lists the scopes Mediated Sign-In can grant, each in `scopes_supported`".

<a id="t16"></a>**T16. `require_pushed_authorization_requests` isn't addressed.** Clarity, Low.

3.2 (line 172) lists `pushed_authorization_request_endpoint` as optional and 4.5 (line 547) lets the Personal Agent "instead push the request". RFC 9126 §5 also defines `require_pushed_authorization_requests`; an issuer that sets it refuses ordinary authorization requests, and a Personal Agent that follows 4.5's primary path, `dpop_jkt` in the URL, can't sign in there.

*Fix.* Either say Personal Agents MUST support pushed authorization requests when the Company requires them, or say Companies MUST NOT require them.

<a id="t20"></a>**T20. Two places to describe a scope, no precedence.** Clarity, Low.

3.1 (line 124) makes `auth.scopes` required "For scopes no OpenAPI description describes" and 4.4 (line 494) says "or otherwise in `auth.scopes`", but the discovery example describes all three scopes in `auth.scopes` while listing an OpenAPI description, so both can describe one scope and nothing says which the Personal Agent shows the User. And 3.2 requires `auth` to be identical on every domain naming the issuer while the OpenAPI descriptions may differ by domain, so the same scope can be described differently at `example.com` and `example.co.uk`.

*Fix.* Name a precedence (the OpenAPI description of the API the task uses, else `auth.scopes`) or require them to agree.

## Sign-in

<a id="t8"></a>**T8. `dpop_jkt` is a MUST, then a MAY.** Editorial, Low.

4.5 (line 531): "The Personal Agent MUST include `dpop_jkt` in the URL"; line 547: it "MAY instead push the request with a proof signed with the Session Key, and leave out `dpop_jkt`". 4.3's bullet states the real rule, binding the code to the Session Key by either means. 4.5 should say the same: "MUST bind the code to the Session Key, with `dpop_jkt` in the URL or a proof on a pushed authorization request".

<a id="t9"></a>**T9. The sign-in types table keeps identifiers 0.3 removed.** Editorial, Low. *Fixed by 26 October: the table names Direct, Device and Mediated in plain text, and 4.4 says "Direct or Device Sign-In".*

4.4's table lists the types as `direct`, `device` and `mediated` in code font, as if they were wire values. In 0.2 they were the keys of `auth.direct`, `auth.device` and `auth.mediated`; in 0.3 only `mediated` remains a key, and Direct and Device Sign-In are inferred from `grant_types_supported`. Line 485 also writes "direct or Device Sign-In".

<a id="t21"></a>**T21. 4.6 checks "the link's host" but shows two links.** Editorial, Low.

Line 604: the Personal Agent shows "`verification_uri` and `user_code`, or `verification_uri_complete`", then "MUST check that the link's host" is the issuer's or a protected resource's. Both URLs need the check; a Company could pass the check on `verification_uri` and put another host in `verification_uri_complete`.

## Web browsing and secrets

<a id="t29"></a>**T29. A failed browser join has no error code, and one failure is permanent.** Clarity, Low.

Section 5 step 3 (line 848): on failure the Company "sets no cookie and returns an error page, with HTTP 400, or 429", and "After an error, the Personal Agent starts again at step 1." One cause is a Session Key the Company doesn't know (line 846), which 4.2 (line 345) says can happen after a renewal silently started a new Session; that 400 repeats forever, and the only prescribed action is to loop. The Personal Agent can't tell an expired code from an unknown Session from a bad proof.

*Fix.* Give the error page a machine-readable code, as every other endpoint has, or say that after a second 400 the Personal Agent renews the Session (4.2) before joining again.

<a id="t15"></a>**T15. The browser-session code's level.** Security, Medium.

Section 5 (line 839): "The Personal Agent reads the code and signs the proof in software its model can't read (9.2)", stated as what happens. 9.2 (line 1384) makes it a SHOULD: "Personal Agents SHOULD keep every other secret out of model context too, such as one-time codes". The guides (line 19) list "browser-session codes" among the secrets, and the changelog (line 51) confirms the choice: "Other secrets, such as one-time codes, stay a SHOULD." But the consent-phishing defence in 9.6 is exactly that no one can talk the Personal Agent into signing a code from a message, and a model that can see codes is the component that can be talked into it. Section 5's MUST ("take the code only from the page its own browser loaded") is the rule that matters, and it is only enforceable in code the model doesn't run.

*Fix.* Add the browser-session code to 9.2's MUST list, next to authorization codes and device codes, and have section 5 cite that.

*Our reading.* MUST: the code never leaves the join routine.

## APIs, conversations and Operations

<a id="t25"></a>**T25. Section 6 overclaims against its own exception.** Editorial, Low.

Line 908: "Because every token is issued to a known `client_id` and User, the Company always knows a request comes from a Personal Agent, which one, and for which User." Line 881, in the same section: a Session started by a plain MCP client "has no User ID".

<a id="t30"></a>**T30. A conversation after it uses the account: same User, different account.** Clarity, Low.

7.2 (line 943): "Once it uses the User's account, it belongs to that account instead." 7.11 (line 1313): a request "from a token for the same User that isn't signed in to that account gets `sign_in_required`". 7.13 (line 1327): `conversation_not_found` for one that "belongs to a different Personal Agent, User, or account". A token for the same User signed in to a different account fits both. And if the conversation now belongs to the account, whether a different User ID of the same Personal Agent signed in to that account may continue it is unstated.

<a id="t31"></a>**T31. No error for a parent that is itself a Direct Conversation.** Clarity, Low.

7.10 (line 1270) sets four conditions on the parent and names three errors: "`conversation_not_found`, `conversation_closed`, or `direct_conversation_open`". A parent that is a Direct Conversation meets none of those descriptions. `invalid_request` is the likely intent; say so.

<a id="t24"></a>**T24. Operations and 4.9 disagree about a confirmed operation after sign-out.** Interop, Medium.

Operations 5.2 (line 263): "Once confirmed, the operation continues even if the Session Token expires or the User signs out. To stop it, the Personal Agent cancels it." Spec 4.9 (line 777): "When the account's access is revoked, by sign-out or by the User disconnecting the Personal Agent, the Company MAY stop work in progress that uses the account, or let it finish." The guides (line 241) go further for consequential actions: "tie it to the account token, so revoking access stops it right away." A Personal Agent that shows the User "your return is confirmed and will go ahead" after they sign out is right under Operations and may be wrong under the spec. Operations v1 wasn't revised for 0.2's 4.9 or for 0.3.

*Fix.* Make Operations say what 4.9 says, and have the Company record the stop as a final status the Personal Agent can read.

<a id="t26"></a>**T26. The Terms and section 4 tables, versus the text.** Editorial, Low.

Terms (line 34) and the section 4 table (line 215) say an Account Token is used "only at the Company's token endpoint"; 4.8 (line 748) and 4.9 send it to the revocation endpoint too. Terms (line 33) say a Session Token is "used at the Company's APIs and conversations"; it also goes to the Mediated Sign-In, feedback and extension endpoints. The section 4 table (line 227) says that at sign-out "Sessions continue signed out"; 4.9 (line 773) lets the Company end them instead.

## Security considerations and references

<a id="t7"></a>**T7. RFCs the body cites that section 10 doesn't list.** Editorial, Low.

RFC 7638 (JWK thumbprint, 4.3 line 381) and RFC 9126 (pushed authorization requests, 3.2 line 172 and 4.5 line 547) are new in 0.3 and missing from the table; RFC 3339, RFC 4648 and RFC 5646 (section 7) were missing in 0.2 too. The table lists RFC 9111 and RFC 7519, which no section cites, and RFC 9728 in two rows.

<a id="t10"></a>**T10. 9.5 cites 4.7 for a rule in 4.4.** Editorial, Low. *The 9.5 citation is fixed by 26 October; the 4.2 one about anonymous IDs and the RFC 9449 §8 one in section 5 are not.*

Line 1396: Mediated Sign-In "limits it to `auth.mediated.scopes` (4.7)". The limit is stated in 4.4 (line 496); 4.7 never mentions `auth.mediated.scopes`. Likewise 4.2 (line 267) says an anonymous User ID "MUST NOT sign in with a Session that uses it (4.4)", and 4.4 says nothing about anonymous IDs. Section 5 (line 827) cites RFC 9449 §8, the authorization server's nonce, for a nonce issued by the website host; §9, the resource server's nonce, is the closer fit.

<a id="t14"></a>**T14. Why a key per Session.** Editorial, Low.

4.3 (line 381): a new key per Session "so Companies can't link Sessions or Users by their keys". Sessions of one User at one Company are linked anyway by the User ID in every Session assertion, by design (4.2). The real reasons are the ones the changelog gives: the thumbprint names the Session, and an anonymous browsing Session (4.2) leaves nothing to link. Saying "Users" alone, as 0.2 did, would be accurate.

## Guides

<a id="t17"></a>**T17. "Prefer direct, then device, then mediated (SHOULD, 4.4)".** Editorial, Low. *Fixed by 26 October: the guide now says "Prefer direct or device sign-in to mediated sign-in (SHOULD, 4.4), and direct to device sign-in (4.6)".*

Guides line 149 cite 4.4 for an order of three. 4.4 (line 487) only says "SHOULD use Direct or Device Sign-In rather than Mediated Sign-In"; it ranks neither of the first two over the other. The guides' own rule says a repeated requirement "says MUST and links to the section that requires it"; this cites a SHOULD the spec doesn't make. *06:13: partly answered.* 4.6 (line 580) now ranks Direct over Device through RFC 10027's protocol selection guidance, so the order has a basis; the guide still cites 4.4 for it, and the basis is a MUST, not a SHOULD.

<a id="t18"></a>**T18. "Token lifetimes and sign-out" misses 4.9's new SHOULD.** Editorial, Low.

Guides line 239: "Check on each request whether the session is still signed in, so sign-out takes effect right away. If you can't, keep session tokens to a few minutes (4.9)." 4.9 (line 775) now puts invalidating the Session Tokens first, and the changelog calls the per-request check and the short lifetime "the fallbacks". The guide still presents the fallback as the rule.

## Found in the 06:13 text

Line numbers in this section are in the [06:13 snapshot](../spec/draft-0.3-retrieved-2026-10-25T0613Z/README.md).

<a id="t34"></a>**T34. A disconnection made at the Company now looks like a request for more scopes.** Interop, Medium.

0.3 replaced `sign_in_required` with `insufficient_scope` everywhere. Section 6 (line 909): "A signed-out token has no scopes, so this is also the answer to a request that needs the User's account. The Personal Agent uses an Account Token that covers them (4.8), or signs in (4.4), and retries, unless the User signed out or disconnected it (4.9)." 4.9 (line 786): when the User disconnects the Personal Agent in the Company's account settings, "The Personal Agent finds out when a request fails with `invalid_token` or `insufficient_scope`". And (line 792) it "SHOULD NOT sign in to that account again unless the User asks, even when a request gets `insufficient_scope`".

A Personal Agent knows when its own User signed out. It doesn't know when the User disconnected it at the Company, and that is exactly when it gets `insufficient_scope` on a token it believes is signed in, the same answer it gets when a task needs a scope it never asked for. Following section 6 it asks the User to sign in again; following 4.9 it must not. Under 0.2 the two were different codes, so the agent could tell.

*Fix.* Either keep a distinct signal for "this token's Session is no longer signed in", or state the test an agent can apply: if the scopes the error names are all in the scope it was granted, the Session was signed out at the Company, so it renews with the Account Token (4.8), and an `invalid_grant` there means the access was revoked.

*Our reading.* That test: an `insufficient_scope` that names only scopes we hold means signed out at the Company; renew with the Account Token, and on `invalid_grant` tell the User their access was removed and don't start a sign-in.

<a id="t35"></a>**T35. "MUST follow the best practices in RFC 10027 §2" can't be checked, and mostly binds the Company.** Clarity, Low.

4.6 (line 580): "Companies that offer Device Sign-In and Personal Agents that use it MUST follow the best practices in RFC 10027 (BCP 247) §2." RFC 10027 §2 is five process rules for "implementers": "MUST perform a risk assessment", "SHOULD avoid cross-device flows if risks cannot be sufficiently mitigated", "SHOULD follow the guidance provided in Section 6.2", "MUST select appropriate mitigations from Section 6.1", "SHOULD include proximity". None can be observed on the wire, and the MUST in 4.6 leaves unclear whether §2's own SHOULDs become MUSTs. The one concrete rule for a Personal Agent, which 4.6 draws from §6.2.1.5, is to use Direct Sign-In when it can; §6.2.1.5 also says "Do not use for same-device scenarios", which applies to a Personal Agent whose User is on the device it runs on, and 4.6 doesn't say so.

*Fix.* State the Personal Agent's rules directly in 4.6 (use Direct Sign-In when the User can receive its redirect, never Device Sign-In on the User's own device), and make the Company's adoption of RFC 10027 a SHOULD with the guides' list of mitigations.

<a id="t36"></a>**T36. Operations changed incompatibly without a new version.** Interop, Medium.

Operations is still "version 1" (Operations line 20), but its 3.2 (line 109) now answers a signed-out Session with `insufficient_scope` where the 0.2 text said `sign_in_required`, and 5.2 (line 230) dropped `sign_in_required` from the confirm check. Spec 3.3 (line 199): "Changes that implementations can safely ignore keep the version, and incompatible changes get a new one." An agent written to Operations v1 as published with 0.2 looks for an error that no longer comes. The changelog tags the change Breaking and lists Operations 3.2 among its sections, so the authors know it breaks.

*26 October: a second instance.* Operations 4.3 (26 October snapshot, line 183) now shows `"author": { "type": "agent" }` where it showed `"sender"`, and the page is still "version 1" (line 20).

*Fix.* Either version Operations with the protocol before 1.0 (state that an extension's version is read together with `protocol_version`), or call this version 2.

*Our reading.* Operations behaviour follows the document's `protocol_version`, not the extension's `version` alone. Our 0.2 profile keeps `sign_in_required`; a 0.3 profile expects `insufficient_scope`.

<a id="t37"></a>**T37. "The grant says whether a token is signed in" doesn't cover Token Exchange.** Clarity, Low.

4.2 (line 328): "The grant says whether a token is signed in: this grant always returns signed-out tokens, and a sign-in (4.4) or an Account Token (4.8) always returns signed-in ones." Token Exchange (4.3, line 453) returns a Bearer token "with the subject token's scopes, or fewer", for a signed-in or a signed-out Session, and its response may leave `scope` out under the RFC 6749 §5.1 rule (line 504). A Personal Agent can work it out from the subject token, but the rule as stated has a gap, and a signed-out exchange's response is never shown.

*Fix.* Add Token Exchange to the sentence: its token is signed in exactly when the subject token is.

<a id="t38"></a>**T38. An alternative's `web` reference can point at any host.** Security, Medium.

8.2 (line 1410): a `web` reference is "A page the User can open, on the Company's website or in its app", and the guides (line 205) tell the agent to "give the user the link". Only `openapi` and `mcp` references are checked: they "MUST name an API listed in the Company's `poppy.json`. Personal Agents MUST ignore one that doesn't, so an alternative can't aim them at another Company's servers" (line 1412). Nothing checks a `web` URL's host, so a Company's excluded-tasks document, fetched without a token from any host (8.1, 9.3), can hand the User a link to another Company's look-alike page under the first Company's name. That is the attack 4.6 (line 609) closes for device sign-in links with a host check: "Otherwise a Company could pass off another Company's sign-in page as its own."

*Fix.* Apply 4.6's check: a `web` reference's host is `organization.domain`, the host of `auth.issuer` or of a URL in `protected_resources`, or a subdomain of one of them; Personal Agents ignore any other, and show the Company's `organization.name` and domain with the link. An app link on another host is a universal link the app claims, so it can be required to be on one of those hosts too.

*Our reading.* That check.

## Found in the 26 October text

Line numbers in this section are in the [26 October snapshot](../spec/draft-0.3-retrieved-2026-10-26/README.md).

<a id="t39"></a>**T39. A Company message's author picture can be on any host.** Security, Low.

7.4 now lets a Company message name its writer, and line 1137 says "`image` is the URL of the author's picture, for the Personal Agent to show next to the name." Line 1139 treats the name and picture as "content from the Company (9.1)", which covers prompt injection, but nothing limits the image's host. A Personal Agent that shows it in the User's browser tells whoever serves it the User's address and when they read the message, for every message, including in a Direct Conversation, where the Company already knows who the User is but a third party shouldn't. Section 3's rule against private addresses covers the Personal Agent's own fetches, not the User's browser.

*Fix.* Either require the image's host to be `organization.domain` or a subdomain, as 4.6 does for sign-in links, or say the Personal Agent fetches and serves the image itself, without the User's cookies or address, and SHOULD NOT load it in the User's browser directly.

*Our reading.* Show the name, never the picture, until one of those holds.

## Checked and found consistent

Things we looked at because they could have been wrong and weren't: the changelog's eighteen 0.3 entries each match the spec text they point to; the discovery example, the metadata example and the sign-in example use the same scopes; `__Host-poppy_join` has `Path=/` and no `Domain`, as the prefix requires; the join cookie's `Max-Age=60` matches the code's 60-second limit; 9.6's two attacks are both stopped by section 5's checks as written (the code can't be read cross-origin under `frame-ancestors 'none'` and COOP, the cookie can't be planted under `__Host-` and `SameSite=Strict`, and the code can't be signed from a message under the step-2 MUST); the Token Exchange response is a valid RFC 8693 response; 4.8's "RFC 9449 §5 binds refresh tokens only for public clients" is what §5 says; Operations v1 relies on nothing 0.3 removed. In the 06:13 text: the new discovery rule, that a redirect may end only at `/.well-known/poppy.json` with no query (section 3, line 49), closes the upload hole it names and agrees with 9.3; an alternative's `instructions` are called Company content under 9.1 and "not instructions the Personal Agent has to follow" (8.2), and 9.1's list now includes excluded tasks, so section 8 adds no prompt-injection gap; RFC 10027 §4.1.1 and §6.2.1.5 are cited for what they say.

## The 0.1 catalogue in 0.2 and 0.3

There was never a separate list of problems in 0.2. The 0.2 upgrade marked the 64 findings of [spec-issues.md](spec-issues.md) "not blanket-closed by this upgrade" and asked for each to be checked against the text before it was cited again ([poppy-0.2-upgrade.md](poppy-0.2-upgrade.md#old-readings)); this is that check, for 0.2 at our 19 October pin (the frozen 0.2 has the same text) and for 0.3 at 06:13 on 25 October. Checked again against the 26 October text: no grade changes. The new `refresh_token_expires_in` guide touches N28, but an unused token's early expiry is still invisible. Withdrawn findings (S6, S15, S21, N36, N37, N38) aren't listed. **Resolved** means the text now answers the finding, even where it chose differently from our suggested fix; **Partly** means part of it is answered; **Worse** means the new text makes it sharper.

In 0.2: 16 resolved, 14 partly, 34 open. In 0.3: 21 resolved, 14 partly, 28 open, 1 worse.

| ID | Finding | Severity | 0.2 | 0.3 | What the text says now |
| --- | --- | --- | --- | --- | --- |
| [N2](spec-issues.md#n2) | Sign-in isn't bound to the Session until the code is exchanged | Critical | Open | Resolved | `dpop_jkt` binds the code to the Session Key before consent; a device code binds to the first poll's key. [T2](#t2) is what's left. |
| [N9](spec-issues.md#n9) | Most URLs needn't be HTTPS | Critical | Resolved | Resolved | Every protocol URL MUST be HTTPS. Putting the Mediated Sign-In endpoint on the issuer's host was declined: 9.3 says endpoints "can be on any host". |
| [N10](spec-issues.md#n10) | Which hosts may receive Session Tokens | Critical | Open | Open | One DPoP Session Token still "works at all of a Company's services" (4.3), and nothing limits an OpenAPI description's `servers`. Our host rule stays our own. |
| [N11](spec-issues.md#n11) | A shared issuer merges unrelated Companies | Critical | Resolved | Resolved | An issuer MUST represent exactly one Company (3.2). |
| [N17](spec-issues.md#n17) | Nothing ties Bearer issuance to a listed MCP server | Critical | Resolved | Resolved | 0.2 chose the token type by the listed `resource`; 0.3 issues Bearer tokens only by Token Exchange. |
| [N45](spec-issues.md#n45) | A lost code-exchange answer orphans an Account Token | High | Open | Open | Session Keys don't help: the code is single-use and revocation still needs the token the agent never got. |
| [N43](spec-issues.md#n43) | Website actions outside Operations have no approval step | High | Open | Open |  |
| [N25](spec-issues.md#n25) | Client and Session assertions can be confused | High | Open | Open | Both name the issuer since 0.2; neither has its own `typ`, and nothing requires the client assertion's `sub` to be the `client_id`. |
| [N5](spec-issues.md#n5) | Account Token rotation has no recovery | High | Open | Open |  |
| [N8](spec-issues.md#n8) | Mediated Sign-In has no consent step | High | Partly | Partly | The agent MUST show the Company's name and domain when it asks for credentials (0.2). Nothing requires the User to agree to the scopes. |
| [N14](spec-issues.md#n14) | Consent pages show the agent's self-declared name | High | Partly | Partly | Agents MUST show the Company's name and domain at Device and Mediated Sign-In (0.2). Showing the `client_id` domain on the consent page is still only in the guides. |
| [N13](spec-issues.md#n13) | The browser cookie is a bearer credential | High | Open | Partly | 0.2 required `SameSite=Lax` or `None`. 0.3 requires `Secure` and `HttpOnly`, recommends `__Host-`, allows `Strict`, and requires nothing about `SameSite`. |
| [N15](spec-issues.md#n15) | No prompt-injection considerations | High | Resolved | Resolved | Section 9.1. |
| [S1](spec-issues.md#s1) | The client assertion's `aud` is never stated | High | Resolved | Resolved | The issuer, compared exactly. |
| [S2](spec-issues.md#s2) | Assertion `typ`, `kid` and lifetime | High | Partly | Partly | At most five minutes (0.2). `typ` and `kid` are still unstated. |
| [S22](spec-issues.md#s22) | Which writes propose operations | High | Open | Open | Operations 4.1 still defines no marker. |
| [S8](spec-issues.md#s8) | Retries after sign-out return the original response | High | Partly | Partly | 4.9's "After sign-out" (0.2) has the Company answer a signed-out token on anything that used the account with an error; 7.3 still says a retry returns "the original response", and neither says which wins. |
| [S20](spec-issues.md#s20) | Standing permissions have no checkable action | High | Open | Open | Operations unchanged on this. |
| [N46](spec-issues.md#n46) | Nothing bounds how long a Company may keep an agent checking | Medium | Open | Open |  |
| [N47](spec-issues.md#n47) | A refused revocation leaves a grant live | Medium | Partly | Partly | S1's fix removes the commonest refusal. What an agent does when revocation fails, and revocation without the token, are still undefined. |
| [N44](spec-issues.md#n44) | When to fetch discovery documents again | Medium | Open | Open | The cache bounds are still only in the guides. |
| [N39](spec-issues.md#n39) | The error for an ended Session at a resource | Medium | Partly | Partly | The token endpoint says `invalid_grant` (0.3; `invalid_session` in 0.2). A resource's answer is still unstated. |
| [N40](spec-issues.md#n40) | `wait` is a hint, but examples read like a promise | Medium | Partly | Partly | A capped `wait` is held for the cap (0.2). Still not said that the agent reads events when a send returns no reply. |
| [N41](spec-issues.md#n41) | `null` for an optional member | Medium | Open | Open |  |
| [N42](spec-issues.md#n42) | No bounded test mode | Medium | Open | Open | "Unless they were configured to on purpose" became normative in 0.2 section 3, still unbounded. |
| [N34](spec-issues.md#n34) | Which new proposals Operations 6 forbids | Medium | Open | Open |  |
| [N23](spec-issues.md#n23) | The client metadata example has no `grant_types` | Medium | Open | Open |  |
| [N6](spec-issues.md#n6) | Required token response fields aren't listed | Medium | Open | Resolved | `session_id` and `signed_in` are gone, and `scope` follows RFC 6749 (06:13). |
| [N4](spec-issues.md#n4) | Step-up revocation signs out parallel Sessions | Medium | Open | Worse | 0.3 also invalidates their Session Tokens at once ([T11](#t11)). |
| [N1](spec-issues.md#n1) | DPoP at the device and revocation endpoints | Medium | Resolved | Resolved | Requests that carry neither a token nor a token request need no proof. |
| [N3](spec-issues.md#n3) | A different account at sign-in | Medium | Resolved | Resolved | `account_mismatch`, no tokens, sign in again in a new Session. Still no account hint. |
| [N7](spec-issues.md#n7) | Mediated Sign-In's wire contract is incomplete | Medium | Resolved | Resolved | Statuses with HTTP 200, `invalid_scope`, `account_mismatch`, `sign_in_not_found`. The error for a missing field is still unnamed. |
| [N16](spec-issues.md#n16) | Three sections disagree on conversations at sign-out | Medium | Resolved | Resolved | 4.9 gathers the rule. The guides still let a Company close them. |
| [N30](spec-issues.md#n30) | Server-sent events | Medium | Partly | Partly | `Last-Event-ID` wins over `cursor` (0.2). The starting status, `wait` on a stream and `retry:` are still undefined. |
| [N21](spec-issues.md#n21) | No generic conversation error | Medium | Partly | Partly | `invalid_request` (0.2). A parent that is itself a Direct Conversation still has no error ([T31](#t31)). |
| [N19](spec-issues.md#n19) | An operation proposed signed-out can deadlock | Medium | Open | Open | Operations 3.2 still limits it to its Session, and Sessions still end. |
| [N20](spec-issues.md#n20) | Operations statuses and errors | Medium | Open | Open | Confirm, cancel and read still have no stated HTTP status. |
| [N22](spec-issues.md#n22) | No way to offer two versions at once | Medium | Open | Open | Sharper now: 0.3 breaks 0.2, and a document has one `protocol_version`, so a Company can't serve 0.2 and 0.3 agents from one `poppy.json`. |
| [N12](spec-issues.md#n12) | Signed-out tracking can't be reset | Medium | Partly | Partly | Anonymous browsing IDs (0.2). The regular User ID still can't be reset. |
| [S3](spec-issues.md#s3) | Where metadata lives for an issuer with a path | Medium | Resolved | Resolved | RFC 8414 insertion, with an example. |
| [S7](spec-issues.md#s7) | Trailing slashes in issuers | Medium | Resolved | Resolved | Exact comparison, character for character; 0.3 also forbids the slash in `protected_resources` entries. |
| [S19](spec-issues.md#s19) | Is ES256 required? | Medium | Partly | Partly | Companies MUST accept ES256 DPoP proofs (0.2). Assertion algorithms are only in the guides. |
| [S4](spec-issues.md#s4) | Signed-out `scope` | Medium | Partly | Resolved | `poppy:read` is gone and a signed-out token has no `scope`. |
| [S5](spec-issues.md#s5) | Renewing a signed-in Session with an assertion | Medium | Open | Partly | The token is signed out (06:13); the Session's state is still open ([T3](#t3)). |
| [S14](spec-issues.md#s14) | DPoP error status at resources | Medium | Resolved | Resolved | 401 with `WWW-Authenticate: DPoP`. |
| [S23](spec-issues.md#s23) | DPoP nonces per origin or per Company | Medium | Open | Open |  |
| [S13](spec-issues.md#s13) | API errors for an ended Session | Medium | Open | Open | As N39. |
| [S9](spec-issues.md#s9) | Message-id idempotency | Medium | Open | Open | In-flight retries, retries to `{id}/messages`, and "the same content" are still undefined. |
| [S12](spec-issues.md#s12) | Direct Conversations: who sends, which error | Medium | Open | Open |  |
| [N24](spec-issues.md#n24) | The metadata example breaks RFC 8414 | Low | Open | Open | Still no `response_types_supported`. |
| [N26](spec-issues.md#n26) | `auth` isn't required for extension endpoints | Low | Open | Open | 3.1's condition still leaves extensions out. |
| [N27](spec-issues.md#n27) | Discovering a subdomain | Low | Resolved | Resolved | A document speaks for the host that served it after redirects (0.2); 0.3 requires the redirect to end at the well-known path. |
| [N35](spec-issues.md#n35) | One DPoP key per User? | Low | Resolved | Resolved | MUST per User ID in 0.2; superseded by a key per Session in 0.3. |
| [N28](spec-issues.md#n28) | Account Token idle expiry is invisible | Low | Open | Open | See [T28](#t28). |
| [N32](spec-issues.md#n32) | `iss` on redirects: guides overstate 4.5 | Low | Resolved | Resolved | The guide no longer says MUST. |
| [N18](spec-issues.md#n18) | Sessions from plain MCP clients | Low | Resolved | Resolved | No User ID, can't continue signed out, ends with its sign-in. |
| [N29](spec-issues.md#n29) | `context` can't clear a field | Low | Open | Open |  |
| [N31](spec-issues.md#n31) | Declining `user_requested` is free text only | Low | Open | Open |  |
| [N33](spec-issues.md#n33) | Inconsistent examples | Low | Partly | Partly | The Operations event ID is its own (0.2). Order `#1042` against `ord_7Hk2`, and `invalid_token` for a missing token, remain. |
| [S18](spec-issues.md#s18) | `web` has no URL | Low | Open | Open |  |
| [S16](spec-issues.md#s16) | Approving zero scopes | Low | Partly | Resolved | "If the User approves none, it ends as a decline." |
| [S10](spec-issues.md#s10) | The cursor on an empty first read | Low | Open | Open | With no events and no request cursor, `cursor` is still undefined. |
| [S11](spec-issues.md#s11) | `sign_in_required` has no `scope` | Low | Open | Resolved | `insufficient_scope` names the scopes (06:13). |
| [S17](spec-issues.md#s17) | Can another User ID continue an account's conversation? | Low | Open | Open | See [T30](#t30). |
