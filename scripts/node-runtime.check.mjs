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
import { readFileSync } from "node:fs";

test("the deploy check's modules load under Node, and a setting's problem names both sides", async () => {
  const { deploymentProblems } = await import("../src/deployment.ts");
  const problems = deploymentProblems({});
  assert.ok(problems.length > 0);
  assert.ok(problems.some((problem) => /: expected .+, got /.test(problem)), problems.join("\n"));
});

/** A var's value as wrangler.jsonc commits it. */
function committed(name) {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const found = new RegExp(`"${name}":\\s*("[^"]*"|\\d+)`).exec(text);
  assert.ok(found, `wrangler.jsonc names ${name}`);
  return JSON.parse(found[1]);
}

test("the committed models resolve in the catalogs this install ships, and a renamed one is caught before a deploy", async () => {
  const { modelCatalogProblems } = await import("../src/model-catalog.ts");
  const vars = Object.fromEntries(["DEMO_GATEWAY_ID", "DEMO_MODEL_ID", "ANTHROPIC_MODEL_ID", "OPENAI_MODEL_ID", "THINKING_LEVEL"].map((name) => [name, committed(name)]));
  assert.deepEqual(modelCatalogProblems(vars), []);
  // The spelling AI Gateway's catalog stopped answering to, as pi 1.3 and agents 0.28 accepted it.
  const dashed = modelCatalogProblems({ ...vars, DEMO_MODEL_ID: "anthropic/claude-sonnet-5-5" });
  assert.equal(dashed.length, 1, dashed.join("\n"));
  assert.match(dashed[0], /^DEMO_MODEL_ID: expected a model in AI Gateway's catalog/);
  assert.match(dashed[0], /claude-sonnet-5\.5/);
  const ownKey = modelCatalogProblems({ ...vars, OPENAI_MODEL_ID: "gpt-retired" });
  assert.equal(ownKey.length, 1, ownKey.join("\n"));
  assert.match(ownKey[0], /^OPENAI_MODEL_ID: expected a model in pi-ai's openai catalog, got "gpt-retired"/);
});
