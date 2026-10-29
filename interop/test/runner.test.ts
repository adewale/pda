import type { RegistryEntry } from "../runner/types.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { upstreamFor } from "../proxy/routing.mjs";
import { VIOLATION_IDS } from "../../test/mock-company/violations.ts";
import { certificateNames, makeCertificates } from "../runner/certs.ts";
import { TRACE_CHECKS } from "../runner/checks.ts";
import { gridCoverage, liveCompanyManifest, imageOf, loadKnownFailures, loadRegistry, loadScenarios, negotiateVersion, parseOptions, runExitCode, runOne, selected } from "../runner/cli.ts";
import { PROTOCOL_VERSIONS } from "../../src/poppy/protocol-version.ts";
import { dockerAsync, mapConcurrent, proxyAliases } from "../runner/docker.ts";
import { documentChecks, recordedFetcher } from "../runner/documents.ts";
import { cellId, renderReport } from "../runner/report.ts";
import type { Cell } from "../runner/types.ts";
import { recording } from "./helpers.ts";

describe("options", () => {
  it("parses lists, the lane and per-implementation settings", () => {
    const options = parseOptions(["--agents", "pda", "--companies", "lenient-company,x", "--scenarios", "D,SD", "--set", "pda:INTEROP_FAULT=assertion-typ", "--no-build"]);
    expect(options).toMatchObject({ agents: ["pda"], companies: ["lenient-company", "x"], scenarios: ["D", "SD"], lane: "local", build: false, keep: false });
    expect(options.set.get("pda")).toEqual({ INTEROP_FAULT: "assertion-typ" });
    expect(parseOptions([]).agents).toBeNull();
    expect(parseOptions([]).requireSupported).toBe(false);
    expect(parseOptions(["--require-supported"]).requireSupported).toBe(true);
    expect(() => parseOptions(["--lane", "moon"])).toThrow("--lane must be local or live");
    expect(() => parseOptions(["--set", "pda=1"])).toThrow("--set takes name:KEY=VALUE");
  });

  it("retries failed cells and wants 2 GB free unless told otherwise", () => {
    expect(parseOptions([])).toMatchObject({ retry: true, minFreeGb: 2 });
    expect(parseOptions(["--no-retry", "--min-free-gb", "0.5"])).toMatchObject({ retry: false, minFreeGb: 0.5 });
    expect(() => parseOptions(["--min-free-gb", "lots"])).toThrow("--min-free-gb takes a number");
  });
});

describe("Docker logs", () => {
  it.each([0, 7])("retains both log streams when Docker exits %i", async (code) => {
    const dir = mkdtempSync(path.join(tmpdir(), "interop-log-streams-"));
    const previous = process.env.PATH;
    try {
      // A real child process, without Docker: startup errors arrive on stderr.
      writeFileSync(path.join(dir, "docker"), '#!/bin/sh\nprintf "normal log\\n"\nprintf "startup error\\n" >&2\nexit "$3"\n', { mode: 0o700 });
      process.env.PATH = `${dir}:${previous ?? ""}`;
      expect(await dockerAsync(["logs", "fixture", String(code)])).toEqual({ code, output: "normal log\nstartup error\n" });
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("build scheduling", () => {
  it("starts the next build only when a slot is released and preserves results despite out-of-order completion", async () => {
    const started: number[] = [];
    const release = new Map<number, (value: string) => void>();
    const result = mapConcurrent([0, 1, 2, 3], 2, (item) => {
      started.push(item);
      return new Promise<string>((resolve) => release.set(item, resolve));
    });
    expect(started).toEqual([0, 1]);
    release.get(1)!("one");
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    release.get(2)!("two");
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    release.get(3)!("three");
    release.get(0)!("zero");
    expect(await result).toEqual(["zero", "one", "two", "three"]);
  });

  it("handles an empty registry without starting anything", async () => {
    expect(await mapConcurrent([], 2, async () => { throw new Error("must not run"); })).toEqual([]);
  });

  it.each([1, 2, 4, Number.MAX_SAFE_INTEGER])("runs every build once within the concurrency boundary %i", async (limit) => {
    let active = 0, peak = 0;
    const visited: number[] = [];
    const results = await mapConcurrent([0, 1, 2], limit, async (item) => {
      visited.push(item);
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return item;
    });
    expect(results).toEqual([0, 1, 2]);
    expect(visited).toEqual([0, 1, 2]);
    expect(peak).toBe(Math.min(limit, 3));
    expect(active).toBe(0);
  });

  it.each(["0", "-1", "1.5", "Infinity", "-Infinity", "not-a-number", String(Number.MAX_SAFE_INTEGER + 1)])("refuses invalid build concurrency %s instead of silently skipping builds", async (value) => {
    expect(() => parseOptions([`--build-jobs=${value}`])).toThrow("positive whole number");
    await expect(mapConcurrent([1], Number(value), async () => { throw new Error("must not start"); })).rejects.toThrow("positive whole number");
  });

  it("defaults to two builds and allows an explicit positive count", () => {
    expect(parseOptions([]).buildJobs).toBe(2);
    expect(parseOptions(["--build-jobs", "1"]).buildJobs).toBe(1);
  });
});

describe("the registry and known failures", () => {
  it("judges a * over the honest grid: a full grid without the adversarial implementations and scenarios covers every dimension", () => {
    const registry = loadRegistry();
    const all = loadScenarios();
    const local = (role: string) => registry.implementations.filter((entry) => entry.role === role && entry.build);
    const honest = (role: string) => local(role).filter((entry) => !entry.adversarial);
    const interop = all.filter((scenario) => !scenario.adversary && !scenario.faults?.length);
    expect(interop.length).toBeLessThan(all.length);
    expect(gridCoverage(registry, "local", { agents: honest("agent"), companies: honest("company"), scenarios: interop }, all)).toEqual({ agent: true, company: true, scenario: true });
    expect(gridCoverage(registry, "local", { agents: local("agent"), companies: local("company"), scenarios: all }, all)).toEqual({ agent: true, company: true, scenario: true });
    // Leaving out an honest implementation or an interop scenario makes the run partial.
    const partial = gridCoverage(registry, "local", { agents: honest("agent").slice(1), companies: honest("company").slice(1), scenarios: interop.slice(1) }, all);
    expect(partial).toEqual({ agent: false, company: false, scenario: false });
    // The live lane never judges a * scenario: it runs only the live ones.
    expect(gridCoverage(registry, "live", { agents: honest("agent"), companies: [], scenarios: all }, all).scenario).toBe(false);
  });

  it("provisions a vectors-only entry only when explicitly selected for its lane", () => {
    const base = loadRegistry();
    // The official validator was one, until its 0.2 lane was retired with 0.2 (docs/interop-spec.md).
    const registry = { ...base, implementations: [...base.implementations, { name: "a-vector-lane", role: "agent", owner: "self", source: "https://example.com", commit: "HEAD", build: "interop/impls/pda-agent", vectorsOnly: true } as RegistryEntry] };
    expect(selected(registry, "agent", null, "local").some((entry) => entry.name === "a-vector-lane")).toBe(false);
    expect(selected(registry, "agent", ["a-vector-lane"], "local")).toHaveLength(1);
  });

  it("lists our agent and the reference Company, each with a Dockerfile", () => {
    const registry = loadRegistry();
    const names = registry.implementations.map((entry) => `${entry.role}:${entry.name}`);
    expect(names).toEqual(expect.arrayContaining(["agent:pda", "company:lenient-company"]));
    for (const entry of registry.implementations.filter((item) => item.build)) {
      expect(readFileSync(path.join(import.meta.dirname, "../..", entry.build!, "Dockerfile"), "utf8")).toContain("FROM ");
    }
  });

  it("reads known failures, each with an issue, a reason and the failure it expects, naming registry entries or *", () => {
    const registry = loadRegistry();
    const names = (role: string) => new Set(registry.implementations.filter((entry) => entry.role === role).map((entry) => entry.name));
    const scenarios = new Set(loadScenarios().map((scenario) => scenario.id));
    for (const failure of loadKnownFailures()) {
      expect(failure.issue).toMatch(/^https:\/\//);
      expect(failure.reason, JSON.stringify(failure)).toBeTruthy();
      expect(failure.agent === "*" || names("agent").has(failure.agent), failure.agent).toBe(true);
      expect(failure.company === "*" || names("company").has(failure.company), failure.company).toBe(true);
      expect(failure.scenario === "*" || scenarios.has(failure.scenario), failure.scenario).toBe(true);
      // What the failure looks like: a blame, and checks the grid knows (a trace check, or one our mock records).
      expect("blame" in failure, JSON.stringify(failure)).toBe(true);
      for (const id of failure.checks ?? []) expect(id in TRACE_CHECKS || (VIOLATION_IDS as readonly string[]).includes(id), id).toBe(true);
    }
  });

  it("builds one image for entries that differ only in env: the strict mock is the reference mock's image", () => {
    const registry = loadRegistry();
    const entry = (name: string) => registry.implementations.find((item) => item.role === "company" && item.name === name)!;
    expect(imageOf(entry("lenient-company"), registry)).toBe("poppy-interop/company-lenient-company:latest");
    expect(imageOf(entry("strict-company"), registry)).toBe("poppy-interop/company-lenient-company:latest");
    expect(entry("strict-company").env).toEqual({ INTEROP_MOCK_PROFILE: "strict" });
  });
});

describe("the network", () => {
  it("routes every Company and agent name to its container", () => {
    expect(upstreamFor("lenient-company.company.interop.test")).toBe("company-lenient-company");
    expect(upstreamFor("auth.lenient-company.company.interop.test:443")).toBe("company-lenient-company");
    expect(upstreamFor("www.uk.lenient-company.company.interop.test")).toBe("company-lenient-company");
    expect(upstreamFor("pda.agent.interop.test")).toBe("agent-pda");
    expect(upstreamFor("runner.interop.test")).toBeNull();
    expect(upstreamFor("example.com")).toBeNull();
  });

  it("aliases every name to the proxy, and covers each Company's subdomains in the certificate", () => {
    const aliases = proxyAliases(["pda"], [{ name: "acme", subdomains: ["shop"] }]);
    expect(aliases).toEqual(expect.arrayContaining(["runner.interop.test", "pda.agent.interop.test", "acme.company.interop.test", "auth.acme.company.interop.test", "shop.acme.company.interop.test"]));
    expect(certificateNames(["acme"])).toEqual(["*.company.interop.test", "*.acme.company.interop.test", "*.agent.interop.test", "runner.interop.test"]);
  });

  it("makes a CA and a certificate for those names with openssl", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "interop-certs-"));
    try {
      const { ca } = makeCertificates(dir, "test", ["acme"]);
      const text = execFileSync("openssl", ["x509", "-in", path.join(dir, "proxy.pem"), "-noout", "-text"], { encoding: "utf8" });
      expect(text).toContain("DNS:*.acme.company.interop.test");
      execFileSync("openssl", ["verify", "-CAfile", ca, path.join(dir, "proxy.pem")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("discovery documents from the recording", () => {
  const poppy = (body: unknown, headers: Record<string, string> = { "cache-control": "max-age=300" }) => ({
    url: "https://acme.company.interop.test/.well-known/poppy.json",
    response: body,
    responseHeaders: { "content-type": "application/json", ...headers }
  });

  it("answers only what was recorded", async () => {
    const fetcher = recordedFetcher(recording(poppy({ a: 1 })));
    expect(await (await fetcher(new Request("https://acme.company.interop.test/.well-known/poppy.json"))).json()).toEqual({ a: 1 });
    await expect(fetcher(new Request("https://acme.company.interop.test/other"))).rejects.toThrow("not in the recording");
  });

  it("runs src/validator over the documents a Company served", async () => {
    const checks = await documentChecks(recording(poppy({ protocol_version: "0.1", organization: { name: "Acme" } })));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check) => check.side === "company" && check.source === "validator" && check.id.startsWith("validator."))).toBe(true);
    expect(checks.some((check) => check.severity === "error")).toBe(true);
  });
});

describe("the report", () => {
  it("draws a grid per scenario and a section per cell, escaping what implementations said", () => {
    const cells: Cell[] = [
      { agent: "pda", company: "lenient-company", scenario: "SD", outcome: "pass", blame: null, rule: null, steps: [], checks: [], har: "SD/pda__lenient-company.har" },
      { agent: "pda", company: "x", scenario: "SD", outcome: "fail", blame: "agent", rule: "violation", steps: [{ actor: "agent", op: "session", ms: 3, ok: false, error: "<script>" }], checks: [], har: null }
    ];
    const html = renderReport({
      run: "r",
      lane: "local",
      spec: "Draft 0.1",
      implementations: [
        { name: "pda", role: "agent", commit: "abc", readings: { S1: "token-endpoint" }, relaxations: [] },
        { name: "lenient-company", role: "company", commit: "abc", readings: {}, relaxations: [] },
        { name: "x", role: "company", commit: "def", readings: {}, relaxations: ["Accepts *.interop.test"] }
      ],
      scenarios: [{ id: "SD", title: "Direct Sign-In", steps: [] }],
      cells
    });
    expect(html).toContain(`href="#${cellId(cells[1]!)}"`);
    expect(html).toContain("fail · agent (violation)");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Accepts *.interop.test");
    expect(html).not.toContain("Flaky cells");
    expect(html).not.toContain("Stale known failures");
  });

  it("lists flaky cells and stale known failures", () => {
    const flaky: Cell = {
      agent: "pda",
      company: "x",
      scenario: "SD",
      outcome: "pass",
      blame: null,
      rule: null,
      steps: [],
      checks: [],
      har: "SD/pda__x.attempt2.har",
      flaky: true,
      attempts: [
        { outcome: "error", reason: "x didn't reset", har: "SD/pda__x.har" },
        { outcome: "pass", har: "SD/pda__x.attempt2.har" }
      ]
    };
    const html = renderReport({
      run: "r",
      lane: "local",
      spec: "Draft 0.1",
      implementations: [],
      scenarios: [{ id: "SD", title: "Direct Sign-In", steps: [] }],
      cells: [flaky],
      staleKnown: [{ agent: "pi-poppy", company: "*", scenario: "SE", blame: "agent", issue: "https://example.com/1" }]
    });
    expect(html).toContain("<h2>Flaky cells</h2>");
    expect(html).toContain("pass · flaky");
    expect(html).toContain("first error");
    expect(html).toContain('href="SD/pda__x.har"');
    expect(html).toContain("<h2>Stale known failures</h2>");
    expect(html).toContain("pi-poppy × * SE");
  });
});

/**
 * Live Companies as the registry describes them. Every live peer spoke 0.1 or
 * 0.2 and was retired with them (docs/interop-spec.md), so these are made up.
 */
const liveEntry = (name: string, extra: Record<string, unknown> = {}) => ({ name, role: "company" as const, source: "https://example.com", commit: "unknown", url: `https://${name}.example`, notes: "A made-up live Company.", ...extra });

// A live peer's declared version is the one its cells are attributed to.
it("attributes live cells to the configured wire version, and an entry without one to the version we speak", () => {
  const scenarios = loadScenarios();
  expect(liveCompanyManifest(liveEntry("current", { protocolVersion: "0.3" }), scenarios).poppy).toEqual(["0.3"]);
  expect(liveCompanyManifest(liveEntry("unversioned"), scenarios).poppy).toEqual([...PROTOCOL_VERSIONS].slice(-1));
});

describe("a run that runs nothing", () => {
  const impl = (name: string, poppy: string[], owner?: "self") => ({ entry: { name, role: "agent" as const, source: "https://example.com", commit: "HEAD", ...(owner ? { owner } : {}) }, manifest: { interop: 1, name, role: "agent" as const, commit: "HEAD", poppy, scenarios: ["D"] } });

  // On 29 October the grid's mock still declared 0.1 while our agent spoke 0.3: CI ran 88 cells, every one
  // unsupported for "No common Poppy protocol version", and passed.
  it("blames the harness when two of our own builds share no version", () => {
    expect(negotiateVersion(impl("pda", ["0.3"], "self"), impl("lenient-company", ["0.1"], "self"))).toEqual({
      reason: "No common Poppy protocol version (pda 0.3; lenient-company 0.1)",
      harness: true
    });
    expect(negotiateVersion(impl("pda", ["0.3"], "self"), impl("someone-else", ["0.1"]))).toMatchObject({ harness: false });
    expect(negotiateVersion(impl("pda", ["0.3"], "self"), impl("lenient-company", ["0.2", "0.3"], "self"))).toEqual({ version: "0.3" });
  });

  it("fails a run in which no cell passed or failed, and only then", () => {
    const cell = (outcome: Cell["outcome"]) => ({ agent: "a", company: "c", scenario: "D", outcome, blame: null, rule: null, steps: [], checks: [], har: null }) as Cell;
    expect(runExitCode([cell("unsupported"), cell("unsupported")], [], [])).toBe(1);
    expect(runExitCode([cell("unsupported"), cell("pass")], [], [])).toBe(0);
    expect(runExitCode([cell("pass"), cell("fail")], [], [])).toBe(0);
    expect(runExitCode([], [], [])).toBe(0);
    expect(runExitCode([cell("unsupported"), cell("pass")], [], [], true)).toBe(1);
    expect(runExitCode([cell("pass")], [], [], true)).toBe(0);
  });
});

it("limits a live Company to the scenarios its entry allows: a real store gets discovery only", () => {
  const scenarios = loadScenarios();
  expect(liveCompanyManifest(liveEntry("store", { liveScenarios: ["D"] }), scenarios).scenarios).toEqual(["D"]);
  expect([...liveCompanyManifest(liveEntry("retail", { liveScenarios: ["D", "S0", "N", "CL"] }), scenarios).scenarios].sort()).toEqual(["CL", "D", "N", "S0"]);
  // A real Company's conversation is closed when the test ends: CL runs live, ending with a close; C, which leaves it open, never does.
  const live = scenarios.filter((scenario) => scenario.live);
  expect(live.map((scenario) => scenario.id)).toContain("CL");
  expect(live.filter((scenario) => scenario.steps.some((step) => "agent" in step && step.agent === "send") && !scenario.steps.some((step) => "agent" in step && step.agent === "close")).map((scenario) => scenario.id)).toEqual([]);
  expect(liveCompanyManifest(liveEntry("open", { protocolVersion: "0.3" }), scenarios).scenarios).toHaveLength(scenarios.length);
});

it("stops a live version mismatch before a Session request can send credentials", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-version-mismatch-"));
  const registry = loadRegistry();
  const agentEntry = registry.implementations.find((entry) => entry.name === "pda" && entry.role === "agent")!;
  const companyEntry = { ...liveEntry("current-live", { protocolVersion: "0.3" }) } as unknown as typeof agentEntry;
  const implementation = (entry: typeof agentEntry) => ({ entry, target: entry.name, domain: "company.example", manifest: null, hooks: [], broken: null });
  const calls: string[] = [];
  const cell: Cell = { agent: "pda", company: "current-live", scenario: "S0", protocolVersion: "0.3", outcome: "unsupported", blame: null, rule: null, steps: [], checks: [], har: null };
  try {
    await runOne(cell, loadScenarios().find((scenario) => scenario.id === "S0")!, implementation(agentEntry), implementation(companyEntry), {
      resultsDir: dir, proxy: null,
      control: async (_target, _method, pathname, body) => {
        if (pathname === "/reset") return { status: 200, body: {} };
        if (pathname === "/step") {
          calls.push((body as { op: string }).op);
          return { status: 200, body: { ok: true, result: { poppy_version: "0.1" } } };
        }
        return { status: 501, body: {} };
      }
    });
    expect(cell.outcome).toBe("error");
    expect(cell.reason).toContain("declares 0.1");
    expect(calls).toEqual(["discover"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
