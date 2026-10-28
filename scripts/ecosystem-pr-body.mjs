#!/usr/bin/env node
/** PR prose from numeric receipts and immutable screenshot URLs, without copying untrusted source text. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function surveyPrBody(report, { repository, commit, evidence }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(commit) || !/^docs\/evidence\/ecosystem-\d{4}-\d{2}-\d{2}$/.test(evidence)) throw new Error("Expected repository, immutable commit and dated evidence path");
  const raw = `https://raw.githubusercontent.com/${repository}/${commit}/${evidence}`;
  const blob = `https://github.com/${repository}/blob/${commit}/${evidence}`;
  const count = outcome => report.discovery.filter(row => row.outcome === outcome).length;
  return `Record the ${report.startedAt.slice(0, 10)} public ecosystem survey: ${report.repositories.filter(row => row.head).length} repository heads read and ${report.discovery.length} Company hosts checked. Discovery results: **${count("valid")} valid, ${count("invalid")} invalid, ${count("unsupported")} unsupported by PDA, ${count("indeterminate")} indeterminate**. ${report.incomplete ? "Some observations are incomplete; the report names them and preserves earlier observation dates." : "All configured sources answered."}

Review the [survey report](${blob}/survey.md) and [JSON receipt](${raw}/survey.json) for exact revisions, package releases, metadata diagnostics and bounded search leads. Adapter pins, interpreted claims and historical grid dates are preserved. This survey starts no Sessions, sign-ins, conversations or ordering flows.

## Visual evidence

Inspect the generated observation block: the check date and source/discovery counts change while older interpreted results retain their dates. Both screenshots use the production Vite renderer and the existing isolated app-smoke fixture in Chromium at 1280 × 900.

| Before | After |
| --- | --- |
| ![Before: ecosystem observation date and counts before this refresh](${raw}/before.png) | ![After: updated ecosystem observation date and counts, with older evidence still dated](${raw}/after.png) |

[Phone-width capture](${raw}/mobile.png) · [Browser checks](${raw}/browser-checks.json)

The images establish rendered survey data and layout. They do not prove live sign-in, API or ordering interoperability. Review protocol changes and new project candidates before treating them as supported behavior; reviewed pin changes have their own targeted grid checks.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = process.argv[2];
  const report = JSON.parse(readFileSync(path.join(evidence, "survey.json"), "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  process.stdout.write(surveyPrBody(report, { repository: process.env.GITHUB_REPOSITORY, commit, evidence }));
}
