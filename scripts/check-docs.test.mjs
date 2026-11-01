import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkReferences } from "./check-docs.mjs";

function fixture(t, evidence, status = "Scenario `XH`") {
  const root = mkdtempSync(path.join(tmpdir(), "pda-doc-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["docs", "test", "interop/scenarios"]) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, "pda-spec.md"), `## Appendix A: requirements\n| Rule | Checked by |\n| --- | --- |\n| safe | ${evidence} |\n`);
  writeFileSync(path.join(root, "docs/adversarial-interop.md"), `| \`XH\` | attack | ${status} |\n`);
  writeFileSync(path.join(root, "test/safety.test.ts"), 'test("a title that may change", () => {});\n');
  writeFileSync(path.join(root, "interop/scenarios/XH.json"), "{}");
  return root;
}
test("stable evidence links work without Vitest or test-title discovery", (t) => {
  const root = fixture(t, "Test: [safety](test/safety.test.ts)");
  assert.deepEqual(checkReferences(root), { problems: [], references: 2 });
  writeFileSync(path.join(root, "test/safety.test.ts"), 'test("renamed", () => {});\n');
  assert.equal(checkReferences(root).problems.length, 0);
});
test("missing files and scenarios fail; an unlinked test claim fails", (t) => {
  assert.equal(checkReferences(fixture(t, "Test: [gone](test/missing.ts)", "Scenario `MISSING`")).problems.length, 2);
  assert.match(checkReferences(fixture(t, 'Test: "old title"')).problems[0], /stable file link/);
});
test("references cannot escape the repository", (t) => {
  assert.match(checkReferences(fixture(t, "Test: [outside](../outside.ts)")).problems[0], /leaves the repository/);
});
