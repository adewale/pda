// shoot.cjs <dist> <png>: serve the built page over http and capture #root in Chromium, UTC, en-US.
const { chromium } = require("playwright");
const http = require("http"); const fs = require("fs"); const path = require("path");
const [dist, png] = process.argv.slice(2);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/^\/$/, "/.shot/index.html")));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).pipe(res);
}).listen(0, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ locale: "en-US", timezoneId: "UTC", deviceScaleFactor: 2, viewport: { width: 640, height: 2400 } });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/.shot/index.html`);
  await page.waitForSelector("#root > div > *");
  await page.locator("#root").screenshot({ path: png });
  console.log(png, errors.length ? errors : "no page errors");
  await browser.close(); server.close();
});
