# Issues in Personal Agent Protocol 0.4

Drafts for the owner's review. **Nothing here has been submitted**, and nothing will be without the owner's approval.

From the [Poppy Demo Agent](https://github.com/adewale/pda) project, which implements a Personal Agent and a strict mock Company for Poppy 0.3 and 0.4. These are issues in the upstream text and its company kit, found while implementing 0.4; how PDA reads each one meanwhile is in [readings](readings.md#04-readings-11-november-text).

**What we read.** Version 0.4 as published on 11 November 2026, the 1.0 release candidate ([pin](../spec/draft-0.4-retrieved-2026-11-11/README.md)), and the company kit of the same day ([pin](../spec/company-kit-2026-11-11/README.md)). Quotations are verbatim from those files. All three issues were first found in the 10 November draft and are unchanged in the published text.

## 1. A Company serving 0.3 and 0.4 can't reject a request for lacking `Poppy-Version`

*Contradiction. §3.4.*

§3.4, "Checking the version":

> An endpoint that verifies the Session header (5.3) MUST also check `Poppy-Version`. It rejects a request without it, or with a version that isn't compatible with one the Company serves, with `version_unsupported` (HTTP 400, JSON body), and MUST NOT handle the request under another version.

0.3 defines no `Poppy-Version` header, so a 0.3 Personal Agent never sends one. A Company that serves 0.3 beside 0.4 through `supported_versions`, as §3.4 invites, can't tell a 0.3 request from a 0.4 request that left the header out. Following the text, it must refuse every 0.3 request, which defeats serving 0.3.

The kit follows the text: its `session.version-missing` check fails a Company that accepts a request without the header, including one that serves 0.3. Our reviewed kit run serves 0.4 alone to pass it.

**Suggested fix.** Treat a request without `Poppy-Version` as a 0.3 request: a Company that serves 0.3 handles it under 0.3; one that doesn't rejects it with `version_unsupported`. The kit's check would then apply only to a Company that doesn't serve 0.3.

## 2. The kit resolves skill URLs against `poppy.json`; the text says `tasks.endpoint`

*Kit and text disagree. §9.4; kit `schemas/skill-index.schema.json`.*

§9.4, "URLs":

> Personal Agents MUST resolve an entry's `url` against `tasks.endpoint`, using [RFC 3986 §5](https://www.rfc-editor.org/rfc/rfc3986#section-5).

The kit's schema describes the same field as:

> An HTTPS URL or a relative reference resolved against the final poppy.json URL.

The two bases differ whenever `tasks.endpoint` isn't at the root of the `poppy.json` host, as in §9's own example (`https://api.example.com/...`). A Company that tests its relative references against the kit's description publishes skills that a Personal Agent following §9.4 fetches from the wrong place. The schema only checks the pattern today, but the description is what a Company author reads.

**Suggested fix.** Change the schema's description to name `tasks.endpoint`.

## 3. Whether a feedback report may carry an access token

*Ambiguity. §5.2, §9, §9.3.*

§9 says the tasks request carries "no access token, even in a signed-in Session". §9.3 says a Company "needs no scope" for a report, and verifies the Session header "signed in or signed out", but also:

> Token errors, `invalid_session`, and `session_ended` are the ones in section 7.

Token errors only arise if a token is sent. Meanwhile `feedback.endpoint` comes from the tasks response and may be on any host (§9.4 allows other domains for artifacts; §9.3 only says "an HTTPS URL"), while §5.2 makes it a Session destination. A Personal Agent can't tell whether to send the User's access token there, or whether a Company may require one.

PDA sends the Session header and never a token, since no scope is needed and the host isn't vetted as the Company's.

**Suggested fix.** Say that a report carries no access token, as the tasks request doesn't, and drop "token errors" from §9.3; or, if signed-in reports are wanted, require `feedback.endpoint` to be on a host that receives the Company's tokens.
