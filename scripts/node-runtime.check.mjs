/**
 * The deploy check's TypeScript under Node's type stripping, as
 * `npm run deploy` runs it (`node scripts/check-deployment.ts`). Its modules
 * import packages (jose), so this needs `npm ci` and isn't part of
 * test:tooling, which CI runs before installing; CI runs it with the runtime
 * checks (`npm run test:node-runtime`). scripts/node-strip.test.mjs covers the
 * dependency-free validator CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

test("the deploy check's modules load under Node, and a setting's problem names both sides", async () => {
  const { deploymentProblems } = await import("../src/deployment.ts");
  const problems = deploymentProblems({});
  assert.ok(problems.length > 0);
  assert.ok(problems.some((problem) => /: expected .+, got /.test(problem)), problems.join("\n"));
});
