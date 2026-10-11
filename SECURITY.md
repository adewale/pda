# Security policy

This covers the Durable Personal Agent: the Worker, its sign-in, the Poppy client in `src/poppy/`, the validator, the mock Company and the interop harness. It also sets out how we disclose what our interop and adversarial testing finds in other people's implementations.

## Reporting a vulnerability in this project

Report it privately, as a GitHub security advisory on [adewale/dpa](https://github.com/adewale/dpa). Please don't open an issue, pull request or discussion about it.

- **While the repository is private** (it is now), only collaborators can see it: go to **Security → Advisories → New draft security advisory**. A draft advisory is visible only to the repository's administrators and the people you add to it.
- **Once it's public**, the owner turns on private vulnerability reporting (**Settings → Code security**), and anyone can use **Security → Report a vulnerability**, which opens the same kind of private draft.

If you can't do either, open an issue that asks for a private channel and says nothing about the problem.

Useful in a report:

- what an attacker can do, and what they need first (a signed-in session, a malicious Company, a position on the network);
- the route, file or protocol step involved;
- steps or a test that shows it. The strict mock Company in `test/mock-company/` and the fakes in `test/fake-providers.ts` usually make a failing test the shortest proof.

We'll acknowledge a report, agree a timeline with you, fix it in the advisory's private fork, and credit you in the advisory unless you'd rather not be named.

**In scope:** sign-in and sessions, the allowlist, anything that lets the model approve an action or see a token, key or password, our Poppy client's handling of a malicious Company, the validator, and the harness's handling of what it records. **Out of scope:** the Poppy draft itself (send that to its authors; see below) and the projects we test against (see below).

## Disclosing what interop testing finds in other projects

The [interop harness](interop/README.md) runs our agent and mock Company against other projects' implementations, and [adversarial cells](docs/adversarial-interop.md) run deliberately misbehaving peers. A failure there can be a vulnerability in someone else's code. Our process:

1. **Their maintainers hear first, privately**, through that project's own security policy (its `SECURITY.md`, GitHub private vulnerability reporting, or the contact it names). If it has none, we ask for a private channel without describing the problem.
2. **Nothing is committed or published** until they've had a reasonable window: 90 days from our report, or until a fix is released, whichever comes first. That includes results files, known-failure reasons, vectors, docs and commit messages. We'll agree to a longer window when they're working on a fix.
3. **Afterwards, a known failure may link the advisory** (or our spec issue) in its `interop/known-failures.json` reason.
4. **Attacks the spec permits go to the spec's authors** as spec issues. When a conforming implementation is open to an attack because the draft allows it, the fix is in the draft: we write it up in [`docs/spec-issues.md`](docs/spec-issues.md) and send it to the Poppy authors, and tell any affected implementer privately first if it's exploitable today.
5. **Adversarial cells run only against our own implementations** (`dpa`, `dpa-mock`, `dpa-mock-strict`). The runner enforces this, on the local lane only, and no flag or setting lifts it ([interop-spec §13](docs/interop-spec.md#13-the-own-project-rule)). Running one against another project would take a reviewed code change to the runner, made only with the owner's approval and with this process followed for that project.
6. **Nothing is posted to another project** (an issue, pull request, comment, advisory or email) without the repository owner's approval. That applies to people and to coding agents working in this repository.

The ordinary interop grid isn't a security test, but the same rules apply when one of its failures turns out to be a vulnerability.
