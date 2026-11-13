#!/usr/bin/env node
/**
 * The sentences whose BCP 14 key words changed between two snapshots, such
 * as a MUST that became a SHOULD: `node scripts/keyword-changes.mjs <old
 * snapshot> <new snapshot>`. A report for review when a pin is refreshed
 * (docs/upgrading.md), never a gate: it pairs each sentence with the most
 * similar one on the same page, which an edit can fool, and a key word can
 * move to another sentence. The changelog says what changed on purpose; this
 * finds what it doesn't say, such as an entry edited in place.
 *
 * Pages pair by name without their version (`0.4-spec` with `1.0-spec`).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { normalize } from "./check-requirements.mjs";

const KEY_WORDS = /\b(MUST NOT|MUST|REQUIRED|SHALL NOT|SHALL|SHOULD NOT|SHOULD|NOT RECOMMENDED|RECOMMENDED|MAY|OPTIONAL)\b/g;
const keyWords = (sentence) => [...new Set(sentence.match(KEY_WORDS) ?? [])].sort().join(", ");

function pages(snapshot) {
  const dir = path.join(snapshot, "pages");
  return new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => [file.replace(/^\d+\.\d+-/, "").replace(/\.md$/, ""), sentences(readFileSync(path.join(dir, file), "utf8"))])
  );
}

function sentences(text) {
  return text
    .split(/\n\s*\n|\n(?=- |\| |\d+\. )/)
    .flatMap((block) => normalize(block).split(/(?<=[.;])\s+(?=[A-Z])/))
    .filter((sentence) => sentence.length > 30 && sentence.length < 800)
    .map((sentence) => ({ sentence, words: new Set(sentence.toLowerCase().match(/[a-z0-9_.:/-]{4,}/g) ?? []) }));
}

const similarity = (a, b) => {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.max(1, a.size + b.size - shared);
};

/** For each sentence with key words in `from`, the most similar sentence in `to`, when its key words differ. */
function changed(from, to) {
  const found = [];
  for (const one of from) {
    const words = keyWords(one.sentence);
    if (!words) continue;
    let best, score = 0;
    for (const other of to) {
      const s = similarity(one.words, other.words);
      if (s > score) [best, score] = [other, s];
    }
    if (best && score > 0.45 && keyWords(best.sentence) !== words) found.push({ from: one.sentence, to: best.sentence, score });
  }
  return found;
}

const [oldSnapshot, newSnapshot] = process.argv.slice(2);
if (!oldSnapshot || !newSnapshot) {
  console.error("Usage: node scripts/keyword-changes.mjs <old snapshot> <new snapshot>");
  process.exit(2);
}
const before = pages(oldSnapshot), after = pages(newSnapshot);
let count = 0;
for (const [name, old] of before) {
  const now = after.get(name);
  if (!now) {
    console.log(`## ${name}: not in ${newSnapshot}`);
    continue;
  }
  // Both directions: a weakened sentence is found from the old text, a strengthened one from the new.
  const seen = new Set();
  const report = [...changed(old, now), ...changed(now, old).map(({ from, to, score }) => ({ from: to, to: from, score }))]
    .filter(({ from, to }) => !seen.has(`${from}\n${to}`) && seen.add(`${from}\n${to}`));
  if (report.length === 0) continue;
  console.log(`## ${name}`);
  for (const { from, to, score } of report) {
    count++;
    console.log(`\n${keyWords(from) || "no key word"} → ${keyWords(to) || "no key word"} (similarity ${score.toFixed(2)})\n  before: ${from}\n  after:  ${to}`);
  }
  console.log("");
}
console.log(`${count} sentences whose key words changed, from ${oldSnapshot} to ${newSnapshot}.`);
