/**
 * Who a failed cell is blamed on (spec section 9), by the first rule that
 * decides it, and known failures. Pure functions over the whole grid.
 *
 * 1. violation: error checks on one side only. An error that is exactly a
 *    declared reading difference (a check of a section 7 question, such as
 *    a strict Company's `session-assertion.typ`, between sides whose
 *    readings of it are incompatible) is not a violation: when every error
 *    is one, the cell goes to rule 3 at once. So does a cell with no
 *    one-sided errors whose trace shows a refusal the Company's declared
 *    reading explains (`reading.<id>.refused`: an assertion `aud` or `typ`
 *    its S1 or S2 reading doesn't accept), when the readings are incompatible.
 * 2. grid: the agent passes the scenario against the reference Company but
 *    this Company fails it with every agent that ran it (blame the Company);
 *    or this agent fails it with every Company it ran against while this
 *    Company passes it with another agent (blame the agent).
 * 3. reading: the two sides declare incompatible readings of a question the
 *    scenario depends on, or that an error check belongs to (blame the spec).
 * 4. unattributed.
 */
import { compatible, questionOf, REFUSED_READING } from "./readings.ts";
import type { Blame, Cell, Check, KnownFailure, Rule, Scenario } from "./types.ts";

export const REFERENCE_COMPANY = "dpa-mock";

/**
 * Each implementation's declared readings, by role, then name: a project with
 * both sides (adonis-agora, pi-poppy) registers one name per role, and its
 * agent and Company may read a question differently.
 */
export type Readings = Readonly<Record<"agent" | "company", Readonly<Record<string, Readonly<Record<string, string>>>>>>;

export type Verdict = { readonly blame: Blame; readonly rule: Rule; readonly detail?: string };

const ran = (cell: Cell) => cell.outcome === "pass" || cell.outcome === "fail";

export type AttributionContext = {
  readonly readings: Readings;
  readonly scenarios: ReadonlyMap<string, Scenario>;
  readonly reference?: string;
  /** Implementation names that misbehave on purpose (evil-agent, evil-company). */
  readonly adversarial?: ReadonlySet<string>;
};

/**
 * A cell is a security (adversarial) cell when a side is an adversarial
 * implementation, or its scenario names an `adversary` or a `faults` list.
 * Such cells go in the security grid, never in the interop pass rates, and
 * never stand in as grid references (spec §9, rule 2).
 */
export function isSecurityCell(cell: Pick<Cell, "agent" | "company" | "scenario">, context: AttributionContext): boolean {
  const adv = context.adversarial ?? new Set<string>();
  if (adv.has(cell.agent) || adv.has(cell.company)) return true;
  const scenario = context.scenarios.get(cell.scenario);
  return !!scenario?.adversary || !!scenario?.faults?.length;
}

export function attribute(cell: Cell, grid: readonly Cell[], context: AttributionContext): Verdict {
  if (cell.outcome === "error") return { blame: "harness", rule: null };
  if (cell.outcome !== "fail") return { blame: null, rule: null };
  const reference = context.reference ?? REFERENCE_COMPANY;

  // Rule 0, adversarial (applied first). In a cell with an adversarial side, that side's
  // violations are expected; the cell passes when the honest side refuses. A failure is the
  // honest side's, or the spec's when `permitted_by` names a draft gap.
  const adv = context.adversarial ?? new Set<string>();
  const agentAdversarial = adv.has(cell.agent);
  const companyAdversarial = adv.has(cell.company);
  if (agentAdversarial || companyAdversarial) {
    const scenario = context.scenarios.get(cell.scenario);
    if (scenario?.permitted_by) {
      return { blame: "spec", rule: "adversarial", detail: `permitted by the draft (${scenario.permitted_by})` };
    }
    const honest = agentAdversarial ? "company" : "agent";
    return { blame: honest, rule: "adversarial", detail: `${honest === "agent" ? cell.agent : cell.company} didn't refuse the attack` };
  }

  const readingOf = (question: string) => ({
    agent: context.readings.agent[cell.agent]?.[question],
    company: context.readings.company[cell.company]?.[question]
  });
  const reading = (question: string): Verdict => {
    const { agent, company } = readingOf(question);
    return { blame: "spec", rule: "reading", detail: `${question}: ${cell.agent} reads ${agent}, ${cell.company} reads ${company}` };
  };
  const errors = cell.checks.filter((check) => check.severity === "error");
  // A Company-recorded error the two sides' declared readings explain: a difference of reading,
  // not a violation. (The runner's own trace checks of a reading are warnings, or errors only
  // beyond what any reading allows, such as a lifetime over 300 s.)
  const explainedBy = (check: Check): string | null => {
    const question = check.source.startsWith("company:") ? questionOf(check.id) : undefined;
    if (!question) return null;
    const { agent, company } = readingOf(question);
    return agent && company && !compatible(question, agent, company) ? question : null;
  };
  const explained = errors.map(explainedBy);
  if (errors.length > 0 && explained.every((question) => question !== null)) return reading(explained[0]!);

  // 1. violation
  const sides = new Set(errors.filter((_, index) => explained[index] === null).map((check) => check.side));
  if (sides.size === 1) {
    const [side] = sides;
    return { blame: side!, rule: "violation" };
  }

  // A refusal the Company's declared reading explains (an assertion its S1 or S2 reading
  // doesn't accept, refused with invalid_client or invalid_grant) between sides whose
  // readings of that question are incompatible: the spec's open question, at once.
  const refused = cell.checks
    .map((check) => REFUSED_READING.exec(check.id)?.[1])
    .filter((question): question is string => question !== undefined);
  for (const question of refused) {
    const { agent, company } = readingOf(question);
    if (!compatible(question, agent, company)) return reading(question);
  }

  // 2. grid (adversarial implementations are never reference cells, spec §9 rule 2)
  const same = grid.filter((other) => other.scenario === cell.scenario && ran(other) && !other.security);
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
  for (const question of [...(scenario?.readings ?? []), ...explained.filter((found): found is string => found !== null)]) {
    const { agent, company } = readingOf(question);
    if (!compatible(question, agent, company)) return reading(question);
  }

  // 4. unattributed
  return { blame: null, rule: "unattributed" };
}

/** Attribute every cell in place, and attach known failures. */
export function attributeAll(
  cells: Cell[],
  context: AttributionContext & { readonly known?: readonly KnownFailure[] }
): void {
  // First pass: mark security cells, so rule 2's grid scan can ignore them.
  for (const cell of cells) if (isSecurityCell(cell, context)) cell.security = true;
  for (const cell of cells) {
    const verdict = attribute(cell, cells, context);
    cell.blame = verdict.blame;
    cell.rule = verdict.rule;
    if (verdict.detail) cell.reason = cell.reason ? `${cell.reason} [${verdict.detail}]` : verdict.detail;
    const known = knownFailure(cell, context.known ?? []);
    if (known && (cell.outcome === "fail" || cell.outcome === "error")) {
      cell.known = { issue: known.issue, ...(known.reason ? { reason: known.reason } : {}) };
    }
  }
}

const FIELDS = ["agent", "company", "scenario"] as const;

/** A known failure's `agent`, `company` or `scenario` names one, or `"*"` for any. */
export function knownMatches(entry: KnownFailure, cell: Pick<Cell, "agent" | "company" | "scenario">): boolean {
  return FIELDS.every((field) => entry[field] === "*" || entry[field] === cell[field]);
}

/** The known failure that covers a cell: the most specific match (fewest wildcards), first in the file on a tie. */
export function knownFailure(cell: Pick<Cell, "agent" | "company" | "scenario">, known: readonly KnownFailure[]): KnownFailure | undefined {
  const wildcards = (entry: KnownFailure) => FIELDS.filter((field) => entry[field] === "*").length;
  let best: KnownFailure | undefined;
  for (const entry of known) {
    if (knownMatches(entry, cell) && (!best || wildcards(entry) < wildcards(best))) best = entry;
  }
  return best;
}

/** Known failures no failed or errored cell matched: fixed, or never run. */
export function unmatchedKnown(cells: readonly Cell[], known: readonly KnownFailure[]): KnownFailure[] {
  const failed = cells.filter((cell) => cell.outcome === "fail" || cell.outcome === "error");
  return known.filter((entry) => !failed.some((cell) => knownFailure(cell, known) === entry));
}

/** Cells that fail the run: failed or errored, and not a known failure. */
export function unexpected(cells: readonly Cell[]): Cell[] {
  return cells.filter((cell) => (cell.outcome === "fail" || cell.outcome === "error") && !cell.known);
}
