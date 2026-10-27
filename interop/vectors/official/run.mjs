#!/usr/bin/env node
/**
 * The pinned, unmodified official Company validator against the 0.2 Companies
 * of the local grid, one-sided: our mock and the independent SDK Companies.
 * Reuses the harness's isolation/proxy lifecycle without treating a validator
 * as an interop peer.
 *
 *   node interop/vectors/official/run.mjs [--targets a,b] [runner options]
 *
 * Fails when the validator never runs against a target, or finds a MUST
 * failure in our own mock. Another project's failure is a finding to judge,
 * not a failure of this script.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "../../runner/cli.ts";
import { officialCheck, totals } from "./check.mjs";

export const TARGETS = ["lenient-company-v02", "datalayer-ts-v02", "datalayer-py-v02"];
const OURS = new Set(["lenient-company-v02"]);

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);
const argv = process.argv.slice(2);
const at = argv.indexOf("--targets");
const targets = at === -1 ? TARGETS : argv[at + 1].split(",").filter(Boolean);
const passed = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];

const checked = new Map();
let failed = false;
const result = await main(["--agents", "official-validator", "--companies", targets.join(","), "--scenarios", "D", ...passed], async (context) => {
  // The empty scenario manifest intentionally keeps validator results out of M×N pass rates.
  for (const company of targets) {
    const { report, code, file } = await officialCheck(context, company);
    checked.set(company, { file, exitCode: code, total: totals(report), failed: report.results.filter((x) => x.status === "fail").map((x) => x.id), warned: report.results.filter((x) => x.status === "warn").map((x) => x.id) });
    if (code !== 0 && OURS.has(company)) failed = true;
    console.log(`Official validator × ${company}: ${JSON.stringify(totals(report))} → ${path.join(context.runDir, file)}`);
  }
  writeFileSync(path.join(context.runDir, "official-validator.json"), `${JSON.stringify(Object.fromEntries(checked), null, 2)}\n`);
});
const missing = targets.filter((company) => !checked.has(company));
if (missing.length) throw new Error(`The official validator did not run against ${missing.join(", ")}`);
process.exitCode = failed ? 1 : result;
