#!/usr/bin/env node
/** Reuse the harness's isolation/proxy lifecycle, without treating a validator as an interop peer. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "../../runner/cli.ts";
import { dockerAsync } from "../../runner/docker.ts";
const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);
let checked = false;
let failed = false;
const result = await main(["--agents", "official-validator", "--companies", "lenient-company-v02", "--scenarios", "D", ...process.argv.slice(2)], async ({ containers, runDir }) => {
  // The empty scenario manifest intentionally keeps validator results out of M×N pass rates.
  const container = containers["agent-official-validator"];
  const pin = JSON.parse(readFileSync(path.join(root, "spec/upstream.json"), "utf8"));
  const source = `/repo/${pin.snapshot}/kit/company/validate/index.ts`;
  const { output, code } = await dockerAsync(["exec", "-w", "/state", container, "node", source, "check", "https://lenient-company-v02.company.interop.test", "--json"]);
  const report = JSON.parse(output);
  failed = code !== 0;
  writeFileSync(path.join(runDir, "official-validator.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Official validator report: ${path.join(runDir, "official-validator.json")}`);
  console.log(JSON.stringify(report.summary ?? report.counts ?? { exitCode: code }));
  checked = true;
});
if (!checked) throw new Error("The official validator did not run");
process.exitCode = failed ? 1 : result;
