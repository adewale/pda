/**
 * The mock Company's hooks, shared by the interop adapter and the Hypothesis
 * launcher (interop/impls/shared/mock-hooks.ts): one copy, so the two can't
 * drift, and enough of them for every scenario.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MOCK_BASE, mockHooks, violationsBody } from "../impls/shared/mock-hooks.ts";
import type { MockCompany } from "../../test/mock-company/index.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const SHARED = Object.keys(mockHooks(() => ({}) as MockCompany));

describe("the shared mock hooks", () => {
  it("are every Company hook a scenario needs or calls, but the adversary's arm", () => {
    const dir = path.join(ROOT, "interop/scenarios");
    const used = new Set<string>();
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const scenario = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { needs?: { company?: string[] }; steps: { company?: string }[] };
      for (const hook of scenario.needs?.company ?? []) used.add(hook);
      for (const step of scenario.steps) if (step.company) used.add(step.company);
    }
    used.delete("arm");
    expect([...used].filter((hook) => !SHARED.includes(hook))).toEqual([]);
  });

  it("serve violations by id, with the detail after it", () => {
    expect(violationsBody({ violations: ["[dpop.htu] DPoP: htu https://a.example/x != https://a.example/y", "[user-id.personal] User ID \"ada@example.com\""] })).toEqual({
      violations: [
        { id: "dpop.htu", detail: "DPoP: htu https://a.example/x != https://a.example/y" },
        { id: "user-id.personal", detail: 'User ID "ada@example.com"' }
      ]
    });
  });

  it("rotate Account Tokens and poll devices every second, for every host", () => {
    expect(MOCK_BASE).toEqual({ rotateRefreshTokens: true, deviceInterval: 1 });
  });

  for (const host of ["interop/impls/dpa-mock/adapter.ts", "test/hypothesis/launcher.ts"]) {
    it(`are what ${host} serves: it takes placement, base, hooks and violations from the shared module and copies none`, () => {
      const source = readFileSync(path.join(ROOT, host), "utf8");
      expect(source).toMatch(/from "(?:\.\.\/shared|\.\.\/\.\.\/interop\/impls\/shared)\/mock-hooks\.ts"/);
      for (const used of ["placeInteropCompanies()", "mockHooks(() => mock)", "violationsBody(await mock.state())", "MOCK_BASE"]) expect(source, used).toContain(used);
      for (const copied of ["placeCompanies(", "class HookError", "function accountFor", "async fixture(", "violationId(", "deviceInterval"]) expect(source, copied).not.toContain(copied);
    });
  }
});
