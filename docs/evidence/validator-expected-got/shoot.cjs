const { chromium } = require("playwright");
(async () => {
  const [input, output] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  await page.goto(`file://${input}`);
  const doc = page.locator(".doc").first();
  await doc.screenshot({ path: output });
  await browser.close();
})();
