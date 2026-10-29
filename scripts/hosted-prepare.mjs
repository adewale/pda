#!/usr/bin/env node
/** Prepare an isolated pair and dry-run both uploads. This script never deploys or prints secrets. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { PrivateInputError, readPrivateJson as privateRead, writePrivateJson as secureWrite, privateErrorMessage } from "./private-files.mjs";
import { exportJWK, generateKeyPair, importJWK } from "jose";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const settingsIndex = args.indexOf("--settings");
const settingsPath = path.resolve(settingsIndex < 0 ? path.join(root, "test/hosted/settings.local.json") : args[settingsIndex + 1] ?? "");
const prepareOnly = args.includes("--prepare-only");
const run = (command, values, options = {}) => {
  const result = spawnSync(command, values, { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, ...options });
  if (result.status !== 0) throw new PrivateInputError(`${path.basename(command)} ${values[0] ?? ""} failed (${result.status}); inspect the local command without printing secrets`);
  return result.stdout ?? "";
};
const json = file => JSON.parse(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, ""));
const validOrigin = value => {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", "Origins must use HTTPS");
  assert.equal(url.origin, value, "Origins must have no path, credentials or trailing slash");
  assert.ok(!url.username && !url.password && !url.port, "Origins must be public HTTPS origins");
  return url;
};
try {
  const settings = privateRead(settingsPath);
  assert.match(settings.label, /^[a-z0-9][a-z0-9-]{2,30}$/, "Set an isolated run label");
  assert.match(settings.accountId, /^[a-f0-9]{32}$/, "Set Cloudflare accountId");
  const pda = validOrigin(settings.pdaOrigin);
  const company = validOrigin(settings.companyOrigin);
  assert.notEqual(pda.origin, company.origin, "PDA and Company need separate origins");
  assert.match(settings.githubLogin, /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/, "Set the GitHub login");
  assert.ok(Number.isSafeInteger(settings.githubNumericId) && settings.githubNumericId > 0, "Set the matching numeric GitHub account ID");
  for (const name of ["githubClientId", "githubClientSecret", "privacyContact"]) assert.ok(typeof settings[name] === "string" && settings[name].trim().length >= 3, `Set ${name}`);
  const pdaName = `pda-hosted-${settings.label}`;
  const companyName = `pda-dummy-${settings.label}`;
  for (const [url, name] of [[pda, pdaName], [company, companyName]]) {
    assert.ok(url.hostname.split(".")[0] === name && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname), "Use the isolated Worker's workers.dev HTTPS origin");
  }
  assert.equal(pda.hostname.split(".").slice(1).join("."), company.hostname.split(".").slice(1).join("."), "Both test Workers must belong to the selected account's Workers subdomain");
  const output = path.join(root, "test/hosted/local", settings.label);
  run("git", ["check-ignore", "--quiet", path.relative(root, path.join(output, "pda.secrets.json"))]);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  chmodSync(output, 0o700);
  const manifest = { label: settings.label, accountId: settings.accountId, pdaName, companyName, pdaOrigin: pda.origin, companyOrigin: company.origin, githubNumericId: settings.githubNumericId };
  const manifestPath = path.join(output, "manifest.json");
  if (existsSync(manifestPath) && JSON.stringify(privateRead(manifestPath)) !== JSON.stringify(manifest)) throw new PrivateInputError("Use a new label rather than rebinding an existing test namespace");
  const pdaSecretPath = path.join(output, "pda.secrets.json");
  const companySecretPath = path.join(output, "company.secrets.json");
  if (!existsSync(pdaSecretPath)) {
    const keys = [];
    for (const kid of ["hosted-current", "hosted-next"]) {
      const { privateKey } = await generateKeyPair("ES256", { extractable: true });
      keys.push({ ...await exportJWK(privateKey), kid, alg: "ES256", use: "sig" });
    }
    secureWrite(pdaSecretPath, { SESSION_SECRET: randomBytes(48).toString("base64url"), TOKEN_ENC_KEY: randomBytes(32).toString("base64"), POPPY_SIGNING_JWKS: JSON.stringify(keys), GITHUB_CLIENT_ID: settings.githubClientId, GITHUB_CLIENT_SECRET: settings.githubClientSecret });
  }
  const existingPda = privateRead(pdaSecretPath);
  if (existingPda.GITHUB_CLIENT_ID !== settings.githubClientId || existingPda.GITHUB_CLIENT_SECRET !== settings.githubClientSecret) throw new PrivateInputError("Existing OAuth application or secret differs: use a new label");
  if (typeof existingPda.SESSION_SECRET !== "string" || existingPda.SESSION_SECRET.length < 32 || Buffer.from(existingPda.TOKEN_ENC_KEY ?? "", "base64").length !== 32) throw new PrivateInputError("PDA session/encryption keys are missing or invalid");
  try {
    const keys = JSON.parse(existingPda.POPPY_SIGNING_JWKS);
    if (!Array.isArray(keys) || keys.length < 2) throw new PrivateInputError();
    for (const key of keys) { if (!key.d || !key.kid) throw new PrivateInputError(); await importJWK(key, "ES256"); }
  } catch { throw new PrivateInputError("PDA signing keys are missing or invalid"); }
  if (!existsSync(companySecretPath)) secureWrite(companySecretPath, { COMPANY_PASSWORD: randomBytes(32).toString("base64url"), COMPANY_CONTROL_SECRET: randomBytes(32).toString("base64url") });
  const companySecrets = privateRead(companySecretPath);
  if (![companySecrets.COMPANY_PASSWORD, companySecrets.COMPANY_CONTROL_SECRET].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value)) || companySecrets.COMPANY_PASSWORD === companySecrets.COMPANY_CONTROL_SECRET) throw new PrivateInputError("Company consent/control secrets are missing or invalid");
  const pdaConfig = json(path.join(root, "test/hosted/pda.wrangler.jsonc"));
  pdaConfig.name = pdaName;
  pdaConfig.account_id = settings.accountId;
  pdaConfig.main = path.join(root, "src/index.ts");
  pdaConfig.assets.directory = path.join(output, "client");
  Object.assign(pdaConfig.vars, { PUBLIC_ORIGIN: pda.origin, POPPY_LOGO_URI: `${pda.origin}/logo.svg`, PRIVACY_CONTACT: settings.privacyContact, OWNERS: { emails: [], github: { [settings.githubLogin]: settings.githubNumericId } } });
  const companyConfig = json(path.join(root, "test/hosted/company.wrangler.jsonc"));
  companyConfig.name = companyName;
  companyConfig.account_id = settings.accountId;
  companyConfig.main = path.join(root, "test/hosted/company.ts");
  companyConfig.vars = { COMPANY_ORIGIN: company.origin, PDA_ORIGIN: pda.origin };
  secureWrite(path.join(output, "pda.wrangler.json"), pdaConfig);
  secureWrite(path.join(output, "company.wrangler.json"), companyConfig);
  secureWrite(manifestPath, manifest);
  if (!prepareOnly) {
    run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--config", "test/hosted/vite.config.mjs", "--outDir", path.join(output, "client")]);
    for (const target of ["pda", "company"]) run(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--config", path.join(output, `${target}.wrangler.json`), "--outdir", path.join(output, `${target}-bundle`)]);
  }
  process.stdout.write(`Prepared isolated files in ${path.relative(root, output)}. ${prepareOnly ? "Build/upload dry-runs skipped." : "Both upload dry-runs passed."} Nothing was deployed; secrets were not printed.\n`);
} catch (error) {
  process.stderr.write(`hosted-prepare: ${privateErrorMessage(error, "Preparation failed; check the private inputs and local command")}\n`);
  process.exitCode = 1;
}
