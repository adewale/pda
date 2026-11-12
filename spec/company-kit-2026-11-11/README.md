# Official Company kit, retrieved 11 November 2026

The original [website download](https://personalagentprotocol.org/kit/implement-personal-agent-protocol.zip) is `upstream.zip`, an archive dated 11 November 2026 at 04:01 UTC. Its SHA-256 is `88f718418b8cd11365b1a2b83dd463969d7cb46d330fe131c22411d7e7fb125f`. `kit/` contains all 92 extracted files, unmodified. `manifest.json` records every file's hash. The kit is Apache-2.0; its license is retained here.

This kit is for 0.4 as published, the 1.0 release candidate: its validator's `PROTOCOL_VERSION` is `"0.4"`. Its files are upstream `kit/company` at commit `ed47408` apart from links the site rewrites to `/docs/0.4/`; upstream's `validate/test/` isn't in the archive. Its `reference/` pages match our [11 November snapshot](../draft-0.4-retrieved-2026-11-11/README.md) apart from absolute links to the protocol site.

Against the [10 November kit](../company-kit-2026-11-10/README.md), 20 files changed and one was added:

- `schemas/approval-declined.schema.json`, Operations' decline of an approval, and `operations-content.schema.json`, which now allows `declined` in a Company message.
- `validate/checks/discovery.ts` counts `scopes_supported` in the domain's protected resource metadata as well as the issuer's, for the scope checks and `poppy:browser-sign-in`; `catalog.ts` and `types.ts` follow, and the catalogue maps spec 10.8.
- The reference pages, checklist, milestones and patterns for the 11 November text: declining an approval, sign-ins someone else started, the browser-session endpoint on another host, consent-page headings and passkeys, and scopes a Company doesn't grant.

The check count is unchanged, and against the mock this kit gives the same results as the 10 November one.

Verify the original archive and extracted files from the repository root:

```sh
node scripts/check-company-kit.mjs --protocol 0.4 --verify-pin
```

Run the upstream CLI against our local Companies:

```sh
node scripts/check-company-kit.mjs --protocol 0.4 --output /tmp/company-kit-0.4.json
```

The [0.4 upgrade](../../docs/poppy-0.4-upgrade.md) uses this kit's results to track the mock Company's progress, milestone by milestone, and its JSON Schemas as an independent check on what our agent sends.

Updates are manual. Download a new artifact only after a request, review its changes, and pin its archive and file hashes together. Neither this command nor CI fetches a newer kit. 0.4 is now published and frozen; a draft 1.0 would get its own pin.
