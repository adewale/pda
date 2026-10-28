#!/usr/bin/env node
/** Read public sources and discovery only. Never execute a peer, move a pin or start a Session. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { validateTarget, isPublicHost, isPublicAddress } from "../src/validator/index.ts";
import { addressCheckingFetcher, systemResolver } from "./node-fetcher.ts";

const root = path.resolve(import.meta.dirname, "..");
const MAX_BYTES = 2_000_000;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const cell = value => String(value ?? "unknown").replace(/[\r\n]+/g, " ").replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "\\`");
const readJson = async file => JSON.parse(await readFile(file, "utf8"));

function publicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || !isPublicHost(url)) {
    throw new Error("Expected a public HTTPS URL");
  }
  return url;
}

/** Bound public responses, keep credentials on api.github.com and recheck redirects. */
export function sourceReader(fetcher = (url, init) => addressCheckingFetcher()(new Request(url, init)), token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN) {
  return async (input, json = true) => {
    let url = publicUrl(input);
    for (let hop = 0; hop <= 3; hop++) {
      const headers = { accept: json ? "application/json" : "text/html,text/plain", "user-agent": "pda-ecosystem-survey" };
      if (token && url.hostname === "api.github.com") headers.authorization = `Bearer ${token}`;
      const response = await fetcher(url.href, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (!response.headers.get("location")) throw new Error("Redirect without Location");
        url = publicUrl(new URL(response.headers.get("location"), url).href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Public response exceeds 2 MB"); }
        chunks.push(item.value);
      }
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString("utf8");
      return { value: json ? JSON.parse(text) : text, url: url.href, status: response.status, bytes: size, sha256: sha256(bytes) };
    }
    throw new Error("Too many public-source redirects");
  };
}

const errorCode = error => /^HTTP \d{3}$/.test(error.message) ? error.message : error.name === "TimeoutError" ? "timeout" : "unavailable";

/** A changed path list at GitHub's cap is not evidence that other paths stayed unchanged. */
export function comparison(value) {
  const files = value.files ?? [];
  return { commits: value.total_commits, files: files.length, complete: files.length < 300,
    poppyPaths: files.filter(file => /poppy|personal.agent|protocol|oauth|mcp|idempot|interop/i.test(file.filename)).map(file => file.filename),
    url: value.html_url };
}

export function changedDocuments(current, previous) {
  if (!previous || current.outcome === "indeterminate") return null;
  const fingerprint = row => canonical({ outcome: row.outcome, protocol: row.protocol_version,
    documents: row.documents.map(doc => [doc.kind, doc.finalUrl, doc.parsed_json_sha256 ?? null]),
    messages: row.messages.map(message => [message.id, message.severity, message.pointer]) });
  return fingerprint(current) !== fingerprint(previous);
}

export async function survey(config, previous, registry, { get = sourceReader(), discoveryFetcher = addressCheckingFetcher(), now = () => new Date().toISOString(), since = "2026-10-23" } = {}) {
  const startedAt = now();
  const output = { version: 1, startedAt, since, scope: "Public source, release and discovery GETs only; no Sessions, sign-ins, APIs or third-party code execution", repositories: [], packages: [], publicSources: [], discovery: [], candidates: [], discussions: [] };
  const oldRepositories = new Map((previous.repositories ?? []).map(row => [row.repository, row]));
  for (const repository of config.repositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid watchlist repository");
    const old = oldRepositories.get(repository);
    const known = old?.head ? { head: old.head, observedAt: old.observedAt ?? previous.finishedAt ?? previous.date ?? null } : old?.lastKnown ?? null;
    const pins = registry.implementations.filter(entry => entry.source.replace(/\.git$/, "").replace(/\/$/, "") === `https://github.com/${repository}` && entry.commit !== "HEAD")
      .map(entry => ({ name: entry.name, role: entry.role, commit: entry.commit }));
    const row = { repository, attemptedAt: now(), observedAt: null, lastKnown: known, pins };
    try {
      const answer = await get(`https://api.github.com/repos/${repository}/commits?per_page=1`);
      const commit = answer.value[0];
      if (!/^[a-f0-9]{40}$/.test(commit?.sha)) throw new Error("Missing source revision");
      Object.assign(row, { observedAt: now(), head: commit.sha, committedAt: commit.commit.committer.date, subject: commit.commit.message.split("\n")[0],
        changed: known ? known.head !== commit.sha : null, url: `https://github.com/${repository}/tree/${commit.sha}` });
      if (known && known.head !== commit.sha) {
        try { row.comparison = comparison((await get(`https://api.github.com/repos/${repository}/compare/${known.head}...${commit.sha}`)).value); }
        catch (error) { row.comparison = { complete: false, error: errorCode(error) }; }
      }
    } catch (error) { row.error = errorCode(error); }
    output.repositories.push(row);
  }
  for (const entry of config.packages) {
    const row = { ...entry, attemptedAt: now(), observedAt: null };
    try {
      const url = entry.registry === "npm" ? `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/latest` : `https://pypi.org/pypi/${encodeURIComponent(entry.name)}/json`;
      const answer = await get(url);
      Object.assign(row, { version: entry.registry === "npm" ? answer.value.version : answer.value.info.version, observedAt: now(), url, sha256: answer.sha256 });
    } catch (error) { row.error = errorCode(error); }
    output.packages.push(row);
  }
  for (const entry of config.publicSources) {
    const row = { ...entry, attemptedAt: now(), observedAt: null };
    try {
      const answer = await get(entry.url, false);
      Object.assign(row, { observedAt: now(), finalUrl: answer.url, sha256: answer.sha256, bytes: answer.bytes });
      // A bounded lead list for human review, never additional live targets or adopted implementations.
      row.githubLinks = [...new Set([...answer.value.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g)].map(match => match[0].replace(/[.)]+$/, "")))].slice(0, 60);
      row.companyLeads = [...new Set([...answer.value.matchAll(/https:\/\/papchecker\.com\/site\/([a-z0-9.-]+)/g)].map(match => match[1]))];
      row.newCompanyLeads = row.companyLeads.filter(host => !config.companies.includes(host));
    } catch (error) { row.error = errorCode(error); }
    output.publicSources.push(row);
  }
  for (const term of ['"personal agent protocol"', 'poppy']) {
    const query = `${term} created:>=${since}`;
    try {
      const answer = await get(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&per_page=20`);
      output.candidates.push({ query, observedAt: now(), total: answer.value.total_count, limit: 20,
        repositories: answer.value.items.map(item => ({ repository: item.full_name, description: item.description, fork: item.fork, url: item.html_url })) });
    } catch (error) { output.candidates.push({ query, observedAt: null, error: errorCode(error) }); }
  }
  try {
    const url = `https://api.github.com/repos/personal-agent-protocol/personal-agent-protocol/issues?state=all&since=${since}T00:00:00Z&sort=updated&direction=desc&per_page=40`;
    const answer = await get(url);
    output.discussions = answer.value.map(item => ({ number: item.number, title: item.title, state: item.state, updatedAt: item.updated_at, url: item.html_url, pullRequest: Boolean(item.pull_request) }));
    output.discussionSearch = { observedAt: now(), since, limit: 40, atLimit: answer.value.length === 40 };
  } catch (error) { output.discussionSearch = { observedAt: null, error: errorCode(error) }; }
  const oldDiscovery = new Map((previous.discovery ?? previous.results ?? []).map(row => [row.host, row]));
  for (const host of config.companies) {
    if (!/^[a-z0-9.-]+$/.test(host) || !isPublicHost(new URL(`https://${host}`))) throw new Error("Invalid watchlist Company host");
    const requests = [];
    const fetcher = async request => { requests.push(request.url); return discoveryFetcher(request); };
    const result = await validateTarget(fetcher, host);
    const value = result.documents.find(doc => doc.kind === "poppy")?.value;
    const unsupported = result.messages.some(message => message.id === "version-unsupported" || message.id === "version-unsupported-major");
    const row = { host, listed_by: config.companySources?.[host] ?? null, attemptedAt: now(), checked_at: now(), outcome: unsupported ? "unsupported" : result.outcome, validatorOutcome: result.outcome, protocol_version: value?.protocol_version ?? null,
      organization: value?.organization?.name ?? null, auth_issuer: value?.auth?.issuer ?? null,
      counts: result.counts, refused_by_pda: result.refused,
      messages: result.messages.map(({ id, severity, document, pointer, text }) => ({ id, severity, document, pointer, text })),
      documents: result.documents.map(({ value: document, ...doc }) => ({ kind: doc.kind, url: doc.url, finalUrl: doc.finalUrl, status: doc.status, contentType: doc.contentType,
        ...(document === undefined ? {} : { parsed_json_sha256: sha256(canonical(document)) }) })), requests,
      checkedAgainst: unsupported || !value ? null : result.checkedAgainst,
      protocolVersion: unsupported || !value ? null : result.protocolVersion,
      specificationRevision: unsupported || !value ? null : result.specificationRevision };
    row.changed = changedDocuments(row, oldDiscovery.get(host));
    output.discovery.push(row);
  }
  output.finishedAt = now();
  output.incomplete = [...output.repositories, ...output.packages, ...output.publicSources, ...output.candidates, output.discussionSearch].some(row => row.error || row.comparison?.complete === false)
    || output.discovery.some(row => row.outcome === "indeterminate");
  return output;
}

export function renderReport(report) {
  const date = report.startedAt.slice(0, 10);
  const count = outcome => report.discovery.filter(row => row.outcome === outcome).length;
  const lines = [`# Ecosystem survey — ${date}`, "", `Attempted ${report.startedAt}; finished ${report.finishedAt}. ${report.incomplete ? "Some observations are incomplete; their last known values are not fresh checks." : "All configured sources answered."}`, "", report.scope, "",
    `Discovery: **${count("valid")} valid, ${count("invalid")} invalid, ${count("unsupported")} unsupported by PDA, ${count("indeterminate")} indeterminate**. Unsupported profiles are not judged against older rules. These are document observations under PDA's pinned profiles, not sign-in or ordering results.`, "",
    "## Repository observations", "", "Pin values were read at survey start; reviewed follow-up pin changes are recorded separately.", "", "| Repository | Observed head | Changed since prior observation | Grid pins at survey start |", "| --- | --- | --- | --- |"];
  for (const row of report.repositories) lines.push(`| ${cell(row.repository)} | ${row.head ? `[${row.head.slice(0, 7)}](${row.url})` : cell(row.error)} | ${row.changed === null || row.changed === undefined ? "unknown" : row.changed ? "yes; review comparison" : "no"} | ${cell(row.pins.map(pin => `${pin.name}/${pin.role}: ${pin.commit.slice(0, 7)}`).join(", ") || "none")} |`);
  lines.push("", "## Packages", "", "| Registry | Package | Observed version |", "| --- | --- | --- |");
  for (const row of report.packages) lines.push(`| ${cell(row.registry)} | ${cell(row.name)} | ${cell(row.version ?? row.error)} |`);
  lines.push("", "## Public discovery", "", "| Host | Declared profile | Verdict | Errors / warnings / info | Changed documents or diagnostics |", "| --- | --- | --- | --- | --- |");
  for (const row of report.discovery) lines.push(`| ${cell(row.host)} | ${cell(row.protocol_version)} | ${cell(row.outcome)} | ${row.counts.error} / ${row.counts.warning} / ${row.counts.info} | ${row.changed === null ? "unknown" : row.changed ? "yes" : "no"} |`);
  lines.push("", "## Review leads", "", "Searches are bounded leads; forks and similarly named projects require review. No candidate was added to the interop registry.", "");
  for (const search of report.candidates) {
    lines.push(`- ${cell(search.query)}: ${search.error ? cell(search.error) : `${search.total} matches; first ${search.limit} requested`}.`);
    for (const item of search.repositories ?? []) lines.push(`  - [${cell(item.repository)}](${item.url})${item.fork ? " (fork)" : ""}: ${cell(item.description)}`);
  }
  lines.push("", "## Specification discussions", "", `Up to ${report.discussionSearch.limit ?? 40} updated items since ${report.since}; proposals and merged specification text require separate review.`, "");
  for (const item of report.discussions) lines.push(`- [${cell(item.title)}](${item.url}) (${item.pullRequest ? "PR" : "issue"}, ${item.state}, ${item.updatedAt}).`);
  lines.push("", "## Follow-up", "", "Review relevant upstream changes before moving any adapter pin. Use the targeted cross-project workflow for reviewed pin changes; keep older grid and live-journey results dated. Source movement and valid metadata do not establish successful protocol behavior.", "");
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string", default: "docs/ecosystem-status" }, watchlist: { type: "string", default: "docs/ecosystem-watchlist.json" }, since: { type: "string" }, transport: { type: "string", default: "pinned" }, help: { type: "boolean" } } });
  if (values.help) {
    process.stdout.write("Usage: npm run ecosystem:survey -- [--since YYYY-MM-DD] [--out path-prefix] [--transport pinned|proxy]\nReads the reviewed watchlist and writes JSON/Markdown observations. Does not change pins or start Sessions.\n");
    return;
  }
  const config = await readJson(path.resolve(root, values.watchlist));
  if (config.version !== 1) throw new Error("Unsupported watchlist version");
  let previous;
  try { previous = await readJson(path.join(root, "docs/ecosystem-status.json")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const baseline = path.resolve(root, config.baseline);
    previous = { ...await readJson(path.join(baseline, "sources.json")), discovery: (await readJson(path.join(baseline, "discovery.json"))).results };
  }
  const registry = await readJson(path.join(root, "interop/registry.json"));
  let discoveryFetcher;
  if (values.transport === "pinned") discoveryFetcher = addressCheckingFetcher();
  else if (values.transport === "proxy" && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)) {
    discoveryFetcher = async request => {
      const addresses = await systemResolver(new URL(request.url).hostname);
      if (addresses.length === 0 || addresses.some(item => !isPublicAddress(item.address))) throw new Error("Non-public discovery address");
      return fetch(request);
    };
  } else throw new Error("Use --transport pinned, or --transport proxy with the managed proxy configured");
  const since = values.since ?? previous.startedAt?.slice(0, 10) ?? "2026-10-23";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("Expected --since YYYY-MM-DD");
  const get = sourceReader((url, init) => discoveryFetcher(new Request(url, init)));
  const report = await survey(config, previous, registry, { get, discoveryFetcher, since });
  report.transport = values.transport === "proxy" ? "Node environment proxy with TLS verification and public-DNS checks; proxy connection is not DNS-pinned" : "Node HTTPS with DNS-pinned public-address checks";
  report.sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const destination = path.resolve(root, values.out);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(`${destination}.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${destination}.md`, renderReport(report));
  process.stdout.write(`${destination}: ${report.repositories.length} repositories, ${report.discovery.length} hosts; ${report.incomplete ? "incomplete observations need review" : "complete"}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
