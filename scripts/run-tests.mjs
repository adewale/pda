#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { testConfigs } from "./test-projects.mjs";

if (process.argv.length > 2) throw new Error("npm test runs the full suite; use a targeted Vitest command for filters.");
const root = path.resolve(import.meta.dirname, "..");
let failed = false;
for (const config of testConfigs) {
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", config], { cwd: root, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  failed ||= result.status !== 0;
  if (result.signal || result.error) break;
}
process.exitCode = failed ? 1 : 0;
