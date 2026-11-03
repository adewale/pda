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
test("a directory is not a stable requirement-evidence file", (t) => {
  const root = fixture(t, "Test: [tests](test/)");
  assert.deepEqual(checkReferences(root).problems, ["pda-spec.md:4: missing file: test/"]);
});

test("all project guides check local fragments, including duplicate headings and explicit aliases", (t) => {
  const root = fixture(t, "Test: [safety](test/safety.test.ts)");
  mkdirSync(path.join(root, "docs/history"));
  writeFileSync(path.join(root, "docs/history/guide.md"), "# Guide\n\n## A heading\n\n## A heading\n\n<a id='stable-alias'></a>\n");
  writeFileSync(path.join(root, "README.md"), "[first](docs/history/guide.md#a-heading)\n[second](docs/history/guide.md#a-heading-1)\n[alias](docs/history/guide.md#stable-alias)\n[missing](docs/history/guide.md#retired-heading)\n");
  assert.deepEqual(checkReferences(root).problems, ["README.md:4: missing anchor: docs/history/guide.md#retired-heading"]);
  writeFileSync(path.join(root, "README.md"), "[fixed](docs/history/guide.md#stable-alias)\n");
  assert.equal(checkReferences(root).problems.length, 0);
});

test("self links and setext headings work, while code and comment examples supply no anchors or links", (t) => {
  const root = fixture(t, "Test: [safety](test/safety.test.ts)");
  writeFileSync(path.join(root, "docs/guide.md"), [
    "Overview", "========", "", "[self](#overview)", "",
    "```md", "## Fenced heading", "[example](missing.md)", "```", "",
    "~~~md", "## Other fence", "[example](also-missing.md)", "~~~", "",
    "<!-- ## Comment heading", "[example](comment.md) -->", "",
    "`[inline example](missing.md)`", "", "[bad](#fenced-heading)"
  ].join("\n"));
  assert.deepEqual(checkReferences(root).problems, ["docs/guide.md:21: missing anchor: guide.md#fenced-heading"]);
});

test("encoded local paths and fragments are decoded separately and cannot escape the repository", (t) => {
  const root = fixture(t, "Test: [safety](test/safety.test.ts)");
  writeFileSync(path.join(root, "docs/file #1.md"), "# Café\n");
  writeFileSync(path.join(root, "README.md"), "[encoded](docs/file%20%231.md#caf%C3%A9)\n[escape](%2e%2e/outside.md)\n[bad encoding](docs/%ZZ.md)\n");
  assert.deepEqual(checkReferences(root).problems, [
    "README.md:2: reference leaves the repository: ../outside.md",
    "README.md:3: invalid URL encoding: docs/%ZZ.md"
  ]);
});

test("directory links use their README for fragments and project links ignore external services", (t) => {
  const root = fixture(t, "Test: [safety](test/safety.test.ts)");
  writeFileSync(path.join(root, "docs/README.md"), "# Documents\n");
  writeFileSync(path.join(root, "README.md"), "[directory](docs/#documents)\n[web](https://example.com/missing#fragment)\n[route](/validator)\n[mail](mailto:maintainer@example.com)\n");
  assert.equal(checkReferences(root).problems.length, 0);
  writeFileSync(path.join(root, "README.md"), "[bad directory fragment](docs/#missing)\n[missing file](docs/missing.md)\n");
  assert.deepEqual(checkReferences(root).problems, [
    "README.md:1: missing anchor: docs/#missing",
    "README.md:2: missing file: docs/missing.md"
  ]);
});
