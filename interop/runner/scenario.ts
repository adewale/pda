/**
 * Scenarios are data (spec section 6). This file interprets them: `${...}`
 * references to saved results, and `expect` comparisons. Pure functions.
 */
import type { Expectations, Scenario, Step } from "./types.ts";

export type Saved = Record<string, unknown>;

export class ScenarioError extends Error {
  override name = "ScenarioError";
}

const WHOLE = /^\$\{([^}]+)\}$/;
const PART = /\$\{([^}]+)\}/g;

/** `a.b.0.c` into saved values: object members and array indexes. */
export function lookup(path: string, saved: Saved): unknown {
  let value: unknown = saved;
  for (const part of path.trim().split(".")) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) && /^\d+$/.test(part)) value = value[Number(part)];
    else if (typeof value === "object") value = (value as Record<string, unknown>)[part];
    else return undefined;
  }
  return value;
}

/**
 * Replace references in a value. A string that is exactly one reference
 * becomes the referenced value, whatever its type; references inside a
 * longer string are spliced in as text. With `strict`, a reference to
 * nothing is an error (the step can't run without it).
 */
export function interpolate(value: unknown, saved: Saved, strict = true): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) {
      const found = lookup(whole[1]!, saved);
      if (found === undefined && strict) throw new ScenarioError(`\${${whole[1]}} refers to nothing`);
      return found;
    }
    return value.replace(PART, (_match, path: string) => {
      const found = lookup(path, saved);
      if (found === undefined && strict) throw new ScenarioError(`\${${path}} refers to nothing`);
      return typeof found === "string" ? found : JSON.stringify(found);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, saved, strict));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, saved, strict)]));
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Every member of `pattern` is in `value`, recursively. */
function matches(value: unknown, pattern: unknown): boolean {
  if (pattern !== null && typeof pattern === "object" && !Array.isArray(pattern)) {
    if (value === null || typeof value !== "object") return false;
    return Object.entries(pattern).every(([key, item]) => matches((value as Record<string, unknown>)[key], item));
  }
  return deepEqual(value, pattern);
}

const OPERATORS = new Set(["$exists", "$in", "$ne", "$contains", "$gte", "$lte", "$length", "$length_gte", "$some", "$match", "$includes_scope"]);

function isOperator(expected: unknown): expected is Record<string, unknown> {
  return (
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    Object.keys(expected).length > 0 &&
    Object.keys(expected).every((key) => OPERATORS.has(key))
  );
}

/** One comparison: a value, or operators such as `{"$in": [...]}`. Returns why it failed, or null. */
export function compare(actual: unknown, expected: unknown): string | null {
  const show = (value: unknown) => JSON.stringify(value) ?? "undefined";
  if (!isOperator(expected)) {
    return deepEqual(actual, expected) ? null : `expected ${show(expected)}, got ${show(actual)}`;
  }
  for (const [operator, operand] of Object.entries(expected)) {
    let ok: boolean;
    switch (operator) {
      case "$exists":
        ok = (actual !== undefined && actual !== null) === Boolean(operand);
        break;
      case "$in":
        ok = Array.isArray(operand) && operand.some((item) => deepEqual(actual, item));
        break;
      case "$ne":
        ok = !deepEqual(actual, operand);
        break;
      case "$contains":
        ok = typeof actual === "string" ? actual.includes(String(operand)) : Array.isArray(actual) && actual.some((item) => deepEqual(item, operand));
        break;
      case "$includes_scope":
        // One scope, or every scope of a list (a fixture's `scopes.read`).
        ok = typeof actual === "string" && (Array.isArray(operand) ? operand : [operand]).every((scope) => actual.split(" ").includes(String(scope)));
        break;
      case "$gte":
        ok = typeof actual === "number" && actual >= Number(operand);
        break;
      case "$lte":
        ok = typeof actual === "number" && actual <= Number(operand);
        break;
      case "$length":
        ok = Array.isArray(actual) && actual.length === Number(operand);
        break;
      case "$length_gte":
        ok = Array.isArray(actual) && actual.length >= Number(operand);
        break;
      case "$some":
        ok = Array.isArray(actual) && actual.some((item) => matches(item, operand));
        break;
      case "$match":
        ok = typeof actual === "string" && new RegExp(String(operand)).test(actual);
        break;
      default:
        ok = false;
    }
    if (!ok) return `expected ${operator} ${show(operand)}, got ${show(actual)}`;
  }
  return null;
}

/** A saved step result that was a refusal: `{ok: false, poppy_error}` as the adapter answered it. */
export type Refusal = { readonly refused: true; readonly poppy_error: string; readonly status?: number; readonly detail?: string };

export function isRefusal(value: unknown): value is Refusal {
  return value !== null && typeof value === "object" && (value as Refusal).refused === true;
}

/** Check one `expect` block against saved values. Returns failures, empty when all hold. */
export function evaluate(expectations: Expectations, saved: Saved): string[] {
  const list = Array.isArray(expectations) ? expectations : [expectations];
  const failures: string[] = [];
  for (const block of list as Readonly<Record<string, unknown>>[]) {
    if (typeof block.step === "string") {
      const result = saved[block.step];
      if ("poppy_error" in block) {
        if (!isRefusal(result)) failures.push(`${block.step}: expected poppy_error ${String(block.poppy_error)}, but it succeeded`);
        else {
          const why = compare(result.poppy_error, block.poppy_error);
          if (why) failures.push(`${block.step}.poppy_error: ${why}`);
        }
      }
      continue;
    }
    for (const [reference, expected] of Object.entries(block)) {
      const actual = interpolate(reference, saved, false);
      const target = isOperator(expected) ? interpolate(expected, saved, false) : interpolate(expected, saved, false);
      const why = compare(actual, target);
      if (why) failures.push(`${reference}: ${why}`);
    }
  }
  return failures;
}

/** Saved names whose refusals a later `expect` accounts for: those steps may fail with a Poppy error. */
export function expectedRefusals(scenario: Scenario): Set<string> {
  const names = new Set<string>();
  for (const step of scenario.steps) {
    if (!step.expect) continue;
    for (const block of (Array.isArray(step.expect) ? step.expect : [step.expect]) as Readonly<Record<string, unknown>>[]) {
      if (typeof block.step === "string" && "poppy_error" in block) names.add(block.step);
    }
  }
  return names;
}

export function actorOf(step: Step): { actor: "agent" | "company" | "runner" | "expect"; op: string } {
  if (step.agent) return { actor: "agent", op: step.agent };
  if (step.company) return { actor: "company", op: step.company };
  if (step.runner) return { actor: "runner", op: step.runner };
  if (step.expect) return { actor: "expect", op: "expect" };
  throw new ScenarioError("A step names no actor");
}

/** Problems with a scenario file, empty when it is well formed. */
export function lintScenario(value: unknown, file: string): string[] {
  const problems: string[] = [];
  if (value === null || typeof value !== "object") return [`${file}: not an object`];
  const scenario = value as Partial<Scenario>;
  if (typeof scenario.id !== "string" || !/^[A-Z][A-Z0-9]{0,7}$/.test(scenario.id)) problems.push(`${file}: id must be a short upper-case name`);
  if (typeof scenario.title !== "string") problems.push(`${file}: no title`);
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) return [...problems, `${file}: no steps`];
  const saved = new Set<string>(["fixture"]);
  scenario.steps.forEach((step, index) => {
    const actors = ["agent", "company", "runner", "expect"].filter((key) => key in (step as object));
    if (actors.length !== 1) problems.push(`${file}: step ${index} must name exactly one of agent, company, runner or expect`);
    if (step.when !== undefined && (typeof step.when !== "string" || !/^\$\{[^}]+\}$/.test(step.when))) {
      problems.push(`${file}: step ${index} when must be one \${...} reference`);
    }
    const references = JSON.stringify([step.params ?? null, step.when ?? null]).match(/\$\{([^}.]+)/g) ?? [];
    for (const reference of references) {
      const name = reference.slice(2);
      if (!saved.has(name)) problems.push(`${file}: step ${index} refers to \${${name}} before it is saved`);
    }
    if (step.save) saved.add(step.save);
  });
  return problems;
}
