#!/usr/bin/env node
/** Check stable evidence-file and scenario references, without collecting tests.
 * File existence is navigation hygiene, not proof of behavioral coverage.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function checkReferences(root) {
  const problems = [];
  let references = 0;
  function file(from, target, line) {
    references++;
    const resolved = path.resolve(root, path.dirname(from), target);
    const relative = path.relative(root, resolved);
    if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      problems.push(`${from}:${line}: reference leaves the repository: ${target}`);
      return;
    }
    try {
      if (!statSync(resolved).isFile()) throw new Error("not a file");
    } catch { problems.push(`${from}:${line}: missing evidence file: ${target}`); }
  }
  function links(from, text, line) {
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) file(from, target, line);
    }
  }
  const spec = "pda-spec.md";
  const lines = readFileSync(path.join(root, spec), "utf8").split("\n");
  const start = lines.findIndex((line) => /^## Appendix A\b/.test(line));
  if (start < 0) throw new Error("pda-spec.md has no Appendix A");
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    if (!lines[i].startsWith("|")) continue;
    const evidence = lines[i].split(/(?<!\\)\|/).at(-2) ?? "";
    links(spec, evidence, i + 1);
    if (/\b(?:Test|property|page test):/i.test(evidence) && !/\[[^\]]+\]\([^)]+\)/.test(evidence)) {
      problems.push(`${spec}:${i + 1}: test evidence needs a stable file link`);
    }
  }
  const adversarial = "docs/adversarial-interop.md";
  readFileSync(path.join(root, adversarial), "utf8").split("\n").forEach((line, index) => {
    const row = /^\|\s*`([A-Z][A-Z0-9]*)`\s*\|.*\|([^|]*)\|\s*$/.exec(line);
    if (!row) return;
    const status = row[2];
    links(adversarial, status, index + 1);
    for (const m of status.matchAll(/\b[Ss]cenarios?\s+`([A-Z][A-Z0-9]*)`/g)) {
      file(adversarial, `../interop/scenarios/${m[1]}.json`, index + 1);
    }
  });
  return { problems, references };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error("Usage: node scripts/check-docs.mjs");
    const { problems, references } = checkReferences(path.resolve(import.meta.dirname, ".."));
    for (const problem of problems) console.error(problem);
    console.log(`${references} evidence-file/scenario references checked; file existence does not establish behavioral coverage.`);
    process.exitCode = problems.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
