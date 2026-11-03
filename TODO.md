# TODO

This is the remaining product and maintenance backlog. [Deployment tasks](docs/deployment-tasks.md) owns configuration, deployed commits and live checks; [current verification](docs/poppy-0.3-conformance.md#current-verification) owns protocol results. Completed work is in [CHANGELOG.md](CHANGELOG.md) and the [dated backlog](https://github.com/adewale/pda/blob/289c6592c6f6e629b1d525247f3c4e2243662bc2/TODO.md), rather than repeated here.

## Owner actions

- [ ] Review the [focused spec-feedback batch](docs/proposals/poppy-feedback.md). Recheck only those passages before sending; the historical audit is supporting material, not a send prerequisite.
- [ ] Review pending implementation reports in [poppy-issues.md](docs/history/poppy-issues.md) one at a time against their recorded revisions. Drop fixed or obsolete findings; the old everruns duplicate migration is already fixed. Potential vulnerabilities require private disclosure under [SECURITY.md](SECURITY.md). Nothing is posted without owner approval.
- [ ] Read the monthly dependency report. It reports audit findings and opens no automatic PRs.
- [ ] Decide whether to submit the [parked plugin proposals](docs/proposals/README.md) after the deployment checklist's live verification. Do not refresh their statistics while parked.

## Product

- [ ] **Delete my agent and data export.** The privacy policy promises deletion on request; it is currently manual. Revoke Company refresh tokens, then delete the agent's storage, including memories, photos and keys. Explain what local deletion cannot erase.
- [ ] **Skills**, the remaining personal-agent milestone in the [build plan](pda-spec.md#build-plan).
- [ ] **Web search**, once a provider and funding are chosen.
- [ ] **Email reminders**, once a sender and verified-address flow are chosen.
- [ ] **Resume a paused scheduled task** from Settings; today the User cancels it and asks again.
- [ ] **An iOS home-screen icon**: supply a PNG `apple-touch-icon`.
- [ ] **Sign-in recovery**: completing sign-in through recovery should run the saved after-sign-in step, without replaying an uncertain action.
- [ ] **Protocol log gaps**: OpenAPI and MCP protected-resource fetches, ordinary website pages, and the Direct Sign-In callback's issuer check. Keep the existing secret filtering.
- [ ] **HEIC photos**: convert where the browser supports decoding; otherwise ask for a JPEG.
- [ ] **MCP 2026-07-28**: support MCP's stateless lifecycle (per-request metadata, no `initialize` or `Mcp-Session-Id`), which 0.3's section 7 now lists beside 2025-06-18. The client speaks 2025-06-18 only; a server that offers only 2026-07-28 can't be used yet.
- [ ] **Operator signatures, live**: set `POPPY_OPERATOR_KEY` on the deployment and check one Company edge that verifies Web Bot Auth accepts its signatures (the draft revision, components and directory caching). The guides warn products differ.

## Maintenance

- [ ] A signing-key rotation and compromise runbook: publish both keys, switch signer, retire the old key after caches expire, and use a new `kid` for each new key.
- [ ] Resolve the npm install-script policy using commands actually supported by the selected npm version. The old `npm install-scripts approve|deny` note was unverified and is not an instruction to run it.

Keep Node 24 while supported and compatible with dependencies. A new LTS release alone does not create an upgrade task.

## Testing and interop

- [ ] Remaining attack coverage: two-Company mix-up (`XM`), a private-host test suffix (`XS`), and the consent-code/browser cases (`YF`, `YC`). [Attack definitions and limits](docs/adversarial-interop.md) own the details; retired Operations 1 scenarios are not current tasks.
- [ ] Evaluate an additional independent peer when it can exercise a missing current-version interface. Historical candidates (openavt, Alpine Retail and typo3) remain in the dated backlog; do not build adapters for incompatible protocols merely to expand the grid. Adversarial use of another project's code retains the consent and disclosure rules in SECURITY.md.

Protocol ambiguities live in [readings](docs/readings.md) and the [spec issue list](docs/poppy-0.3-issues.md); this backlog does not maintain a second inventory of retired standing permissions or Operations 1 proposals.
