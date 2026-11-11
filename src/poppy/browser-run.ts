/**
 * The handover browser in production: Cloudflare Browser Run through
 * `@cloudflare/puppeteer`, loaded only when the User takes control
 * (handover.ts). Nothing here decides anything; tests hand in a fake
 * launcher (test/fake-handover.ts), so no test reaches Browser Run.
 */
import type { BrowserCookie } from "./browser";
import { controllerScript, type HandoverBrowser, type HandoverLauncher } from "./handover";

/** How long Browser Run keeps a browser with nothing connected: its maximum, 10 minutes. */
const KEEP_ALIVE_MS = 600_000;
/** A live view link's life: Browser Run's default, 5 minutes. */
const LIVE_VIEW_MS = 300_000;
const LOAD_MS = 20_000;

/** The parts of a puppeteer page the handover uses. */
type Page = {
  setCookie(...cookies: object[]): Promise<void>;
  evaluateOnNewDocument(source: string): Promise<unknown>;
  evaluate(source: string): Promise<unknown>;
  createCDPSession(): Promise<{ send(method: string, params?: object): Promise<unknown> }>;
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  on(event: "popup", handler: (page: { close(): Promise<void> } | null) => void): unknown;
  url(): string;
};
type Browser = { sessionId(): string; pages(): Promise<Page[]>; newPage(): Promise<Page>; close(): Promise<void> };

/** A cookie as CDP sets it: a host-only one by URL, a domain one by its domain (RFC 6265 5.3). */
function cookieParam(cookie: BrowserCookie): object {
  return {
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? { url: `https://${cookie.host}${cookie.path}` } : { domain: `.${cookie.host}` }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.expires !== undefined ? { expires: Math.floor(cookie.expires / 1000) } : {})
  };
}

function wrap(browser: Browser): HandoverBrowser {
  const page = async () => (await browser.pages())[0] ?? (await browser.newPage());
  return {
    sessionId: browser.sessionId(),
    async open(url, cookies, domain) {
      const tab = await page();
      const cdp = await tab.createCDPSession();
      // Nothing the User downloads would reach them from a remote browser.
      await cdp.send("Page.setDownloadBehavior", { behavior: "deny" });
      // A window the page opens wouldn't be in the User's live view, which shows one tab.
      tab.on("popup", (popup) => void popup?.close().catch(() => undefined));
      if (cookies.length > 0) await tab.setCookie(...cookies.map(cookieParam));
      await tab.evaluateOnNewDocument(controllerScript(domain));
      await tab.goto(url, { waitUntil: "domcontentloaded", timeout: LOAD_MS }).catch(() => undefined);
    },
    async restore(domain) {
      const tab = await page();
      await tab.evaluateOnNewDocument(controllerScript(domain));
      await tab.evaluate(controllerScript(domain)).catch(() => undefined);
    },
    async liveView(now) {
      const cdp = await (await page()).createCDPSession();
      const view = (await cdp.send("Cloudflare.getLiveView", { mode: "tab", expiresInMs: LIVE_VIEW_MS })) as { devtoolsFrontendUrl?: unknown };
      if (typeof view.devtoolsFrontendUrl !== "string") throw new Error("Browser Run gave no live view");
      return { url: view.devtoolsFrontendUrl, expiresAt: now + LIVE_VIEW_MS };
    },
    async currentUrl() {
      return (await page()).url();
    },
    async close() {
      await browser.close();
    }
  };
}

/**
 * A launcher on the `BROWSER` binding. Browser Run's guardrails keep the
 * browser to the Company's domain and the common CDNs its pages load from,
 * whoever drives it.
 */
export function browserRunHandover(binding: BrowserRun): HandoverLauncher {
  const puppeteer = async () => (await import("@cloudflare/puppeteer")).default;
  return {
    async launch(domain) {
      const browser = await (await puppeteer()).launch(binding, {
        keep_alive: KEEP_ALIVE_MS,
        guardrails: { allowedDomains: [domain, `*.${domain}`], allowedDomainSets: ["common-cdns"] }
      });
      return wrap(browser as unknown as Browser);
    },
    async connect(sessionId) {
      try {
        return wrap((await (await puppeteer()).connect(binding, sessionId)) as unknown as Browser);
      } catch {
        // Closed, or past its keep_alive: gone.
        return null;
      }
    }
  };
}
