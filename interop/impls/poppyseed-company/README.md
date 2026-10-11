# poppyseed (Company)

poppyseed's reference Company, served by its Next.js fixture app (`fixtures/next-app`), behind an [interop spec](../../../docs/interop-spec.md) 5.3 adapter.

- **Upstream:** [akshay5995/poppyseed](https://github.com/akshay5995/poppyseed), MIT licence. The Dockerfile clones it at a pinned commit; nothing is vendored here.
- **Pinned commit:** `f479fb6bd1754b9639440515f259e01936b0a18a` (11 Oct 2026).
- **Patches:** none.

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
| `POPPYSEED_BASE_URL` | `https://poppyseed.company.interop.test` | The public origin. poppyseed builds every URL and DPoP `htu` from it, never from the inner request. |
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
| `end_sessions` | `endSession(id)`. poppyseed ends one Session by id and can't list them, so this needs `params.session_id` (or `sessions: [...]`) and answers 400 without it. |
| `staff_join`, `staff_reply` | `staffJoin(id)` (then `staffReply` if `text` is given), `staffReply(id, text)`. |
| `settle_operation` | `settle(id, state, summary)`; `outcome` is `succeeded`, `failed` or `cancelled`. |
| `fixture` | Accounts `alice` and `bob`, the Direct scopes, the `echo` tool by MCP and OpenAPI, the conversation prompts, and poppyseed's whole `TargetProfile` as `poppyseed_profile`. |
| `propose_operation` | 501. Operations are proposed by the scripted Company Agent when a conversation asks for one (`fixture.conversations.operationRequest`). |

Hook bodies may be the params object or `{"params": {...}}`. Results are `{"ok": true, "result": {...}}`.

`POST /reset` restarts `next start`: everything lives in the fixture's in-memory store, so a restart forgets every Session, token, conversation and rate-limit counter (about 2 s).

Accounts are `alice` and `bob`; `acct_alice` and `alice@reference.test` are accepted too.

## Relaxations

None are patches. All are upstream settings the fixture app already has:

- `fixtures/next-app` hard-wires `dev.allowInsecureClients: true`. That accepts `http` and private-address `client_id`s, and fetches metadata with the platform `fetch` rather than poppyseed's `safeFetch`, which refuses private addresses at connect time. In the grid the proxy has a private IP, so without this setting poppyseed would refuse every agent. A production poppyseed site with `allowInsecureClients: false` couldn't join the local lane without a resolver-level exception.
- `POPPYSEED_TEST_HOOKS=1` turns on the test hooks (off by default).
- `POPPYSEED_BASE_URL` sets the public origin.

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
- `end_sessions` needs a Session id; see above.

## `poppyseed check` against any 5.3 adapter

[`check-bridge.mjs`](check-bridge.mjs) serves poppyseed's hooks protocol in front of any 5.3 Company adapter, so `poppyseed check <origin> --hooks http://127.0.0.1:8090` can use it. Run against this adapter, through the bridge: 62 passed, 0 failed, 37 skipped. 33 of the skips need `siteSignIn`, which 5.3 has no equivalent for: 5.3 approves a whole authorization, while `check` wants the site's cookie so it can drive the consent page itself. 1 needs `connections`, 2 need `performed`, and 1 is the loopback skip.

`check`'s agents publish `http://127.0.0.1:<port>` client_ids, so it only works against a Company that accepts loopback `http` agents and runs where those ports are reachable (the same container or network namespace).
