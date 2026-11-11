#!/usr/bin/env node
/**
 * Offline integrity of the spec pins, or a read-only comparison with the live
 * site (`--drift`). Never updates a pin.
 *
 * Each pin is a dated snapshot of personalagentprotocol.org for one protocol
 * version (`spec/upstream.json`), with the official kit retrieved alongside
 * it; commit is null until all pinned text is committed. A published version
 * is frozen; a draft gets newer snapshots. The snapshot's own hashes supply
 * the offline integrity check. Only `runtime` pins are spoken by the agent,
 * and they must agree with src/poppy/protocol-version.ts.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { LEDGER_START, LEDGER_END, ledgerSection } from "./spec-ledger.mjs";
import { DRAFT_REVISIONS, PROTOCOL_COMMIT, PROTOCOL_REVISIONS, PROTOCOL_VERSIONS } from "../src/poppy/protocol-version.ts";

const root = path.resolve(import.meta.dirname, "..");
const { pins } = JSON.parse(readFileSync(path.join(root, "spec/upstream.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A version's section of the changelog: "Draft 0.4" while in progress, "Version 0.3" once published. */
function changelogSection(changelog, version) {
  return changelog.split(/^## /m).find((part) => part.startsWith(`Draft ${version}\n`) || part.startsWith(`Version ${version}\n`));
}
const entryTitles = (section) => [...section.matchAll(/^#### (.+)$/gm)].map((match) => match[1].trim());

if (!Array.isArray(pins) || pins.length === 0) throw new Error("spec/upstream.json lists no pins");
if (new Set(pins.map((pin) => pin.protocolVersion)).size !== pins.length) throw new Error("Two pins for one protocol version");

// The versions the agent speaks are exactly the runtime pins, at their pinned revisions.
const runtime = pins.filter((pin) => pin.runtime);
if (JSON.stringify(runtime.map((pin) => pin.protocolVersion).sort()) !== JSON.stringify([...PROTOCOL_VERSIONS].sort())) {
  throw new Error("Runtime protocol versions disagree with the runtime pins");
}
for (const pin of runtime) {
  if (PROTOCOL_REVISIONS[pin.protocolVersion] !== pin.revision) throw new Error(`Runtime protocol revision disagrees with the ${pin.protocolVersion} pin`);
}
if (PROTOCOL_COMMIT !== runtime.at(-1).commit) throw new Error("Runtime protocol commit disagrees with the newest runtime pin");
// Pinned drafts the validator checks but the agent doesn't speak yet carry their pinned revision too.
const drafts = pins.filter((pin) => !pin.runtime);
if (JSON.stringify(drafts.map((pin) => pin.protocolVersion).sort()) !== JSON.stringify(Object.keys(DRAFT_REVISIONS).sort())) {
  throw new Error("Draft protocol revisions disagree with the non-runtime pins");
}
for (const pin of drafts) {
  if (DRAFT_REVISIONS[pin.protocolVersion] !== pin.revision) throw new Error(`Draft protocol revision disagrees with the ${pin.protocolVersion} pin`);
}

const checked = [];
for (const pin of pins) {
  if (!["published", "draft"].includes(pin.status)) throw new Error(`Pin ${pin.protocolVersion}: unknown status ${pin.status}`);
  const dir = path.join(root, pin.snapshot);
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  if (manifest.protocol_version !== pin.protocolVersion) throw new Error(`Spec pin disagrees with snapshot: protocolVersion ${pin.protocolVersion}`);
  if (!manifest.sitemap.retrieved_at.startsWith(pin.revision)) throw new Error(`Spec pin disagrees with snapshot: revision ${pin.protocolVersion}`);

  // Every stored page is the one the manifest hashed.
  for (const page of manifest.pages) {
    for (const stored of [page.markdown, page.content_html]) {
      if (hash(readFileSync(path.join(dir, stored.file))) !== stored.sha256) throw new Error(`Snapshot changed: ${pin.snapshot}/${stored.file}`);
    }
  }

  // The kit retrieved with the snapshot is for the same version (its file hashes: check-company-kit.mjs --verify-pin).
  const kit = JSON.parse(readFileSync(path.join(root, pin.kit, "manifest.json"), "utf8"));
  if (kit.protocolVersion !== pin.protocolVersion) throw new Error(`Kit pin disagrees with spec pin: ${pin.kit}`);
  if (hash(readFileSync(path.join(root, pin.kit, "upstream.zip"))) !== kit.archiveSha256) throw new Error(`Kit archive changed: ${pin.kit}`);

  // One reviewed disposition for each changelog entry of the pinned version, in order.
  const ledger = JSON.parse(readFileSync(path.join(root, `spec/requirements-${pin.protocolVersion}.json`), "utf8"));
  for (const key of ["protocolVersion", "revision", "commit"]) if (ledger[key] !== pin[key]) throw new Error(`Requirement ledger disagrees with pin: ${pin.protocolVersion} ${key}`);
  const section = changelogSection(readFileSync(path.join(dir, "pages/changelog.md"), "utf8"), pin.protocolVersion);
  if (!section) throw new Error(`The changelog has no section for ${pin.protocolVersion}`);
  if (JSON.stringify(entryTitles(section)) !== JSON.stringify(ledger.changes.map((entry) => entry.change))) {
    throw new Error(`Every official ${pin.protocolVersion} changelog entry must have a reviewed ledger disposition, in order`);
  }
  const ledgerDoc = readFileSync(path.join(root, `docs/poppy-${pin.protocolVersion}-upgrade.md`), "utf8");
  const ledgerStart = ledgerDoc.indexOf(LEDGER_START), ledgerEnd = ledgerDoc.indexOf(LEDGER_END);
  if (ledgerStart < 0 || ledgerEnd < ledgerStart || ledgerDoc.slice(ledgerStart, ledgerEnd + LEDGER_END.length) !== ledgerSection(ledger)) {
    throw new Error(`Stale ${pin.protocolVersion} requirement table; run npm run spec:docs`);
  }
  for (const entry of ledger.changes) {
    if (!entry.disposition || !entry.notes) throw new Error(`Unreviewed change: ${entry.change}`);
    for (const key of ["implementation", "evidence"]) readFileSync(path.join(root, entry[key]));
  }
  checked.push({ pin, manifest, section });
  console.log(`Verified ${ledger.changes.length} changelog dispositions and ${manifest.pages.length} pinned pages (${pin.protocolVersion} ${pin.status}, retrieved ${pin.revision}).`);
}

let failed = false;
if (process.argv.includes("--drift")) {
  const live = new Map();
  const fetchText = async (source) => {
    if (!live.has(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
      live.set(source, response.status === 404 ? null : response.ok ? Buffer.from(await response.arrayBuffer()) : response.status);
    }
    const body = live.get(source);
    if (typeof body === "number") throw new Error(`${source}: HTTP ${body}`);
    return body;
  };
  // The shared pages follow the newest draft, or the newest version once every pinned version is published.
  const byVersion = (a, b) => a.localeCompare(b, "en", { numeric: true });
  const inProgress = checked.filter(({ pin }) => pin.status === "draft");
  const newest = (inProgress.length ? inProgress : checked).map(({ pin }) => pin.protocolVersion).sort(byVersion).at(-1);
  for (const { pin, manifest, section } of checked) {
    // The site serves each page's Markdown source; the snapshot hashed it when it was stored.
    // A frozen version owns only its own pages and its changelog entries.
    const frozen = pin.status === "published";
    const shared = pin.protocolVersion === newest;
    for (const page of manifest.pages) {
      const source = page.markdown.fetched?.url;
      if (!source) continue;
      if (frozen && !shared && !page.name.startsWith(`${pin.protocolVersion}-`) && page.name !== "changelog") continue;
      const body = await fetchText(source);
      if (body === null) {
        failed = true;
        console.log(`REMOVED ${page.name} (${source}): review the changelog before updating the ${pin.protocolVersion} pin.`);
        continue;
      }
      if (frozen && page.name === "changelog") {
        const now = changelogSection(body.toString("utf8"), pin.protocolVersion);
        if (!now || JSON.stringify(entryTitles(now)) !== JSON.stringify(entryTitles(section))) {
          failed = true;
          console.log(`CHANGED ${pin.protocolVersion} changelog entries (${source}): a published version changed; review it.`);
        }
        continue;
      }
      if (hash(body) !== page.markdown.sha256) {
        failed = true;
        console.log(`CHANGED ${page.name} (${source}): review the changelog before updating the ${pin.protocolVersion} pin.`);
      }
    }
  }
  if (!failed) console.log("No drift: every pinned page's text is the same on the site.");
}
process.exitCode = failed ? 1 : 0;
