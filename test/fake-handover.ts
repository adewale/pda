/**
 * A fake Browser Run browser for handing control to the User
 * (src/poppy/handover.ts), so no test reaches Cloudflare. It records what
 * the agent gave it (cookies, the page, the domain `navigator.poppy` is for)
 * and whether it closed; a test plays the User through `userRequest`, which
 * sends a request with the browser's cookies, as the User's clicks would.
 */
import type { BrowserCookie } from "../src/poppy/browser";
import type { HandoverBrowser, HandoverLauncher } from "../src/poppy/handover";

/** One browser the agent launched, as the test sees it. */
export type FakeHandoverBrowser = {
  readonly sessionId: string;
  readonly domain: string;
  url: string | null;
  cookies: BrowserCookie[];
  /** Pages opened, oldest first. */
  readonly opened: string[];
  /** The domains `navigator.poppy` was given for: at the first page, then after each reconnect. */
  readonly scripts: string[];
  views: number;
  closed: boolean;
};

export type FakeHandoverWeb = {
  readonly browsers: FakeHandoverBrowser[];
  /** As `BROWSER_RUN` off, or the binding missing: no launcher at all. */
  off: boolean;
  /** Launching fails, as Browser Run out of capacity would. */
  failLaunch: boolean;
};

export function fakeHandoverWeb(): FakeHandoverWeb {
  return { browsers: [], off: false, failLaunch: false };
}

/** A live view link's life, as Browser Run's default. */
export const FAKE_LIVE_VIEW_MS = 300_000;

function wrap(state: FakeHandoverBrowser): HandoverBrowser {
  return {
    sessionId: state.sessionId,
    async open(url, cookies, domain) {
      state.cookies = cookies.map((cookie) => ({ ...cookie }));
      state.scripts.push(domain);
      state.opened.push(url);
      state.url = url;
    },
    async restore(domain) {
      state.scripts.push(domain);
    },
    async liveView(now) {
      state.views += 1;
      return { url: `https://live.browser-run.test/${state.sessionId}/${state.views}`, expiresAt: now + FAKE_LIVE_VIEW_MS };
    },
    async currentUrl() {
      return state.url;
    },
    async close() {
      state.closed = true;
    }
  };
}

export function fakeHandoverLauncher(web: FakeHandoverWeb): HandoverLauncher {
  return {
    async launch(domain) {
      if (web.failLaunch) throw new Error("No browsers available");
      const state: FakeHandoverBrowser = { sessionId: `brs_${web.browsers.length + 1}`, domain, url: null, cookies: [], opened: [], scripts: [], views: 0, closed: false };
      web.browsers.push(state);
      return wrap(state);
    },
    async connect(sessionId) {
      const state = web.browsers.find((browser) => browser.sessionId === sessionId);
      return state && !state.closed ? wrap(state) : null;
    }
  };
}

/** The browser's `Cookie` header for `url`: its host-only cookies for that host, its domain cookies for that host and below (RFC 6265 5.4). */
export function cookieHeader(cookies: readonly BrowserCookie[], url: string): string {
  const { hostname, pathname } = new URL(url);
  return cookies
    .filter((cookie) => (cookie.hostOnly ? hostname === cookie.host : hostname === cookie.host || hostname.endsWith(`.${cookie.host}`)) && pathname.startsWith(cookie.path))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
