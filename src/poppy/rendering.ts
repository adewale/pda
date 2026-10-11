import puppeteer, { type Browser, type BrowserContext, type BrowserWorker, type Page } from "@cloudflare/puppeteer";
import type { BrowserContextHandle, PageSnapshot, PoppyBrowser } from "./browser";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function snapshot(page: Page, status: number): Promise<PageSnapshot> {
  const details = await page.evaluate(() => {
    const forms = [...document.forms].map((form, index) => ({
      selector: form.id ? `#${form.id}` : `form:nth-of-type(${index + 1})`,
      action: form.action,
      method: form.method,
      fields: [...form.elements].flatMap((element) => {
        const named = element as HTMLInputElement;
        return named.name ? [named.name] : [];
      })
    }));
    return {
      title: document.title,
      text: document.body?.innerText ?? "",
      links: [...document.links].slice(0, 100).map((link) => ({ text: link.innerText.trim(), href: link.href })),
      forms
    };
  });
  return { url: page.url(), status, ...details };
}

/** One isolated Browser Rendering context: separate cookies and storage (spec 5; Guides). */
class RenderingContext implements BrowserContextHandle {
  readonly #context: BrowserContext;
  #page: Page | undefined;

  constructor(context: BrowserContext) {
    this.#context = context;
  }

  async #currentPage(): Promise<Page> {
    this.#page ??= await this.#context.newPage();
    return this.#page;
  }

  async postForm(action: string, fields: Readonly<Record<string, string>>) {
    const page = await this.#currentPage();
    // A page that submits itself: a top-level POST navigation, so the Company's
    // cookie lands in this context. The assertion is in the body, never a URL.
    const inputs = Object.entries(fields)
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("");
    await page.setContent(
      `<!doctype html><form method="post" action="${escapeHtml(action)}">${inputs}</form>`
    );
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.evaluate(() => document.forms[0]!.submit())
    ]);
    return { url: page.url(), status: response?.status() ?? 0 };
  }

  async goto(url: string) {
    const page = await this.#currentPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    return snapshot(page, response?.status() ?? 0);
  }

  async click(selector: string) {
    const page = await this.#currentPage();
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => null),
      page.click(selector)
    ]);
    return snapshot(page, response?.status() ?? 200);
  }

  async fill(selector: string, value: string) {
    const page = await this.#currentPage();
    await page.type(selector, value);
    return snapshot(page, 200);
  }

  async submit(selector: string) {
    const page = await this.#currentPage();
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.$eval(selector, (form) => (form as HTMLFormElement).submit())
    ]);
    return snapshot(page, response?.status() ?? 0);
  }

  async close() {
    await this.#context.close();
  }
}

/** Cloudflare Browser Rendering, one context per Session. */
export class RenderingBrowser implements PoppyBrowser {
  readonly #binding: BrowserWorker;
  #browser: Promise<Browser> | undefined;

  constructor(binding: unknown) {
    // The Workers types name the binding `BrowserRun`; Puppeteer calls it `BrowserWorker`.
    this.#binding = binding as BrowserWorker;
  }

  async newContext(): Promise<BrowserContextHandle> {
    this.#browser ??= puppeteer.launch(this.#binding);
    const browser = await this.#browser;
    return new RenderingContext(await browser.createBrowserContext());
  }
}
