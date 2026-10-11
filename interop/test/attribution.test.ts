import { describe, expect, it } from "vitest";
import { attribute, attributeAll, unexpected } from "../runner/attribution.ts";
import { compatible } from "../runner/readings.ts";
import type { Cell, Check, Outcome, Scenario } from "../runner/types.ts";

const error = (side: "agent" | "company"): Check => ({ id: "x", side, severity: "error", exchange: null, detail: "", source: "trace" });

function cell(agent: string, company: string, outcome: Outcome, checks: Check[] = [], scenario = "SD"): Cell {
  return { agent, company, scenario, outcome, blame: null, rule: null, steps: [], checks, har: null };
}

const scenarios = new Map<string, Scenario>([["SD", { id: "SD", title: "Direct", readings: ["S1", "S2"], steps: [] }]]);
const none = { readings: {}, scenarios };

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

  it("rule 3: incompatible readings of a question the scenario depends on blame the spec", () => {
    const readings = { a: { S2: "any" }, c: { S2: "jwt-60s" } };
    expect(attribute(cell("a", "c", "fail"), [], { readings, scenarios })).toMatchObject({ blame: "spec", rule: "reading" });
    expect(attribute(cell("a", "c", "fail", [], "C"), [], { readings, scenarios }).rule).toBe("unattributed");
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

describe("reading compatibility", () => {
  it("lets an accepting side's either or any accept everything", () => {
    expect(compatible("S1", "token-endpoint", "either")).toBe(true);
    expect(compatible("S1", "token-endpoint", "issuer")).toBe(false);
    expect(compatible("S3", "either", "append")).toBe(true);
    expect(compatible("S1", undefined, "issuer")).toBe(true);
  });

  it("knows which way S2 and S23 break", () => {
    expect(compatible("S2", "jwt-60s", "any")).toBe(true);
    expect(compatible("S2", "any", "jwt-60s")).toBe(false);
    expect(compatible("S23", "per-origin", "per-company")).toBe(true);
    expect(compatible("S23", "per-company", "per-origin")).toBe(false);
  });
});
