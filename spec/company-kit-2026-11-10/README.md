# Official Company kit, retrieved 10 November 2026

The original [website download](https://personalagentprotocol.org/kit/implement-personal-agent-protocol.zip) is `upstream.zip`, an archive dated 9 November 2026 at 21:25 UTC. Its SHA-256 is `8bf370e09bc1e13440f3099877f4736eb188c01aa4ed19f2d1af5c5f6c10b0b8`. `kit/` contains all 91 extracted files, unmodified. `manifest.json` records every file's hash. The kit is Apache-2.0; its license is retained here.

This kit is for the 0.4 draft: its validator's `PROTOCOL_VERSION` is `"0.4"`. Its files are upstream `kit/company` at commit `a2f16ec` apart from links the site rewrites to `/docs/0.4/`; upstream's `validate/test/` isn't in the archive. Its `reference/` pages match our [10 November snapshot](../draft-0.4-retrieved-2026-11-10/README.md) apart from absolute links to the protocol site.

Against the [9 November kit](../company-kit-2026-11-09/README.md), 18 files changed and one was added:

- `reference/browser-control.md`, the new Browser Control extension, and its sections in the catalogue's anchor map.
- Operations version 3: `approval.schema.json` requires `approver` (`user` or `agent`), forbids `input_type` with `agent`, and adds an optional `reference`; `operation.schema.json` requires `terms` in place of `summary`.
- The Session header on website pages fetched without a browser, in `reference/spec.md`, `reference/guides.md` and `patterns/session-header.md`.
- The catalogue's `operations.not-returned` becomes `extensions.not-returned`, checked for every extension, so the count stays at 132 checks. `discovery.ts` lists `browser-control` among known extensions; `conversations.ts` and `run.ts` follow.

Verify the original archive and extracted files from the repository root:

```sh
node scripts/check-company-kit.mjs --protocol 0.4 --verify-pin
```

Run the upstream CLI against our local Companies:

```sh
node scripts/check-company-kit.mjs --protocol 0.4 --output /tmp/company-kit-0.4.json
```

The [0.4 upgrade](../../docs/poppy-0.4-upgrade.md) uses this kit's results to track the mock Company's progress, milestone by milestone, and its JSON Schemas as an independent check on what our agent sends.

Updates are manual. Download a new artifact only after a request, review its changes, and pin its archive and file hashes together. Neither this command nor CI fetches a newer kit. A newer 0.4 kit gets its own dated directory, as a newer 0.4 site snapshot does.
