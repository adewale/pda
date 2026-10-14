# tipping-co (Personal Agent)

The Personal Agent in [timothyohare/personal-agent-protocol](https://github.com/timothyohare/personal-agent-protocol): `packages/agent`'s `CompanyClient`, driven directly (no model, no CLI), with `packages/agent-host` serving its identity. It runs behind the [interop spec](../../../docs/interop-spec.md) 5.2 adapter.

- **Pinned commit:** `fb7b4e64ad343d9406055a995f4beb06269c1ce6` (12 October 2026, still upstream's head on 13 October), cloned in the image build.
- **Licence:** none declared. Nothing upstream is kept in this repository: the build clones the commit, and the image is built and run only on the grid's machine.
- **Ports:** 8080 is upstream's `createAgentHost` app at `INTEROP_ORIGIN` (`tipping-co.agent.interop.test`): `/agent.json` (the `client_id`), `/jwks.json` and `/oauth/callback`. 8081 is the control API.
- **How it runs:** [`adapter.mjs`](adapter.mjs) is copied into the upstream checkout so the workspace's packages resolve, and Node 24 runs their TypeScript directly. It imports `packages/agent/src/company.ts`, `identity.ts` and `vault.ts` by path rather than the package's index, which would also load the LangChain chat loop the grid never uses. Nothing upstream is patched.

## Ops

- `discover`, `session` (`ensureSession`), `signin` (Direct only: `beginSignIn`; an Account Token that already covers the scopes signs the Session in with `refreshIntoSession`), `signin_continue` (`completeSignIn` with the callback URL), `api`, `signout` (`signOut`), `state`.
- `api`: the agent has no OpenAPI reader of its own (its model picks a method and path for the `poppy_call` tool), so the adapter reads the description the discovery document lists and turns the step's `operationId` or `"METHOD /path"` into the method and path a model would choose, path parameters filled and the rest as the query. `CompanyClient.call` then sends it to the description's origin with the Session Token and a DPoP proof, retrying once on `use_dpop_nonce`, 429 and `invalid_token`. A description whose server is on another origin is unsupported: `call` always uses the description's origin.
- Every key, the vault and each Company client are new on `/reset`; the key's `kid` is new each time.

Not offered: conversations, device and Mediated Sign-In, MCP, browser joins, Operations, uploads.

**Manifest:** scenarios `D DP S0 N CM SD SX SO R AO AS RL`. Readings: S1 `token-endpoint` (`clientAssertion`'s `aud` is the token endpoint everywhere, at revocation too), S2 `any` (ES256 with a `kid`, 60 s, no `typ`), S3 `insertion` (`metadataUrl`), S4 `omit`, S23 `per-origin` (nonces kept per origin).

## Relaxations

The run CA is trusted through `NODE_EXTRA_CA_CERTS`. The agent itself checks only that each URL is HTTPS, so `*.interop.test` names need nothing else.

## Results

First run, 13 October ([interop-testing.md](../../../docs/interop-testing.md#tipping-co-joins-the-grid)): all twelve Companies over the twelve scenarios above, 144 cells, 18 pass, 81 fail, 45 unsupported, every failure a known one.

- At its own Company it passes D, S0, N, CM, SD, SX, SO, AO and AS; R (no rotation), DP and RL are unsupported there.
- It passes D at nine other Companies. Everywhere else its first Session fails with `invalid_client`: it sends no `client_id` at the token endpoint, only the client assertion (`packages/agent/src/company.ts`, `tokenRequest`). RFC 7521 4.2 makes `client_id` optional beside a client assertion and the draft never requires it, but every token request in the draft's examples carries one, and every other Company in the grid requires it, our mocks included (`client_id is required`). The adapter sends what the agent sends.
- At Ilmer and everruns it stops at discovery: it requires `authorization_endpoint` in the OAuth metadata (`discover.ts`), which a signed-out Company needn't publish (RFC 8414 2).
- At pda-mock-strict and Northstar the grid blames the spec instead (reading [S2](../../../docs/spec-issues.md#s2): the strict Companies require `typ`, which it doesn't send), though the refusal there is the same `invalid_client`.
