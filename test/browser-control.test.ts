/**
 * Browser Control 1 (0.4 extension; decision 47): the agent's fetch browser
 * leaves the steps a Company marks for the User undone, and the User takes
 * them in a browser handed to them for the Session (test/fake-handover.ts in
 * place of Browser Run). Every test also passes the strict check in
 * agent-helpers: the mock recorded no violation or warning.
 */
import { describe, expect, it } from "vitest";
import { agent, cards, company, requests, signInDirect, tool, type Agent, type Company } from "./agent-helpers";
import type { MockConfig } from "./mock-company";
import { FAKE_LIVE_VIEW_MS } from "./fake-handover";
import { handoverAvailable } from "../src/tools/render";

const MARKED: Partial<MockConfig> = { protocolVersion: "0.4", browserControl: true };
const SCOPES = ["orders:read", "orders:write", "poppy:browser-sign-in"];

const browse = (a: Agent, c: Company, args: Record<string, unknown>) => tool(a, "poppy_browse", { domain: c.domain, ...args });
const json = (text: string) => JSON.parse(text) as Record<string, any>;
const handover = async (a: Agent) => (await cards(a)).filter((card) => card.kind === "browser_control").at(-1)!;

/** Signed in, on the return page; `setup` runs before the agent first uses Poppy. */
async function onReturnPage(config: Partial<MockConfig> = MARKED, setup: { off?: boolean; failLaunch?: boolean } = {}) {
  const c = await company(config);
  const a = await agent();
  await a.stub.handoverSetup(setup);
  await signInDirect(a, c, SCOPES);
  const page = await browse(a, c, { action: "open", url: "/orders/ord_7Hk2/return" });
  expect(page.isError, page.text).toBe(false);
  return { a, c, page: json(page.text) };
}

/** On the return page, the agent tries to submit the marked form, and the User takes control. */
async function userHasControl(config: Partial<MockConfig> = MARKED) {
  const { a, c } = await onReturnPage(config);
  const offered = json((await browse(a, c, { action: "submit", selector: "#return" })).text);
  const replies = await a.stub.poppyFrameReplies({ type: "poppy.browser.take", handoverId: offered.offered });
  const [browser] = await a.stub.handoverBrowsers();
  return { a, c, id: offered.offered as string, replies, browser: browser! };
}

describe("Browser Control: declaring the extension (3)", () => {
  it("hands over only with BROWSER_CONTROL on, which ships off, and Browser Run available", () => {
    expect(handoverAvailable({ BROWSER_CONTROL: "on", BROWSER_RUN: "on", BROWSER: {} })).toBe(true);
    expect(handoverAvailable({ BROWSER_CONTROL: "off", BROWSER_RUN: "on", BROWSER: {} })).toBe(false);
    expect(handoverAvailable({ BROWSER_CONTROL: "on", BROWSER_RUN: "off", BROWSER: {} })).toBe(false);
    expect(handoverAvailable({ BROWSER_CONTROL: "on", BROWSER_RUN: "on" })).toBe(false);
    expect(() => handoverAvailable({ BROWSER_CONTROL: "yes", BROWSER_RUN: "on", BROWSER: {} })).toThrow("BROWSER_CONTROL must be on or off");
    expect(() => handoverAvailable({ BROWSER_RUN: "on", BROWSER: {} })).toThrow("Missing required setting BROWSER_CONTROL");
  });

  it("declares browser-control on the Session's join where the Company lists it and this agent can hand over a browser", async () => {
    const { c } = await onReturnPage();
    const join = (await requests(c)).find((request) => request.url.endsWith("/poppy/browser-session/authorize"))!;
    expect(join.headers["poppy-extensions"]).toBe(`"operations";v="3", "browser-control";v="1"`);
  });

  it.each([
    ["the Company doesn't list it", { protocolVersion: "0.4" } as Partial<MockConfig>, {}],
    ["Browser Run is off here", MARKED, { off: true }]
  ] as const)("doesn't declare it when %s", async (_, config, setup) => {
    const { c } = await onReturnPage(config, setup);
    const join = (await requests(c)).find((request) => request.url.endsWith("/poppy/browser-session/authorize"))!;
    expect(join.headers["poppy-extensions"]).toBe(`"operations";v="3"`);
  });
});

describe("Browser Control: marked steps (4, 5)", () => {
  it("shows the model the marks, and fills what a submission form allows", async () => {
    const { a, c, page } = await onReturnPage();
    expect(page.forms).toContainEqual(expect.objectContaining({ selector: "#return", userStep: "submission", userFields: ["card_last4"] }));
    // Any value but the two counts as interaction.
    expect(page.links).toContainEqual(expect.objectContaining({ selector: "#policy", userStep: "interaction" }));
    const filled = await browse(a, c, { action: "fill", selector: "#return [name=reason]", value: "fault" });
    expect(filled.isError, filled.text).toBe(false);
  });

  it.each([
    ["submits the marked form", { action: "submit", selector: "#return" }, "submit the form #return"],
    ["fills a marked field", { action: "fill", selector: "#card", value: "4242" }, "fill in #card"],
    ["follows a marked link", { action: "click", selector: "#policy" }, "follow the link #policy"]
  ] as const)("doesn't take a marked step when the model %s, and offers the User control on a card", async (_, args, step) => {
    const { a, c } = await onReturnPage();
    const result = await browse(a, c, args);
    expect(result.isError).toBe(false);
    expect(json(result.text)).toMatchObject({ user_step: true, offered: expect.stringMatching(/^hnd_/), note: expect.stringContaining("don't wait for them") });
    expect(await handover(a)).toMatchObject({ state: "offered", open: true, step, url: `https://${c.domain}/orders/ord_7Hk2/return` });
    // Nothing reached the website: no submit, no marked link followed.
    expect((await requests(c)).filter((request) => request.method === "POST" && request.url.includes("/return"))).toEqual([]);
    expect((await requests(c)).some((request) => request.url.includes("policy=accepted"))).toBe(false);
    expect((await c.stub.state()).returns).toEqual([]);
  });

  it("leaves a marked step to the User on the website when it can't hand over a browser", async () => {
    const { a, c } = await onReturnPage(MARKED, { off: true });
    const result = json((await browse(a, c, { action: "submit", selector: "#return" })).text);
    expect(result).toMatchObject({ user_step: true, note: expect.stringContaining(`they can take it on ${c.domain} themselves`) });
    expect(result.offered).toBeUndefined();
    expect(await handover(a)).toBeUndefined();
  });

  it("replaces an open offer with a newer one", async () => {
    const { a, c } = await onReturnPage();
    const first = json((await browse(a, c, { action: "fill", selector: "#card", value: "4242" })).text).offered;
    await browse(a, c, { action: "submit", selector: "#return" });
    const all = (await cards(a)).filter((card) => card.kind === "browser_control");
    expect(all.find((card) => card.handoverId === first)).toMatchObject({ state: "ended", open: false, note: "A newer step replaced this one." });
    expect(all.filter((card) => card.open)).toHaveLength(1);
  });
});

describe("Browser Control: the User in control (5, 6)", () => {
  it("opens a browser for the Session at the step's page, with navigator.poppy for the Company's domain, and sends the live view to the User's page alone", async () => {
    const { a, c, id, replies, browser } = await userHasControl();
    expect(browser).toMatchObject({ domain: c.domain, opened: [`https://${c.domain}/orders/ord_7Hk2/return`], scripts: [c.domain], closed: false });
    expect(browser.cookies.map((cookie) => cookie.name)).toContain("mock_sid");
    expect(replies).toEqual([{ type: "poppy.browser.view", handoverId: id, url: `https://live.browser-run.test/${browser.sessionId}/1`, expiresAt: expect.any(Number) }]);
    const card = await handover(a);
    expect(card).toMatchObject({ state: "user", open: true });
    // The link is a bearer capability: on no card, in no store, never the model's.
    const link = (replies[0] as { url: string }).url;
    expect(JSON.stringify(await cards(a))).not.toContain(link);
    expect(await a.stub.poppySql("SELECT * FROM poppy_handovers")).not.toContain(link);
    expect(await a.stub.poppyTranscript()).not.toContain(link);
    expect(await a.stub.poppyTranscript()).not.toContain(browser.sessionId);
  });

  it("lets the User take the step in that browser, as the Session's joined browser, with controller user", async () => {
    const { a, c, browser } = await userHasControl();
    const sent = await a.stub.handoverUserRequest(browser.sessionId, "POST", `https://${c.domain}/orders/ord_7Hk2/return`, "item_id=itm_4Qa&controller=user&reason=size&card_last4=4242");
    expect(sent).toEqual({ status: 303, location: "/orders/ord_7Hk2?returned=1" });
    expect((await c.stub.state()).returns).toEqual([{ account: expect.any(String), controller: "user", reason: "size", cardLast4: "4242" }]);
  });

  it("refuses the model's browser actions while the User holds control, and doesn't wait on the User", async () => {
    const { a, c } = await userHasControl();
    for (const args of [{ action: "open", url: "/orders" }, { action: "click", selector: "#policy" }, { action: "fill", selector: "#return [name=reason]", value: "fault" }]) {
      const refused = await browse(a, c, args);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("The User has control of the browser");
      expect(refused.text).toContain("Don't wait for them");
    }
    // Other work goes on: the APIs aren't the browser.
    const read = await tool(a, "poppy_api_call", { domain: c.domain, operation: "searchProducts", params: { q: "jacket" } });
    expect(read.isError, read.text).toBe(false);
  });

  it("keeps the User in control past any timeout: the browser closes after 30 minutes, and opens again at the last page", async () => {
    const { a, c, id, browser } = await userHasControl();
    await a.stub.handoverUserRequest(browser.sessionId, "GET", `https://${c.domain}/orders`);
    await a.stub.poppyAdvance(30_000);
    expect(JSON.parse(await a.stub.poppySql("SELECT url FROM poppy_handovers WHERE id = ?", id))).toEqual([{ url: `https://${c.domain}/orders` }]);
    await a.stub.poppyAdvance(30 * 60_000);
    expect((await a.stub.handoverBrowsers())[0]!.closed).toBe(true);
    expect(await handover(a)).toMatchObject({ state: "user", open: true, note: expect.stringContaining("You still have control") });
    expect((await browse(a, c, { action: "open", url: "/orders" })).text).toContain("The User has control");
    const replies = await a.stub.poppyFrameReplies({ type: "poppy.browser.view", handoverId: id });
    const browsers = await a.stub.handoverBrowsers();
    expect(browsers).toHaveLength(2);
    expect(browsers[1]!.opened).toEqual([`https://${c.domain}/orders`]);
    expect(replies).toEqual([expect.objectContaining({ type: "poppy.browser.view", url: expect.stringContaining(browsers[1]!.sessionId) })]);
  });

  it("gives a fresh live view link for the open browser, without starting another", async () => {
    const { a, id, browser } = await userHasControl();
    await a.stub.poppyAdvance(FAKE_LIVE_VIEW_MS);
    const replies = await a.stub.poppyFrameReplies({ type: "poppy.browser.view", handoverId: id });
    expect(replies).toEqual([expect.objectContaining({ url: `https://live.browser-run.test/${browser.sessionId}/2` })]);
    expect(await a.stub.handoverBrowsers()).toHaveLength(1);
  });

  it("opens at most six browsers an hour", async () => {
    const { a, c } = await onReturnPage();
    for (let round = 0; round < 7; round++) {
      const offered = json((await browse(a, c, { action: "submit", selector: "#return" })).text).offered;
      await a.stub.poppyFrameReplies({ type: "poppy.browser.take", handoverId: offered });
      if (round < 6) {
        await a.stub.poppyFrame({ type: "poppy.browser.return", handoverId: offered });
        await browse(a, c, { action: "open", url: "/orders/ord_7Hk2/return" });
      }
    }
    expect(await a.stub.handoverBrowsers()).toHaveLength(6);
    // The seventh offer stays open, for later or for the website itself.
    expect(await handover(a)).toMatchObject({ state: "offered", open: true });
  });

  it("leaves the offer open when Browser Run can't start a browser", async () => {
    const { a, c } = await onReturnPage(MARKED, { failLaunch: true });
    const offered = json((await browse(a, c, { action: "submit", selector: "#return" })).text).offered;
    expect(await a.stub.poppyFrameReplies({ type: "poppy.browser.take", handoverId: offered })).toEqual([]);
    expect(await handover(a)).toMatchObject({ state: "offered", open: true });
    expect(JSON.parse(await a.stub.poppySql("SELECT state, browser, started_at FROM poppy_handovers"))).toEqual([{ state: "offered", browser: null, started_at: null }]);
  });
});

describe("Browser Control: ending control (5)", () => {
  it.each(["return", "cancel"] as const)("on %s, closes the browser, tells the model, and has it look at the page again first", async (how) => {
    const { a, c, id, browser } = await userHasControl();
    await a.stub.handoverUserRequest(browser.sessionId, "POST", `https://${c.domain}/orders/ord_7Hk2/return`, "item_id=itm_4Qa&controller=user&reason=size&card_last4=4242");
    await a.stub.poppyFrame({ type: `poppy.browser.${how}`, handoverId: id });
    expect((await a.stub.handoverBrowsers())[0]!.closed).toBe(true);
    expect(await handover(a)).toMatchObject({ state: how === "return" ? "returned" : "cancelled", open: false, url: `https://${c.domain}/orders/ord_7Hk2?returned=1` });
    const notice = await a.stub.poppyWaitForNotice(how === "return" ? "handed control of the browser back" : "cancelled their control");
    expect(notice).toContain(`https://${c.domain}/orders/ord_7Hk2?returned=1`);
    expect(notice).toContain("Open that page again");
    // Anything but a fresh look is refused, once.
    const refused = await browse(a, c, { action: "click", selector: "#return" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Open the page again");
    expect((await browse(a, c, { action: "open", url: "/orders/ord_7Hk2?returned=1" })).text).toContain("Return started.");
    expect((await browse(a, c, { action: "click", selector: "#exchange" })).isError).toBe(false);
  });

  it("on Not now, ends the offer and tells the model the step stays undone", async () => {
    const { a, c } = await onReturnPage();
    const offered = json((await browse(a, c, { action: "submit", selector: "#return" })).text).offered;
    await a.stub.poppyFrame({ type: "poppy.browser.cancel", handoverId: offered });
    expect(await handover(a)).toMatchObject({ state: "declined", open: false });
    expect(await a.stub.poppyWaitForNotice("chose not to")).toContain("don't take it yourself");
    expect(await a.stub.handoverBrowsers()).toEqual([]);
    // No fresh look needed: the browser never left the agent.
    expect((await browse(a, c, { action: "fill", selector: "#return [name=reason]", value: "fault" })).isError).toBe(false);
  });

  it("ends the handover when the Session changes, since the browser's cookie no longer acts for it", async () => {
    const { a, c, id } = await userHasControl();
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    expect((await a.stub.handoverBrowsers())[0]!.closed).toBe(true);
    expect(await handover(a)).toMatchObject({ handoverId: id, state: "ended", note: expect.stringContaining("Session at this Company changed") });
    expect(await a.stub.poppyWaitForNotice("closed because the Session there changed")).toContain("Open the page again");
  });

  it("ignores the frames for a handover that has ended", async () => {
    const { a, id } = await userHasControl();
    await a.stub.poppyFrame({ type: "poppy.browser.return", handoverId: id });
    await a.stub.poppyFrame({ type: "poppy.browser.cancel", handoverId: id });
    expect(await handover(a)).toMatchObject({ state: "returned" });
    expect(await a.stub.poppyFrameReplies({ type: "poppy.browser.take", handoverId: id })).toEqual([]);
    expect(await a.stub.handoverBrowsers()).toHaveLength(1);
  });
});
