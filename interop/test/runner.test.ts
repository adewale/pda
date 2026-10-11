import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { upstreamFor } from "../proxy/routing.mjs";
import { certificateNames, makeCertificates } from "../runner/certs.ts";
import { imageOf, loadKnownFailures, loadRegistry, loadScenarios, parseOptions } from "../runner/cli.ts";
import { proxyAliases } from "../runner/docker.ts";
import { documentChecks, recordedFetcher } from "../runner/documents.ts";
import { cellId, renderReport } from "../runner/report.ts";
import type { Cell } from "../runner/types.ts";
import { recording } from "./helpers.ts";

describe("options", () => {
  it("parses lists, the lane and per-implementation settings", () => {
    const options = parseOptions(["--agents", "dpa", "--companies", "dpa-mock,x", "--scenarios", "D,SD", "--set", "dpa:INTEROP_FAULT=assertion-typ", "--no-build"]);
    expect(options).toMatchObject({ agents: ["dpa"], companies: ["dpa-mock", "x"], scenarios: ["D", "SD"], lane: "local", build: false, keep: false });
    expect(options.set.get("dpa")).toEqual({ INTEROP_FAULT: "assertion-typ" });
    expect(parseOptions([]).agents).toBeNull();
    expect(() => parseOptions(["--lane", "moon"])).toThrow("--lane must be local or live");
    expect(() => parseOptions(["--set", "dpa=1"])).toThrow("--set takes name:KEY=VALUE");
  });
});

describe("the registry and known failures", () => {
  it("lists our agent and the reference Company, each with a Dockerfile", () => {
    const registry = loadRegistry();
    const names = registry.implementations.map((entry) => `${entry.role}:${entry.name}`);
    expect(names).toEqual(expect.arrayContaining(["agent:dpa", "company:dpa-mock"]));
    for (const entry of registry.implementations.filter((item) => item.build)) {
      expect(readFileSync(path.join(import.meta.dirname, "../..", entry.build!, "Dockerfile"), "utf8")).toContain("FROM ");
    }
  });

  it("reads known failures, each with an issue and a reason, naming registry entries or *", () => {
    const registry = loadRegistry();
    const names = (role: string) => new Set(registry.implementations.filter((entry) => entry.role === role).map((entry) => entry.name));
    const scenarios = new Set(loadScenarios().map((scenario) => scenario.id));
    for (const failure of loadKnownFailures()) {
      expect(failure.issue).toMatch(/^https:\/\//);
      expect(failure.reason, JSON.stringify(failure)).toBeTruthy();
      expect(failure.agent === "*" || names("agent").has(failure.agent), failure.agent).toBe(true);
      expect(failure.company === "*" || names("company").has(failure.company), failure.company).toBe(true);
      expect(failure.scenario === "*" || scenarios.has(failure.scenario), failure.scenario).toBe(true);
    }
  });

  it("builds one image for entries that differ only in env: the strict mock is the reference mock's image", () => {
    const registry = loadRegistry();
    const entry = (name: string) => registry.implementations.find((item) => item.role === "company" && item.name === name)!;
    expect(imageOf(entry("dpa-mock"), registry)).toBe("poppy-interop/company-dpa-mock:latest");
    expect(imageOf(entry("dpa-mock-strict"), registry)).toBe("poppy-interop/company-dpa-mock:latest");
    expect(entry("dpa-mock-strict").env).toEqual({ INTEROP_MOCK_PROFILE: "strict" });
    expect(imageOf(entry("datalayer-ts"), registry)).toBe("poppy-interop/company-datalayer-ts:latest");
  });
});

describe("the network", () => {
  it("routes every Company and agent name to its container", () => {
    expect(upstreamFor("dpa-mock.company.interop.test")).toBe("company-dpa-mock");
    expect(upstreamFor("auth.dpa-mock.company.interop.test:443")).toBe("company-dpa-mock");
    expect(upstreamFor("www.uk.dpa-mock.company.interop.test")).toBe("company-dpa-mock");
    expect(upstreamFor("dpa.agent.interop.test")).toBe("agent-dpa");
    expect(upstreamFor("runner.interop.test")).toBeNull();
    expect(upstreamFor("example.com")).toBeNull();
  });

  it("aliases every name to the proxy, and covers each Company's subdomains in the certificate", () => {
    const aliases = proxyAliases(["dpa"], [{ name: "acme", subdomains: ["shop"] }]);
    expect(aliases).toEqual(expect.arrayContaining(["runner.interop.test", "dpa.agent.interop.test", "acme.company.interop.test", "auth.acme.company.interop.test", "shop.acme.company.interop.test"]));
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
      { agent: "dpa", company: "dpa-mock", scenario: "SD", outcome: "pass", blame: null, rule: null, steps: [], checks: [], har: "SD/dpa__dpa-mock.har" },
      { agent: "dpa", company: "x", scenario: "SD", outcome: "fail", blame: "agent", rule: "violation", steps: [{ actor: "agent", op: "session", ms: 3, ok: false, error: "<script>" }], checks: [], har: null }
    ];
    const html = renderReport({
      run: "r",
      lane: "local",
      spec: "Draft 0.1",
      implementations: [
        { name: "dpa", role: "agent", commit: "abc", readings: { S1: "token-endpoint" }, relaxations: [] },
        { name: "dpa-mock", role: "company", commit: "abc", readings: {}, relaxations: [] },
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
  });
});
