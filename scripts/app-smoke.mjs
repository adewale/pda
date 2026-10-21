#!/usr/bin/env node
/** Real Chromium + built app + local workerd. Synthetic signed identity/model; no production auth bypass or external service. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { exportJWK, generateKeyPair } from "jose";
import puppeteer from "@cloudflare/puppeteer";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex < 0 ? null : args[outputIndex + 1];
if (outputIndex >= 0 && !output) throw new Error("--output needs a path");
const directory = mkdtempSync(path.join(tmpdir(), "pda-app-smoke-"));
let runtime;
let browser;
let child;
let activePage;
const failures = [];
const evidence = {};
try {
  if (output) rmSync(output, { force: true });
  if (!args.includes("--skip-build")) {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  }
  const workerDirectory = path.join(directory, "worker");
  execFileSync(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--config", "test/wrangler.jsonc", "--outdir", workerDirectory], {
    cwd: root, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }
  });
  const sessionModule = path.join(directory, "session.mjs");
  await build({ entryPoints: [path.join(root, "src/session.ts")], outfile: sessionModule, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  const { createSession } = await import(pathToFileURL(sessionModule).href);
  const config = JSON.parse(readFileSync(path.join(root, "test/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const keys = await Promise.all(["smoke-current", "smoke-next"].map(async kid => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    return { ...await exportJWK(privateKey), kid, alg: "ES256", use: "sig" };
  }));
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=agent.test", "-addext", "subjectAltName=DNS:agent.test"], { stdio: "ignore" });
  const spki = createHash("sha256").update(new X509Certificate(readFileSync(cert)).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: "pda-app-smoke", scriptPath: path.join(workerDirectory, "worker.js"), modulesRoot: workerDirectory, modules: true,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    host: "127.0.0.1", port: 0, https: true, httpsKey: readFileSync(key, "utf8"), httpsCert: readFileSync(cert, "utf8"),
    log: new Log(LogLevel.ERROR),
    bindings: { ...config.vars, POPPY_SIGNING_JWKS: JSON.stringify(keys), TOKEN_ENC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"), CF_VERSION_METADATA: { id: "local-browser-smoke" } },
    durableObjects: Object.fromEntries(config.durable_objects.bindings.map(binding => [binding.name, { className: binding.class_name, useSQLite: true }])),
    ratelimits: Object.fromEntries(config.ratelimits.map(binding => [binding.name, { namespace_id: binding.namespace_id, simple: binding.simple }])),
    assets: { directory: path.join(root, "dist/client"), binding: "ASSETS", routerConfig: { has_user_worker: true }, run_worker_first: ["/", "/activity", "/companies", "/settings", "/api/*", "/ws", "/logout", "/privacy"], assetConfig: { not_found_handling: "single-page-application" } },
    outboundService: async request => new URL(request.url).hostname === "agent.test" ? runtime.dispatchFetch(request) : new Response("No external network in app smoke", { status: 502 })
  }));
  const address = await runtime.ready;
  const chrome = process.env.PDA_ACCEPTANCE_CHROMIUM || "/usr/bin/chromium";
  child = spawn(chrome, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-proxy-server", "--disable-background-networking", "--disable-component-update", "--remote-debugging-port=0", `--user-data-dir=${path.join(directory, "chrome")}`, `--ignore-certificate-errors-spki-list=${spki}`, `--host-resolver-rules=MAP agent.test:443 127.0.0.1:${address.port}, MAP * ~NOTFOUND`], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error("Chromium startup timed out")), 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stderr.on("data", chunk => {
      data = (data + String(chunk)).slice(-8192);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/devtools\/browser\/[a-z0-9-]+)/.exec(data);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const anonymous = await browser.createBrowserContext();
  const signedOut = activePage = await anonymous.newPage();
  signedOut.on("pageerror", error => failures.push(error.name));
  await signedOut.goto("https://agent.test/", { waitUntil: "networkidle0" });
  await signedOut.waitForSelector('a[aria-label="Sign in with GitHub"]');
  assert.equal(await signedOut.evaluate(async () => (await fetch("/api/me")).status), 401);
  assert.match(await signedOut.title(), /Poppy/i);
  evidence.signedOutPage = true;
  await anonymous.close();
  const authenticated = await browser.createBrowserContext();
  const identity = { provider: "github", sub: "4141", email: "owner@example.com", domain: null };
  const signedCookie = await createSession(identity, config.vars.SESSION_SECRET);
  const token = signedCookie.split(";", 1)[0].slice("__Host-session=".length);
  const page = activePage = await authenticated.newPage();
  await page.setCookie({ name: "__Host-session", value: token, url: "https://agent.test/", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  const network = await page.target().createCDPSession();
  let websocketHandshakes = 0;
  network.on("Network.webSocketHandshakeResponseReceived", event => { if (event.response.status === 101) websocketHandshakes++; });
  await network.send("Network.enable");
  page.on("pageerror", error => failures.push(error.name));
  await page.goto("https://agent.test/", { waitUntil: "networkidle0" });
  await page.waitForSelector('textarea[aria-label="Message your agent"]');
  await page.waitForFunction(() => !document.body.innerText.includes("Connecting to your agent.") && !document.body.innerText.includes("Reconnecting to your agent."));
  evidence.authenticatedWorkspaceAndWebSocket = true;
  await page.type('textarea[aria-label="Message your agent"]', "App smoke hello");
  await page.click('button[aria-label="Send message"]');
  await page.waitForFunction(() => /echo:.*App smoke hello/s.test(document.body.innerText), { timeout: 20_000 });
  assert.ok(websocketHandshakes > 0, "Chat must use an actual accepted WebSocket");
  evidence.chatReply = true;
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => /echo:.*App smoke hello/s.test(document.body.innerText));
  evidence.chatSurvivesReload = true;
  for (const route of ["/settings", "/companies", "/activity"]) {
    await page.goto(`https://agent.test${route}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('nav[aria-label="Places"]');
    assert.equal(new URL(page.url()).pathname, route);
    const heading = { "/settings": "Settings", "/companies": "Companies", "/activity": "Activity" }[route];
    await page.waitForFunction(expected => [...document.querySelectorAll("h1")].some(element => element.textContent.trim() === expected), {}, heading);
    if (route === "/settings") assert.match(await page.$eval("body", element => element.innerText), /Memory/);
  }
  evidence.deepRoutes = true;
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto("https://agent.test/", { waitUntil: "networkidle0" });
  await page.waitForSelector('button[aria-label="Open navigation"]');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.click('button[aria-label="Open navigation"]');
  const mobileSettings = '[data-mobile="true"][data-state="expanded"] nav[aria-label="Places"] a[href="/settings"]';
  await page.waitForSelector(mobileSettings, { visible: true });
  await page.waitForFunction(selector => document.querySelector(selector)?.getBoundingClientRect().left >= 0, {}, mobileSettings);
  await page.click(mobileSettings);
  await page.waitForFunction(() => document.querySelector("h1")?.textContent.trim() === "Settings");
  await page.goto("https://agent.test/", { waitUntil: "networkidle0" });
  await page.waitForSelector('textarea[aria-label="Message your agent"]');
  evidence.mobileLayout = true;
  const screenshot = output ? `${output}.png` : path.join(directory, "app.png");
  writeFileSync(screenshot, Buffer.from(await page.screenshot({ type: "png", fullPage: true })));
  await page.type('textarea[aria-label="Message your agent"]', "Unsent draft stays in this tab");
  assert.equal(await page.evaluate(async () => (await fetch("/logout", { method: "POST" })).ok), true);
  await page.waitForFunction(() => document.body.innerText.includes("This connection no longer has access."));
  assert.equal(await page.$eval('textarea[aria-label="Message your agent"]', element => element.value), "Unsent draft stays in this tab");
  evidence.revokedSessionShowsRecoveryAndRetainsDraft = true;
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector('a[aria-label="Sign in with GitHub"]');
  evidence.logoutAndReloadSignsOut = true;
  evidence.uncaughtBrowserErrors = failures.length;
  assert.deepEqual(failures, []);
  const result = { ...evidence, runtime: "local workerd", assets: "production Vite build", builtThisRun: !args.includes("--skip-build"), model: "synthetic test provider", authentication: "production signed-cookie verifier with synthetic test identity", liveOAuthOrModelVerified: false };
  if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // All text and identities in this isolated runtime are synthetic fixtures.
  process.stderr.write(`${JSON.stringify({ evidence, browserErrors: failures, page: await activePage?.evaluate(() => document.body.innerText).catch(() => null) })}\n`);
  if (output && activePage) await activePage.screenshot({ type: "png", fullPage: true }).then(bytes => writeFileSync(`${output}.failure.png`, Buffer.from(bytes))).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(() => {});
  child?.kill("SIGKILL");
  await runtime?.dispose();
  rmSync(directory, { recursive: true, force: true });
}
