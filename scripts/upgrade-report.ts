/**
 * The pure half of `scripts/upgrade-dry-run.mjs`: what npm, the packages'
 * changelogs, the issue search and a trial typecheck said, in; a plan and a
 * Markdown report, out. No process, file or network access, and no
 * dependencies, so `scripts/upgrade-report.test.mjs` runs it on fixtures
 * before `npm ci`.
 *
 * The pi family moves as one: pi-durable pins pi-ai, chord, pi-telemetry and
 * pi-schema to its own version, and each `agents` release accepts one pi
 * minor (decision 57). So the plan is one pi version and the newest `agents`
 * whose pi peer range takes it.
 */

/** A version as three numbers; anything after them (a prerelease) is ignored by `compare`, and refused by `stable`. */
export function parse(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compare(a: string, b: string): number {
  const x = parse(a) ?? [0, 0, 0], y = parse(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Whether `version` satisfies `range`, for the forms the pi family and `agents` use: `~x.y.z`, `^x.y.z`, `x.y.z`, `*`. */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const text = range.trim();
  if (text === "*" || text === "") return true;
  const operator = text[0] === "~" || text[0] === "^" ? text[0] : "";
  const base = parse(operator ? text.slice(1) : text);
  if (!base) return false;
  if (compare(version, base.join(".")) < 0) return false;
  if (operator === "~") return v[0] === base[0] && v[1] === base[1];
  if (operator === "^") return base[0] > 0 ? v[0] === base[0] : v[1] === base[1];
  return compare(version, base.join(".")) === 0;
}

/** The stable versions newer than `installed`, oldest first. */
export function newer(versions: readonly string[], installed: string): string[] {
  return versions.filter((version) => parse(version) !== null && compare(version, installed) > 0).sort(compare);
}

/**
 * The newest `agents` release, no older than `installed`, whose peer range
 * for pi-ai takes `pi`, from each release's `peerDependencies`; null when
 * none does. Never an older one: 0.28.1 declared `^1.0.0` and broke on pi
 * 1.5, so an old, loose range says nothing about a new pi.
 */
export function agentsFor(pi: string, peers: Readonly<Record<string, Readonly<Record<string, string>>>>, installed: string): string | null {
  const fits = Object.entries(peers)
    .filter(([version, deps]) => parse(version) !== null && compare(version, installed) >= 0 && deps["@earendil-works/pi-ai"] !== undefined && satisfies(pi, deps["@earendil-works/pi-ai"]!))
    .map(([version]) => version)
    .sort(compare);
  return fits.at(-1) ?? null;
}

/** One release's breaking changes, as the changelog's "Breaking Changes" section lists them, a bullet each. */
export type Breaking = { readonly version: string; readonly items: readonly string[] };

/**
 * The "### Breaking Changes" bullets of every release after `from` up to
 * `to`, in a Keep a Changelog file (`## [1.6.1] - 2026-11-25`), newest first.
 * Each bullet is its first line, cut at `max` characters.
 */
export function breakingChanges(changelog: string, from: string, to: string, max = 240): Breaking[] {
  const out: Breaking[] = [];
  let version: string | null = null;
  let inBreaking = false;
  let items: string[] = [];
  const flush = () => {
    if (version && items.length > 0) out.push({ version, items });
    items = [];
  };
  for (const line of changelog.split("\n")) {
    const heading = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
    if (heading) {
      flush();
      const found = heading[1]!;
      version = compare(found, from) > 0 && compare(found, to) <= 0 ? found : null;
      inBreaking = false;
      continue;
    }
    if (/^## /.test(line)) {
      flush();
      version = null;
      continue;
    }
    if (/^### /.test(line)) {
      inBreaking = /^### Breaking/i.test(line);
      continue;
    }
    if (version && inBreaking && /^- /.test(line)) {
      const text = line.slice(2).trim();
      items.push(text.length > max ? `${text.slice(0, max - 1)}…` : text);
    }
  }
  flush();
  return out;
}

/** A name our code uses that the candidate no longer has, from a trial typecheck. */
export type MissingApi = { readonly file: string; readonly line: number; readonly name: string; readonly from: string };

/**
 * TypeScript's errors that say a dependency's API is gone: `TS2305` (a
 * module has no exported member) and `TS2339` (no such property), with
 * where our code uses it.
 */
export function missingApis(tscOutput: string): MissingApi[] {
  const out: MissingApi[] = [];
  for (const line of tscOutput.split("\n")) {
    const exported = /^(.+?)\((\d+),\d+\): error TS2305: Module '"([^"]+)"' has no exported member '([^']+)'/.exec(line);
    if (exported) {
      out.push({ file: exported[1]!, line: Number(exported[2]), name: exported[4]!, from: exported[3]! });
      continue;
    }
    const property = /^(.+?)\((\d+),\d+\): error TS2339: Property '([^']+)' does not exist on type '([^']+)'/.exec(line);
    if (property) out.push({ file: property[1]!, line: Number(property[2]), name: property[3]!, from: property[4]! });
  }
  return out;
}

/** Every `file(line,col): error TSnnnn` line of a typecheck, counted. */
export function typeErrorCount(tscOutput: string): number {
  return tscOutput.split("\n").filter((line) => /\): error TS\d+:/.test(line)).length;
}

/** An open upstream issue that may bear on the move. */
export type Issue = { readonly repository: string; readonly number: number; readonly title: string; readonly url: string; readonly createdAt: string };

/** What one trial step gave: its exit status, and the tail of its output. */
export type Step = { readonly name: string; readonly status: number | null; readonly tail: string };

export type Report = {
  readonly installed: { readonly pi: string; readonly agents: string };
  readonly target: { readonly pi: string; readonly agents: string | null } | null;
  readonly breaking: Readonly<Record<string, readonly Breaking[]>>;
  readonly issues: readonly Issue[] | { readonly skipped: string };
  readonly trial: { readonly steps: readonly Step[]; readonly missing: readonly MissingApi[]; readonly typeErrors: number } | { readonly skipped: string };
};

const cell = (value: unknown) => String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");

function table(header: string[], rows: unknown[][]): string {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

/** The report as Markdown, for the terminal and the job summary. */
export function markdown(report: Report): string {
  const out: string[] = ["## pi and agents: upgrade dry run", ""];
  const { installed, target } = report;
  if (!target) {
    out.push(`Installed: pi ${installed.pi}, agents ${installed.agents}. Nothing newer to try.`, "");
    return out.join("\n");
  }
  out.push(table(["", "pi family", "agents"], [["Installed", installed.pi, installed.agents], ["Candidate", target.pi, target.agents ?? "none takes this pi yet"]]), "");
  if (target.agents === null) out.push("**No `agents` release accepts this pi yet.** The family can't move until one does.", "");
  out.push("### Breaking changes upstream", "");
  const packages = Object.entries(report.breaking).filter(([, releases]) => releases.length > 0);
  if (packages.length === 0) out.push("None listed between the installed and candidate versions.", "");
  for (const [name, releases] of packages) {
    out.push(`#### ${name}`, "");
    for (const release of releases) {
      out.push(`- **${release.version}**`);
      for (const item of release.items) out.push(`  - ${item}`);
    }
    out.push("");
  }
  out.push("### Open upstream issues", "");
  if ("skipped" in report.issues) out.push(`Not searched: ${report.issues.skipped}`, "");
  else if (report.issues.length === 0) out.push("None found.", "");
  else out.push(table(["Issue", "Opened", "Title"], report.issues.map((issue) => [`[${issue.repository}#${issue.number}](${issue.url})`, issue.createdAt.slice(0, 10), issue.title])), "");
  out.push("### Trial install", "");
  if ("skipped" in report.trial) out.push(`Not run: ${report.trial.skipped}`, "");
  else {
    out.push(table(["Step", "Result"], report.trial.steps.map((step) => [step.name, step.status === 0 ? "passed" : step.status === null ? "didn't finish" : `failed (exit ${step.status})`])), "");
    if (report.trial.typeErrors > 0) out.push(`${report.trial.typeErrors} type errors.`, "");
    if (report.trial.missing.length > 0) {
      out.push("APIs our code uses that the candidate no longer has:", "");
      out.push(table(["Where", "Name", "From"], report.trial.missing.map((api) => [`${api.file}:${api.line}`, api.name, api.from])), "");
    }
    for (const step of report.trial.steps.filter((each) => each.status !== 0 && each.tail)) {
      out.push(`<details><summary>${step.name}: the end of its output</summary>`, "", "```", step.tail, "```", "", "</details>", "");
    }
  }
  return out.join("\n");
}
