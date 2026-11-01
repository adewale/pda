import { test } from "node:test";
import assert from "node:assert/strict";
import { scope } from "./ci-scope.mjs";

test("documentation-only PRs omit runtimes; main always runs everything", () => {
  assert.deepEqual(scope(["README.md", "docs/interop-results/run.json"]), { runtime: false, specialist: false });
  assert.deepEqual(scope([], true), { runtime: true, specialist: true });
});
test("frontend changes retain runtime tests; server, config and unknown inputs retain specialist checks", () => {
  assert.deepEqual(scope(["docs/ecosystem.md"]), { runtime: true, specialist: false });
  assert.deepEqual(scope(["src/ui/chat.tsx", "test/ui/chat.test.tsx"]), { runtime: true, specialist: false });
  for (const file of ["src/poppy/approvals.ts", "src/log.ts", "test/hosted/worker.ts", "spec/upstream.json", "package-lock.json", ".github/workflows/ci.yml", "new-build-input"]) {
    assert.deepEqual(scope([file]), { runtime: true, specialist: true }, file);
  }
  assert.deepEqual(scope(["src/ui/chat.tsx", "src/poppy/approvals.ts"]), { runtime: true, specialist: true });
});
