/**
 * `index.html` (spec section 9): one table per scenario, agents as rows and
 * Companies as columns, each cell linking to its steps, checks and HAR.
 * Plain HTML and a little CSS; no script, no framework.
 */
import type { Cell, Manifest, Scenario } from "./types.ts";

export type RunSummary = {
  readonly run: string;
  readonly lane: string;
  readonly spec: string;
  readonly implementations: readonly { name: string; role: string; commit: string; readings: Record<string, string>; relaxations: readonly string[] }[];
  readonly scenarios: readonly Scenario[];
  readonly cells: readonly Cell[];
};

const escape = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export const cellId = (cell: Pick<Cell, "scenario" | "agent" | "company">) => `${cell.scenario}--${cell.agent}--${cell.company}`;

function label(cell: Cell): string {
  if (cell.outcome === "pass") return "pass";
  if (cell.outcome === "unsupported") return "n/a";
  const blame = cell.blame ? ` · ${cell.blame}` : "";
  const rule = cell.rule ? ` (${cell.rule})` : "";
  return `${cell.outcome}${blame}${rule}${cell.known ? " · known" : ""}`;
}

function grid(scenario: Scenario, cells: readonly Cell[], agents: readonly string[], companies: readonly string[]): string {
  const rows = agents
    .map((agent) => {
      const tds = companies
        .map((company) => {
          const cell = cells.find((c) => c.scenario === scenario.id && c.agent === agent && c.company === company);
          if (!cell) return "<td class=none>—</td>";
          return `<td class="${cell.outcome}${cell.known ? " known" : ""}"><a href="#${escape(cellId(cell))}">${escape(label(cell))}</a></td>`;
        })
        .join("");
      return `<tr><th scope=row>${escape(agent)}</th>${tds}</tr>`;
    })
    .join("\n");
  return `<section>
<h2 id="${escape(scenario.id)}">${escape(scenario.id)}: ${escape(scenario.title)}</h2>
${scenario.requirements?.length ? `<p class=meta>Spec ${escape(scenario.requirements.join(", "))}${scenario.readings?.length ? ` · readings ${escape(scenario.readings.join(", "))}` : ""}</p>` : ""}
<table class=grid><thead><tr><th>agent \\ Company</th>${companies.map((company) => `<th scope=col>${escape(company)}</th>`).join("")}</tr></thead>
<tbody>${rows}</tbody></table>
</section>`;
}

function details(cell: Cell): string {
  const steps = cell.steps
    .map(
      (step, index) =>
        `<tr class="${step.ok ? "ok" : "bad"}"><td>${index}</td><td>${escape(step.actor)}</td><td>${escape(step.op)}</td><td>${step.ms}</td><td>${step.ok ? "ok" : escape(step.error ?? "failed")}</td></tr>`
    )
    .join("\n");
  const checks = cell.checks.length
    ? `<table><thead><tr><th>check</th><th>side</th><th>severity</th><th>source</th><th>exchange</th><th>detail</th></tr></thead><tbody>${cell.checks
        .map(
          (check) =>
            `<tr class="${check.severity}"><td>${escape(check.id)}</td><td>${escape(check.side)}</td><td>${escape(check.severity)}</td><td>${escape(check.source)}</td><td>${check.exchange ?? ""}</td><td>${escape(check.detail)}</td></tr>`
        )
        .join("\n")}</tbody></table>`
    : "<p>No checks reported anything.</p>";
  return `<details id="${escape(cellId(cell))}"${cell.outcome === "fail" || cell.outcome === "error" ? " open" : ""}>
<summary><b>${escape(cell.scenario)}</b> ${escape(cell.agent)} × ${escape(cell.company)}: <span class="${cell.outcome}">${escape(label(cell))}</span></summary>
${cell.reason ? `<p>${escape(cell.reason)}</p>` : ""}
${cell.known ? `<p>Known failure: <a href="${escape(cell.known.issue)}">${escape(cell.known.issue)}</a>${cell.known.reason ? ` — ${escape(cell.known.reason)}` : ""}</p>` : ""}
${cell.har ? `<p><a href="${escape(cell.har)}">HAR</a></p>` : ""}
<table><thead><tr><th>#</th><th>actor</th><th>op</th><th>ms</th><th>result</th></tr></thead><tbody>${steps}</tbody></table>
${checks}
</details>`;
}

export function renderReport(summary: RunSummary): string {
  const agents = summary.implementations.filter((impl) => impl.role === "agent").map((impl) => impl.name);
  const companies = summary.implementations.filter((impl) => impl.role === "company").map((impl) => impl.name);
  const counts = new Map<string, number>();
  for (const cell of summary.cells) counts.set(cell.outcome, (counts.get(cell.outcome) ?? 0) + 1);
  const impls = summary.implementations
    .map(
      (impl) =>
        `<tr><td>${escape(impl.name)}</td><td>${escape(impl.role)}</td><td><code>${escape(impl.commit)}</code></td><td>${escape(
          Object.entries(impl.readings)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")
        )}</td><td>${escape(impl.relaxations.join("; ") || "none")}</td></tr>`
    )
    .join("\n");
  return `<!doctype html>
<html lang=en>
<meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<title>Poppy interop ${escape(summary.run)}</title>
<style>
:root { color-scheme: light dark; --pass: #1a7f37; --fail: #cf222e; --na: #6e7781; --error: #9a6700; }
body { font: 15px/1.45 system-ui, sans-serif; max-width: 72rem; margin: 0 auto; padding: 1rem; }
table { border-collapse: collapse; margin: 0.5rem 0 1rem; }
th, td { border: 1px solid #8884; padding: 0.25rem 0.5rem; text-align: left; vertical-align: top; }
.grid td { min-width: 9rem; }
td.pass a, span.pass { color: var(--pass); }
td.fail a, span.fail, tr.bad td, tr.error td:first-child { color: var(--fail); }
td.unsupported a, span.unsupported, td.none { color: var(--na); }
td.error a, span.error { color: var(--error); }
td.known { text-decoration: underline dotted; }
.meta { color: var(--na); margin-top: -0.5rem; }
details { border-top: 1px solid #8884; padding: 0.5rem 0; }
code { font-size: 0.9em; }
</style>
<h1>Poppy interop run ${escape(summary.run)}</h1>
<p>Lane ${escape(summary.lane)} · ${escape(summary.spec)} · ${[...counts].map(([outcome, n]) => `${n} ${escape(outcome)}`).join(", ")}.
Each failed cell is blamed by the first rule that decides it: violation, grid, reading, or unattributed (docs/interop-spec.md, section 9).</p>
<h2>Implementations</h2>
<table><thead><tr><th>name</th><th>role</th><th>commit</th><th>readings</th><th>interop-only relaxations</th></tr></thead><tbody>${impls}</tbody></table>
${summary.scenarios.map((scenario) => grid(scenario, summary.cells, agents, companies)).join("\n")}
<h2>Cells</h2>
${summary.cells.map(details).join("\n")}
</html>
`;
}

export type { Manifest };
