#!/usr/bin/env node
/** Read-only production preflight. It does not sign in, invoke a model or send a Company action. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

export async function checkLive({ origin, expectedCommit }, fetcher = fetch) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("--origin must be an HTTPS origin without credentials, path or query");
  const expected = expectedCommit;
  if (!expected || !/^[a-f0-9]{4,40}$/.test(expected)) throw new Error("--expected-commit must name the source revision you intend to verify");
  const checks = [];
  async function read(path, status) {
    const response = await fetcher(url.origin + path, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, status, path);
    checks.push({ path, status });
    return response;
  }
  const provenance = await (await read("/api/build-info", 200)).json();
  assert.match(provenance.commit ?? "", /^[a-f0-9]{4,40}$/, "Deployment must expose its source revision");
  assert.ok(expected.startsWith(provenance.commit) || provenance.commit.startsWith(expected), "Deployed source revision differs from --expected-commit");
  assert.equal(provenance.dirty, false, "A dirty source tree cannot establish the intended committed release");
  assert.equal(typeof provenance.workerVersion, "string", "Deployment must expose its Worker version");
  for (const path of ["/", "/about", "/about/ecosystem", "/privacy", "/validator"]) {
    const response = await read(path, 200);
    assert.ok(response.headers.get("Content-Security-Policy"), `${path} needs a page policy`);
    await response.body?.cancel();
  }
  const metadata = await (await read("/poppy/client.json", 200)).json();
  assert.equal(metadata.client_id, url.origin + "/poppy/client.json");
  const jwks = await (await read("/poppy/jwks.json", 200)).json();
  assert.ok(jwks.keys.length > 0 && jwks.keys.every(key => !("d" in key)), "JWKS must contain public keys only");
  const providers = await (await read("/api/sign-in-options", 200)).json();
  for (const provider of providers.providers) {
    assert.ok(["google", "github"].includes(provider));
    const response = await read(`/auth/${provider}`, 303);
    const destination = new URL(response.headers.get("Location"));
    assert.equal(destination.hostname, provider === "google" ? "accounts.google.com" : "github.com");
    assert.equal(destination.searchParams.get("redirect_uri"), `${url.origin}/auth/${provider}/callback`);
  }
  await (await read("/api/me", 401)).body?.cancel();
  await (await read("/api/agent-data", 401)).body?.cancel();
  return { checkedAt: new Date().toISOString(), origin: url.origin, provenance, checks, verification: "public HTTP only", authenticatedJourneyVerified: false, passed: true };
}

if (import.meta.main) {
  const options = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    const value = process.argv[i + 1];
    if (!["--origin", "--expected-commit", "--output"].includes(key) || !value) throw new Error("Usage: node scripts/check-live.mjs --origin https://your-host --expected-commit <sha> [--output receipt.json]");
    options.set(key, value);
  }
  const result = await checkLive({ origin: options.get("--origin"), expectedCommit: options.get("--expected-commit") });
  if (options.has("--output")) writeFileSync(options.get("--output"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
