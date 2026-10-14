#!/usr/bin/env node
// The interop live lane's identity (docs/interop-spec.md §10): an ES256 key
// for the interop test client the deployed Worker publishes at
// <PUBLIC_ORIGIN>/poppy/interop/client.json.
//
//   node scripts/interop-live-identity.mjs [--origin https://…] [--new]
//
// The first run makes a key and writes it, with the client_id, to
// interop/.live-identity.json (git ignores it; mode 600). Every run prints
// the PUBLIC key set to stdout, for INTEROP_LIVE_JWKS in deployment.local.json.
// The private key is never printed: it stays in that file, and the runner
// gives it only to our own agent's container in the live lane. `--new`
// replaces the key; deploy the new public key set before the next live run.
// The origin is `--origin`, or PUBLIC_ORIGIN from deployment.local.json.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { exportJWK, generateKeyPair } from "jose";

const root = path.resolve(import.meta.dirname, "..");
const local = path.join(root, "deployment.local.json");

function fail(message) {
  process.stderr.write(`interop-live-identity: ${message}\n`);
  process.exit(1);
}

function httpsOrigin(value, from) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${from} isn't a URL`);
  }
  const origin = value.replace(/\/+$/, "");
  if (url.protocol !== "https:" || url.origin !== origin) fail(`${from} must be an https:// origin with no path`);
  return origin;
}

const { values } = parseArgs({
  options: { origin: { type: "string" }, new: { type: "boolean", default: false }, file: { type: "string" } },
  strict: true
});
// `--file` is for the harness's own tests; the runner reads only the default.
const file = values.file ? path.resolve(values.file) : path.join(root, "interop", ".live-identity.json");
const shown = path.relative(root, file);

let origin;
if (values.origin) origin = httpsOrigin(values.origin, "--origin");
else if (existsSync(local)) {
  const configured = JSON.parse(readFileSync(local, "utf8")).PUBLIC_ORIGIN;
  if (typeof configured === "string" && configured !== "") origin = httpsOrigin(configured, "PUBLIC_ORIGIN in deployment.local.json");
}

let identity = existsSync(file) && !values.new ? JSON.parse(readFileSync(file, "utf8")) : null;
if (identity) {
  if (origin && identity.client_id !== `${origin}/poppy/interop/client.json`) {
    const message = `${shown} is for ${identity.client_id}, not ${origin}; run with --new to make one for ${origin}`;
    // A conflicting --origin is refused; one read from deployment.local.json only warns, so a rerun reprints the key it has.
    if (values.origin) fail(message);
    process.stderr.write(`interop-live-identity: warning: ${message}\n`);
  }
} else {
  if (!origin) fail("no origin: pass --origin https://<your deployment>, or set PUBLIC_ORIGIN in deployment.local.json");
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const { kty, crv, x, y, d } = await exportJWK(privateKey);
  const kid = `interop-${new Date().toISOString().slice(0, 10)}`;
  identity = { version: 1, client_id: `${origin}/poppy/interop/client.json`, key: { kty, crv, x, y, d, kid, alg: "ES256", use: "sig" } };
  writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  process.stderr.write(`interop-live-identity: wrote a new key to ${shown} (keep it private; git ignores the default file)\n`);
}

const { kty, crv, x, y, kid } = identity.key;
process.stdout.write(`${JSON.stringify({ keys: [{ kty, crv, x, y, kid, alg: "ES256", use: "sig" }] })}\n`);
process.stderr.write(
  [
    `interop-live-identity: client_id ${identity.client_id}`,
    "Set INTEROP_LIVE_JWKS in deployment.local.json to the key set on stdout, then run `npm run deploy`.",
    ""
  ].join("\n")
);
