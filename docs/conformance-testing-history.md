# Conformance and interop testing: a history, and what it means for Poppy

How the ideas behind our [interop harness](interop-testing.md) grew up: writing tests as data, sharing suites across implementations, running every client against every server, tracing tests back to the spec, and newer methods that generate or check tests mechanically. It ends with what we already do for the [Personal Agent Protocol](https://personalagentprotocol.org/) (Poppy) and what to add next. Sources are linked inline and listed at the end. Anything we couldn't confirm is marked *(unverified)*.

## 1. Pirate testing: tests as data

- **Pirate, 2004.** Pirate was a Python compiler for the Parrot virtual machine ([python-dev, 2003](https://www.python.org/pipermail/python-dev/2003-August/037459.html)). Its tests started out the usual way, as "one class with a large number of `test_*` methods". Sam Ruby [split them into separate files](https://www.intertwingly.net/blog/2004/10/08/Unbundling-Pirate-Tests), one test per file, with a loop that generated one `test_*` method per file. He credited the technique to Mark Pilgrim. Once each case is a file, the cases stop belonging to one harness.
- **The Feed Validator, early 2000s.** It was the same people's work on a bigger scale. Mark Pilgrim designed it and wrote most of the test cases; Sam Ruby wrote much of the back end. The distribution shipped "a complete test suite of almost 1000 feeds" ([About](https://validator.w3.org/feed/about.html)), and a 2003 release added 225 test cases for Pie (later Atom) to 326 for RSS ([news, July 2003](https://validator.w3.org/feed/news/archives/2003/07/09/preliminary_pie_support.html)). Every message had a stable id and a page explaining it. Our validator copies that ([validator.md](validator.md)).
- **"Pirate testing", 2010.** Ade Oshineye [named the pattern](https://blog.oshineye.com/2010/02/pirate-testing.html): functional tests written once as data, or in a neutral little language, and run by each implementation through a thin harness of its own. The examples were Twitter's conformance tests (harnesses in Java and Ruby), mimeparse, and feedparser. The post lists the benefits and the costs:
  - **Benefits.** New implementations are easier to bootstrap. The lessons of every implementation sit in one machine-readable place. Compliance arguments become "empirical matters which can be settled by a carefully crafted test case".
  - **Costs.** Only functional behaviour can be tested this way, so low-level bugs hide inside implementations. Suites get big and slow. Failure messages are generic unless the harness is built with care. When many tests fail, people tend to fix each one rather than the shared cause. Refactoring the data can break several implementations at once. Implementers have to agree on the canonical set. And pirate tests don't replace unit tests.

Pirate testing runs one suite against N implementations, so it tests each one's conformance, not how two of them work together.

## 2. Language-neutral suites

The same move, made separately by many communities:

| Suite | Data format | What it adds |
| --- | --- | --- |
| [html5lib-tests](https://github.com/html5lib/html5lib-tests) | JSON tokenizer tests; `#data`/`#errors`/`#document` text files for tree construction | The tests lived in one implementation's repository until implementers' edits broke each other, and in 2007 it was [proposed](https://lists.whatwg.org/pipermail/implementors-whatwg.org/2007-July/000469.html) to move them to a neutral home. Per the repository page, tree-construction tests are now maintained in WPT. |
| [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite) | One JSON array of cases per file, one directory per draft | Data only. Each implementer turns it into tests; consumers vendor it as a git submodule. |
| [JSON-LD API tests](https://w3c.github.io/json-ld-api/reports) | RDF test manifests | Implementations submit results in EARL. The report both proves independent implementations exist, as W3C process requires, and catalogues them. |
| [YAML test suite](https://github.com/yaml/yaml-test-suite) and [matrix](https://github.com/perlpunk/yaml-test-matrix) | Input, events, JSON, canonical output | A grid of test × library, built from Docker images of about 21 libraries. |
| [CommonMark](https://spec.commonmark.org/) | Examples embedded in the spec text | The spec's examples are the conformance tests. HTML was chosen as the output so that implementations don't need an AST printer. |
| [test262](https://github.com/tc39/test262) | One JS file per test, with metadata | More than 50,000 files. TC39 requires tests before a proposal reaches Stage 4. |
| [Web Platform Tests](https://www.bocoup.com/blog/wpt-an-overview-and-history), [wpt.fyi](https://wpt.fyi) | Many test types | Started as the W3C HTML WG's test suite and was renamed in 2013. Two-way sync with Chromium, then Gecko and WebKit. The annual [Interop](https://hacks.mozilla.org/2023/02/announcing-interop-2023/) effort since 2022 reports pass rates across all engines rather than per browser. |
| [WHATWG URL tests](https://github.com/web-platform-tests/wpt/blob/master/url/README.md) | `urltestdata.json` | Written for any URL parser, not only browsers. |
| Unicode data files ([UAX #44](https://www.unicode.org/reports/tr44/)) | `NormalizationTest.txt`, `BidiTest.txt`, `BidiCharacterTest.txt` | The standards body ships the conformance data with each release. |
| [toml-test](https://github.com/toml-lang/toml-test) | Valid and invalid inputs, with JSON expectations | Runs both ways: decoders, and encoders whose output a trusted decoder checks. Began in one Go library and was split out for everyone. |

**Lessons.** The data belongs in a neutral repository, not in one implementation's. The format should need nothing beyond a JSON parser. Negative cases (invalid documents) matter as much as positive ones. Results become a public grid.

## 3. Protocol interop: events and runners

Data files are enough to test a parser, but a protocol needs two live peers. Testing them moved from meetings in person to automated grids.

- **Events.**
  - The first SIP interoperability "bake-off" was in August 1999. SIPit became the SIP Forum's plugfest, mostly peer-to-peer tests with anonymous results ([Columbia](https://www.cs.columbia.edu/sip/sipit), [UNH-IOL](https://www.iol.unh.edu/event/2021/12/sipit-33)).
  - The IETF's "rough consensus and running code" goes back to David Clark in 1992 ([APNIC](https://blog.apnic.net/2021/08/20/running-code-at-ietf/)). The [IETF Hackathon](https://www.internetsociety.org/publications/ietf-journal-july-2015/ietf-hackathon) began at IETF 92 in March 2015 with about 40 people.
  - [RFC 7942](https://www.rfc-editor.org/rfc/rfc7942) (BCP 205, 2016) asks drafts to carry an Implementation Status section.
  - FIDO certification requires conformance self-tests first, then a proctored interoperability event against other implementers ([FIDO](https://fidoalliance.org/certification/functional-certification/functional-certification-servers/)).
- **Runners.**
  - **[QUIC Interop Runner](https://github.com/quic-interop/quic-interop-runner)** ([Seemann and Iyengar, 2020](https://www.ietf.org/blog/quic-automated-interop-testing/)). Each implementation registers a Docker image by pull request. The test case arrives in `TESTCASE`, and exit code 127 means "unsupported", so adding a case breaks nobody. A network simulator records pcaps, and implementations write qlog and TLS key logs. It replaced manual testing that was "limited by … a quadratic number of combinations".
  - **[h2spec](https://github.com/summerwind/h2spec)** is a one-sided HTTP/2 and HPACK conformance tester, selected by spec section (`http2/6.3`).
  - **BoringSSL's [BoGo](https://boringssl.googlesource.com/boringssl/+/main/ssl/test)** drives each library through a small shim. Its peer is a fork of Go's `crypto/tls` "patched with configurable bugs". NSS, rustls and Go have all written shims, with config files that map error strings and disable unsupported tests ([NSS](https://wiki.mozilla.org/NSS/BoGo_Tests), [Go](https://go.googlesource.com/go/+/2073b35e07ce9cea47ee1fbe763b304d2371954f%5E%21)).
  - **[tlsfuzzer](https://github.com/tlsfuzzer/tlsfuzzer)** is a library of attack scripts (ROBOT, DROWN) run against a host and port ([Red Hat](https://www.redhat.com/pt-br/blog/detecting-robot-and-other-vulnerabilities-using-red-hat-testing-tools)). **[TLS-Attacker](https://www.nds.ruhr-uni-bochum.de/media/nds/veroeffentlichungen/2016/10/19/tls-attacker-ccs16.pdf)** (CCS 2016) builds arbitrary message flows and argues for negative tests.
  - **[OpenID Foundation conformance suite](https://github.com/openid-certification/conformance-suite).** Test plans per profile, and the suite plays the opposite role: a fake OP to test an RP. "Negative tests" deliberately return invalid data ([Open Banking Brazil guide](https://openid.net/certification/fapi-rp-conformance-testing-certification-submission-overview-for-open-banking-brazil/)). The Python suite was retired in 2020 ([OIDF](https://openid.net/openid-certification-program-last-call-for-testing-openid-connect-implementations-on-python-platform/)). It still has gaps: an RP that never checks signatures passed a FAPI2 plan ([issue 1375](https://gitlab.com/openid/conformance-suite/-/issues/1375)).
  - **[Matrix Complement](https://github.com/matrix-org/complement).** A black-box Go rewrite of SyTest ([2020](https://matrix.org/blog/2020/07/10/this-week-in-matrix-2020-07-10)), made so that "any bugfix or feature in any homeserver" would add a test.
  - **ActivityPub.** The official suite is "of historic interest only" ([report](https://activitypub.rocks/implementation-report/)). Newer efforts are NLnet-funded [FediTest](https://nlnet.nl/project/FediverseTestsuite/) ([SeaGL 2024](https://pretalx.seagl.org/2024/talk/ZU7MDV/)) and go-fed's partly manual suite. A suite left unmaintained loses its authority.
  - **[MCP conformance](https://github.com/modelcontextprotocol/conformance).** The runner plays the other side: a scenario server to test a client, or a client to test a server. Each check carries spec references. An expected-failures file lets CI pass, and **a listed failure that now passes fails the run**, so stale entries get removed. SDK tiers are computed from the pass rates.
  - **[A2A TCK](https://github.com/a2aproject/a2a-tck).** Results are graded by RFC 2119 level: MUST failures are hard, SHOULD failures are expected failures, and MAY tests are skipped unless the agent card declares the capability.
  - **SCIM.** Testers such as [scim2-tester](https://pypi.org/project/scim2-tester) are aimed at CI. Older suites went unmaintained and drifted from the RFC.

**Lessons.** Register implementations by pull request. Pin versions. "Unsupported" must be distinct from "failed". Record the traffic. Let the harness play the missing side. Make known failures expire.

## 4. Requirement ledgers and spec coverage

- **In the spec.** Bikeshed's `<wpt>` element puts test links next to the paragraph they test, and tooling reports tests with no link ([Atkins, 2017](https://lists.w3.org/Archives/Public/spec-prod/2017JulSep/0006.html)). ReSpec's `data-tests` does the same for "testable assertions" ([Cáceres, 2017](https://lists.w3.org/Archives/Public/spec-prod/2017JulSep/0003.html)).
- **In the suite.**
  - The A2A TCK uses requirement ids (`CORE-OPS-*`), and MCP checks carry spec references.
  - [Datalayer's Poppy SDK](https://github.com/datalayer/personal-agent-protocol) has `protocol/requirements.yaml`, mapping 160 requirements to code and tests, with a test that the references exist.
  - Its blind spot, [as we found](poppy-issues.md#datalayer-sdk-datalayerpersonal-agent-protocol): it holds only sentences with RFC 2119 keywords, and three bugs sat in sentences without one. The Poppy draft has 107 keyword sentences and many further requirements without a keyword ([spec/grounding.md](../spec/grounding.md#counts)).
- **In the report.** The JSON-LD implementation report uses EARL, and test262 metadata names the features each test covers. Both let results be compared across implementations.

## 5. Certification programmes versus open grids

| | Certification (OIDF, FIDO) | Open grid (QUIC, WPT, YAML matrix) |
| --- | --- | --- |
| Output | A mark or listing, often paid ([OIDF](https://openid.net/certification/), [FIDO](https://fidoalliance.org/certification/conformance/)) | A public table, refreshed continuously |
| Who runs it | The implementer self-certifies, or an auditor does | Everyone, every night |
| Strength | Clear incentive, and procurement can rely on it | Cheap, and finds pairwise failures and spec ambiguity |
| Weakness | A snapshot that can certify a gap (issue 1375 above); cost excludes hobby projects | No authority; a red cell is easily misread as blame |

Certification needs a stable spec, while a grid suits a draft. WPT's move from per-browser scores to a shared Interop score shows how a grid can steer collective work without naming losers.

## 6. Modern additions: generating and checking tests mechanically

- **Fuzzing.** Miller, Fredriksen and So crashed 25–33% of UNIX utilities with random input ([CACM 1990](https://ftp1.cs.wisc.edu/par-distr-sys/papers/fuzz.pdf)).
  - Since then: continuous fuzzing ([OSS-Fuzz, 2016](https://opensource.googleblog.com/2016/12/announcing-oss-fuzz-continuous-fuzzing.html)), and stateful protocol and API fuzzers.
  - [AFLNet](https://www.comp.nus.edu.sg/~abhik/pdf/AFLNet-ICST20.pdf) is seeded with recorded client–server exchanges and steers by response codes. [RESTler](https://www.microsoft.com/en-us/research/publication/restler-stateful-rest-api-fuzzing) infers producer–consumer dependencies from an OpenAPI description. [Schemathesis](https://pypi.org/project/schemathesis/) does property-based testing from OpenAPI, following links between operations.
- **Property-based and model-based testing.**
  - QuickCheck, by Claessen and Hughes, grew stateful testing: a model, a generator of command sequences, postconditions, and shrinking to a minimal failing sequence ([Hughes 2016](https://research.chalmers.se/en/publication/232550)).
  - Modelling 3,000 pages of AUTOSAR specifications for Volvo exposed more than 200 issues ([Arts et al. 2015](https://research.chalmers.se/en/publication/219899)).
  - [Hypothesis](https://hypothesis.readthedocs.io/en/latest/stateful.html) offers the same through rule-based state machines.
- **Differential testing.** McKeeman's "Differential Testing for Software" ([DTJ 1998](https://dblp.org/pid/40/4856)) ran several compilers on the same input. [Csmith](https://www-old.cs.utah.edu/~regehr/papers/pldi11-preprint.pdf) (PLDI 2011) found more than 325 compiler bugs this way: "if the outputs differ, one of the compilers must be wrong". An M×N grid is differential testing between peers.
- **Metamorphic testing.** When there is no oracle for one output, check a relation between the outputs of related inputs ([Chen, Cheung and Yiu, 1998](https://arxiv.org/abs/2002.12543)).
- **Mutation testing of test suites.** Seed small faults and require the tests to catch them ([DeMillo, Lipton and Sayward, 1978](https://www.cerias.purdue.edu/apps/reports_and_papers/view/919)).
  - BoGo's "configurable bugs" turn the idea on the peer. [poppyseed](https://github.com/akshay5995/poppyseed) has 124 mutants, each of which breaks one rule and must make a named check fail ([poppy-issues](poppy-issues.md#poppyseed-akshay5995poppyseed)).
  - Our `TAMPERS` rows do the same for every check our mock makes.

## 7. Lessons

1. **Data outlives harnesses.** Keep the cases in a neutral format and a neutral repository (Pirate, html5lib, JSON Schema, toml-test).
2. **Play the missing side.** A suite that can be the peer (OIDF, MCP, BoGo) tests a lone implementation and pinpoints which side is at fault.
3. **"Unsupported" is not "failed"** (QUIC's 127, A2A's MAY skips). Otherwise new tests punish early adopters.
4. **Known failures must expire** (MCP's stale-entry rule, WPT's linked expectations).
5. **Grade by requirement level** (A2A: MUST fails, SHOULD warns), and trace every check to a sentence, including sentences without a keyword.
6. **Disagreement between implementations is evidence about the spec** (Csmith's insight, applied to protocols).
7. **Test the tests.** Mutants, negative cases and configurable bugs keep a suite from passing everything (OIDF issue 1375).
8. **Unmaintained suites lose authority** (ActivityPub, older SCIM suites). Someone has to own the suite.

## 8. Timeline

| Year | Event |
| --- | --- |
| 1978 | Mutation testing (DeMillo, Lipton, Sayward) |
| 1990 | Fuzz (Miller et al.) |
| 1992 | "Rough consensus and running code" (Clark) |
| 1998 | Differential testing (McKeeman); metamorphic testing (Chen et al.) |
| 1999 | First SIP bake-off |
| 2000 | QuickCheck (Claessen and Hughes; the year is from memory) |
| 2003 | Feed Validator test cases for RSS and Pie/Atom |
| 2004 | Sam Ruby unbundles Pirate's tests |
| 2007 | html5lib tests proposed for a neutral home |
| 2010 | "Pirate testing" (Oshineye) |
| 2011 | Csmith |
| 2013 | html-testsuite renamed web-platform-tests |
| 2015 | IETF Hackathon begins |
| 2016 | RFC 7942; OSS-Fuzz; TLS-Attacker |
| 2017 | Bikeshed `<wpt>`, ReSpec `data-tests`; WPT gets its own GitHub organisation |
| 2019 | RESTler |
| 2020 | QUIC Interop Runner paper; Complement; AFLNet; OIDF retires its Python suite |
| 2022 | Interop 2022 |
| 2024 | FediTest |
| 2025 | MCP conformance framework (date approximate) |
| 2026 | Poppy Draft 0.1 (9 October); our M×N grid (11 October). (The A2A TCK is current, but we didn't establish when it started.) |

## 9. What this means for Poppy

### What we already do

| Idea | Where it is in our harness |
| --- | --- |
| Tests as data | Scenarios as JSON in [`interop/scenarios/`](../interop/scenarios), honest, adversarial and network-fault; Datalayer's one-sided vectors run against our code by [`interop/vectors/datalayer/`](../interop/vectors/datalayer), and [`interop/vectors/validators/`](../interop/vectors/validators/README.md) runs two other validators and ours over the same 107 `poppy.json` documents. We exported our own validator fixtures and tamper rows in Datalayer's schema too, but removed them: nothing consumed them |
| Thin adapter per implementation | Control API and hooks API ([interop-spec §5](interop-spec.md#5-adapter-apis)); every implementation is an entry in [`registry.json`](../interop/registry.json) |
| Unsupported ≠ failed | 501 from an adapter, and `scenarios` in the manifest |
| Playing the missing side | Our mock Company, in its lenient profile (`dpa-mock`), is the reference column for attribution rule 2; the strict profile runs beside it as `dpa-mock-strict` |
| Recorded traffic and passive checks | Recording proxy, a HAR per cell, the mock's checks as pure functions over the trace |
| Disagreement as evidence about the spec | Our [readings](readings.md) of the open questions, rule 3 (blame `spec`), and "Grid:" rows in [spec-issues](spec-issues.md) |
| Testing the tests | `TAMPERS` and the catalog test; `INTEROP_FAULT=assertion-typ` to check attribution |
| Six readings of open questions | The `PROFILES` in `test/poppy.test.ts` |
| Ledger | Appendix A of the spec and `npm run check:docs`, kept by hand |
| Grading by requirement level | [conformance-levels.md](conformance-levels.md): a check's basis (MUST, RFC, Rule, SHOULD, Guides, Reading) sets its level in the mock, the validator and the grid; warnings never fail, readings are tentative, and only our own strict runs fail on warnings |
| Known failures linked to issues | [`known-failures.json`](../interop/known-failures.json), with wildcards, one entry per root cause; an entry that matched no failed cell in a run that could judge it is stale and fails the run |

### What to add, in priority order

1. **Make known failures expire.** Done: following MCP, an entry in `known-failures.json` that matched no failed cell, in a run that covered its cells, now fails the run ([interop-spec §9](interop-spec.md#9-results-and-attribution)), so a fix can't go unnoticed and the file doesn't rot.
2. **One fault per check, for attribution.** Grow `INTEROP_FAULT` from one fault (`assertion-typ`) to one per trace check id, in both our adapters. A CI job then asserts each fault makes the right check fire and blames the right side by the right rule. This is mutation testing of the checker and of `attribution.ts`, as `TAMPERS` is for the mock.
3. **A shared vectors repository.** Do step 1 of our [plan](interop-testing.md#plan): propose `poppy-test-vectors` in Datalayer's schema, seeded with our validator fixtures and tamper rows, Datalayer's 124 cases and poppyseed's 124 mutants. Not done: the repository was never made, and our exported vectors were removed because nothing consumed them; exporting them again is worth it only once someone will. Give each entry the spec sentence it tests, and include the keywordless sentences Datalayer's ledger misses.
4. **A machine-readable ledger shown on the grid.** Turn Appendix A into data: every keyword sentence (107), every keywordless requirement, the 20 in Operations, each with the scenario, check, vector and test ids that cover it. Show coverage per section on `index.html`, and grade failures by keyword level as A2A does. `check:docs` already checks the references exist.
5. **Automatic disagreement reports.** For each scenario, normalise what every Company returned (status, error code, `WWW-Authenticate`, the presence of optional fields) and list each field where Companies disagree. That is McKeeman's method across Companies, and it would draft N-numbered issues instead of leaving them to be spotted by hand (N39, N40 and N41 were found that way).
6. **Metamorphic variants of existing scenarios.** Run each scenario again with a transformation that shouldn't change the outcome: an issuer with a trailing slash or a path (S3, S7), percent-encoded paths (the Datalayer `htu` bug), nonces on (S23), reordered JSON members, a different host case, a retry with the same message id (S9). A pass becoming a fail pinpoints the bug without a new oracle.
7. **Model-based scenario generation.** Scenarios are already data over a fixed vocabulary of steps. Write a small model of Session, Account Token, conversation and operation state, and generate random step sequences as scenario JSON. Check invariants after each step (an operation is performed at most once; tokens only go to listed hosts; no `jti` is reused), and shrink failures to a minimal scenario. Rotation (N5), sign-out (N16) and Ops deadlocks (N19) are the bugs this approach finds.
8. **Fuzzing with the HARs as seeds.** Mutate recorded exchanges, AFLNet-style, against Companies. Fuzz `poppy.json` and client metadata from the validator's schema against every agent's discovery code, with WPT-style "crashtests" (pass means no crash, no hang, a clean `discovery_failed`). Run Schemathesis against fixture OpenAPI descriptions.
9. **Adversarial implementations.** Built: `evil-company` and `evil-agent` adapters and a fault-injection proxy, run only against our own implementations. What remains is the "Not yet" rows of [adversarial-interop.md](adversarial-interop.md)'s attack tables.
10. **Community process, not certification.** While the draft is 0.1, keep an open grid. Suggest the spec carry an RFC 7942 Implementation Status section that links the grid, and hold a virtual plugfest once implementers have adapters. Present results as a shared Interop-style score per scenario, not a ranking of projects ([risks](interop-testing.md#risks)). Certification is premature until the spec stops breaking compatibility.

## Sources

Every source above is linked where it's cited. Primary sources:

- Pirate and pirate testing: [Ruby 2004](https://www.intertwingly.net/blog/2004/10/08/Unbundling-Pirate-Tests); [python-dev 2003](https://www.python.org/pipermail/python-dev/2003-August/037459.html); [Oshineye 2010](https://blog.oshineye.com/2010/02/pirate-testing.html); Feed Validator [About](https://validator.w3.org/feed/about.html) and [2003 news](https://validator.w3.org/feed/news/archives/2003/07/09/preliminary_pie_support.html)
- Suites: [html5lib-tests](https://github.com/html5lib/html5lib-tests); [WHATWG 2007](https://lists.whatwg.org/pipermail/implementors-whatwg.org/2007-July/000469.html); [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite); [JSON-LD reports](https://w3c.github.io/json-ld-api/reports); [yaml-test-suite](https://github.com/yaml/yaml-test-suite); [yaml-test-matrix](https://github.com/perlpunk/yaml-test-matrix); [CommonMark](https://spec.commonmark.org/); [test262](https://github.com/tc39/test262); [WPT history (Bocoup)](https://www.bocoup.com/blog/wpt-an-overview-and-history); [Interop 2023](https://hacks.mozilla.org/2023/02/announcing-interop-2023/); [wpt.fyi](https://wpt.fyi); [WPT URL tests](https://github.com/web-platform-tests/wpt/blob/master/url/README.md); [UAX #44](https://www.unicode.org/reports/tr44/); [toml-test](https://github.com/toml-lang/toml-test)
- Events and runners: [SIPit](https://www.cs.columbia.edu/sip/sipit); [SIPit 33](https://www.iol.unh.edu/event/2021/12/sipit-33); [Running code (APNIC)](https://blog.apnic.net/2021/08/20/running-code-at-ietf/); [IETF Hackathon](https://www.internetsociety.org/publications/ietf-journal-july-2015/ietf-hackathon); [RFC 7942](https://www.rfc-editor.org/rfc/rfc7942); [QUIC Interop Runner](https://github.com/quic-interop/quic-interop-runner); [IETF blog on QUIC interop](https://www.ietf.org/blog/quic-automated-interop-testing/); [h2spec](https://github.com/summerwind/h2spec); [BoGo](https://boringssl.googlesource.com/boringssl/+/main/ssl/test); [NSS BoGo](https://wiki.mozilla.org/NSS/BoGo_Tests); [Go BoGo shim](https://go.googlesource.com/go/+/2073b35e07ce9cea47ee1fbe763b304d2371954f%5E%21); [tlsfuzzer](https://github.com/tlsfuzzer/tlsfuzzer); [Red Hat on tlsfuzzer](https://www.redhat.com/pt-br/blog/detecting-robot-and-other-vulnerabilities-using-red-hat-testing-tools); [TLS-Attacker](https://www.nds.ruhr-uni-bochum.de/media/nds/veroeffentlichungen/2016/10/19/tls-attacker-ccs16.pdf); [OIDF conformance suite](https://github.com/openid-certification/conformance-suite); [OIDF certification](https://openid.net/certification/); [OIDF Python retirement](https://openid.net/openid-certification-program-last-call-for-testing-openid-connect-implementations-on-python-platform/); [OIDF Brazil RP guide](https://openid.net/certification/fapi-rp-conformance-testing-certification-submission-overview-for-open-banking-brazil/); [OIDF issue 1375](https://gitlab.com/openid/conformance-suite/-/issues/1375); [FIDO conformance](https://fidoalliance.org/certification/conformance/); [FIDO server certification](https://fidoalliance.org/certification/functional-certification/functional-certification-servers/); [Complement](https://github.com/matrix-org/complement); [This Week in Matrix 2020-07-10](https://matrix.org/blog/2020/07/10/this-week-in-matrix-2020-07-10); [ActivityPub report](https://activitypub.rocks/implementation-report/); [FediTest (NLnet)](https://nlnet.nl/project/FediverseTestsuite/); [FediTest at SeaGL](https://pretalx.seagl.org/2024/talk/ZU7MDV/); [MCP conformance](https://github.com/modelcontextprotocol/conformance); [A2A TCK](https://github.com/a2aproject/a2a-tck); [scim2-tester](https://pypi.org/project/scim2-tester)
- Ledgers: [Bikeshed `<wpt>`](https://lists.w3.org/Archives/Public/spec-prod/2017JulSep/0006.html); [ReSpec `data-tests`](https://lists.w3.org/Archives/Public/spec-prod/2017JulSep/0003.html); [Datalayer SDK](https://github.com/datalayer/personal-agent-protocol); [poppyseed](https://github.com/akshay5995/poppyseed)
- Methods: [Miller et al. 1990](https://ftp1.cs.wisc.edu/par-distr-sys/papers/fuzz.pdf); [OSS-Fuzz](https://opensource.googleblog.com/2016/12/announcing-oss-fuzz-continuous-fuzzing.html); [AFLNet](https://www.comp.nus.edu.sg/~abhik/pdf/AFLNet-ICST20.pdf); [RESTler](https://www.microsoft.com/en-us/research/publication/restler-stateful-rest-api-fuzzing); [Schemathesis](https://pypi.org/project/schemathesis/); [Hughes 2016](https://research.chalmers.se/en/publication/232550); [AUTOSAR with QuickCheck](https://research.chalmers.se/en/publication/219899); [Hypothesis stateful](https://hypothesis.readthedocs.io/en/latest/stateful.html); [McKeeman 1998 (dblp)](https://dblp.org/pid/40/4856); [Csmith](https://www-old.cs.utah.edu/~regehr/papers/pldi11-preprint.pdf); [Metamorphic testing](https://arxiv.org/abs/2002.12543); [DeMillo et al. 1978](https://www.cerias.purdue.edu/apps/reports_and_papers/view/919)
- Poppy: [personalagentprotocol.org](https://personalagentprotocol.org/); [Sierra announcement](https://sierra.ai/blog/poppy)
