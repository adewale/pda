/**
 * The TypeScript that Node runs by stripping types (Node 22.18+, 23.6+ and
 * 24, as package.json's scripts do): the validator CLI. Vite, which runs the
 * other tests, accepts syntax that stripping refuses, such as a
 * constructor's parameter properties or an enum, so only running it under
 * Node catches it. Offline and dependency-free, as test:tooling is (CI runs
 * it before npm ci): the CLI checks a document on standard input. The deploy
 * check's chain needs packages, so scripts/node-runtime.check.mjs covers it
 * after npm ci.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function validate(document, ...args) {
  return spawnSync(process.execPath, ["scripts/poppy-validate.ts", ...args, "-"], { cwd: root, input: document, encoding: "utf8" });
}

test("the validator CLI runs under Node and says what it expected and what it got", () => {
  const broken = validate('{"protocol_version":"1.0",}');
  assert.equal(broken.stderr, "");
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /error \[json-syntax\] line 1, column 27: expected a member name in double quotes, got "\}"\./);
  const valid = validate(JSON.stringify({ protocol_version: "1.0", organization: { name: "Example", domain: "example.com" }, web: {} }), "--domain", "example.com");
  assert.equal(valid.stderr, "");
  assert.equal(valid.status, 0);
});
