import type { BrowserContextHandle, PageSnapshot, PoppyBrowser } from "../src/poppy/browser";
import type { Fetcher } from "../src/poppy/fetch";

/**
 * A browser for tests: plain fetches with one cookie jar per context, so the
 * browser-session join (a form POST, a 303 and the Company's cookie) behaves
 * as it would in Browser Rendering. No JavaScript runs.
 */
class FakeContext implements BrowserContextHandle {
  readonly #fetcher: Fetcher;
  readonly #cookies = new Map<string, Map<string, string>>();
  #page: { url: string; html: string } | undefined;
  /** Every URL this context requested, for assertions. */
  readonly visited: string[] = [];

  constructor(fetcher: Fetcher) {
    this.#fetcher = fetcher;
  }

  #cookieHeader(url: URL): string {
    return [...(this.#cookies.get(url.hostname) ?? new Map()).entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  #store(url: URL, response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const index = pair!.indexOf("=");
      if (index === -1) continue;
      const jar = this.#cookies.get(url.hostname) ?? new Map<string, string>();
      jar.set(pair!.slice(0, index).trim(), pair!.slice(index + 1).trim());
      this.#cookies.set(url.hostname, jar);
    }
  }

  async #navigate(url: string, init: { method: string; body?: URLSearchParams }): Promise<{ url: string; status: number; html: string }> {
    let current = new URL(url);
    let method = init.method;
    let body = init.body;
    for (let hop = 0; hop < 5; hop++) {
      this.visited.push(`${method} ${current.href}`);
      const headers = new Headers({ Accept: "text/html" });
      const cookie = this.#cookieHeader(current);
      if (cookie) headers.set("Cookie", cookie);
      if (body) headers.set("Content-Type", "application/x-www-form-urlencoded");
      const response = await this.#fetcher(new Request(current.href, { method, headers, redirect: "manual", ...(body ? { body } : {}) }));
      this.#store(current, response);
      if (response.status >= 300 && response.status < 400 && response.headers.get("Location")) {
        await response.body?.cancel();
        current = new URL(response.headers.get("Location")!, current);
        method = "GET";
        body = undefined;
        continue;
      }
      const html = await response.text();
      this.#page = { url: current.href, html };
      return { url: current.href, status: response.status, html };
    }
    throw new Error("Too many redirects");
  }

  #snapshot(page: { url: string; status: number; html: string }): PageSnapshot {
    const strip = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return {
      url: page.url,
      status: page.status,
      title: /<title>([^<]*)<\/title>/i.exec(page.html)?.[1] ?? "",
      text: strip(page.html),
      links: [...page.html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({ href: new URL(match[1]!, page.url).href, text: strip(match[2]!) })),
      forms: []
    };
  }

  async postForm(action: string, fields: Readonly<Record<string, string>>) {
    const result = await this.#navigate(action, { method: "POST", body: new URLSearchParams(fields) });
    return { url: result.url, status: result.status };
  }

  async goto(url: string) {
    return this.#snapshot(await this.#navigate(url, { method: "GET" }));
  }

  async click(selector: string) {
    const href = this.#page ? new RegExp(`<a[^>]*id="${selector.replace(/^#/, "")}"[^>]*href="([^"]+)"`).exec(this.#page.html)?.[1] : undefined;
    if (!href || !this.#page) throw new Error(`No link ${selector}`);
    return this.goto(new URL(href, this.#page.url).href);
  }

  async fill(): Promise<PageSnapshot> {
    if (!this.#page) throw new Error("No page");
    return this.#snapshot({ ...this.#page, status: 200 });
  }

  async submit(): Promise<PageSnapshot> {
    if (!this.#page) throw new Error("No page");
    return this.#snapshot({ ...this.#page, status: 200 });
  }

  async close() {
    this.#cookies.clear();
  }
}

export class FakeBrowser implements PoppyBrowser {
  readonly #fetcher: Fetcher;
  readonly contexts: FakeContext[] = [];

  constructor(fetcher: Fetcher) {
    this.#fetcher = fetcher;
  }

  async newContext(): Promise<BrowserContextHandle> {
    const context = new FakeContext(this.#fetcher);
    this.contexts.push(context);
    return context;
  }
}
