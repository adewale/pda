#!/usr/bin/env node
/** Local workerd checks for the public hosted Company's routes and consent protections. No GitHub auth claim. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPair, exportJWK } from "jose";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";

const root = path.resolve(import.meta.dirname, "../..");
const directory = mkdtempSync(path.join(tmpdir(), "pda-hosted-security-"));
const companyOrigin = "https://company.test";
const pdaOrigin = "https://agent.test";
const clientId = `${pdaOrigin}/poppy/client.json`;
const password = crypto.randomUUID().replaceAll("-", "") + "-dummy-test-password";
const control = crypto.randomUUID().replaceAll("-", "") + "-dummy-control-key";
let runtime;
let unconfigured;
try {
  const config = JSON.parse(readFileSync(path.join(import.meta.dirname, "company.wrangler.jsonc"), "utf8"));
  config.main = path.join(import.meta.dirname, "company.ts");
  const configPath = path.join(directory, "wrangler.json");
  writeFileSync(configPath, JSON.stringify(config));
  const bundle = path.join(directory, "bundle");
  execFileSync(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--config", configPath, "--outdir", bundle], { cwd: root, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  const jwtFile = path.join(directory, "jwt.mjs");
  await build({ entryPoints: [path.join(root, "src/poppy/jwt.ts")], outfile: jwtFile, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  const { sha256, newDpopKey, dpopProof, clientAssertion, delegate, sessionJwt } = await import(pathToFileURL(jwtFile));
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...await exportJWK(publicKey), kid: "local-hosted-test", alg: "ES256", use: "sig" };
  const signing = { privateKey, publicJwk, kid: publicJwk.kid };
  const metadata = { client_id: clientId, client_name: "Local hosted security fixture", jwks_uri: `${pdaOrigin}/poppy/jwks.json`, redirect_uris: [`${pdaOrigin}/poppy/callback`], token_endpoint_auth_method: "private_key_jwt", extensions: { operations: { version: "2" } } };
  let externalFetches = 0;
  const options = bindings => convertV4MiniflareOptions({
    name: "hosted-company-security", scriptPath: path.join(bundle, "company.js"), modules: true, modulesRoot: bundle,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    durableObjects: { HOSTED_COMPANY: { className: "HostedCompany", useSQLite: true } },
    bindings, log: new Log(LogLevel.ERROR),
    outboundService: request => {
      externalFetches++;
      if (request.url === clientId) return Response.json(metadata);
      if (request.url === metadata.jwks_uri) return Response.json({ keys: [publicJwk] });
      return new Response("No external network in hosted local checks", { status: 502 });
    }
  });
  unconfigured = new Miniflare(options({ COMPANY_ORIGIN: companyOrigin, PDA_ORIGIN: pdaOrigin }));
  assert.equal((await unconfigured.dispatchFetch(`${companyOrigin}/.well-known/poppy.json`)).status, 503, "Missing consent/control secrets must fail closed");
  runtime = new Miniflare(options({ COMPANY_ORIGIN: companyOrigin, PDA_ORIGIN: pdaOrigin, COMPANY_PASSWORD: password, COMPANY_CONTROL_SECRET: control }));
  const fetch = (route, init) => runtime.dispatchFetch(`${companyOrigin}${route}`, init);
  const discovery = await (await fetch("/.well-known/poppy.json")).json();
  assert.equal(discovery.protocol_version, "0.3");
  assert.deepEqual(discovery.apis.map(api => api.url), [`${companyOrigin}/openapi.json`, `${companyOrigin}/mcp`]);
  const issuer = await (await fetch("/.well-known/oauth-authorization-server/issuer")).json();
  assert.equal(issuer.issuer, `${companyOrigin}/issuer`);
  assert.deepEqual(issuer.protected_resources, [companyOrigin, `${companyOrigin}/mcp`]);
  assert.equal((await (await fetch("/.well-known/oauth-protected-resource/mcp")).json()).resource, `${companyOrigin}/mcp`);
  assert.equal((await (await fetch("/openapi.json")).json()).servers[0].url, companyOrigin);
  assert.equal((await fetch("/__evidence")).status, 404);
  for (const route of ["/reset", "/arm", "/approve", "/control", "/violations"]) assert.equal((await fetch(route, { method: "POST" })).status, 404, "No administrative HTTP hook may be public");
  const refused = new URL(`${companyOrigin}/oauth/authorize`);
  refused.searchParams.set("client_id", "https://unaccepted.test/client.json");
  assert.equal((await runtime.dispatchFetch(refused)).status, 403);
  assert.equal(externalFetches, 0, "An unaccepted client must be refused before metadata fetch");
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const authorization = new URL(`${companyOrigin}/oauth/authorize`);
  for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: metadata.redirect_uris[0], response_type: "code", scope: "orders:read orders:write", state: "local-security-state", code_challenge_method: "S256", code_challenge: await sha256(verifier) })) authorization.searchParams.set(key, value);
  const consent = await runtime.dispatchFetch(authorization);
  assert.equal(consent.status, 200);
  assert.match(consent.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.ok(consent.headers.get("Content-Security-Policy").includes(`form-action 'self' ${pdaOrigin};`), "Chromium must be able to follow the approved OAuth redirect to the configured PDA");
  const html = await consent.text();
  const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  const decide = (origin, nonce, suppliedPassword) => fetch("/oauth/decision", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: nonce, password: suppliedPassword, decision: "approve" }).toString(), redirect: "manual" });
  assert.equal((await decide("https://unaccepted.test", csrf, password)).status, 403, "Cross-origin consent must be refused");
  assert.equal((await decide(companyOrigin, "invented-csrf", password)).status, 403, "Invented CSRF must be refused");
  assert.equal((await decide(companyOrigin, csrf, "incorrect-password")).status, 403, "Real password verification is required");
  const concurrent = await Promise.all([decide(companyOrigin, csrf, password), decide(companyOrigin, csrf, password)]);
  assert.equal(concurrent.filter(response => response.status === 303).length, 1, "One User consent must issue only one authorization response");
  assert.ok(concurrent.some(response => [403, 409].includes(response.status)), "A simultaneous replay must be refused");
  const callback = new URL(concurrent.find(response => response.status === 303).headers.get("Location"));
  assert.equal(callback.origin, pdaOrigin);
  assert.equal(callback.searchParams.get("state"), "local-security-state");
  assert.equal(callback.searchParams.get("iss"), `${companyOrigin}/issuer`);
  assert.ok(callback.searchParams.get("code"));
  const dpop = await newDpopKey();
  let nonce;
  let token;
  for (let attempt = 0; attempt < 2; attempt++) {
    const form = new URLSearchParams({ client_id: clientId, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await clientAssertion(signing, clientId, issuer.issuer), grant_type: "authorization_code", code: callback.searchParams.get("code"), redirect_uri: metadata.redirect_uris[0], code_verifier: verifier });
    const response = await fetch("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: await dpopProof(dpop, { method: "POST", url: issuer.token_endpoint, ...(nonce ? { nonce } : {}) }) }, body: form.toString() });
    nonce = response.headers.get("DPoP-Nonce") ?? nonce;
    if (response.status === 200) { token = await response.json(); break; }
    assert.ok(nonce, "The only retry is a strict nonce challenge");
  }
  assert.ok(token?.access_token && token?.refresh_token, "Real strict authorization code/PKCE/client assertion/DPoP exchange must succeed");
  const delegated = await delegate(signing, clientId, await newDpopKey());
  const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const sid = crypto.randomUUID();
  const resource = async (route, payload, extras = {}) => {
    const method = payload ? "POST" : "GET";
    const url = `${companyOrigin}${route}`;
    return fetch(route, {
      method, headers: {
        Authorization: `DPoP ${token.access_token}`,
        DPoP: await dpopProof(dpop, { method, url, accessToken: token.access_token, nonce }),
        "Poppy-Session": await sessionJwt(delegated, { clientId, issuer: issuer.issuer, sid, userId, method, url, accessToken: token.access_token }),
        ...(payload ? { "Content-Type": "application/json" } : {}), ...extras
      }, ...(payload ? { body: JSON.stringify(payload) } : {})
    });
  };
  const orders = await resource("/orders");
  assert.equal(orders.status, 200, "The single-origin API must verify the actual delegated Session and DPoP token");
  const exchange = { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" };
  const proposed = await resource("/orders/ord_7Hk2/exchanges", exchange, { "Idempotency-Key": crypto.randomUUID() });
  assert.equal(proposed.status, 403);
  const operation = (await proposed.json()).operation;
  assert.ok(operation?.operation_id && operation?.revision);
  const approved = await resource("/orders/ord_7Hk2/exchanges", exchange, { "Idempotency-Key": crypto.randomUUID(), "Poppy-Approval": `operation_id="${operation.operation_id}", revision="${operation.revision}"` });
  assert.equal(approved.status, 201, "The approved single-origin strict dummy action must execute");
  const mcp = await fetch("/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Poppy-Session": await sessionJwt(delegated, { clientId, issuer: issuer.issuer, sid: crypto.randomUUID(), userId, method: "POST", url: `${companyOrigin}/mcp` }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hosted-local-check", version: "1" } } })
  });
  assert.equal(mcp.status, 200);
  assert.ok(mcp.headers.get("Mcp-Session-Id"), "MCP shares the origin while keeping its own service path");
  const evidence = await fetch("/__evidence", { headers: { Authorization: `Bearer ${control}` } });
  assert.equal(evidence.status, 200);
  const counters = await evidence.json();
  assert.deepEqual(Object.keys(counters).sort(), ["instanceId", "performs", "requests", "startedAt", "violations", "warnings"]);
  assert.equal(counters.violations, 0);
  assert.equal(counters.warnings, 0);
  assert.equal(counters.performs, 1);
  assert.ok(!JSON.stringify(counters).includes(password) && !JSON.stringify(counters).includes(control));
  // A bounded fixture checks the read-only live verifier's failure path; it never authenticates a PDA User.
  const replyFile = path.join(directory, "counter-reply.json");
  const validationPrivateProbe = "private-value-must-not-be-printed";
  const privateSettings = path.join(directory, "private-settings.json");
  for (const invalid of [{ pdaOrigin: `https://username:${validationPrivateProbe}@pda-hosted-private-check.example` }, { accountId: validationPrivateProbe }]) {
    writeFileSync(privateSettings, JSON.stringify({ label: "private-check", accountId: "0".repeat(32),
      pdaOrigin: "https://pda-hosted-private-check.example", companyOrigin: "https://pda-dummy-private-check.example",
      githubLogin: "test-owner", githubNumericId: 1, githubClientId: "test-client", githubClientSecret: "test-oauth-private",
      privacyContact: "privacy@example.com", ...invalid }), { mode: 0o600 });
    const refused = spawnSync(process.execPath, [path.join(root, "scripts/hosted-prepare.mjs"), "--settings", privateSettings, "--prepare-only"], { cwd: root, encoding: "utf8" });
    assert.equal(refused.status, 1, "Private malformed settings must be refused");
    assert.equal(refused.stdout, "");
    assert.ok(!refused.stderr.includes(validationPrivateProbe), "Preparation errors must not print private input values");
  }
  const networkFixture = path.join(directory, "counter-network.mjs");
  writeFileSync(networkFixture, `import { readFileSync } from "node:fs"; globalThis.fetch = async () => Response.json(JSON.parse(readFileSync(${JSON.stringify(replyFile)}, "utf8")));\n`, { mode: 0o600 });
  for (const [name, value] of [["manifest.json", { companyOrigin }], ["company.secrets.json", { COMPANY_CONTROL_SECRET: control }]]) writeFileSync(path.join(directory, name), JSON.stringify(value), { mode: 0o600 });
  const check = (mode, reply) => {
    writeFileSync(replyFile, JSON.stringify(reply), { mode: 0o600 });
    return spawnSync(process.execPath, ["--import", networkFixture, path.join(root, "scripts/hosted-check.mjs"), mode, directory, "1"], { cwd: root, encoding: "utf8" });
  };
  assert.equal(check("start", { ...counters, performs: 0 }).status, 0);
  const changed = check("finish", { ...counters, instanceId: crypto.randomUUID() });
  assert.equal(changed.status, 1, "Live verification must fail when the Company instance changes");
  assert.match(changed.stderr, /instance changed/);
  assert.equal(check("finish", counters).status, 0);
  process.stdout.write(`${JSON.stringify({ runtime: "local workerd", hostedCompanyUploadDryRun: true, missingSecretsFailClosed: true, singleOriginDiscoveryAndServices: true, publicAdministrativeHooksAbsent: true, unacceptedClientRefusedBeforeFetch: true, realPasswordAndCsrfRequired: true, simultaneousConsentSingleUse: true, strictAuthorizationCodePkceAssertionDpop: true, delegatedSessionApiTermsAndApprovedDummyAction: true, signedOutMcpInitialization: true, protectedBoundedCountersOnly: true, liveVerifierRejectsInstanceChange: true, privatePreparationErrorsRedacted: true, strictViolations: counters.violations, strictWarnings: counters.warnings, liveGitHubOAuthVerified: false })}\n`);
} finally {
  await runtime?.dispose();
  await unconfigured?.dispose();
  rmSync(directory, { recursive: true, force: true });
}
