#!/usr/bin/env node
/**
 * The flawed-Company lane: our 0.2 mock with one of its protections turned
 * off (test/mock-company/types.ts `COMPANY_FLAWS`, mirroring the official
 * validator's own test Company), checked by everything that claims to notice:
 * the pinned official validator, and our adversarial and strict agents. Each
 * flaw gets a fresh run; an honest variant row shows the checkers' verdict on
 * a Company without it.
 *
 *   node interop/vectors/official/flaws.mjs [--flaws a,b] [--json out.json] [runner options]
 *
 * "caught" means a checker that targets the protection reported it: an
 * expected official check failed or warned, or our cell failed or recorded a
 * Company-side check. Information only: the exit status is 0 unless the
 * harness failed (a run, a report or a container).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "../../runner/cli.ts";
import { officialCheck, totals } from "./check.mjs";

const COMPANY = "lenient-company-v02";

/**
 * Each flaw, the official checks that target it, and our cells that do
 * (agent and scenario). `[]` is a claim too: nobody here targets it.
 */
export const FLAWS = [
  { flaw: "accept-replayed-assertion", official: ["session.assertion-replay"], ours: [["evil-personal-agent", "YR"]] },
  { flaw: "accept-replayed-proof", official: ["dpop.token-replay"], ours: [["evil-personal-agent", "YD"]] },
  { flaw: "accept-wrong-htu", official: ["dpop.token-htu", "dpop.resource-htu"], ours: [] },
  { flaw: "accept-other-key", official: ["dpop.wrong-key"], ours: [["evil-personal-agent", "YT"]] },
  { flaw: "accept-bearer-scheme", official: ["dpop.bearer-scheme"], ours: [["evil-personal-agent", "YS"]] },
  { flaw: "accept-query-token", official: ["dpop.token-in-url"], ours: [] },
  { flaw: "accept-token-endpoint-aud", official: ["session.client-assertion-aud"], ours: [["evil-personal-agent", "YA"]] },
  { flaw: "token-cacheable", official: ["session.no-store"], ours: [["strict-personal-agent", "S0"]] },
  { flaw: "retry-new-conversation", official: ["conversations.retry-same-id", "conversations.retry-not-duplicated"], ours: [["strict-personal-agent", "CIDUP"]] },
  { flaw: "accept-rotated-account-token", official: [], ours: [["evil-personal-agent", "YK"]] }
];

/** Honest settings that reach the validator's conditional checks; nothing should be caught. */
export const VARIANTS = [
  { variant: "", note: "the honest 0.2 mock" },
  { variant: "requireNonce", note: "requires DPoP nonces (dpop.nonce)" },
  { variant: "bearerMcp", note: "MCP with Bearer tokens at 0.2 (mcp.bearer-*)" }
];

const root = path.resolve(import.meta.dirname, "../../..");
process.chdir(root);
const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(name);
  if (at === -1) return null;
  const [value] = argv.splice(at, 2).slice(1);
  return value;
};
const only = option("--flaws")?.split(",").filter(Boolean) ?? null;
const jsonOut = option("--json");
const out = option("--out") ?? path.join(root, "interop", "results", `flaws-${new Date().toISOString().replace(/[:.]/g, "-")}`);
for (const name of only ?? []) if (!FLAWS.some((row) => row.flaw === name)) throw new Error(`No flaw ${name}`);

const ALL_OURS = [...new Set(FLAWS.flatMap((row) => row.ours.map(([agent]) => agent)))];
const ALL_SCENARIOS = [...new Set(FLAWS.flatMap((row) => row.ours.map(([, scenario]) => scenario)))];

/** One harness run against the mock with `env`; returns the official report and our cells. */
async function runOnce(label, env, agents, scenarios, build) {
  let official = null;
  const runDir = path.join(out, label);
  const set = Object.entries(env).flatMap(([key, value]) => ["--set", `${COMPANY}:${key}=${value}`]);
  await main(["--agents", ["official-validator", ...agents].join(","), "--companies", COMPANY, "--scenarios", (scenarios.length ? scenarios : ["D"]).join(","), "--out", runDir, ...(build ? [] : ["--no-build"]), ...set, ...argv], async (context) => {
    official = (await officialCheck(context, COMPANY, "official-validator.json")).report;
  });
  if (!official) throw new Error(`${label}: the official validator did not run`);
  const results = JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8"));
  return { official, cells: results.cells.filter((cell) => cell.agent !== "official-validator") };
}

const statusOf = (report, id) => report.results.find((x) => x.id === id)?.status ?? "absent";
const caughtByOfficial = (status) => status === "fail" || status === "warn";
const companySide = (cell) => cell.checks.filter((check) => check.side === "company").map((check) => `${check.severity}:${check.id}`);
const caughtByUs = (cell) => cell?.outcome === "fail" || companySide(cell ?? { checks: [] }).length > 0;
const notPassing = (report) => report.results.filter((x) => x.status === "fail" || x.status === "warn").map((x) => `${x.status}:${x.id}`);

const rows = [];
let build = true;
for (const { variant, note } of VARIANTS) {
  if (only) break;
  const { official, cells } = await runOnce(`honest${variant ? `-${variant}` : ""}`, variant ? { INTEROP_MOCK_VARIANT: variant } : {}, ALL_OURS, ALL_SCENARIOS, build);
  build = false;
  rows.push({ kind: "honest", name: variant || "honest", note, total: totals(official), official: notPassing(official), ours: cells.map((cell) => ({ agent: cell.agent, scenario: cell.scenario, outcome: cell.outcome, company: companySide(cell) })) });
}
for (const row of FLAWS.filter((item) => !only || only.includes(item.flaw))) {
  const agents = [...new Set(row.ours.map(([agent]) => agent))];
  const scenarios = row.ours.map(([, scenario]) => scenario);
  const { official, cells } = await runOnce(row.flaw, { INTEROP_MOCK_FLAWS: row.flaw }, agents, scenarios, build);
  build = false;
  const expected = row.official.map((id) => ({ id, status: statusOf(official, id) }));
  const ours = row.ours.map(([agent, scenario]) => {
    const cell = cells.find((item) => item.agent === agent && item.scenario === scenario);
    return { agent, scenario, outcome: cell?.outcome ?? "absent", company: cell ? companySide(cell) : [], caught: caughtByUs(cell) };
  });
  rows.push({
    kind: "flaw",
    name: row.flaw,
    official: { caught: expected.some((x) => caughtByOfficial(x.status)), expected, other: notPassing(official).filter((entry) => !row.official.includes(entry.split(":")[1])) },
    ours: { caught: ours.some((x) => x.caught), cells: ours }
  });
}

const mark = (targeted, caught) => (!targeted ? "—" : caught ? "caught" : "MISSED");
console.log("\nFlaw                          Official   Ours");
for (const row of rows.filter((item) => item.kind === "flaw")) {
  const spec = FLAWS.find((item) => item.flaw === row.name);
  console.log(`${row.name.padEnd(30)}${mark(spec.official.length > 0, row.official.caught).padEnd(11)}${mark(spec.ours.length > 0, row.ours.caught)}`);
}
for (const row of rows.filter((item) => item.kind === "honest")) console.log(`honest ${row.name}: official ${JSON.stringify(row.total)}${row.official.length ? ` ${row.official.join(" ")}` : ""}`);
const report = { company: COMPANY, pin: JSON.parse(readFileSync(path.join(root, "spec/upstream.json"), "utf8")), rows };
writeFileSync(path.join(out, "flaws.json"), `${JSON.stringify(report, null, 2)}\n`);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nReport: ${path.join(out, "flaws.json")}`);
