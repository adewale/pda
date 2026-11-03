#!/usr/bin/env node
/** Check local Markdown links, anchors and scenario references, without collecting tests.
 * Navigation checks do not establish behavioral coverage.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Project documents; pinned snapshots and vendored skills keep their original links. */
function markdownFiles(root) {
  const files = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".md")).map(entry => entry.name);
  function walk(dir) {
    let entries;
    try { entries = readdirSync(path.join(root, dir), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(file);
    }
  }
  for (const dir of ["docs", "interop", "test"]) walk(dir);
  return files;
}

/** Blank fenced examples and HTML comments while preserving diagnostic line numbers. */
function prose(text) {
  let fence;
  return text.replace(/<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, " "))
    .split("\n").map(line => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
        return "";
      }
      if (marker) { fence = marker; return ""; }
      return line;
    }).join("\n");
}

/** GitHub-style heading fragments, including duplicate headings and explicit HTML anchors. */
function anchors(text) {
  const visible = prose(text);
  const ids = new Set([...visible.matchAll(/<(?:a|h[1-6])\b[^>]*\bid=["']([^"']+)["']/gi)].map(match => match[1]));
  const used = new Set();
  const lines = visible.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[index])?.[1]
      ?? (index + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1]) && lines[index].trim() ? lines[index].trim() : undefined);
    if (heading === undefined) continue;
    const base = heading.replace(/<[^>]+>/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
    let id = base, suffix = 0;
    while (used.has(id)) id = `${base}-${++suffix}`;
    used.add(id);
    ids.add(id);
  }
  return ids;
}

export function checkReferences(root) {
  const problems = [];
  let references = 0;
  const fragments = new Map();
  function file(from, target, line, { fragment = "", requireFile = false, count = true } = {}) {
    if (count) references++;
    const resolved = path.resolve(root, path.dirname(from), target);
    const relative = path.relative(root, resolved);
    if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      problems.push(`${from}:${line}: reference leaves the repository: ${target}`);
      return;
    }
    let destination = resolved;
    try {
      const stat = statSync(destination);
      if (requireFile && !stat.isFile()) throw new Error("not a file");
      if (stat.isDirectory()) destination = path.join(destination, "README.md");
    } catch { problems.push(`${from}:${line}: missing file: ${target}`); return; }
    if (!fragment || !destination.endsWith(".md")) return;
    try {
      if (!fragments.has(destination)) fragments.set(destination, anchors(readFileSync(destination, "utf8")));
      if (!fragments.get(destination).has(fragment)) problems.push(`${from}:${line}: missing anchor: ${target}#${fragment}`);
    } catch { problems.push(`${from}:${line}: cannot read anchor target: ${target}#${fragment}`); }
  }
  function links(from, text, { firstLine = 1, requireFile = false, count = true } = {}) {
    const code = [...text.matchAll(/(`+)[\s\S]*?\1(?!`)/g)].map(match => [match.index, match.index + match[0].length]);
    for (const match of text.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\)/g)) {
      if (code.some(([start, end]) => match.index >= start && match.index < end)) continue;
      const raw = match[1] ?? match[2];
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/")) continue;
      const line = firstLine + text.slice(0, match.index).split("\n").length - 1;
      const at = raw.indexOf("#");
      let filePart, fragment;
      try {
        filePart = decodeURIComponent(at < 0 ? raw : raw.slice(0, at));
        fragment = at < 0 ? "" : decodeURIComponent(raw.slice(at + 1));
      }
      catch { problems.push(`${from}:${line}: invalid URL encoding: ${raw}`); continue; }
      file(from, filePart || path.basename(from), line, { fragment, requireFile, count });
    }
  }
  for (const document of markdownFiles(root)) links(document, prose(readFileSync(path.join(root, document), "utf8")));
  const spec = "pda-spec.md";
  const lines = readFileSync(path.join(root, spec), "utf8").split("\n");
  const start = lines.findIndex((line) => /^## Appendix A\b/.test(line));
  if (start < 0) throw new Error("pda-spec.md has no Appendix A");
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    if (!lines[i].startsWith("|")) continue;
    const evidence = lines[i].split(/(?<!\\)\|/).at(-2) ?? "";
    // General navigation can name a directory; requirement evidence must name a file.
    links(spec, evidence, { firstLine: i + 1, requireFile: true, count: false });
    if (/\b(?:Test|property|page test):/i.test(evidence) && !/\[[^\]]+\]\([^)]+\)/.test(evidence)) {
      problems.push(`${spec}:${i + 1}: test evidence needs a stable file link`);
    }
  }
  const adversarial = "docs/adversarial-interop.md";
  readFileSync(path.join(root, adversarial), "utf8").split("\n").forEach((line, index) => {
    const row = /^\|\s*`([A-Z][A-Z0-9]*)`\s*\|.*\|([^|]*)\|\s*$/.exec(line);
    if (!row) return;
    const status = row[2];
    for (const m of status.matchAll(/\b[Ss]cenarios?\s+`([A-Z][A-Z0-9]*)`/g)) {
      file(adversarial, `../interop/scenarios/${m[1]}.json`, index + 1, { requireFile: true });
    }
  });
  return { problems: [...new Set(problems)], references };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error("Usage: node scripts/check-docs.mjs");
    const { problems, references } = checkReferences(path.resolve(import.meta.dirname, ".."));
    for (const problem of problems) console.error(problem);
    console.log(`${references} local Markdown links and scenario references checked; navigation does not establish behavioral coverage.`);
    process.exitCode = problems.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
