/** Decision 50: a request naming an unselected Company → a card → Allow → the print goes ahead. Local workerd/strict mock only. */
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

/** The card's own article, found by its title. */
const cardText = (page, domain) => page.evaluate(title => [...document.querySelectorAll("article")].find(article => article.innerText.includes(title))?.innerText ?? null, `Let your agent contact ${domain}?`);

export async function companyAccessJourneys({ runtime, page, agentName, output }) {
  const agents = await runtime.getDurableObjectNamespace("PersonalAgent");
  const companies = await runtime.getDurableObjectNamespace("MOCK_COMPANY");
  const agent = agents.getByName(agentName);
  const screenshots = [];
  const receipts = [];
  const capture = async suffix => {
    if (!output) return;
    const file = `${output}.company-access-${suffix}.png`;
    writeFileSync(file, Buffer.from(await page.screenshot({ type: "png" })));
    screenshots.push(file);
  };
  for (const viewport of ["desktop", "mobile"]) {
    const id = `caccess${viewport}`;
    const domain = `${id}.shop.test`;
    const company = companies.getByName(id);
    await company.configure({ printShop: true });
    await page.setViewport(viewport === "desktop" ? { width: 1440, height: 1000, deviceScaleFactor: 1 } : { width: 390, height: 844, deviceScaleFactor: 1 });
    await page.goto("https://agent.test/", { waitUntil: "networkidle0" });
    await page.waitForSelector('textarea[aria-label="Message your agent"]');
    await page.$eval('[data-testid="attach-input"]', async input => {
      const canvas = document.createElement("canvas");
      canvas.width = 240; canvas.height = 180;
      const paint = canvas.getContext("2d");
      paint.fillStyle = "#dce9ed"; paint.fillRect(0, 0, 240, 180);
      paint.fillStyle = "#51705d"; paint.beginPath(); paint.moveTo(0, 120); paint.lineTo(90, 35); paint.lineTo(175, 120); paint.fill();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "lake.jpg", { type: "image/jpeg" }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForSelector('ul[aria-label="Photos to send"] img');
    // No Company selected: the request names it only in prose.
    await page.$eval('input[aria-label="Companies your agent can contact"]', field => { field.focus(); field.select(); });
    await page.keyboard.press("Backspace");
    await page.type('textarea[aria-label="Message your agent"]', `Print this photo at ${domain}, please.`);
    await page.click('button[aria-label="Send message"]');

    const text = await until(() => cardText(page, domain), Boolean, "No card asked to contact the Company");
    assert.match(text, new RegExp(`calls itself Mock Shop ${id}`));
    assert.match(text, /Anything it charges still needs your approval/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "The card fits the viewport");
    assert.equal(await page.evaluate(title => [...document.querySelectorAll("article")].find(article => article.innerText.includes(title))?.querySelectorAll("img").length, `Let your agent contact ${domain}?`), 1, "The card shows the photo it would send");
    // Before Allow the Company has seen discovery and nothing else.
    const before = await company.state();
    assert.deepEqual(before.requests.filter(request => !new URL(request.url).pathname.startsWith("/.well-known/")), []);
    await capture(`card-${viewport}`);

    const allow = await page.waitForFunction(title => {
      const card = [...document.querySelectorAll("article")].find(article => article.innerText.includes(title));
      return [...(card?.querySelectorAll("[data-card-actions] button") ?? [])].find(button => !button.disabled && /^Allow/.test(button.textContent.trim()));
    }, {}, `Let your agent contact ${domain}?`);
    assert.equal((await allow.evaluate(button => button.textContent.trim())), "Allow, with this photo");
    await allow.asElement().click();
    await allow.dispose();

    // The grant is a message of the User's, in the chat, with the Company now selected in the composer.
    await page.waitForFunction(message => document.body.innerText.includes(message), {}, `Yes, you can contact ${domain} and send it that photo.`);
    assert.equal(await page.$eval('input[aria-label="Companies your agent can contact"]', field => field.value), domain);
    const ownCards = async () => JSON.parse(await agent.poppyCards());
    const settled = await until(ownCards, cards => cards.some(card => card.kind === "approval" && card.domain === domain && card.open && card.terms), "Company terms did not arrive after Allow");
    assert.equal(settled.find(card => card.id === `company-access-${domain}`)?.open, false, "Allow's message closes the card");
    assert.equal(settled.filter(card => card.kind === "approval" && card.domain === domain).length, 1, "No disclosure card for the photo the card showed");
    await until(() => cardText(page, domain), value => value === null, "The card left the page");
    const state = await company.state();
    assert.deepEqual(state.requests.filter(request => request.url.endsWith("/photos")).map(request => request.status), [201]);
    assert.deepEqual(state.violations, []);
    assert.deepEqual(state.warnings, []);
    await capture(`allowed-${viewport}`);
    // Decline the order, so the next viewport's panel holds only its own card.
    const terms = settled.find(card => card.kind === "approval" && card.domain === domain && card.open && card.terms);
    const decline = await page.waitForFunction(() => [...document.querySelectorAll("article [data-card-actions] button")].find(button => !button.disabled && button.textContent.trim() === "Decline"));
    await decline.asElement().click();
    await decline.dispose();
    await until(ownCards, cards => cards.find(card => card.approvalId === terms.approvalId)?.status === "declined", "The order wasn't declined");
    receipts.push({ viewport, cardShown: true, photoShown: true, requestsBeforeAllow: 0, allowMessageSent: true, uploads: 1, disclosureCards: 0, strictViolations: 0, strictWarnings: 0 });
  }
  return { journeys: receipts, screenshots };
}
