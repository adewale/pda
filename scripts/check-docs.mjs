#!/usr/bin/env node
/**
 * Checks that the docs still describe the tests:
 *
 * 1. Every test name quoted in the "Checked by" column of Appendix A of
 *    durable-personal-agent-spec.md names a real test. "…" stands for any
 *    text, at the start, middle or end of a name.
 * 2. Every test count the docs claim matches the suite: "runs N tests",
 *    "N tests passing", "in N files", "passes N conformance tests" (the Poppy
 *    tests), and the per-file rows of the Testing and conformance table.
 *
 * Test names come from `vitest list`, so names made by `it.each` or by a
 * loop over a table are checked as Vitest will run them. Each Vitest config
 * named with --config in package.json's "test" script is listed; with none,
 * Vitest's default config is. Needs only Node and the project's own Vitest.
 *
 * Exits 1 and lists each problem when anything doesn't match.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const SPEC = "durable-personal-agent-spec.md";
const DOCS = ["README.md", SPEC];

/** The Vitest configs `npm test` runs. */
function testConfigs() {
  const script = JSON.parse(read("package.json")).scripts?.test ?? "";
  const configs = [...script.matchAll(/(?:--config[= ]|-c )(\S+)/g)].map((m) => m[1]);
  return configs.length > 0 ? configs : [null];
}

/** Every test as { file, name, title }, where name includes the describe blocks and title doesn't. */
function listTests() {
  const dir = mkdtempSync(path.join(tmpdir(), "check-docs-"));
  try {
    return testConfigs().flatMap((config, index) => {
      const out = path.join(dir, `list-${index}.json`);
      const args = ["vitest", "list", `--json=${out}`, ...(config ? ["--config", config] : [])];
      execFileSync("npx", args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
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

/** "…" in a doc's quotation stands for any text. */
function pattern(quoted) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${quoted.split("…").map(escape).join(".*")}$`, "s");
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const number = (text) => (/^\d+$/.test(text) ? Number(text) : WORDS.indexOf(text.toLowerCase()));

/** Test counts the docs claim, each with what it should equal. */
function countClaims(tests) {
  const byFile = new Map();
  for (const test of tests) byFile.set(test.file, (byFile.get(test.file) ?? 0) + 1);
  const claims = [];
  for (const doc of DOCS) {
    read(doc).split("\n").forEach((line, index) => {
      const at = `${doc}:${index + 1}`;
      for (const m of line.matchAll(/\bruns (\d+) tests\b|\b(\d+) tests passing\b/g)) {
        claims.push({ at, what: "tests in all", claimed: Number(m[1] ?? m[2]), actual: tests.length });
      }
      for (const m of line.matchAll(/\b(\d+|[a-z]+) tests? in (\d+|[a-z]+) files\b|\btests\b[^.]*?\bin (\d+|[a-z]+) files\b/gi)) {
        const files = number(m[2] ?? m[3]);
        if (files >= 0) claims.push({ at, what: "test files", claimed: files, actual: byFile.size });
      }
      for (const m of line.matchAll(/\bpasses (\d+) conformance tests\b/g)) {
        claims.push({ at, what: "test/poppy.test.ts tests", claimed: Number(m[1]), actual: byFile.get("test/poppy.test.ts") ?? 0 });
      }
      const row = /^\|\s*`(test\/[^`]+\.test\.tsx?)`\s*\|\s*(\d+)\s*\|/.exec(line);
      if (row) claims.push({ at, what: `${row[1]} tests`, claimed: Number(row[2]), actual: byFile.get(row[1]) ?? 0 });
    });
  }
  return { claims, byFile };
}

const tests = listTests();
const problems = [];

const names = appendixNames();
for (const { line, name } of names) {
  const re = pattern(name);
  if (!tests.some((test) => re.test(test.title))) {
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
  if (!tests.some((test) => re.test(test.title))) {
    problems.push(`${at}: names a test that doesn't exist: "${name}"`);
  }
}

const { claims, byFile } = countClaims(tests);
for (const claim of claims) {
  if (claim.claimed !== claim.actual) {
    problems.push(`${claim.at}: says ${claim.claimed} ${claim.what}; there are ${claim.actual}`);
  }
}

console.log(
  `${tests.length} tests in ${byFile.size} files; ${names.length} test names in Appendix A; ${claims.length} test counts in the docs; ` +
    `${advScenarios.length} scenarios and ${advTests.length} tests named in ${ADVERSARIAL}.`
);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log("Docs match the tests.");
