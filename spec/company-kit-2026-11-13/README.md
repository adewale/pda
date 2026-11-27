# Official Company kit, retrieved 13 November 2026

The original [website download](https://personalagentprotocol.org/kit/implement-personal-agent-protocol.zip) is `upstream.zip`, an archive dated 13 November 2026 (14:29 in the archive's local time). Its SHA-256 is `81bb287b623e31fc80f8630d149ac415fbe5fe89df46b3d4b33c8ef4adc0c2b0`. It replaced the archive downloaded earlier that day (`78b50cf3…`, upstream `736ef95`) before either was merged. `kit/` contains all 92 extracted files, unmodified. `manifest.json` records every file's hash. The kit is Apache-2.0; its license is retained here.

This kit is for the 1.0 draft: its validator's `PROTOCOL_VERSION` is `"1.0"`. Its `validate/` and `schemas/` files are upstream `kit/company` at commit `bb98332` apart from links the site rewrites to `/docs/1.0/`; upstream's `validate/test/` isn't in the archive. Its `reference/` pages match our [13 November snapshot](../draft-1.0-retrieved-2026-11-13/README.md) apart from absolute links to the protocol site.

Against the [11 November kit](../company-kit-2026-11-11/README.md), 39 files changed and none was added:

- `schemas/poppy.schema.json` requires a `description` on each `agent.protocols` entry (spec 8.1), and allows a port in a domain (3.1).
- `schemas/message.schema.json` lets a `context` field be `null`, which clears it (8.4).
- `schemas/authorization-server-metadata.schema.json` says Companies require PS384 beside ES256 for client assertions, in a description only.
- `validate/catalog.ts` sets `PROTOCOL_VERSION` to `"1.0"`, and makes `assertion.ps384` and `session.delegation-ps384` MUSTs (4.1, 5.2). `discovery.domain-matches-host` and `metadata.protected-resources` allow a port. The validator has no check for the description, Pushed Authorization Requests, `prompt=consent` or DPoP keys at refresh.
- The reference pages, checklist, milestones and patterns for the 1.0 draft.

Verify the original archive and extracted files from the repository root:

```sh
node scripts/check-company-kit.mjs --protocol 1.0 --verify-pin
```

Run the upstream CLI against our local Companies, which serve 1.0 for this run:

```sh
node scripts/check-company-kit.mjs --protocol 1.0 --output /tmp/company-kit-1.0.json
```

Updates are manual. Download a new artifact only after a request, review its changes, and pin its archive and file hashes together. Neither this command nor CI fetches a newer kit. 1.0 is a draft, so a newer kit replaces this pin after review.
