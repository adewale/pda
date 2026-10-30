/** User-selected photo → one Company-terms decision. Local workerd/strict mock only. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

async function until(read, accepts, label) {
  const end = Date.now() + 20_000;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < end);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

async function approve(page) {
  const handle = await page.waitForFunction(() => [...document.querySelectorAll("article [data-card-actions] button")].find(button => !button.disabled && /^Approve(?: |$)/.test(button.textContent.trim())));
  assert.ok(handle.asElement());
  await handle.asElement().click();
  await handle.dispose();
}

export async function photoJourneys({ runtime, page, network, agentName, output, baselineConsent = false, negativeControl = false }) {
  const agents = await runtime.getDurableObjectNamespace("PersonalAgent");
  const companies = await runtime.getDurableObjectNamespace("MOCK_COMPANY");
  const agent = agents.getByName(agentName);
  const decisions = [];
  const screenshots = [];
  const receipts = [];
  const onFrame = event => {
    try {
      const frame = JSON.parse(event.response.payloadData);
      if (frame.type === "poppy.approval") decisions.push({ approvalId: frame.approvalId, decision: frame.decision });
    } catch { /* Only decision frames are part of this count. */ }
  };
  network.on("Network.webSocketFrameSent", onFrame);
  const capture = async suffix => {
    if (!output) return;
    const file = `${output}.photo-${suffix}.png`;
    // The app is a viewport-height layout with its own scrollers. A full-page
    // capture can resize dvh and crop the mobile request panel misleadingly.
    writeFileSync(file, Buffer.from(await page.screenshot({ type: "png" })));
    screenshots.push(file);
  };
  try {
    for (const viewport of ["desktop", "mobile"]) {
      const id = `cphoto${viewport}`;
      const domain = `${id}.shop.test`;
      const company = companies.getByName(id);
      await company.configure({ protocolVersion: "0.3", printShop: true });
      await page.setViewport(viewport === "desktop" ? { width: 1440, height: 1000, deviceScaleFactor: 1 } : { width: 390, height: 844, deviceScaleFactor: 1 });
      await page.goto("https://agent.test/", { waitUntil: "networkidle0" });
      await page.waitForSelector('textarea[aria-label="Message your agent"]');
      // A synthetic image enters the real file-input handler and authenticated
      // attachment POST, not a test-only storage shortcut or an external URL.
      await page.$eval('[data-testid="attach-input"]', async input => {
        const canvas = document.createElement("canvas");
        canvas.width = 240; canvas.height = 180;
        const paint = canvas.getContext("2d");
        paint.fillStyle = "#dce9ed"; paint.fillRect(0, 0, 240, 180);
        paint.fillStyle = "#51705d"; paint.beginPath(); paint.moveTo(0, 120); paint.lineTo(90, 35); paint.lineTo(175, 120); paint.fill();
        paint.fillStyle = "#7999a7"; paint.fillRect(0, 120, 240, 60);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], "lake.jpg", { type: "image/jpeg" }));
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForSelector('ul[aria-label="Photos to send"] img');
      await page.type('textarea[aria-label="Message your agent"]', `Please print this photo at ${domain}.`);
      await page.click('button[aria-label="Send message"]');
      const ownCards = async () => JSON.parse(await agent.poppyCards()).filter(card => card.kind === "approval" && card.domain === domain);
      const first = await until(ownCards, cards => cards.some(card => card.open), "No print decision reached the page");
      if (baselineConsent) {
        assert.equal(first.length, 1);
        assert.equal(first[0].terms, undefined);
        assert.equal((await company.state()).requests.filter(request => request.url.endsWith("/photos")).length, 0);
        await page.waitForFunction(() => [...document.querySelectorAll("article")].some(article => article.innerText.includes("Send this photo")));
        await capture(`disclosure-${viewport}`);
        await approve(page);
      }
      const pending = await until(ownCards, cards => cards.some(card => card.open && card.terms), "Company terms did not arrive");
      const terms = pending.find(card => card.open && card.terms);
      assert.equal(pending.length, baselineConsent ? 2 : 1, "Only baseline behavior may ask for the redundant disclosure click");
      const before = await company.state();
      assert.deepEqual(before.requests.filter(request => request.url.endsWith("/photos")).map(request => request.status), [201]);
      assert.deepEqual(before.requests.filter(request => request.url.endsWith("/prints")).map(request => request.status), [403]);
      assert.deepEqual(before.operations.map(operation => [operation.state, operation.confirms]), [["proposed", 0]]);
      await page.waitForFunction(summary => [...document.querySelectorAll("article")].some(article => article.innerText.includes(summary)), {}, terms.terms.summary);
      if (!baselineConsent) {
        await page.waitForFunction(domain => [...document.querySelectorAll('[data-tool="poppy_api_call"]')].some(element => element.innerText.includes(domain) && /Sent your photo/.test(element.innerText)), {}, domain);
        assert.equal(await page.evaluate(() => document.body.innerText.includes("Asked you to approve sending your photo")), false);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await capture(`terms-${viewport}`);
      await approve(page);
      await until(ownCards, cards => cards.find(card => card.approvalId === terms.approvalId)?.status === "done", "Print terms did not settle");
      const completed = (await ownCards()).find(card => card.approvalId === terms.approvalId);
      const checkout = JSON.parse(completed.result).body.order.checkout_url;
      assert.equal(new URL(checkout).hostname, domain);
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForFunction(href => [...document.querySelectorAll("a[href]")].some(link => link.getAttribute("href") === href && link.href === href), {}, checkout);
      // Oracle sabotage: a previous desktop link must not stand in for this
      // mobile receipt. This is test-harness DOM removal, never app behavior.
      if (negativeControl && viewport === "mobile") await page.evaluate(href => document.querySelectorAll("a[href]").forEach(link => { if (link.getAttribute("href") === href) link.remove(); }), checkout);
      assert.equal(await page.evaluate(href => [...document.querySelectorAll("a[href]")].some(link => link.getAttribute("href") === href && link.href === href), checkout), true, "The current Company's exact checkout receipt must survive reload");
      const state = await company.state();
      const uploads = state.requests.filter(request => request.url.endsWith("/photos"));
      const orders = state.requests.filter(request => request.url.endsWith("/prints"));
      assert.deepEqual(uploads.map(request => request.status), [201]);
      assert.deepEqual(orders.map(request => [request.status, !!request.headers["poppy-approval"]]), [[403, false], [201, true]]);
      assert.deepEqual(state.operations.map(operation => [operation.state, operation.confirms, operation.approvedBy]), [["succeeded", 1, "user"]]);
      assert.deepEqual(state.violations, []);
      assert.deepEqual(state.warnings, []);
      const ids = new Set((await ownCards()).map(card => card.approvalId));
      const clicks = decisions.filter(decision => ids.has(decision.approvalId));
      assert.equal(clicks.length, baselineConsent ? 2 : 1);
      assert.ok(clicks.every(click => click.decision === "approve"));
      await capture(`done-${viewport}`);
      receipts.push({ viewport, attachmentViaRealComposer: true, uploads: uploads.length, approvals: clicks.length, companyOperations: 1, approvedOrderRequests: 1, orderStatuses: orders.map(request => request.status), survivesReload: true, checkoutOpened: false, strictViolations: 0, strictWarnings: 0 });
    }
    return { baselineConsent, negativeControl, journeys: receipts, screenshots };
  } finally {
    network.off("Network.webSocketFrameSent", onFrame);
  }
}
