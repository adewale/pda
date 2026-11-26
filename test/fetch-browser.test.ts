import { describe, expect, it } from "vitest";
import { CookieJar, decodeEntities, FetchBrowser } from "../src/poppy/fetch-browser";
import type { Fetcher } from "../src/poppy/fetch";
import { answerOf } from "../src/poppy/client";
import { workerPorts } from "../src/validator/fetch";

/**
 * The production browser's own rules, with stub fetchers. Browsing against
 * the mock Company, through the agent, is in `poppy.test.ts` ("5 web browsing").
 */

const allowAll = () => undefined;

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

describe("the fetch browser's cookie jar", () => {
  it("leaves a form a Worker refused to send, on a port it won't honour, marked as never sent", async () => {
    let sent = 0;
    const context = await new FetchBrowser(workerPorts(async () => {
      sent++;
      return new Response("ok");
    })).newContext(allowAll);
    const failure = await context
      .submit({ from: "https://shop.example/", method: "POST", action: "https://shop.example:9443/order", enctype: "application/x-www-form-urlencoded", fields: [] })
      .then(() => undefined, (error: unknown) => error);
    expect(String(failure)).toContain("a Cloudflare Worker can't fetch port 9443");
    // Marked "none", it would read as possibly received and leave an unknown outcome.
    expect(answerOf(failure)).toBeUndefined();
    expect(sent).toBe(0);
  });

  it("keeps cookies host-only, whatever their Domain says", () => {
    const jar = new CookieJar();
    jar.store(new URL("https://www.shop.example/"), ["a=1; Domain=shop.example; Path=/", "b=2; Path=/; Domain=elsewhere.example"]);
    expect(jar.header(new URL("https://www.shop.example/orders"))).toBe("a=1");
    expect(jar.header(new URL("https://shop.example/orders"))).toBe("");
    expect(jar.header(new URL("https://api.shop.example/orders"))).toBe("");
  });

  it("lets a cookie's Domain cover the Company's hosts, and only at or under the Company's domain (0.4, 6)", () => {
    const jar = new CookieJar(Date.now, ["shop.example"]);
    jar.store(new URL("https://accounts.shop.example/poppy/browser-session"), [
      "session=1; Domain=shop.example; Path=/; Secure",
      "wide=1; Domain=example; Path=/; Secure",
      "__Host-join=1; Path=/; Secure"
    ]);
    expect(jar.header(new URL("https://www.shop.example/orders"))).toBe("session=1");
    expect(jar.header(new URL("https://shop.example/"))).toBe("session=1");
    expect(jar.header(new URL("https://accounts.shop.example/poppy/browser-session"))).toBe("session=1; wide=1; __Host-join=1");
    expect(jar.header(new URL("https://other.example/"))).toBe("");
    expect(jar.header(new URL("https://shop.example.evil.test/"))).toBe("");
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
    await expect(context.goto("https://shop.example/")).rejects.toThrow("https://shop.example: expected a page of at most 10000 bytes, got a larger one");
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

  it("keeps the final response's Poppy-Operation for the agent's own code, and none from a redirect on the way (0.4 Ops 4)", async () => {
    const pages: Record<string, () => Response> = {
      "https://shop.example/hop": () => new Response(null, { status: 302, headers: { Location: "/waiting", "Poppy-Operation": 'sid="s", ref="from-redirect"' } }),
      "https://shop.example/waiting": () => html("<p>Waiting</p>", { "Poppy-Operation": 'sid="s", ref="final"' }),
      "https://shop.example/plain": () => html("<p>Plain</p>")
    };
    const context = await new FetchBrowser(async (request) => pages[request.url]!()).newContext(allowAll);
    expect((await context.goto("https://shop.example/hop")).operationHeader).toBe('sid="s", ref="final"');
    expect(await context.goto("https://shop.example/plain")).not.toHaveProperty("operationHeader");
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

describe("steps a website marks for the User (0.4 Browser Control 4, 5)", () => {
  const page = `
<form id="checkin" method="post" action="/check-in" data-poppy-user-step="submission">
  <select name="seat"><option value="12A">12A<option value="12C" selected>12C</select>
  <input id="traveller" name="traveller_name" data-poppy-user-step="interaction">
  <input id="note" name="note" data-poppy-user-step="SUBMISSION">
  <button type="submit">Check in</button>
</form>
<form id="hands-off" method="post" action="/upgrade" data-poppy-user-step="interaction"><input name="cabin"><button>Upgrade</button></form>
<form id="odd" method="post" action="/odd" data-poppy-user-step="later"><input name="x"><button>Go</button></form>
<form id="plain" method="post" action="/plain"><input name="y"><button id="pay" data-poppy-user-step="submission">Pay</button></form>
<a id="terms" href="/terms" data-poppy-user-step="interaction">Accept</a>
<a id="help" href="/help">Help</a>`;

  async function opened() {
    const context = await new FetchBrowser(async (request) => (new URL(request.url).pathname === "/" ? html(page) : html("<p>Next</p>"))).newContext(allowAll);
    return { context, snapshot: await context.goto("https://air.example/") };
  }
  const refused = (what: Promise<unknown>) => expect(what).rejects.toMatchObject({ code: "user_step" });

  it("shows the marks: a value other than the two, or submission on a control, counts as interaction", async () => {
    const { snapshot } = await opened();
    expect(snapshot.forms.map(({ selector, userStep, userFields }) => ({ selector, userStep, userFields }))).toEqual([
      { selector: "#checkin", userStep: "submission", userFields: ["traveller_name", "note"] },
      { selector: "#hands-off", userStep: "interaction", userFields: undefined },
      { selector: "#odd", userStep: "interaction", userFields: undefined },
      { selector: "#plain", userStep: undefined, userFields: undefined }
    ]);
    expect(snapshot.links.map(({ selector, userStep }) => ({ selector, userStep }))).toEqual([
      { selector: "#terms", userStep: "interaction" },
      { selector: "#help", userStep: undefined }
    ]);
  });

  it("fills a submission form's unmarked fields, but neither its marked ones nor any of an interaction form", async () => {
    const { context } = await opened();
    await context.fill("#checkin [name=seat]", "12A");
    await refused(context.fill("#traveller", "Ada Lovelace"));
    await refused(context.fill("#note", "window"));
    await refused(context.fill("#hands-off [name=cabin]", "business"));
    await refused(context.fill("#odd [name=x]", "1"));
    await context.fill("#plain [name=y]", "1");
  });

  it("submits no marked form, nor through a marked button, and follows no marked link", async () => {
    const { context } = await opened();
    for (const form of ["#checkin", "#hands-off", "#odd", "#plain"]) await refused(context.prepareSubmit(form));
    await refused(context.click("#terms"));
    expect((await context.click("#help")).text).toBe("Next");
  });
});

describe("what the browser says when a selector or value doesn't fit the page", () => {
  const page = `
<form id="a" method="post" action="/a">
  <select name="size"><option>Small<option>Large</select>
  <input type="radio" name="colour" value="red"><input type="radio" name="colour" value="blue">
  <input name="note">
</form>
<form id="b" method="post" action="/b"><input name="note"></form>
<a id="js" href="javascript:void(0)">Open</a>`;

  async function opened() {
    const context = await new FetchBrowser(async () => html(page)).newContext(allowAll);
    await context.goto("https://shop.example/");
    return context;
  }

  it("names the choices a field has beside the value it was given", async () => {
    const context = await opened();
    await expect(context.fill("size", "Huge")).rejects.toMatchObject({ code: "invalid_request", message: 'the field "size": expected one of its options, "Small" or "Large", got "Huge"' });
    await expect(context.fill("colour", "green")).rejects.toMatchObject({ code: "invalid_request", message: 'the field "colour": expected one of its choices, "red" or "blue", got "green"' });
  });

  it("says how to name a field that is in more than one form, and why a link it can't follow is refused", async () => {
    const context = await opened();
    await expect(context.fill("note", "x")).rejects.toMatchObject({
      code: "invalid_request",
      message: 'the field "note": expected a field in one form, got fields in 2 forms. Put the form\'s selector first, as in "#a note"'
    });
    await expect(context.click("#js")).rejects.toMatchObject({
      code: "refused",
      message: "the link \"#js\": expected an http or https link, got a javascript: link. It needs JavaScript or another app, which this browser doesn't have"
    });
  });
});
