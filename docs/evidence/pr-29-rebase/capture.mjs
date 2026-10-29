/** One-off PR evidence: use immutable runCell sources and the unchanged production report renderer. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "@cloudflare/puppeteer";

const [base, head] = process.argv.slice(2);
assert.ok([base, head].every(sha => /^[a-f0-9]{40}$/.test(sha)), "Supply full base/head SHAs");
const root = path.resolve(import.meta.dirname, "../../..");
const output = import.meta.dirname;
const directory = mkdtempSync(path.join(tmpdir(), "pr29-classification-"));
const git = (sha, file) => execFileSync("git", ["show", `${sha}:${file}`], { cwd: root });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const rendererSources = [
  "interop/runner/report.ts", "interop/runner/attribution.ts", "interop/runner/readings.ts", "interop/runner/har.ts",
  "src/validator/levels.ts", "src/poppy/protocol-version.ts"
];
for (const file of rendererSources) assert.deepEqual(git(base, file), git(head, file), `Renderer dependency must be identical: ${file}`);
const receipt = {
  base, head, fixture: "Company offers neither conversations nor MCP", networkRequests: 0,
  rendererSha256: Object.fromEntries(rendererSources.map(file => [file, hash(git(head, file))])), stages: []
};
let child, browser;
try {
  child = spawn(process.env.PDA_ACCEPTANCE_CHROMIUM || "/usr/bin/chromium", ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(directory, "chrome")}`], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Chromium startup timed out")), 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stderr.on("data", chunk => {
      stderr = (stderr + String(chunk)).slice(-8192);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/devtools\/browser\/[a-z0-9-]+)/.exec(stderr);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on("request", request => { void request.abort(); });
  for (const [stage, sha] of [["before", base], ["after", head]]) {
    const source = path.join(directory, stage);
    for (const file of ["interop/runner/cell.ts", "interop/runner/scenario.ts", ...rendererSources]) {
      const target = path.join(source, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, git(sha, file));
    }
    const { runCell } = await import(pathToFileURL(path.join(source, "interop/runner/cell.ts")));
    const { renderReport } = await import(pathToFileURL(path.join(source, "interop/runner/report.ts")));
    const scenarios = ["CL", "ML"].map(id => JSON.parse(git(sha, `interop/scenarios/${id}.json`)));
    const cells = [];
    for (const scenario of scenarios) for (const live of [true, false]) {
      const calls = [];
      const driver = {
        agent: async op => {
          calls.push(op);
          assert.equal(op, "discover", "An absent feature must stop before sending or listing");
          return { kind: "ok", result: { poppy_version: "0.3", conversations: false, apis: [] } };
        },
        company: async () => { throw new Error("No Company calls in this fixture"); },
        runner: async () => { throw new Error("No runner calls in this fixture"); }
      };
      const run = await runCell(scenario, {}, driver, { live });
      assert.deepEqual(calls, ["discover"]);
      assert.equal(run.outcome, stage === "after" && live ? "unsupported" : "fail");
      cells.push({ agent: "pda", company: live ? "fixture-live" : "fixture-claimed", scenario: scenario.id, protocolVersion: "0.3", outcome: run.outcome, reason: run.reason, blame: null, rule: null, steps: run.steps, checks: [], har: null });
    }
    const html = renderReport({
      run: "PR29 synthetic capability fixture", lane: "synthetic; no external traffic", spec: "Poppy 0.3",
      implementations: [
        { name: "pda", role: "agent", commit: sha, readings: {}, relaxations: ["Synthetic discover response; actual runCell/report code"] },
        ...["fixture-live", "fixture-claimed"].map(name => ({ name, role: "company", commit: "fixture", readings: {}, relaxations: ["No conversations or MCP"] }))
      ], scenarios, cells
    });
    const htmlFile = path.join(output, `${stage}.html`);
    const pngFile = path.join(output, `${stage}.png`);
    writeFileSync(htmlFile, html);
    await page.setContent(html, { waitUntil: "load", timeout: 10_000 });
    await page.waitForSelector(".grid");
    assert.equal(await page.$$eval(".grid td.fail", cells => cells.length), stage === "before" ? 4 : 2);
    assert.equal(await page.$$eval(".grid td.unsupported", cells => cells.length), stage === "before" ? 0 : 2);
    await page.evaluate(() => { window.scrollTo(0, 0); });
    writeFileSync(pngFile, await page.screenshot({ type: "png" }));
    receipt.stages.push({ stage, source: sha, cells: cells.map(({ company, scenario, outcome }) => ({ company, scenario, outcome })), htmlSha256: hash(Buffer.from(html)) });
  }
  writeFileSync(path.join(output, "visual-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  child?.kill("SIGTERM");
  rmSync(directory, { recursive: true, force: true });
}
