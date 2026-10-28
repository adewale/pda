#!/usr/bin/env node
/** Publish only aggregate outcomes from a successful honest local run; never raw traces or new failure detail. */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HONEST_SCENARIOS } from "./ecosystem-grid.mjs";

export function gridReceipt(result, observedAt = new Date().toISOString(), published = []) {
  const honest = new Set(HONEST_SCENARIOS.split(","));
  const publicFinding = cell => published.some(finding => finding.agent === cell.agent && finding.company === cell.company && finding.scenario === cell.scenario
    && result.implementations.some(item => item.role === "agent" && item.name === cell.agent && item.commit === finding.agentCommit)
    && (!finding.companyCommit || result.implementations.some(item => item.role === "company" && item.name === cell.company && item.commit === finding.companyCommit))
    && cell.steps?.find(step => !step.ok)?.error?.split(":", 1)[0] === finding.error);
  if (result.lane !== "local" || !result.isolation || !result.cells?.length || result.staleKnown?.length
      || result.implementations.some(entry => entry.adversarial || entry.broken)
      || result.cells.some(cell => !honest.has(cell.scenario) || !["pass", "fail", "unsupported"].includes(cell.outcome) || (cell.outcome === "fail" && !cell.known && !publicFinding(cell)))) {
    throw new Error("Cross-project results need local review before publication (SECURITY.md)");
  }
  const counts = Object.fromEntries(["pass", "fail", "unsupported"].map(outcome => [outcome, result.cells.filter(cell => cell.outcome === outcome).length]));
  return { version: 1, observedAt, run: result.run, lane: result.lane, scope: "Honest scenarios at retained registry pins; aggregate receipt only",
    implementations: result.implementations.map(({ name, role, commit }) => ({ name, role, commit })), counts,
    knownFailures: result.cells.filter(cell => cell.known).length,
    publishedFailures: result.cells.filter(cell => cell.outcome === "fail" && !cell.known && publicFinding(cell)).length,
    flaky: result.cells.filter(cell => cell.flaky).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--aggregate") {
    const directory = process.argv[3], prefix = process.argv[4], expected = Number(process.argv[5]);
    if (!directory || !prefix) throw new Error("Use --aggregate receipt-directory output-prefix");
    const jobs = readdirSync(directory, { recursive: true }).filter(file => file.endsWith(".json")).map(file => JSON.parse(readFileSync(path.join(directory, file), "utf8")));
    if (!jobs.length || jobs.some(job => job.version !== 1 || job.lane !== "local") || (Number.isFinite(expected) && jobs.length !== expected)) throw new Error("Missing local grid receipts; automatic publication is withheld");
    const date = new Date().toISOString();
    const report = { observedAt: date, scope: "PDA against registered local Companies; registered Personal Agents against our matching-profile mocks. This is not the complete foreign-to-foreign matrix.", jobs };
    writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
    const lines = [`# Cross-project grid — ${date.slice(0, 10)}`, "", report.scope, "", "Only completed honest runs without unreviewed failures are included. Previously published compatibility findings remain unexempted failures and still make the grid job fail. Unsupported is not a pass.", "", "| Implementations at checked commits | Pass | Fail | Unsupported | Flaky |", "| --- | --- | --- | --- | --- |"];
    for (const job of jobs) lines.push(`| ${job.implementations.map(item => `${item.role}/${item.name}@${item.commit.slice(0, 7)}`).join(", ")} | ${job.counts.pass} | ${job.counts.fail} | ${job.counts.unsupported} | ${job.flaky} |`);
    lines.push("", "Raw traces and unexpected findings are not published automatically. Follow SECURITY.md for anything requiring private disclosure. No live Company or account was used.", "");
    writeFileSync(`${prefix}.md`, lines.join("\n"));
  } else {
    const result = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const published = JSON.parse(readFileSync(new URL("../interop/published-findings.json", import.meta.url), "utf8")).findings;
    process.stdout.write(`${JSON.stringify(gridReceipt(result, new Date().toISOString(), published), null, 2)}\n`);
  }
}
