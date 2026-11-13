#!/usr/bin/env node
/**
 * Ties each normative check to the pinned sentence it enforces, so a change
 * upstream fails a check instead of leaving a rule at its old strength.
 *
 * - A validator message (src/validator/messages.ts) whose basis is MUST,
 *   SHOULD or Rule quotes its sentence in `requires`.
 * - A mock violation (test/mock-company/violations.ts) with that basis, or
 *   MUST NOT, SHOULD NOT or Guides, quotes it in its basis string.
 *
 * Each quote must appear in every runtime pin (one marked 1.0 only in the 1.0
 * pin), within one paragraph, after removing Markdown links, emphasis and
 * code marks; `…` separates parts that appear in that order. The quote must
 * carry its basis's key word: MUST (or a required field) for a MUST, SHOULD
 * for a SHOULD, and none of MUST or SHOULD for a Rule or the Guides. Quotes
 * of another standard (an RFC basis, or a location naming MCP or an RFC) are
 * not checked, nor is a validator message whose ref is an RFC. A key word that changes upstream changes the sentence, so the
 * quote stops matching and the basis has to be reviewed. A quote that appears in
 * no new pin is the first sign: docs/upgrading.md says what to do.
 *
 * `check-spec.mjs` runs this. Run it alone to list every problem, or with
 * `--quote <basis> <text> [version]` to test one quote.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

/** Text as quotes are written: no link targets, emphasis, code marks or curly quotes, one space between words. */
export const normalize = (text) =>
  text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** A runtime pin's paragraphs, from every page. */
export function paragraphs(snapshot) {
  const dir = path.join(root, snapshot, "pages");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .flatMap((file) => readFileSync(path.join(dir, file), "utf8").split(/\n\s*\n/))
    .map(normalize);
}

const KEY_WORDS = {
  // A required member: the key word, "Required." in a list, or Yes in a table's Req. column.
  MUST: /\b(MUST|REQUIRED|SHALL|Required)\b|\b(is|are) required\b|\| Yes \|/,
  SHOULD: /\b(SHOULD|RECOMMENDED)\b/
};
const STRONGER = /\b(MUST|SHOULD|REQUIRED|RECOMMENDED|SHALL)\b/;

/** What's wrong with a quote for `basis` ("MUST", "MUST NOT", "SHOULD", "Rule", "Guides"), or nothing. */
export function quoteProblem(basis, quote, pins) {
  const parts = normalize(quote).split(/\s*(?:…|\.\.\.)\s*/).filter(Boolean);
  for (const pin of pins) {
    const found = pin.paragraphs.some((paragraph) => {
      let from = 0;
      return parts.every((part) => {
        const at = paragraph.indexOf(part, from);
        from = at + part.length;
        return at >= 0;
      });
    });
    if (!found) return `not in the ${pin.version} text`;
  }
  const kind = basis.split(" ")[0];
  const text = parts.join(" ");
  if (KEY_WORDS[kind] && !KEY_WORDS[kind].test(text)) return `a ${basis} basis, but the quote has no ${kind}`;
  if ((kind === "Rule" || kind === "Guides") && STRONGER.test(text)) return `a ${basis} basis, but the quote has ${STRONGER.exec(text)[0]}`;
  return undefined;
}

const NEEDS_QUOTE = new Set(["MUST", "MUST NOT", "SHOULD", "SHOULD NOT", "Rule", "Guides"]);

/** The runtime pins, each with its paragraphs. */
export function runtimePins() {
  const { pins } = JSON.parse(readFileSync(path.join(root, "spec/upstream.json"), "utf8"));
  return pins.filter((pin) => pin.runtime).map((pin) => ({ version: pin.protocolVersion, paragraphs: paragraphs(pin.snapshot) }));
}

/** Every problem with the catalogs' quotes, as "where: what". */
export async function requirementProblems(pins = runtimePins()) {
  const problems = [];
  const only = (version) => pins.filter((pin) => pin.version === version);

  const { MESSAGES } = await import(pathToFileURL(path.join(root, "src/validator/messages.ts")).href);
  for (const [id, message] of Object.entries(MESSAGES)) {
    // A SHOULD of an RFC the draft builds on is quoted by its ref, not here.
    if (message.note || !NEEDS_QUOTE.has(message.basis) || message.ref.url.startsWith("https://www.rfc-editor.org/")) continue;
    const where = `src/validator/messages.ts ${id}`;
    if (!message.requires) {
      problems.push(`${where}: a ${message.basis} message with no requires quote`);
      continue;
    }
    const applies = message.ref.url.includes("/docs/1.0/") ? only("1.0") : pins;
    const problem = quoteProblem(message.basis, message.requires, applies);
    if (problem) problems.push(`${where}: ${problem}: "${message.requires}"`);
  }

  const { VIOLATIONS } = await import(pathToFileURL(path.join(root, "test/mock-company/violations.ts")).href);
  for (const [id, basis] of Object.entries(VIOLATIONS)) {
    const match = /^(MUST NOT|MUST|SHOULD NOT|SHOULD|RFC|Rule|Guides|Reading|MAY) \(([^:)]*)/.exec(basis);
    const where = `test/mock-company/violations.ts ${id}`;
    if (!match) {
      problems.push(`${where}: no basis`);
      continue;
    }
    const [, kind, location] = match;
    if (!NEEDS_QUOTE.has(kind) || /^(MCP|RFC)\b/.test(location)) continue;
    const quotes = [...basis.matchAll(/"([^"]+)"/g)].map((quote) => quote[1]);
    if (quotes.length === 0) {
      problems.push(`${where}: a ${kind} basis with no quote`);
      continue;
    }
    const applies = /^1\.0\b/.test(location) ? only("1.0") : pins;
    const found = quotes.map((quote) => quoteProblem(kind, quote, applies));
    const missing = found.findIndex((problem) => problem?.startsWith("not in"));
    if (missing >= 0) problems.push(`${where}: ${found[missing]}: "${quotes[missing]}"`);
    // One quote carries the key word; the others may say where or when.
    else if (found.every(Boolean)) problems.push(`${where}: ${found[0]}`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf("--quote");
  if (at >= 0) {
    const [basis, quote, version] = process.argv.slice(at + 1);
    const pins = runtimePins().filter((pin) => !version || pin.version === version);
    console.log(quoteProblem(basis, quote, pins) ?? `ok in ${pins.map((pin) => pin.version).join(" and ")}`);
  } else {
    const problems = await requirementProblems();
    for (const problem of problems) console.log(problem);
    console.log(`${problems.length} problems`);
    process.exitCode = problems.length ? 1 : 0;
  }
}
