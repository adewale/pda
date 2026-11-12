#!/usr/bin/env node
/** The reviewed JSON ledger owns the requirement table; Markdown is a checked view. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export const LEDGER_START = "<!-- BEGIN GENERATED REQUIREMENT LEDGER -->";
export const LEDGER_END = "<!-- END GENERATED REQUIREMENT LEDGER -->";
/** `codeAt`: a retired pin's links go to the files at that commit (spec/upstream.json), not to today's tree. */
export function ledgerTable(ledger, codeAt) {
  const link = (file) => codeAt ? `${codeAt}/${file}` : `../${file}`;
  const cell = (text) => String(text).replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
  return [
    "| Upstream change | Disposition | Implementation / evidence | Scope and limits |",
    "| --- | --- | --- | --- |",
    ...ledger.changes.map((row) => `| ${cell(row.change)} | ${cell(row.disposition)} | [code](${link(row.implementation)}), [evidence](${link(row.evidence)}) | ${cell(row.notes)} |`)
  ].join("\n");
}
export function ledgerSection(ledger, codeAt) { return `${LEDGER_START}\n${ledgerTable(ledger, codeAt)}\n${LEDGER_END}`; }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, "..");
  const { pins } = JSON.parse(readFileSync(path.join(root, "spec/upstream.json"), "utf8"));
  for (const pin of pins) {
    const ledger = JSON.parse(readFileSync(path.join(root, `spec/requirements-${pin.protocolVersion}.json`), "utf8"));
    const file = path.join(root, `docs/poppy-${pin.protocolVersion}-upgrade.md`);
    const doc = readFileSync(file, "utf8");
    const start = doc.indexOf(LEDGER_START), end = doc.indexOf(LEDGER_END);
    if (start < 0 || end < start) throw new Error(`Missing ledger markers in ${file}`);
    const current = doc.slice(start, end + LEDGER_END.length);
    const generated = ledgerSection(ledger, pin.codeAt);
    if (process.argv.includes("--write")) writeFileSync(file, doc.replace(current, generated));
    else if (current !== generated) throw new Error(`Stale ${pin.protocolVersion} requirement table; run npm run spec:docs`);
  }
}
