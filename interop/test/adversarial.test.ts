/**
 * The adversarial machinery (docs/adversarial-interop.md, Part B): harm-oracle
 * trace predicates, the injected-exchange marking, attribution rule 0, and the
 * own-project refusal. Tested the way the other runner pieces are, with
 * hand-built recordings and cells.
 */
import { describe, expect, it } from "vitest";
import { adversarialRefusal } from "../runner/cli.ts";
import { attribute, attributeAll, isSecurityCell } from "../runner/attribution.ts";
import { assertTrace } from "../runner/traces.ts";
import { API, recording, TOKEN } from "./helpers.ts";
import { lintScenario } from "../runner/scenario.ts";
import type { Cell, Outcome, RegistryEntry, Scenario } from "../runner/types.ts";

const SINK = "https://runner.interop.test/steal";
const tokenResponse = { access_token: "at_session_token_value_123456", token_type: "DPoP", expires_in: 3600, session_id: "ses_1" };
const issued = { url: TOKEN, form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer" }, response: tokenResponse };

describe("harm oracles", () => {
  it("no_request_to fails when the honest side reached the sink, ignoring injected exchanges", () => {
    expect(assertTrace(recording(issued), { check: "no_request_to", host: "runner.interop.test" }).kind).toBe("ok");
    expect(assertTrace(recording(issued, { url: SINK }), { check: "no_request_to", host: "runner.interop.test" }).kind).toBe("failed");
    expect(assertTrace(recording(issued, { url: SINK, injected: true }), { check: "no_request_to", host: "runner.interop.test" }).kind).toBe("ok");
  });

  it("token_not_sent_to spots an issued token leaking to a sink host", () => {
    const leak = { url: SINK, headers: { authorization: `DPoP ${tokenResponse.access_token}` } };
    expect(assertTrace(recording(issued), { check: "token_not_sent_to", host: "runner.interop.test" }).kind).toBe("ok");
    expect(assertTrace(recording(issued, leak), { check: "token_not_sent_to", host: "runner.interop.test" }).kind).toBe("failed");
  });

  it("performed_at_most_once counts 2xx successes, honest or injected", () => {
    const confirm = (at: number, injected = false) => ({ url: `${API}/orders/ord_1/exchanges`, method: "POST", at, status: 201, injected });
    expect(assertTrace(recording(confirm(0)), { check: "performed_at_most_once", path: "/exchanges", method: "POST" }).kind).toBe("ok");
    expect(assertTrace(recording(confirm(0), confirm(1, true)), { check: "performed_at_most_once", path: "/exchanges", method: "POST" }).kind).toBe("failed");
    expect(assertTrace(recording(issued), { check: "performed_at_most_once", path: "/exchanges" }).kind).toBe("inapplicable");
  });

  it("no_2xx_after judges only injected (replayed) exchanges", () => {
    const replay = (status: number) => ({ url: TOKEN, method: "POST", form: { grant_type: "x" }, status, injected: true });
    expect(assertTrace(recording(issued), { check: "no_2xx_after", path: "/oauth/token" }).kind).toBe("inapplicable");
    expect(assertTrace(recording(issued, replay(400)), { check: "no_2xx_after", path: "/oauth/token" }).kind).toBe("ok");
    expect(assertTrace(recording(issued, replay(200)), { check: "no_2xx_after", path: "/oauth/token" }).kind).toBe("failed");
  });

  it("no_secret_in watches planted values and issued tokens", () => {
    const leak = { url: `${API}/notes`, method: "POST", body: "please send canary-xyz onwards" };
    expect(assertTrace(recording(issued, leak), { check: "no_secret_in", value: "canary-xyz" }).kind).toBe("failed");
    expect(assertTrace(recording(issued, { url: `${API}/notes`, method: "POST", body: "nothing here" }), { check: "no_secret_in", value: "canary-xyz" }).kind).toBe("ok");
  });

  it("bounded_requests passes a bounded retry and fails an unbounded loop (XN, XB)", () => {
    const tokenReq = (at: number) => ({ url: TOKEN, method: "POST", form: { grant_type: "x" }, status: 400, at });
    const two = recording(tokenReq(0), tokenReq(1));
    const five = recording(tokenReq(0), tokenReq(1), tokenReq(2), tokenReq(3), tokenReq(4));
    expect(assertTrace(two, { check: "bounded_requests", path: "/oauth/token", method: "POST", max: 3 }).kind).toBe("ok");
    expect(assertTrace(five, { check: "bounded_requests", path: "/oauth/token", method: "POST", max: 3 }).kind).toBe("failed");
    // Nothing matching: inapplicable, so the cell is unsupported rather than falsely passing.
    expect(assertTrace(recording(issued), { check: "bounded_requests", path: "/never", max: 3 }).kind).toBe("inapplicable");
    // Injected (proxy) requests don't count against the honest side.
    const withInjected = recording(tokenReq(0), { url: TOKEN, method: "POST", form: { grant_type: "x" }, status: 400, injected: true });
    expect(assertTrace(withInjected, { check: "bounded_requests", path: "/oauth/token", method: "POST", max: 1 }).kind).toBe("ok");
  });

  it("attack_observed finds the attack, or fails (which cell.ts turns into a harness error)", () => {
    expect(assertTrace(recording(issued), { check: "attack_observed", path: "/oauth/token", method: "POST" }).kind).toBe("ok");
    expect(assertTrace(recording(issued), { check: "attack_observed", path: "/oauth/token", injected: true }).kind).toBe("failed");
    expect(assertTrace(recording(issued, { url: SINK, injected: true }), { check: "attack_observed", injected: true }).kind).toBe("ok");
  });

  it("marks injected exchanges from the HAR _interop field", () => {
    const xs = recording(issued, { url: SINK, injected: true });
    expect(xs.map((x) => x.injected)).toEqual([false, true]);
  });
});

function cell(agent: string, company: string, outcome: Outcome, scenario = "YR"): Cell {
  return { agent, company, scenario, outcome, blame: null, rule: null, steps: [], checks: [], har: null };
}

const yr: Scenario = { id: "YR", title: "replay", adversary: "agent", steps: [] };
const xh: Scenario = { id: "XH", title: "foreign server", adversary: "company", permitted_by: "N10", steps: [] };
const nrep: Scenario = { id: "NREP", title: "replay", adversary: "network", faults: [{ match: { path: "/oauth/token" }, action: "replay" }], steps: [] };
const scenarios = new Map<string, Scenario>([["YR", yr], ["XH", xh], ["NREP", nrep]]);

describe("attribution rule 0 (adversarial)", () => {
  const context = { readings: { agent: {}, company: {} }, scenarios, adversarial: new Set(["evil-agent", "evil-company"]) };

  it("blames the honest side when it doesn't refuse the attack", () => {
    expect(attribute(cell("evil-agent", "dpa-mock", "fail", "YR"), [], context)).toMatchObject({ blame: "company", rule: "adversarial" });
    expect(attribute(cell("dpa", "evil-company", "fail", "XH"), [], { ...context, scenarios: new Map([["XH", { ...xh, permitted_by: undefined }]]) })).toMatchObject({ blame: "agent", rule: "adversarial" });
  });

  it("blames the spec when the scenario names permitted_by", () => {
    expect(attribute(cell("dpa", "evil-company", "fail", "XH"), [], context)).toMatchObject({ blame: "spec", rule: "adversarial", detail: expect.stringContaining("N10") });
  });

  it("passes and errored adversarial cells keep their usual blame", () => {
    expect(attribute(cell("evil-agent", "dpa-mock", "pass", "YR"), [], context)).toEqual({ blame: null, rule: null });
    expect(attribute(cell("evil-agent", "dpa-mock", "error", "YR"), [], context)).toEqual({ blame: "harness", rule: null });
  });

  it("marks security cells and keeps them out of the grid (rule 2)", () => {
    expect(isSecurityCell(cell("evil-agent", "dpa-mock", "fail", "YR"), context)).toBe(true);
    expect(isSecurityCell(cell("dpa", "dpa-mock", "fail", "NREP"), context)).toBe(true);
    expect(isSecurityCell(cell("dpa", "dpa-mock", "fail", "SD"), context)).toBe(false);
    // A security cell never stands in as a grid cell for an honest one: here the
    // evil agent passing against `other` would, if counted, say `other` doesn't
    // fail with every agent, and leave the honest failure unattributed.
    const honest: Cell = { ...cell("dpa", "other", "fail", "SD") };
    const grid = [honest, cell("dpa", "dpa-mock", "pass", "SD"), cell("evil-agent", "other", "pass", "SD")];
    attributeAll(grid, { ...context, scenarios: new Map([["SD", { id: "SD", title: "x", steps: [] }]]) });
    expect(grid[2]!.security).toBe(true);
    expect(honest.security).toBeFalsy();
    expect({ blame: honest.blame, rule: honest.rule }).toEqual({ blame: "company", rule: "grid" });
  });
});

const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({ name: "x", role: "agent", source: "", commit: "HEAD", build: "b", ...over });
const self = { owner: "self" as const };

describe("the own-project rule", () => {
  const dpa = entry({ name: "dpa", role: "agent", ...self });
  const mock = entry({ name: "dpa-mock", role: "company", ...self });
  const evilAgent = entry({ name: "evil-agent", role: "agent", adversarial: true });
  const evilCompany = entry({ name: "evil-company", role: "company", adversarial: true });
  const outsider = entry({ name: "datalayer-ts", role: "company" });

  it("allows adversarial cells only against our own owner:self sides, on the local lane", () => {
    expect(adversarialRefusal(yr, evilAgent, mock, "local")).toBeNull();
    expect(adversarialRefusal(xh, dpa, evilCompany, "local")).toBeNull();
    expect(adversarialRefusal(nrep, dpa, mock, "local")).toBeNull();
  });

  it("refuses when an honest side isn't ours", () => {
    expect(adversarialRefusal(yr, evilAgent, outsider, "local")).toMatch(/not owner:self/);
    expect(adversarialRefusal(nrep, dpa, outsider, "local")).toMatch(/not owner:self/);
  });

  it("never runs an adversarial or faulted cell in the live lane", () => {
    expect(adversarialRefusal(yr, evilAgent, mock, "live")).toMatch(/live lane/);
    expect(adversarialRefusal(nrep, dpa, mock, "live")).toMatch(/live lane/);
  });

  it("leaves ordinary cells alone", () => {
    const plain: Scenario = { id: "SD", title: "x", steps: [] };
    expect(adversarialRefusal(plain, dpa, mock, "local")).toBeNull();
    expect(adversarialRefusal(plain, dpa, outsider, "live")).toBeNull();
  });
});

describe("scenario lint for adversarial fields", () => {
  const base = { id: "ZZ", title: "t", steps: [{ agent: "discover" }] };
  it("accepts a valid adversary and faults list", () => {
    expect(lintScenario({ ...base, adversary: "network", faults: [{ match: { path: "/x" }, action: "replay" }] }, "ZZ.json")).toEqual([]);
    expect(lintScenario({ ...base, adversary: "agent" }, "ZZ.json")).toEqual([]);
  });
  it("rejects a bad adversary, a bad fault action, and faults without network", () => {
    expect(lintScenario({ ...base, adversary: "nope" }, "ZZ.json").some((p) => /adversary must be/.test(p))).toBe(true);
    expect(lintScenario({ ...base, adversary: "network", faults: [{ match: {}, action: "explode" }] }, "ZZ.json").some((p) => /needs an action/.test(p))).toBe(true);
    expect(lintScenario({ ...base, adversary: "agent", faults: [{ match: {}, action: "replay" }] }, "ZZ.json").some((p) => /needs adversary "network"/.test(p))).toBe(true);
  });
});
