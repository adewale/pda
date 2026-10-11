# poppyseed (Company)

poppyseed's reference Company, served by its Next.js fixture app (`fixtures/next-app`), behind an [interop spec](../../../docs/interop-spec.md) 5.3 adapter.

- **Upstream:** [akshay5995/poppyseed](https://github.com/akshay5995/poppyseed), MIT licence. The Dockerfile clones it at a pinned commit; nothing is vendored here.
- **Pinned commit:** `f479fb6bd1754b9639440515f259e01936b0a18a` (11 Oct 2026).
- **Patches:** one, [`patches/0001-interop-hooks.patch`](patches/0001-interop-hooks.patch), applied in the image. It adds two test hooks to the fixture app, on only with `POPPYSEED_TEST_HOOKS=1` and `POPPYSEED_INTEROP_HOOKS=1`: `interopEndAllSessions`, which ends every Session the memory store has held, and `interopConversation`, which reads a conversation through poppyseed's own staff inbox (`conversations.get`).

## Run

```sh
docker build -t poppyseed-company interop/impls/poppyseed-company
docker run -e INTEROP_SECRET=... [-v ca.pem:/interop/ca.pem] poppyseed-company
```

| Port | What |
| --- | --- |
| 8080 | The Company over plain HTTP, for the proxy (`poppyseed.company.interop.test`). |
| 8081 | The adapter's control API. |

| Variable | Default | Meaning |
| --- | --- | --- |
| `INTEROP_SECRET` | none | Bearer secret for every control request except `/manifest` and `/healthz`. Without it they all answer 401. |
| `INTEROP_ORIGIN` | `https://poppyseed.company.interop.test` | The public origin, set by the runner; passed to the app as `POPPYSEED_BASE_URL`. poppyseed builds every URL and DPoP `htu` from it, never from the inner request. |
| `INTEROP_COMMIT` | the pinned commit | Reported in the manifest. |
| `POPPYSEED_SECRET` | a fixed interop-only value | Seals tokens. |

If `/interop/ca.pem` exists, the entrypoint adds it to the system trust store and sets `NODE_EXTRA_CA_CERTS`, so the Company can fetch client metadata through the proxy.

## Hooks

Each hook maps to poppyseed's own test hooks (`POST /test-hooks/{hook}` with `{"args": [...]}`, on only with `POPPYSEED_TEST_HOOKS=1`) or to its own consent pages, driven over HTTP as a browser would. The adapter signs the person in with poppyseed's `siteSignIn` hook, which returns the site's own sign-in cookie, then approves or declines on the real consent page. There is no other way in.

| 5.3 hook | How |
| --- | --- |
| `approve_authorization`, `deny_authorization` | `siteSignIn(account)`, then GET the authorization URL and POST the consent form with `decision=approve` or `decline`. Returns the `Location` the Company redirects to. `scopes` narrows what is ticked. |
| `approve_device`, `deny_device` | `siteSignIn`, then the device page: enter `user_code`, then approve or decline. |
| `mediated_answers` | The profile's credentials: alice signs in directly; bob always needs a one-time code. |
| `last_one_time_code` | `lastCode()`. |
| `end_sessions` | With no params (as in the spec), the patched `interopEndAllSessions`: every Session the store has held. With `session_id`, poppyseed's own `endSession(id)`. |
| `staff_join`, `staff_reply` | `staffJoin(id)` (then `staffReply` if `text` is given), `staffReply(id, text)`. |
| `settle_operation` | `settle(id, state, summary)`; `outcome` is `succeeded`, `failed` or `cancelled`. |
| `fixture` | Accounts `alice` and `bob`; the Direct scopes; `openapi` `private_echo` (`poppy:read`), `openapi_public` `echo`, `openapi_write` `write_note` (`poppy:write`), each `POST /poppy/tools/{name}` with the input as `args.body`; `mcp` `echo`; `prompts` `hello`, `sign_in` ("What are my notes?": the Company Agent calls `private_echo`, so signed out it answers `sign_in_required`) and `operation` (the Company Agent proposes `exchange_item`); `otp_account` `bob`; poppyseed's whole `TargetProfile` as `poppyseed_profile`. |
| `propose_operation` | The scripted Company Agent proposes when asked (`prompts.operation`); this reads the conversation with the patched `interopConversation` and returns the operation on its latest message. The agent must list the operations extension, or poppyseed leaves the operation off the message. |
| `require_nonce`, `rate_limit`, `expire_tokens` | 501. poppyseed has no DPoP nonces, its rate limits are fixed windows set at startup, and tokens are sealed with their expiry. |

Hook bodies are the bare params object and results the bare result object (spec 5.3), as the runner reads them.

`POST /reset` restarts `next start`: everything lives in the fixture's in-memory store, so a restart forgets every Session, token, conversation and rate-limit counter (about 2 s).

Accounts are `alice` and `bob`; `acct_alice` and `alice@reference.test` are accepted too.

## Relaxations

Upstream settings the fixture app already has, and one patch:

- `fixtures/next-app` hard-wires `dev.allowInsecureClients: true`. That accepts `http` and private-address `client_id`s, and fetches metadata with the platform `fetch` rather than poppyseed's `safeFetch`, which refuses private addresses at connect time. In the grid the proxy has a private IP, so without this setting poppyseed would refuse every agent. A production poppyseed site with `allowInsecureClients: false` couldn't join the local lane without a resolver-level exception.
- `POPPYSEED_TEST_HOOKS=1` turns on the test hooks (off by default).
- `POPPYSEED_BASE_URL` (from `INTEROP_ORIGIN`) sets the public origin.
- The patch's two test hooks, behind `POPPYSEED_INTEROP_HOOKS=1` (off by default).

## What works

Checked by hand on a private network with a stand-in TLS proxy and a per-run CA, over HTTPS:

- `/manifest`, `/healthz`, `/hooks`, `fixture`, 501 for `propose_operation`, 401 without the secret, `/reset`.
- Discovery and OAuth metadata through the proxy name the interop origin.
- poppyseed's own `TestAgent`, with every human step done by this adapter's hooks: Direct Sign-In approved (callback has `code`, the `state` and `iss`) and declined (`error=access_denied` with `iss`), Device Sign-In approved, Mediated Sign-In for bob with the one-time code from `last_one_time_code`, a staff join and reply in a conversation, and `end_sessions` (renewing the ended Session then gives `invalid_session`).
- The same `TestAgent` published at `https://seed-agent.agent.interop.test` through the proxy: discovery, signed-out Session, a conversation, and a retried message id returning the same conversation.
- `poppyseed check` from inside the container, against `https://poppyseed.company.interop.test`, with poppyseed's own hooks: 98 checks passed, 0 failed, 1 skipped (`identity/private-agent-urls`, because loopback agents are allowed).

## What doesn't

- No DPoP nonce challenges, so scenario `N` isn't claimed.
- `wait` is honoured on `GET …/events` only. A `POST` with `?wait=25` answers at once with `status: working`, and the reply arrives in a later read.

## `poppyseed check` against any 5.3 adapter

[`check-bridge.mjs`](check-bridge.mjs) serves poppyseed's hooks protocol in front of any 5.3 Company adapter, so `poppyseed check <origin> --hooks http://127.0.0.1:8090` can use it. Run against this adapter, through the bridge: 62 passed, 0 failed, 37 skipped. 33 of the skips need `siteSignIn`, which 5.3 has no equivalent for: 5.3 approves a whole authorization, while `check` wants the site's cookie so it can drive the consent page itself. 1 needs `connections`, 2 need `performed`, and 1 is the loopback skip.

`check`'s agents publish `http://127.0.0.1:<port>` client_ids, so it only works against a Company that accepts loopback `http` agents and runs where those ports are reachable (the same container or network namespace).

## The full grid (runner, run 2026-10-11T16:46:10Z)

| Agent | Pass | Fail |
| --- | --- | --- |
| dpa | D S0 SD SV SM SMC SX SXV C CI CS SO SE AO AM AS O OX | CA |
| poppy-demo | D S0 SD SX C | CA, SO |
| adonis-agora | D S0 SD SM SMC SX C CI CS CA SE AO AM AS | SV, SXV, SO |

- **CA (dpa, poppy-demo).** poppyseed honours `wait` only on `GET …/events`. The signed-in `POST …/messages?wait=2` answers at once with `status: working`, so the send result has no Company reply. Poppy 7.3 makes `wait` a hint, so this is the scenario's assumption, not a poppyseed bug. CA should `read` with `wait` after the send, as C does.
- **SO (poppy-demo).** poppyseed answers revocation with 200 and an empty body (RFC 7009 allows it), and poppy-demo's caller throws parsing it. That's the agent's bug.
- **SV, SXV, SO (adonis-agora).** At the device authorization and revocation endpoints, the adonis agent's client assertion has the token endpoint as `aud`. poppyseed requires the URL of the endpoint the assertion is sent to, and answers `invalid_client` "assertion signature or claims are invalid". Both declare S1 `token-endpoint`, because S1's values can't express "always the token endpoint" as opposed to "the endpoint it's sent to". That's a spec gap.
