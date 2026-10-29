import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "@cloudflare/puppeteer";

const dist = "/tmp/pda-pr36-audit-evidence-dist";
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const file = path.resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${dist}/`)) { response.writeHead(403).end(); return; }
  try { const bytes = readFileSync(file); response.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream" }).end(bytes); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = mkdtempSync("/tmp/pda-pr36-capture-");
const chrome = spawn(process.env.PDA_ACCEPTANCE_CHROMIUM ?? "/usr/bin/chromium", ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"], { stdio: ["ignore", "ignore", "pipe"] });
let browser;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not start")), 10_000);
    chrome.on("error", reject);
    chrome.stderr.on("data", chunk => {
      log += chunk;
      const found = /DevTools listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/devtools\/browser\/[a-z0-9-]+)/.exec(log);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
  });
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const files = {};
  for (const [state, width] of [["before", 960], ["after", 960], ["after-mobile", 375]]) {
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}/?state=${state === "before" ? "before" : "after"}`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-tool="poppy_mcp_call"]');
    const status = await page.$eval('[data-tool="poppy_mcp_call"]', node => node.getAttribute("data-status"));
    if (status !== (state === "before" ? "waiting" : "done")) throw new Error(`Unexpected transcript state ${status}`);
    const file = `${state}.png`;
    const bytes = Buffer.from(await page.screenshot({ fullPage: true }));
    writeFileSync(path.join(import.meta.dirname, file), bytes);
    files[file] = { sha256: createHash("sha256").update(bytes).digest("hex"), width, status };
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join(", ")}`);
  writeFileSync(path.join(import.meta.dirname, "receipt.json"), `${JSON.stringify({ fixture: "fixture.tsx", fixtureSha256: createHash("sha256").update(readFileSync(path.join(import.meta.dirname, "fixture.tsx"))).digest("hex"), browser: await browser.version(), observedAt: new Date().toISOString(), pageErrors: errors, files, limitation: "Production components with controlled before/after card data. Worker and migration regression tests establish the state transitions; these images do not show a live Company or OAuth flow." }, null, 2)}\n`);
} finally {
  await browser?.close(); chrome.kill("SIGTERM"); server.close(); rmSync(profile, { recursive: true, force: true });
}
