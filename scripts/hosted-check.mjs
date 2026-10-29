#!/usr/bin/env node
/** Read-only live receipt. Stop if the ephemeral strict mock restarted or a protocol check failed. */
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const [mode, directory, expectedRaw = "1"] = process.argv.slice(2);
try {
  assert.ok(["start", "finish"].includes(mode) && directory, "Usage: hosted-check.mjs start|finish <prepared-directory> [expected-performs]");
  const read = name => {
    const file = path.join(directory, name);
    assert.equal(statSync(file).mode & 0o077, 0, `${name} must have permissions 0600`);
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const manifest = read("manifest.json");
  const secrets = read("company.secrets.json");
  const response = await fetch(`${manifest.companyOrigin}/__evidence`, { headers: { Authorization: `Bearer ${secrets.COMPANY_CONTROL_SECRET}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, "Company evidence requires the configured control secret");
  const current = await response.json();
  assert.match(current.instanceId, /^[a-f0-9-]{36}$/);
  for (const key of ["startedAt", "performs", "requests", "violations", "warnings"]) assert.ok(Number.isSafeInteger(current[key]) && current[key] >= 0, "Malformed bounded counters");
  assert.equal(current.violations, 0, "Strict Company recorded a protocol violation");
  assert.equal(current.warnings, 0, "Strict Company recorded a protocol warning");
  const baseline = path.join(directory, "baseline.json");
  if (mode === "start") {
    writeFileSync(baseline, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write("Baseline recorded. Complete the real browser journey, then run finish.\n");
  } else {
    const before = read("baseline.json");
    assert.equal(current.instanceId, before.instanceId, "Company instance changed: this run is invalid; start a fresh sign-in and baseline");
    const expected = Number(expectedRaw);
    assert.ok(Number.isSafeInteger(expected) && expected >= 0, "Expected performs must be a nonnegative integer");
    assert.equal(current.performs - before.performs, expected, "Company performed an unexpected number of actions");
    const receipt = { before, after: current, performs: current.performs - before.performs, instanceUnchanged: true, authentication: "Operator must verify actual GitHub OAuth in Chromium; this script checks Company counters only", liveBrowserVerifiedByScript: false };
    writeFileSync(path.join(directory, "live-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }
} catch (error) {
  process.stderr.write(`hosted-check: ${error instanceof Error ? error.message : "verification failed"}\n`);
  process.exitCode = 1;
}
