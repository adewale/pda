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
import { approvalJourneys } from "./app-approval-journey.mjs";
import { photoJourneys } from "./app-photo-journey.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex < 0 ? null : args[outputIndex + 1];
if (outputIndex >= 0 && !output) throw new Error("--output needs a path");
if (args.includes("--baseline-photo-consent") && !args.includes("--photo-journey")) throw new Error("--baseline-photo-consent is only for the historical photo evidence run");
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
  let workerConfig = "test/wrangler.jsonc";
  let workerEntry = "worker.js";
  if (args.includes("--approval-journey") || args.includes("--photo-journey")) {
    const fixtureConfig = JSON.parse(readFileSync(path.join(root, workerConfig), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    fixtureConfig.main = path.join(root, "test/browser/approval-journey-worker.ts");
    workerEntry = "approval-journey-worker.js";
    workerConfig = path.join(directory, "wrangler.json");
    writeFileSync(workerConfig, JSON.stringify(fixtureConfig));
  }
  execFileSync(process.execPath, [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--config", workerConfig, "--outdir", workerDirectory], {
    cwd: root, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" }
  });
  const sessionModule = path.join(directory, "session.mjs");
  await build({ entryPoints: [path.join(root, "src/session.ts")], outfile: sessionModule, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  const { createSession, agentNameFor } = await import(pathToFileURL(sessionModule).href);
  const config = JSON.parse(readFileSync(path.join(root, "test/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const assets = JSON.parse(readFileSync(path.join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "")).assets;
  const keys = await Promise.all(["smoke-current", "smoke-next"].map(async kid => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    return { ...await exportJWK(privateKey), kid, alg: "ES256", use: "sig" };
  }));
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=agent.test", "-addext", "subjectAltName=DNS:agent.test"], { stdio: "ignore" });
  const spki = createHash("sha256").update(new X509Certificate(readFileSync(cert)).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: "pda-app-smoke", scriptPath: path.join(workerDirectory, workerEntry), modulesRoot: workerDirectory, modules: true,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    host: "127.0.0.1", port: 0, https: true, httpsKey: readFileSync(key, "utf8"), httpsCert: readFileSync(cert, "utf8"),
    log: new Log(LogLevel.ERROR),
    bindings: { ...config.vars, POPPY_SIGNING_JWKS: JSON.stringify(keys), TOKEN_ENC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"), CF_VERSION_METADATA: { id: "local-browser-smoke" } },
    durableObjects: Object.fromEntries(config.durable_objects.bindings.map(binding => [binding.name, { className: binding.class_name, useSQLite: true }])),
    ratelimits: Object.fromEntries(config.ratelimits.map(binding => [binding.name, { namespace_id: binding.namespace_id, simple: binding.simple }])),
    assets: { directory: path.join(root, "dist/client"), binding: assets.binding, routerConfig: { has_user_worker: true }, run_worker_first: assets.run_worker_first, assetConfig: { not_found_handling: assets.not_found_handling } },
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
  await signedOut.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  evidence.colorScheme = "light";
  if (args.includes("--ecosystem-viewport")) await signedOut.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  signedOut.on("pageerror", error => failures.push(error.name));
  await signedOut.goto("https://agent.test/", { waitUntil: "networkidle0" });
  await signedOut.waitForSelector('a[aria-label="Sign in with GitHub"]');
  assert.equal(await signedOut.evaluate(async () => (await fetch("/api/me")).status), 401);
  assert.match(await signedOut.title(), /Poppy/i);
  evidence.signedOutPage = true;
  assert.equal(await signedOut.$('a[href="/about/ecosystem"]'), null);
  const publicRequests = [];
  signedOut.on("request", request => {
    if (/^\/(api\/|ws(?:$|\?))/.test(new URL(request.url()).pathname)) publicRequests.push(request.url());
  });
  await Promise.all([signedOut.waitForNavigation({ waitUntil: "networkidle0" }), signedOut.click('a[href="/about"]')]);
  await signedOut.waitForSelector('a[href="/about/ecosystem"]');
  assert.equal(await signedOut.title(), "About · Poppy Demo Agent");
  assert.ok(await signedOut.$('a[href="/validator"]'));
  assert.ok(await signedOut.$('a[href^="https://github.com/"]'));
  if (output) writeFileSync(`${output}.about.png`, Buffer.from(await signedOut.screenshot({ fullPage: true })));
  await Promise.all([signedOut.waitForNavigation({ waitUntil: "networkidle0" }), signedOut.click('a[href="/about/ecosystem"]')]);
  await signedOut.waitForSelector(".ecosystem-table");
  assert.equal(new URL(signedOut.url()).pathname, "/about/ecosystem");
  assert.equal(await signedOut.$eval('nav[aria-label="Breadcrumb"] a', element => element.getAttribute("href")), "/about");
  assert.equal(await signedOut.$eval("details", element => element.open), false);
  if (output) writeFileSync(`${output}.ecosystem.png`, Buffer.from(await signedOut.screenshot({ fullPage: !args.includes("--ecosystem-viewport") })));
  await signedOut.setViewport({ width: 375, height: 812, deviceScaleFactor: 1 });
  assert.equal(await signedOut.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await signedOut.$eval(".ecosystem-table", element => element.scrollWidth > element.clientWidth), true);
  if (output) writeFileSync(`${output}.ecosystem-mobile.png`, Buffer.from(await signedOut.screenshot({ fullPage: false })));
  await signedOut.setViewport({ width: 812, height: 375, deviceScaleFactor: 1 });
  assert.equal(await signedOut.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (output) writeFileSync(`${output}.ecosystem-landscape.png`, Buffer.from(await signedOut.screenshot({ fullPage: false })));
  await signedOut.click('a[href="#scorecard"]');
  await signedOut.waitForSelector("details[open] #scorecard");
  assert.equal(await signedOut.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await signedOut.reload({ waitUntil: "networkidle0" });
  await signedOut.waitForSelector("details[open] #scorecard");
  const brokenSections = await signedOut.$$eval('a[href^="#"]', links => links
    .map(link => link.getAttribute("href"))
    .filter(href => href.length > 1 && !document.getElementById(decodeURIComponent(href.slice(1)))));
  assert.deepEqual(brokenSections, [], "Every in-page section link must have a target");
  assert.deepEqual(publicRequests, []);
  await signedOut.goto("https://agent.test/about/ecosystem/", { waitUntil: "networkidle0" });
  await signedOut.waitForSelector(".ecosystem-table");
  assert.deepEqual(publicRequests, []);
  await signedOut.click('nav[aria-label="Breadcrumb"] a');
  await signedOut.waitForFunction(() => document.querySelector("h1")?.textContent === "About Poppy Demo Agent");
  assert.equal(new URL(signedOut.url()).pathname, "/about");
  const publicLinks = await signedOut.$$eval('a[href^="/"]', links => [...new Set(links.map(link => link.getAttribute("href")))]);
  for (const link of [...publicLinks, "/validator/messages"]) {
    assert.equal(await signedOut.evaluate(async href => (await fetch(href)).status, link), 200, `Public link ${link}`);
  }
  assert.deepEqual(publicRequests, []);
  evidence.publicAboutAndEcosystem = true;
  evidence.publicPagesNeedNoIdentityOrSocket = true;
  evidence.ecosystemMobileTablesAndDeepLinks = true;
  evidence.ecosystemMobileLandscape = true;
  evidence.publicLinksAndSectionTargets = true;
  const retired = activePage = await anonymous.newPage();
  await retired.goto("https://agent.test/ecosystem", { waitUntil: "networkidle0" });
  await retired.waitForSelector('a[aria-label="Sign in with GitHub"]');
  assert.equal(new URL(retired.url()).pathname, "/ecosystem");
  assert.equal(await retired.$(".ecosystem-table"), null);
  evidence.oldEcosystemPathHasNoPageOrRedirect = true;
  await signedOut.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await signedOut.goto("https://agent.test/privacy", { waitUntil: "networkidle0" });
  await signedOut.waitForSelector("main h1");
  assert.equal(await signedOut.$eval("h1", element => element.textContent), "Privacy policy");
  if (output) writeFileSync(`${output}.privacy-desktop.png`, Buffer.from(await signedOut.screenshot({ fullPage: true })));
  await signedOut.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  assert.equal(await signedOut.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (output) writeFileSync(`${output}.privacy-mobile.png`, Buffer.from(await signedOut.screenshot({ fullPage: true })));
  evidence.privacyPolicyDesktopAndMobile = true;
  await anonymous.close();
  const authenticated = await browser.createBrowserContext();
  const identity = { provider: "github", sub: "4141", email: "owner@example.com", domain: null };
  const signedCookie = await createSession(identity, config.vars.SESSION_SECRET);
  const token = signedCookie.split(";", 1)[0].slice("__Host-session=".length);
  const page = activePage = await authenticated.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
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
  if (args.includes("--approval-journey")) {
    evidence.companyApprovalJourneys = await approvalJourneys({ runtime, page, network, agentName: await agentNameFor(identity), cookie: signedCookie.split(";", 1)[0], output });
  }
  if (args.includes("--photo-journey")) {
    evidence.photoJourneys = await photoJourneys({ runtime, page, network, agentName: await agentNameFor(identity), output, baselineConsent: args.includes("--baseline-photo-consent"), negativeControl: args.includes("--photo-negative-control") });
  }
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
