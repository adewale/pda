// Runs the pinned official Company validator's CLI, unmodified, in file mode
// (`check --file <doc> --json`: schema and field rules, no network) over the
// corpus's 0.2 documents, inside the container run.mjs starts with no network.
// Mounted read-only: /repo/spec (the verified snapshot), /corpus. Writable:
// /out, and /work for the CLI's .poppy/last-results.json.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const pin = JSON.parse(readFileSync("/repo/spec/upstream.json", "utf8"));
const cli = `/repo/${pin.snapshot}/kit/company/validate/index.ts`;
const manifest = JSON.parse(readFileSync("/corpus/manifest.json", "utf8"));
const results = {};
for (const entry of manifest.filter((item) => item.version === "0.2")) {
  const run = spawnSync("node", [cli, "check", "--file", `/corpus/docs/${entry.file}`, "--json"], { cwd: "/work", encoding: "utf8" });
  try {
    const report = JSON.parse(run.stdout);
    const failing = report.results.filter((x) => x.status === "fail" || x.status === "warn");
    results[entry.file] = {
      // The CLI exits 1 exactly when a MUST check failed; a SHOULD is a warning.
      valid: run.status === 0,
      findings: failing.map((x) => `${x.status === "fail" ? "error" : "warning"}:${x.id}`)
    };
  } catch (error) {
    results[entry.file] = { valid: null, findings: [`crash:exit ${run.status}: ${(run.stderr || String(error)).slice(0, 200)}`] };
  }
}
writeFileSync("/out/official.json", JSON.stringify(results, null, 2));
console.log(`official: ${Object.keys(results).length} reports`);
