import { describe, expect, it } from "vitest";
import { pieces, shortSegment, urlParts } from "../src/rich-text";
import { handleValidator, type ValidatorHttpOptions } from "../src/validator/http";
import { resultPage } from "../src/validator/html";
import { codeSpan, reportMarkdown } from "../src/validator/markdown";
import { validateCompany, validateText } from "../src/validator/index";
import { named } from "./named-fetcher.ts";

/**
 * How reports are laid out: a long URL never overflows the results page, a
 * departure is shown as its subject and its two sides, and the same report
 * reads as Markdown that can't be turned into links or markup by what a
 * Company served.
 */

const SIGN_IN = "https://login.example-idp.com/app/example_idp_production_tenant_1/exk7g3v8a0D8kEuzr4h7/sso/saml?SAMLRequest=fVLRctow&RelayState=https%3A%2F%2Fexample.com";

/** A signed-out Company whose catch-all sends its protected resource metadata to a sign-in page on another host. */
function catchAll() {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" } });
  const routes: Record<string, () => Response> = {
    "https://example.com/.well-known/poppy.json": () =>
      json({ protocol_version: "1.0", organization: { name: "Example Company", domain: "example.com" }, agent: { protocols: [{ type: "poppy", endpoint: "https://agents.example.net/poppy", description: "Claims" }] } }),
    "https://example.com/.well-known/oauth-protected-resource": () => new Response(null, { status: 302, headers: { Location: SIGN_IN } }),
    [SIGN_IN]: () => new Response("<!DOCTYPE html><html><body>Sign in</body></html>", { headers: { "Content-Type": "text/html" } })
  };
  return named(async (request) => {
    const route = routes[request.url];
    if (!route) throw new TypeError("fetch failed");
    return route();
  });
}

describe("rich text", () => {
  it("finds each URL in shown text, leaving a sentence's punctuation and keeping an elided query", () => {
    expect(pieces("got a page at https://a.example/x?…, on another host.")).toEqual([
      { kind: "text", text: "got a page at " },
      { kind: "url", url: "https://a.example/x?…" },
      { kind: "text", text: ", on another host." }
    ]);
    expect(pieces('"https://a.example/" and (https://b.example).').map((piece) => piece.kind)).toEqual(["text", "url", "text", "url", "text"]);
    expect(pieces("no URL here")).toEqual([{ kind: "text", text: "no URL here" }]);
  });

  it("splits a URL into scheme, host, segments and what follows, and shortens a long segment in its middle", () => {
    expect(urlParts("https://a.example/one/two?…")).toEqual({ scheme: "https://", host: "a.example", segments: ["one", "two"], suffix: "?…" });
    expect(urlParts("https://a.example")).toEqual({ scheme: "https://", host: "a.example", segments: [], suffix: "" });
    expect(urlParts("not a url")).toBeNull();
    expect(shortSegment("exk7g3v8a0D8kEuzr4h7")).toBe("exk7g3v8a0D8kEuzr4h7");
    expect(shortSegment("example_idp_production_tenant_1")).toBe("example_idp_prod…enant_1");
  });
});

describe("the results page", () => {
  it("sets a long URL as a breakable value, its host in bold and a long segment shortened, with the whole in the tooltip", async () => {
    const page = resultPage(await validateCompany(catchAll(), "example.com"), { url: "example.com" });
    // The header: where the redirects led, without the sign-in request, and the whole URL a click away.
    expect(page).toContain('→ <code class="url" title="https://login.example-idp.com/app/example_idp_production_tenant_1/exk7g3v8a0D8kEuzr4h7/sso/saml?…">https://<b>login.example-idp.com</b>/<wbr>app/<wbr>example_idp_prod…enant_1/<wbr>exk7g3v8a0D8kEuzr4h7/<wbr>sso/<wbr>saml<wbr>?<wbr>…</code>');
    expect(page).toMatch(/<details class="full"><summary>The whole URL<\/summary><code class="url">https:\/<wbr>\/<wbr>login\.example-idp\.com\/<wbr>.*SAMLRequest=<wbr>fVLRctow&#38;<wbr>RelayState=<wbr>/);
    // Nowhere else: not in a message, not unbroken.
    expect(page.replace(/<details class="full">.*?<\/details>/s, "")).not.toContain("SAMLRequest");
  });

  it("shows a departure as its subject, then expected and got apart, then what follows, saying each value once", async () => {
    const failing = named(async () => new Response(null, { status: 503 }));
    const report = await validateCompany(failing, "example.com");
    const page = resultPage(report, { url: "example.com" });
    const item = page.slice(page.indexOf("<li>"), page.indexOf("</li>"));
    expect(item).toContain('<span class="subject"><code class="url">https://<b>example.com</b>/<wbr>.well-known/<wbr>poppy.json</code></span>');
    expect(item).toContain("<dt>Expected</dt><dd>HTTP 200 with a JSON document</dd><dt>Got</dt><dd>HTTP 503, a server error</dd>");
    expect(item).toContain('<p class="detail">Server errors are often temporary; try again later</p>');
    expect(item.match(/HTTP 503/g)).toHaveLength(1);
  });

  it("lets a long line wrap instead of overflowing the page", () => {
    const page = resultPage(validateText("poppy", "{}"), { document: "{}" });
    expect(page).toContain("ul.messages li{border-top:1px solid var(--line);padding:10px 0;overflow-wrap:anywhere}");
  });

  it("links a URL's report as JSON and as Markdown, and puts a pasted document's Markdown on the page", async () => {
    const fetched = resultPage(await validateCompany(catchAll(), "example.com"), { url: "example.com" });
    expect(fetched).toContain('<a href="/validator/api?url=example.com&amp;format=markdown">This report as Markdown</a>');
    const pasted = resultPage(validateText("poppy", '{"protocol_version":"1.0"}'), { document: '{"protocol_version":"1.0"}' });
    expect(pasted).toContain('<details class="markdown"><summary>This report as Markdown</summary><pre># Poppy Validator report');
  });
});

describe("the report as Markdown", () => {
  it("gives each departure its subject, expected and got, with URLs as code and no sign-in request", async () => {
    const markdown = reportMarkdown(await validateCompany(catchAll(), "example.com"));
    expect(markdown).toContain(
      [
        "- **Error** `http-web-page` · MUST · [Spec 3](https://personalagentprotocol.org/docs/1.0/spec#discovery)",
        "  `https://example.com/.well-known/oauth-protected-resource`",
        "  - Expected: HTTP 404 (no issuer), or protected resource metadata as application/json",
        "  - Got: a web page (HTTP 200, text/html) at `https://login.example-idp.com/app/example_idp_production_tenant_1/exk7g3v8a0D8kEuzr4h7/sso/saml?…`, on another host, after redirects"
      ].join("\n")
    );
    expect(markdown).not.toContain("SAMLRequest");
    expect(markdown.startsWith("# Poppy Validator report\n\n**Couldn't check")).toBe(true);
  });

  it("escapes what a document says, so it can't become markup, a link or a list in someone else's issue", () => {
    const markdown = reportMarkdown(validateText("poppy", JSON.stringify({ protocol_version: "1.0", organization: { name: "A", domain: "example.com" }, web: {}, extensions: { "*[x](https://evil.example)*": [{ version: "1" }] } })));
    expect(markdown).toContain('  - Got: "\\*\\[x\\](`https://evil.example`)\\*"');
    // Outside code spans, where Markdown parses, no link syntax survives.
    expect(markdown.replace(/`[^`\n]*`/g, "")).not.toMatch(/(^|[^\\])\[x\]\(/m);
  });

  it("fences a code span with more backticks than its value holds", () => {
    expect(codeSpan("plain")).toBe("`plain`");
    expect(codeSpan("a`b")).toBe("`` a`b ``");
    expect(codeSpan("``x")).toBe("``` ``x ```");
  });
});

describe("the API's formats", () => {
  const origin = "https://agent.test";
  const options = (fetcher = catchAll()): ValidatorHttpOptions & { asked: () => number } => {
    let asked = 0;
    return {
      fetcher: async (request) => {
        asked++;
        return fetcher(request);
      },
      allowFetch: async () => true,
      asked: () => asked
    };
  };

  it("answers a URL's report as Markdown when asked, and as JSON otherwise", async () => {
    const md = await handleValidator(new Request(`${origin}/validator/api?url=example.com&format=markdown`), options());
    expect(md!.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(md!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await md!.text()).toMatch(/^# Poppy Validator report\n/);
    const json = await handleValidator(new Request(`${origin}/validator/api?url=example.com`), options());
    expect(((await json!.json()) as { outputVersion: number }).outputVersion).toBe(1);
  });

  it("answers a posted document as Markdown", async () => {
    const response = await handleValidator(
      new Request(`${origin}/validator/api`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document: "{}", kind: "poppy", format: "markdown" }) }),
      options()
    );
    expect(await response!.text()).toContain("**Error** `missing-member`");
  });

  it("refuses an unknown format before fetching anything", async () => {
    const opts = options();
    const response = await handleValidator(new Request(`${origin}/validator/api?url=example.com&format=html`), opts);
    expect(response!.status).toBe(400);
    expect(await response!.json()).toEqual({ error: 'format: expected json or markdown, got "html".', expected: "json or markdown", got: '"html"' });
    expect(opts.asked()).toBe(0);
  });
});
