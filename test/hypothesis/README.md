# A second Poppy client, and stateful tests of our mock Company

Our TypeScript client (`src/poppy/`) and our mock Company (`test/mock-company/`) were written by the same people under the same readings of the draft, so a misreading they share passes every test. This directory checks the mock from outside, with:

- **an independent Poppy client in Python** (`poppy_client.py`), written from Draft 0.1 (`spec/draft-0.1-2026-10-09/`) and our spec's readings, not ported from `src/poppy`. It covers discovery, client and Session assertions, DPoP proofs with nonces and `ath`, the token grants, Account Token renewal and rotation, conversations with handoff and Direct Conversations, sign-out, the Operations extension, MCP with Bearer Session Tokens, joining a browser to a Session, Device Sign-In polling, and rate limits;
- **five Hypothesis stateful, model-based tests** (`RuleBasedStateMachine`s) that drive it against the mock and hold every response to a model. `machine.py` has the model, the rules they share and the invariants they all hold; each `test_*.py` is one machine.

**Maintenance.** By the owner's decision on 12 October 2026, this client is maintained only as an occasional local check, run after a change to the draft or a large change to the mock Company. It is not expanded feature by feature.

## Running it

```sh
npm run test:hypothesis                                 # default: 100 runs of up to 30 steps per machine
npm run test:hypothesis -- --hypothesis-profile=deep    # 2,000 runs of up to 60 steps per machine
```

It needs `uv` and Node; `uv run --frozen` installs the pinned, hash-locked dependencies from `uv.lock` into `.venv/`. It is local only: not part of `npm test`, not in CI. Everything stays on 127.0.0.1, with no Docker. After dependencies are installed, no external service or paid model is used. A deep run on 16 October took 95 minutes with four workers while other checks were running; this is an observation, not a runtime promise. Default and deep profiles have very different costs.

## How it reaches the mock

`launcher.ts` runs the mock in Node, bundled by `interop/impls/shared/build.mjs` like the interop adapter, under `<id>.company.interop.test`. The Python client's transport sends each `https://` request to 127.0.0.1 with the Company's host in `Host` and `X-Forwarded-Proto: https`, as the interop proxy does, so the mock checks `htu`, `aud` and the issuer against the real URLs. No check is relaxed. The Python agent's client metadata and JWKS reach the mock through its `serveClientDocument`, made for a second client, and are checked like any other client's.

**The clock.** The client times requests on its own clock (`Clock`), which starts at the real time and moves only when the agent waits. The transport stamps it on every request in `x-test-clock`, the header the mock reads for rate limits, device polling and token age (`CLOCK_HEADER` in `test/mock-company/core.ts`). So waiting out a `Retry-After`, a device `interval` or `expires_in` costs nothing and every timing is exact. JWTs carry the real time, which is what the mock checks them against.

**The client's limiter.** The transport is also the client's one rate limiter for the Company (4.3; the Guides' "Rate limits": share a Company's limits across tasks and Users): after a 429 it sends nothing to the Company until the `Retry-After` has passed. The client resends a refused request with new proofs and assertions.

The launcher's control port has the interop hooks and `GET /violations` of `interop/impls/shared/mock-hooks.ts`, the module the `pda-mock` adapter uses too, `GET /state`, and `POST /reset` with the settings a run draws: strict or lenient assertions, the client assertion's `aud` (S1), rotation and reuse detection, nonces per Company or per origin (S23), token responses without `scope`, an issuer with a trailing slash, sign-out that ends Sessions, which error an ended Session gets, streaming, text deltas, keep-alives, whether the Company Agent replies, slow confirms, operations that need the User's own approval, refusing writes from agents without the extension, operation ids with the Company's own prefixes (`booking:`, `ord#`, `a/b `, `%41`, accented), the device `interval` and `expires_in`, and the events per page. Besides the interop spec's hooks, the shared module has five the interop spec's table doesn't list, which only our mock implements: `revise_operation`, `confirm_on_website`, `staff_unavailable`, `company_close` and `request_user`.

## The machines

Every machine holds three invariants after every step: `GET /violations` holds exactly the ids its reject rules expect, in order, and nothing after honest rules; the Company's Sessions are the ones the model started, ended as it says; and, over every request the client sent, a Bearer token went only to the MCP server's `url` and DPoP everywhere else (4.3), but for the reject rules that break it on purpose. The run ends by printing how often each rule reached each outcome, so a rule that stopped firing shows.

Every read of a conversation to its end is held to the log checks in `machine.py`: our messages once each, in order, as sent; every event read once, in order, resuming from the cursor, JSON and stream alike; a `state` event marks a change, and while `queued` the responder is `agent` (7.7); a person's message comes after a `state` event saying `human`; nothing changes after `closed` (7.12); each Direct Conversation opened has `direct_opened` and, once closed however it closed, `direct_closed` (7.10); each `user_requested`, with its reason; no operation for an agent that doesn't list the extension (Ops 2); and the last `state` event and the read's `status` and `responder` are the model's.

### `test_mock_company.py`: Sessions, sign-in, conversations

Honest rules: discover from every domain the Company names; add Users; start and renew Sessions; switch DPoP keys; sign in by Direct, Device or Mediated Sign-In with any subset of the offered scopes, approved in full or in part; sign in with a stored Account Token; sign out; call the OpenAPI reads; start conversations, send, retry with the same id (members in any order, any spelling), read as JSON or a stream, from the start or the saved cursor; close.

Reject rules: a replayed client assertion, Session assertion or DPoP proof; any `aud` (accepted exactly when the draft or the Company's reading of S1 says so); a stolen Session Token with another key; a rotated Account Token used again; a revoked one; an Account Token from another client; a message id reused with other content; a message to a closed conversation; an invalid cursor; another User's conversation; a read after sign-out of a conversation that used the account; an ended Session.

Who may use a conversation is 7.2 and 7.11 with our reading of S17 (`docs/readings.md`): its User; once it used an account, any Session of the agent signed in to that account, whichever User; the same User signed out of it gets `sign_in_required`, anyone else `conversation_not_found` (recorded as a cross-User reach).

The model: who is signed in, to which account, with which scopes; a retry answers for the original conversation and adds nothing.

### `test_operations.py`: the Operations extension

Proposals through every channel: the OpenAPI exchange (202 with the operation; for an agent without the extension, done at once or `extension_required`; a retry with the same `Idempotency-Key` answers for the same request), the MCP tool (`structuredContent.operation`), a Company message (Ops 4.3, or an `authorization` event when signed out or short of scopes), and the print shop's signed-out order. Then confirm with the revision the User was shown and an approval the operation allows, read after `Retry-After`, cancel, look at its `url` on the website in the same Session (Ops 4.4), and the Company's side: a new revision, a confirm on the website.

Reject rules: a standing permission where `user_approval_required` (403 `user_approval_required`); a revision that isn't the latest (409 `terms_changed` with the current operation); a malformed confirm (a revision that isn't an integer, an `approved_by` that isn't `user` or `standing_permission`); asking for a new proposal of the same action after a confirm, before it's final (Ops 6, N34).

The fixture has one exchangeable jacket per account. An approved exchange that is still pending reserves that jacket, so another User cannot approve a second exchange of it before the first finishes. Retries of the same operation, other accounts and print orders remain enabled; cancellation releases the reservation. This is a business-fixture constraint, not a new protocol restriction.

The model: each operation's revisions, each fixed once issued (3.1); its state, never changing once final; `confirmation` null until confirmed, then the revision and approval; `result` null until final; who may use it (3.2: the same agent and User signed in to its account, or only its own Session when proposed signed out); the open operation a proposal of the same action returns (Ops 4); and, through `GET /state`, that the Company performed exactly the confirmed actions, once each (at most once, Ops 1, 6).

### `test_handoff_direct.py`: handoff and Direct Conversations

On top of the conversation rules: hand off (202, `queued`, responder `agent`); a person joins (`human`); no one is available (back to `idle` with `agent`, 7.9); the Company closes a conversation; the Company asks for the User (`user_requested`); open a Direct Conversation from any conversation and any Session, with the outcome 7.10 gives (`conversation_not_found` for another User's parent or a Direct Conversation, `sign_in_required` signed out of the parent's account, `conversation_closed`, `direct_conversation_open` naming the open one, or 201); a message or handoff to a parent while its Direct Conversation is open (`direct_conversation_open`); a handoff to a closed conversation. By our reading of S12, the agent's own words opening or sent into a Direct Conversation are accepted and recorded. Reads use pages of 1 to 20 events.

### `test_mcp_browsing.py`: MCP and web browsing

MCP: a Bearer token from the Session's renewal without DPoP and with `resource` (4.3), `token_type` Bearer, renewed when the Session's sign-in changes; `initialize`, `tools/list`, `tools/call`; the exchange tool needs a signed-in token with `poppy:write` (`sign_in_required`, `insufficient_scope` in a Bearer challenge); without a token, 401 with a Bearer challenge naming the protected resource metadata at the RFC 9728 location, whose `authorization_servers` include `auth.issuer` (6). Reject rules: the DPoP token at the MCP server with either scheme; the Bearer token at the OpenAPI API with either scheme; a token request without DPoP for anything but the MCP server; a DPoP-bound token for the MCP server.

Browsing (5): join with `return_to` drawn on the Company's domain (303 to it, and a cookie that is Secure, HttpOnly and SameSite Lax or None), off it, or not a URL (400, no cookie); then the website follows the Session as it signs in, changes scope, signs out or ends. Reject rules: each flaw alone (the `typ`, a lifetime over 60 s, the `aud`, another User's or an unknown Session, the assertion in the URL, a replayed `jti`) is 400, no cookie, its own record; a browser assertion at the token endpoint.

### `test_limits_device.py`: rate limits and Device Sign-In polling

Rate limits: the `rate_limit` hook makes the next n token or resource requests 429. An invariant replays the Company's limiter over every request the client sent and holds each answer to it: which got 429, each with the `Retry-After` it should carry. The honest rules carry on through the limits. Reject rules: the same request again inside its `Retry-After` (429, the MUST of 4.3, recorded), and a different request inside another's (429, the Guides' advice, recorded as a warning).

Device Sign-In: start (the codes, `verification_uri`, `expires_in`, `interval`); the User approves (some or all scopes, for an account) or declines, at once or between polls; time passes; poll every `interval` (`authorization_pending`, `access_denied`, `expired_token`, the tokens, or `account_mismatch` into a Session bound to another account, after which the request is still approved). Reject rules: polling sooner than `interval` (`slow_down`, and 5 s more for every later poll; too soon again is recorded, RFC 8628 3.5); polling after the final answer (recorded).

## Bounds

For cost, not to dodge failures: reads never ask for `wait`, and retries don't either, since a long poll with nothing new holds each step for up to the mock's 2 s cap; a send asks for `wait` (0 or 1) only where its own message is already there to return. JSON integers stay within ±(2^53 − 1), RFC 8259's interoperable range. A device poll the rule means to be too soon stays 300 ms short of the interval, because the mock allows 250 ms of jitter. A browser `return_to` with a trailing dot on the host is in no class: the draft doesn't say whether it is the Company's domain.

`machine.WarmUp` starts the operations, MCP and rate-limit machines with up to three Users and up to four sign-ins, drawn as the `sign_in` rule draws them, so states such as two Users in one account are reached within the steps.

Not covered: an operation's `expires_at` passing (the mock times it on the real clock, ten minutes on); `cursor_expired`; streams the Company closes early; the Direct Sign-In consent page and `deny_authorization`; the mock's knobs that model a Company departing from the draft (`neverQueued`, `ignoreWait`, wrong issuers, redirects).

## What it found

The ledger is in `docs/spec-issues.md` (N4, S8, S9); each finding has a regression test in `test/mock-company.test.ts` under "the mock Company, as the Hypothesis model found it". Found while closing the gaps above, each now fixed in the mock:

- **Another User's operation** (Ops 3.2, 4). A proposal of the jacket exchange returned the open operation of whichever User was signed in to the same account first, which the second User then couldn't read, confirm or cancel (`operation_not_found`). The mock now matches an open operation only for the same agent and User.
- **A handoff while a person handles the conversation** (7.7, 7.9) set `queued` with `responder: human`; 7.7 says that while queued the responder stays `agent`. The mock now changes nothing: there's no one to find.
- **No `direct_closed` when the parent's close closed its Direct Conversation** (7.10: "When the Direct Conversation closes, the Company adds a `direct_closed` event to the parent"). The mock now closes the Direct Conversation first, so the parent gets `direct_closed`, then its own `closed`.
- **The print shop's operation `url` was a 404** (Ops 3: "A page on the Company's website that shows this operation"). The mock's website now shows an order of prints there, in its Session.
- **Any request inside a `Retry-After` was the MUST** (4.3: "MUST wait at least that long before sending *the request* again"). The mock still answers 429 inside the window, but records `rate-limit.retry-after-ignored` only for the same request (method and URL) sent again, and a different request as `rate-limit.shared-limit-ignored`, a Guides warning. Our TypeScript client never sees the difference, since it shares one limiter per Company; the grid's own trace check (`interop/runner/checks.ts`) still treats any request to the peer as a retry.

Questions for the draft's authors, raised by these models (not yet in `docs/spec-issues.md`):

- **Handoff while a person is already handling the conversation** (7.9): a no-op, a new queue with `responder: agent`, or an error?
- **The parent's own close and `direct_closed`** (7.10, 7.12): does closing the parent add `direct_closed` to it, and before or after its `closed` state? 7.12 says a closed conversation takes no more messages; can it take events?
- **The order of a confirm's checks** (Ops 5.2): the list puts "the latest revision" before "the operation is `proposed`", so is a confirm naming an old revision of an operation that is no longer `proposed` `terms_changed`, or the operation returned as it is ("so a repeated confirm is safe")? The model accepts either.
- **"The request again"** (4.3): only the request that got 429, or anything sent to that Company? It decides whether an agent that keeps one limiter per task, not per Company, is conformant.
