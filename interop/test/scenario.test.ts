import { describe, expect, it } from "vitest";
import { runCell, toReply, withScopes, type Driver, type Reply } from "../runner/cell.ts";
import { loadScenarios } from "../runner/cli.ts";
import { compare, evaluate, expectedRefusals, firstOf, inlineFiles, interpolate, lintScenario, lookup, missingFixture, resolveParams } from "../runner/scenario.ts";
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
    expect(compare("orders:read orders:write", { $includes_scope: "orders:write" })).toBeNull();
    expect(compare("orders:readx", { $includes_scope: "orders:read" })).not.toBeNull();
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

  it.each(["C", "CL"])("is unsupported when a live Company lacks conversations for %s, and fails when an adapter claimed it", async id => {
    const C = loadScenarios().find(scenario => scenario.id === id)!;
    const noConversations = () => driver({ discover: { kind: "ok", result: { conversations: false } } });
    const live = await runCell(C, {}, noConversations(), { live: true });
    expect(live.outcome).toBe("unsupported");
    expect(live.reason).toContain(`doesn't offer what ${id} tests`);
    expect((await runCell(C, {}, noConversations())).outcome).toBe("fail");
    // An expectation not marked `offers` still fails against a live Company.
    const S: Scenario = { id: "S0", title: "s", steps: [{ agent: "session", save: "s" }, { expect: { "${s.session_id}": { $exists: true } } }] };
    expect((await runCell(S, {}, driver({ session: { kind: "ok", result: {} } }), { live: true })).outcome).toBe("fail");
  });

  it("keeps real MCP failures distinct from a live Company without MCP", async () => {
    const ML = loadScenarios().find(scenario => scenario.id === "ML")!;
    const absent = () => driver({ discover: { kind: "ok", result: { apis: [] } } });
    expect((await runCell(ML, {}, absent(), { live: true })).outcome).toBe("unsupported");
    expect((await runCell(ML, {}, absent())).outcome).toBe("fail");
    const brokenListing = driver({ discover: { kind: "ok", result: { apis: ["mcp"] } }, mcp_list: { kind: "ok", result: { tools: [] } } });
    expect((await runCell(ML, {}, brokenListing, { live: true })).outcome).toBe("fail");
  });

  it("checks interpolated fixture values while leaving literal parameter keys alone", () => {
    const literalKey: Scenario = { id: "KEY", title: "literal key", steps: [{ agent: "api", params: { "${fixture.not_a_reference}": "literal" } }] };
    expect(resolveParams(literalKey.steps[0]!.params, { fixture: {} })).toEqual({ "${fixture.not_a_reference}": "literal" });
    expect(missingFixture(literalKey, {})).toBeNull();
    const nestedValue: Scenario = { id: "VALUE", title: "nested value", steps: [{ agent: "api", params: { nested: [{ value: "${fixture.required}" }] } }] };
    expect(missingFixture(nestedValue, {})).toBe("fixture.required");
  });

  it("finds the fixture value a scenario's steps can't run without, skipping steps that may go without", () => {
    const publicRead: Scenario = { id: "PUBLIC", title: "public read", steps: [
      { agent: "api", params: { api: "${fixture.openapi_public.api}", operation: "${fixture.openapi_public.operation}", args: "${fixture.openapi_public.args}" } }
    ] };
    expect(missingFixture(publicRead, { prompts: { hello: "Hello" } })).toBe("fixture.openapi_public.api");
    expect(missingFixture(publicRead, { openapi_public: { api: "openapi", operation: "get", args: {} } })).toBeNull();
    const lenient: Scenario = {
      id: "W",
      title: "w",
      steps: [
        { agent: "api", params: { x: "${fixture.optional}" }, when: "${fixture.optional}" },
        { company: "require_nonce", optional: true },
        { runner: "first", params: { of: ["${fixture.a}", "${fixture.b}"] } },
        { agent: "send", params: { text: "say ${fixture.prompts.hello}" } }
      ]
    };
    expect(missingFixture(lenient, { prompts: { hello: "Hello" } })).toBeNull();
    expect(missingFixture(lenient, {})).toBe("fixture.prompts.hello");
  });

  it.each([true, 0, "", false, null, undefined])("checks parameters only when a fixture condition is active (%s)", enabled => {
    const scenario: Scenario = { id: "WHEN", title: "fixture condition", steps: [
      { agent: "api", when: "${fixture.enabled}", params: { account: "${fixture.account}" } }
    ] };
    const active = enabled !== undefined && enabled !== null && enabled !== false;
    expect(missingFixture(scenario, { enabled })).toBe(active ? "fixture.account" : null);
  });

  it("defers runtime conditions and fixture references to earlier results without following a third interpolation pass", () => {
    const scenario: Scenario = { id: "LATER", title: "runtime result", steps: [
      { agent: "api", save: "upload_id" },
      { agent: "api", params: { args: "${fixture.args}" } },
      { agent: "send", when: "${upload_id.held}", params: { account: "${fixture.runtime_only}" } }
    ] };
    expect(lintScenario(scenario, "LATER.json")).toEqual([]);
    const fixture = { args: { photo: "${upload_id}", chain: "${fixture.second}" }, second: "${fixture.third}" };
    expect(missingFixture(scenario, fixture)).toBeNull();
    expect(resolveParams(scenario.steps[1]!.params, { fixture, upload_id: "photo-1" })).toEqual({ args: { photo: "photo-1", chain: "${fixture.third}" } });
  });

  it("defers a second-pass path assembled from an unknown runtime result", () => {
    const scenario: Scenario = { id: "DYNAMIC", title: "runtime-built path", steps: [
      { agent: "api", save: "s" },
      { agent: "api", params: { value: "${fixture.prefix}${s.suffix}" } }
    ] };
    const fixture = { prefix: "${fixture.", present: "available" };
    expect(lintScenario(scenario, "DYNAMIC.json")).toEqual([]);
    expect(missingFixture(scenario, fixture)).toBeNull();
    expect(resolveParams(scenario.steps[1]!.params, { fixture, s: { suffix: "present}" } })).toEqual({ value: "available" });
  });

  it("signs in with the Company's own scopes from its fixture, and none when it names none", async () => {
    expect(withScopes({ accounts: ["a"] }).scopes).toEqual({ read: [], write: [] });
    expect(withScopes({ scopes: { read: ["orders:read"], write: ["orders:read", "orders:write"] } }).scopes).toEqual({ read: ["orders:read"], write: ["orders:read", "orders:write"] });
    // Version 1's list of everything offered is kept, and the defaults still apply.
    expect(withScopes({ scopes: ["orders:read", "addresses"] }).scopes).toEqual({ all: ["orders:read", "addresses"], read: [], write: [] });
    expect(withScopes(null)).toEqual({ scopes: { read: [], write: [] } });
    const scenario: Scenario = {
      id: "SD",
      title: "sd",
      steps: [{ agent: "signin", params: { scopes: "${fixture.scopes.write}" }, save: "done" }, { expect: { "${done.scope}": { $includes_scope: "${fixture.scopes.write}" } } }]
    };
    const d = driver({ signin: { kind: "ok", result: { scope: "orders:write orders:read" } } });
    expect((await runCell(scenario, { scopes: { read: ["orders:read"], write: ["orders:read", "orders:write"] } }, d)).outcome).toBe("pass");
    expect(d.calls).toEqual(['agent signin {"scopes":["orders:read","orders:write"]}']);
    const narrower = driver({ signin: { kind: "ok", result: { scope: "orders:read" } } });
    expect((await runCell(scenario, { scopes: { read: ["orders:read"], write: ["orders:read", "orders:write"] } }, narrower)).outcome).toBe("fail");
  });

  it("runs a step with when only if its reference names something", async () => {
    const scenario: Scenario = {
      id: "AS",
      title: "as",
      steps: [
        { agent: "api", save: "w" },
        { agent: "approve_op", when: "${w.held}", params: { operation: "${w.held}" }, save: "w" },
        { expect: { step: "w", poppy_error: "insufficient_scope" } }
      ]
    };
    const held = driver({ api: { kind: "ok", result: { held: "apr_1" } }, approve_op: { kind: "refused", poppyError: "insufficient_scope", status: 0 } });
    expect((await runCell(scenario, {}, held)).outcome).toBe("pass");
    expect(held.calls).toEqual(["agent api {}", 'agent approve_op {"operation":"apr_1"}']);
    const direct = driver({ api: { kind: "refused", poppyError: "insufficient_scope", status: 403 } });
    const run = await runCell(scenario, {}, direct);
    expect(run.outcome).toBe("pass");
    expect(direct.calls).toEqual(["agent api {}"]);
    expect(run.steps[1]).toMatchObject({ op: "approve_op", ok: true, result: { skipped: "${w.held} is null" } });
    expect(lintScenario({ id: "X", title: "x", steps: [{ agent: "a", when: "w.held" }] }, "X.json")).toEqual(["X.json: step 0 when must be one ${...} reference"]);
    expect(lintScenario({ id: "X", title: "x", steps: [{ agent: "a", when: "${w.held}" }] }, "X.json")).toEqual(["X.json: step 0 refers to ${w} before it is saved"]);
  });

  it("takes an upload's id from whichever step sent it, and resolves the references a fixture's values carry (OU)", async () => {
    const OU = loadScenarios().find((scenario) => scenario.id === "OU")!;
    const fixture = {
      openapi_upload: { api: "openapi", operation: "uploadPhoto", args: { files: { photo: "lake.jpg" } } },
      openapi_propose: { api: "openapi", operation: "orderPrints", args: { body: { items: [{ photo_id: "${upload_id}", copies: 1 }] } } }
    };
    /** Answers in turn, per op. */
    const sequence = (answers: Record<string, Reply[]>): Driver & { calls: string[] } => {
      const calls: string[] = [];
      const next = (op: string): Reply => answers[op]?.shift() ?? { kind: "ok", result: {} };
      return {
        calls,
        agent: async (op, params) => {
          calls.push(`agent ${op} ${JSON.stringify(params)}`);
          return next(op);
        },
        company: async () => ({ kind: "ok", result: {} }),
        runner: async () => ({ kind: "ok" })
      };
    };
    const session: Reply = { kind: "ok", result: { signed_in: false, session_id: "ses_1" } };
    // The task request already obtained Company terms; no preliminary write card.
    const operation = { operation_id: "op_print", revision: "r1" };
    const order: Reply = { kind: "ok", result: { held: "apr2_1", operation } };
    const done: Reply = { kind: "ok", result: { status: "done", approved: operation, result: { status: 201, body: { order: { order_id: "ord_1" } } } } };
    // An agent that asks its User before the photo leaves: held, then approved.
    const held = sequence({
      session: [session, session],
      api: [{ kind: "ok", result: { held: "apr_1" } }, order],
      approve_op: [{ kind: "ok", result: { status: "done", result: { status: 201, body: { id: "pho_1" } } } }, done]
    });
    expect((await runCell(OU, fixture, held)).outcome).toBe("pass");
    expect(held.calls).toContain('agent api {"api":"openapi","operation":"orderPrints","args":{"body":{"items":[{"photo_id":"pho_1","copies":1}]}}}');
    expect(held.calls).toContain('agent approve_op {"operation":"apr2_1","decision":"approve"}');
    // One that sends the photo at once.
    const direct = sequence({
      session: [session, session],
      api: [{ kind: "ok", result: { status: 201, body: { id: "pho_2" } } }, order],
      approve_op: [done]
    });
    expect((await runCell(OU, fixture, direct)).outcome).toBe("pass");
    expect(direct.calls.filter((call) => call.startsWith("agent approve_op"))).toEqual(['agent approve_op {"operation":"apr2_1","decision":"approve"}']);
    expect(direct.calls).toContain('agent api {"api":"openapi","operation":"orderPrints","args":{"body":{"items":[{"photo_id":"pho_2","copies":1}]}}}');
    // An upload that answered no id fails at `first`, before anything is ordered.
    const none = sequence({ session: [session], api: [{ kind: "ok", result: { status: 201, body: {} } }] });
    const run = await runCell(OU, fixture, none);
    expect(run.outcome).toBe("fail");
    expect(run.reason).toContain("runner first");
    expect(none.calls.filter((call) => call.includes("orderPrints"))).toEqual([]);

    // A local held-write decision alone must not pass Operations coverage.
    const noTerms = sequence({ session: [session, session], api: [{ kind: "ok", result: { status: 201, body: { id: "pho_3" } } }, { kind: "ok", result: { held: "apr_local" } }], approve_op: [done] });
    expect((await runCell(OU, fixture, noTerms)).outcome).toBe("fail");
    // Even reported Company terms need a matching recorded approval.
    const noApproval = sequence({ session: [session, session], api: [{ kind: "ok", result: { status: 201, body: { id: "pho_4" } } }, order], approve_op: [{ kind: "ok", result: { status: "done", result: { status: 201 } } }] });
    expect((await runCell(OU, fixture, noApproval)).outcome).toBe("fail");
  });

  it("sends an api step's files to the agent's adapter as name, type and base64, only from interop/files/", () => {
    const read = (name: string) => (name === "lake.jpg" ? new Uint8Array([0xff, 0xd8, 0xff]) : null);
    expect(inlineFiles("api", { api: "openapi", args: { files: { photo: "lake.jpg" }, body: { a: 1 } } }, read)).toEqual({
      api: "openapi",
      args: { files: { photo: { name: "lake.jpg", type: "image/jpeg", data: "/9j/" } }, body: { a: 1 } }
    });
    expect(inlineFiles("send", { args: { files: { photo: "lake.jpg" } } }, read)).toEqual({ args: { files: { photo: "lake.jpg" } } });
    expect(() => inlineFiles("api", { args: { files: { photo: "../secrets.jpg" } } }, read)).toThrow("must name a file in interop/files/");
    expect(() => inlineFiles("api", { args: { files: { photo: "missing.jpg" } } }, read)).toThrow("isn't there");
    expect(resolveParams({ id: "${fixture.ref}" }, { fixture: { ref: "${upload_id}" }, upload_id: "pho_3" })).toEqual({ id: "pho_3" });
    expect(firstOf({ of: ["${a.b}", "${c}"] }, { c: 0 })).toEqual({ found: true, value: 0 });
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

it("allows offers only as true, on an expect step", () => {
  const base = { id: "ZZ", title: "z" };
  expect(lintScenario({ ...base, steps: [{ expect: { "${fixture.x}": true }, offers: true }] }, "ZZ.json")).toEqual([]);
  expect(lintScenario({ ...base, steps: [{ agent: "discover", offers: true }] }, "ZZ.json").some((p) => /offers must be true, on an expect step/.test(p))).toBe(true);
  expect(lintScenario({ ...base, steps: [{ expect: { "${fixture.x}": true }, offers: "yes" }] }, "ZZ.json").some((p) => /offers must be true/.test(p))).toBe(true);
});
