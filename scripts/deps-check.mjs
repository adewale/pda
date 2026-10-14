#!/usr/bin/env node
/**
 * `npm run deps:check`: what's outdated and what `npm audit` finds, as one
 * Markdown report on stdout, and appended to the GitHub Actions job summary
 * when `GITHUB_STEP_SUMMARY` is set (the monthly `.github/workflows/deps.yml`).
 * It changes nothing: no installs, no fixes, no pull requests.
 *
 * Outdated packages are information only, and so is npm failing to list
 * them. The audit runs twice, production dependencies alone and then
 * everything (production and dev), and only a finding at "high" or
 * "critical" fails the check. The outdated section's Markdown comes from
 * `scripts/deps-report.ts`, which `test/deps-check.test.ts` runs on fixtures.
 *
 * Exit status: 0 no high or critical finding, 1 at least one, 2 the audit
 * couldn't run (no network, no lockfile) or npm's output wasn't understood.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { outdatedSection, table } from "./deps-report.ts";

const root = path.resolve(import.meta.dirname, "..");
const SEVERITIES = ["critical", "high", "moderate", "low", "info"];
const FAILING = new Set(["critical", "high"]);

/** Runs npm with these arguments and parses its JSON output. */
function npmJson(args) {
  const result = spawnSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  // `npm outdated` exits 1 when anything is outdated and `npm audit` when it
  // finds anything, so the exit status says nothing; the JSON does.
  const text = (result.stdout ?? "").trim();
  if (text === "") return { error: (result.stderr ?? "").trim() || `npm ${args[0]} printed nothing` };
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { error: `npm ${args[0]} printed something that isn't JSON:\n${text.slice(0, 500)}` };
  }
}

const out = [];
let failed = false;
let broken = false;

// Outdated: information only, even when npm itself fails (it prints `{"error": …}` then).
out.push("## Outdated packages", "", ...outdatedSection(npmJson(["outdated", "--json", "--long"])));

// Audit: production, then production and dev.
out.push("## Audit", "");
for (const [label, args] of [
  ["Production dependencies", ["audit", "--json", "--omit=dev"]],
  ["All dependencies (production and dev)", ["audit", "--json"]],
]) {
  out.push(`### ${label}`, "");
  const audit = npmJson(args);
  const counts = audit.json?.metadata?.vulnerabilities;
  if (audit.error || audit.json?.error || !counts) {
    broken = true;
    const reason = audit.error ?? audit.json?.error?.summary ?? JSON.stringify(audit.json?.error ?? audit.json).slice(0, 500);
    out.push(`The audit couldn't run: ${reason}`, "");
    continue;
  }
  out.push(SEVERITIES.map((severity) => `${severity} ${counts[severity] ?? 0}`).join(" · "), "");
  const findings = Object.values(audit.json.vulnerabilities ?? {}).sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.name.localeCompare(b.name),
  );
  if (findings.length === 0) {
    out.push("No known vulnerabilities.", "");
    continue;
  }
  if (findings.some((finding) => FAILING.has(finding.severity))) failed = true;
  const rows = findings.map((finding) => {
    const advisories = finding.via
      .map((via) => (typeof via === "string" ? `via ${via}` : via.url ? `[${via.title}](${via.url})` : via.title))
      .join("; ");
    const fix =
      finding.fixAvailable === true
        ? "`npm audit fix`"
        : finding.fixAvailable
          ? `${finding.fixAvailable.name}@${finding.fixAvailable.version}${finding.fixAvailable.isSemVerMajor ? " (major)" : ""}`
          : "none yet";
    return [finding.name, finding.severity, finding.isDirect ? "yes" : "no", finding.range, advisories, fix];
  });
  out.push(table(["Package", "Severity", "Direct", "Vulnerable range", "Advisories", "Fix"], rows), "");
}

out.push(
  "## Result",
  "",
  broken
    ? "**The audit couldn't run**, so this check can't say whether anything is vulnerable."
    : failed
      ? "**Failed:** at least one finding is high or critical."
      : "**Passed:** no high or critical findings. Outdated packages and lower findings are for information.",
  "",
);

const report = out.join("\n");
process.stdout.write(`${report}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Dependency check\n\n${report}\n`);
process.exit(broken ? 2 : failed ? 1 : 0);
