import { describe, expect, it } from "vitest";
import { runCell, toReply, type Driver, type Reply } from "../runner/cell.ts";
import { loadScenarios } from "../runner/cli.ts";
import { compare, evaluate, expectedRefusals, interpolate, lintScenario, lookup } from "../runner/scenario.ts";
import type { Scenario } from "../runner/types.ts";

describe("interpolation", () => {
  const saved = { fixture: { accounts: ["acct_ada"] }, pending: { pending: { url: "https://x/y" } }, n: 3 };

  it("looks up members and array indexes", () => {
    expect(lookup("fixture.accounts.0", saved)).toBe("acct_ada");
    expect(lookup("pending.pending.url", saved)).toBe("https://x/y");
    expect(lookup("pending.nothing.deeper", saved)).toBeUndefined();
  });

  it("replaces a whole reference with its value, whatever the type, and splices parts into text", () => {
    expect(interpolate({ url: "${pending.pending.url}", n: "${n}", text: "n is ${n}", list: ["${fixture.accounts}"] }, saved)).toEqual({
      url: "https://x/y",
      n: 3,
      text: "n is 3",
      list: [["acct_ada"]]
    });
  });

  it("refuses a reference to nothing in step parameters", () => {
    expect(() => interpolate({ url: "${pending.url}" }, saved)).toThrow("${pending.url} refers to nothing");
    expect(interpolate("${pending.url}", saved, false)).toBeUndefined();
  });
});

describe("expectations", () => {
  it("compares values and operators", () => {
    expect(compare(true, true)).toBeNull();
    expect(compare({ a: [1] }, { a: [1] })).toBeNull();
    expect(compare("x", "y")).toBe('expected "y", got "x"');
    expect(compare(undefined, { $exists: false })).toBeNull();
    expect(compare("b", { $in: ["a", "b"] })).toBeNull();
    expect(compare("poppy:read poppy:write", { $includes_scope: "poppy:write" })).toBeNull();
    expect(compare("poppy:readx", { $includes_scope: "poppy:read" })).not.toBeNull();
    expect(compare(["openapi", "mcp"], { $contains: "mcp" })).toBeNull();
    expect(compare([{ role: "user" }, { role: "company", text: "hi" }], { $some: { role: "company" } })).toBeNull();
    expect(compare([], { $length: 0, $length_gte: 0 })).toBeNull();
    expect(compare(2, { $gte: 3 })).toBe("expected $gte 3, got 2");
    expect(compare("https://a", { $match: "^https://" })).toBeNull();
  });

  it("evaluates references on both sides, and Poppy errors by step", () => {
    const saved = { a: { id: "1" }, b: { id: "1" }, w: { refused: true, poppy_error: "insufficient_scope" }, ok: { status: 200 } };
    expect(evaluate({ "${b.id}": "${a.id}" }, saved)).toEqual([]);
    expect(evaluate({ step: "w", poppy_error: "insufficient_scope" }, saved)).toEqual([]);
    expect(evaluate({ step: "w", poppy_error: "invalid_token" }, saved)).toHaveLength(1);
    expect(evaluate({ step: "ok", poppy_error: "invalid_token" }, saved)).toEqual(["ok: expected poppy_error invalid_token, but it succeeded"]);
  });

  it("knows which saved steps may be refusals", () => {
    const scenario: Scenario = { id: "X", title: "x", steps: [{ agent: "api", save: "w" }, { expect: { step: "w", poppy_error: "e" } }] };
    expect([...expectedRefusals(scenario)]).toEqual(["w"]);
  });
});

describe("the scenario files", () => {
  it("are well formed, in order, and cover at least the spec's first scenarios", () => {
    const scenarios = loadScenarios();
    const ids = scenarios.map((scenario) => scenario.id);
    for (const id of ["D", "S0", "N", "SD", "SV", "SX", "C", "CI", "SO", "O", "OX", "SE", "R", "AS", "RL"]) expect(ids).toContain(id);
    expect(ids.slice(0, 4)).toEqual(["D", "S0", "N", "SD"]);
    for (const scenario of scenarios) expect(lintScenario(scenario, scenario.id)).toEqual([]);
  });

  it("lint catches references before they are saved, and steps with two actors", () => {
    expect(lintScenario({ id: "X", title: "x", steps: [{ agent: "a", params: { u: "${later.x}" } }, { agent: "b", save: "later" }] }, "X.json")).toEqual([
      "X.json: step 0 refers to ${later} before it is saved"
    ]);
    expect(lintScenario({ id: "X", title: "x", steps: [{ agent: "a", company: "b" }] }, "X.json")).toHaveLength(1);
  });
});

/** A driver whose answers a test scripts per operation. */
function driver(answers: Record<string, Reply>, runner: Record<string, Awaited<ReturnType<Driver["runner"]>>> = {}): Driver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    agent: async (op, params) => {
      calls.push(`agent ${op} ${JSON.stringify(params)}`);
      return answers[op] ?? { kind: "ok", result: {} };
    },
    company: async (hook, params) => {
      calls.push(`company ${hook} ${JSON.stringify(params)}`);
      return answers[hook] ?? { kind: "ok", result: {} };
    },
    runner: async (op) => runner[op] ?? { kind: "ok" }
  };
}

const SD: Scenario = {
  id: "SD",
  title: "Direct",
  steps: [
    { agent: "signin", params: { method: "direct" }, save: "pending" },
    { company: "approve_authorization", params: { url: "${pending.pending.url}", account: "${fixture.accounts.0}" }, save: "consent" },
    { agent: "signin_continue", params: { callback_url: "${consent.redirect}" }, save: "done" },
    { expect: { "${done.signed_in}": true } }
  ]
};

describe("a cell", () => {
  it("passes when every step and expectation holds, threading saved results into later steps", async () => {
    const d = driver({
      signin: { kind: "ok", result: { pending: { url: "https://auth/authorize?x" } } },
      approve_authorization: { kind: "ok", result: { redirect: "https://agent/cb?code=1" } },
      signin_continue: { kind: "ok", result: { signed_in: true } }
    });
    const run = await runCell(SD, { accounts: ["acct_ada"] }, d);
    expect(run.outcome).toBe("pass");
    expect(d.calls).toEqual([
      'agent signin {"method":"direct"}',
      'company approve_authorization {"url":"https://auth/authorize?x","account":"acct_ada"}',
      'agent signin_continue {"callback_url":"https://agent/cb?code=1"}'
    ]);
    expect(run.steps.map((step) => step.ok)).toEqual([true, true, true, true]);
  });

  it("fails on an unexpected refusal or a failed expectation", async () => {
    const refused = await runCell(SD, { accounts: ["a"] }, driver({ signin: { kind: "refused", poppyError: "invalid_client" } }));
    expect(refused.outcome).toBe("fail");
    expect(refused.reason).toContain("refused: invalid_client");
    const notSignedIn = await runCell(SD, { accounts: ["a"] }, driver({
      signin: { kind: "ok", result: { pending: { url: "u" } } },
      approve_authorization: { kind: "ok", result: { redirect: "r" } },
      signin_continue: { kind: "ok", result: { signed_in: false } }
    }));
    expect(notSignedIn.outcome).toBe("fail");
    expect(notSignedIn.reason).toContain("expected true, got false");
  });

  it("fails when a step needs a value an earlier step didn't return", async () => {
    const run = await runCell(SD, { accounts: ["a"] }, driver({ signin: { kind: "ok", result: {} } }));
    expect(run.outcome).toBe("fail");
    expect(run.reason).toContain("${pending.pending.url} refers to nothing");
  });

  it("is unsupported on a 501, unless the step is optional, and errors when an adapter breaks", async () => {
    expect((await runCell(SD, { accounts: ["a"] }, driver({ signin: { kind: "unsupported", detail: "no" } }))).outcome).toBe("unsupported");
    const optional: Scenario = { id: "N", title: "n", steps: [{ company: "require_nonce", optional: true }, { agent: "session" }] };
    expect((await runCell(optional, {}, driver({ require_nonce: { kind: "unsupported", detail: "no" } }))).outcome).toBe("pass");
    expect((await runCell(SD, { accounts: ["a"] }, driver({ signin: { kind: "broken", detail: "connection refused" } }))).outcome).toBe("error");
  });

  it("accepts a refusal a later expectation names, and is unsupported when a trace has nothing to judge", async () => {
    const scenario: Scenario = { id: "AS", title: "as", steps: [{ agent: "api", save: "w" }, { expect: { step: "w", poppy_error: "insufficient_scope" } }, { runner: "assert_trace", params: { check: "nonce_retry" } }] };
    const pass = await runCell(scenario, {}, driver({ api: { kind: "refused", poppyError: "insufficient_scope", status: 403 } }));
    expect(pass.outcome).toBe("pass");
    const inapplicable = await runCell(scenario, {}, driver({ api: { kind: "refused", poppyError: "insufficient_scope" } }, { assert_trace: { kind: "inapplicable", detail: "no nonce" } }));
    expect(inapplicable.outcome).toBe("unsupported");
  });

  it("reads adapter answers as the spec words them", () => {
    expect(toReply(200, { ok: true, result: { a: 1 } }, true)).toEqual({ kind: "ok", result: { a: 1 } });
    expect(toReply(200, { ok: false, poppy_error: "invalid_session", status: 401 }, true)).toEqual({ kind: "refused", poppyError: "invalid_session", status: 401 });
    expect(toReply(200, { redirect: "r" }, false)).toEqual({ kind: "ok", result: { redirect: "r" } });
    expect(toReply(501, { error: "unsupported", detail: "no" }, true)).toEqual({ kind: "unsupported", detail: "no" });
    expect(toReply(400, { error: "invalid_params", detail: "x" }, false)).toEqual({ kind: "failed", status: 400, error: "invalid_params", detail: "x" });
    expect(toReply(0, null, true).kind).toBe("broken");
    expect(toReply(200, { result: 1 }, true).kind).toBe("broken");
  });
});
