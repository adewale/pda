#!/usr/bin/env node
/**
 * Checks that the docs still name real tests:
 *
 * 1. Every test name quoted in the "Checked by" column of Appendix A of
 *    pda-spec.md names a real test. "…" stands for any
 *    text, at the start, middle or end of a name.
 * 2. Every scenario id and test name the Status column of the attack tables
 *    in docs/adversarial-interop.md points at exists: a scenario file in
 *    interop/scenarios/, or a test.
 *
 * The checker does not maintain or validate documentation test-count inventories.
 *
 * `npm test` supplies JSON results from that invocation's full test run,
 * reusing its discovered names (including skipped/failed/parameterized tests).
 * Standalone `npm run check:docs` uses `vitest list` for the same projects.
 * There is no persistent discovery cache and no requirement for tests to pass.
 * Missing or incomplete explicitly supplied evidence fails; it never silently
 * falls back to rediscovery or trusts a prior run.
 *
 * Exits 1 and lists each problem when anything doesn't match.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testConfigs } from "./test-projects.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const SPEC = "pda-spec.md";

/** Every test as { file, name, title }, where name includes the describe blocks and title doesn't. */
function listTests() {
  const dir = mkdtempSync(path.join(tmpdir(), "check-docs-"));
  try {
    return testConfigs.flatMap((config, index) => {
      const out = path.join(dir, `list-${index}.json`);
      const args = ["node_modules/vitest/vitest.mjs", "list", `--json=${out}`, "--config", config];
      execFileSync(process.execPath, args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
      return JSON.parse(readFileSync(out, "utf8")).map((test) => ({
        file: path.relative(root, test.file),
        name: test.name,
        title: test.name.split(" > ").at(-1)
      }));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The quoted test names in Appendix A's "Checked by" column, with their table rows' line numbers. */
function appendixNames() {
  const lines = read(SPEC).split("\n");
  const start = lines.findIndex((line) => /^## Appendix A\b/.test(line));
  if (start === -1) throw new Error(`${SPEC} has no "## Appendix A" section`);
  const names = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const line = lines[i];
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = line.split("|").slice(1, -1);
    const checkedBy = cells.at(-1) ?? "";
    for (const match of checkedBy.matchAll(/"([^"]+)"/g)) names.push({ line: i + 1, name: match[1] });
  }
  return names;
}

/** Match a title/suite suffix in either discovery format; titles may themselves contain " > ". "…" matches any text. */
function pattern(quoted) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^| > )${quoted.split("…").map(escape).join(".*")}$`, "s");
}

/** Read only the full run's invocation-local reports. Never infer success from these names. */
export function testsFromResults(dir, configs = testConfigs) {
  return configs.flatMap((config, index) => {
    const report = JSON.parse(readFileSync(path.join(dir, `${index}.json`), "utf8"));
    if (!Array.isArray(report.testResults) || report.testResults.length === 0) {
      throw new Error(`Incomplete test discovery for ${config}: no collected modules`);
    }
    const tests = report.testResults.flatMap((module) => {
      if (typeof module.name !== "string" || !Array.isArray(module.assertionResults) || module.assertionResults.length === 0) {
        throw new Error(`Incomplete test discovery for ${config}: a module has no declared tests`);
      }
      return module.assertionResults.map((test) => {
        if (typeof test.title !== "string" || !Array.isArray(test.ancestorTitles) || test.ancestorTitles.some((part) => typeof part !== "string")) {
          throw new Error(`Malformed test discovery for ${config}`);
        }
        return { file: path.relative(root, module.name), name: [...test.ancestorTitles, test.title].join(" > "), title: test.title };
      });
    });
    if (report.numTotalTests !== tests.length) throw new Error(`Incomplete test discovery for ${config}: test count differs`);
    return tests;
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--test-results-dir")) throw new Error("Usage: check-docs.mjs [--test-results-dir <invocation-local directory>]");
  const tests = args.length ? testsFromResults(args[1]) : listTests();


  const problems = [];

  const names = appendixNames();
  for (const { line, name } of names) {
    const re = pattern(name);
    if (!tests.some((test) => re.test(test.name))) {
      problems.push(`${SPEC}:${line}: Appendix A names a test that doesn't exist: "${name}"`);
    }
  }

  // docs/adversarial-interop.md: every scenario id and test name the X/Y attack tables'
  // Status column points at must exist (a scenario file, or a test `vitest list` knows).
  const ADVERSARIAL = "docs/adversarial-interop.md";
  function adversarialStatuses() {
    const found = { scenarios: [], tests: [] };
    read(ADVERSARIAL).split("\n").forEach((line, index) => {
      const row = /^\|\s*`([A-Z][A-Z0-9]*)`\s*\|.*\|([^|]*)\|\s*$/.exec(line);
      if (!row) return;
      const at = `${ADVERSARIAL}:${index + 1}`;
      const status = row[2];
      for (const m of status.matchAll(/\b[Ss]cenarios?\s+`([A-Z][A-Z0-9]*)`/g)) found.scenarios.push({ at, id: m[1] });
      // A test/row the Status column points at is quoted after "check", "test" or "TAMPERS".
      for (const m of status.matchAll(/(?:check|test|TAMPERS)s?\s+`?"([^"]+)"/g)) found.tests.push({ at, name: m[1] });
    });
    return found;
  }
  const { scenarios: advScenarios, tests: advTests } = adversarialStatuses();
  const scenariosDir = path.join(root, "interop", "scenarios");
  for (const { at, id } of advScenarios) {
    if (!existsSync(path.join(scenariosDir, `${id}.json`))) {
      problems.push(`${at}: names scenario ${id}, but interop/scenarios/${id}.json doesn't exist`);
    }
  }
  for (const { at, name } of advTests) {
    const re = pattern(name);
    if (!tests.some((test) => re.test(test.name))) {
      problems.push(`${at}: names a test that doesn't exist: "${name}"`);
    }
  }

  const files = new Set(tests.map((test) => test.file));
  console.log(
    `${tests.length} tests in ${files.size} files; ${names.length} test names in Appendix A; ` +
      `${advScenarios.length} scenarios and ${advTests.length} tests named in ${ADVERSARIAL}.`
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log("Documented test and scenario references exist (this does not establish behavioral coverage).");

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
