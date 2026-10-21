/**
 * Flaky cells (spec section 9): a cell that fails or errors is run once more.
 * One that passes the second time is recorded as a pass with `flaky: true`
 * and both attempts; it doesn't fail the run and never matches a known
 * failure. One that fails again is recorded as its second attempt.
 */
import type { Attempt, Cell } from "./types.ts";

/** Runs one attempt of a cell into `target`; `attempt` is 1, then 2. */
export type RunAttempt = (target: Cell, attempt: number) => Promise<void>;

const failed = (cell: Cell) => cell.outcome === "fail" || cell.outcome === "error";

const summary = (cell: Cell): Attempt => ({ outcome: cell.outcome, ...(cell.reason ? { reason: cell.reason } : {}), har: cell.har });

export async function runWithRetry(cell: Cell, run: RunAttempt, retry: boolean): Promise<void> {
  await run(cell, 1);
  if (!retry || !failed(cell)) return;
  const first = summary(cell);
  const again: Cell = { agent: cell.agent, company: cell.company, scenario: cell.scenario, protocolVersion: cell.protocolVersion, specificationRevision: cell.specificationRevision, outcome: "unsupported", blame: null, rule: null, steps: [], checks: [], har: null };
  await run(again, 2);
  cell.outcome = again.outcome;
  cell.steps = again.steps;
  cell.checks = again.checks;
  cell.har = again.har;
  if (again.reason) cell.reason = again.reason;
  else delete cell.reason;
  cell.attempts = [first, summary(again)];
  if (again.outcome === "pass") cell.flaky = true;
}
