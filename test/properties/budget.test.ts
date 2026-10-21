import { describe, expect, it } from "vitest";
import { memorySql } from "../../interop/impls/pda-agent/sqlite";
import { Ledger, utcDay } from "../../src/budget";

describe("demo spend uses the metering clock for retention", () => {
  it("retains a charge made on the injected day even when wall time is later", () => {
    const ledger = new Ledger(memorySql());
    const now = Date.UTC(2026, 9, 11, 12);
    ledger.add(utcDay(now), 0.8, now);
    expect(ledger.spent("2026-10-11")).toBe(0.8);
  });

  it("keeps seven days and prunes older charges when that same clock advances", () => {
    const ledger = new Ledger(memorySql());
    const start = Date.UTC(2026, 9, 11, 12);
    ledger.add(utcDay(start), 0.8, start);
    ledger.add("2026-10-18", 0.2, start + 7 * 86_400_000);
    expect(ledger.spent("2026-10-11")).toBe(0.8);
    ledger.add("2026-10-19", 0.1, start + 8 * 86_400_000);
    expect(ledger.spent("2026-10-11")).toBe(0);
    expect(ledger.spent("2026-10-18")).toBe(0.2);
  });
});
