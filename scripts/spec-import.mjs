#!/usr/bin/env node
/** Import from Git objects, never from an uncommitted working tree. Does not activate a pin. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("spec:import -- --source <local upstream clone> --commit <full SHA> --version <major.minor> --revision <YYYY-MM-DD> --operations-version <version> [--output <new directory>]");
  process.exit(0);
}
const { values } = parseArgs({ args, options: Object.fromEntries(["source", "commit", "version", "revision", "operations-version", "output"].map((name) => [name, { type: "string" }])) });
const options = Object.fromEntries(Object.entries(values).map(([name, value]) => [`--${name}`, value]));
const { "--source": source, "--commit": commit, "--version": version, "--revision": revision, "--operations-version": operationsVersion } = options;
if (!source || !/^[a-f0-9]{40}$/.test(commit ?? "") || !/^\d+\.\d+$/.test(version ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(revision ?? "") || !operationsVersion) throw new Error("Missing or invalid explicit inputs. Use --help.");
if (new Date(`${revision}T00:00:00Z`).toISOString().slice(0, 10) !== revision) throw new Error("Invalid revision date");
const git = (...argv) => execFileSync("git", ["-C", path.resolve(source), ...argv], { maxBuffer: 16 * 1024 * 1024 });
if (git("rev-parse", `${commit}^{commit}`).toString().trim() !== commit) throw new Error("Commit is not available in the source clone");
const output = path.resolve(options["--output"] ?? `spec/draft-${version}-${revision}`);
if (existsSync(output)) throw new Error(`Refusing to replace existing snapshot: ${output}`);
const files = new Map();
for (const file of git("ls-tree", "-r", "--name-only", commit, "kit/company/schemas", "kit/company/validate").toString().trim().split("\n").filter(Boolean)) files.set(file, git("show", `${commit}:${file}`));
for (const page of ["spec", "extensions", "operations", "guides", "changelog", "introduction", "path-to-1"]) files.set(`pages/${page}.md`, git("show", `${commit}:skills/implement-personal-agent-protocol/reference/${page}.md`));
if (!files.get("pages/spec.md").toString().includes(`draft version ${version}`)) throw new Error("The selected source specification does not match --version");
files.set("LICENSE", git("show", `${commit}:LICENSE`));
// Resolve every object before writing anything: missing upstream paths fail without a partial import.
const manifest = { protocolVersion: version, revision, upstream: "https://github.com/personal-agent-protocol/personal-agent-protocol", commit, retrievedAt: new Date().toISOString().slice(0, 10), operationsVersion, files: {} };
for (const [file, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  mkdirSync(path.dirname(path.join(output, file)), { recursive: true });
  writeFileSync(path.join(output, file), bytes);
  manifest.files[file] = createHash("sha256").update(bytes).digest("hex");
}
writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(path.join(output, "README.md"), `# Pinned Poppy ${version}\n\nRevision ${revision}, commit [${commit}](${manifest.upstream}/tree/${commit}). Operations ${operationsVersion}. Imported upstream files are unmodified and licensed by LICENSE. See manifest.json for SHA-256 hashes.\n\nReview the official pages/changelog.md and actual specification diff before activating this snapshot in spec/upstream.json. Update implementation constants, requirement ledger, profiles, changelog and validation evidence in the same review.\n`);
console.log(`Imported ${files.size} files into ${output}. The active pin is unchanged.`);
