# How we test against Companies

A Personal Agent can only be tested against a Company, and the tests need one they can sign in to, buy from and break without anyone being harmed. So we built one: the mock Company in [`test/mock-company/`](../test/mock-company). It is written from the draft, records every departure from it by name, and refuses what the draft tells a Company to refuse. Most of what this page describes exists to keep that mock honest, because a test is only as good as the Company it runs against.

This page explains the approach. The interop harness's contract is [interop-spec.md](interop-spec.md), how checks become failures or warnings is [conformance-levels.md](conformance-levels.md), and the page for other projects' maintainers is [testing-with-us.md](testing-with-us.md).

## The mock Company

The mock is one implementation of the Company side: discovery documents, OAuth metadata, the token endpoint, Direct, Device and Mediated Sign-In, conversations, OpenAPI and MCP APIs, a website with browser Sessions, and the Operations extension. In the Workers tests it runs as a Durable Object. The interop harness and the Hypothesis suite bundle the same code for Node.

Every check it makes records exactly one id from [`test/mock-company/violations.ts`](../test/mock-company/violations.ts), as `[id] detail`. Each id's description starts with its basis: `MUST`, `RFC` or `Rule` for a requirement, `SHOULD` or `Guides` for a recommendation, and `Reading` for our answer to an open question. The basis decides the level everywhere. A requirement broken is a failure, and anything else is a warning.

What the mock records is its verdict. Whether it also refuses the request is its behaviour, and the two are separate. It refuses where the draft gives it an error to send, and where a recommendation guards against replay, forgery or a repeated write.

## Keeping the mock honest

Four checks stand between a bug in the mock and a test that passes for the wrong reason.

1. **Tamper rows.** `TAMPERS` in [`test/mock-company.test.ts`](../test/mock-company.test.ts) drives the mock with hand-made requests, never our client. Each row breaks one thing in an otherwise correct request and expects exactly one violation id. A check that stops firing fails a named row.
2. **The catalogue test.** The same file checks that every id in `violations.ts` appears in the mock's source and has a tamper row. An id nobody tests can't be added quietly.
3. **A second client.** Our client and our mock were written by the same people, so a misreading they share passes every test. [`test/hypothesis/`](../test/hypothesis) holds an independent Poppy client in Python, written from the draft rather than ported from `src/poppy`, and five stateful, model-based Hypothesis tests that drive it against the mock. It runs locally, after a change to the draft or a large change to the mock, and not in CI.
4. **The maintainers' validator.** The official Company validator, from the draft's own Company implementation kit, acts as a test Personal Agent against our 0.2 mock: pinned in [`spec/`](../spec/upstream.json), unmodified, in Docker with no route to the internet (`npm run interop:official`). CI's Interop workflow runs it whenever the mock, the harness or `spec/` changes. Our mock passes its 69 available checks and fails none; the five it skips need a Company that requires DPoP nonces or serves MCP with Bearer tokens, and two honest settings of the mock reach them. It doesn't automate sign-in or Operations ([its lanes](../interop/vectors/official/README.md)).

A new check therefore lands with three things: the check in the mock, its id with a basis in `violations.ts`, and a tamper row. The catalogue test fails until all three are there.

## Holding our client to the mock

Every Poppy test in the Workers suite runs against the mock, and the `afterEach` in [`test/agent-helpers.ts`](../test/agent-helpers.ts) fails the test if the mock recorded any violation or any warning. Our own client is held to the recommendations and our readings too, as h2spec's `--strict` holds a server. A test that breaks the protocol on purpose declares what it expects with `expectViolations`.

That strictness is for our own code only. In the interop grid a warning never fails a cell.

## One mock, four profiles

The interop grid runs the mock under four names, all built from one image in [`interop/impls/pda-mock`](../interop/impls/pda-mock) and told apart by environment variables in [`interop/registry.json`](../interop/registry.json).

| Name | What changes | What it is for |
| --- | --- | --- |
| `lenient-company` | Nothing: assertions need no `typ` or `kid` and may live 300 seconds | The reference Company. Attribution compares other cells against it |
| `strict-company` | `INTEROP_MOCK_PROFILE=strict`: `typ: "JWT"`, a published `kid` and 60-second assertions | The strictest reading live Companies take, so an agent learns where it would be refused |
| `lenient-company-v02` | `INTEROP_POPPY_VERSION=0.2` | The lenient mock speaking draft 0.2 |
| `evil-company` | `INTEROP_ADVERSARY=company`, then one attack armed per cell | Checking that an agent refuses a Company that misbehaves on purpose |

Two more settings exist for one lane only and never appear in the registry. `INTEROP_MOCK_VARIANT` turns on honest options the profiles leave off (required DPoP nonces, Bearer MCP at 0.2), and `INTEROP_MOCK_FLAWS` turns one of the Company's own protections off (below).

Because the code is the same, a difference between two profiles' results comes from the profile and nothing else. Every profile reports every check it recorded at `GET /violations` with its basis and level, and the runner turns failures into errors and everything else into warnings.

## Other projects' Companies

The local grid runs other projects' Companies at pinned commits, unchanged, in Docker containers on a network with no route to the internet. Each runs in its own demo or simulated mode, so nothing reaches a payment, print or email provider. Whatever an adapter turns on to make that work is declared in its manifest as a relaxation, and we don't patch the code.

The grid judges a Company two ways:

- **From the recording.** A proxy records every exchange, and the runner's Company-side checks, prefixed `company.` in [`interop/runner/checks.ts`](../interop/runner/checks.ts), read it: `WWW-Authenticate` on a 401, `Retry-After` on a 429, OAuth error bodies, `iss` on authorization responses, the shape of event reads and more. The validator reads the Company's documents.
- **From a strict agent.** `strict-personal-agent` runs those same checks and the validator over everything it receives, refuses at the first finding of any level, and reports what it found at `GET /violations`.
- **From the maintainers' validator.** `npm run interop:official` runs the official Company validator against the grid's 0.2 Companies, Datalayer's two SDK Companies as well as our mock, outside the M×N grid.

A failure that belongs to upstream or to the draft goes in [`interop/known-failures.json`](../interop/known-failures.json) with a reason. It doesn't fail the run, but an entry that stops matching any failure does.

The live lane runs against a few public deployments at their own URLs, signed out unless the owner agrees to more, one request a second, and only the scenarios listed for that Company in the registry.

## The evil Company

The honest grid assumes both sides are trying. To check refusals, `evil-company` misbehaves on purpose. It is the lenient mock with one attack switched on per cell, so the attack is the only thing that differs from a correct Company. The adapter's `arm` hook switches the attack on, and the options it sets are grouped under "Interop adversarial options" in [`test/mock-company/types.ts`](../test/mock-company/types.ts), each off by default.

A cell against it ends with checks on the recording: one that proves the attack actually happened, and harm checks such as a token never reaching a host it shouldn't. A cell whose attack never happened is a harness error, not a pass. When the agent fails to refuse, attribution blames the agent, or the draft when the scenario names a draft gap that permits the attack.

Its cells run only in the local grid, never live, and appear in a separate security grid that never counts toward the interop pass rates. The evil Company may attack other projects' agents, with the owner's approval since 13 October 2026. What those cells find stays in the gitignored results until that project's maintainers have heard privately ([`SECURITY.md`](../SECURITY.md)).

The attacks, what each expects of an agent, and which are not built yet are in [adversarial-interop.md](adversarial-interop.md), Part B. Who may be attacked is [interop-spec.md](interop-spec.md) §13. The committed results are in the security grid of [interop-results/README.md](interop-results/README.md#security-grid).

## Checking our checks

Tamper rows prove the mock notices an agent's mistakes. Nothing proved that our checks notice a Company's, until the flawed-Company lane (`npm run interop:flaws`). It gives our 0.2 mock one known flaw at a time, from `COMPANY_FLAWS` in [`test/mock-company/types.ts`](../test/mock-company/types.ts): it accepts a replayed assertion or DPoP proof, a proof from another key or for another URL, a token in the query string, a token-endpoint audience at 0.2, or a rotated Account Token; it drops `Cache-Control: no-store`; or it starts a second conversation for a retried message. The official validator, our adversarial agent's attacks and the strict agent each check the flawed mock. A test in `test/mock-company.test.ts` proves each flaw changes what the mock does, and the honest mock must pass every one of those checks first, so a catch means something.

On 24 October the official validator caught nine of the ten flaws and our checks six. Ours missed four the validator caught: the 0.2 audience and `no-store`, which they claim to check, and a proof for another URL and a token in the query, which nothing of ours probes. Only ours caught the rotated Account Token. The same lane found that our adversarial agent had never reached a 0.2 Company, since fixed. [Results](../interop/vectors/official/README.md#the-flawed-company-lane-npm-run-interopflaws).

## What this approach can't show

- **A misreading the draft allows.** Where the draft is ambiguous, the mock takes a reading, recorded in [readings.md](readings.md). A Company that reads it the other way isn't wrong, and the grid attributes such a failure to the draft.
- **Behaviour no scenario exercises.** A cell covers only what both sides list in their manifests. A Company's untested paths stay untested.
- **A requirement nothing of ours checks.** [`spec/official-checks-0.2.json`](../spec/official-checks-0.2.json) maps each of the official validator's 74 checks to ours: 25 have nothing behind them, mostly a Company's refusals of malformed conversation requests and of DPoP misuse no agent of ours attempts.
- **What a deployment does.** The local grid runs code. Hosting, redirects and a live allowlist show up only in the live lane, which mostly runs signed out.
- **A real model.** The harness drives protocol code with no model, so whether a model obeys text a Company sends is tested separately, in [`test/prompt-injection.test.ts`](../test/prompt-injection.test.ts), with a fake model that obeys everything.
