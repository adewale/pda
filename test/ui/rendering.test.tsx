import type { Browser, BrowserWorker } from "@cloudflare/puppeteer";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RenderingBrowser, type Launch } from "../../src/poppy/rendering";

/**
 * The Browser Rendering adapter (`src/poppy/rendering.ts`) against a stub of
 * the Puppeteer API. The Poppy suite swaps the whole browser for a fetch-based
 * fake, so this is where the page that carries the browser assertion (spec 5)
 * is checked: a form POSTed by a top-level navigation, the assertion in its
 * body. The stub parses the HTML with a real HTML parser (happy-dom), so what
 * it reads back is what Chrome would submit.
 */

type Submitted = { method: string; action: string; fields: [string, string][] };

class StubPage {
  /** Every call, in order, as `name` or `name arg`. */
  readonly calls: string[] = [];
  readonly submitted: Submitted[] = [];
  html = "";
  current = "about:blank";
  /** The status the next navigation reports, after any redirects. */
  status = 200;
  /** Where the next navigation lands. */
  landAt: string | null = null;
  #document: Document | null = null;

  async setContent(html: string) {
    this.calls.push("setContent");
    this.html = html;
    const document = new DOMParser().parseFromString(html, "text/html");
    for (const form of document.forms) {
      // What a browser would submit: the form's method, action and entries.
      form.submit = () => {
        this.submitted.push({
          method: form.getAttribute("method") ?? "",
          action: form.getAttribute("action") ?? "",
          fields: [...form.querySelectorAll("input")].map((input) => [input.name, input.value])
        });
      };
    }
    this.#document = document;
  }

  async waitForNavigation() {
    this.calls.push("waitForNavigation");
    await Promise.resolve();
    if (this.landAt) this.current = this.landAt;
    return { status: () => this.status };
  }

  async evaluate(fn: () => unknown) {
    this.calls.push("evaluate");
    // Run the page function against the page's own document, as Chrome would.
    const saved = Object.getOwnPropertyDescriptor(globalThis, "document")!;
    Object.defineProperty(globalThis, "document", { value: this.#document ?? saved.value, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(globalThis, "document", saved);
    }
  }

  async goto(url: string) {
    this.calls.push(`goto ${url}`);
    this.current = url;
    await this.setContent(`<!doctype html><title>Shop</title><body><p>Hello</p><a href="${url}/next">Next</a></body>`);
    this.calls.pop();
    return { status: () => this.status };
  }

  async click(selector: string) {
    this.calls.push(`click ${selector}`);
  }

  async type(selector: string, value: string) {
    this.calls.push(`type ${selector} ${value}`);
  }

  async $eval(selector: string) {
    this.calls.push(`$eval ${selector}`);
  }

  url() {
    return this.current;
  }
}

class StubContext {
  readonly pages: StubPage[] = [];
  closed = false;

  async newPage() {
    const page = new StubPage();
    this.pages.push(page);
    return page;
  }

  async close() {
    this.closed = true;
  }
}

function stubBrowser() {
  const contexts: StubContext[] = [];
  const launches: unknown[] = [];
  const browser = {
    async createBrowserContext() {
      const context = new StubContext();
      contexts.push(context);
      return context;
    }
  };
  const launch: Launch = async (binding) => {
    launches.push(binding);
    return browser as unknown as Browser;
  };
  const binding = { fetch: () => Promise.reject(new Error("no network")) } as unknown as BrowserWorker;
  return { rendering: new RenderingBrowser(binding, launch), contexts, launches, binding };
}

const ENDPOINT = "https://shop.example/poppy/browser-session";
const ASSERTION = "eyJ0eXAiOiJwb3BweS1icm93c2VyK2p3dCJ9.eyJzdWIiOiJ1In0.c2ln";

describe("Browser Rendering adapter", () => {
  it("joins with a page whose form POSTs the assertion in its body, by a top-level navigation", async () => {
    const { rendering, contexts } = stubBrowser();
    const context = await rendering.newContext();
    const page = () => contexts[0]!.pages[0]!;
    const result = await context.postForm(ENDPOINT, { assertion: ASSERTION });

    const stub = page();
    // The form exists before the navigation is awaited, which starts before the submit.
    expect(stub.calls).toEqual(["setContent", "waitForNavigation", "evaluate"]);
    const document = new DOMParser().parseFromString(stub.html, "text/html");
    expect(document.forms).toHaveLength(1);
    const form = document.forms[0]!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe(ENDPOINT);
    const inputs = [...form.querySelectorAll("input")];
    expect(inputs.map((input) => [input.type, input.name, input.value])).toEqual([["hidden", "assertion", ASSERTION]]);
    // No script and no URL carries it: only the body.
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(form.getAttribute("action")).not.toContain(ASSERTION);
    expect(stub.calls.some((call) => call.startsWith("goto"))).toBe(false);

    // The page submitted itself once, as a POST to the endpoint.
    expect(stub.submitted).toEqual([{ method: "post", action: ENDPOINT, fields: [["assertion", ASSERTION]] }]);
    expect(result.status).toBe(200);
  });

  it("reports where the join landed and its status", async () => {
    const { rendering, contexts } = stubBrowser();
    const context = await rendering.newContext();
    await context.goto("https://shop.example/");
    const stub = contexts[0]!.pages[0]!;
    stub.landAt = "https://shop.example/orders";
    stub.status = 403;
    expect(await context.postForm(ENDPOINT, { assertion: ASSERTION })).toEqual({ url: "https://shop.example/orders", status: 403 });
  });

  it("escapes every field so the browser submits exactly what was given", async () => {
    // Text a parser treats specially. CR and NUL are left out: an HTML parser
    // normalises them in any attribute, and a JWT never contains them.
    const tricky = fc.string({
      unit: fc.constantFrom('"', "'", "<", ">", "&", "=", " ", "/", "\n", "\t", "#", ";", "a", "Z", "0", "é", "😀", "&amp;", "&#34;", "-->", "</form>", "<script>")
    });
    const text = fc.oneof(tricky, fc.string({ unit: "grapheme" }).filter((value) => !/[\r\0]/.test(value)));
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.tuple(text.filter((name) => name.length > 0 && name.trim() === name && name !== "isindex"), text), {
          minLength: 1,
          maxLength: 4,
          selector: ([name]) => name
        }),
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        async (fields, action) => {
          const { rendering, contexts } = stubBrowser();
          const context = await rendering.newContext();
          const record = Object.fromEntries(fields);
          await context.postForm(action, record);
          const stub = contexts[0]!.pages[0]!;
          expect(stub.submitted).toHaveLength(1);
          const [sent] = stub.submitted;
          expect(sent!.method).toBe("post");
          expect(sent!.action).toBe(action);
          expect(sent!.fields).toEqual(Object.entries(record));
          // Nothing escaped the form: one form, hidden inputs only.
          const document = new DOMParser().parseFromString(stub.html, "text/html");
          expect(document.forms).toHaveLength(1);
          expect(document.querySelectorAll("script")).toHaveLength(0);
          expect([...document.querySelectorAll("input")].every((input) => input.type === "hidden")).toBe(true);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("gives each Session its own browser context on one browser, and closes it", async () => {
    const { rendering, contexts, launches, binding } = stubBrowser();
    const first = await rendering.newContext();
    const second = await rendering.newContext();
    expect(launches).toEqual([binding]);
    expect(contexts).toHaveLength(2);

    await first.goto("https://shop.example/a");
    await second.goto("https://shop.example/b");
    // Each context has its own page.
    expect(contexts.map((context) => context.pages.length)).toEqual([1, 1]);
    expect(contexts[0]!.pages[0]!.url()).toBe("https://shop.example/a");
    expect(contexts[1]!.pages[0]!.url()).toBe("https://shop.example/b");

    await first.close();
    expect(contexts.map((context) => context.closed)).toEqual([true, false]);
    await second.close();
    expect(contexts[1]!.closed).toBe(true);
  });

  it("reuses the Session's page and returns text and links, never cookies", async () => {
    const { rendering, contexts } = stubBrowser();
    const context = await rendering.newContext();
    const opened = await context.goto("https://shop.example/");
    expect(opened).toMatchObject({ url: "https://shop.example/", status: 200, title: "Shop" });
    expect(opened.text).toContain("Hello");
    expect(opened.links).toEqual([{ text: "Next", href: "https://shop.example//next" }]);
    expect(Object.keys(opened).sort()).toEqual(["forms", "links", "status", "text", "title", "url"]);

    await context.fill("#search", "socks");
    await context.click("#go");
    await context.submit("#form");
    const stub = contexts[0]!.pages[0]!;
    expect(contexts[0]!.pages).toHaveLength(1);
    expect(stub.calls).toEqual(
      expect.arrayContaining(["goto https://shop.example/", "type #search socks", "click #go", "$eval #form"])
    );
  });
});
