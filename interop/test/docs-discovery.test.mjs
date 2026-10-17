import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testsFromResults } from "../../scripts/check-docs.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function evidence(report) {
  const dir = mkdtempSync(path.join(tmpdir(), "pda-discovery-control-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "0.json"), JSON.stringify(report));
  return dir;
}
const declared = (title, status) => ({ title, ancestorTitles: ["a suite"], status });
const report = (assertionResults) => ({ numTotalTests: assertionResults.length, testResults: [{ name: "/tests/declared.test.ts", assertionResults }] });

describe("documentation references reuse full-run discovery independently of assertions", () => {
  it("keeps expanded parameter titles, failures, skipped and todo tests without claiming they passed", () => {
    const dir = evidence(report([declared("accepts ES256", "passed"), declared("accepts RS256", "failed"), declared("deployment identity", "pending"), declared("future case", "todo")]));
    expect(testsFromResults(dir, ["one project"]).map((test) => [test.name, test.title])).toEqual([
      ["a suite > accepts ES256", "accepts ES256"], ["a suite > accepts RS256", "accepts RS256"],
      ["a suite > deployment identity", "deployment identity"], ["a suite > future case", "future case"]
    ]);
  });
  it("rejects a partial set of projects instead of silently falling back", () => {
    expect(() => testsFromResults(evidence(report([declared("one", "passed")])), ["one", "missing"])).toThrow(/ENOENT/);
  });
  it.each([
    { numTotalTests: 0, testResults: [] },
    { numTotalTests: 0, testResults: [{ name: "/bad.test.ts", assertionResults: [], status: "failed" }] },
    { ...report([declared("one", "passed")]), numTotalTests: 2 },
    report([{ title: "one" }])
  ])("rejects incomplete or malformed collection evidence %#", (broken) => {
    expect(() => testsFromResults(evidence(broken), ["broken"])).toThrow(/Incomplete|Malformed/);
  });
});

// Exercise the orchestration contract using a tiny local Vitest stand-in.
// No real tests, workerd runtime or external command is needed by this fixture.
function checkout(title = "expanded title") {
  const root = mkdtempSync(path.join(tmpdir(), "pda-test-orchestration-"));
  dirs.push(root);
  for (const dir of ["scripts", "docs", "node_modules/vitest"]) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ["run-tests.mjs", "check-docs.mjs", "test-projects.mjs"]) copyFileSync(path.resolve("scripts", file), path.join(root, "scripts", file));
  writeFileSync(path.join(root, "pda-spec.md"), '## Appendix A\n| Requirement | Checked by |\n| --- | --- |\n| one | ' + JSON.stringify(title) + ' |\n');
  writeFileSync(path.join(root, "docs/adversarial-interop.md"), "No scenario references in this fixture.\n");
  writeFileSync(path.join(root, "node_modules/vitest/vitest.mjs"), `
    import { appendFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    const args = process.argv.slice(2);
    appendFileSync("calls", args[0] + "\\n");
    const test = { title: ${JSON.stringify(title)}, ancestorTitles: ["parameters"], status: process.env.FAKE_FAILURE ? "failed" : "pending" };
    if (args[0] === "list") {
      writeFileSync(args.find((arg) => arg.startsWith("--json=")).slice(7), JSON.stringify([{ file: path.resolve("declared.test.ts"), name: "parameters > " + ${JSON.stringify(title)} }]));
    } else if (!process.env.FAKE_MISSING_REPORT) {
      const out = args.find((arg) => arg.startsWith("--outputFile.json=")).slice("--outputFile.json=".length);
      writeFileSync(out, JSON.stringify({ numTotalTests: 1, testResults: [{ name: path.resolve("declared.test.ts"), assertionResults: [test] }] }));
    }
    process.exitCode = process.env.FAKE_FAILURE ? 1 : 0;
  `);
  return root;
}
function run(root, script, extra = {}) {
  return spawnSync(process.execPath, ["scripts/" + script], { cwd: root, encoding: "utf8", env: { ...process.env, ...extra } });
}
describe("full-run discovery and standalone checking remain independent", () => {
  it("checks references even when assertions fail and preserves the failed exit status", () => {
    const root = checkout();
    const result = run(root, "run-tests.mjs", { FAKE_FAILURE: "1" });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Documented test and scenario references exist");
    expect(result.status).toBe(1);
    expect(readCalls(root)).toEqual(Array(5).fill("run"));
  });
  it("fails missing reports without performing duplicate discovery", () => {
    const root = checkout();
    const result = run(root, "run-tests.mjs", { FAKE_MISSING_REPORT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ENOENT");
    expect(readCalls(root)).toEqual(Array(5).fill("run"));
  });
  it("matches the same title containing the suite separator through both discovery paths", () => {
    for (const script of ["run-tests.mjs", "check-docs.mjs"]) {
      const result = run(checkout("expanded > title"), script);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });
  it("can check documentation alone without executing tests or requiring a previous run", () => {
    const root = checkout();
    expect(existsSync(path.join(root, "calls"))).toBe(false);
    const result = run(root, "check-docs.mjs");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Documented test and scenario references exist");
    expect(readCalls(root)).toEqual(Array(5).fill("list"));
  });
});
function readCalls(root) {
  return readFileSync(path.join(root, "calls"), "utf8").trim().split("\n");
}
