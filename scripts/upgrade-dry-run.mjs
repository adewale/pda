#!/usr/bin/env node
/**
 * `npm run deps:dry-run`: what moving the pi family and `agents` to their
 * newest compatible pair would take, before anyone starts. It reads npm for
 * the candidate (`--pi <version>`, or the newest stable pi-ai) and the
 * newest `agents` release whose pi-ai peer range takes it; each package's
 * changelog for the breaking changes in between; with `GITHUB_TOKEN`, open
 * upstream issues about pi-durable and the Pi harness; and, unless
 * `--no-install`, a trial: a throwaway git worktree with the candidate
 * installed, its typecheck, and `npm test` (`--typecheck-only` skips the
 * tests). The worktree is removed afterwards; this checkout isn't touched.
 *
 * The report is Markdown on stdout, and is appended to the GitHub Actions job
 * summary when `GITHUB_STEP_SUMMARY` is set. The pure half, and its tests,
 * are `scripts/upgrade-report.ts` and `scripts/upgrade-report.test.mjs`.
 *
 * Exit status: 0 the report was written (whatever it says), 2 npm or git
 * couldn't be asked.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentsFor, breakingChanges, markdown, missingApis, newer, typeErrorCount } from "./upgrade-report.ts";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

/** The packages that move together; pi-durable pins the others to its own version. */
const FAMILY = ["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord", "@earendil-works/pi-telemetry", "@earendil-works/pi-schema"];

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32", ...options });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function npmView(spec, field) {
  const result = run("npm", ["view", spec, field, "--json"]);
  if (result.status !== 0 || result.stdout.trim() === "") throw new Error(`npm view ${spec} ${field} failed: ${result.stderr.trim().slice(0, 300)}`);
  return JSON.parse(result.stdout);
}

function installed(name) {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  return lock.packages?.[`node_modules/${name}`]?.version;
}

/** A package's changelog, from the default branch of the repository npm names for it. */
async function changelog(name) {
  const repository = npmView(name, "repository");
  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(typeof repository === "string" ? repository : repository?.url ?? "");
  if (!match) return null;
  const directory = typeof repository === "object" && repository.directory ? `${repository.directory}/` : "";
  const response = await fetch(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/HEAD/${directory}CHANGELOG.md`, { signal: AbortSignal.timeout(20_000) });
  return response.ok ? response.text() : null;
}

/** Open issues upstream about the parts PDA uses, opened since the installed pi was published. */
async function issues(since) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { skipped: "set GITHUB_TOKEN to search upstream issues." };
  const found = [];
  for (const query of [`repo:earendil-works/pi is:issue is:open pi-durable created:>=${since}`, `repo:cloudflare/agents is:issue is:open PiHarness created:>=${since}`]) {
    const response = await fetch(`https://api.github.com/search/issues?per_page=15&sort=created&q=${encodeURIComponent(query)}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "pda-deps-dry-run" },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) return { skipped: `GitHub answered ${response.status} to the issue search.` };
    const body = await response.json();
    for (const item of body.items ?? []) {
      found.push({ repository: item.repository_url.split("/").slice(-2).join("/"), number: item.number, title: item.title, url: item.html_url, createdAt: item.created_at });
    }
  }
  return found;
}

/** The candidate installed in a throwaway worktree, and checked there. */
function trial(target) {
  if (flag("--no-install")) return { skipped: "--no-install." };
  if (!target.agents) return { skipped: "no agents release accepts this pi yet." };
  const dir = mkdtempSync(path.join(os.tmpdir(), "pda-upgrade-"));
  const steps = [];
  const step = (name, command, commandArgs, timeoutMs) => {
    const result = run(command, commandArgs, { cwd: dir, timeout: timeoutMs });
    const output = `${result.stdout}\n${result.stderr}`;
    steps.push({ name, status: result.status, tail: output.trim().split("\n").slice(-40).join("\n") });
    return { ok: result.status === 0, output };
  };
  try {
    if (run("git", ["worktree", "add", "--detach", dir, "HEAD"]).status !== 0) return { skipped: "git couldn't make a worktree." };
    const specs = [...FAMILY.map((name) => `dependencies.${name}=~${target.pi}`), `dependencies.agents=${target.agents}`];
    run("npm", ["pkg", "set", ...specs], { cwd: dir });
    const install = step("npm install", "npm", ["install", "--legacy-peer-deps", "--no-audit", "--no-fund"], 15 * 60_000);
    let missing = [];
    let typeErrors = 0;
    if (install.ok) {
      const typecheck = step("npm run typecheck", "npm", ["run", "typecheck"], 10 * 60_000);
      missing = missingApis(typecheck.output);
      typeErrors = typeErrorCount(typecheck.output);
      if (!flag("--typecheck-only")) step("npm test", "npm", ["test"], 45 * 60_000);
    }
    return { steps, missing, typeErrors };
  } finally {
    run("git", ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const current = { pi: installed("@earendil-works/pi-ai"), agents: installed("agents") };
  if (!current.pi || !current.agents) throw new Error("package-lock.json names no installed pi-ai or agents.");
  const candidates = newer(npmView("@earendil-works/pi-ai", "versions"), current.pi);
  const pi = option("--pi") ?? candidates.at(-1);
  let target = null;
  const breaking = {};
  let found = [];
  let tried = { skipped: "nothing newer." };
  if (pi) {
    const agentsVersions = newer(npmView("agents", "versions"), current.agents);
    const peers = { [current.agents]: npmView(`agents@${current.agents}`, "peerDependencies") };
    for (const version of agentsVersions) peers[version] = npmView(`agents@${version}`, "peerDependencies");
    target = { pi, agents: agentsFor(pi, peers, current.agents) };
    for (const name of FAMILY) {
      const text = await changelog(name).catch(() => null);
      breaking[name] = text ? breakingChanges(text, current.pi, pi) : [{ version: "?", items: ["The changelog couldn't be read."] }];
    }
    if (target.agents) {
      const text = await changelog("agents").catch(() => null);
      breaking.agents = text ? breakingChanges(text, current.agents, target.agents) : [{ version: "?", items: ["The changelog couldn't be read."] }];
    }
    const times = npmView("@earendil-works/pi-ai", "time");
    found = await issues(String(times[current.pi] ?? "").slice(0, 10) || "2026-01-01");
    tried = trial(target);
  }
  const report = markdown({ installed: current, target, breaking, issues: found, trial: tried });
  process.stdout.write(`${report}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
} catch (error) {
  process.stderr.write(`deps:dry-run: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
