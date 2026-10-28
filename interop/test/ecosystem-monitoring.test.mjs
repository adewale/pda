import { describe, expect, it } from "vitest";
import { sourceReader, comparison, survey, changedDocuments } from "../../scripts/ecosystem-survey.mjs";
import { updateMap } from "../../scripts/ecosystem-map.mjs";
import { gridPlan } from "../../scripts/ecosystem-grid.mjs";
import { gridReceipt } from "../../scripts/ecosystem-grid-receipt.mjs";
import { surveyPrBody } from "../../scripts/ecosystem-pr-body.mjs";

const SHA = "a".repeat(40), OLD = "b".repeat(40);
const DATE = "2026-10-28T10:00:00Z";
const config = { repositories: [], packages: [], publicSources: [], companies: [] };
const registry = { implementations: [] };
const get = async url => ({ value: url.includes("search/repositories") ? { items: [], total_count: 0 } : [], sha256: SHA });

describe("dated ecosystem observations", () => {
  it("does not send GitHub credentials to an external redirect", async () => {
    const calls = [];
    const read = sourceReader(async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://docs.example/report" } }) : Response.json({ ok: true });
    }, "private-test-credential");
    await read("https://api.github.com/repos/example/project");
    expect(calls[0].init.headers.authorization).toBe("Bearer private-test-credential");
    expect(calls[1].init.headers.authorization).toBeUndefined();
    expect(calls.every(call => call.init.redirect === "manual")).toBe(true);
  });

  it("refuses a redirect into a private host before fetching it", async () => {
    let calls = 0;
    const read = sourceReader(async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/" } }); });
    await expect(read("https://public.example/data")).rejects.toThrow("public HTTPS");
    expect(calls).toBe(1);
  });

  it("keeps the last successful source observation dated when a fresh request fails", async () => {
    const report = await survey({ ...config, repositories: ["example/project"] }, { repositories: [{ repository: "example/project", head: OLD, observedAt: "2026-10-23" }] }, registry,
      { get: async url => { if (url.includes("/commits")) throw new Error("HTTP 403"); return get(url); }, now: () => DATE });
    expect(report.repositories[0]).toMatchObject({ observedAt: null, attemptedAt: DATE, lastKnown: { head: OLD, observedAt: "2026-10-23" }, error: "HTTP 403" });
    expect(report.repositories[0].head).toBeUndefined();
    expect(report.incomplete).toBe(true);
  });

  it("records a new protocol declaration as unsupported rather than validating it under 0.2", async () => {
    const requests = [];
    const report = await survey({ ...config, companies: ["shop.example"] }, {}, registry, { get, now: () => DATE,
      discoveryFetcher: async request => { requests.push(request.url); return Response.json({ protocol_version: "0.3", organization: { name: "Shop", domain: "shop.example" }, auth: { issuer: "https://auth.shop.example" } }); } });
    expect(report.discovery[0]).toMatchObject({ protocol_version: "0.3", outcome: "unsupported", refused_by_pda: true });
    expect(requests).toEqual(["https://shop.example/.well-known/poppy.json"]);
  });

  it("does not treat a truncated comparison as proof of unchanged Poppy code", () => {
    const value = comparison({ total_commits: 200, files: Array.from({ length: 300 }, (_, i) => ({ filename: `unrelated/${i}.txt` })) });
    expect(value).toMatchObject({ complete: false, poppyPaths: [] });
  });

  it("does not confuse a legacy commit date with the date its head was observed", async () => {
    const old = { date: "2026-10-23", repositories: [{ repository: "example/project", head: OLD, committed_at: "2026-10-01" }] };
    const result = await survey({ ...config, repositories: ["example/project"] }, old, registry, { now: () => DATE, get: async url => { if (url.includes("/commits")) throw new Error("HTTP 403"); return get(url); } });
    expect(result.repositories[0].lastKnown.observedAt).toBe("2026-10-23");
  });

  it("compares document hashes and diagnostics without counting observation time as drift", () => {
    const row = { outcome: "valid", protocol_version: "0.2", documents: [{ kind: "poppy", finalUrl: "https://shop.example/poppy.json", parsed_json_sha256: SHA }], messages: [] };
    expect(changedDocuments({ ...row, checked_at: DATE }, { ...row, checked_at: "2026-10-23" })).toBe(false);
    expect(changedDocuments({ ...row, outcome: "indeterminate" }, row)).toBeNull();
    expect(changedDocuments({ ...row, documents: [{ ...row.documents[0], parsed_json_sha256: OLD }] }, row)).toBe(true);
  });

  it("updates the automated block idempotently without refreshing the old grid", () => {
    const source = "# The Poppy ecosystem\n\nA map, updated **23 October 2026**.\n\n## Current ecosystem — 23 October 2026\n\nReviewed evidence.\n\n## Dated implementation catalogue\n\nGrid run 17 October at 13 October pins.\n";
    const report = { startedAt: DATE, incomplete: true, repositories: [{ repository: "example/project", head: null }], packages: [], discovery: [] };
    const updated = updateMap(source, report);
    expect(updated).toContain("Grid run 17 October at 13 October pins.");
    expect(updated).toContain("0 of 1 watched repository heads were read");
    expect(updated).toContain("incomplete observations");
    expect(updateMap(updated, report)).toBe(updated);
  });
});

describe("bounded cross-project automation", () => {
  const company = { name: "peer", role: "company", source: "https://github.com/example/peer", commit: SHA, build: "interop/impls/peer" };
  it("selects reviewed local honest peers and excludes adversaries, fakes, live targets and vector runners", () => {
    const implementations = [company, { ...company, name: "self", owner: "self" }, { ...company, name: "evil", adversarial: true }, { ...company, name: "fake", fake: true },
      { ...company, name: "live", url: "https://live.example" }, { ...company, name: "vector", vectorsOnly: true }];
    expect(gridPlan({ implementations }).include).toEqual([expect.objectContaining({ agents: "pda", companies: "peer", commit: SHA })]);
    expect(() => gridPlan({ implementations }, { peers: "evil" })).toThrow("honest peer");
  });

  it("tests changed pin entries and shared adapter changes, but not unrelated docs", () => {
    const prior = { implementations: [company] };
    expect(gridPlan(prior, { previous: prior, files: ["docs/ecosystem.md"] }).include).toEqual([]);
    expect(gridPlan({ implementations: [{ ...company, commit: OLD }] }, { previous: prior }).include).toHaveLength(1);
    expect(gridPlan(prior, { previous: prior, files: ["interop/impls/peer/adapter.mjs"] }).include).toHaveLength(1);
  });

  it("pairs 0.2 agents with the 0.2 mock", () => {
    expect(gridPlan({ implementations: [{ ...company, role: "agent", env: { INTEROP_POPPY_VERSION: "0.2" } }] }).include[0].companies).toBe("lenient-company-v02");
  });

  it("publishes aggregate counts without traces, raw checks or known-failure detail", () => {
    const result = { lane: "local", isolation: { internal: true }, run: "test", implementations: [{ name: "peer", role: "company", commit: SHA }], staleKnown: [],
      cells: [{ scenario: "D", outcome: "pass", steps: [{ secret: "private-trace" }] }, { scenario: "S0", outcome: "fail", known: { reason: "private-detail" } }] };
    const receipt = gridReceipt(result, DATE);
    expect(receipt.counts).toEqual({ pass: 1, fail: 1, unsupported: 0 });
    expect(JSON.stringify(receipt)).not.toMatch(/private-trace|private-detail/);
    expect(() => gridReceipt({ ...result, cells: [{ scenario: "S0", outcome: "fail" }] })).toThrow("local review");
    expect(() => gridReceipt({ ...result, lane: "live" })).toThrow("local review");
    expect(() => gridReceipt({ ...result, cells: [{ scenario: "YR", outcome: "pass" }] })).toThrow("local review");
  });

  it("allows only a previously published finding at its reviewed pin and keeps it a failure", () => {
    const finding = { agent: "sdk", company: "mock", scenario: "H", agentCommit: SHA, error: "poppy_error invalid_response" };
    const result = { lane: "local", isolation: { internal: true }, run: "test", implementations: [{ name: "sdk", role: "agent", commit: SHA }], staleKnown: [],
      cells: [{ agent: "sdk", company: "mock", scenario: "H", outcome: "fail", steps: [{ ok: false, error: "poppy_error invalid_response: control shape" }] }] };
    expect(gridReceipt(result, DATE, [finding])).toMatchObject({ counts: { fail: 1 }, knownFailures: 0, publishedFailures: 1 });
    expect(() => gridReceipt({ ...result, implementations: [{ ...result.implementations[0], commit: OLD }] }, DATE, [finding])).toThrow("local review");
  });

  it("writes partial-survey PR prose with immutable images without copying untrusted candidate text", () => {
    const body = surveyPrBody({ startedAt: DATE, incomplete: true, repositories: [{ head: SHA }], discovery: [{ outcome: "unsupported" }], candidates: [{ description: "@someone private-untrusted-text" }] },
      { repository: "example/project", commit: SHA, evidence: "docs/evidence/ecosystem-2026-10-28" });
    expect(body).toContain("1 unsupported by PDA");
    expect(body).toContain("incomplete");
    expect(body).toContain(`/example/project/${SHA}/docs/evidence/`);
    expect(body).not.toContain("private-untrusted-text");
  });
});
