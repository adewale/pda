import { describe, expect, it } from "vitest";
import { CookieJar, decodeEntities, FetchBrowser } from "../src/poppy/fetch-browser";
import type { Fetcher } from "../src/poppy/fetch";

/**
 * The production browser's own rules, with stub fetchers. Browsing against
 * the mock Company, through the agent, is in `poppy.test.ts` ("5 web browsing").
 */

const allowAll = () => undefined;

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

describe("the fetch browser's cookie jar", () => {
  it("keeps cookies host-only, whatever their Domain says", () => {
    const jar = new CookieJar();
    jar.store(new URL("https://www.shop.example/"), ["a=1; Domain=shop.example; Path=/", "b=2; Path=/; Domain=elsewhere.example"]);
    expect(jar.header(new URL("https://www.shop.example/orders"))).toBe("a=1");
    expect(jar.header(new URL("https://shop.example/orders"))).toBe("");
    expect(jar.header(new URL("https://api.shop.example/orders"))).toBe("");
  });

  it("sends cookies only over HTTPS, and keeps none from plain HTTP", () => {
    const jar = new CookieJar();
    jar.store(new URL("http://shop.example/"), ["plain=1; Path=/"]);
    jar.store(new URL("https://shop.example/"), ["secure=1; Path=/; Secure", "open=1; Path=/"]);
    expect(jar.header(new URL("https://shop.example/"))).toBe("secure=1; open=1");
    expect(jar.header(new URL("http://shop.example/"))).toBe("");
  });

  it("honours Max-Age over Expires, and deletes with either", () => {
    let now = Date.parse("2026-10-11T12:00:00Z");
    const jar = new CookieJar(() => now);
    const url = new URL("https://shop.example/");
    jar.store(url, [
      "short=1; Path=/; Max-Age=60; Expires=Wed, 01 Jan 2031 00:00:00 GMT",
      "dated=1; Path=/; Expires=Sun, 11 Oct 2026 12:30:00 GMT",
      "past=1; Path=/; Expires=Thu, 01 Jan 2015 00:00:00 GMT",
      "session=1; Path=/"
    ]);
    expect(jar.header(url)).toBe("short=1; dated=1; session=1");
    now += 61_000;
    expect(jar.header(url)).toBe("dated=1; session=1");
    jar.store(url, ["session=1; Path=/; Max-Age=0"]);
    now += 30 * 60_000;
    expect(jar.header(url)).toBe("");
  });

  it("scopes a cookie to its path, by default the request's directory", () => {
    const jar = new CookieJar();
    jar.store(new URL("https://shop.example/account/login"), ["dir=1", "root=1; Path=/", "deep=1; Path=/account/orders"]);
    expect(jar.header(new URL("https://shop.example/account/orders/1"))).toBe("deep=1; dir=1; root=1");
    expect(jar.header(new URL("https://shop.example/account"))).toBe("dir=1; root=1");
    expect(jar.header(new URL("https://shop.example/accounts"))).toBe("root=1");
  });

  it("enforces the __Secure- and __Host- prefixes, and replaces a cookie of the same name", () => {
    const jar = new CookieJar();
    const url = new URL("https://shop.example/");
    jar.store(url, ["__Secure-a=1; Path=/", "__Host-b=1; Secure; Path=/; Domain=shop.example", "__Host-c=1; Secure; Path=/", "d=1; Path=/"]);
    jar.store(url, ["d=2; Path=/"]);
    expect(jar.header(url)).toBe("__Host-c=1; d=2");
  });
});

describe("the fetch browser", () => {
  it("decodes the character references HTMLRewriter leaves as written", () => {
    expect(decodeEntities("Fish &amp; chips &lt;3 &#169; &#x1F600; &nbsp;&unknown; &")).toBe("Fish & chips <3 © 😀  &unknown; &");
  });

  it("refuses plain HTTP and private hosts even when the Company's rules would allow them", async () => {
    const fetched: string[] = [];
    const browser = new FetchBrowser(async (request) => {
      fetched.push(request.url);
      return html("<p>no</p>");
    });
    const context = await browser.newContext(allowAll);
    await expect(context.goto("http://shop.example/")).rejects.toThrow("only loads HTTPS pages");
    await expect(context.goto("https://127.0.0.1/")).rejects.toThrow("non-public host");
    await expect(context.goto("https://localhost/")).rejects.toThrow("non-public host");
    expect(fetched).toEqual([]);
  });

  it("checks every redirect against the Company's rules", async () => {
    const fetched: string[] = [];
    const browser = new FetchBrowser(async (request) => {
      fetched.push(request.url);
      return new Response(null, { status: 302, headers: { Location: "https://other.example/" } });
    });
    const context = await browser.newContext((url) => {
      if (url.hostname !== "shop.example") throw new Error(`not ${url.hostname}`);
    });
    await expect(context.goto("https://shop.example/")).rejects.toThrow("not other.example");
    expect(fetched).toEqual(["https://shop.example/"]);
  });

  it("gives up on a page that takes too long", async () => {
    const hanging: Fetcher = (request) =>
      new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)));
    const context = await new FetchBrowser(hanging, { timeoutMs: 50 }).newContext(allowAll);
    await expect(context.goto("https://slow.example/")).rejects.toThrow("took longer than 0.05 s");
  });

  it("stops reading a streamed page at its limit", async () => {
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled++;
            controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
          }
        }),
        { headers: { "Content-Type": "text/html" } }
      );
    const context = await new FetchBrowser(async () => endless(), { maxBytes: 10_000 }).newContext(allowAll);
    await expect(context.goto("https://shop.example/")).rejects.toThrow("larger than 10000 bytes");
    expect(pulled).toBeLessThan(20);
  });

  it("sends nothing of ours with a page request: no credentials, no extra headers", async () => {
    const seen: Headers[] = [];
    const browser = new FetchBrowser(async (request) => {
      seen.push(request.headers);
      return html("<p>hello</p>", { "Set-Cookie": "sid=1; Path=/; Secure" });
    });
    const context = await browser.newContext(allowAll);
    await context.goto("https://shop.example/");
    await context.goto("https://shop.example/again");
    await context.goto("https://other.example/");
    expect(seen.map((headers) => [...headers.keys()].sort())).toEqual([["accept"], ["accept", "cookie"], ["accept"]]);
    expect(seen[1]!.get("cookie")).toBe("sid=1");
  });

  it("says when a page shows nothing without JavaScript, and doesn't show files that aren't pages", async () => {
    const pages: Record<string, Response> = {
      "https://shop.example/app": html('<div id="root"></div><script src="/app.js"></script><noscript>Enable JavaScript</noscript>'),
      "https://shop.example/file.pdf": new Response("%PDF-1.7", { headers: { "Content-Type": "application/pdf" } }),
      "https://shop.example/latin1": new Response(new Uint8Array([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9]), {
        headers: { "Content-Type": "text/html; charset=iso-8859-1" }
      })
    };
    const context = await new FetchBrowser(async (request) => pages[request.url]!).newContext(allowAll);
    expect((await context.goto("https://shop.example/app")).text).toBe("(This page shows nothing without JavaScript, which this browser doesn't run.)");
    expect((await context.goto("https://shop.example/file.pdf")).text).toBe("(A application/pdf file, which this browser doesn't show.)");
    expect((await context.goto("https://shop.example/latin1")).text).toBe("café");
  });
});
