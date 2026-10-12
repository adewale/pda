#!/usr/bin/env node
/**
 * `npm run deps:check`: what's outdated and what `npm audit` finds, as one
 * Markdown report on stdout, and appended to the GitHub Actions job summary
 * when `GITHUB_STEP_SUMMARY` is set (the monthly `.github/workflows/deps.yml`).
 * It changes nothing: no installs, no fixes, no pull requests.
 *
 * Outdated packages are information only. The audit runs twice, production
 * dependencies alone and then everything (production and dev), and only a
 * finding at "high" or "critical" fails the check.
 *
 * Exit status: 0 no high or critical finding, 1 at least one, 2 the audit
 * couldn't run (no network, no lockfile) or npm's output wasn't understood.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

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

const cell = (value) => String(value ?? "").replaceAll("|", "\\|");
const table = (header, rows) =>
  [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
const major = (version) => Number.parseInt(String(version).split(".")[0], 10);

const out = [];
let failed = false;
let broken = false;

// Outdated: information only.
out.push("## Outdated packages", "");
const outdated = npmJson(["outdated", "--json", "--long"]);
if (outdated.error) {
  out.push(`Couldn't list outdated packages: ${outdated.error}`, "");
} else {
  const names = Object.keys(outdated.json).sort();
  if (names.length === 0) {
    out.push("Every direct dependency is at its latest version.", "");
  } else {
    const rows = names.map((name) => {
      const info = Array.isArray(outdated.json[name]) ? outdated.json[name][0] : outdated.json[name];
      const kind = info.type === "devDependencies" ? "dev" : info.type === "dependencies" ? "prod" : (info.type ?? "");
      const notes = [];
      if (info.current === undefined || info.current === "MISSING") notes.push("not installed");
      else {
        if (info.wanted !== info.current) notes.push("update in range");
        if (major(info.latest) > major(info.current)) notes.push("new major");
        else if (info.latest !== info.wanted) notes.push("outside range");
      }
      return [name, kind, info.current ?? "missing", info.wanted, info.latest, notes.join(", ")];
    });
    out.push(
      `${names.length} direct ${names.length === 1 ? "dependency is" : "dependencies are"} behind. ` +
        '"update in range": `npm update` would take it to Wanted; "outside range" and "new major": reaching Latest means changing `package.json`. Information only; nothing here fails the check.',
      "",
      table(["Package", "Type", "Current", "Wanted", "Latest", "Note"], rows),
      "",
    );
  }
}

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
