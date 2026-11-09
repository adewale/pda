# Official Company kit, retrieved 9 November 2026

The original [website download](https://personalagentprotocol.org/kit/implement-personal-agent-protocol.zip) is `upstream.zip`, an archive dated 8 November 2026. Its SHA-256 is `975c9ab4a44a01f62841dafff421be665ec73c01f5f5f384a8285d6d0b3d91fc`. `kit/` contains all 90 extracted files, unmodified. `manifest.json` records every file's hash. The kit is Apache-2.0; its license is retained here.

This kit is for the 0.4 draft: its validator's `PROTOCOL_VERSION` is `"0.4"`, and its `reference/` pages match our [9 November snapshot](../draft-0.4-retrieved-2026-11-09/README.md) apart from absolute links to the protocol site. Its catalogue has 132 checks. Against the [3 November kit](../company-kit-2026-11-03/README.md) for 0.3, which stays pinned for the 0.3 profile, it adds 19: linked version documents, `Poppy-Version`, `web.disabled` and `web.unscoped`, request IDs on every conversation request, `working` and handoff cancel, and the tasks endpoint. It drops 8: message IDs, the excluded-tasks document, and the Session checks 0.4 replaces with lookup by User ID.

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
