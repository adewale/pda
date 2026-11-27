#!/usr/bin/env node
/**
 * Captures this folder's screenshots: the fixture in `fixture.tsx`, served by
 * Vite from the production components and styles of the checkout at
 * `--root` (this repository by default), in headless Chromium, and measures
 * how far each page overflows its width.
 *
 *   node docs/evidence/app-long-values/capture.mjs --out <dir> [--root <checkout>] [--prefix after-]
 *
 * For the "before" images, check out the base commit elsewhere, copy this
 * folder into it at the same path, link its node_modules, and pass that
 * checkout as --root. Every Company is a fixture, so nothing is fetched.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const root = path.resolve(args.root ?? path.join(import.meta.dirname, "../../.."));
const out = path.resolve(args.out ?? path.join(import.meta.dirname, "out"));
const prefix = args.prefix ?? "";
const chrome = process.env.EVIDENCE_CHROMIUM ?? "/opt/pw-browsers/chromium";
const require = createRequire(path.join(root, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const { default: puppeteer } = await import(require.resolve("@cloudflare/puppeteer"));

const SHOTS = [
  { name: "notices-phone", scene: "notices", path: "/", width: 390, height: 1100 },
  { name: "notices-desktop", scene: "notices", path: "/", width: 1280, height: 900 },
  { name: "protocol-phone", scene: "protocol", path: `/activity?company=print.example&`, width: 390, height: 1100 },
  { name: "protocol-desktop", scene: "protocol", path: `/activity?company=print.example&`, width: 1280, height: 900 }
];

const work = mkdtempSync(path.join(tmpdir(), "app-long-values-"));
const server = await createServer({ configFile: path.join(root, "docs/evidence/app-long-values/vite.config.ts"), logLevel: "error", server: { port: 5198, host: "127.0.0.1" } });
await server.listen();
const child = spawn(chrome, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-proxy-server", "--hide-scrollbars", "--font-render-hinting=none", "--remote-debugging-port=0", `--user-data-dir=${path.join(work, "chrome")}`], { stdio: ["ignore", "ignore", "pipe"] });
const endpoint = await new Promise((resolve, reject) => {
  let data = "";
  const timer = setTimeout(() => reject(new Error("Chromium startup timed out")), 15_000);
  child.stderr.on("data", (chunk) => {
    data = (data + String(chunk)).slice(-8192);
    const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-z0-9-]+)/.exec(data);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
});
const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
mkdirSync(out, { recursive: true });
const artifacts = [];
try {
  for (const shot of SHOTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: shot.width, height: shot.height, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/entitlement") {
        return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ lane: "own_key", reason: null, key: { provider: "anthropic", status: "valid" }, demo: null, model: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" } }) });
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/poppy/")) return request.respond({ status: 404, body: "" });
      if (url.origin !== "http://127.0.0.1:5198") return request.abort();
      return request.continue();
    });
    await page.goto(`http://127.0.0.1:5198${shot.path}${shot.path.includes("?") ? "" : "?"}scene=${shot.scene}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // How far anything reaches past the viewport, and the widest element that does: what a reader would scroll sideways to see.
    const overflow = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      let widest = 0;
      for (const element of document.querySelectorAll("body *")) {
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.right > width + 1) widest = Math.max(widest, Math.round(box.right - width));
      }
      return { page: Math.max(0, document.documentElement.scrollWidth - width), element: widest };
    });
    const file = path.join(out, `${prefix}${shot.name}.png`);
    // Cloudflare's Puppeteer can't write files itself: it returns the bytes.
    const bytes = Buffer.from(await page.screenshot({ type: "png", fullPage: true }));
    writeFileSync(file, bytes);
    artifacts.push({ path: path.basename(file), scene: shot.scene, viewport: `${shot.width}×${shot.height}`, overflow, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    console.log(`${path.basename(file)}: overflow page ${overflow.page} px, element ${overflow.element} px`);
    await page.close();
  }
} finally {
  await browser.disconnect();
  // Chromium writes to its profile as it exits, so wait for it before removing the profile.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
  await server.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: root }).toString().trim() !== "";
writeFileSync(path.join(out, `${prefix}receipt.json`), `${JSON.stringify({ source_sha: commit, source_has_uncommitted_changes_in_src: dirty, browser: execFileSync(chrome, ["--version"]).toString().trim(), fixture: "docs/evidence/app-long-values/fixture.tsx", artifacts }, null, 2)}\n`);
