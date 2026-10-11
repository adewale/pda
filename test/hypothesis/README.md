# A second Poppy client, and a stateful test of our mock Company

Our TypeScript client (`src/poppy/`) and our mock Company (`test/mock-company/`) were written by the same people under the same readings of the draft, so a misreading they share passes every test. This directory checks the mock from outside, with:

- **an independent Poppy client in Python** (`poppy_client.py`), written from Draft 0.1 and our spec's readings, not ported from `src/poppy`. It covers discovery, client and Session assertions, DPoP proofs with nonces and `ath`, the token grants, Account Token renewal and rotation, conversations, and sign-out;
- **a Hypothesis stateful, model-based test** (`test_mock_company.py`, a `RuleBasedStateMachine`) that drives it against the mock and holds every response to a model.

## Running it

```sh
npm run test:hypothesis                                 # default: 100 runs of up to 30 steps, about 10 s
npm run test:hypothesis -- --hypothesis-profile=deep    # 2,000 runs of up to 60 steps, a few minutes
```

It needs `uv` and Node; `uv run --frozen` installs the pinned, hash-locked dependencies from `uv.lock` into `.venv/`. It is local only: not part of `npm test`, not in CI. Everything stays on 127.0.0.1, with no Docker.

## How it reaches the mock

`launcher.ts` runs the mock in Node, bundled by `interop/impls/shared/build.mjs` like the interop adapter, under `<id>.company.interop.test`. The Python client's transport sends each `https://` request to 127.0.0.1 with the Company's host in `Host` and `X-Forwarded-Proto: https`, as the interop proxy does, so the mock checks `htu`, `aud` and the issuer against the real URLs. No check is relaxed. The Python agent's client metadata and JWKS reach the mock through its `serveClientDocument`, made for a second client, and are checked like any other client's.

The launcher's control port has the interop hooks and `GET /violations` of `interop/impls/shared/mock-hooks.ts`, the module the `dpa-mock` adapter uses too, `GET /state`, and `POST /reset` with the settings a run draws: strict or lenient assertions, the client assertion's `aud` (S1), rotation and reuse detection, nonces per Company or per origin (S23), token responses without `scope`, an issuer with a trailing slash, sign-out that ends Sessions, streaming, text deltas, keep-alives, and whether the Company Agent replies.

## The model and its rules

Honest rules: discover from every domain the Company names; add Users; start and renew Sessions; switch DPoP keys; sign in by Direct, Device or Mediated Sign-In with any subset of the offered scopes, approved in full or in part; sign in with a stored Account Token; sign out; call the OpenAPI reads; start conversations, send, retry with the same id (members in any order, any spelling), read as JSON or a stream, from the start or the saved cursor; close.

Reject rules: a replayed client assertion, Session assertion or DPoP proof; any `aud` (accepted exactly when the draft or the Company's reading of S1 says so); a stolen Session Token with another key; a rotated Account Token used again; a revoked one; an Account Token from another client; a message id reused with other content; a message to a closed conversation; an invalid cursor; another User's conversation; a read after sign-out of a conversation that used the account; an ended Session.

Invariants: `GET /violations` holds exactly the ids the reject rules expect, in order, and nothing after honest rules; the Company's Sessions are the ones the model started, ended as it says. Each response matches the model: who is signed in, to which account, with which scopes; a retry answers for the original conversation and adds nothing; reads return every event once, in order, resuming from the cursor, JSON and stream alike.

The run ends by printing how often each rule reached each outcome, so a rule that stopped firing shows.

Bounds, for cost, not to dodge failures: reads never ask for `wait`, and retries don't either, since a long poll with nothing new holds each step for up to the mock's 2 s cap; a send asks for `wait` (0 or 1) only where its own message is already there to return. JSON integers stay within ±(2^53 − 1), RFC 8259's interoperable range. Not covered: the Operations extension, MCP, browsing, handoff and Direct Conversations, rate limits, and Device Sign-In's polling (the User approves before the first poll).

## What it found

See the triage ledger in `docs/spec-issues.md` (N4, S8, S9) and the regression tests in `test/mock-company.test.ts` under "the mock Company, as the Hypothesis model found it".
