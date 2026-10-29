# A second Poppy client, and stateful tests of our mock Company

Our TypeScript client (`src/poppy/`) and our mock Company (`test/mock-company/`) were written by the same people under the same readings of the text, so a misreading they share passes every test. This directory checks the mock from outside, with:

- **an independent Poppy client in Python** (`poppy_client.py`), written from the 28 October text of Poppy 0.3 (`spec/draft-0.3-retrieved-2026-10-28/`) and our readings (`docs/readings.md`), not ported from `src/poppy`. It covers discovery from the domain's protected resource metadata, client assertions, the Session header (a delegated key, its delegation and a Session JWT per request), DPoP proofs with nonces and `ath` when the issuer lists ES256, the three sign-in types (Direct, Device, and Mediated Sign-In's grant), refresh tokens with rotation, revocation, conversations with handoff and Direct Conversations, Operations 2, MCP with a token for the server's `url`, the browser join, Device Sign-In polling, and rate limits;
- **five Hypothesis stateful, model-based tests** (`RuleBasedStateMachine`s) that drive it against the mock and hold every response to a model. `machine.py` has the model, the rules they share and the invariants they all hold; each `test_*.py` is one machine. `test_oracles.py` checks, without a Company, that the model's oracles reject wrong answers.

It was written for Draft 0.1 in October and ported to 0.3 on 29 October, when the mock stopped speaking anything else ([decision 37](../../docs/decisions.md)).

**Maintenance.** By the owner's decision on 12 October 2026, this client is maintained only as an occasional local check, run after a change to the text or a large change to the mock Company. It is not expanded feature by feature.

## Running it

```sh
npm run test:hypothesis                                 # default: 100 runs of up to 30 steps per machine
npm run test:hypothesis -- --hypothesis-profile=deep    # 2,000 runs of up to 60 steps per machine
```

It needs `uv` and Node; `uv run --frozen` installs the pinned, hash-locked dependencies from `uv.lock` into `.venv/`. It is local only: not part of `npm test`, not in CI. Everything stays on 127.0.0.1, with no Docker. After dependencies are installed, no external service or paid model is used. The default profile took 99 seconds on 29 October; a deep run of the 0.1 client took 95 minutes with four workers. These are observations, not runtime promises.

## How it reaches the mock

`launcher.ts` runs the mock in Node, bundled by `interop/impls/shared/build.mjs` like the interop adapter, under `<id>.company.interop.test`. The Python client's transport sends each `https://` request to 127.0.0.1 with the Company's host in `Host` and `X-Forwarded-Proto: https`, as the interop proxy does, so the mock checks `htu`, `aud` and the issuer against the real URLs. No check is relaxed. The Python agent's client metadata and JWKS, and a second agent's for the reject rules, reach the mock through its `serveClientDocument` and are checked like any other client's.

**The clock.** The client times requests on its own clock (`Clock`), which starts at the real time and moves only when the agent waits. The transport stamps it on every request in `x-test-clock`, the header the mock reads for rate limits, device polling and token age (`CLOCK_HEADER` in `test/mock-company/core.ts`). So waiting out a `Retry-After`, a device `interval` or `expires_in` costs nothing and every timing is exact. JWTs carry the real time, which is what the mock checks them against.

**The client's limiter.** The transport is also the client's one rate limiter for the Company (5.6; the Guides' "Rate limits": share a Company's limits across tasks and Users): after a 429 it sends nothing to the Company until the `Retry-After` has passed. The client resends a refused request with a new Session JWT, proof and client assertion.

The launcher's control port has the interop hooks and `GET /violations` of `interop/impls/shared/mock-hooks.ts`, the module the `lenient-company` adapter uses too, `GET /state`, and `POST /reset` with the settings a run draws (`KNOBS` in `launcher.ts`): strict or lenient assertions, DPoP-bound or Bearer tokens, rotation and reuse detection, nonces per Company or per origin, token responses without `scope`, an issuer with a trailing slash, sign-out that ends Sessions, streaming, text deltas, keep-alives, whether the Company Agent replies, refusing writes from agents without the extension, operation ids with the Company's own prefixes (`booking:`, `ord#`, `a/b `, `%41`, accented), the device `interval` and `expires_in`, and the events per page.

## The machines

Every machine holds three invariants after every step:

- `GET /violations` holds exactly the ids its reject rules expect, in order, and nothing after honest rules.
- The Company's Sessions are the ones our requests started, by `sid` (5.3): each the User's, signed in to the account its last request's token was for, or signed out, and ended as the model says. The model follows the Company's side of each Session as well as the agent's: a Session the Company has seen, the sign-in its last token came from, and the account it was ever used with.
- Over every request the client sent, the Session header went to every resource (APIs, conversations, MCP, the browser join's `authorize`, feedback) and never to an OAuth endpoint, a website page or a well-known document (5.2), but for the reject rules that break it on purpose.

The run ends by printing how often each rule reached each outcome, so a rule that stopped firing shows.

Every read of a conversation to its end is held to the log checks in `machine.py`: our messages once each, in order, as sent; every event read once, in order, resuming from the cursor, JSON and stream alike; every message with `author.type` and none with 0.2's `sender` (8.4); a `state` event marks a change, and while `queued` the responder is `agent` (8.7); a person's message comes after a `state` event saying `human`; nothing changes after `closed` (8.12); each Direct Conversation opened has `direct_opened` and, once closed however it closed, `direct_closed` (8.10); each `user_requested`, with its reason; no operation for an agent that doesn't list Operations 2; and the last `state` event and the read's `status` and `responder` are the model's.

### `test_mock_company.py`: Sessions, sign-in, conversations

Honest rules: discover again; add Users; start Sessions (a new `sid`, nothing requested); switch DPoP keys; sign in by Direct, Device or Mediated Sign-In with any subset of the offered scopes, approved in full or in part, the token going to a Session never used with another account or to a new one (5.4); sign a Session in from a stored refresh token; refresh, perhaps narrower; sign out by revoking the refresh token; meet a Session the Company ended (`invalid_session`) and start a new one; call the OpenAPI reads (a 401 challenge naming the scopes signed out, `insufficient_scope` short of them); start conversations, send, retry with the same id (members in any order, any spelling), read as JSON or a stream, from the start or the saved cursor; close.

Reject rules: a replayed client assertion, DPoP proof (at the token endpoint and at a resource) or Session JWT; any client assertion `aud` but the issuer as a string (4.1); the Session header at an OAuth endpoint; a tampered Session JWT (`typ`, signature, `kid`, `aud`, `htm`, `htu`, `ath`, no `sub` or `sid`) or delegation (longer than a day, naming the User); one delegated key for two User IDs; a DPoP-bound token with another key's proof, or as Bearer; an access token in another agent's Session; a rotated refresh token used again (with reuse detection, its sign-in revoked); a revoked one; one from another client; a second account in one Session; a sign-in asking for no scope or an unlisted one; a message id reused with other content; a message to a closed conversation; an invalid cursor.

Who may use a conversation is 8.2 and 8.11 with our reading of S17 (`docs/readings.md`): its User; once it used an account, any Session of the agent signed in to that account, whichever User; the same User not signed in to it gets a challenge for the account (401, no error code), anyone else `conversation_not_found` (recorded as a cross-User reach).

### `test_operations.py`: Operations 2

A write that needs approval is refused with the operation through every channel the mock has: the OpenAPI exchange (403 `approval_required`), the MCP tool (an error result with the operation in `structuredContent`), the Company Agent's message in a conversation that used the account, and the print shop's order (signed out or in, with photos uploaded in that Session). The same request sent again with `Poppy-Approval`, `_meta` or a message's `approval` naming a revision the Company returned is performed; sent again, approved, it gets the first response (Ops 7). An agent without the extension gets the exchange done at once, or `extension_required` naming it.

Reject rules: an approval from a Session that may not approve it (no approval: the Session gets its own operation); an approval naming a revision never returned, or sent with a changed request (a new revision, never the one named); the approved request reusing the first request's `Idempotency-Key`; a malformed `Poppy-Approval`, `_meta` approval or message `approval` (recorded, and no approval); a second exchange of an item already exchanged; a print order without its required `Idempotency-Key`; a performed order's key reused with another body.

The model: each operation's request and channel, who may approve it (Ops 3: the same agent and User signed in to its account, or only its own Session when returned signed out), every revision fixed once returned, whether it was performed and its first response, and how many approvals reached it. Through `GET /state` it holds the Company to the same operations, revisions and approvals, and to the number of actions performed (at most once, Ops 7).

### `test_handoff_direct.py`: handoff and Direct Conversations

On top of the conversation rules: hand off (202, `queued`, responder `agent`); a person joins (`human`); no one is available (back to `idle` with `agent`, 8.9); the Company closes a conversation; the Company asks for the User (`user_requested`); open a Direct Conversation from any conversation and any Session, with the outcome 8.10 gives (`conversation_not_found` for another User's parent or a Direct Conversation, a challenge signed out of the parent's account, `conversation_closed`, `direct_conversation_open` naming the open one, or 201); a message or handoff to a parent while its Direct Conversation is open (`direct_conversation_open`); a handoff to a closed conversation. By our reading of S12, the agent's own words opening or sent into a Direct Conversation are accepted and recorded. Reads use pages of 1 to 20 events.

### `test_mcp_browsing.py`: MCP and the browser join

MCP (7): every request carries the Session header and, signed in, a token for the server's `url` from the refresh token with `resource` (RFC 8707), asked for again when the Session's sign-in changes; `initialize`, `tools/list`, `tools/call`; the exchange tool needs `orders:write` (signed out, a Bearer challenge naming the scope and the server's metadata; short of it, `insufficient_scope`; with it, an operation); the server's protected resource metadata names it and the issuer. Reject rules: the Company's default token at the MCP server; the MCP server's token at the OpenAPI API.

The browser join (6): the Personal Agent's own browser loads the join page (not cached, not framed, a `__Host-` cookie that is Secure and SameSite Strict), our request authorizes its code at `{endpoint}/authorize` (204), the browser submits the code alone (303, the Session's cookie Secure and HttpOnly); then the website acts for the account and scopes the join authorized until that sign-in is revoked, and never for an ended Session. Reject rules: the code submitted before it was authorized, twice, or from another browser; authorized twice, or as a form.

### `test_limits_device.py`: rate limits and Device Sign-In polling

Rate limits (5.6): the `rate_limit` hook makes the next n token or resource requests 429. An invariant replays the Company's limiter over every request the client sent and holds each answer to it: which got 429, each with the `Retry-After` it should carry. The honest rules carry on through the limits. Reject rules: the same request again inside its `Retry-After` (429, the MUST, recorded), and a different request inside another's (429, the Guides' advice, recorded as a warning).

Device Sign-In (4.3): start (the codes, `verification_uri`, `expires_in`, `interval`); the User approves (some or all scopes, for an account) or declines, at once or between polls; time passes; poll every `interval` (`authorization_pending`, `access_denied`, `expired_token`, or the tokens, which go to a Session as any sign-in's do). Reject rules: polling sooner than `interval` (`slow_down`, and 5 s more for every later poll; too soon again is recorded, RFC 8628 3.5); polling after the final answer (recorded).

## Bounds

For cost, not to dodge failures: reads never ask for `wait`, and retries don't either, since a long poll with nothing new holds each step for up to the mock's 2 s cap; a send asks for `wait` (0 or 1) only where its own message is already there to return. JSON integers stay within ±(2^53 − 1), RFC 8259's interoperable range. A device poll the rule means to be too soon stays 300 ms short of the interval, because the mock allows 250 ms of jitter.

`machine.WarmUp` starts the operations, MCP and rate-limit machines with up to three Users and up to four sign-ins, drawn as the `sign_in` rule draws them, so states such as two Users in one account are reached within the steps.

Not covered: an operation's `expires_at` passing (the mock times it on the real clock, ten minutes on); `cursor_expired`; streams the Company closes early; the Direct Sign-In consent page and `deny_authorization`; excluded tasks and feedback (9); the mock's knobs that model a Company departing from the text (`neverQueued`, `ignoreWait`, wrong issuers, redirects).

## What it found

**In the 0.3 port, 29 October.** Device Sign-In refused `addresses` with `invalid_scope`, though the issuer lists it in `scopes_supported`, which 4.7 says holds every scope a Personal Agent can request. The mock now leaves out a listed scope a sign-in type can't grant, as RFC 6749 3.3 allows, and refuses only an unlisted scope or a request with nothing left to grant. Writing the model showed a second slip: with `omitTokenScope`, the mock left `scope` out of the token response even when it granted less than was asked, which RFC 6749 5.1 forbids; it now names the scope whenever it differs. Both have regression tests in `test/mock-company.test.ts` under "the mock Company, as the Hypothesis model found it".

**With the 0.1 client, October.** The ledger is in `docs/spec-issues.md` (N4, S8, S9). Each was fixed in the mock and has a regression test in `test/mock-company.test.ts`:

- **Another User's operation** (Operations 1). A proposal of the jacket exchange returned the open operation of whichever User was signed in to the same account first. The mock now matches an operation only for the same agent and User, as Operations 2 still requires.
- **A handoff while a person handles the conversation** set `queued` with `responder: human`; the text says that while queued the responder stays `agent`. The mock now changes nothing: there's no one to find.
- **No `direct_closed` when the parent's close closed its Direct Conversation.** The mock now closes the Direct Conversation first, so the parent gets `direct_closed`, then its own `closed`.
- **Any request inside a `Retry-After` was the MUST**, though the text says "before sending *the request* again". The mock records `rate-limit.retry-after-ignored` only for the same request sent again, and a different request as `rate-limit.shared-limit-ignored`, a Guides warning.

Questions for the text's authors these models raised, not in `docs/poppy-0.3-issues.md`:

- **Handoff while a person is already handling the conversation** (8.9): a no-op, a new queue with `responder: agent`, or an error?
- **The parent's own close and `direct_closed`** (8.10, 8.12): does closing the parent add `direct_closed` to it, and before or after its `closed` state?
- **"The request again"** (5.6): only the request that got 429, or anything sent to that Company? It decides whether an agent that keeps one limiter per task, not per Company, is conformant.
