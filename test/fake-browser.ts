/**
 * A fake Browser Run browser for read_url's renders (src/tools/render.ts),
 * so no test reaches Cloudflare. It plays a page load as a browser would
 * report it: the document request, then each request the page's markup and
 * scripts send, each handed to the page's request handler, which must
 * continue or abort it. It records every decision, the setup calls, the
 * dialogs and popups dismissed, and whether the browser was closed.
 */
import type { BrowserLauncher, RenderBrowser, RenderDialog, RenderPage, RenderRequest, RenderResponse } from "../src/tools/render";

/** What a URL does when the fake browser loads it. */
export type FakeRender = {
  /** The DOM after the page's scripts ran. */
  readonly html?: string;
  readonly status?: number;
  /** Requests the page sends after its document: images, scripts, a form a script posts, a beacon. */
  readonly requests?: readonly { readonly method: string; readonly url: string }[];
  /** A script's navigation to another address, after the page loaded. */
  readonly navigateTo?: string;
  /** The address the document came from; default a public one. */
  readonly remoteIp?: string;
  /** The page opens an alert, or a popup. */
  readonly dialog?: boolean;
  readonly popup?: boolean;
  /** The page never finishes loading, whatever the timeout. */
  readonly hang?: boolean;
};

/** One request the page sent, and what the agent's handler decided. */
export type FakeDecision = { readonly method: string; readonly url: string; readonly navigation: boolean; readonly decision: "continue" | "abort" | "not intercepted" };

/** One render: what was loaded, decided and closed. */
export type FakeRenderLog = {
  readonly url: string;
  readonly decisions: FakeDecision[];
  readonly setup: string[];
  dialogsDismissed: number;
  popupsClosed: number;
  contexts: number;
  closed: boolean;
};

export type FakeBrowserWeb = {
  readonly pages: Map<string, FakeRender>;
  readonly logs: FakeRenderLog[];
  launches: number;
  /** Launching takes this long (ms), or never finishes. */
  launchDelay?: number | "never";
};

export function fakeBrowserWeb(): FakeBrowserWeb {
  return { pages: new Map(), logs: [], launches: 0 };
}

type Handlers = { request: ((r: RenderRequest) => void)[]; response: ((r: RenderResponse) => void)[]; dialog: ((d: RenderDialog) => void)[]; popup: ((p: RenderPage | null) => void)[] };

function fakeResponse(url: string, status: number, ip: string): RenderResponse {
  return { url: () => url, status: () => status, headers: () => ({ "content-type": "text/html" }), remoteAddress: () => ({ ip, port: 443 }) };
}

function fakePage(web: FakeBrowserWeb, log: () => FakeRenderLog, setup: string[]): RenderPage {
  const handlers: Handlers = { request: [], response: [], dialog: [], popup: [] };
  let intercepting = false;
  let current = "about:blank";
  let html = "";
  /** Hand one request to the handlers; resolves with the decision once one is made. */
  const send = async (method: string, url: string, navigation: boolean): Promise<FakeDecision["decision"]> => {
    let decided: (decision: "continue" | "abort") => void = () => undefined;
    const decision = new Promise<"continue" | "abort">((resolve) => (decided = resolve));
    const request: RenderRequest = {
      method: () => method,
      url: () => url,
      isNavigationRequest: () => navigation,
      abort: async () => decided("abort"),
      continue: async () => decided("continue")
    };
    if (!intercepting) {
      log().decisions.push({ method, url, navigation, decision: "not intercepted" });
      return "not intercepted";
    }
    for (const handler of handlers.request) handler(request);
    const made = await decision;
    log().decisions.push({ method, url, navigation, decision: made });
    return made;
  };
  const page: RenderPage = {
    async setRequestInterception(on) {
      intercepting = on;
      setup.push(`interception ${on ? "on" : "off"}`);
    },
    async setBypassServiceWorker(bypass) {
      setup.push(`bypass service workers ${bypass}`);
    },
    async evaluateOnNewDocument(source) {
      setup.push(`script before the page's own: ${["WebSocket", "RTCPeerConnection", "Worker", "sendBeacon", "open"].filter((name) => source.includes(name)).join(", ")}`);
      return undefined;
    },
    async createCDPSession() {
      return {
        async send(method: string, params?: object) {
          setup.push(`${method} ${JSON.stringify(params ?? {})}`);
          return {};
        }
      };
    },
    on(event: keyof Handlers, handler: (value: never) => void) {
      (handlers[event] as unknown[]).push(handler);
      return page;
    },
    async goto(url) {
      const spec = web.pages.get(url);
      if (spec?.hang) return new Promise<never>(() => undefined);
      if ((await send("GET", url, true)) === "abort") throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`);
      current = url;
      const status = spec ? (spec.status ?? 200) : 502;
      html = spec?.html ?? "";
      for (const request of spec?.requests ?? []) await send(request.method, request.url, false);
      if (spec?.dialog) {
        for (const handler of handlers.dialog) handler({ dismiss: async () => void log().dialogsDismissed++ });
      }
      if (spec?.popup) {
        const popup = { close: async () => void log().popupsClosed++ } as unknown as RenderPage;
        for (const handler of handlers.popup) handler(popup);
      }
      const response = fakeResponse(url, status, spec?.remoteIp ?? "203.0.114.10");
      for (const handler of handlers.response) handler(response);
      if (spec?.navigateTo && (await send("GET", spec.navigateTo, true)) !== "abort") {
        current = spec.navigateTo;
        html = web.pages.get(spec.navigateTo)?.html ?? html;
      }
      return response;
    },
    async waitForNetworkIdle() {},
    async content() {
      return html;
    },
    url: () => current,
    async close() {}
  };
  return page;
}

/** A launcher for the fake: each launch is a new browser, logged. */
export function fakeLauncher(web: FakeBrowserWeb): BrowserLauncher {
  return async () => {
    web.launches++;
    if (web.launchDelay === "never") await new Promise<never>(() => undefined);
    if (typeof web.launchDelay === "number") await new Promise((resolve) => setTimeout(resolve, web.launchDelay as number));
    const setup: string[] = [];
    let log: FakeRenderLog | undefined;
    const logOf = () => {
      if (!log) throw new Error("no page");
      return log;
    };
    const browser: RenderBrowser = {
      async createBrowserContext() {
        return {
          async newPage() {
            const page = fakePage(web, logOf, setup);
            const goto = page.goto.bind(page);
            page.goto = async (url, options) => {
              log = { url, decisions: [], setup, dialogsDismissed: 0, popupsClosed: 0, contexts: 1, closed: false };
              web.logs.push(log);
              return goto(url, options);
            };
            return page;
          }
        };
      },
      async close() {
        if (log) log.closed = true;
        else web.logs.push({ url: "", decisions: [], setup, dialogsDismissed: 0, popupsClosed: 0, contexts: 0, closed: true });
      }
    };
    return browser;
  };
}
