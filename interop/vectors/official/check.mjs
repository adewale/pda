/** Run the pinned, unmodified official Company validator inside its container, against one Company of the run. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dockerAsync } from "../../runner/docker.ts";

const root = path.resolve(import.meta.dirname, "../../..");

/** The Company's origin in the local lane (interop/runner/cli.ts `domainOf`). */
export const companyOrigin = (name) => `https://${name}.company.interop.test`;

/**
 * `check <origin> --json` in the validator's container. Returns its report and
 * exit code (0: no MUST failed, 1: a MUST failed); throws if it never ran or
 * printed no report. The report is written to `<runDir>/<file>`.
 */
export async function officialCheck({ containers, runDir }, company, file = `official-validator-${company}.json`) {
  const container = containers["agent-official-validator"];
  if (!container) throw new Error("No official validator container in this run");
  const pin = JSON.parse(readFileSync(path.join(root, "spec/upstream.json"), "utf8"));
  const source = `/repo/${pin.snapshot}/kit/company/validate/index.ts`;
  const { output, code } = await dockerAsync(["exec", "-w", "/state", container, "node", source, "check", companyOrigin(company), "--json"]);
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    throw new Error(`The official validator printed no report for ${company} (exit ${code}): ${output.slice(0, 300)}`);
  }
  writeFileSync(path.join(runDir, file), `${JSON.stringify(report, null, 2)}\n`);
  return { report, code, file };
}

/** pass/fail/warn/skip counts over the whole report. */
export const totals = (report) => report.summary?.total ?? { pass: 0, fail: 0, warn: 0, skip: 0 };
