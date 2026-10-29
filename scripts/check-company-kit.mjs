#!/usr/bin/env node
/** Run the verified upstream CLI (optionally a separately patched copy) against local HTTPS/workerd. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import { localAgent, localFetch } from "../test/company-kit/local-https.mjs";
import { dpopControls } from "../test/company-kit/dpop-controls.mjs";

const root = path.resolve(import.meta.dirname, "..");
const snapshot = path.join(root, "spec/company-kit-2026-10-29");
const kit = path.join(snapshot, "kit");
let cli = path.join(kit, "validate/index.ts");
const manifest = JSON.parse(readFileSync(path.join(snapshot, "manifest.json"), "utf8"));
const digest = data => createHash("sha256").update(data).digest("hex");
assert.equal(digest(readFileSync(path.join(snapshot, "upstream.zip"))), manifest.archiveSha256, "The original Company kit archive changed");
for (const [file, sha] of Object.entries(manifest.files)) assert.equal(digest(readFileSync(path.join(snapshot, file))), sha, `Upstream file changed: ${file}`);

const args = process.argv.slice(2);
const withDpop = args.includes("--with-dpop");
const output = args.includes("--output") ? args[args.indexOf("--output") + 1] : undefined;
if (args.includes("--verify-pin")) { process.stdout.write(`Verified Company kit: ${Object.keys(manifest.files).length} unmodified files and original archive.\n`); process.exit(0); }
if (!output) throw new Error("Usage: node scripts/check-company-kit.mjs --output <receipt.json> [--reviewed-findings] | --verify-pin");
const directory = mkdtempSync(path.join(tmpdir(), "pda-company-kit-"));
chmodSync(directory, 0o700);
const dpopPatch = path.join(root, "test/company-kit/dpop-probes.patch");
if (withDpop) {
  const copy = path.join(directory, "kit");
  cpSync(kit, copy, { recursive: true });
  execFileSync("git", ["apply", "--unidiff-zero", dpopPatch], { cwd: copy, stdio: "pipe" });
  cli = path.join(copy, "validate/index.ts");
}
const pdaOrigin = "https://kit-agent.test";
const companyOrigin = "https://kit-hosted.test";
const hosts = ["kit-agent.test", "kit-hosted.test", ...["", "auth.", "api.", "mcp.", "www.", "cdn."].flatMap(prefix => [`${prefix}kit.shop.test`, `${prefix}kit.shop-uk.test`])];
const failures = [];
let runtime, server, agent;

async function command(argv, env = {}) {
  const child = spawn(process.execPath, argv, { cwd: directory, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
  try { const [code] = await once(child, "close"); return { code, stdout }; }
  finally { clearTimeout(timer); }
}

try {
  const keygen = await command([cli, "keygen", "--base-url", `${pdaOrigin}/poppy`]);
  assert.equal(keygen.code, 0, "Upstream test identity generation failed");
  // Provision the generated identity at the existing hosted Company's exact allowlisted client_id.
  // Neither the validator source nor the Company's allowlist is changed.
  for (const file of ["config.json", "agent.json"]) {
    const target = path.join(directory, ".poppy", file);
    const value = JSON.parse(readFileSync(target, "utf8"));
    value.client_id = `${pdaOrigin}/poppy/client.json`;
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(target, 0o600);
  }
  const certificate = path.join(directory, "certificate.pem");
  const tlsKey = path.join(directory, "tls-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tlsKey, "-out", certificate, "-days", "1", "-subj", "/CN=kit-agent.test", "-addext", `subjectAltName=${hosts.map(host => `DNS:${host}`).join(",")}`], { stdio: "ignore" });
  const config = JSON.parse(readFileSync(path.join(root, "test/hosted/company.wrangler.jsonc"), "utf8"));
  config.main = path.join(root, "test/company-kit/worker.ts");
  config.durable_objects.bindings.push({ name: "MOCK_COMPANY", class_name: "MockCompany" });
  config.migrations[0].new_sqlite_classes.push("MockCompany");
  const configFile = path.join(directory, "wrangler.json");
  writeFileSync(configFile, JSON.stringify(config));
  const bundle = path.join(directory, "bundle");
  execFileSync(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--config", configFile, "--outdir", bundle], { cwd: root, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  const control = randomBytes(32).toString("base64url");
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: "company-kit", scriptPath: path.join(bundle, "worker.js"), modules: true, modulesRoot: bundle,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    durableObjects: { HOSTED_COMPANY: { className: "HostedCompany", useSQLite: true }, MOCK_COMPANY: { className: "MockCompany", useSQLite: true } },
    bindings: { PUBLIC_ORIGIN: "https://no-direct-worker.invalid", COMPANY_ORIGIN: companyOrigin, PDA_ORIGIN: pdaOrigin, COMPANY_PASSWORD: randomBytes(32).toString("base64url"), COMPANY_CONTROL_SECRET: control },
    log: new Log(LogLevel.ERROR),
    outboundService: request => localFetch(agent, request)
  }));
  await runtime.ready;
  server = createServer({ key: readFileSync(tlsKey), cert: readFileSync(certificate) }, async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, `https://${incoming.headers.host}`);
      assert.ok(hosts.includes(url.hostname), "Unexpected local hostname");
      let response;
      if (url.origin === pdaOrigin) {
        const file = url.pathname === "/poppy/client.json" ? "agent.json" : url.pathname === "/poppy/jwks.json" ? "jwks.json" : undefined;
        response = file ? new Response(readFileSync(path.join(directory, ".poppy", file)), { headers: { "Content-Type": "application/json" } }) : new Response(null, { status: 404 });
      } else {
        const chunks = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        response = await runtime.dispatchFetch(url, { method: incoming.method, headers: incoming.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), redirect: "manual" });
      }
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), ...(response.headers.getSetCookie().length ? { "set-cookie": response.headers.getSetCookie() } : {}) });
      if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
      else outgoing.end();
    } catch { failures.push("Local HTTPS transport failed"); if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const network = { port: server.address().port, hosts, certificate };
  agent = localAgent(network);
  const networkFile = path.join(directory, "network.json");
  writeFileSync(networkFile, JSON.stringify(network));
  const mock = (await runtime.getDurableObjectNamespace("MOCK_COMPANY")).getByName("kit");
  const runs = [];
  const proofControls = [];
  for (const profile of ["lenient", "strict", "bearer", "hosted"]) {
    if (profile !== "hosted") {
      await mock.configure({ protocolVersion: "0.3", strictAssertions: profile !== "lenient", dpopTokens: profile !== "bearer", unknownApi: false, unknownProtocol: false, unknownExtension: false, unknownField: false, printShop: true, feedback: true });
    }
    const target = profile === "hosted" ? companyOrigin : "https://kit.shop.test";
    const run = await command(["--import", path.join(root, "test/company-kit/local-https.mjs"), cli, "check", target, "--allow-private-addresses", "--json", ...(profile === "hosted" ? ["--probe", `${companyOrigin}/products`] : [])], { PDA_COMPANY_KIT_NETWORK: networkFile });
    assert.ok(run.code === 0 || run.code === 1, "Upstream CLI did not finish a validation run");
    const report = JSON.parse(run.stdout);
    runs.push({ profile, target, exitCode: run.code, ...report });
    process.stdout.write(`${profile}: ${JSON.stringify(report.summary.total)}\n`);
    if (withDpop && profile !== "bearer") proofControls.push({ profile, results: await dpopControls({ kit, directory, target, fetcher: (url, init) => localFetch(agent, url, init) }) });
  }
  const limits = JSON.parse(readFileSync(path.join(root, "test/company-kit/reviewed-findings.json"), "utf8"));
  let review, reviewError;
  if (args.includes("--reviewed-findings")) {
    try {
      const sorted = values => [...values].sort();
      const dpop = limits.dpopPrerequisite;
      for (const run of runs) {
        assert.equal(run.results.length, limits.catalogChecks, "Every pinned catalogue check must be reported");
        assert.equal(new Set(run.results.map(item => item.id)).size, limits.catalogChecks);
        const expectedFail = !withDpop && dpop.failureProfiles.includes(run.profile) ? [dpop.failureId] : [];
        const expectedWarn = !withDpop && dpop.warningProfiles.includes(run.profile) ? dpop.warningIds : [];
        const expectedSkip = limits.skips[run.profile === "hosted" ? "hosted" : "mock"];
        for (const [status, expected] of [["fail", expectedFail], ["warn", expectedWarn], ["skip", expectedSkip]]) {
          const actual = run.results.filter(item => item.status === status);
          assert.deepEqual(sorted(actual.map(item => item.id)), sorted(expected), `Review changed ${status} findings for ${run.profile}`);
          if (status !== "skip") for (const item of actual) {
            assert.equal(item.got, dpop.response, "A DPoP prerequisite finding changed");
            if (status === "warn") assert.equal(item.inconclusive, true, "Only the documented inconclusive warnings are reviewed");
          }
        }
      }
      const control = runs.find(run => run.profile === limits.positiveControlProfile);
      for (const id of [...dpop.warningIds, dpop.failureId]) assert.equal(control.results.find(item => item.id === id)?.status, "pass", `Missing accepted control for ${id}`);
      if (withDpop) for (const run of runs) for (const id of [...dpop.warningIds, dpop.failureId]) {
        if (!limits.skips[run.profile === "hosted" ? "hosted" : "mock"].includes(id)) assert.equal(run.results.find(item => item.id === id)?.status, "pass", `Missing DPoP-capable control for ${run.profile}/${id}`);
      }
      review = withDpop ? "The separately patched CLI supplies ES256 DPoP proofs. All applicable checks pass; only documented absent-feature skips remain. The pinned upstream source is unchanged." : "All upstream verdicts retained; only the documented DPoP prerequisite findings and explicit absent-feature skips remain. Accepted controls pass on the bearer profile.";
    } catch (error) { reviewError = error; }
  }
  const mockState = await mock.state();
  const hostedState = await (await localFetch(agent, `${companyOrigin}/__evidence`, { headers: { Authorization: `Bearer ${control}` } })).json();
  const effects = { mock: mockState.performs, hosted: hostedState.performs };
  assert.deepEqual(effects, { mock: 0, hosted: 0 }, "The signed-out kit must perform no Company action");
  const receipt = {
    archiveSha256: manifest.archiveSha256, source: manifest.source, upstreamFilesVerified: Object.keys(manifest.files).length,
    runtime: "local workerd through real HTTPS; certificate and hostname verified", validator: withDpop ? "separate temporary upstream copy with DPoP token-probe patch" : "unmodified upstream CLI",
    ...(withDpop ? { patchSha256: digest(readFileSync(dpopPatch)), dpopScope: "ES256 token proofs; nonce preflight uses an independent assertion before the tested controls" } : {}),
    identity: "fresh upstream-generated test identity, provisioned at the dummy Company's existing allowlisted client_id",
    privateAddressSetting: "upstream --allow-private-addresses; transport accepts declared local hosts only",
    liveHostingVerified: false, liveSignInVerified: false, authenticatedActionVerifiedByKit: false, companyEffects: effects,
    transportFailures: failures, ...(review ? { reviewedFindings: review } : {}),
    ...(withDpop ? { proofControls } : {}),
    ...(reviewError ? { reviewFailure: "An upstream verdict or expected control changed; inspect the raw runs." } : {}), runs
  };
  const serialized = JSON.stringify(receipt, null, 2);
  for (const file of ["private-key.jwk", "private-key-rsa.jwk"]) {
    const key = JSON.parse(readFileSync(path.join(directory, ".poppy", file), "utf8"));
    for (const field of ["d", "p", "q", "dp", "dq", "qi"]) if (typeof key[field] === "string") assert.ok(!serialized.includes(key[field]), "Private key material appeared in upstream output");
  }
  assert.deepEqual(failures, [], "Local transport must complete cleanly");
  writeFileSync(path.resolve(output), `${serialized}\n`, { mode: 0o600 });
  if (reviewError) throw reviewError;
  if (!review && runs.some(run => run.exitCode !== 0)) process.exitCode = 1;
} finally {
  if (agent) agent.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (runtime) await runtime.dispose();
  rmSync(directory, { recursive: true, force: true });
}
