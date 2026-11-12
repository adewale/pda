/** Company selection and agent deletion in a real browser. Local workerd/strict mock only. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const COMPANIES = 'input[aria-label="Companies your agent can contact"]';
const MESSAGE = 'textarea[aria-label="Message your agent"]';

async function buttonNamed(page, name) {
  const handle = await page.waitForFunction(text => [...document.querySelectorAll("button")].find(button => !button.disabled && button.textContent.trim() === text), {}, name);
  return handle.asElement();
}

/** A person of their own: this journey ends by deleting the agent, which the smoke run after it must not lose. */
export async function dataControlsJourney({ runtime, browser, createSession, agentNameFor, secret, output, failures }) {
  const identity = { provider: "github", sub: "4242", email: "octo@example.com", domain: null };
  const cookie = (await createSession(identity, secret)).split(";", 1)[0];
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", error => failures.push(error.name));
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setCookie({ name: "__Host-session", value: cookie.slice("__Host-session=".length), url: "https://agent.test/", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  const shots = [];
  const capture = async (suffix, fullPage = false) => {
    if (!output) return;
    const file = `${output}.${suffix}.png`;
    writeFileSync(file, Buffer.from(await page.screenshot({ type: "png", fullPage })));
    shots.push(file);
  };
  const agents = await runtime.getDurableObjectNamespace("PersonalAgent");
  const companies = await runtime.getDurableObjectNamespace("MOCK_COMPANY");
  const agent = agents.getByName(await agentNameFor(identity));
  const domain = "cdata.shop.test";
  const company = companies.getByName("cdata");
  // Refusing with invalid_client is what a Company does with a token issued to an earlier client_id.
  await company.configure({ deviceInterval: 1, refuseRevocations: 1000 });

  await page.goto("https://agent.test/", { waitUntil: "networkidle0" });
  await page.waitForSelector(COMPANIES);
  await page.type(COMPANIES, domain);
  await page.type(MESSAGE, "Hello");
  await page.click('button[aria-label="Send message"]');
  await page.waitForFunction(() => /echo:.*Hello/s.test(document.body.innerText), { timeout: 20_000 });
  assert.equal(await page.$eval(COMPANIES, field => field.value), domain, "Sending must keep the selection");
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction((selector, expected) => document.querySelector(selector)?.value === expected, {}, COMPANIES, domain);
  await capture("composer-after-reload");
  assert.equal(await agent.taskCompanies(identity).then(saved => saved[0]), domain);
  const selectionSurvivesReload = true;

  const signIn = await agent.poppyTool("poppy_sign_in", { domain, scopes: ["orders:read"], reason: "To check an order" });
  assert.equal(signIn.isError, false, signIn.text);
  const link = JSON.parse(await agent.poppyCards()).find(card => card.kind === "signin_link" && card.open);
  assert.ok(link, "Synthetic Company setup must use the normal sign-in flow");
  const callback = await runtime.dispatchFetch(await company.approveAuthorization(link.url, { approve: true, account: "acct_ada" }), { headers: { Cookie: cookie } });
  assert.equal(callback.status, 200, await callback.text());

  await page.goto("https://agent.test/settings", { waitUntil: "networkidle0" });
  await (await buttonNamed(page, "Delete my agent")).click();
  await page.type('input[aria-label="Deletion confirmation"]', "DELETE");
  await page.evaluate(() => document.querySelector('input[aria-label="Deletion confirmation"]').scrollIntoView({ block: "center" }));
  await capture("settings-confirm");
  await (await buttonNamed(page, "Permanently delete my agent")).click();
  await page.waitForFunction(() => document.body.innerText.includes("Your local data is still here"), { timeout: 30_000 });
  await page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].at(-1)?.scrollIntoView({ block: "center" }));
  await capture("settings-unrevoked");
  assert.equal(await page.evaluate(expected => document.body.innerText.includes(expected), domain), true);
  assert.equal(await page.evaluate(() => document.body.innerText.includes("no longer has access")), false, "A refused deletion must not look like a lost session");
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].at(-1)?.scrollIntoView({ block: "start" }));
  await capture("settings-unrevoked-mobile");
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  assert.equal(await page.evaluate(async () => (await fetch("/api/me")).status), 200, "A refused deletion leaves the agent usable");
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), (await buttonNamed(page, "Delete anyway")).click()]);
  await page.waitForSelector('a[aria-label="Sign in with GitHub"]');
  assert.equal(await page.evaluate(async () => (await fetch("/api/me")).status), 401);
  const fresh = (await createSession(identity, secret)).split(";", 1)[0];
  const exported = await (await runtime.dispatchFetch("https://agent.test/api/agent-data", { headers: { Cookie: fresh } })).json();
  assert.deepEqual(exported.tables.poppy_signouts ?? [], []);
  assert.deepEqual(exported.tables.task_company_selection ?? [], []);
  await context.close();
  return { selectionSurvivesReload, refusedRevocationShown: true, refusedDeletionLeavesAgentUsable: true, abandonedDeletionErased: true, screenshots: shots };
}
