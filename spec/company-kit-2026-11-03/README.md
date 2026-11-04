# Official Company kit, retrieved 3 November 2026

The original [website download](https://personalagentprotocol.org/kit/implement-personal-agent-protocol.zip) is `upstream.zip`. Its SHA-256 is `bae0595a317a32460733669d454dc6a22e4694aa7ffb16b3ed7020b355710e22`. `kit/` contains all 87 extracted files, unmodified. `manifest.json` records every file's hash. The kit is Apache-2.0; its license is retained here.

This is a website artifact pin. Apart from absolute links to the protocol site (`/docs/` in the download, `/docs/0.3/` in the repository) and the repository's `validate/test` directory, it matches `kit/company` at upstream commit [`7205250`](https://github.com/personal-agent-protocol/personal-agent-protocol/tree/7205250c6fb7d4a181707898fa418911ccbcb163/kit/company). That is the commit whose specification text our [3 November snapshot](../draft-0.3-retrieved-2026-11-03/README.md) pins. It includes 850a46d's issuerless discovery and the `poppy_dlg` delegation header. The [29 October kit](../company-kit-2026-10-29/README.md) stays as a record.

Verify the original archive and extracted files from the repository root:

```sh
node scripts/check-company-kit.mjs --verify-pin
```

Run the upstream CLI against our local Companies:

```sh
node scripts/check-company-kit.mjs --output /tmp/company-kit.json
```

It runs five profiles: the lenient and strict mock, a strict Bearer mock, the hosted dummy Company, and the mock with no OAuth issuer (3.2), so upstream's validator also judges a signed-out Company whose protected resource metadata is a 404. The command retains the upstream exit verdicts and exits nonzero for a MUST failure. The [review](../../docs/company-kit-review.md) explains the reviewed findings and the accepted controls. CI adds `--reviewed-findings`: it requires exactly the documented findings/skips and passing controls, while preserving every raw upstream result. A new or disappeared finding fails that review check.

Updates are manual. Download a new artifact only after a request, review its changes, and pin its archive and file hashes together. Neither this command nor CI fetches a newer kit.
