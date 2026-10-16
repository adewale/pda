/**
 * Settings and shared generators for the property suite.
 *
 * Cost: properties use Hegel's default of 100 cases unless overridden.
 * Runtime depends on the property and machine; stateful crypto flows cost more. A deep run is local only: `HEGEL_CASES=5000 npm run
 * test:properties` runs that many cases per property. Hegel derandomizes and
 * keeps no database in CI on its own; locally it keeps failing examples in
 * `.hegel/` (gitignored) and replays them first.
 */
import { afterAll, expect } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

export { gs };

const cases = Number(process.env.HEGEL_CASES ?? "0");

/**
 * Settings for every property: the default case count, or the property's own
 * `testCases`; `HEGEL_CASES`, when set, overrides both.
 */
export function settings(extra: Partial<hegel.Settings> = {}): Partial<hegel.Settings> {
  return { ...extra, ...(cases > 0 ? { testCases: cases } : {}) };
}

/** Run a synchronous property. */
export function property(body: (tc: hegel.TestCase) => void, extra: Partial<hegel.Settings> = {}): () => void {
  return () => hegel.test(body, settings(extra));
}

/** Run an asynchronous property. */
export function propertyAsync(body: (tc: hegel.TestCase) => Promise<void>, extra: Partial<hegel.Settings> = {}): () => Promise<void> {
  return () => hegel.testAsync(body, settings(extra));
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Any JSON value: the full domain of each leaf (any finite double, any
 * string, lone surrogates included), nested up to `depth`, which bounds the
 * value where it is built rather than the domain drawn.
 */
export function jsonValues(depth = 6): gs.Generator<Json> {
  const leaf: gs.Generator<Json> = gs.oneOf<Json>(
    gs.just(null),
    gs.booleans(),
    gs.integers({ minValue: Number.MIN_SAFE_INTEGER, maxValue: Number.MAX_SAFE_INTEGER }),
    gs.floats({ allowNan: false, allowInfinity: false }),
    gs.text()
  );
  if (depth === 0) return leaf;
  const inner = jsonValues(depth - 1);
  return gs.oneOf<Json>(
    leaf,
    gs.arrays(inner, { maxSize: 5 }),
    gs.maps(gs.text(), inner, { maxSize: 5 }).map((map) => Object.fromEntries(map))
  );
}

// Counts describe completed actions in successful examples, not commands drawn
// and then skipped. Initialization is separate from the generated transitions.
const completed = new Map<string, Record<string, number>>();
export function recordTransitions(suite: string, counts: Record<string, number>, expected: number) {
  expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(expected);
  const total = completed.get(suite) ?? {};
  for (const [action, count] of Object.entries(counts)) total[action] = (total[action] ?? 0) + count;
  completed.set(suite, total);
}
afterAll(() => {
  for (const [suite, counts] of completed) console.info(`Executed transitions (${suite}, successful examples): ${JSON.stringify(counts)}`);
});
