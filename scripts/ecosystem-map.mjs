#!/usr/bin/env node
/** Update only the automated observation block; reviewed interpretation and old grid dates stay intact. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- ecosystem-survey:start -->";
const END = "<!-- ecosystem-survey:end -->";
const text = value => String(value ?? "unknown").replace(/[\r\n`<>|]/g, " ");

export function updateMap(source, report) {
  const date = report.startedAt.slice(0, 10);
  const label = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const count = outcome => report.discovery.filter(row => row.outcome === outcome).length;
  const official = report.repositories.find(row => row.repository === "personal-agent-protocol/personal-agent-protocol");
  const observed = report.repositories.filter(row => row.head).length;
  const changed = report.repositories.filter(row => row.changed).length;
  const block = [START, `### Latest automated observations — ${label}`, "",
    `${observed} of ${report.repositories.length} watched repository heads were read; ${changed} moved since the preceding observation. ${report.incomplete ? "The survey has incomplete observations, listed in its report." : "All configured sources answered."}`,
    "", `- **Specification source:** ${official?.head ? `[${official.head.slice(0, 7)}](${official.url})` : "unavailable; the last checked revision is not a fresh observation"}. PDA's adopted wire profile and validator pin are unchanged.`,
    `- **Package releases:** ${report.packages.map(row => `${text(row.name)} ${text(row.version ?? row.error)}`).join("; ")}.`,
    `- **Public discovery:** ${count("valid")} valid, ${count("invalid")} invalid, ${count("unsupported")} unsupported by PDA and ${count("indeterminate")} indeterminate. A newer unsupported declaration is not a failed check against its own rules.`,
    "", `[Read the current survey](ecosystem-status.md) and [machine-readable receipt](ecosystem-status.json). These observations cover source and public metadata only. They do not refresh Sessions, sign-in, ordering or the historical grid.`, END].join("\n");
  let result = source.replace(/updated \*\*[^*]+\*\*/, `updated **${label}**`).replace(/^## Current ecosystem — .*$/m, `## Current ecosystem — ${label}`);
  if (result.includes(START)) {
    const from = result.indexOf(START), to = result.indexOf(END, from);
    if (to < 0) throw new Error("Incomplete ecosystem survey block");
    result = result.slice(0, from) + block + result.slice(to + END.length);
  } else {
    result = result.replace(/(^## Current ecosystem — .*\n)/m, `$1\n${block}\n\n### Reviewed landscape — 23 October 2026\n`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "..");
  const map = path.join(root, "docs/ecosystem.md");
  writeFileSync(map, updateMap(readFileSync(map, "utf8"), JSON.parse(readFileSync(path.join(root, "docs/ecosystem-status.json"), "utf8"))));
}
