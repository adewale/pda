# Draft upstream report: token probes omit advertised DPoP prerequisite

Prepared for review only; nothing has been posted upstream.

The Company kit retrieved on 29 October 2026 sends its assertion probes and unknown Mediated Sign-In ID probe without DPoP. On an issuer advertising `dpop_signing_alg_values_supported`, the missing required proof is refused before the intended assertion/grant check. Seven assertion checks become inconclusive and the unknown-ID check fails on both mock profiles. This reproduces with the pinned archive; upstream `kit/company/validate/checks/assertion.ts` at `3e9bada9ec8f66777b43e429d49574131dc2f67e` has the same omission.

Reproduce in this repository with Node 24, OpenSSL and installed dependencies:

```sh
node scripts/check-company-kit.mjs --reviewed-findings --output /tmp/company-kit.json
node scripts/check-company-kit.mjs --with-dpop --reviewed-findings --output /tmp/company-kit-dpop.json
```

The first command preserves the unmodified upstream CLI and its raw verdicts. Both DPoP mocks report 111 pass, 1 fail, 7 inconclusive, 1 skip. A strict Bearer control passes all eight affected checks and reports 119 pass, 1 skip.

The second command verifies all 79 original files and the archive, copies them, then applies [the token-probe patch](../../../test/company-kit/dpop-probes.patch) only in the temporary copy. Both DPoP mocks report 119 pass, 1 skip. Expected verdicts and Company validation are unchanged. The hosted handlers change from 55 pass/7 inconclusive to 62 pass, retaining all 58 absent-feature skips.

The patch uses the kit's own signer with a separate ephemeral DPoP key. It learns a nonce using a separate valid assertion and nonexistent refresh token before testing assertions, so nonce negotiation cannot consume the assertion under test. Every retry gets a fresh proof. Six additional positive/negative controls per DPoP profile verify missing proofs, invalid signatures, method and URL mismatches are still refused; valid proofs before and after denials reach `invalid_grant`. All 18 controls pass.

This concerns test prerequisites and verdicts. The kit makes zero Company business actions; the results do not establish a live authenticated journey. [Original results](company-kit-original.json), [patched results and controls](company-kit-dpop.json).
