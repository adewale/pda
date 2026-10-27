/**
 * spec/official-checks-0.2.json, the map from each official validator check
 * to what of ours would notice a Company breaking the same requirement, held
 * to the pinned catalog: one row per check, in its order, and every
 * reference resolves to something that exists.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "../../src/validator/messages.ts";
import { TRACE_CHECKS } from "../runner/checks.ts";
import { loadScenarios } from "../runner/cli.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const pin = JSON.parse(readFileSync(path.join(ROOT, "spec/upstream.json"), "utf8")) as { snapshot: string; commit: string };
const ledger = JSON.parse(readFileSync(path.join(ROOT, "spec/official-checks-0.2.json"), "utf8")) as {
  pin: string;
  catalog: string;
  kinds: Record<string, string>;
  checks: { id: string; ours: string[]; note?: string }[];
};
const { CATALOG } = (await import(path.join(ROOT, pin.snapshot, "kit/company/validate/catalog.ts"))) as { CATALOG: { id: string }[] };

describe("the official checks ledger", () => {
  it("is for the pinned snapshot's catalog", () => {
    expect(ledger.pin).toBe(pin.commit);
    expect(ledger.catalog).toBe(`${pin.snapshot}/kit/company/validate/catalog.ts`);
    expect(existsSync(path.join(ROOT, ledger.catalog))).toBe(true);
  });

  it("has one row per official check, in the catalog's order", () => {
    expect(ledger.checks.map((row) => row.id)).toEqual(CATALOG.map((check) => check.id));
  });

  it("names only things that exist", () => {
    const scenarios = new Map(loadScenarios().map((scenario) => [scenario.id, scenario]));
    const broken: string[] = [];
    for (const row of ledger.checks) {
      for (const ref of row.ours) {
        const [kind, id] = ref.split(":", 2) as [string, string];
        const ok =
          kind === "validator" ? id in MESSAGES
          : kind === "runner" ? TRACE_CHECKS[id as keyof typeof TRACE_CHECKS]?.side === "company"
          : kind === "scenario" ? scenarios.has(id) && scenarios.get(id)!.adversary !== "agent"
          : kind === "attack" ? scenarios.get(id)?.adversary === "agent"
          : false;
        if (!ok || !(kind in ledger.kinds)) broken.push(`${row.id}: ${ref}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
