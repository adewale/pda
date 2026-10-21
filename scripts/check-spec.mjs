#!/usr/bin/env node
/** Offline integrity, or a read-only comparison with upstream. Never updates the pin. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { LEDGER_START, LEDGER_END, ledgerSection } from "./spec-ledger.mjs";
import { PROTOCOL_COMMIT, PROTOCOL_REVISION, PROTOCOL_VERSIONS } from "../src/poppy/protocol-version.ts";
const root = path.resolve(import.meta.dirname, "..");
const pin = JSON.parse(readFileSync(path.join(root, "spec/upstream.json"), "utf8"));
const dir = path.join(root, pin.snapshot);
const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const registry = JSON.parse(readFileSync(path.join(root, "interop/registry.json"), "utf8"));
const official = registry.implementations?.find((entry) => entry.name === "official-validator") ?? (Array.isArray(registry) ? registry.find((entry) => entry.name === "official-validator") : null);
if (!official || official.commit !== pin.commit) throw new Error("Official validator registry revision disagrees with the pin");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let failed = false;
if (PROTOCOL_COMMIT !== pin.commit || PROTOCOL_REVISION !== pin.revision || !PROTOCOL_VERSIONS.includes(pin.protocolVersion)) throw new Error("Runtime protocol constants disagree with the active pin");
const ledger = JSON.parse(readFileSync(path.join(root, `spec/requirements-${pin.protocolVersion}.json`), "utf8"));
for (const key of ["protocolVersion", "revision", "commit"]) if (ledger[key] !== pin[key]) throw new Error(`Requirement ledger disagrees with pin: ${key}`);
const titles = [...readFileSync(path.join(dir, "pages/changelog.md"), "utf8").matchAll(/^- \*\*(.*?)\*\*/gm)].map((match) => match[1]);
if (JSON.stringify(titles) !== JSON.stringify(ledger.changes.map((entry) => entry.change))) throw new Error("Every official changelog entry must have a reviewed ledger disposition, in order");
const ledgerDoc = readFileSync(path.join(root, `docs/poppy-${pin.protocolVersion}-upgrade.md`), "utf8");
const ledgerStart = ledgerDoc.indexOf(LEDGER_START), ledgerEnd = ledgerDoc.indexOf(LEDGER_END);
if (ledgerStart < 0 || ledgerEnd < ledgerStart || ledgerDoc.slice(ledgerStart, ledgerEnd + LEDGER_END.length) !== ledgerSection(ledger)) throw new Error("Stale requirement table; run npm run spec:docs");
for (const entry of ledger.changes) {
  if (!entry.disposition || !entry.notes) throw new Error(`Unreviewed change: ${entry.change}`);
  for (const key of ["implementation", "evidence"]) readFileSync(path.join(root, entry[key]));
}

for (const key of ["protocolVersion", "revision", "commit", "operationsVersion"]) {
  if (pin[key] !== manifest[key]) throw new Error(`Spec pin disagrees with snapshot: ${key}`);
}
for (const [file, expected] of Object.entries(manifest.files)) {
  if (hash(readFileSync(path.join(dir, file))) !== expected) throw new Error(`Snapshot changed: ${file}`);
}
console.log(`Verified ${ledger.changes.length} changelog dispositions and ${Object.keys(manifest.files).length} pinned upstream files (${pin.protocolVersion}, ${pin.commit}).`);
if (process.argv.includes("--drift")) {
  const inputs = [
    [`content/versions/${pin.protocolVersion}/spec.mdx`, null],
    ["content/shared/changelog.mdx", null],
    [`content/versions/${pin.protocolVersion}/guides.mdx`, null],
    [`content/versions/${pin.protocolVersion}/extensions.mdx`, null],
    [`content/versions/${pin.protocolVersion}/extensions/operations.mdx`, null],
    ...Object.keys(manifest.files).filter((file) => file.startsWith("kit/")).map((file) => [file, file])
  ];
  for (const [file, local] of inputs) {
    const url = (ref) => `https://raw.githubusercontent.com/personal-agent-protocol/personal-agent-protocol/${ref}/${file}`;
    const get = async (ref) => {
      const response = await fetch(url(ref), { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    };
    const before = local ? readFileSync(path.join(dir, local)) : await get(pin.commit);
    if (hash(before) !== hash(await get("main"))) {
      failed = true;
      console.log(`CHANGED ${file}: review the official changelog before updating the profile.`);
    }
  }
  if (!failed) console.log("No upstream drift in the specification, changelog or pinned Company kit.");
}
process.exitCode = failed ? 1 : 0;
