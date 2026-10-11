import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attribute, attributeAll, knownFailure, staleKnown, unexpected } from "../runner/attribution.ts";
import { compatible, QUESTIONS, readingChecks, refusedReadingChecks } from "../runner/readings.ts";
import { jwt, NOW, recording } from "./helpers.ts";
import type { Cell, Check, Outcome, Scenario } from "../runner/types.ts";

const error = (side: "agent" | "company"): Check => ({ id: "x", side, severity: "error", exchange: null, detail: "", source: "trace" });
/** The trace's evidence that a Company refused what its reading of `question` doesn't accept. */
const refusal = (question: string): Check => ({ id: `reading.${question}.refused`, side: "agent", severity: "warning", exchange: 1, detail: "", source: "trace" });

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
    const grid = [target, cell("a", "dpa-mock", "pass"), cell("b", "c", "fail"), cell("b", "dpa-mock", "pass")];
    expect(attribute(target, grid, none)).toMatchObject({ blame: "company", rule: "grid" });
    // Another agent passes at c, and a passes elsewhere: the grid decides nothing.
    const mixed = [target, cell("a", "dpa-mock", "pass"), cell("b", "c", "pass")];
    expect(attribute(target, mixed, none)).toEqual({ blame: null, rule: "unattributed" });
  });

  it("rule 2: an agent that fails everywhere, at a Company another agent passes, blames the agent", () => {
    const target = cell("a", "dpa-mock", "fail");
    const grid = [target, cell("a", "c", "fail"), cell("b", "dpa-mock", "pass")];
    expect(attribute(target, grid, none)).toMatchObject({ blame: "agent", rule: "grid" });
    // Unsupported cells don't count either way.
    expect(attribute(target, [target, cell("b", "dpa-mock", "unsupported")], none).rule).toBe("unattributed");
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
    // poppy-demo reads S3 append, dpa-mock insertion; D fails on poppy-demo's issuer check, with no S3 in the trace.
    const d = new Map<string, Scenario>([["D", { id: "D", title: "Discovery", readings: ["S3"], steps: [] }]]);
    const readings = { agent: { "poppy-demo": { S3: "append" }, dpa: { S3: "insertion" } }, company: { "dpa-mock": { S3: "insertion" }, poppyseed: { S3: "either" } } };
    const target = cell("poppy-demo", "dpa-mock", "fail", [], "D");
    expect(attribute(target, [target], { readings, scenarios: d })).toEqual({ blame: null, rule: "unattributed" });
    // So the grid gets its say: poppy-demo fails D everywhere, and dpa passes it at dpa-mock.
    const grid = [target, cell("poppy-demo", "poppyseed", "fail", [], "D"), cell("dpa", "dpa-mock", "pass", [], "D")];
    expect(attribute(target, grid, { readings, scenarios: d })).toMatchObject({ blame: "agent", rule: "grid" });
  });

  it("rule 3 after rule 2: a Company-recorded error of the question is evidence, beside errors on both sides", () => {
    const typ: Check = { id: "session-assertion.typ", side: "agent", severity: "error", exchange: null, detail: "typ", source: "company:dpa-mock-strict" };
    const readings = { agent: { a: { S2: "any" } }, company: { "dpa-mock-strict": { S2: "jwt-60s" } } };
    const target = cell("a", "dpa-mock-strict", "fail", [typ, error("agent"), error("company")], "C");
    expect(attribute(target, [target], { readings, scenarios })).toEqual({ blame: "spec", rule: "reading", detail: "S2: a reads any, dpa-mock-strict reads jwt-60s" });
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

  it("rule 3, before rule 1: a Company-recorded error that is exactly a declared reading difference", () => {
    // A strict Company refuses a typ-less Session assertion; the agent declared S2 any.
    const typ: Check = { id: "session-assertion.typ", side: "agent", severity: "error", exchange: null, detail: "typ", source: "company:dpa-mock-strict" };
    const readings = { agent: { "pi-poppy": { S2: "any" } }, company: { "dpa-mock-strict": { S2: "jwt-60s" }, "dpa-mock": { S2: "any" } } };
    const strict = cell("pi-poppy", "dpa-mock-strict", "fail", [typ], "C");
    expect(attribute(strict, [strict], { readings, scenarios })).toEqual({ blame: "spec", rule: "reading", detail: "S2: pi-poppy reads any, dpa-mock-strict reads jwt-60s" });
    // An agent that declared jwt-60s and sent no typ broke its own word: a violation.
    expect(attribute(strict, [strict], { readings: { ...readings, agent: { "pi-poppy": { S2: "jwt-60s" } } }, scenarios })).toEqual({ blame: "agent", rule: "violation" });
    // Another error beside it is still a violation, by the side that made it.
    const both = cell("pi-poppy", "dpa-mock-strict", "fail", [typ, error("agent")], "C");
    expect(attribute(both, [both], { readings, scenarios })).toEqual({ blame: "agent", rule: "violation" });
    // The runner's own trace check of the same id isn't a Company's refusal.
    const traced = cell("pi-poppy", "dpa-mock-strict", "fail", [{ ...typ, source: "trace" }], "C");
    expect(attribute(traced, [traced], { readings, scenarios })).toEqual({ blame: "agent", rule: "violation" });
  });

  it("errors are the harness's, and passes and unsupported cells have no blame", () => {
    expect(attribute(cell("a", "c", "error"), [], none)).toEqual({ blame: "harness", rule: null });
    expect(attribute(cell("a", "c", "pass"), [], none)).toEqual({ blame: null, rule: null });
    expect(attribute(cell("a", "c", "unsupported"), [], none)).toEqual({ blame: null, rule: null });
  });

  it("attaches known failures, which no longer fail the run", () => {
    const cells = [cell("a", "c", "fail"), cell("a", "d", "fail")];
    attributeAll(cells, { ...none, known: [{ agent: "a", company: "c", scenario: "SD", issue: "https://example.com/1", reason: "S2" }] });
    expect(cells[0]!.known).toEqual({ issue: "https://example.com/1", reason: "S2" });
    expect(unexpected(cells).map((c) => c.company)).toEqual(["d"]);
  });
});

describe("known failures", () => {
  const issue = "https://example.com/1";
  it("match a field by name or by * for any", () => {
    const known = [{ agent: "pi-poppy", company: "*", scenario: "SE", issue }];
    expect(knownFailure({ agent: "pi-poppy", company: "datalayer-ts", scenario: "SE" }, known)).toBe(known[0]);
    expect(knownFailure({ agent: "pi-poppy", company: "datalayer-ts", scenario: "O" }, known)).toBeUndefined();
    expect(knownFailure({ agent: "dpa", company: "datalayer-ts", scenario: "SE" }, known)).toBeUndefined();
    const any = [{ agent: "*", company: "*", scenario: "*", issue }];
    expect(knownFailure({ agent: "a", company: "c", scenario: "D" }, any)).toBe(any[0]);
  });

  it("prefer the most specific entry, then the first", () => {
    const broad = { agent: "pi-poppy", company: "*", scenario: "*", issue, reason: "broad" };
    const exact = { agent: "pi-poppy", company: "dpa-mock-strict", scenario: "SE", issue, reason: "exact" };
    const later = { agent: "pi-poppy", company: "*", scenario: "SE", issue, reason: "later" };
    const known = [broad, later, exact];
    expect(knownFailure({ agent: "pi-poppy", company: "dpa-mock-strict", scenario: "SE" }, known)).toBe(exact);
    expect(knownFailure({ agent: "pi-poppy", company: "pi-poppy", scenario: "SE" }, known)).toBe(later);
    expect(knownFailure({ agent: "pi-poppy", company: "pi-poppy", scenario: "O" }, known)).toBe(broad);
    const first = { ...later, reason: "first" };
    expect(knownFailure({ agent: "pi-poppy", company: "x", scenario: "SE" }, [first, later])).toBe(first);
  });

  it("are attached to failed cells through wildcards, and unmatched ones are found", () => {
    const cells = [cell("pi-poppy", "a", "fail", [], "SE"), cell("pi-poppy", "b", "error", [], "SE"), cell("pi-poppy", "c", "pass", [], "SE"), cell("dpa", "a", "fail", [], "SE")];
    const known = [
      { agent: "pi-poppy", company: "*", scenario: "SE", issue, reason: "renewal" },
      { agent: "*", company: "*", scenario: "O", issue, reason: "fixed" }
    ];
    attributeAll(cells, { ...none, known });
    expect(cells.map((c) => c.known?.reason ?? null)).toEqual(["renewal", "renewal", null, null]);
    expect(unexpected(cells).map((c) => `${c.agent}×${c.company}`)).toEqual(["dpa×a"]);
    // O never ran here: the "fixed" entry can't be judged.
    expect(staleKnown(cells, known)).toEqual([]);
    cells.push(cell("pi-poppy", "a", "pass", [], "O"));
    expect(staleKnown(cells, known)).toEqual([known[1]]);
  });

  it("are stale when the cells they name ran and none failed", () => {
    const exact = { agent: "a", company: "c", scenario: "SD", issue, reason: "exact" };
    expect(staleKnown([cell("a", "c", "pass")], [exact])).toEqual([exact]);
    expect(staleKnown([cell("a", "c", "fail")], [exact])).toEqual([]);
    expect(staleKnown([cell("a", "c", "error")], [exact])).toEqual([]);
    // A cell now unsupported didn't fail either.
    expect(staleKnown([cell("a", "c", "unsupported")], [exact])).toEqual([exact]);
    // A pair the run didn't run is never judged (--agents dpa --companies dpa-mock).
    expect(staleKnown([cell("dpa", "dpa-mock", "pass")], [exact])).toEqual([]);
  });

  it("judge a wildcard entry over every failed cell it covers, even where a more specific entry is attached", () => {
    const broad = { agent: "a", company: "*", scenario: "*", issue, reason: "broad" };
    const exact = { agent: "a", company: "c", scenario: "SD", issue, reason: "exact" };
    const cells = [cell("a", "c", "fail"), cell("a", "d", "pass")];
    attributeAll(cells, { ...none, known: [broad, exact] });
    expect(cells[0]!.known?.reason).toBe("exact");
    // The broad entry still covers a failed cell, so it isn't stale.
    expect(staleKnown(cells, [broad, exact])).toEqual([]);
    // Once that cell passes, both are.
    expect(staleKnown([cell("a", "c", "pass"), cell("a", "d", "pass")], [broad, exact])).toEqual([broad, exact]);
  });

  it("don't judge a wildcard over a dimension the run didn't cover whole", () => {
    // adonis-agora × * × SV fails at Companies reading S1 endpoint; a run against dpa-mock alone passes it.
    const sv = { agent: "adonis-agora", company: "*", scenario: "SV", issue, reason: "S1" };
    const cells = [cell("adonis-agora", "dpa-mock", "pass", [], "SV")];
    expect(staleKnown(cells, [sv], { agent: false, company: false, scenario: true })).toEqual([]);
    expect(staleKnown(cells, [sv], { agent: false, company: true, scenario: true })).toEqual([sv]);
    const pair = { agent: "poppy-demo", company: "datalayer-ts", scenario: "*", issue, reason: "scopes" };
    const d = [cell("poppy-demo", "datalayer-ts", "pass", [], "D")];
    expect(staleKnown(d, [pair], { agent: true, company: true, scenario: false })).toEqual([]);
  });

  it("never match a flaky cell, which passes and doesn't fail the run", () => {
    const entry = { agent: "a", company: "c", scenario: "SD", issue, reason: "exact" };
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
      agent: { "adonis-agora": { S1: "token-endpoint" }, dpa: { S1: "endpoint" } },
      company: { "adonis-agora": { S1: "either" }, poppyseed: { S1: "endpoint" }, "dpa-mock": { S1: "either" } }
    };
    const target = cell("adonis-agora", "poppyseed", "fail", [s1], "SV");
    // The grid would blame the agent: it fails SV everywhere, and poppyseed passes it with dpa.
    const grid = [target, cell("adonis-agora", "dpa-mock", "fail", [], "SV"), cell("dpa", "poppyseed", "pass", [], "SV")];
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

  it("S2 lenient-300s (the reference dpa-mock): accepts jwt-60s and itself, not an agent that promises nothing", () => {
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

    // The lenient mock recording a 301 s assertion is the open question with an `any` agent, the agent's own fault with a jwt-60s one.
    const lifetime: Check = { id: "client-assertion.lifetime", side: "agent", severity: "error", exchange: 2, detail: "", source: "company:dpa-mock" };
    const target = cell("a", "dpa-mock", "fail", [lifetime], "SD");
    const declared = (agent: string) => ({ agent: { a: { S2: agent } }, company: { "dpa-mock": { S2: "lenient-300s" } } });
    expect(attribute(target, [target], { readings: declared("any"), scenarios })).toMatchObject({ blame: "spec", rule: "reading" });
    expect(attribute(target, [target], { readings: declared("jwt-60s"), scenarios })).toEqual({ blame: "agent", rule: "violation" });
  });

  it("dpa-mock declares the S2 reading the mock enforces: lenient-300s, at the mock's 300 s, or jwt-60s when strict", () => {
    const root = path.join(import.meta.dirname, "../..");
    const adapter = readFileSync(path.join(root, "interop/impls/dpa-mock/adapter.ts"), "utf8");
    const core = readFileSync(path.join(root, "test/mock-company/core.ts"), "utf8");
    expect(adapter).toMatch(/S2: PROFILE === "strict" \? "jwt-60s" : "lenient-300s"/);
    expect(core).toMatch(/const MAX_ASSERTION_LIFETIME = 300;/);
    expect(core).toMatch(/const STRICT_ASSERTION_LIFETIME = 60;/);
  });
});
