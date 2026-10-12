#!/usr/bin/env node
/**
 * The validator cross-check: our discovery document validator (src/validator)
 * against two independent ones, over the same poppy.json documents.
 *
 *   node interop/vectors/validators/run.mjs [--json <file>] [--verbose]
 *
 * - tusharck/poppy-validator (MIT, Python) and habib-analyst/poppy-sidecar
 *   (MIT, Python) are fetched at pinned commits into node_modules/.cache, not
 *   vendored, and run only in Docker, with no network (`--network none`),
 *   their source mounted read-only.
 * - Ours runs here under Node, in file mode: nothing is fetched.
 * - The corpus is corpus.mjs: our fixtures, probes, and the two projects'
 *   own example documents (read as data).
 *
 * It prints each validator's verdict (valid: no errors) per document, the
 * agreement between each pair, and every document where they differ. The
 * differences are judged by hand against the stored draft, in
 * docs/interop-testing.md ("Validator cross-check"). Information only: the
 * exit status is 0 unless the harness itself failed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildCorpus } from "./corpus.mjs";

export const PINS = {
  "poppy-validator": { repo: "tusharck/poppy-validator", commit: "d2220bfefb519f603bc2de6a4c5a63db04c660d3" },
  "poppy-sidecar": { repo: "habib-analyst/poppy-sidecar", commit: "858db66bcaa0cd26b3dbfec16ea5a8fb2055b8ef" }
};
const IMAGE = "poppy-interop/validator-xcheck:latest";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const CACHE = join(ROOT, "node_modules/.cache/validator-xcheck");

const { values: args } = parseArgs({ options: { json: { type: "string" }, verbose: { type: "boolean" } } });

function sh(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    process.stderr.write(`${command} ${argv.join(" ")} failed:\n${result.stderr ?? ""}${result.stdout ?? ""}\n`);
    process.exit(2);
  }
  return result.stdout;
}

/** Each project's source at its pinned commit, from GitHub's tarball, unpacked once. */
function fetchSource(name) {
  const { repo, commit } = PINS[name];
  const dir = join(CACHE, `${name}-${commit}`);
  if (existsSync(join(dir, "LICENSE"))) return dir;
  mkdirSync(dir, { recursive: true });
  const tarball = join(CACHE, `${name}-${commit}.tar.gz`);
  sh("curl", ["-sSfL", "-o", tarball, `https://codeload.github.com/${repo}/tar.gz/${commit}`]);
  sh("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1"]);
  return dir;
}

const sources = { "poppy-validator": fetchSource("poppy-validator"), "poppy-sidecar": fetchSource("poppy-sidecar") };
const run = mkdtempSync(join(CACHE, "run-"));
const corpus = join(run, "corpus");
const out = join(run, "out");
mkdirSync(out);
chmodSync(out, 0o777); // the container runs as nobody
const manifest = buildCorpus({
  theirsFixtures: join(sources["poppy-validator"], "tests/fixtures"),
  sidecarExamples: join(sources["poppy-sidecar"], "examples/guest-houses"),
  out: corpus
});

// Ours, in this process.
const { validateText } = await import(pathToFileURL(join(ROOT, "src/validator/index.ts")).href);
const ours = {};
for (const entry of manifest) {
  const report = validateText("poppy", readFileSync(join(corpus, "docs", entry.file), "utf8"), { domain: entry.domain });
  ours[entry.file] = {
    valid: !report.messages.some((m) => m.severity === "error"),
    findings: report.messages.map((m) => `${m.severity}:${m.id}`)
  };
}

// Theirs, in Docker with no network.
sh("docker", ["build", "-q", "--label", "interop.vectors=validators", "-t", IMAGE, HERE]);
const mount = (from, to, mode) => ["-v", `${from}:${to}:${mode}`];
process.stdout.write(
  sh("docker", [
    "run", "--rm", "--network", "none", "--label", "interop.vectors=validators",
    ...mount(sources["poppy-validator"], "/src/poppy-validator", "ro"),
    ...mount(sources["poppy-sidecar"], "/src/poppy-sidecar", "ro"),
    ...mount(corpus, "/corpus", "ro"),
    ...mount(out, "/out", "rw"),
    IMAGE
  ])
);

const results = {
  ours,
  "poppy-validator": JSON.parse(readFileSync(join(out, "poppy-validator.json"), "utf8")),
  "poppy-sidecar": JSON.parse(readFileSync(join(out, "poppy-sidecar.json"), "utf8"))
};
const names = Object.keys(results);
const verdict = (r) => (r.valid === null ? "crash" : r.valid ? "valid" : "invalid");
const pairs = [["ours", "poppy-validator"], ["ours", "poppy-sidecar"], ["poppy-validator", "poppy-sidecar"]];
const agree = Object.fromEntries(pairs.map(([a, b]) => [`${a} = ${b}`, 0]));
let all = 0;
let crashes = 0;
const differ = [];
for (const entry of manifest) {
  const v = Object.fromEntries(names.map((n) => [n, verdict(results[n][entry.file])]));
  crashes += names.filter((n) => v[n] === "crash").length;
  for (const [a, b] of pairs) if (v[a] === v[b]) agree[`${a} = ${b}`]++;
  if (names.every((n) => v[n] === v.ours)) all++;
  else differ.push({ name: entry.name, source: entry.source, ...v });
}

console.log(`\n${manifest.length} documents. Same verdict:`);
for (const [pair, n] of Object.entries(agree)) console.log(`  ${pair}: ${n}`);
console.log(`  all three: ${all}`);
if (crashes) console.log(`  validator crashes: ${crashes}`);
console.log(`\nWhere they differ (${differ.length}):`);
for (const d of differ) {
  console.log(`  ${d.name.padEnd(50)} ours=${d.ours.padEnd(7)} poppy-validator=${d["poppy-validator"].padEnd(7)} poppy-sidecar=${d["poppy-sidecar"]}`);
  if (args.verbose) for (const n of names) console.log(`      ${n}: ${results[n][manifest.find((e) => e.name === d.name).file].findings.join(" ")}`);
}
if (args.json) {
  writeFileSync(args.json, JSON.stringify({ pins: PINS, documents: manifest.length, agree, all, differ, results, manifest }, null, 2));
  console.log(`\nWrote ${args.json}`);
}
