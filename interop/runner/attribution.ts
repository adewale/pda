/**
 * Who a failed cell is blamed on (spec section 9), by the first rule that
 * decides it, and known failures. Pure functions over the whole grid.
 *
 * 1. violation: error checks on one side only.
 * 2. grid: the agent passes the scenario against the reference Company but
 *    this Company fails it with every agent that ran it (blame the Company);
 *    or this agent fails it with every Company it ran against while this
 *    Company passes it with another agent (blame the agent).
 * 3. reading: the two sides declare incompatible readings of a question the
 *    scenario depends on (blame the spec).
 * 4. unattributed.
 */
import { compatible } from "./readings.ts";
import type { Blame, Cell, KnownFailure, Rule, Scenario } from "./types.ts";

export const REFERENCE_COMPANY = "dpa-mock";

export type Readings = Readonly<Record<string, Readonly<Record<string, string>>>>;

export type Verdict = { readonly blame: Blame; readonly rule: Rule; readonly detail?: string };

const ran = (cell: Cell) => cell.outcome === "pass" || cell.outcome === "fail";

export function attribute(
  cell: Cell,
  grid: readonly Cell[],
  context: { readonly readings: Readings; readonly scenarios: ReadonlyMap<string, Scenario>; readonly reference?: string }
): Verdict {
  if (cell.outcome === "error") return { blame: "harness", rule: null };
  if (cell.outcome !== "fail") return { blame: null, rule: null };
  const reference = context.reference ?? REFERENCE_COMPANY;

  // 1. violation
  const sides = new Set(cell.checks.filter((check) => check.severity === "error").map((check) => check.side));
  if (sides.size === 1) {
    const [side] = sides;
    return { blame: side!, rule: "violation" };
  }

  // 2. grid
  const same = grid.filter((other) => other.scenario === cell.scenario && ran(other));
  const at = (agent: string, company: string) => same.find((other) => other.agent === agent && other.company === company);
  if (cell.company !== reference && at(cell.agent, reference)?.outcome === "pass") {
    const withCompany = same.filter((other) => other.company === cell.company);
    if (withCompany.every((other) => other.outcome === "fail")) {
      return { blame: "company", rule: "grid", detail: `${cell.agent} passes ${cell.scenario} against ${reference}; ${cell.company} fails it with every agent` };
    }
  }
  const withAgent = same.filter((other) => other.agent === cell.agent);
  const companyPassesElsewhere = same.some((other) => other.company === cell.company && other.agent !== cell.agent && other.outcome === "pass");
  if (withAgent.every((other) => other.outcome === "fail") && companyPassesElsewhere) {
    return { blame: "agent", rule: "grid", detail: `${cell.company} passes ${cell.scenario} with another agent; ${cell.agent} fails it with every Company` };
  }

  // 3. reading
  const scenario = context.scenarios.get(cell.scenario);
  for (const question of scenario?.readings ?? []) {
    const agent = context.readings[cell.agent]?.[question];
    const company = context.readings[cell.company]?.[question];
    if (!compatible(question, agent, company)) {
      return { blame: "spec", rule: "reading", detail: `${question}: ${cell.agent} reads ${agent}, ${cell.company} reads ${company}` };
    }
  }

  // 4. unattributed
  return { blame: null, rule: "unattributed" };
}

/** Attribute every cell in place, and attach known failures. */
export function attributeAll(
  cells: Cell[],
  context: { readonly readings: Readings; readonly scenarios: ReadonlyMap<string, Scenario>; readonly known?: readonly KnownFailure[]; readonly reference?: string }
): void {
  for (const cell of cells) {
    const verdict = attribute(cell, cells, context);
    cell.blame = verdict.blame;
    cell.rule = verdict.rule;
    if (verdict.detail) cell.reason = cell.reason ? `${cell.reason} [${verdict.detail}]` : verdict.detail;
    const known = (context.known ?? []).find((entry) => entry.agent === cell.agent && entry.company === cell.company && entry.scenario === cell.scenario);
    if (known && (cell.outcome === "fail" || cell.outcome === "error")) {
      cell.known = { issue: known.issue, ...(known.reason ? { reason: known.reason } : {}) };
    }
  }
}

/** Cells that fail the run: failed or errored, and not a known failure. */
export function unexpected(cells: readonly Cell[]): Cell[] {
  return cells.filter((cell) => (cell.outcome === "fail" || cell.outcome === "error") && !cell.known);
}
