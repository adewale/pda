#!/usr/bin/env node
/** Plan bounded, honest cross-project jobs at reviewed registry pins. No live or adversarial peers. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const HONEST_SCENARIOS = "D,S0,N,SD,SV,SVN,SM,SMC,SX,SXV,C,CI,CS,CA,H,DC,SO,SE,R,AO,AM,AS,W,O,O2,OX,OU,RL,DP,CM";

export function gridPlan(registry, { previous, files = [], peers } = {}) {
  const candidates = registry.implementations.filter(entry => entry.owner !== "self" && !entry.fake && !entry.adversarial && !entry.vectorsOnly && entry.build && !entry.url);
  const wanted = peers ? new Set(peers.split(",")) : null;
  if (wanted && [...wanted].some(name => !candidates.some(entry => entry.name === name))) throw new Error("Select registered, local, honest peer names only");
  const old = new Map((previous?.implementations ?? []).map(entry => [`${entry.role}/${entry.name}`, entry]));
  return { include: candidates.filter(entry => {
    if (wanted && !wanted.has(entry.name)) return false;
    if (!previous) return true;
    const prior = old.get(`${entry.role}/${entry.name}`);
    return JSON.stringify(entry) !== JSON.stringify(prior) || files.some(file => file.startsWith(`${entry.build}/`) && !/\.(md|png|jpg|svg)$/.test(file));
  }).map(entry => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) throw new Error("Invalid registry name");
    const companies = entry.env?.INTEROP_POPPY_VERSION === "0.2" ? "lenient-company-v02" : "lenient-company,strict-company";
    return { id: `${entry.role}-${entry.name}`, agents: entry.role === "agent" ? entry.name : "pda", companies: entry.role === "company" ? entry.name : companies,
      peer: entry.name, role: entry.role, commit: entry.commit, source: entry.source };
  }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: "string" }, peers: { type: "string" }, scenarios: { type: "boolean" } } });
  if (values.scenarios) process.stdout.write(`${HONEST_SCENARIOS}\n`);
  else {
    const registry = JSON.parse(readFileSync(new URL("../interop/registry.json", import.meta.url), "utf8"));
    let previous;
    let files = [];
    if (values.base) {
      if (!/^[a-f0-9]{40}$/.test(values.base)) throw new Error("Expected an immutable base SHA");
      previous = JSON.parse(execFileSync("git", ["show", `${values.base}:interop/registry.json`], { encoding: "utf8" }));
      files = execFileSync("git", ["diff", "--name-only", values.base, "HEAD"], { encoding: "utf8" }).trim().split("\n");
    }
    process.stdout.write(`${JSON.stringify(gridPlan(registry, { previous, files, peers: values.peers }))}\n`);
  }
}
