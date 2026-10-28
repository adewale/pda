#!/usr/bin/env node
/**
 * Offline integrity of the spec pin, or a read-only comparison with the live
 * site (`--drift`). Never updates the pin.
 *
 * The pin is a dated snapshot of personalagentprotocol.org
 * (`spec/upstream.json`), since upstream hasn't committed the 0.3 text it
 * publishes: `commit` is null, and the snapshot's own hashes are what we pin.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { LEDGER_START, LEDGER_END, ledgerSection } from "./spec-ledger.mjs";
import { PROTOCOL_COMMIT, PROTOCOL_REVISION, PROTOCOL_VERSIONS } from "../src/poppy/protocol-version.ts";

const root = path.resolve(import.meta.dirname, "..");
const pin = JSON.parse(readFileSync(path.join(root, "spec/upstream.json"), "utf8"));
const dir = path.join(root, pin.snapshot);
const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (PROTOCOL_COMMIT !== pin.commit || PROTOCOL_REVISION !== pin.revision || !PROTOCOL_VERSIONS.includes(pin.protocolVersion)) {
  throw new Error("Runtime protocol constants disagree with the active pin");
}
if (manifest.protocol_version !== pin.protocolVersion) throw new Error("Spec pin disagrees with snapshot: protocolVersion");
if (!manifest.sitemap.retrieved_at.startsWith(pin.revision)) throw new Error("Spec pin disagrees with snapshot: revision");

// Every stored page is the one the manifest hashed.
for (const page of manifest.pages) {
  for (const stored of [page.markdown, page.content_html]) {
    if (hash(readFileSync(path.join(dir, stored.file))) !== stored.sha256) throw new Error(`Snapshot changed: ${stored.file}`);
  }
}

// One reviewed disposition for each changelog entry of the pinned version, in order.
const ledger = JSON.parse(readFileSync(path.join(root, `spec/requirements-${pin.protocolVersion}.json`), "utf8"));
for (const key of ["protocolVersion", "revision", "commit"]) if (ledger[key] !== pin[key]) throw new Error(`Requirement ledger disagrees with pin: ${key}`);
const changelog = readFileSync(path.join(dir, "pages/changelog.md"), "utf8");
const section = changelog.split(/^## /m).find((part) => part.startsWith(`Draft ${pin.protocolVersion}\n`));
if (!section) throw new Error(`The changelog has no Draft ${pin.protocolVersion} section`);
const titles = [...section.matchAll(/^#### (.+)$/gm)].map((match) => match[1].trim());
if (JSON.stringify(titles) !== JSON.stringify(ledger.changes.map((entry) => entry.change))) {
  throw new Error("Every official changelog entry must have a reviewed ledger disposition, in order");
}
const ledgerDoc = readFileSync(path.join(root, `docs/poppy-${pin.protocolVersion}-upgrade.md`), "utf8");
const ledgerStart = ledgerDoc.indexOf(LEDGER_START), ledgerEnd = ledgerDoc.indexOf(LEDGER_END);
if (ledgerStart < 0 || ledgerEnd < ledgerStart || ledgerDoc.slice(ledgerStart, ledgerEnd + LEDGER_END.length) !== ledgerSection(ledger)) {
  throw new Error("Stale requirement table; run npm run spec:docs");
}
for (const entry of ledger.changes) {
  if (!entry.disposition || !entry.notes) throw new Error(`Unreviewed change: ${entry.change}`);
  for (const key of ["implementation", "evidence"]) readFileSync(path.join(root, entry[key]));
}
console.log(`Verified ${ledger.changes.length} changelog dispositions and ${manifest.pages.length} pinned pages (${pin.protocolVersion}, retrieved ${pin.revision}).`);

let failed = false;
if (process.argv.includes("--drift")) {
  // The site serves each page's Markdown source; the snapshot hashed it when it was stored.
  for (const page of manifest.pages) {
    const source = page.markdown.fetched?.url;
    if (!source) continue;
    const response = await fetch(source, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    if (response.status === 404) {
      failed = true;
      console.log(`REMOVED ${page.name} (${source}): review the changelog before updating the pin.`);
      continue;
    }
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    if (hash(Buffer.from(await response.arrayBuffer())) !== page.markdown.sha256) {
      failed = true;
      console.log(`CHANGED ${page.name} (${source}): review the changelog before updating the pin.`);
    }
  }
  if (!failed) console.log("No drift: every pinned page's text is the same on the site.");
}
process.exitCode = failed ? 1 : 0;
