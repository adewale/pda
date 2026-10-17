#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testConfigs } from "./test-projects.mjs";

if (process.argv.length > 2) throw new Error("npm test runs the full suite; use a targeted Vitest command for filters.");

const root = path.resolve(import.meta.dirname, "..");
// Reports come from this invocation, never an implicitly reused cache.
// Cross-run caching would require source, config and environment invalidation.
const dir = mkdtempSync(path.join(tmpdir(), "pda-test-discovery-"));
let failed = false;
try {
  for (const [index, config] of testConfigs.entries()) {
    const result = spawnSync(process.execPath, [
      "node_modules/vitest/vitest.mjs", "run", "--config", config,
      "--reporter=default", "--reporter=json", `--outputFile.json=${path.join(dir, `${index}.json`)}`
    ], { cwd: root, stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    failed ||= result.status !== 0;
    if (result.signal || result.error) break;
  }
  // Assertions may fail while discovery is complete. Check documentation
  // independently and retain the original test failure either way.
  const docs = spawnSync(process.execPath, ["scripts/check-docs.mjs", "--test-results-dir", dir], { cwd: root, stdio: "inherit" });
  if (docs.error) console.error(docs.error.message);
  failed ||= docs.status !== 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
