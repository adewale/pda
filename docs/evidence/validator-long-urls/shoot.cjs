// Screenshots the protected resource metadata section at a width, and reports whether anything overflows it.
const { chromium } = require("playwright");
(async () => {
  const [input, output, width] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: Number(width), height: 1200 }, deviceScaleFactor: 2, colorScheme: "light" });
  await page.goto(`file://${input}`);
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    sections: [...document.querySelectorAll(".doc")].map((doc) => doc.scrollWidth - doc.clientWidth)
  }));
  await page.locator(".doc").nth(1).screenshot({ path: output });
  process.stdout.write(`${width}px: page overflows by ${overflow.page}px; sections by ${overflow.sections.join(", ")}px\n`);
  await browser.close();
})();
