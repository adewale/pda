import { describe, expect, it } from "vitest";
import { NodeHTMLRewriter } from "../impls/pda-agent/html-rewriter.ts";
import { FetchBrowser } from "../../src/poppy/fetch-browser.ts";
import type { Fetcher } from "../../src/poppy/fetch.ts";

// The agent's image runs src/poppy in Node, where this stands in for Workers' HTMLRewriter.
(globalThis as Record<string, unknown>).HTMLRewriter ??= NodeHTMLRewriter;

const ENDPOINT = "https://shop.company.interop.test/poppy/browser-session";
const JOIN_PAGE =
  '<!doctype html><title>Connecting</title><form method="post" action="/poppy/browser-session"><input type="hidden" name="code" value="bc_uhTwNlMO66NcxzZvJ5LuV72i"><button>Continue</button></form>';

const serving =
  (html: string): Fetcher =>
  async () =>
    new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });

describe("the interop agent's HTMLRewriter (Node)", () => {
  // Until 29 October the image read every page as empty, so at 0.3 scenario W failed: "the
  // browser-session page didn't give a code to join with", though the mock's page carried one.
  it("lets the browser join read the one-time code from the Company's page (0.3 6, step 1)", async () => {
    const context = await new FetchBrowser(serving(JOIN_PAGE)).newContext(() => {});
    expect(await context.joinCode(ENDPOINT)).toEqual({ status: 200, code: "bc_uhTwNlMO66NcxzZvJ5LuV72i", action: ENDPOINT });
  });

  it("reads a page's text and links as the Worker's does", async () => {
    const context = await new FetchBrowser(serving('<title>Mock Shop</title><h1>Orders</h1><p>Signed out</p><a id="orders" href="/orders">Your orders</a>')).newContext(() => {});
    const page = await context.goto("https://shop.company.interop.test/");
    expect(page.title).toBe("Mock Shop");
    expect(page.text).toContain("Signed out");
    expect(page.links.map((link) => link.text)).toEqual(["Your orders"]);
  });
});
