#!/usr/bin/env node
/**
 * The validator cross-check: our discovery document validator (src/validator)
 * against independent ones, over the same poppy.json documents. Draft 0.1:
 * two community validators. Draft 0.2: the official Company validator, the
 * pinned snapshot in spec/ (spec/upstream.json), in its file mode.
 *
 *   node interop/vectors/validators/run.mjs [--json <file>] [--verbose]
 *
 * - tusharck/poppy-validator (MIT, Python) and habib-analyst/poppy-sidecar
 *   (MIT, Python) are fetched at pinned commits into node_modules/.cache, not
 *   vendored, and run only in Docker, with no network (`--network none`),
 *   their source mounted read-only.
 * - The official validator's CLI runs unmodified (`check --file`) in Docker,
 *   on the image its interop identity host pins
 *   (interop/impls/official-validator/Dockerfile), with no network, the
 *   snapshot mounted read-only (run_official.mjs).
 * - Ours runs here under Node, in file mode: nothing is fetched. Against the
 *   official validator it is run without a domain, as file mode has none.
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

const OFFICIAL = JSON.parse(readFileSync(join(ROOT, "spec/upstream.json"), "utf8"));
const NODE_IMAGE = /^FROM (\S+)/m.exec(readFileSync(join(ROOT, "interop/impls/official-validator/Dockerfile"), "utf8"))[1];

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
const everything = buildCorpus({
  theirsFixtures: join(sources["poppy-validator"], "tests/fixtures"),
  sidecarExamples: join(sources["poppy-sidecar"], "examples/guest-houses"),
  specPage: join(ROOT, OFFICIAL.snapshot, "pages/spec.md"),
  out: corpus
});
/** The 0.1 comparison keeps its original documents; the 0.2 one takes every document that declares 0.2. */
const manifest = everything.filter((entry) => entry.original);
const manifest02 = everything.filter((entry) => entry.version === "0.2");

// Ours, in this process: as served from its domain, and (for 0.2) in file mode, as the official validator is.
const { validateText } = await import(pathToFileURL(join(ROOT, "src/validator/index.ts")).href);
const judge = (entry, domain) => {
  const report = validateText("poppy", readFileSync(join(corpus, "docs", entry.file), "utf8"), domain ? { domain } : {});
  return { valid: !report.messages.some((m) => m.severity === "error"), findings: report.messages.map((m) => `${m.severity}:${m.id}`) };
};
const ours = Object.fromEntries(manifest.map((entry) => [entry.file, judge(entry, entry.domain)]));
const ours02 = Object.fromEntries(manifest02.map((entry) => [entry.file, judge(entry, null)]));

// Theirs, in Docker with no network.
// Behind a TLS-intercepting proxy, as for the interop runner's builds (interop/runner/cli.ts).
const proxyCa = process.env.CODEX_PROXY_CERT ? ["--secret", "id=system_ca,src=/etc/ssl/certs/ca-certificates.crt"] : [];
sh("docker", ["build", "-q", ...proxyCa, "--label", "interop.vectors=validators", "-t", IMAGE, HERE]);
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

// The official validator, in Docker with no network, as nobody.
const work = join(run, "work");
mkdirSync(work);
chmodSync(work, 0o777);
process.stdout.write(
  sh("docker", [
    "run", "--rm", "--network", "none", "--user", "65534:65534", "--label", "interop.vectors=validators",
    ...mount(join(ROOT, "spec"), "/repo/spec", "ro"),
    ...mount(join(HERE, "run_official.mjs"), "/driver/run_official.mjs", "ro"),
    ...mount(corpus, "/corpus", "ro"),
    ...mount(out, "/out", "rw"),
    ...mount(work, "/work", "rw"),
    NODE_IMAGE, "node", "/driver/run_official.mjs"
  ])
);
const official = JSON.parse(readFileSync(join(out, "official.json"), "utf8"));

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

console.log(`\nDraft 0.1: ${manifest.length} documents. Same verdict:`);
for (const [pair, n] of Object.entries(agree)) console.log(`  ${pair}: ${n}`);
console.log(`  all three: ${all}`);
if (crashes) console.log(`  validator crashes: ${crashes}`);
console.log(`\nWhere they differ (${differ.length}):`);
for (const d of differ) {
  console.log(`  ${d.name.padEnd(50)} ours=${d.ours.padEnd(7)} poppy-validator=${d["poppy-validator"].padEnd(7)} poppy-sidecar=${d["poppy-sidecar"]}`);
  if (args.verbose) for (const n of names) console.log(`      ${n}: ${results[n][manifest.find((e) => e.name === d.name).file].findings.join(" ")}`);
}
// Draft 0.2: ours (file mode) against the official validator.
let agree02 = 0;
const differ02 = [];
for (const entry of manifest02) {
  const a = verdict(ours02[entry.file]);
  const b = verdict(official[entry.file]);
  if (a === b) agree02++;
  else differ02.push({ name: entry.name, source: entry.source, ours: a, official: b });
}
console.log(`\nDraft 0.2: ${manifest02.length} documents, file mode. Same verdict, ours = official: ${agree02}`);
console.log(`Where they differ (${differ02.length}):`);
for (const d of differ02) {
  console.log(`  ${d.name.padEnd(50)} ours=${d.ours.padEnd(7)} official=${d.official}`);
  if (args.verbose) {
    const file = manifest02.find((e) => e.name === d.name).file;
    console.log(`      ours: ${ours02[file].findings.join(" ")}`);
    console.log(`      official: ${official[file].findings.join(" ")}`);
  }
}
if (args.json) {
  const pins = { ...PINS, official: { repo: "personal-agent-protocol/personal-agent-protocol", commit: OFFICIAL.commit, snapshot: OFFICIAL.snapshot } };
  writeFileSync(args.json, JSON.stringify({ pins, documents: manifest.length, agree, all, differ, results, manifest, v02: { documents: manifest02.length, agree: agree02, differ: differ02, results: { ours: ours02, official }, manifest: manifest02 } }, null, 2));
  console.log(`\nWrote ${args.json}`);
}
