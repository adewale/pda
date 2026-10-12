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

  it("serve every recorded check by id, in order, with its basis, its level and the detail after it", () => {
    const state = {
      recorded: [
        "[message.json-in-text] conversation message: JSON in text; use data (7.4)",
        "[dpop.htu] DPoP: htu https://a.example/x != https://a.example/y",
        "[exchange.performed-twice] itm_4Qa on ord_7Hk2 exchanged again for acct_ada (confirm)",
        "[client-assertion.aud-array] aud is an array",
        "[made-up.check] something"
      ]
    };
    expect(violationsBody(state)).toEqual({
      violations: [
        { id: "message.json-in-text", basis: "SHOULD", level: "warning", detail: "conversation message: JSON in text; use data (7.4)" },
        { id: "dpop.htu", basis: "MUST", level: "failure", detail: "DPoP: htu https://a.example/x != https://a.example/y" },
        { id: "exchange.performed-twice", basis: "Guides", level: "warning", detail: "itm_4Qa on ord_7Hk2 exchanged again for acct_ada (confirm)" },
        { id: "client-assertion.aud-array", basis: "Reading", level: "tentative", detail: "aud is an array" },
        // An id the catalog doesn't know counts as a failure, so it can't slip through as a warning.
        { id: "made-up.check", basis: null, level: "failure", detail: "something" }
      ]
    });
  });

  it("rotate Account Tokens, poll devices every second and list no API of an unknown type, for every host", () => {
    expect(MOCK_BASE).toEqual({ rotateRefreshTokens: true, deviceInterval: 1, unknownApi: false });
  });

  for (const host of ["interop/impls/dpa-mock/adapter.ts", "test/hypothesis/launcher.ts"]) {
    it(`are what ${host} serves: it takes placement, base, hooks and violations from the shared module and copies none`, () => {
      const source = readFileSync(path.join(ROOT, host), "utf8");
      expect(source).toMatch(/from "(?:\.\.\/shared|\.\.\/\.\.\/interop\/impls\/shared)\/mock-hooks\.ts"/);
      for (const used of ["placeInteropCompanies()", "mockHooks(() => mock)", "violationsBody(await mock.state()", "MOCK_BASE"]) expect(source, used).toContain(used);
      for (const copied of ["placeCompanies(", "class HookError", "function accountFor", "async fixture(", "violationId(", "deviceInterval"]) expect(source, copied).not.toContain(copied);
    });
  }
});
