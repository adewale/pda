import { describe, expect, it } from "vitest";
import { runWithRetry, type RunAttempt } from "../runner/retry.ts";
import type { Cell, Outcome } from "../runner/types.ts";

const blank = (): Cell => ({ agent: "a", company: "c", scenario: "SD", outcome: "unsupported", blame: null, rule: null, steps: [], checks: [], har: null });

/** An attempt that comes to each outcome in turn, recording what it was given. */
function scripted(...outcomes: Outcome[]): RunAttempt & { calls: number[] } {
  const calls: number[] = [];
  const run = async (target: Cell, attempt: number) => {
    calls.push(attempt);
    // A fresh cell each time: nothing of the first attempt leaks into the second.
    expect(target.steps).toEqual([]);
    target.outcome = outcomes[attempt - 1]!;
    target.steps = [{ actor: "agent", op: "session", ms: attempt, ok: target.outcome === "pass" }];
    target.har = attempt === 1 ? "SD/a__c.har" : `SD/a__c.attempt${attempt}.har`;
    if (target.outcome !== "pass") target.reason = `attempt ${attempt} ${target.outcome}`;
  };
  return Object.assign(run, { calls });
}

describe("flaky cells", () => {
  it("run a failed cell once more; a pass then is recorded as a flaky pass with both attempts", async () => {
    const cell = blank();
    const run = scripted("fail", "pass");
    await runWithRetry(cell, run, true);
    expect(run.calls).toEqual([1, 2]);
    expect(cell).toMatchObject({ outcome: "pass", flaky: true, har: "SD/a__c.attempt2.har", steps: [{ ms: 2, ok: true }] });
    expect(cell.reason).toBeUndefined();
    expect(cell.attempts).toEqual([
      { outcome: "fail", reason: "attempt 1 fail", har: "SD/a__c.har" },
      { outcome: "pass", har: "SD/a__c.attempt2.har" }
    ]);
  });

  it("retains the protocol context when a failed 0.2 cell is retried", async () => {
    const cell = { ...blank(), protocolVersion: "0.2", specificationRevision: "2026-10-19" };
    await runWithRetry(cell, async (target, attempt) => {
      expect(target.protocolVersion).toBe("0.2");
      expect(target.specificationRevision).toBe("2026-10-19");
      target.outcome = attempt === 1 ? "fail" : "pass";
    }, true);
    expect(cell.flaky).toBe(true);
  });

  it("retry errors too, and keep the second failure, not flaky", async () => {
    const cell = blank();
    await runWithRetry(cell, scripted("error", "fail"), true);
    expect(cell.outcome).toBe("fail");
    expect(cell.flaky).toBeUndefined();
    expect(cell.reason).toBe("attempt 2 fail");
    expect(cell.attempts?.map((attempt) => attempt.outcome)).toEqual(["error", "fail"]);
  });

  it("don't run a pass or an unsupported cell again", async () => {
    for (const outcome of ["pass", "unsupported"] as const) {
      const cell = blank();
      const run = scripted(outcome);
      await runWithRetry(cell, run, true);
      expect(run.calls).toEqual([1]);
      expect(cell.attempts).toBeUndefined();
    }
  });

  it("run nothing twice with --no-retry", async () => {
    const cell = blank();
    const run = scripted("fail", "pass");
    await runWithRetry(cell, run, false);
    expect(run.calls).toEqual([1]);
    expect(cell).toMatchObject({ outcome: "fail", reason: "attempt 1 fail" });
    expect(cell.flaky).toBeUndefined();
  });
});
