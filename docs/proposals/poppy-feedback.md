# Focused feedback on Poppy 0.3

Prepared for owner review; not sent. Suggested destination: the draft authors' feedback channel, after the owner confirms the contribution terms in [SECURITY.md](../../SECURITY.md). This batch contains editorial interoperability issues, not reports about vulnerabilities in other implementations.

## Draft message

Subject: Three small clarifications in the 29 October Poppy 0.3 text

We implement a Personal Agent and a mock Company in [PDA](https://github.com/adewale/pda). These findings refer specifically to our [29 October snapshot](../../spec/draft-0.3-retrieved-2026-10-29/README.md). They are not claims about later revisions. Could you clarify these three points?

1. **Refresh-token optionality (§4.4 and §4.7).** §4.4 says a Company MAY return a new refresh token, but §4.7 says sign-in and refresh return an access token and a refresh token. Suggested wording: a refresh response includes an access token and may include a replacement refresh token. A response containing only `access_token`, `token_type` and `expires_in` should therefore be valid; the client keeps its existing refresh token. [Original finding 37](../poppy-0.3-issues.md#37-refresh-responses).
2. **The browser-join code has two distinct uses (§6).** “Each code works once” can be read as consuming it at authorization, before the browser submits it. Suggested wording: “each code can be authorized once and submitted once.” Accept the first authorization and first submission; reject a second of either. [Original finding 42](../poppy-0.3-issues.md#42-each-code-works-once-but-the-browser-join-code-is-used-twice).
3. **Advertise support for the authorization response issuer (§4.2).** The agent must check the returned `iss`, but the listed issuer metadata does not require RFC 9207's `authorization_response_iss_parameter_supported`. Suggested addition: require that metadata member to be `true`. This lets document validation identify a missing prerequisite before attempting sign-in. [Original finding 43](../poppy-0.3-issues.md#43-the-issuer-isnt-asked-to-say-it-sends-iss).

Each item has a small wording change and an observable acceptance case. Happy to provide a focused specification patch if useful.

## Review and disposition

The quoted claims come from the pinned text and existing findings. Before sending, check only these three passages against the authors' current text and drop any resolved item. Do not re-audit the ecosystem or refresh all historical findings. Record the sent date and response link here once sent; no separate tracking ledger is needed.

The remaining historical audit is supporting material, not a prerequisite for this batch. The old everruns duplicate-migration finding is already fixed upstream and needs no new report. Potential vulnerabilities remain subject to private disclosure under SECURITY.md; none are included here.
