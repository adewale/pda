import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attribute, attributeAll, checkLevel, companyRecorded, failureCode, knownFailure, knownMatches, levelCounts, staleKnown, unexpected } from "../runner/attribution.ts";
import { compatible, QUESTIONS, readingChecks, refusedReadingChecks } from "../runner/readings.ts";
import { jwt, NOW, recording } from "./helpers.ts";
import type { Cell, Check, Outcome, Scenario, StepRecord } from "../runner/types.ts";

const error = (side: "agent" | "company"): Check => ({ id: "x", side, severity: "error", exchange: null, detail: "", source: "trace" });
/** The trace's evidence that a Company refused what its reading of `question` doesn't accept. */
const refusal = (question: string): Check => ({ id: `reading.${question}.refused`, side: "agent", severity: "warning", basis: "Reading", exchange: 1, detail: "", source: "trace" });

function cell(agent: string, company: string, outcome: Outcome, checks: Check[] = [], scenario = "SD"): Cell {
  return { agent, company, scenario, outcome, blame: null, rule: null, steps: [], checks, har: null };
}

const scenarios = new Map<string, Scenario>([["SD", { id: "SD", title: "Direct", readings: ["S1", "S2"], steps: [] }]]);
const none = { readings: { agent: {}, company: {} }, scenarios };

describe("attribution", () => {
  it("rule 1: errors on one side blame that side; on both, it falls through", () => {
    expect(attribute(cell("a", "c", "fail", [error("agent")]), [], none)).toEqual({ blame: "agent", rule: "violation" });
    expect(attribute(cell("a", "c", "fail", [error("company"), error("company")]), [], none)).toEqual({ blame: "company", rule: "violation" });
    expect(attribute(cell("a", "c", "fail", [error("agent"), error("company")]), [], none)).toEqual({ blame: null, rule: "unattributed" });
    const warningsOnly = cell("a", "c", "fail", [{ ...error("agent"), severity: "warning" }]);
    expect(attribute(warningsOnly, [], none).rule).toBe("unattributed");
  });

  it("rule 2: an agent that passes against the reference, at a Company every agent fails, blames the Company", () => {
    const target = cell("a", "c", "fail");
    const grid = [target, cell("a", "pda-mock", "pass"), cell("b", "c", "fail"), cell("b", "pda-mock", "pass")];
    expect(attribute(target, grid, none)).toMatchObject({ blame: "company", rule: "grid" });
    // Another agent passes at c, and a passes elsewhere: the grid decides nothing.
    const mixed = [target, cell("a", "pda-mock", "pass"), cell("b", "c", "pass")];
    expect(attribute(target, mixed, none)).toEqual({ blame: null, rule: "unattributed" });
  });

  it("rule 2: an agent that fails everywhere, at a Company another agent passes, blames the agent", () => {
    const target = cell("a", "pda-mock", "fail");
    const grid = [target, cell("a", "c", "fail"), cell("b", "pda-mock", "pass")];
    expect(attribute(target, grid, none)).toMatchObject({ blame: "agent", rule: "grid" });
    // Unsupported cells don't count either way.
    expect(attribute(target, [target, cell("b", "pda-mock", "unsupported")], none).rule).toBe("unattributed");
  });

  it("rule 3: incompatible readings of a question the scenario depends on blame the spec, when the trace shows it mattered", () => {
    const readings = { agent: { a: { S2: "any" } }, company: { c: { S2: "jwt-60s" } } };
    expect(attribute(cell("a", "c", "fail", [refusal("S2")]), [], { readings, scenarios })).toMatchObject({ blame: "spec", rule: "reading" });
    // Declarations that differ, with nothing in the trace to say the question came up, decide nothing.
    expect(attribute(cell("a", "c", "fail"), [], { readings, scenarios })).toEqual({ blame: null, rule: "unattributed" });
    expect(attribute(cell("a", "c", "fail", [], "C"), [], { readings, scenarios }).rule).toBe("unattributed");
    // Evidence of another question isn't evidence of this one.
    expect(attribute(cell("a", "c", "fail", [refusal("S1")]), [], { readings, scenarios }).rule).toBe("unattributed");
  });

  it("rule 3 without evidence falls through: poppy-demo's issuer-origin failure isn't S3", () => {
    // poppy-demo reads S3 append, pda-mock insertion; D fails on poppy-demo's issuer check, with no S3 in the trace.
    const d = new Map<string, Scenario>([["D", { id: "D", title: "Discovery", readings: ["S3"], steps: [] }]]);
    const readings = { agent: { "poppy-demo": { S3: "append" }, pda: { S3: "insertion" } }, company: { "pda-mock": { S3: "insertion" }, poppyseed: { S3: "either" } } };
    const target = cell("poppy-demo", "pda-mock", "fail", [], "D");
    expect(attribute(target, [target], { readings, scenarios: d })).toEqual({ blame: null, rule: "unattributed" });
    // So the grid gets its say: poppy-demo fails D everywhere, and pda passes it at pda-mock.
    const grid = [target, cell("poppy-demo", "poppyseed", "fail", [], "D"), cell("pda", "pda-mock", "pass", [], "D")];
    expect(attribute(target, grid, { readings, scenarios: d })).toMatchObject({ blame: "agent", rule: "grid" });
  });

  it("rule 3 after rule 2: a Company-recorded error of the question is evidence, beside errors on both sides", () => {
    const typ: Check = { id: "session-assertion.typ", side: "agent", severity: "error", exchange: null, detail: "typ", source: "company:pda-mock-strict" };
    const readings = { agent: { a: { S2: "any" } }, company: { "pda-mock-strict": { S2: "jwt-60s" } } };
    const target = cell("a", "pda-mock-strict", "fail", [typ, error("agent"), error("company")], "C");
    expect(attribute(target, [target], { readings, scenarios })).toEqual({ blame: "spec", rule: "reading", detail: "S2: a reads any, pda-mock-strict reads jwt-60s" });
  });

  it("reads each side's readings under its own role, where one name has both", () => {
    // adonis-agora's agent reads S1 token-endpoint; its Company accepts either.
    const readings = { agent: { "adonis-agora": { S1: "token-endpoint" } }, company: { "adonis-agora": { S1: "either" }, poppyseed: { S1: "endpoint" } } };
    expect(attribute(cell("adonis-agora", "poppyseed", "fail", [refusal("S1")]), [], { readings, scenarios })).toEqual({
      blame: "spec",
      rule: "reading",
      detail: "S1: adonis-agora reads token-endpoint, poppyseed reads endpoint"
    });
    expect(attribute(cell("adonis-agora", "adonis-agora", "fail", [refusal("S1")]), [], { readings, scenarios }).rule).toBe("unattributed");
  });

  it("rule 3: a Company-recorded reading of ours that is exactly a declared reading difference", () => {
    // A strict Company refuses a typ-less Session assertion (Reading S2: a tentative warning); the agent declared S2 any.
    const typ = companyRecorded({ id: "session-assertion.typ", basis: "Reading", level: "tentative", detail: "typ" }, "pda-mock-strict", false);
    expect(typ).toMatchObject({ severity: "warning", basis: "Reading" });
    const readings = { agent: { "pi-poppy": { S2: "any" } }, company: { "pda-mock-strict": { S2: "jwt-60s" }, "pda-mock": { S2: "any" } } };
    const strict = cell("pi-poppy", "pda-mock-strict", "fail", [typ], "C");
    expect(attribute(strict, [strict], { readings, scenarios })).toEqual({ blame: "spec", rule: "reading", detail: "S2: pi-poppy reads any, pda-mock-strict reads jwt-60s" });
    // An agent that declared jwt-60s and sent no typ broke its own word: its departure, at warning level.
    expect(attribute(strict, [strict], { readings: { ...readings, agent: { "pi-poppy": { S2: "jwt-60s" } } }, scenarios })).toMatchObject({ blame: "agent", rule: "warning" });
    // An error beside it is a violation, by the side that made it: a failure outranks a reading.
    const both = cell("pi-poppy", "pda-mock-strict", "fail", [typ, error("agent")], "C");
    expect(attribute(both, [both], { readings, scenarios })).toEqual({ blame: "agent", rule: "violation" });
    // The runner's own trace check of the same id isn't a Company's refusal, so it decides nothing.
    const traced = cell("pi-poppy", "pda-mock-strict", "fail", [{ ...typ, source: "trace" }], "C");
    expect(attribute(traced, [traced], { readings, scenarios })).toEqual({ blame: null, rule: "unattributed" });
    // A Company that still sends an error for it (no basis) is read as before: the declared difference explains it.
    const legacy: Check = { ...typ, severity: "error", basis: null };
    const old = cell("pi-poppy", "pda-mock-strict", "fail", [legacy], "C");
    expect(attribute(old, [old], { readings, scenarios })).toMatchObject({ blame: "spec", rule: "reading" });
  });

  it("files what a Company records by its basis: a failure is an error, the rest warnings that never fail a cell", () => {
    const at = (basis: unknown, security = false) => companyRecorded({ id: "x.y", basis, detail: "" }, "pda-mock", security);
    expect(["MUST", "RFC", "Rule"].map((basis) => at(basis).severity)).toEqual(["error", "error", "error"]);
    expect(["SHOULD", "Guides", "Reading"].map((basis) => at(basis).severity)).toEqual(["warning", "warning", "warning"]);
    // No basis, or one we don't know: a failure, as every record was before bases.
    expect([at(null).severity, at("SOMETIMES").severity]).toEqual(["error", "error"]);
    // In a security cell the bad request is the attack's: always a warning (rule 0 decides).
    expect(at("MUST", true).severity).toBe("warning");
    expect([at("MUST"), at("Guides"), at("Reading"), error("agent"), { ...error("agent"), severity: "warning" as const }].map(checkLevel)).toEqual([
      "failure",
      "warning",
      "tentative",
      "failure",
      "warning"
    ]);
  });

  it("rule warning: a SHOULD or Guides refusal on one side blames that side as a warning, not a violation", () => {
    // pda-mock refuses an ES384 Session assertion (Guides: support ES256 and RS256).
    const alg = companyRecorded({ id: "session-assertion.alg", basis: "Guides", detail: "alg ES384" }, "pda-mock", false);
    const target = cell("a", "pda-mock", "fail", [alg], "C");
    expect(attribute(target, [target], none)).toEqual({ blame: "agent", rule: "warning", detail: "session-assertion.alg: a SHOULD or the Guides, not a requirement" });
    // Any failure-level error decides first.
    const withError = cell("a", "pda-mock", "fail", [alg, error("company")], "C");
    expect(attribute(withError, [withError], none)).toEqual({ blame: "company", rule: "violation" });
    // Passive warnings (the runner's trace, the validator) aren't a Company's refusal and decide nothing.
    const passive = cell("a", "c", "fail", [{ ...alg, source: "validator" }], "C");
    expect(attribute(passive, [passive], none)).toEqual({ blame: null, rule: "unattributed" });
  });

  it("blames the spec for a failure our own reading of an open question explains, when no declared question covers it", () => {
    // The mock refuses an array aud on a client assertion (Reading S1: 4.2 asks a single string only of the Session assertion).
    const array = companyRecorded({ id: "client-assertion.aud-array", basis: "Reading", detail: "aud is an array" }, "pda-mock", false);
    const target = cell("a", "pda-mock", "fail", [array], "C");
    expect(attribute(target, [target], none)).toEqual({ blame: "spec", rule: "reading", detail: "client-assertion.aud-array: our reading, not a requirement of the draft" });
  });

  it("counts checks per level over the interop cells, leaving security cells out", () => {
    const cells = [
      cell("a", "c", "fail", [error("agent"), companyRecorded({ id: "x", basis: "Guides", detail: "" }, "c", false)]),
      cell("a", "d", "pass", [companyRecorded({ id: "y", basis: "Reading", detail: "" }, "d", false), refusal("S2")]),
      { ...cell("evil", "c", "pass", [error("agent")]), security: true }
    ];
    expect(levelCounts(cells)).toEqual({ failure: 1, warning: 1, tentative: 2 });
  });

  it("errors are the harness's, and passes and unsupported cells have no blame", () => {
    expect(attribute(cell("a", "c", "error"), [], none)).toEqual({ blame: "harness", rule: null });
    expect(attribute(cell("a", "c", "pass"), [], none)).toEqual({ blame: null, rule: null });
    expect(attribute(cell("a", "c", "unsupported"), [], none)).toEqual({ blame: null, rule: null });
  });

  it("attaches known failures, which no longer fail the run", () => {
    const cells = [cell("a", "c", "fail"), cell("a", "d", "fail")];
    attributeAll(cells, { ...none, known: [{ agent: "a", company: "c", scenario: "SD", blame: null, issue: "https://example.com/1", reason: "S2" }] });
    expect(cells[0]!.known).toEqual({ issue: "https://example.com/1", reason: "S2" });
    expect(unexpected(cells).map((c) => c.company)).toEqual(["d"]);
  });
});

describe("known failures", () => {
  const issue = "https://example.com/1";
  /** A failed cell with no checks or failed step, unattributed: what an entry with `blame: null` and nothing else expects. */
  const failed = (agent: string, company: string, scenario: string) => cell(agent, company, "fail", [], scenario);
  const step = (error: string, actor: "agent" | "expect" = "agent"): StepRecord => ({ actor, op: actor === "agent" ? "session" : "expect", ms: 1, ok: false, error });
  const check = (id: string, severity: "error" | "warning" = "error"): Check => ({ id, side: "agent", severity, exchange: null, detail: "", source: "trace" });

  it("match a field by name or by * for any", () => {
    const known = [{ agent: "pi-poppy", company: "*", scenario: "SE", blame: null, issue }];
    expect(knownFailure(failed("pi-poppy", "datalayer-ts", "SE"), known)).toBe(known[0]);
    expect(knownFailure(failed("pi-poppy", "datalayer-ts", "O"), known)).toBeUndefined();
    expect(knownFailure(failed("pda", "datalayer-ts", "SE"), known)).toBeUndefined();
    const any = [{ agent: "*", company: "*", scenario: "*", blame: null, issue }];
    expect(knownFailure(failed("a", "c", "D"), any)).toBe(any[0]);
  });

  it("never exempts a 0.2 failure with an unversioned 0.1 known failure", () => {
    const target = { ...failed("a", "c", "D"), protocolVersion: "0.2" };
    const entry = { agent: "*", company: "*", scenario: "*", blame: null, issue };
    expect(knownFailure(target, [entry])).toBeUndefined();
    expect(knownFailure(target, [{ ...entry, protocolVersion: "0.2" }])).toBeDefined();
  });

  it("prefer the most specific entry, then the first", () => {
    const broad = { agent: "pi-poppy", company: "*", scenario: "*", blame: null, issue, reason: "broad" };
    const exact = { agent: "pi-poppy", company: "pda-mock-strict", scenario: "SE", blame: null, issue, reason: "exact" };
    const later = { agent: "pi-poppy", company: "*", scenario: "SE", blame: null, issue, reason: "later" };
    const known = [broad, later, exact];
    expect(knownFailure(failed("pi-poppy", "pda-mock-strict", "SE"), known)).toBe(exact);
    expect(knownFailure(failed("pi-poppy", "pi-poppy", "SE"), known)).toBe(later);
    expect(knownFailure(failed("pi-poppy", "pi-poppy", "O"), known)).toBe(broad);
    const first = { ...later, reason: "first" };
    expect(knownFailure(failed("pi-poppy", "x", "SE"), [first, later])).toBe(first);
  });

  it("name each failed cell's code: a refusal's Poppy error, an expectation's path, a harness error", () => {
    expect(failureCode({ outcome: "fail", steps: [step("poppy_error invalid_grant: POST https://x/oauth/token")] })).toBe("invalid_grant");
    expect(failureCode({ outcome: "fail", steps: [step("poppy_error invalid_scope")] })).toBe("invalid_scope");
    expect(failureCode({ outcome: "fail", steps: [step('outcome.poppy_error: expected "access_denied", got "invalid_scope"', "expect")] })).toBe("expect outcome.poppy_error");
    expect(failureCode({ outcome: "fail", steps: [step("500 internal: boom")] })).toBe("500 internal");
    // An optional step that was unsupported isn't the failure.
    expect(failureCode({ outcome: "fail", steps: [step("unsupported: no MCP"), step("poppy_error invalid_client")] })).toBe("invalid_client");
    expect(failureCode({ outcome: "fail", steps: [] })).toBeNull();
    expect(failureCode({ outcome: "error", steps: [] })).toBe("error");
  });

  it("count a failed cell as known only when its blame, every error check and its step error are the entry's", () => {
    const entry = { agent: "pi-poppy", company: "*", scenario: "N", blame: "agent" as const, checks: ["session-assertion.jti-reused"], errors: ["invalid_grant"], issue };
    const at = (blame: Cell["blame"], checks: Check[], steps: StepRecord[] = []): Cell => ({ ...cell("pi-poppy", "pda-mock", "fail", checks, "N"), blame, steps });
    // The failure it describes, with or without the refused step, and with warnings beside it.
    expect(knownMatches(entry, at("agent", [check("session-assertion.jti-reused")]))).toBe(true);
    expect(knownMatches(entry, at("agent", [check("session-assertion.jti-reused"), check("client-assertion.typ", "warning")], [step("poppy_error invalid_grant: x")]))).toBe(true);
    // The same cell failing on a different check, or on another one as well: a different regression.
    expect(knownMatches(entry, at("agent", [check("dpop.ath")]))).toBe(false);
    expect(knownMatches(entry, at("agent", [check("session-assertion.jti-reused"), check("dpop.ath")]))).toBe(false);
    // Blamed on another side, or failing at a step with another error.
    expect(knownMatches(entry, at("company", [check("session-assertion.jti-reused")]))).toBe(false);
    expect(knownMatches(entry, at("agent", [check("session-assertion.jti-reused")], [step("poppy_error invalid_dpop_proof")]))).toBe(false);
    // An entry that names no checks only matches a cell that has none.
    const stepOnly = { ...entry, checks: undefined };
    expect(knownMatches(stepOnly, at("agent", [], [step("poppy_error invalid_grant")]))).toBe(true);
    expect(knownMatches(stepOnly, at("agent", [check("session-assertion.jti-reused")], [step("poppy_error invalid_grant")]))).toBe(false);
  });

  it("make the same cell with a different failure unexpected, and say which entry it missed", () => {
    const entry = { agent: "a", company: "c", scenario: "SD", blame: "agent" as const, checks: ["x"], issue, reason: "known" };
    const same = cell("a", "c", "fail", [error("agent")]);
    const different = cell("a", "c", "fail", [{ ...error("agent"), id: "y" }]);
    attributeAll([same, different], { ...none, known: [entry] });
    expect(same.known?.reason).toBe("known");
    expect(different.known).toBeUndefined();
    expect(unexpected([same, different])).toEqual([different]);
    expect(different.reason).toContain(`not the known failure ${issue}: it expects blame agent, checks [x], errors []; this cell has blame agent, checks [y], error none`);
    // The entry still matched a cell, so it isn't stale; once only the different failure is left, it is.
    expect(staleKnown([same, different], [entry])).toEqual([]);
    expect(staleKnown([different], [entry])).toEqual([entry]);
  });

  it("are attached to failed cells through wildcards, and unmatched ones are found", () => {
    const cells = [cell("pi-poppy", "a", "fail", [], "SE"), cell("pi-poppy", "b", "fail", [], "SE"), cell("pi-poppy", "c", "pass", [], "SE"), cell("pda", "a", "fail", [], "SE")];
    const known = [
      { agent: "pi-poppy", company: "*", scenario: "SE", blame: null, issue, reason: "renewal" },
      { agent: "*", company: "*", scenario: "O", blame: null, issue, reason: "fixed" }
    ];
    attributeAll(cells, { ...none, known });
    expect(cells.map((c) => c.known?.reason ?? null)).toEqual(["renewal", "renewal", null, null]);
    expect(unexpected(cells).map((c) => `${c.agent}×${c.company}`)).toEqual(["pda×a"]);
    // O never ran here: the "fixed" entry can't be judged.
    expect(staleKnown(cells, known)).toEqual([]);
    cells.push(cell("pi-poppy", "a", "pass", [], "O"));
    expect(staleKnown(cells, known)).toEqual([known[1]]);
  });

  it("are stale when the cells they name ran and none failed", () => {
    const exact = { agent: "a", company: "c", scenario: "SD", blame: null, issue, reason: "exact" };
    expect(staleKnown([cell("a", "c", "pass")], [exact])).toEqual([exact]);
    expect(staleKnown([cell("a", "c", "fail")], [exact])).toEqual([]);
    // An errored cell matches an entry that expects the harness's error, and isn't the unattributed failure.
    expect(staleKnown([{ ...cell("a", "c", "error"), blame: "harness" }], [{ ...exact, blame: "harness", errors: ["error"] }])).toEqual([]);
    expect(staleKnown([{ ...cell("a", "c", "error"), blame: "harness" }], [exact])).toEqual([exact]);
    // A cell now unsupported didn't fail either.
    expect(staleKnown([cell("a", "c", "unsupported")], [exact])).toEqual([exact]);
    // A pair the run didn't run is never judged (--agents pda --companies pda-mock).
    expect(staleKnown([cell("pda", "pda-mock", "pass")], [exact])).toEqual([]);
  });

  it("judge a wildcard entry over every failed cell it covers, even where a more specific entry is attached", () => {
    const broad = { agent: "a", company: "*", scenario: "*", blame: null, issue, reason: "broad" };
    const exact = { agent: "a", company: "c", scenario: "SD", blame: null, issue, reason: "exact" };
    const cells = [cell("a", "c", "fail"), cell("a", "d", "pass")];
    attributeAll(cells, { ...none, known: [broad, exact] });
    expect(cells[0]!.known?.reason).toBe("exact");
    // The broad entry still covers a failed cell, so it isn't stale.
    expect(staleKnown(cells, [broad, exact])).toEqual([]);
    // Once that cell passes, both are.
    expect(staleKnown([cell("a", "c", "pass"), cell("a", "d", "pass")], [broad, exact])).toEqual([broad, exact]);
  });

  it("don't judge a wildcard over a dimension the run didn't cover whole", () => {
    // adonis-agora × * × SV fails at Companies reading S1 endpoint; a run against pda-mock alone passes it.
    const sv = { agent: "adonis-agora", company: "*", scenario: "SV", blame: null, issue, reason: "S1" };
    const cells = [cell("adonis-agora", "pda-mock", "pass", [], "SV")];
    expect(staleKnown(cells, [sv], { agent: false, company: false, scenario: true })).toEqual([]);
    expect(staleKnown(cells, [sv], { agent: false, company: true, scenario: true })).toEqual([sv]);
    const pair = { agent: "poppy-demo", company: "datalayer-ts", scenario: "*", blame: null, issue, reason: "scopes" };
    const d = [cell("poppy-demo", "datalayer-ts", "pass", [], "D")];
    expect(staleKnown(d, [pair], { agent: true, company: true, scenario: false })).toEqual([]);
  });

  it("never match a flaky cell, which passes and doesn't fail the run", () => {
    const entry = { agent: "a", company: "c", scenario: "SD", blame: null, issue, reason: "exact" };
    const flaky: Cell = { ...cell("a", "c", "pass"), flaky: true, attempts: [{ outcome: "fail", reason: "timeout", har: "SD/a__c.har" }, { outcome: "pass", har: "SD/a__c.attempt2.har" }] };
    attributeAll([flaky], { ...none, known: [entry] });
    expect(flaky.known).toBeUndefined();
    expect(flaky).toMatchObject({ blame: null, rule: null });
    expect(unexpected([flaky])).toEqual([]);
    expect(staleKnown([flaky], [entry])).toEqual([entry]);
  });
});

describe("reading compatibility", () => {
  it("lets an accepting side's either or any accept everything", () => {
    expect(compatible("S1", "token-endpoint", "either")).toBe(true);
    expect(compatible("S1", "token-endpoint", "issuer")).toBe(false);
    expect(compatible("S3", "either", "append")).toBe(true);
    expect(compatible("S1", undefined, "issuer")).toBe(true);
  });

  it("tells S1's token endpoint everywhere from the endpoint each assertion goes to", () => {
    expect(compatible("S1", "endpoint", "endpoint")).toBe(true);
    expect(compatible("S1", "token-endpoint", "endpoint")).toBe(false);
    expect(compatible("S1", "endpoint", "token-endpoint")).toBe(false);
    expect(compatible("S1", "endpoint", "either")).toBe(true);
  });

  it("checks a declared S1 at every endpoint a client assertion goes to", () => {
    const metadata = {
      issuer: "https://auth.x.company.interop.test",
      token_endpoint: "https://auth.x.company.interop.test/token",
      device_authorization_endpoint: "https://auth.x.company.interop.test/device",
      revocation_endpoint: "https://auth.x.company.interop.test/revoke"
    };
    const assertion = (aud: string) => jwt({ alg: "ES256", typ: "JWT", kid: "k" }, { iss: "c", sub: "c", aud, iat: NOW, exp: NOW + 60, jti: "j" });
    const trace = recording(
      { url: "https://auth.x.company.interop.test/.well-known/oauth-authorization-server", response: metadata },
      { url: metadata.token_endpoint, form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", client_assertion: assertion(metadata.token_endpoint) } },
      { url: metadata.device_authorization_endpoint, form: { scope: "poppy:read", client_assertion: assertion(metadata.device_authorization_endpoint) } },
      { url: metadata.revocation_endpoint, form: { token: "t", client_assertion: assertion(metadata.token_endpoint) } }
    );
    const s1 = (reading: string) => readingChecks(trace, { S1: reading }).filter((check) => check.id === "reading.S1").map((check) => check.exchange);
    // "endpoint": the revocation request named the token endpoint.
    expect(s1("endpoint")).toEqual([3]);
    // "token-endpoint": the device request named itself.
    expect(s1("token-endpoint")).toEqual([2]);
    expect(s1("issuer")).toEqual([1, 2, 3]);
    expect(s1("either")).toEqual([]);
  });

  it("finds refusals a Company's declared S1 or S2 reading explains", () => {
    const metadata = {
      issuer: "https://x.company.interop.test/poppy",
      token_endpoint: "https://x.company.interop.test/poppy/token",
      device_authorization_endpoint: "https://x.company.interop.test/poppy/device",
      revocation_endpoint: "https://x.company.interop.test/poppy/revoke"
    };
    const assertion = (aud: string, typ?: string) =>
      jwt({ alg: "ES256", kid: "k", ...(typ ? { typ } : {}) }, { iss: "c", sub: "c", aud, iat: NOW, exp: NOW + 60, jti: "j" });
    const refused = { status: 401, response: { error: "invalid_client" } };
    const trace = recording(
      // Appended to the issuer's path (S3 append).
      { url: "https://x.company.interop.test/poppy/.well-known/oauth-authorization-server", response: metadata },
      // Accepted at the token endpoint without typ: no refusal to explain.
      { url: metadata.token_endpoint, form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", client_assertion: assertion(metadata.token_endpoint) } },
      // The device endpoint refuses an aud naming the token endpoint.
      { url: metadata.device_authorization_endpoint, form: { scope: "poppy:read", client_assertion: assertion(metadata.token_endpoint, "JWT") }, ...refused },
      // The token endpoint refuses a Session assertion without typ.
      {
        url: metadata.token_endpoint,
        form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertion(metadata.token_endpoint), client_assertion: assertion(metadata.token_endpoint, "JWT") },
        status: 400,
        response: { error: "invalid_grant" }
      },
      // Another error isn't an assertion refusal.
      { url: metadata.revocation_endpoint, form: { token: "t", client_assertion: assertion(metadata.token_endpoint) }, status: 400, response: { error: "invalid_request" } }
    );
    const ids = (readings: Record<string, string>) => refusedReadingChecks(trace, readings).map((check) => `${check.id}@${check.exchange}`);
    expect(ids({ S1: "endpoint", S2: "jwt-60s" })).toEqual(["reading.S1.refused@2", "reading.S2.refused@3"]);
    expect(ids({ S1: "token-endpoint", S2: "any" })).toEqual([]);
    expect(ids({ S1: "either" })).toEqual([]);
    expect(refusedReadingChecks(trace, { S1: "endpoint" }).every((check) => check.severity === "warning")).toBe(true);
  });

  it("rule 3, before rule 2: a refusal the Company's declared reading explains, between incompatible readings", () => {
    const s1: Check = { id: "reading.S1.refused", side: "agent", severity: "warning", exchange: 2, detail: "", source: "trace" };
    // adonis-agora's Company, under the same name, reads S1 either: it mustn't stand in for the agent.
    const readings = {
      agent: { "adonis-agora": { S1: "token-endpoint" }, pda: { S1: "endpoint" } },
      company: { "adonis-agora": { S1: "either" }, poppyseed: { S1: "endpoint" }, "pda-mock": { S1: "either" } }
    };
    const target = cell("adonis-agora", "poppyseed", "fail", [s1], "SV");
    // The grid would blame the agent: it fails SV everywhere, and poppyseed passes it with pda.
    const grid = [target, cell("adonis-agora", "pda-mock", "fail", [], "SV"), cell("pda", "poppyseed", "pass", [], "SV")];
    expect(attribute(target, grid, { readings, scenarios })).toEqual({ blame: "spec", rule: "reading", detail: "S1: adonis-agora reads token-endpoint, poppyseed reads endpoint" });
    // Compatible readings (the agent broke its own word): the refusal decides nothing.
    expect(attribute(target, grid, { readings: { ...readings, agent: { ...readings.agent, "adonis-agora": { S1: "endpoint" } } }, scenarios })).toMatchObject({ blame: "agent", rule: "grid" });
    // A one-sided error still decides by rule 1.
    const both = cell("adonis-agora", "poppyseed", "fail", [s1, error("agent")], "SV");
    expect(attribute(both, [both], { readings, scenarios })).toEqual({ blame: "agent", rule: "violation" });
  });

  it("knows which way S2 and S23 break", () => {
    expect(compatible("S2", "jwt-60s", "any")).toBe(true);
    expect(compatible("S2", "any", "jwt-60s")).toBe(false);
    expect(compatible("S23", "per-origin", "per-company")).toBe(true);
    expect(compatible("S23", "per-company", "per-origin")).toBe(false);
  });

  it("S2 lenient-300s (the reference pda-mock): accepts jwt-60s and itself, not an agent that promises nothing", () => {
    expect(QUESTIONS.S2.values).toContain("lenient-300s");
    expect(compatible("S2", "jwt-60s", "lenient-300s")).toBe(true);
    expect(compatible("S2", "lenient-300s", "lenient-300s")).toBe(true);
    expect(compatible("S2", "any", "lenient-300s")).toBe(false);
    // A strict Company accepts only jwt-60s; an `any` Company everything.
    expect(compatible("S2", "lenient-300s", "jwt-60s")).toBe(false);
    expect(compatible("S2", "lenient-300s", "any")).toBe(true);

    const token = "https://auth.x.company.interop.test/token";
    const assertion = (lifetime: number) => jwt({ alg: "ES256", kid: "k" }, { iss: "c", sub: "c", aud: token, iat: NOW, exp: NOW + lifetime, jti: `j${lifetime}` });
    const grant = (lifetime: number) => ({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", client_assertion: assertion(lifetime) });
    const trace = recording(
      { url: "https://auth.x.company.interop.test/.well-known/oauth-authorization-server", response: { issuer: "https://auth.x.company.interop.test", token_endpoint: token } },
      // 120 s and no typ: lenient-300s accepts it, jwt-60s doesn't.
      { url: token, form: grant(120), status: 401, response: { error: "invalid_client" } },
      // 301 s: refused by both.
      { url: token, form: grant(301), status: 401, response: { error: "invalid_client" } }
    );
    const refusedAt = (s2: string) => refusedReadingChecks(trace, { S2: s2 }).map((check) => `${check.id}@${check.exchange}`);
    expect(refusedAt("lenient-300s")).toEqual(["reading.S2.refused@2"]);
    expect(refusedAt("jwt-60s")).toEqual(["reading.S2.refused@1", "reading.S2.refused@2"]);
    expect(refusedAt("any")).toEqual([]);
    // An agent that declares lenient-300s is held to 300 s, not to typ or 60 s.
    const sentBeyond = (s2: string) => readingChecks(trace, { S2: s2 }).filter((check) => check.id === "reading.S2").map((check) => check.exchange);
    expect(sentBeyond("lenient-300s")).toEqual([2]);
    expect(sentBeyond("jwt-60s")).toEqual([1, 2]);

    // The lenient mock recording a 301 s assertion (our reading, so a warning) is the open question with an `any` agent, the agent's own departure from its declared jwt-60s otherwise.
    const lifetime = companyRecorded({ id: "client-assertion.lifetime", basis: "Reading", detail: "" }, "pda-mock", false);
    const target = cell("a", "pda-mock", "fail", [lifetime], "SD");
    const declared = (agent: string) => ({ agent: { a: { S2: agent } }, company: { "pda-mock": { S2: "lenient-300s" } } });
    expect(attribute(target, [target], { readings: declared("any"), scenarios })).toMatchObject({ blame: "spec", rule: "reading" });
    expect(lifetime.severity).toBe("warning");
    expect(attribute(target, [target], { readings: declared("jwt-60s"), scenarios })).toMatchObject({ blame: "agent", rule: "warning" });
  });

  it("S2 lenient-120s (print-with-poppy, Datalayer 0.10.0): between jwt-60s and lenient-300s", () => {
    expect(QUESTIONS.S2.values).toEqual(["jwt-60s", "lenient-120s", "lenient-300s", "any"]);
    // As a Company: accepts jwt-60s and itself, not the wider readings.
    expect(compatible("S2", "jwt-60s", "lenient-120s")).toBe(true);
    expect(compatible("S2", "lenient-120s", "lenient-120s")).toBe(true);
    expect(compatible("S2", "lenient-300s", "lenient-120s")).toBe(false);
    expect(compatible("S2", "any", "lenient-120s")).toBe(false);
    // As an agent: accepted by lenient-300s and any, not by jwt-60s.
    expect(compatible("S2", "lenient-120s", "lenient-300s")).toBe(true);
    expect(compatible("S2", "lenient-120s", "any")).toBe(true);
    expect(compatible("S2", "lenient-120s", "jwt-60s")).toBe(false);

    const token = "https://auth.x.company.interop.test/token";
    const assertion = (lifetime: number) => jwt({ alg: "ES256", kid: "k" }, { iss: "c", sub: "c", aud: token, iat: NOW, exp: NOW + lifetime, jti: `j${lifetime}` });
    const grant = (lifetime: number) => ({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", client_assertion: assertion(lifetime) });
    const trace = recording(
      { url: "https://auth.x.company.interop.test/.well-known/oauth-authorization-server", response: { issuer: "https://auth.x.company.interop.test", token_endpoint: token } },
      // 120 s and no typ: lenient-120s accepts it.
      { url: token, form: grant(120), status: 401, response: { error: "invalid_client" } },
      // 121 s: lenient-120s refuses it, lenient-300s doesn't.
      { url: token, form: grant(121), status: 401, response: { error: "invalid_client" } },
      // 301 s: refused by both.
      { url: token, form: grant(301), status: 401, response: { error: "invalid_client" } }
    );
    const refusedAt = (s2: string) => refusedReadingChecks(trace, { S2: s2 }).map((check) => check.exchange);
    expect(refusedAt("lenient-120s")).toEqual([2, 3]);
    expect(refusedAt("lenient-300s")).toEqual([3]);
    const sentBeyond = (s2: string) => readingChecks(trace, { S2: s2 }).filter((check) => check.id === "reading.S2").map((check) => check.exchange);
    expect(sentBeyond("lenient-120s")).toEqual([2, 3]);
  });

  it("pda-mock declares the S2 reading the mock enforces: lenient-300s, at the mock's 300 s, or jwt-60s when strict", () => {
    const root = path.join(import.meta.dirname, "../..");
    const adapter = readFileSync(path.join(root, "interop/impls/pda-mock/adapter.ts"), "utf8");
    const core = readFileSync(path.join(root, "test/mock-company/core.ts"), "utf8");
    expect(adapter).toMatch(/S2: PROFILE === "strict" \? "jwt-60s" : "lenient-300s"/);
    expect(core).toMatch(/const MAX_ASSERTION_LIFETIME = 300;/);
    expect(core).toMatch(/const STRICT_ASSERTION_LIFETIME = 60;/);
  });
});
