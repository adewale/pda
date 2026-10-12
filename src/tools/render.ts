/**
 * Rendering a page that needs JavaScript, for `read_url`, in Cloudflare
 * Browser Run: a fresh browser and an incognito context for each read,
 * closed in a `finally`. Read only: every request the page makes passes
 * `allowBrowserRequest` (GET or HEAD, https, a public host on the standard
 * port) or is aborted; a response from an address that isn't public spoils
 * the read; dialogs are dismissed, downloads denied, popups closed, and the
 * channels request interception can't see (WebSocket, WebRTC, WebTransport,
 * workers) are taken away before the page's scripts run. Nothing types,
 * clicks or submits: load, wait at most 10 seconds for the network to go
 * quiet, then read the DOM. The HTML goes through read_url's own reader,
 * fence and cut.
 *
 * The browser comes through a `BrowserLauncher`, the agent's
 * `browserRenderer()` seam: production launches `@cloudflare/puppeteer` on
 * the `BROWSER` binding; tests hand in a fake (test/fake-browser.ts), so no
 * test reaches Browser Run.
 */
import { readBrowserRun } from "../config";
import { isPublicAddress } from "../validator/address";
import { raceAbort, withDeadline } from "../validator/fetch";
import { cutText, READ_LIMITS, ReadError, readableText, urlProblem, type PageKind, type PageRead } from "./web";

export const RENDER_LIMITS = {
  /** For the whole render: launching, loading, waiting and reading. */
  timeoutMs: 20_000,
  /** The longest wait for the network to go quiet after the page has loaded. */
  settleMs: 10_000,
  /** Quiet means no request for this long. */
  idleMs: 500,
  /** Renders an hour, per agent, apart from read_url's 30 reads a minute. */
  perHour: 10,
  /** The longest wait for the browser to close before the read returns anyway. */
  closeMs: 5_000
} as const;

/** Under this many characters of readable text, an HTML page with a script is taken to need JavaScript. */
export const EMPTY_SHELL_CHARS = 200;

/**
 * Whether a plain read looks like an empty shell that a script fills in: an
 * HTML page with at least one `<script>` and fewer than 200 characters of
 * readable text (links, navigation, footers and `<noscript>` left out, as
 * the reader leaves them out). Text, JSON and XML never need it.
 */
export function needsJavaScript(page: { readonly kind: PageKind | null; readonly textChars: number; readonly scripts: number }): boolean {
  return page.kind === "html" && page.scripts > 0 && page.textChars < EMPTY_SHELL_CHARS;
}

/** Schemes a page may use without the network. */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);

/**
 * Whether the rendering browser may send a request: only GET and HEAD,
 * only https to a public host on the standard port with no credentials in
 * the URL (read_url's own `urlProblem`), or a `data:`, `blob:` or `about:`
 * URL, which never leaves the browser. Everything else is aborted: a form
 * post, a script's POST, PUT or DELETE, plain http, a private host, a
 * redirect to one. Pure, so its decisions are tested one by one.
 */
export function allowBrowserRequest(method: string, url: string): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return { allowed: false, reason: `${verb} isn't sent: rendering is read only` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "not a URL" };
  }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return { allowed: true };
  const problem = urlProblem(parsed);
  return problem ? { allowed: false, reason: problem } : { allowed: true };
}

// ---------------------------------------------------------------- The browser, as much of it as a read uses

/** The parts of `@cloudflare/puppeteer` a render uses, so a test can supply a fake. */
export interface RenderRequest {
  method(): string;
  url(): string;
  isNavigationRequest(): boolean;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
export interface RenderResponse {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  remoteAddress(): { ip?: string; port?: number };
}
export interface RenderDialog {
  dismiss(): Promise<void>;
}
export interface RenderPage {
  setRequestInterception(on: boolean): Promise<void>;
  setBypassServiceWorker(bypass: boolean): Promise<void>;
  evaluateOnNewDocument(source: string): Promise<unknown>;
  createCDPSession(): Promise<{ send(method: string, params?: object): Promise<unknown> }>;
  on(event: "request", handler: (request: RenderRequest) => void): unknown;
  on(event: "response", handler: (response: RenderResponse) => void): unknown;
  on(event: "dialog", handler: (dialog: RenderDialog) => void): unknown;
  on(event: "popup", handler: (page: RenderPage | null) => void): unknown;
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<RenderResponse | null>;
  waitForNetworkIdle(options: { idleTime: number; timeout: number }): Promise<void>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}
export interface RenderContext {
  newPage(): Promise<RenderPage>;
}
export interface RenderBrowser {
  createBrowserContext(): Promise<RenderContext>;
  close(): Promise<void>;
}
/** A new browser, for one read. */
export type BrowserLauncher = () => Promise<RenderBrowser>;

/** Whether this deployment renders: `BROWSER_RUN` on (a value other than on or off is a config error) and the `BROWSER` binding present. */
export function renderAvailability(env: { readonly BROWSER_RUN?: unknown; readonly BROWSER?: unknown }): "on" | "off" | "no binding" {
  if (readBrowserRun(env) === "off") return "off";
  return env.BROWSER ? "on" : "no binding";
}

/** Production's launcher: `@cloudflare/puppeteer` on the binding, loaded only when a page is rendered. */
export function puppeteerLauncher(binding: BrowserRun): BrowserLauncher {
  return async () => {
    const { default: puppeteer } = await import("@cloudflare/puppeteer");
    // No keep_alive and no session reuse: each read gets its own browser, closed when it is done.
    const browser = await puppeteer.launch(binding);
    // Puppeteer's typed event emitter is wider than RenderPage's four events; the methods used are the same.
    return browser as unknown as RenderBrowser;
  };
}

/**
 * Taken from every channel interception can't see, before the page's own
 * scripts run: sockets, peer connections and workers (whose requests may
 * not reach the page's interception), `window.open` and `sendBeacon`.
 */
const LOCKDOWN = `(() => {
  const gone = ["WebSocket", "WebSocketStream", "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport", "Worker", "SharedWorker"];
  for (const name of gone) { try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }); } catch {} }
  try { Object.defineProperty(window, "open", { value: () => null, configurable: false, writable: false }); } catch {}
  try { Object.defineProperty(Navigator.prototype, "sendBeacon", { value: () => false, configurable: false, writable: false }); } catch {}
  try { Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => undefined, configurable: false }); } catch {}
})();`;

export type RenderedPage = {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly html: string;
  /** Whether the DOM was longer than read_url's 1 MB and cut. */
  readonly htmlCut: boolean;
  /** Requests refused by `allowBrowserRequest`. */
  readonly blocked: number;
};

/** `promise`, but no longer than `ms`: for closing a browser that may not answer. */
function atMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
  ]).finally(() => clearTimeout(timer));
}

/**
 * Load `raw` in a new browser and return its DOM after scripts ran. Throws
 * only `ReadError`. The browser is closed in a `finally`, after a timeout
 * too, and a browser that arrives after the deadline is closed as it arrives.
 */
export async function renderPage(
  launch: BrowserLauncher,
  raw: string,
  options: { readonly timeoutMs?: number; readonly settleMs?: number } = {}
): Promise<RenderedPage> {
  const timeoutMs = options.timeoutMs ?? RENDER_LIMITS.timeoutMs;
  const settleMs = options.settleMs ?? RENDER_LIMITS.settleMs;
  let start: URL;
  try {
    start = new URL(raw);
  } catch {
    throw new ReadError(`${JSON.stringify(raw)} isn't a URL`);
  }
  const problem = urlProblem(start);
  if (problem) throw new ReadError(problem);
  try {
    return await withDeadline(timeoutMs, async (signal) => {
      const launching = launch();
      let browser: RenderBrowser;
      try {
        browser = await raceAbort(launching, signal);
      } catch (error) {
        // Close a browser that turns up after we stopped waiting for it.
        void launching.then((late) => late.close()).catch(() => undefined);
        if (signal.aborted) throw error;
        throw new ReadError("Couldn't start a browser to render the page");
      }
      try {
        const context = await raceAbort(browser.createBrowserContext(), signal);
        const page = await raceAbort(context.newPage(), signal);
        let blocked = 0;
        let privateAddress: string | null = null;
        await raceAbort(page.setBypassServiceWorker(true), signal);
        const cdp = await raceAbort(page.createCDPSession(), signal);
        await raceAbort(cdp.send("Page.setDownloadBehavior", { behavior: "deny" }), signal);
        await raceAbort(cdp.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] }), signal);
        await raceAbort(page.evaluateOnNewDocument(LOCKDOWN), signal);
        page.on("request", (request) => {
          const decision = allowBrowserRequest(request.method(), request.url());
          if (decision.allowed) {
            request.continue().catch(() => undefined);
          } else {
            blocked++;
            request.abort("blockedbyclient").catch(() => undefined);
          }
        });
        page.on("response", (response) => {
          // A public name that resolved to a private address (DNS rebinding): nothing from it reaches the model.
          const ip = response.remoteAddress().ip;
          if (ip && !isPublicAddress(ip) && privateAddress === null) privateAddress = `${new URL(response.url()).hostname} (${ip})`;
        });
        page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
        page.on("popup", (popup) => void popup?.close().catch(() => undefined));
        // Handlers first, then interception, so no request waits with nobody to decide it.
        await raceAbort(page.setRequestInterception(true), signal);

        let response: RenderResponse | null;
        try {
          response = await raceAbort(page.goto(start.href, { waitUntil: "domcontentloaded", timeout: timeoutMs }), signal);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new ReadError(`The browser couldn't load ${start.href}${blocked > 0 ? " (the page or a redirect wasn't one read_url may request)" : ""}`);
        }
        // Wait for the scripts' requests to settle, but never long: a page that keeps polling is read as it is.
        await raceAbort(
          page.waitForNetworkIdle({ idleTime: RENDER_LIMITS.idleMs, timeout: settleMs }).catch(() => undefined),
          signal
        );
        const status = response?.status() ?? 0;
        if (status < 200 || status > 299) throw new ReadError(`${start.href} answered HTTP ${status} in the browser`);
        if (privateAddress) throw new ReadError(`${privateAddress} isn't a public address, so the rendered page isn't read`);
        const finalUrl = page.url();
        let final: URL;
        try {
          final = new URL(finalUrl);
        } catch {
          throw new ReadError(`The browser ended at ${finalUrl}, which isn't read`);
        }
        const moved = urlProblem(final);
        if (moved) throw new ReadError(`The browser ended at ${final.href}, which isn't read: ${moved}`);
        const dom = await raceAbort(page.content(), signal);
        const htmlCut = dom.length > READ_LIMITS.maxBytes;
        return { url: start.href, finalUrl: final.href, status, html: htmlCut ? dom.slice(0, READ_LIMITS.maxBytes) : dom, htmlCut, blocked };
      } finally {
        await atMost(browser.close(), RENDER_LIMITS.closeMs);
      }
    });
  } catch (error) {
    if (error instanceof ReadError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") throw new ReadError(`Rendering ${start.host} took longer than ${timeoutMs / 1000} seconds`);
    throw new ReadError(`Couldn't render ${start.href}`);
  }
}

/** A rendered page as read_url gives it: the same reader and cut as a plain read. */
export async function renderedRead(rendered: RenderedPage, maxChars: number = READ_LIMITS.maxChars): Promise<PageRead> {
  const page = await readableText(rendered.html, new URL(rendered.finalUrl));
  const shown = cutText(page.text, maxChars);
  return {
    url: rendered.url,
    finalUrl: rendered.finalUrl,
    status: rendered.status,
    contentType: "text/html",
    bytes: new TextEncoder().encode(rendered.html).byteLength,
    bytesCut: rendered.htmlCut,
    title: page.title,
    text: shown.text,
    characters: page.text.length,
    truncated: shown.truncated || rendered.htmlCut,
    textChars: page.textChars,
    scripts: page.scripts,
    via: "browser",
    blocked: rendered.blocked
  };
}

// ---------------------------------------------------------------- The render limit

const SCHEMA = `CREATE TABLE IF NOT EXISTS read_url_renders (at INTEGER NOT NULL)`;

/**
 * At most `limit` renders in any hour, per agent, in the agent's SQLite.
 * read_url's 30 reads a minute live in memory, because an evicted agent
 * starting a fresh minute costs a site a few requests; renders cost the
 * operator browser time, so their count survives an eviction.
 */
export class RenderLimiter {
  constructor(
    readonly sql: SqlStorage,
    readonly now: () => number,
    readonly limit: number = RENDER_LIMITS.perHour
  ) {
    sql.exec(SCHEMA);
  }

  /** Seconds until the next render is allowed, or 0 and the render counted. */
  take(): number {
    const now = this.now();
    this.sql.exec("DELETE FROM read_url_renders WHERE at <= ?", now - 3_600_000);
    const rows = this.sql.exec("SELECT at FROM read_url_renders ORDER BY at").toArray() as { at: number }[];
    if (rows.length >= this.limit) return Math.max(1, Math.ceil((rows[0]!.at + 3_600_000 - now) / 1000));
    this.sql.exec("INSERT INTO read_url_renders (at) VALUES (?)", now);
    return 0;
  }
}
