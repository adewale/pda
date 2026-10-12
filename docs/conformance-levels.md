# Conformance levels: MUST, SHOULD, MAY, rules without a key word, the Guides and our readings

What a finding rests on decides how much it counts, in all three places that judge an implementation: the mock Company (`test/mock-company/`), the validator (`src/validator/`) and the interop grid's attribution (`interop/runner/`). The code is `src/validator/levels.ts`. This page sets out the policy and the conventions of other conformance suites it follows, and settles the open grounding questions in [spec/grounding.md](../spec/grounding.md).

## What the draft says about its own words

- **BCP 14, capitals only.** Poppy Draft 0.1 says: "The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used as described in BCP 14 ([RFC 2119], [RFC 8174]) when they appear in capitals, as shown here." (spec section 1, [snapshot](../spec/draft-0.1-2026-10-09/pages/spec.md)). RFC 8174 adds: "When these words are not capitalized, they have their normal English meanings."
- **Normative text without key words.** RFC 8174 also says: "Specifically, normative text does not require the use of these key words. … a lot of normative text does not use them and is still normative." The draft states most of the protocol that way: "the Personal Agent sends `session_id` when it exchanges the code" (4.5); "Each has a `type` …, a `url`, and a short `description`" (3.1).
- **What is non-normative.** The draft doesn't say which of its sections are non-normative. The Guides say it about themselves: "Following the guides is not required to comply with the protocol. Each item is a recommendation, in the sense of SHOULD: do it unless you have a good reason not to. Where a guide repeats something the specification requires, it says MUST and links to the section that requires it."

## What other conformance suites do

| Suite | Levels | MUST | SHOULD | MAY or optional | Strict mode |
| --- | --- | --- | --- | --- | --- |
| [OpenID Foundation conformance suite](https://gitlab.com/openid/conformance-suite/-/blob/master/src/main/java/net/openid/conformance/testmodule/TestModule.java) | Per check: `FAILURE`, `WARNING`, `INFO`, `SUCCESS`, `REVIEW`. Per test: `PASSED`, `FAILED`, `WARNING`, `REVIEW`, `SKIPPED` | `FAILURE` | `WARNING`. The test author sets the level at each call site, with a requirement id such as `"OIDCC-3.1.2.1"`. Certification: "results with warnings are acceptable for certification purposes" ([FAPI OP submission](https://openid.net/certification/fapi_op_submission/)) | `SKIPPED` | None |
| [web-platform-tests](https://web-platform-tests.org/writing-tests/file-names.html) | Pass or fail. A file's name marks it `.tentative` or `.optional` | Fail | Fail: "This flag should not be used for 'SHOULD'; such requirements can be tested with regular tests, like 'MUST'." | `.optional`: "optional behavior … typically marked by the RFC 2119 'MAY' or 'OPTIONAL' keywords" | `.tentative`: "assertions not yet required by any specification, or in contradiction to some specification" |
| [h2spec](https://github.com/summerwind/h2spec) | Passed, failed, skipped | Run by default | Run only with `-S, --strict` ("Run all test cases including strict test cases"). When run, a failure is a failure | Not tested | `--strict` adds the SHOULD cases |
| [Autobahn&#124;Testsuite](https://github.com/crossbario/autobahn-testsuite/blob/master/autobahntestsuite/autobahntestsuite/fuzzing.py) | `OK`, `NON-STRICT`, `INFORMATIONAL`, `UNIMPLEMENTED`, `FAILED` | `FAILED`: "non-conforming to a MUST-behavior" | `NON-STRICT`: "does not adhere to a SHOULD-behavior … or a well-defined, canonical behavior that appears to be desirable but left open in the protocol specification. An implementation with non-strict behavior is still conformant" | `UNIMPLEMENTED`, reported as Missing | None. Unspecified behaviour is `INFORMATIONAL` |
| [A2A TCK](https://github.com/a2aproject/a2a-tck) | `--level must\|should\|may` | "Hard failure if not met" | "Expected failure (`xfail`), does not block compatibility" | "Skipped if the agent doesn't declare the capability" (in [0.3.0.beta5](https://github.com/a2aproject/a2a-tck/blob/0.3.0.beta5/README.md), declaring a capability made its tests mandatory: "False Advertising Detection") | 0.3.0.beta5: `--quality-required --features-required` |
| [MCP conformance](https://github.com/modelcontextprotocol/conformance), [SEP-2484](https://modelcontextprotocol.io/seps/2484-conformance-tests-required-for-final-seps) | `SUCCESS`, `FAILURE`, `WARNING`, `SKIPPED`, `INFO` | `FAILURE` | "Checks for SHOULD-level requirements report as warnings rather than failures." The runner itself isn't consistent: client mode exits 1 on warnings, server mode doesn't | "MAY requirements do not need rows" | None |
| [Khronos VK-GL-CTS](https://github.com/KhronosGroup/VK-GL-CTS/blob/main/framework/qphelper/qpTestLog.h) | `PASS`, `FAIL`, `QUALITY_WARNING`, `COMPATIBILITY_WARNING`, `NOT_SUPPORTED`, … | `FAIL` | `QUALITY_WARNING` ("within specification, but is not of high quality") and `COMPATIBILITY_WARNING` both count as passes ([Android CTS](https://source.android.com/docs/core/graphics/cts-integration)) | `NOT_SUPPORTED`, a pass | None |
| [Nu HTML checker](https://github.com/validator/validator/wiki/Output-%C2%BB-JSON) | `error`, `info` (subtype `warning`), `non-document-error` | `error`: "causes the validation/checking to fail" | `info`/`warning`: "does not affect the validity of the document" | n/a | `non-document-error`: checking ends "in an indeterminate state" |
| [tusharck/poppy-validator](https://github.com/tusharck/poppy-validator) (another Poppy validator) | Each rule has a level and a basis: MUST, field table, advisory, context, tool limit | MUST | Advisory | Context: "Never fails, even with `--strict`" | `--strict`: "Also fail on warnings and on info findings whose basis is `advisory`" |

Beyond the suites:

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) defines SHOULD as: "there may exist valid reasons in particular circumstances to ignore a particular item, but the full implications must be understood and carefully weighed". For MAY it says: "An implementation which does not include a particular option MUST be prepared to interoperate with another implementation which does include the option … (and the converse)."
- The [W3C QA Framework: Specification Guidelines](https://www.w3.org/TR/qaframe-spec/) name three styles of conformance requirement: "RFC 2119 keywords, imperative voice, [descriptive assertions]". It asks a spec to "Indicate which conformance requirements are mandatory, which are recommended, and which are optional" (Requirement 8).
- W3C's ReSpec boilerplate sets the default: "Everything else in this specification is normative."

**Where they agree.**

- A broken MUST fails.
- An unimplemented option is not a failure.
- Reports name the requirement each check rests on (OIDF requirement ids, MCP `specReferences`, poppy-validator's basis).

**Where they disagree.** A broken SHOULD is handled four ways:

- a warning that still conforms (OIDF, MCP, Autobahn, Khronos);
- an expected failure (A2A);
- not run unless strict, then a failure (h2spec);
- a plain failure (WPT).

Requirements without a key word are graded only by Autobahn, which calls departing from "a well-defined, canonical behavior … left open" non-strict. W3C and RFC 8174 treat them as normative. No suite gives security-motivated SHOULDs a level of their own. MCP's SEP-2484 exempts "Security recommendations describing implementation hardening rather than wire-level requirements" from required tests.

We take the majority reading: OIDF, MCP, Autobahn and Khronos. A broken SHOULD is reported as a warning and still conforms. h2spec's `--strict` becomes a mode we run on our own code. WPT's `.tentative` becomes the level for our readings.

## The policy

| Basis (what it rests on) | Level | Mock Company | Validator | Grid attribution |
| --- | --- | --- | --- | --- |
| `MUST`: MUST, MUST NOT, or a required field ("Req. Yes") | failure | Records a **violation**. Refuses the request where the draft gives it an error to send | **error**: the document is invalid | **error**: fails the cell. Rule 1 (`violation`) blames the side that broke it |
| `RFC`: a MUST of a standard the draft names normatively (RFC 9449, RFC 7523, RFC 8259, …) | failure | As MUST | As MUST | As MUST |
| `Rule`: a normative statement without a key word (RFC 8174; W3C's descriptive assertions) | failure | As MUST | As MUST | As MUST |
| `SHOULD`, `SHOULD NOT`, in the draft or an RFC it builds on | warning | Records a **warning**. It refuses only where the refusal is the Company's own protection (below) | **warning**: the document is still valid | **warning**: never fails a cell. When a cell fails and a Company's recorded SHOULD or Guides warning on one side is the only evidence, rule `warning` blames that side as a warning, not a violation |
| `Guides`: "a recommendation, in the sense of SHOULD" | warning | As SHOULD | As SHOULD | As SHOULD |
| `Reading`: our answer to an open question (docs/readings.md, docs/spec-issues.md) | tentative (WPT's `.tentative`) | Records a **warning**. Which reading the Company takes (and refuses on) is its profile | **warning** | **warning**. A failure it explains is the **spec's** (rule `reading`), unless both sides declared compatible readings of that question and one sent otherwise: then rule `warning`, that side |
| `MAY` | none | Nothing: an option is never held against the side that takes it (RFC 2119's interoperation clause) | Nothing, or **info** | Nothing. A capability that isn't offered is `unsupported` (501), not a failure |
| A fact, not a departure (an unknown member agents ignore, a website-only Company) | none | n/a | **info** (`note`) | Not a grid check |

**Strict runs.** This is h2spec's `--strict` and the A2A TCK's `--level should`: a strict run treats warnings and tentative readings as failures. It never decides blame. We run strict only on our own code:

- **Conformance tests.** The `afterEach` in `test/agent-helpers.ts` fails a test if the mock recorded any violation or any warning, so our client is held to SHOULDs, the Guides and our readings too. A test that breaks the protocol on purpose declares `expectViolations`, which matches either kind.
- **The validator.** `poppy-validate --strict` exits 1 on warnings.
- **The strict mock** (`dpa-mock-strict`). What makes it stricter is behaviour, not verdict: it takes the strictest reading of S2 (`typ: "JWT"`, 60 seconds) and refuses what that reading excludes. It records those checks as tentative, so in the grid a failure they cause goes to rule 3 (the spec) or to the side that broke its own declared reading. It is never a violation.

Profiles no longer filter what a Company reports. Both mocks report every recorded check with its basis and level (`GET /violations`), and the runner turns failures into errors and everything else into warnings. The old hand-kept `STRICT_ONLY` list has gone. Its seven SHOULD and Guides checks are warnings because of their basis, along with the ten other Guides checks and the ten readings.

## Security: behaviour and verdict are separate

A refusal made for safety stays in the behaviour, but its level comes from its basis. It is never promoted to a failure blamed on the other side. RFC 2119 section 6 allows imperatives "to limit behavior which has potential for causing harm". Where the draft gives only a SHOULD or the Guides, the protection is the refusing side's own choice. The other side departed from a recommendation, and a recommendation is not a requirement. So:

- **The mock** keeps refusing on the Guides' hardening, at the warning level:
  - the `.alg` allow-lists, ES256 and RS256 (S19);
  - a client assertion without a `jti`;
  - an `iat` in the future;
  - `Idempotency-Key` reuse.

  It also keeps refusing on our readings, at the tentative level:
  - an array `aud` (S1);
  - assertion lifetimes over 300 seconds, or over 60 when strict (S2).

  The harm oracle `exchange.performed-twice` and the record-only `secret.one-time-code` are warnings too, because their basis is the Guides.
- **The validator** gives each message a `refuses` flag, separate from its severity: whether our client refuses a Company over it. The report's `refused` says whether our client refuses the documents.
  - Our client still refuses everything it refused before, with one exception: an extension `version` written as a number now makes it ignore that extension instead of refusing the Company. It also now refuses a URL with an empty host label, such as `https://.`. The reports no longer call our policy the draft's requirement.
  - Warnings our client refuses:
    - the Guides' fetch limits: `http-non-public-host`, `http-non-public-address` (added later, for the Node CLI, which checks what a name resolves to), `http-too-many-redirects`, `http-redirect-not-allowed`, `http-too-large`. These now make a report **indeterminate**, because the document was never read.
    - `json-duplicate-member` (a SHOULD);
    - HTTPS and no fragment where the draft doesn't ask for them, which is spec-issues N9: `not-https-url-unstated`, `url-has-fragment-unstated`;
    - `mediated-fields-empty`.
  - Errors our client tolerates, because the draft or an RFC tells a reader to, or because it has a safe fallback:
    - `json-bom`: RFC 8259 lets parsers ignore a BOM;
    - `api-type-unknown`: section 6 says agents SHOULD skip unknown API types;
    - `api-description-missing`;
    - `organization-name-missing`: we show the domain instead.
- **The grid** reports security-relevant departures at the level of their basis:
  - `token.unlisted-host` (N10) is a warning;
  - `redirect.credentials-followed` (Guides) is a warning.

  Our own agent is held to them by the conformance tests, which run strict.

A security property the draft states as a MUST, RFC MUST or Rule stays a failure everywhere: DPoP binding, `jti` replay, `secret.token-in-url`, `client-metadata.not-https`, and every adversarial (Y/X) scenario's oracle.

**YK (reuse a rotated Account Token)** gets `"permitted_by": "N5"`. Section 4.8 binds only the agent: "A Company MAY return a new Account Token in `refresh_token`. The Personal Agent then MUST use the new one from then on." Nothing requires the Company to refuse the old token, and N5 asks for exactly that rule. The attack's oracle rests on the OAuth security BCP, not on the draft. Under this policy, a Company that accepts the old token has departed from no requirement of the draft, so a failure is the spec's (rule 0, `permitted_by`), not the Company's. Our mocks still refuse it, which is their behaviour. YK keeps passing against them, and a Company that lets the token through is reported as the open question N5.

## What changed, and how the counts moved

**Mock Company.** 144 checks:

- 117 rest on MUST (51), RFC (19) or a Rule (47) and stay violations;
- 17 rest on a SHOULD (1) or the Guides (16) and are now warnings;
- 10 rest on our readings and are now warnings, at the tentative level.

`state()` has `recorded` (every check, in order), `violations` and `warnings`. The catalog test checks each check's basis, level and filing. Each `TAMPERS` row checks that its id lands in the right list.

The grid's mock (`MOCK_BASE`) no longer lists an API of type `graphql`. The conformance tests' default still lists one, to check that agents skip it. Under section 6 that is a MUST the mock breaks on purpose, and a reference Company keeps to every MUST.

**Validator.** 75 messages, against 71 before, each with a basis. Errors went from 39 to 34, warnings from 20 to 29, and info stayed at 12. A 76th, `http-non-public-address`, came later, with the Node CLI's address check.

- Nine errors became warnings (all listed above, and our client still refuses every one):
  - the five fetch-limit messages;
  - `json-duplicate-member`;
  - `mediated-fields-empty`;
  - `jwks-key-type`;
  - `jwks-kid-duplicate`.
- Four became errors, and our client tolerates every one:
  - `json-bom` (RFC 8259 §8.1, MUST NOT);
  - `api-type-unknown` (6's MUST; now an error only in a document whose minor version the validator knows, and info as `api-type-newer` in a newer one, per 3.1);
  - `api-description-missing` (a Rule);
  - `organization-name-missing` (the "Req. Yes" `organization` is "Display name and domain": a Rule).
- Four are new:
  - `not-https-url-unstated` and `url-has-fragment-unstated` (N9: the draft's own HTTPS and fragment rules stay errors);
  - `api-type-newer`;
  - `extension-version-number`: N22, a Reading and a warning. It used to be a `wrong-type` error.
- `https://.` and other URLs with an empty host label are now `not-a-url`.
- `extension-plain-unknown` stays a warning (Reading). Plain names belong to extensions "defined on this site", which can be added independently of the protocol version, so an unknown one may be new rather than misnamed.

**Grid.** Trace checks now carry a basis. Where a check shares an id with the mock, its basis is the mock's, and a test checks that they agree. Company-recorded checks come with `basis` and `level`.

- Eight trace checks went from error to warning:
  - `client-assertion.alg`, `session-assertion.alg` (Guides);
  - `client-assertion.jti-missing` (Guides);
  - `client-assertion.aud-array` (Reading);
  - both `.lifetime` checks over 300 seconds (Reading);
  - `token.unlisted-host` (Reading);
  - `redirect.credentials-followed` (Guides).
- One went from warning to error: `company.retry-after`. Section 4.3 says a rate-limiting Company "returns HTTP 429 with a `Retry-After` header", a Rule.
- Rule `warning` is new, as described in the policy table.
- `results.json` has `levels` (checks per level over the interop cells), and the console and `index.html` print them.

The known failures don't change. Each one is a step failure, a Rule or MUST violation, or an S2 or S1 reading, and those keep their outcome and their known entry. Some cells can change rule without changing outcome. datalayer-ts and datalayer-py × both mocks, SVN, was rule 1. If the violation behind it was the mock's `dpop.nonce-ignored`, which rests on the Guides, it becomes rule `warning`; the known entry still matches.

A third-party Company whose documents break one of the four new errors now fails its cells by rule 1, and so does one that answers 429 without `Retry-After`. The full grid was run again under this policy at `08b28e7` on 12 October, and every interop cell's outcome stayed the same, with no known failure stale ([interop-results](interop-results/README.md)).
