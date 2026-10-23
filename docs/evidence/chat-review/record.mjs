#!/usr/bin/env node
/**
 * Films the bug report's journey on the fixture's `flow` scene: ten photos
 * waiting, the User's decisions, the shop refusing the GIF, an address, the
 * order and its checkout. The page and its clicks are real; the agent is the
 * fixture's script (fixture.tsx `Flow`), and the cursor is drawn in, since a
 * headless browser has none. It clicks what the checkout at --root offers:
 * one "Send N photos" where there is a batch card, otherwise Approve on each
 * card in turn.
 *
 *   node docs/evidence/chat-review/record.mjs --out <dir> [--root <checkout>] [--name <file stem>]
 *
 * Writes <name>.mp4 and <name>.gif, and adds them to <dir>/receipt.json.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []));
const root = path.resolve(args.root ?? path.join(import.meta.dirname, "../../.."));
const out = path.resolve(args.out ?? path.join(import.meta.dirname, "out"));
const stem = args.name ?? "flow";
const chrome = process.env.EVIDENCE_CHROMIUM ?? "/opt/pw-browsers/chromium";
const require = createRequire(path.join(root, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const { default: puppeteer } = await import(require.resolve("@cloudflare/puppeteer"));

// The same test patterns as capture.mjs, so the photos match the stills.
const PATTERNS = ["smptehdbars", "gradients=seed=3", "mandelbrot", "testsrc2", "rgbtestsrc", "gradients=seed=8:type=radial", "gradients=seed=11:type=circular", "life=seed=7:mold=10", "sierpinski=seed=2", "yuvtestsrc"];
const work = mkdtempSync(path.join(tmpdir(), "chat-review-video-"));
const photos = PATTERNS.map((source, index) => {
  const file = path.join(work, `photo-${index}.${index === 7 ? "gif" : "jpg"}`);
  const [name, options] = source.split("=", 2);
  const size = index % 3 === 0 ? "900x1200" : "1200x900";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${name}=s=${size}${options ? `:${source.slice(name.length + 1)}` : ""}`, "-frames:v", "1", file]);
  return file;
});
const photoFor = (id) => photos[Number(/^att_(\d\d)/.exec(id)?.[1] ?? -1)];

const WIDTH = 1280;
const HEIGHT = 800;
const server = await createServer({ configFile: path.join(root, "docs/evidence/chat-review/vite.config.ts"), logLevel: "error", server: { port: 5198, host: "127.0.0.1" } });
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
const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
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
  if (url.origin !== "http://127.0.0.1:5198") return request.abort();
  return request.continue();
});

const frames = [];
const framesDir = path.join(work, "frames");
mkdirSync(framesDir);
let recording = false;
let filming;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A visible pointer, moved to each target before it is clicked. */
async function pointAt(handle) {
  const box = await handle.boundingBox();
  if (!box) throw new Error("Nothing to click");
  await page.evaluate(
    (x, y) => {
      let dot = document.getElementById("evidence-pointer");
      if (!dot) {
        dot = document.createElement("div");
        dot.id = "evidence-pointer";
        dot.style.cssText = "position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(239,138,23,.45);border:2px solid #a34a06;pointer-events:none;transition:left .45s ease,top .45s ease;left:640px;top:400px";
        document.body.append(dot);
      }
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
    },
    box.x + box.width / 2,
    box.y + box.height / 2
  );
  await pause(650);
}

async function click(handle) {
  await pointAt(handle);
  await handle.click();
  await pause(350);
}

/** The first button whose text matches, inside `scope` when given. */
async function button(pattern, scope) {
  const handles = await page.$$(`${scope ?? ""} button`);
  for (const handle of handles) {
    const text = await handle.evaluate((node) => (node.disabled ? "" : node.textContent?.trim() ?? ""));
    if (pattern.test(text)) return handle;
  }
  return null;
}

async function waitForText(text, timeout = 15_000) {
  await page.waitForFunction((wanted) => document.body.innerText.includes(wanted), { timeout }, text);
}

try {
  await page.goto("http://127.0.0.1:5198/?scene=flow", { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  recording = true;
  filming = (async () => {
    while (recording) {
      const file = path.join(framesDir, `${String(frames.length).padStart(5, "0")}.jpg`);
      const bytes = await page.screenshot({ type: "jpeg", quality: 85 });
      writeFileSync(file, Buffer.from(bytes));
      frames.push({ file, at: Date.now() });
    }
  })();
  await pause(2500);

  // The photos: one batch card here, ten cards before.
  const panel = 'section[aria-label="Needs you"]';
  const batch = await button(/^Send \d+ photos$/, panel);
  if (batch) {
    await pause(1500);
    await click(batch);
  } else {
    for (let n = 0; n < 10; n++) {
      const approve = await button(/^Approve$/, panel);
      if (!approve) break;
      await click(approve);
      await pause(500);
    }
  }
  await waitForText("Where should the prints go?");
  await pause(3500);

  // The address, typed into the composer.
  const box = await page.$('textarea[aria-label="Message your agent"]');
  await pointAt(box);
  await box.click();
  await page.keyboard.type("Ada Lovelace, ada@example.com, 12 Example Street, Springfield, CA 94105", { delay: 18 });
  await pause(400);
  await page.keyboard.press("Enter");

  // The order.
  await waitForText("Approve this at");
  await pause(3000);
  await click(await button(/^Approve/, panel));
  await waitForText("Your order is ready");
  await pause(1500);
  const checkout = await page.$("a[href='https://prints.example/checkout/ord_1']");
  if (checkout) await pointAt(checkout);
  await pause(3000);
} finally {
  recording = false;
  await filming;
  await browser.disconnect();
  child.kill();
  await server.close();
}

// Each frame lasts until the next was taken, so the film keeps the page's real timing.
const list = frames.map((frame, index) => `file '${frame.file}'\nduration ${(((frames[index + 1]?.at ?? frame.at + 1000) - frame.at) / 1000).toFixed(3)}`).join("\n");
writeFileSync(path.join(work, "frames.txt"), `${list}\nfile '${frames.at(-1).file}'\n`);
mkdirSync(out, { recursive: true });
const mp4 = path.join(out, `${stem}.mp4`);
const gif = path.join(out, `${stem}.gif`);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(work, "frames.txt"), "-vf", "fps=15,format=yuv420p", "-c:v", "libx264", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", mp4]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-vf", "fps=6,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle", gif]);
rmSync(work, { recursive: true, force: true });

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
const receiptFile = path.join(out, "receipt.json");
const receipt = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, "utf8")) : {};
receipt.films = [
  ...(receipt.films ?? []).filter((film) => film.source_sha !== commit || !film.path.startsWith(stem)),
  ...[mp4, gif].map((file) => {
    const bytes = readFileSync(file);
    return { path: path.basename(file), source_sha: commit, scene: "flow", viewport: `${WIDTH}×${HEIGHT}`, seconds: Number(((frames.at(-1).at - frames[0].at) / 1000 + 1).toFixed(1)), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  })
];
writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`${frames.length} frames → ${path.basename(mp4)}, ${path.basename(gif)}`);
