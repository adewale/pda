/**
 * Who a failed cell is blamed on (spec section 9), by the first rule that
 * decides it, and known failures. Pure functions over the whole grid.
 *
 * 1. violation: error checks on one side only. An error that is exactly a
 *    declared reading difference (a check of a section 7 question, such as
 *    a strict Company's `client-assertion.typ`, between sides whose
 *    readings of it are incompatible) is not a violation: when every error
 *    is one, the cell goes to rule 3 at once. So does a cell with no
 *    one-sided errors whose trace shows a refusal the Company's declared
 *    reading explains (`reading.<id>.refused`: an assertion `aud` or `typ`
 *    its S1 or S2 reading doesn't accept), when the readings are incompatible.
 * 1b. below a failure (docs/conformance-levels.md): with no error to decide
 *    it, a check one side recorded of the other at a lower level (the mock
 *    Company of the agent, the strict fake agent of the Company). Our reading (basis
 *    Reading) blames the spec (rule `reading`), unless both sides declared
 *    compatible readings of its question and the agent sent otherwise
 *    (rule `warning`, the agent). A SHOULD or the Guides, recorded on one
 *    side, blames that side with rule `warning`: it departed from a
 *    recommendation, which isn't a violation.
 * 2. grid: the agent passes the scenario against the reference Company but
 *    this Company fails it with every agent that ran it (blame the Company);
 *    or this agent fails it with every Company it ran against while this
 *    Company passes it with the reference agent, or any other (blame the agent).
 * 3. reading: the two sides declare incompatible readings of a question the
 *    scenario depends on, or that an error check belongs to, and the trace
 *    shows that question mattered: a `reading.<id>.refused` check, or a
 *    Company-recorded error of that question (blame the spec). Declared
 *    readings that differ, with no such evidence, decide nothing.
 * 4. unattributed.
 */
import { isBasis, levelOf, type Level } from "../../src/validator/levels.ts";
import { compatible, questionOf, REFUSED_READING } from "./readings.ts";
import type { Blame, Cell, Check, KnownFailure, Rule, Scenario } from "./types.ts";

export const REFERENCE_COMPANY = "lenient-company";
/** The reference agent: the fake Personal Agent that accepts every reading giving no more access (spec §9, rule 2). */
export const REFERENCE_AGENT = "lenient-personal-agent";

/** One entry of an adapter's `GET /violations`: the mock Company's (interop/impls/shared/mock-hooks.ts) or the strict fake agent's. */
export type RecordedViolation = { readonly id: string; readonly basis?: unknown; readonly level?: unknown; readonly detail: string };

/**
 * A check a Company recorded, as a cell check against the agent. Its basis
 * decides the severity: a failure (MUST, RFC, Rule) is an error, which fails
 * the cell; a SHOULD, the Guides or our reading a warning, which doesn't. A
 * record without a known basis counts as a failure. In a security cell every
 * record is a warning: the bad request is the attack's, and rule 0 decides.
 */
export function companyRecorded(violation: RecordedViolation, company: string, security: boolean): Check {
  const basis = isBasis(violation.basis) ? violation.basis : null;
  const failure = basis === null || levelOf(basis) === "failure";
  return { id: violation.id, side: "agent", severity: failure && !security ? "error" : "warning", basis, exchange: null, detail: violation.detail, source: `company:${company}` };
}

/**
 * A check the strict fake agent recorded (interop/impls/pda-agent/profiles.ts), as a cell
 * check against the Company, with the same levels as `companyRecorded`.
 */
export function agentRecorded(violation: RecordedViolation, agent: string, security: boolean): Check {
  const basis = isBasis(violation.basis) ? violation.basis : null;
  const failure = basis === null || levelOf(basis) === "failure";
  return { id: violation.id, side: "company", severity: failure && !security ? "error" : "warning", basis, exchange: null, detail: violation.detail, source: `agent:${agent}` };
}

/** A check's level: from its basis, or, without one, `failure` for an error and `warning` otherwise. */
export function checkLevel(check: Check): Exclude<Level, "none"> {
  const level = check.basis ? levelOf(check.basis) : check.severity === "error" ? "failure" : "warning";
  return level === "none" ? "warning" : level;
}

/** Checks per level across the interop cells (security cells apart), for the results' `levels`. */
export function levelCounts(cells: readonly Cell[]): Record<Exclude<Level, "none">, number> {
  const counts = { failure: 0, warning: 0, tentative: 0 };
  for (const cell of cells) if (!cell.security) for (const check of cell.checks) counts[checkLevel(check)]++;
  return counts;
}

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
  readonly referenceAgent?: string;
  /** Implementation names that misbehave on purpose (evil-personal-agent, evil-company). */
  readonly adversarial?: ReadonlySet<string>;
};

/**
 * A cell is a security (adversarial) cell when a side is an adversarial
 * implementation, or its scenario names an `adversary` or a `faults` list.
 * Such cells go in the security grid, never in the interop pass rates, and
 * never stand in as grid references (spec §9, rule 2).
 */
export function isSecurityCell(cell: Pick<Cell, "agent" | "company" | "scenario" | "protocolVersion">, context: AttributionContext): boolean {
  const adv = context.adversarial ?? new Set<string>();
  if (adv.has(cell.agent) || adv.has(cell.company)) return true;
  const scenario = context.scenarios.get(cell.scenario);
  return !!scenario?.adversary || !!scenario?.faults?.length;
}

export function attribute(cell: Cell, grid: readonly Cell[], context: AttributionContext): Verdict {
  if (cell.outcome === "error") return { blame: "harness", rule: null };
  if (cell.outcome !== "fail") return { blame: null, rule: null };
  const reference = context.reference ?? REFERENCE_COMPANY;
  const referenceAgent = context.referenceAgent ?? REFERENCE_AGENT;

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

  // Below a failure (docs/conformance-levels.md): what one side recorded of the other as a warning
  // or a tentative reading, when no error decided the cell: the Company's record of the request it
  // refused (or let through), or the strict fake agent's of the answer it refused. They say why the
  // cell failed; the runner's passive trace and validator warnings don't, and aren't counted here.
  const recorded = cell.checks.filter((check) => (check.source.startsWith("company:") || check.source.startsWith("agent:")) && check.severity !== "error" && check.basis);
  // A reading of ours (basis Reading): the spec's open question, unless both sides declared
  // compatible readings of it and the agent sent otherwise, which is its own departure.
  const tentative = recorded.find((found) => levelOf(found.basis!) === "tentative");
  if (tentative) {
    const question = questionOf(tentative.id);
    if (!question) return { blame: "spec", rule: "reading", detail: `${tentative.id}: our reading, not a requirement of the draft` };
    const { agent, company } = readingOf(question);
    if (!agent || !company || !compatible(question, agent, company)) return reading(question);
    const who = tentative.side === "agent" ? cell.agent : cell.company;
    return { blame: tentative.side, rule: "warning", detail: `${tentative.id}: ${who} departs from its own declared reading of ${question}` };
  }
  // A SHOULD or the Guides: the side that departed from the recommendation, as a warning, not a
  // violation: the draft lets it, and lets the other side refuse.
  const warned = recorded.filter((found) => levelOf(found.basis!) === "warning");
  const warnedSides = new Set(warned.map((check) => check.side));
  if (warnedSides.size === 1) {
    const [side] = warnedSides;
    return { blame: side!, rule: "warning", detail: `${[...new Set(warned.map((check) => check.id))].join(", ")}: a SHOULD or the Guides, not a requirement` };
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
  // The same rule from the agent's side, against the reference agent.
  if (cell.agent !== referenceAgent && at(referenceAgent, cell.company)?.outcome === "pass") {
    const withThisAgent = same.filter((other) => other.agent === cell.agent);
    if (withThisAgent.every((other) => other.outcome === "fail")) {
      return { blame: "agent", rule: "grid", detail: `${cell.company} passes ${cell.scenario} with ${referenceAgent}; ${cell.agent} fails it at every Company` };
    }
  }
  const withAgent = same.filter((other) => other.agent === cell.agent);
  const companyPassesElsewhere = same.some((other) => other.company === cell.company && other.agent !== cell.agent && other.outcome === "pass");
  if (withAgent.every((other) => other.outcome === "fail") && companyPassesElsewhere) {
    return { blame: "agent", rule: "grid", detail: `${cell.company} passes ${cell.scenario} with another agent; ${cell.agent} fails it with every Company` };
  }

  // 3. reading, only where the trace shows the question mattered: the Company refused what its
  // reading doesn't accept (`reading.<id>.refused`), or recorded an error of that question.
  // Two declarations that merely differ prove nothing: poppy-demo × lenient-company fails D on its
  // issuer-origin rule, not on S3, though the two read S3 differently.
  const evidenced = new Set([...refused, ...explained.filter((found): found is string => found !== null)]);
  const scenario = context.scenarios.get(cell.scenario);
  for (const question of [...(scenario?.readings ?? []), ...evidenced]) {
    const { agent, company } = readingOf(question);
    if (evidenced.has(question) && !compatible(question, agent, company)) return reading(question);
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
    if (cell.outcome !== "fail" && cell.outcome !== "error") continue;
    const known = knownFailure(cell, context.known ?? []);
    if (known) cell.known = { issue: known.issue, ...(known.reason ? { reason: known.reason } : {}) };
    else {
      // A known failure for this cell that expected another failure: say so, so the difference is easy to see.
      const other = (context.known ?? []).find((entry) => knownCovers(entry, cell));
      if (other) {
        const seen = failureSignature(cell);
        const note = `not the known failure ${other.issue}: it expects blame ${blamesOf(other).join(" or ")}, checks [${(other.checks ?? []).join(", ")}], errors [${(other.errors ?? []).join(", ")}]; this cell has blame ${seen.blame}, checks [${seen.checks.join(", ")}], error ${seen.error ?? "none"}`;
        cell.reason = cell.reason ? `${cell.reason} [${note}]` : note;
      }
    }
  }
}

const FIELDS = ["agent", "company", "scenario"] as const;

/** Where a known failure may happen: its `agent`, `company` and `scenario` each name the cell's, or are `"*"` for any. */
export function knownCovers(entry: KnownFailure, cell: Pick<Cell, "agent" | "company" | "scenario" | "protocolVersion">): boolean {
  if ((entry.protocolVersion ?? "0.1") !== (cell.protocolVersion ?? "0.1")) return false;
  return FIELDS.every((field) => entry[field] === "*" || entry[field] === cell[field]);
}

/**
 * The first failed step's code: the Poppy error a refusal named
 * (`poppy_error invalid_grant: …` gives `invalid_grant`), `expect <path>`
 * for an expectation that didn't hold, or the text before the first colon of
 * any other step error. A cell that errored before any step gives `error`;
 * one that failed only on its checks gives `null`.
 */
export function failureCode(cell: Pick<Cell, "steps" | "outcome" | "protocolVersion">): string | null {
  const step = cell.steps.find((s) => !s.ok && !(s.error ?? "").startsWith("unsupported:"));
  if (!step) return cell.outcome === "error" ? "error" : null;
  const text = step.error ?? "";
  if (step.actor === "expect") return `expect ${text.split(":")[0]!.trim()}`;
  return text.replace(/^poppy_error /, "").split(":")[0]!.trim() || `${step.actor} ${step.op}`;
}

/** What a failed cell shows: its blame, its error checks, and its first failed step's code. */
export type FailureSignature = { readonly blame: Blame; readonly checks: readonly string[]; readonly error: string | null };

export function failureSignature(cell: Pick<Cell, "blame" | "checks" | "steps" | "outcome" | "protocolVersion">): FailureSignature {
  const checks = [...new Set(cell.checks.filter((check) => check.severity === "error").map((check) => check.id))].sort();
  return { blame: cell.blame, checks, error: failureCode(cell) };
}

/**
 * A known failure matches a failed cell when it covers the cell, names the
 * cell's blame, lists every error check the cell shows, and lists its first
 * failed step's code (where a step failed). Anything else in the cell is a
 * different failure, and unexpected.
 */
export function knownMatches(entry: KnownFailure, cell: Pick<Cell, "agent" | "company" | "scenario" | "blame" | "checks" | "steps" | "outcome" | "protocolVersion">): boolean {
  if (!knownCovers(entry, cell)) return false;
  const seen = failureSignature(cell);
  return (
    blamesOf(entry).includes(seen.blame) &&
    seen.checks.every((id) => (entry.checks ?? []).includes(id)) &&
    (seen.error === null || (entry.errors ?? []).includes(seen.error))
  );
}

/** The blames a known failure allows. */
export const blamesOf = (entry: Pick<KnownFailure, "blame">): readonly Blame[] => (Array.isArray(entry.blame) ? entry.blame : [entry.blame as Blame]);

/** The known failure that matches a failed cell: the most specific (fewest wildcards), first in the file on a tie. */
export function knownFailure(cell: Pick<Cell, "agent" | "company" | "scenario" | "blame" | "checks" | "steps" | "outcome" | "protocolVersion">, known: readonly KnownFailure[]): KnownFailure | undefined {
  const wildcards = (entry: KnownFailure) => FIELDS.filter((field) => entry[field] === "*").length;
  let best: KnownFailure | undefined;
  for (const entry of known) {
    if (knownMatches(entry, cell) && (!best || wildcards(entry) < wildcards(best))) best = entry;
  }
  return best;
}

/** Which of the agent, Company and scenario dimensions a run covered whole (every one the lane has). */
export type Coverage = Readonly<Record<(typeof FIELDS)[number], boolean>>;

/**
 * Stale known failures: entries this run could judge that matched no failed
 * or errored cell (`knownMatches`: the same blame, checks and step error), so
 * the failure is fixed, has changed, or the entry is wrong. An entry is
 * judged only when each field it names matched a cell that ran, and each `*`
 * spans a dimension the run covered whole: a run of some scenarios, or some
 * Companies, can't say a wildcard's failure has gone from the rest. A
 * wildcard entry is stale only when no failed cell it covers is left, even
 * where a more specific entry is the one attached to those cells.
 */
export function staleKnown(cells: readonly Cell[], known: readonly KnownFailure[], coverage: Coverage = { agent: true, company: true, scenario: true }): KnownFailure[] {
  const failed = cells.filter((cell) => cell.outcome === "fail" || cell.outcome === "error");
  return known.filter(
    (entry) =>
      cells.some((cell) => knownCovers(entry, cell)) &&
      FIELDS.every((field) => entry[field] !== "*" || coverage[field]) &&
      !failed.some((cell) => knownMatches(entry, cell))
  );
}

/** Cells that fail the run: failed or errored, and not a known failure. */
export function unexpected(cells: readonly Cell[]): Cell[] {
  return cells.filter((cell) => (cell.outcome === "fail" || cell.outcome === "error") && !cell.known);
}
