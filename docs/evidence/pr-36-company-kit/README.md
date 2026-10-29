# PR 36: official Company kit

The [review](../../company-kit-review.md) records scope, interpretation and all 229 manual-checklist entries in 52 groups. [The pin](../../../spec/company-kit-2026-10-29/README.md) retains the original website archive and all 79 extracted files unchanged.

- `results.json`: the upstream CLI's raw results for both mock profiles, the strict Bearer control and the hosted dummy Company in local workerd. Every profile reports all 120 catalogue entries. The runner's `reviewedFindings` field describes the exact comparison; individual upstream verdicts are unchanged.
- `before-after.json`: selected upstream failures from the preceding Company source and their new passing results. Five checks exposed three defects: lost message context, query-credential error classification and MCP challenge discovery. Hosted conversation checks remain skipped because that feature is absent.
- `regressions-before.txt` and `regressions-after.txt`: the same three Worker regressions fail on `c98ebf64f8209cf651a855c714fdd4874e0f546f` and pass with the fixes. Terminal color codes and trailing blank lines are removed for reading; assertions and generators are preserved.
- `validation.json`: 2,004 repository tests passed and one existing test skipped, types/specification checks passed, and the local hosted security smoke passed. The kit caused zero Company actions; its signed-out probes do not verify an authenticated action.

Reproduce from the repository root with Node 24, OpenSSL and installed dependencies:

```sh
node scripts/check-company-kit.mjs --verify-pin
node scripts/check-company-kit.mjs --output /tmp/company-kit.json
node scripts/check-company-kit.mjs --reviewed-findings --output /tmp/company-kit-reviewed.json
```

The ordinary command exits nonzero for the two raw Mediated Sign-In findings on the DPoP-required mock profiles. The reviewed command succeeds only when those exact prerequisite failures, seven inconclusive assertion checks per DPoP profile, documented feature skips and accepted Bearer controls match the review. It does not certify DPoP-required checks that the upstream CLI cannot complete.

Transport is real local HTTPS with verified certificates/hostnames and an explicit allowlist of fixture hosts. Both Companies use their normal workerd handlers and real cryptographic verification. The identity is generated afresh by the upstream kit; only its public metadata/client ID is provisioned to match the existing dummy Company allowlist. Test keys and passwords are temporary and removed afterward. No external deployment, account sign-in, model call or payment occurs.

These are protocol and fixture changes with no UI markup change. Existing browser captures in the PR remain evidence for their original interaction runs; no new screenshot is used to stand in for the CLI results.
