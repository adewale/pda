#!/usr/bin/env node
/**
 * Captures this folder's screenshots: the fixture in `fixture.tsx`, served by
 * Vite from the production components and styles of the checkout at
 * `--root` (this repository by default), in headless Chromium.
 *
 *   node docs/evidence/chat-review/capture.mjs --out <dir> [--root <checkout>]
 *
 * For the "before" images, check out the base commit elsewhere, copy this
 * folder into it at the same path, link its node_modules, and pass that
 * checkout as --root. The photos are ffmpeg test patterns made here; the
 * agent, its socket and every Company are fixtures, so nothing is fetched.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const root = path.resolve(args.root ?? path.join(import.meta.dirname, "../../.."));
const out = path.resolve(args.out ?? path.join(import.meta.dirname, "out"));
const chrome = process.env.EVIDENCE_CHROMIUM ?? "/opt/pw-browsers/chromium";
const require = createRequire(path.join(root, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const { default: puppeteer } = await import(require.resolve("@cloudflare/puppeteer"));

/** The fixture's photos, as ffmpeg test patterns: one per name in fixture.tsx, the eighth a GIF. */
const PATTERNS = ["smptehdbars", "gradients=seed=3", "mandelbrot", "testsrc2", "rgbtestsrc", "gradients=seed=8:type=radial", "gradients=seed=11:type=circular", "life=seed=7:mold=10", "sierpinski=seed=2", "yuvtestsrc"];
const work = mkdtempSync(path.join(tmpdir(), "chat-review-"));
const photos = PATTERNS.map((source, index) => {
  const file = path.join(work, `photo-${index}.${index === 7 ? "gif" : "jpg"}`);
  const [name, options] = source.split("=", 2);
  const size = index % 3 === 0 ? "900x1200" : "1200x900";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${name}=s=${size}${options ? `:${source.slice(name.length + 1)}` : ""}`, "-frames:v", "1", file]);
  return file;
});
const photoFor = (id) => photos[Number(/^att_(\d\d)/.exec(id)?.[1] ?? -1)];

const SHOTS = [
  { name: "chat-desktop", scene: "chat", path: "/", width: 1280, height: 900 },
  { name: "chat-mobile", scene: "chat", path: "/", width: 390, height: 844 },
  { name: "batch-desktop", scene: "batch", path: "/", width: 1280, height: 900, untick: "noise.gif" },
  { name: "batch-mobile", scene: "batch", path: "/", width: 390, height: 844, untick: "noise.gif" },
  { name: "order-desktop", scene: "order", path: "/", width: 1280, height: 900 },
  { name: "ordered-desktop", scene: "ordered", path: "/", width: 1280, height: 900 },
  { name: "activity-desktop", scene: "activity", path: "/activity", width: 1280, height: 900 },
  { name: "companies-desktop", scene: "companies", path: "/companies", width: 1280, height: 900 }
];

const server = await createServer({ configFile: path.join(root, "docs/evidence/chat-review/vite.config.ts"), logLevel: "error", server: { port: 5199, host: "127.0.0.1" } });
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
    await page.setViewport({ width: shot.width, height: shot.height, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/attachments/")) {
        const file = photoFor(decodeURIComponent(url.pathname.split("/").pop()));
        return file ? request.respond({ status: 200, contentType: file.endsWith(".gif") ? "image/gif" : "image/jpeg", body: readFileSync(file) }) : request.respond({ status: 404, body: "" });
      }
      if (url.pathname === "/api/entitlement") {
        return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ lane: "own_key", reason: null, key: { provider: "anthropic", status: "valid" }, demo: null, model: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" } }) });
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/poppy/")) return request.respond({ status: 404, body: "" });
      if (url.origin !== "http://127.0.0.1:5199") return request.abort();
      return request.continue();
    });
    await page.goto(`http://127.0.0.1:5199${shot.path}?scene=${shot.scene}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    if (shot.untick) {
      const box = await page.$(`li[data-tile] img[alt="${shot.untick}"]`);
      if (box) await page.evaluate((img) => img.closest("li").querySelector("input").click(), box);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const file = path.join(out, `${shot.name}.png`);
    // Cloudflare's Puppeteer can't write files itself: it returns the bytes.
    const bytes = Buffer.from(await page.screenshot({ type: "png" }));
    writeFileSync(file, bytes);
    artifacts.push({ path: path.basename(file), scene: shot.scene, viewport: `${shot.width}×${shot.height}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    await page.close();
  }
} finally {
  await browser.disconnect();
  child.kill();
  await server.close();
  rmSync(work, { recursive: true, force: true });
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: root }).toString().trim() !== "";
writeFileSync(path.join(out, "receipt.json"), `${JSON.stringify({ source_sha: commit, source_has_uncommitted_changes_in_src: dirty, browser: execFileSync(chrome, ["--version"]).toString().trim(), fixture: "docs/evidence/chat-review/fixture.tsx", artifacts }, null, 2)}\n`);
console.log(`${artifacts.length} captures in ${out}`);
