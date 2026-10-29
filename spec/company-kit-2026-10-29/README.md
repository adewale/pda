# Official Company kit, retrieved 29 October 2026

The original [website download](https://personalagentprotocol.org/kit/implement-personal-agent-protocol.zip) is `upstream.zip`. Its SHA-256 is `8b795dd6eb8dd04e6f6ccfdcf6abc63c4a522a8a4292f0ba9b759e8c6ac38e0a`. `kit/` contains all 79 extracted files, unmodified. `manifest.json` records every file's hash. The kit is Apache-2.0; its license is retained here.

This is a website artifact pin, not a Git commit. At retrieval, the website kit used Session JWTs and delegated keys while the GitHub skill still described the earlier Session Token design. The kit's specification, Operations and Mediated Sign-In references match our 28 October snapshot after making absolute links to the protocol site relative. No protocol snapshot was replaced.

Verify the original archive and extracted files from the repository root:

```sh
node scripts/check-company-kit.mjs --verify-pin
```

Run the upstream CLI against our local Companies:

```sh
node scripts/check-company-kit.mjs --output /tmp/company-kit.json
```

The command retains the upstream exit verdicts and exits nonzero for a MUST failure. The [review](../../docs/company-kit-review.md) explains one DPoP prerequisite disagreement and the accepted controls. CI adds `--reviewed-findings`: it requires exactly the documented findings/skips and passing controls, while preserving every raw upstream result. A new or disappeared finding fails that review check.

Updates are manual. Download a new artifact only after a request, review its changes, and pin its archive and file hashes together. Neither this command nor CI fetches a newer kit.
