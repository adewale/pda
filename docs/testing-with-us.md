# Testing your Poppy implementation with ours

For the maintainers of a Poppy Company or Personal Agent that the [Poppy Demo Agent](../README.md) (PDA) tests against. It says what we run against your code, what we need from you, and what we never do. The full contract for the harness is [interop-spec.md](interop-spec.md); this page is the part you need. How we test against Companies in general, our mock included, is [company-testing.md](company-testing.md).

## Two ways we test

| | The local grid | The live lane |
| --- | --- | --- |
| What runs | Your code at a pinned commit, unchanged, in a Docker container on our machine | Your deployment, at its public URL |
| Network | A Docker network created with `--internal`: no container on it can reach the internet | The internet |
| Money, email, real accounts | None. We run your simulated or demo mode; nothing reaches a payment, print or email provider | None by default: signed out, no purchases |
| Who runs against you | Our agents and other projects' agents | Only our own: `pda`, and its lenient and strict test variants |
| Needs your agreement | No, for open-source code; we fetch it at build and keep none of it if it has no licence | Yes, and only for the scenarios you agree to |

The local grid can't touch your deployment or your users, so it is where almost all testing happens. The live lane checks what a deployment does that its code alone doesn't show: hosting, redirects, the allowlist it actually runs with.

## The identities to register

If your Company admits only agents it knows, register these `client_id`s. Each publishes its keys on the same origin, at the `jwks_uri` its metadata names.

| `client_id` | What it is |
| --- | --- |
| `https://poppydemoagent.dev/poppy/client.json` | The deployed agent people use. It has a redirect URI, so it can do Direct Sign-In. |
| `https://poppydemoagent.dev/poppy/interop/client.json` | Our test harness, and both test variants of our agent. No redirect URI, so no Direct Sign-In; it can open Sessions and do Mediated Sign-In. |

We may add or replace keys behind either one. You never need to register again for that: fetch the key set again, as your cache allows.

In the local grid, agents are named after the grid instead: `https://<agent>.agent.interop.test/...`, for example `https://pda.agent.interop.test/poppy/client.json`. Our adapter for your code sets your allowlist to those, through your own configuration.

## Running your Company in the local grid

What the grid gives your container:

- **Its name.** You are `https://<name>.company.interop.test`, with subdomains such as `auth.`, `api.` and `www.`. Every `*.interop.test` name resolves to a recording TLS proxy on the same network, which forwards to your container on port 8080 over plain HTTP, adding `X-Forwarded-Proto: https` and the original `Host`. Build your URLs from your configured origin.
- **Its own certificate authority**, made for that run, in `/interop/ca.pem`, with `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` pointing at it. Everything stays HTTPS.
- **Private addresses.** Docker picks the network's subnet from its default private pools, usually somewhere in 172.17.0.0/16 to 172.31.0.0/16, and it can change between runs. `.test` is a reserved top-level domain ([RFC 6761](https://www.rfc-editor.org/rfc/rfc6761)) that never resolves on the public internet.

What we need from your code:

1. **A mode with no real side effects**: simulated payments, fulfilment and email, or a demo mode.
2. **Your origin and your agent allowlist from configuration**, not from the request.
3. **A way past your private-address check, for test names only.** A Company that refuses to fetch from private addresses (as it should, against SSRF) can't fetch an agent's client metadata in the grid. What we ask for:
   - a setting that is **off by default**, such as `ALLOW_TEST_HOSTS=1`;
   - that lets private addresses through **only for hostnames ending in `.test`**, not by IP range, since the range changes;
   - and that **refuses to start** when it is set together with your production or public sandbox mode.

   Your production and public sandbox protections stay exactly as they are. Tipping Co's code has a hook for this, and our adapter uses it for `*.interop.test` names only ([its adapter](../interop/impls/tipping-co-company/README.md)).
4. **A way for a test to play the person.** Sign-in usually needs someone to read a one-time code or press Allow. In a test mode, store the code where a test can read it (Print with Poppy's demo mode keeps each code email in its database), or accept a fixed code for a test account. Our adapter does the reading; nothing in your production path changes.

We list everything we turn on in your adapter's manifest as a declared relaxation, and we don't patch your code.

## Testing signed in against your deployment

The live lane runs signed out unless you agree to more. For signed-in tests, we'd ask for:

- **A dedicated test account**, not anyone's real one, with every scope you offer and some data to read.
- **A way to reset it** between runs, if an agent can change anything in it.
- **A sign-in code we can get without a person**: a fixed code for a test phone number or email, or a test-only endpoint that returns it (Print with Poppy's sandbox has one).
- **Which scenarios you agree to.** We record them in our registry (`liveScenarios`), and the runner refuses any other before sending a request.

Send passwords and fixed codes to the person who asked, directly, never in a shared thread. They live in an untracked local file, like our test identity's private key; nothing goes in the repository.

## What we never do

- Buy anything, or send a request that costs anyone money.
- Run our deliberately broken agents against your deployment. The sloppy variant (wrong `aud`, assertions without `typ`) and the adversarial one run only in the local grid, and the adversarial one only against our own code ([SECURITY.md](../SECURITY.md)).
- Send more than one request a second to a live Company.
- Publish a finding that may be a vulnerability in your code before you've had it privately. Those go to you first, through your security policy, with a 90-day window ([SECURITY.md](../SECURITY.md)). Nothing is posted to your project without our owner's approval.

## If you build a Personal Agent

The same grid runs your agent against our mock Companies: `lenient-company` (the reference), `strict-company`, `lenient-company-v02` (draft 0.2), and `evil-company`, which tries to make agents leak tokens or act without approval. `evil-company` runs only in our containers, against your agent at its pinned commit, and what it finds goes to you privately first. Your agent publishes its client metadata at `https://<name>.agent.interop.test`, trusts the run's certificate authority, and needs the same narrow exception for `.test` names if it refuses private addresses. How to add an adapter is in [interop/README.md](../interop/README.md#add-an-implementation).

## Talking to us

Open an issue on [adewale/pda](https://github.com/adewale/pda), or use **Security → Report a vulnerability** there for anything sensitive.
