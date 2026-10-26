#!/usr/bin/env node
import { protocolRevision, PROTOCOL_REVISION, PROTOCOL_VERSIONS } from "../../src/poppy/protocol-version.ts";
/**
 * The Poppy interop runner (docs/interop-spec.md):
 *
 *   npm run interop -- [--agents a,b] [--companies x,y] [--scenarios D,SD]
 *                      [--lane local|live] [--no-build] [--keep] [--no-retry]
 *                      [--min-free-gb n] [--set name:KEY=VALUE]... [--out dir]
 *                      [--image-tag tag]
 *
 * Local lane: builds every selected implementation's image, makes a CA and
 * certificate for the run, starts an --internal Docker network (no way out,
 * proven by an egress probe before any implementation starts) with the
 * recording proxy, a control relay and each implementation, waits on
 * /healthz, reads /manifest, then runs each scenario × agent × Company
 * cell, resetting both adapters first.
 * A cell that fails or errors runs once more; one that then passes is flaky.
 * Writes interop/results/<run>/results.json, a HAR per cell and index.html.
 * Exits 1 when a cell fails or errors and isn't in known-failures.json, or
 * when a known failure the run could judge matched no failed cell (stale).
 * Everything it makes on Docker is labelled interop.run=<tag> and removed on
 * exit, error, SIGINT or SIGTERM; it won't start with too little disk.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { agentRecorded, attributeAll, companyRecorded, levelCounts, staleKnown, unexpected, type RecordedViolation } from "./attribution.ts";
import { runCell, toReply, withWebPage, type Driver, type Reply, type RunnerReply } from "./cell.ts";
import { makeCertificates } from "./certs.ts";
import { traceChecks } from "./checks.ts";
import { dockerFreeGb, labelArgs, lowDisk, removeRun } from "./cleanup.ts";
import { docker, dockerAsync, mapConcurrent, proxyAliases } from "./docker.ts";
import { documentChecks } from "./documents.ts";
import { exchanges, PROBE_HEADER, type Har } from "./har.ts";
import { liveIdentityEnv, liveIdentityNotice, readLiveIdentity } from "./live-identity.ts";
import {
  CONTROL_PORT,
  controlNetworkArgs,
  egressProbeArgs,
  egressRefusal,
  implementationCreateArgs,
  INTERNAL_FORMAT,
  isolatedNetworkArgs,
  localNames,
  proxyCreateArgs,
  relayConnectArgs,
  relayCreateArgs
} from "./network.ts";
import { readingChecks, refusedReadingChecks } from "./readings.ts";
import { cellId, renderReport } from "./report.ts";
import { runWithRetry } from "./retry.ts";
import { inlineFiles, lintScenario } from "./scenario.ts";
import { assertTrace } from "./traces.ts";
import type { Cell, Check, KnownFailure, Manifest, Registry, RegistryEntry, Role, Scenario } from "./types.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const INTEROP = path.join(ROOT, "interop");
const SPEC = `Personal Agent Protocol Drafts ${PROTOCOL_VERSIONS.join(" and ")} (${PROTOCOL_REVISION})`;

/** A file scenarios upload (`args.files`), from `interop/files/`; null if there's none by that name. */
function harnessFile(name: string): Uint8Array | null {
  const file = path.join(INTEROP, "files", name);
  return path.dirname(file) === path.join(INTEROP, "files") && existsSync(file) ? readFileSync(file) : null;
}

/** The order scenarios run and are shown in; others follow by id. */
/**
 * What our agent says to a live Company's agent (scenario CL): plainly a
 * test, asking for nothing, so whoever reads it at the Company can ignore
 * it. CL closes the conversation afterwards.
 */
export const LIVE_GREETING = "Interoperability test from the Poppy Demo Agent. No reply or action is needed; this conversation will be closed.";

export const SCENARIO_ORDER = [
  "D", "S0", "N", "SD", "SV", "SVN", "SM", "SMC", "SX", "SXV", "C", "CL", "CC", "CI", "CS", "CA", "H", "DC", "SO", "SE", "R", "AO", "AM", "AS", "W", "O", "O2", "OX", "OU", "RL", "DP", "CM", "ML",
  // Adversarial (docs/adversarial-interop.md): network faults, then malicious agent and Company.
  "NREP", "CDUP", "CIDUP", "ODUP", "YR", "YD", "YA", "YT", "YS", "YK", "YU", "YM", "XH", "XI", "BX", "XB", "XN", "XO", "XP", "XE", "XR", "XT"
];

export type Options = {
  readonly agents: readonly string[] | null;
  readonly companies: readonly string[] | null;
  readonly scenarios: readonly string[] | null;
  readonly lane: "local" | "live";
  readonly build: boolean;
  /** Bound compilation memory and disk pressure instead of building the whole registry at once. */
  readonly buildJobs: number;
  readonly keep: boolean;
  /** Run a failed or errored cell once more (`--no-retry` turns it off). */
  readonly retry: boolean;
  /** Refuse to start with less free space than this on Docker's data disk. */
  readonly minFreeGb: number;
  /** Extra container environment, by implementation name. */
  readonly set: ReadonlyMap<string, Readonly<Record<string, string>>>;
  readonly out: string | null;
  /** The image tag to build and run (default `latest`). `--image-tag adv` keeps the full grid's `:latest` images untouched. */
  readonly imageTag: string;
};

const list = (value: string | undefined) => (value ? value.split(",").map((item) => item.trim()).filter(Boolean) : null);

export function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      agents: { type: "string" },
      companies: { type: "string" },
      scenarios: { type: "string" },
      lane: { type: "string", default: "local" },
      build: { type: "boolean", default: true },
      "no-build": { type: "boolean", default: false },
      "build-jobs": { type: "string", default: "2" },
      keep: { type: "boolean", default: false },
      "no-retry": { type: "boolean", default: false },
      "min-free-gb": { type: "string", default: "2" },
      set: { type: "string", multiple: true },
      out: { type: "string" },
      "image-tag": { type: "string", default: "latest" }
    },
    strict: true
  });
  if (values.lane !== "local" && values.lane !== "live") throw new Error(`--lane must be local or live, not ${values.lane}`);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(values["image-tag"]!)) throw new Error(`--image-tag must be a Docker tag, not ${values["image-tag"]}`);
  const minFreeGb = Number(values["min-free-gb"]);
  if (!(minFreeGb >= 0)) throw new Error(`--min-free-gb takes a number of GB, not ${values["min-free-gb"]}`);
  const buildJobs = Number(values["build-jobs"]);
  if (!Number.isSafeInteger(buildJobs) || buildJobs < 1) throw new Error("--build-jobs takes a positive whole number");
  const set = new Map<string, Record<string, string>>();
  for (const entry of values.set ?? []) {
    const match = /^([a-z0-9-]+):([A-Z][A-Z0-9_]*)=(.*)$/.exec(entry);
    if (!match) throw new Error(`--set takes name:KEY=VALUE, not ${entry}`);
    set.set(match[1]!, { ...(set.get(match[1]!) ?? {}), [match[2]!]: match[3]! });
  }
  return {
    agents: list(values.agents),
    companies: list(values.companies),
    scenarios: list(values.scenarios),
    lane: values.lane,
    build: values.build && !values["no-build"],
    buildJobs,
    keep: values.keep,
    retry: !values["no-retry"],
    minFreeGb,
    set,
    out: values.out ?? null,
    imageTag: values["image-tag"] ?? "latest"
  };
}

export function loadRegistry(file = path.join(INTEROP, "registry.json")): Registry {
  const registry = JSON.parse(readFileSync(file, "utf8")) as Registry;
  if (registry.version !== 1 || !Array.isArray(registry.implementations)) throw new Error(`${file}: not a version 1 registry`);
  const seen = new Set<string>();
  for (const entry of registry.implementations) {
    if (!/^[a-z0-9-]{1,32}$/.test(entry.name)) throw new Error(`${file}: bad name ${JSON.stringify(entry.name)}`);
    if (entry.role !== "agent" && entry.role !== "company") throw new Error(`${file}: ${entry.name} has role ${String(entry.role)}`);
    const key = `${entry.role}:${entry.name}`;
    if (seen.has(key)) throw new Error(`${file}: ${entry.name} is listed twice as ${entry.role}`);
    seen.add(key);
    if (entry.protocolVersion !== undefined && !(PROTOCOL_VERSIONS as readonly string[]).includes(entry.protocolVersion)) throw new Error(`${file}: ${entry.name} has an unsupported protocolVersion`);
    if (!entry.commit) throw new Error(`${file}: ${entry.name} pins no commit`);
    if (!entry.build && !entry.url) throw new Error(`${file}: ${entry.name} has neither build nor url`);
  }
  return registry;
}

/** Live peers have no adapter manifest. Their declared version must be explicit. */
export function liveCompanyManifest(entry: RegistryEntry, scenarios: readonly Scenario[]): Manifest {
  const ids = scenarios.map((s) => s.id);
  return { interop: 1, name: entry.name, role: "company", commit: entry.commit, poppy: [entry.protocolVersion ?? "0.1"], scenarios: entry.liveScenarios ? ids.filter((id) => entry.liveScenarios!.includes(id)) : ids };
}

export function loadScenarios(dir = path.join(INTEROP, "scenarios")): Scenario[] {
  const scenarios = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const value = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Scenario;
      const problems = lintScenario(value, file);
      if (problems.length) throw new Error(problems.join("\n"));
      if (`${value.id}.json` !== file) throw new Error(`${file}: id ${value.id} doesn't match the file name`);
      return value;
    });
  const rank = (id: string) => (SCENARIO_ORDER.includes(id) ? SCENARIO_ORDER.indexOf(id) : SCENARIO_ORDER.length);
  return [...scenarios].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export function loadKnownFailures(file = path.join(INTEROP, "known-failures.json")): KnownFailure[] {
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, "utf8")) as { failures?: KnownFailure[] };
  const failures = value.failures ?? [];
  const blames = new Set<unknown>(["agent", "company", "spec", "harness", null]);
  const strings = (list: unknown) => list === undefined || (Array.isArray(list) && list.every((item) => typeof item === "string"));
  for (const entry of failures) {
    // Each entry says what its failure looks like, so another failure in the same cell isn't taken for it.
    const blame = (entry as { blame?: unknown }).blame;
    const blameOk = Array.isArray(blame) ? blame.length > 0 && blame.every((item) => blames.has(item)) : blame !== undefined && blames.has(blame);
    if (!blameOk || !strings(entry.checks) || !strings(entry.errors)) {
      throw new Error(`${file}: ${entry.agent} × ${entry.company} × ${entry.scenario} needs blame (agent, company, spec, harness or null, or a list of them), and checks and errors as lists of strings`);
    }
  }
  return failures;
}

function sourceCommit(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
    return dirty ? `${head}-dirty` : head;
  } catch {
    return "unknown";
  }
}

/** "HEAD" pins an implementation built from this repository to the commit being run. */
const commitOf = (entry: RegistryEntry) => (entry.commit === "HEAD" ? sourceCommit() : entry.commit);

// ---------------------------------------------------------------- Talking to adapters

type Answer = { status: number; body: unknown };

/** Control calls, through the proxy's control port (local) or straight to a published port (live). */
type Control = (target: string, method: string, pathname: string, body?: unknown) => Promise<Answer>;

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

class Proxy {
  readonly base: string;
  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}`;
  }
  async post(pathname: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.base}${pathname}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return response.json();
  }
  control(secret: string): Control {
    return async (target, method, pathname, body) => {
      const answer = (await this.post("/control", {
        target,
        method,
        path: pathname,
        headers: { authorization: `Bearer ${secret}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })) as { status: number; body: string; error?: string };
      return { status: answer.status, body: parse(answer.body) };
    };
  }
  async cell(id: string, faults: readonly unknown[] = []): Promise<void> {
    await this.post("/cell", { id, faults });
  }
  async har(): Promise<Har> {
    return (await (await fetch(`${this.base}/har`)).json()) as Har;
  }
  async fetch(request: Record<string, unknown>): Promise<unknown> {
    return this.post("/fetch", request);
  }
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// ---------------------------------------------------------------- One run

type Implementation = {
  readonly entry: RegistryEntry;
  readonly target: string;
  readonly domain: string;
  manifest: Manifest | null;
  hooks: string[];
  /** Why it can't take part, if it can't. */
  broken: string | null;
};

const domainOf = (entry: RegistryEntry, lane: "local" | "live") =>
  lane === "live" && entry.url ? entry.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : `${entry.name}.${entry.role}.interop.test`;

/**
 * The own-project rule (docs/adversarial-interop.md, Part B): a cell with an
 * adversarial side, or a proxy `faults` list, runs only on the local lane and
 * only when every honest side is an implementation this project owns
 * (`owner: "self"`). One exception, approved by the owner on 13 October
 * 2026: the adversarial Company may attack another project's agent, built at
 * its pinned commit and run in our own containers, so we learn which clients
 * refuse a malicious Company. What those cells find stays out of the
 * repository until that project's maintainers have heard privately
 * (SECURITY.md). No flag lifts the rest; that is a code change that needs the
 * same process. Returns why a cell must be refused, or null when it may run.
 */
export function adversarialRefusal(
  scenario: Scenario,
  agent: RegistryEntry,
  company: RegistryEntry,
  lane: "local" | "live"
): string | null {
  const isSecurity = !!scenario.adversary || !!scenario.faults?.length || !!agent.adversarial || !!company.adversarial;
  if (!isSecurity) return null;
  if (lane === "live") return "adversarial cells never run in the live lane";
  const honest = [agent, company].filter((entry) => !entry.adversarial);
  // Only the evil Company against an agent: no evil agent, no network faults, no attack by the agent side.
  const evilCompanyOnly = !!company.adversarial && !agent.adversarial && !scenario.faults?.length && scenario.adversary !== "agent";
  const outsiders = honest
    .filter((entry) => entry.owner !== "self" && !(evilCompanyOnly && entry === agent))
    .map((entry) => entry.name);
  if (outsiders.length) return `adversarial cells run only against our own implementations; ${outsiders.join(", ")} is not owner:self`;
  return null;
}

async function runCells(options: {
  scenarios: readonly Scenario[];
  agents: readonly Implementation[];
  companies: readonly Implementation[];
  control: Control;
  proxy: Proxy | null;
  resultsDir: string;
  lane: "local" | "live";
  retry: boolean;
  log: (line: string) => void;
}): Promise<Cell[]> {
  const cells: Cell[] = [];
  for (const scenario of options.scenarios) {
    for (const agent of options.agents) {
      for (const company of options.companies) {
        const cell: Cell = { agent: agent.entry.name, company: company.entry.name, scenario: scenario.id, outcome: "unsupported", blame: null, rule: null, steps: [], checks: [], har: null };
        cells.push(cell);
        const refusal = adversarialRefusal(scenario, agent.entry, company.entry, options.lane);
        if (refusal) {
          cell.outcome = "error";
          cell.reason = refusal;
          cell.security = true;
          options.log(`${scenario.id.padEnd(4)} ${cell.agent} × ${cell.company}: refused — ${refusal}`);
          continue;
        }
        const broken = agent.broken ?? company.broken;
        if (broken) {
          cell.outcome = "error";
          cell.reason = broken;
          continue;
        }
        const versions = company.manifest!.poppy.filter((version) => agent.manifest!.poppy.includes(version));
        if (!versions.length) {
          cell.reason = "No common Poppy protocol version";
          continue;
        }
        cell.protocolVersion = versions.at(-1);
        cell.specificationRevision = protocolRevision(cell.protocolVersion!);
        const missing = [agent, company].filter((impl) => !impl.manifest!.scenarios.includes(scenario.id)).map((impl) => impl.entry.name);
        const hooks = (scenario.needs?.company ?? []).filter((hook) => !company.hooks.includes(hook));
        if (missing.length || hooks.length) {
          cell.reason = missing.length ? `${missing.join(" and ")} don't list ${scenario.id}` : `${company.entry.name} has no hook ${hooks.join(", ")}`;
          options.log(`${scenario.id.padEnd(4)} ${cell.agent} × ${cell.company}: unsupported (${cell.reason})`);
          continue;
        }
        await runWithRetry(cell, (target, attempt) => runOne(target, scenario, agent, company, { ...options, attempt }), options.retry);
        const flaky = cell.flaky ? ` (flaky: ${cell.attempts![0]!.outcome} first${cell.attempts![0]!.reason ? `, ${cell.attempts![0]!.reason}` : ""})` : "";
        options.log(`${scenario.id.padEnd(4)} ${cell.agent} × ${cell.company}: ${cell.outcome}${cell.reason && cell.outcome !== "pass" ? ` — ${cell.reason}` : ""}${flaky}`);
      }
    }
  }
  return cells;
}

export async function runOne(
  cell: Cell,
  scenario: Scenario,
  agent: Implementation,
  company: Implementation,
  options: { control: Control; proxy: Proxy | null; resultsDir: string; attempt?: number }
): Promise<void> {
  const { control, proxy } = options;
  // A live Company (spec §10) is a public deployment with no adapter, so there's nothing to reset.
  for (const impl of [agent, company].filter((item) => !!item.entry.build)) {
    const reset = await control(impl.target, "POST", "/reset").catch((error: unknown) => ({ status: 0, body: String(error) }));
    if (reset.status !== 200) {
      cell.outcome = "error";
      cell.reason = `${impl.entry.name} didn't reset (HTTP ${reset.status})`;
      return;
    }
  }
  await proxy?.cell(cellId(cell), scenario.faults ?? []);

  let fixture: unknown = {};
  if (company.hooks.includes("fixture")) {
    const answer = await control(company.target, "POST", "/hooks/fixture", {});
    if (answer.status === 200) fixture = answer.body;
  }
  // A live Company has no fixture hook; the live scenarios need only a greeting, which says it is a test (spec §10).
  if (!company.entry.build) fixture = { prompts: { hello: LIVE_GREETING }, ...(company.entry.fixture ?? {}), ...(fixture as Record<string, unknown>) };
  fixture = withWebPage(fixture, company.domain);

  const callbacks: string[] = [];
  const reply = (answer: Answer, agentStep: boolean): Reply => toReply(answer.status, answer.body, agentStep);
  const driver: Driver = {
    agent: async (op, params) => {
      let sent: unknown;
      try {
        sent = inlineFiles(op, params, harnessFile);
      } catch (error) {
        return { kind: "broken", detail: error instanceof Error ? error.message : String(error) };
      }
      const answer = reply(await control(agent.target, "POST", "/step", { op, company: company.domain, params: sent }), true);
      if (!company.entry.build && op === "discover" && answer.kind === "ok") {
        const found = answer.result as { poppy_version?: string };
        if (found.poppy_version !== cell.protocolVersion) return { kind: "broken", detail: `Live Company declares ${found.poppy_version}, but this cell expects ${cell.protocolVersion}; update its registry entry before testing` };
      }
      return answer;
    },
    company: async (hook, params) => {
      const answer = await control(company.target, "POST", `/hooks/${hook}`, params);
      const redirect = (answer.body as { redirect?: unknown } | null)?.redirect;
      if (answer.status === 200 && typeof redirect === "string") callbacks.push(redirect);
      return reply(answer, false);
    },
    runner: async (op, params): Promise<RunnerReply> => {
      const input = (params ?? {}) as Record<string, unknown>;
      if (op === "wait") {
        await new Promise((resolve) => setTimeout(resolve, Number(input.ms ?? 0)));
        return { kind: "ok" };
      }
      if (op === "fetch") {
        if (!proxy) return { kind: "inapplicable", detail: "no proxy in this lane" };
        const headers = { ...((input.headers as Record<string, string>) ?? {}), [PROBE_HEADER]: "1" };
        const answer = (await proxy.fetch({ ...input, headers })) as { status: number; headers: Record<string, string>; body: string };
        return { kind: "ok", result: { status: answer.status, headers: answer.headers, body: parse(answer.body) ?? answer.body } };
      }
      if (op === "assert_trace") {
        // The live lane records nothing, so only steps and expectations decide a cell (spec §10).
        if (!proxy) return { kind: "ok", result: { unrecorded: true } };
        return assertTrace(exchanges(await proxy.har()), params);
      }
      return { kind: "failed", detail: `unknown runner op ${op}` };
    }
  };

  const run = await runCell(scenario, fixture, driver);
  cell.steps = run.steps;
  cell.outcome = run.outcome;
  if (run.reason) cell.reason = run.reason;

  const checks: Check[] = [];
  if (proxy) {
    const har = await proxy.har();
    const retried = (options.attempt ?? 1) > 1 ? `.attempt${options.attempt}` : "";
    const file = path.join(scenario.id, `${cell.agent}__${cell.company}${retried}.har`);
    mkdirSync(path.join(options.resultsDir, scenario.id), { recursive: true });
    writeFileSync(path.join(options.resultsDir, file), `${JSON.stringify(har, null, 1)}\n`);
    cell.har = file;
    const recorded = exchanges(har);
    checks.push(...traceChecks(recorded, callbacks, cell.protocolVersion));
    checks.push(...(await documentChecks(recorded, cell.protocolVersion)));
    if (cell.protocolVersion !== "0.2") {
      checks.push(...readingChecks(recorded, agent.manifest?.readings ?? {}));
      checks.push(...refusedReadingChecks(recorded, company.manifest?.readings ?? {}));
    }
  }
  // What each side recorded of the other: the mock Company of the agent, the strict fake agent of the Company (spec §5.3).
  const isSecurity = !!scenario.adversary || !!scenario.faults?.length || !!agent.entry.adversarial || !!company.entry.adversarial;
  for (const [side, recorder] of [["company", company], ["agent", agent]] as const) {
    if (side === "company" && !company.entry.build) continue;
    const violations = await control(recorder.target, "GET", "/violations").catch(() => ({ status: 0, body: null }));
    const recordedViolations = (violations.body as { violations?: RecordedViolation[] } | null)?.violations;
    if (violations.status !== 200 || !Array.isArray(recordedViolations)) continue;
    for (const violation of recordedViolations) {
      checks.push(side === "company" ? companyRecorded(violation, company.entry.name, isSecurity) : agentRecorded(violation, agent.entry.name, isSecurity));
    }
  }
  cell.checks = checks;
  // In an adversarial cell the attacking side's own violations are expected (rule 0): don't fail
  // the cell for them, whether the runner's trace checks or the Company's /violations recorded them.
  const adversarialSide = agent.entry.adversarial ? "agent" : company.entry.adversarial ? "company" : null;
  const errors = checks.filter((check) => check.severity === "error" && check.side !== adversarialSide);
  if (cell.outcome === "pass" && errors.length > 0) {
    cell.outcome = "fail";
    cell.reason = `checks: ${errors.map((check) => `${check.id} (${check.side})`).join(", ")}`;
  }
}

/**
 * Which dimensions a run covered whole, so that a `*` in a known failure is
 * judged over them (spec section 9). The interop grid is the honest
 * implementations and the scenarios without an adversary or faults: the
 * adversarial ones run apart, against our own implementations only (section
 * 13), so a full grid that leaves them out still covers its dimensions.
 */
export function gridCoverage(
  registry: Registry,
  lane: "local" | "live",
  ran: { readonly agents: readonly RegistryEntry[]; readonly companies: readonly RegistryEntry[]; readonly scenarios: readonly Scenario[] },
  all: readonly Scenario[]
): { agent: boolean; company: boolean; scenario: boolean } {
  const honest = (role: Role) => selected(registry, role, null, lane).filter((entry) => !entry.adversarial);
  const names = (entries: readonly RegistryEntry[]) => new Set(entries.map((entry) => `${entry.role}:${entry.name}`));
  const ranAgents = names(ran.agents);
  const ranCompanies = names(ran.companies);
  const ranScenarios = new Set(ran.scenarios.map((scenario) => scenario.id));
  return {
    agent: honest("agent").every((entry) => ranAgents.has(`${entry.role}:${entry.name}`)),
    company: honest("company").every((entry) => ranCompanies.has(`${entry.role}:${entry.name}`)),
    scenario: lane === "local" && all.filter((scenario) => !scenario.adversary && !scenario.faults?.length).every((scenario) => ranScenarios.has(scenario.id))
  };
}

/**
 * The implementations a lane can run, by role. The live lane runs only our
 * own agents (`owner: "self"`, built here: `pda` and the lenient and strict fakes,
 * not one marked `"live": false`) against Companies with a `url` (spec §10): no
 * third-party image, and its identity's key goes to nothing else.
 */
export function selected(registry: Registry, role: Role, names: readonly string[] | null, lane: "local" | "live"): RegistryEntry[] {
  const runs = (entry: RegistryEntry) =>
    lane === "live" ? (role === "agent" ? !!entry.build && entry.owner === "self" && entry.live !== false : !!entry.url) : !!entry.build;
  const all = registry.implementations.filter((entry) => entry.role === role && runs(entry));
  if (!names) return all.filter((entry) => !entry.vectorsOnly);
  for (const name of names) {
    if (!all.some((entry) => entry.name === name)) throw new Error(`No ${role} ${name} in the registry for the ${lane} lane`);
  }
  return all.filter((entry) => names.includes(entry.name));
}

/**
 * A live-lane agent container's environment: the runner's own variables, the registry's `env`
 * (a fake agent's `INTEROP_AGENT_PROFILE`), then `--set`, then the live identity's public half.
 */
export function liveAgentEnv(
  entry: RegistryEntry,
  secret: string,
  commit: string,
  set: Readonly<Record<string, string>> | undefined,
  identity: Readonly<Record<string, string>>
): Record<string, string> {
  return { INTEROP_SECRET: secret, INTEROP_NAME: entry.name, INTEROP_COMMIT: commit, INTEROP_PACE_MS: "1000", ...(entry.env ?? {}), ...(set ?? {}), ...identity };
}

/**
 * An implementation's image. Entries of one role that build the same
 * directory in the same context (`lenient-company` and `strict-company`, told
 * apart by `env`) share one image, named after the first in the registry.
 */
export function imageOf(entry: RegistryEntry, registry: Registry, tag = "latest"): string {
  const same = (other: RegistryEntry) => other.role === entry.role && other.build === entry.build && (other.context ?? other.build) === (entry.context ?? entry.build) && JSON.stringify(other.buildArgs ?? {}) === JSON.stringify(entry.buildArgs ?? {});
  const first = entry.build ? (registry.implementations.find(same) ?? entry) : entry;
  return `poppy-interop/${first.role}-${first.name}:${tag}`;
}

async function buildImages(entries: readonly RegistryEntry[], registry: Registry, logs: string, log: (line: string) => void, tag = "latest", buildJobs = 2): Promise<Map<string, string>> {
  const failures = new Map<string, string>();
  const byImage = new Map<string, RegistryEntry[]>();
  for (const entry of entries) byImage.set(imageOf(entry, registry, tag), [...(byImage.get(imageOf(entry, registry, tag)) ?? []), entry]);
  const builds = [
    { key: "proxy", targets: ["proxy"], args: ["build", "-t", `poppy-interop/proxy:${tag}`, path.join(INTEROP, "proxy")] },
    ...[...byImage].map(([image, sharing]) => {
      const entry = sharing[0]!;
      const dir = path.join(ROOT, entry.build!);
      const context = entry.context ? path.join(ROOT, entry.context) : dir;
      return {
        key: image.replace(/^poppy-interop\//, "").replace(/:[^:]+$/, ""),
        targets: sharing.map((item) => `${item.role}-${item.name}`),
        args: ["build", ...Object.entries(entry.buildArgs ?? {}).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]), "-t", image, "-f", path.join(dir, "Dockerfile"), context]
      };
    })
  ];
  log(`building ${builds.map((b) => b.key).join(", ")}`);
  if (process.env.CODEX_PROXY_CERT) {
    for (const build of builds) build.args.splice(1, 0, "--secret", `id=proxy_ca,src=${process.env.CODEX_PROXY_CERT}`, "--secret", "id=system_ca,src=/etc/ssl/certs/ca-certificates.crt");
  }
  const results = await mapConcurrent(builds, buildJobs, async (b) => {
    const result = { ...b, ...(await dockerAsync(b.args)) };
    // Retain completed logs even if a later build is interrupted.
    writeFileSync(path.join(logs, `build-${result.key}.log`), result.output);
    return result;
  });
  for (const result of results) {
    if (result.code !== 0) for (const target of result.targets) failures.set(target, `image build failed (logs/build-${result.key}.log)`);
  }
  return failures;
}

export async function main(argv: readonly string[], provisioned?: (context: { containers: Record<string, string>; runDir: string }) => Promise<void>): Promise<number> {
  const options = parseOptions(argv);
  const log = (line: string) => console.log(line);
  const registry = loadRegistry();
  const known = loadKnownFailures();
  let scenarios = loadScenarios();
  if (options.scenarios) {
    for (const id of options.scenarios) if (!scenarios.some((scenario) => scenario.id === id)) throw new Error(`No scenario ${id}`);
    scenarios = scenarios.filter((scenario) => options.scenarios!.includes(scenario.id));
  }
  // The live lane never runs adversarial scenarios (spec §10): never attack a public deployment.
  if (options.lane === "live") scenarios = scenarios.filter((scenario) => scenario.live && !scenario.adversary && !scenario.faults?.length && !(scenario.needs?.company?.length));
  let agents = selected(registry, "agent", options.agents, options.lane);
  let companies = selected(registry, "company", options.companies, options.lane);
  if (options.lane === "live") {
    // Adversarial implementations never run in the live lane (spec §10).
    agents = agents.filter((entry) => !entry.adversarial);
    companies = companies.filter((entry) => !entry.adversarial);
  }
  if (!agents.length || !companies.length) throw new Error("Nothing to run: no agents or no Companies selected");

  const run = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const tag = randomBytes(3).toString("hex");
  const runDir = options.out ? path.resolve(options.out) : path.join(INTEROP, "results", `${run.replace(/:/g, "-")}-${tag}`);
  const logs = path.join(runDir, "logs");
  const exec = (args: string[]) => docker(args, { quiet: true });
  const tooFull = lowDisk(dockerFreeGb(tag, exec), options.minFreeGb);
  if (tooFull) throw new Error(tooFull);
  mkdirSync(logs, { recursive: true });
  const secret = randomBytes(24).toString("hex");
  const names = localNames(tag);
  const label = labelArgs(tag);
  const containers: string[] = [];
  log(`run ${run} (${options.lane} lane, label interop.run=${tag}) → ${path.relative(process.cwd(), runDir) || "."}`);

  const implementations: Implementation[] = [...agents, ...companies].map((entry) => ({
    entry,
    target: `${entry.role}-${entry.name}`,
    domain: domainOf(entry, options.lane),
    manifest: null,
    hooks: [],
    broken: null
  }));
  const liveAgents = options.lane === "live";
  let cells: Cell[] = [];
  /** The local lane's proof of isolation: the network is internal and the egress probe got nowhere. */
  let isolation: { network: string; internal: true; probe: Record<string, string> } | null = null;
  const certs = mkdtempSync(path.join(tmpdir(), "poppy-interop-"));
  // Everything this run made on Docker goes with it, however it ends (unless --keep).
  const cleanUp = () => {
    if (options.keep) return;
    const { errors } = removeRun(tag, exec);
    for (const error of errors) log(`! cleanup: ${error}`);
  };
  const interrupted = (signal: NodeJS.Signals) => {
    log(`\n${signal}: removing this run's containers and network${options.keep ? " (no: --keep)" : ""}`);
    cleanUp();
    rmSync(certs, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const buildFailures = options.build ? await buildImages(liveAgents ? agents : [...agents, ...companies], registry, logs, log, options.imageTag, options.buildJobs) : new Map<string, string>();
    if (buildFailures.has("proxy") && !liveAgents) throw new Error(`The proxy didn't build: ${buildFailures.get("proxy")}`);
    for (const impl of implementations) impl.broken = buildFailures.get(impl.target) ?? null;

    let control: Control;
    let proxy: Proxy | null = null;
    if (options.lane === "local") {
      // The local lane: an --internal network with no way out (spec §3, Isolation; network.ts).
      const { ca } = makeCertificates(certs, run, companies.map((entry) => entry.name));
      const trust = path.join(certs, "trust");
      mkdirSync(trust);
      writeFileSync(path.join(trust, "ca.pem"), readFileSync(ca));
      // Only this public certificate is copied to implementations. Docker cp
      // preserves restrictive host modes, so non-root adapters need explicit access.
      chmodSync(trust, 0o755);
      chmodSync(path.join(trust, "ca.pem"), 0o644);
      const proxyCerts = path.join(certs, "proxy");
      mkdirSync(proxyCerts);
      for (const file of ["ca.pem", "proxy.pem", "proxy.key"]) writeFileSync(path.join(proxyCerts, file), readFileSync(path.join(certs, file)));
      // Isolation (spec §3): the internal network first, proven to have no way out before any
      // implementation starts on it. Nothing here can turn --internal off.
      docker(isolatedNetworkArgs(tag), { quiet: true });
      if (docker(["network", "inspect", "--format", INTERNAL_FORMAT, names.network], { quiet: true }) !== "true") {
        throw new Error(`The run's network ${names.network} isn't internal; refusing to run implementations on it`);
      }
      docker(controlNetworkArgs(tag), { quiet: true });

      const aliases = proxyAliases(
        agents.map((entry) => entry.name),
        companies.map((entry) => ({ name: entry.name, ...(entry.subdomains ? { subdomains: entry.subdomains } : {}) }))
      );
      const proxyImage = `poppy-interop/proxy:${options.imageTag}`;
      docker(proxyCreateArgs(tag, aliases, proxyImage), { quiet: true });
      containers.push(names.proxy);
      docker(["cp", proxyCerts, `${names.proxy}:/interop`], { quiet: true });
      docker(["start", names.proxy], { quiet: true });
      const probe = docker(egressProbeArgs(names.proxy), { quiet: true });
      const egress = egressRefusal(probe);
      if (egress) throw new Error(`Isolation: ${egress}`);
      const verdict = probe.trim().split("\n").at(-1)!;
      isolation = { network: names.network, internal: true, probe: JSON.parse(verdict) as Record<string, string> };
      log(`isolation: ${names.network} is internal; egress probe from inside it: ${verdict}`);

      docker(relayCreateArgs(tag, proxyImage), { quiet: true });
      containers.push(names.relay);
      docker(relayConnectArgs(tag), { quiet: true });
      docker(["start", names.relay], { quiet: true });
      const port = Number(docker(["port", names.relay, `${CONTROL_PORT}/tcp`], { quiet: true }).split("\n")[0]!.split(":").at(-1));
      proxy = new Proxy(port);
      const up = await waitFor(async () => (await fetch(`${proxy!.base}/healthz`)).ok, 30_000);
      if (!up) throw new Error(`The proxy didn't come up through the relay on port ${port}`);
      control = proxy.control(secret);

      for (const impl of implementations) {
        if (impl.broken) continue;
        const name = `${names.network}-${impl.target}`;
        const env = {
          INTEROP_SECRET: secret,
          INTEROP_NAME: impl.entry.name,
          INTEROP_ROLE: impl.entry.role,
          INTEROP_DOMAIN: impl.domain,
          INTEROP_ORIGIN: `https://${impl.domain}`,
          INTEROP_COMMIT: commitOf(impl.entry),
          NODE_EXTRA_CA_CERTS: "/interop/ca.pem",
          SSL_CERT_FILE: "/interop/ca.pem",
          REQUESTS_CA_BUNDLE: "/interop/ca.pem",
          ...(impl.entry.env ?? {}),
          ...(options.set.get(impl.entry.name) ?? {})
        };
        docker(implementationCreateArgs(tag, name, impl.target, env, imageOf(impl.entry, registry, options.imageTag)), { quiet: true });
        containers.push(name);
        docker(["cp", trust, `${name}:/interop`], { quiet: true });
        docker(["start", name], { quiet: true });
      }
    } else {
      // The live lane (spec §10), which needs the internet by definition: our agent alone, on
      // Docker's default bridge with its control port published; Companies are public deployments.
      // It never creates the local lane's network or runs a third-party image, and the local lane
      // never comes here: no option gives the local lane egress.
      const ports = new Map<string, number>();
      // The live identity (live-identity.ts): a client_id a public Company can fetch, and its key, for our own agent only.
      const identity = readLiveIdentity();
      log(liveIdentityNotice(identity));
      for (const impl of implementations.filter((item) => item.entry.role === "agent" && !item.broken)) {
        const name = `${names.network}-${impl.target}`;
        const live = liveIdentityEnv(options.lane, impl.entry, identity);
        const env = liveAgentEnv(impl.entry, secret, commitOf(impl.entry), options.set.get(impl.entry.name), live.public);
        // The key goes through the docker CLI's environment (`-e NAME`), never its arguments, so `ps` doesn't show it.
        const passed = Object.keys(live.secret).flatMap((key) => ["-e", key]);
        docker(
          ["run", "-d", "--name", name, ...label, ...(process.env.CODEX_PROXY_CERT ? ["--mount", `type=bind,src=${process.env.CODEX_PROXY_CERT},dst=/run/interop-live-ca.pem,readonly`, "-e", "NODE_EXTRA_CA_CERTS=/run/interop-live-ca.pem"] : []), "-p", "127.0.0.1::8081", ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), ...passed, imageOf(impl.entry, registry, options.imageTag)],
          { quiet: true, env: live.secret }
        );
        containers.push(name);
        ports.set(impl.target, Number(docker(["port", name, "8081/tcp"], { quiet: true }).split("\n")[0]!.split(":").at(-1)));
      }
      control = async (target, method, pathname, body) => {
        const port = ports.get(target);
        // A live Company has no adapter: a hook is unsupported (501), so an optional step is skipped (spec §5).
        if (!port) return { status: 501, body: { error: "unsupported", detail: `${target} has no control API in the live lane` } };
        const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
          method,
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        return { status: response.status, body: parse(await response.text()) };
      };
      for (const impl of implementations.filter((item) => item.entry.role === "company")) {
        impl.manifest = liveCompanyManifest(impl.entry, scenarios);
      }
    }

    // Health, manifests and hooks.
    for (const impl of implementations) {
      if (impl.broken || impl.manifest) continue;
      const healthy = await waitFor(async () => (await control(impl.target, "GET", "/healthz")).status === 200, 60_000);
      if (!healthy) {
        impl.broken = `${impl.entry.name} never answered /healthz`;
        continue;
      }
      const manifest = await control(impl.target, "GET", "/manifest");
      const body = manifest.body as Manifest | null;
      if (manifest.status !== 200 || !body || body.interop !== 1 || !Array.isArray(body.scenarios)) {
        impl.broken = `${impl.entry.name} served no version 1 manifest`;
        continue;
      }
      impl.manifest = body;
      if (impl.entry.role === "company") {
        const hooks = await control(impl.target, "GET", "/hooks");
        impl.hooks = Array.isArray((hooks.body as { hooks?: unknown } | null)?.hooks) ? (hooks.body as { hooks: string[] }).hooks : [];
      }
    }
    for (const impl of implementations) if (impl.broken) log(`! ${impl.broken}`);

    if (provisioned) {
      if (options.lane !== "local" || implementations.some((impl) => impl.broken)) throw new Error("External validator requires healthy isolated containers");
      await provisioned({ containers: Object.fromEntries(implementations.map((impl) => [impl.target, `${names.network}-${impl.target}`])), runDir });
    }
    cells = await runCells({
      scenarios,
      agents: implementations.filter((impl) => impl.entry.role === "agent"),
      companies: implementations.filter((impl) => impl.entry.role === "company"),
      control,
      proxy,
      resultsDir: runDir,
      lane: options.lane,
      retry: options.retry,
      log
    });
  } finally {
    for (const name of containers) {
      try {
        writeFileSync(path.join(logs, `${name.replace(`${names.network}-`, "")}.log`), (await dockerAsync(["logs", name])).output);
      } catch {
        // No logs.
      }
    }
    cleanUp();
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    rmSync(certs, { recursive: true, force: true });
  }

  // By role: a project with both sides has one name in each, and its two sides may read differently.
  const byRole = (role: "agent" | "company") =>
    Object.fromEntries(implementations.filter((impl) => impl.entry.role === role).map((impl) => [impl.entry.name, { ...(impl.manifest?.readings ?? {}) }]));
  const readings = { agent: byRole("agent"), company: byRole("company") };
  const adversarial = new Set(implementations.filter((impl) => impl.entry.adversarial).map((impl) => impl.entry.name));
  attributeAll(cells, { readings, scenarios: new Map(scenarios.map((scenario) => [scenario.id, scenario])), known, adversarial });
  // A `*` is judged only over a dimension this run covered whole.
  const coverage = gridCoverage(registry, options.lane, { agents, companies, scenarios }, loadScenarios());
  const stale = staleKnown(cells, known, coverage);
  const summary = {
    interop: 1,
    run,
    spec: SPEC,
    lane: options.lane,
    ...(isolation ? { isolation } : {}),
    implementations: implementations.map((impl) => ({
      name: impl.entry.name,
      role: impl.entry.role,
      commit: commitOf(impl.entry),
      readings: { ...(impl.manifest?.readings ?? {}) },
      relaxations: [...(impl.manifest?.relaxations ?? [])],
      ...(impl.entry.adversarial ? { adversarial: true } : {}),
      ...(impl.broken ? { broken: impl.broken } : {})
    })),
    cells,
    flaky: cells.filter((cell) => cell.flaky).map(({ agent, company, scenario }) => ({ agent, company, scenario })),
    staleKnown: stale,
    // Checks per level over the interop cells (docs/conformance-levels.md): failures fail cells; warnings and tentative readings don't.
    levels: levelCounts(cells)
  };
  writeFileSync(path.join(runDir, "results.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(runDir, "index.html"), renderReport({ ...summary, scenarios }));

  const bad = unexpected(cells);
  const counts = ["pass", "fail", "unsupported", "error"].map((outcome) => `${cells.filter((cell) => cell.outcome === outcome).length} ${outcome}`);
  log(`\n${counts.join(", ")}; ${cells.filter((cell) => cell.known).length} known failure(s).`);
  log(`Checks: ${summary.levels.failure} failures, ${summary.levels.warning} warnings, ${summary.levels.tentative} tentative (our readings).`);
  for (const cell of cells.filter((c) => c.outcome === "fail" || c.outcome === "error")) {
    log(`  ${cell.scenario} ${cell.agent} × ${cell.company}: ${cell.outcome}, blame ${cell.blame ?? "none"} (${cell.rule ?? "no rule"})${cell.known ? `, known: ${cell.known.issue}` : ""}`);
  }
  const flaky = cells.filter((cell) => cell.flaky);
  if (flaky.length) log(`\nFlaky (failed or errored, then passed on retry; counted as passes):`);
  for (const cell of flaky) log(`  ${cell.scenario} ${cell.agent} × ${cell.company}: first ${cell.attempts![0]!.outcome}${cell.attempts![0]!.reason ? ` — ${cell.attempts![0]!.reason}` : ""}`);
  if (stale.length) log(`\nStale known failures (matched no failed cell; fixed, or the entry is wrong), which fail the run:`);
  for (const entry of stale) log(`  ${entry.agent} × ${entry.company} ${entry.scenario}: ${entry.issue}`);
  log(`Results: ${path.join(runDir, "index.html")}`);
  return bad.length > 0 || stale.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    }
  );
}
