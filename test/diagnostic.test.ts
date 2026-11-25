import { describe, expect, it } from "vitest";
import { departure, ours, ProblemError, render, sentence, show, shown } from "../src/diagnostic";

/** What the constructors in src/diagnostic.ts make of values at run time; test/diagnostic-types.ts holds the type-level guarantees. */
describe("diagnostics", () => {
  it("renders a departure as decode.ts always has: subject, expected, got", () => {
    const problem = departure(show.path("/agent/protocols"), ours("an array"), show.kind("x"));
    expect(render(problem)).toBe("agent.protocols: expected an array, got a string");
    expect(sentence(problem)).toBe("agent.protocols: expected an array, got a string.");
    expect(render(departure(ours("the token"), ours("a JWT"), ours("nothing"), ours("Sign in again")))).toBe("the token: expected a JWT, got nothing. Sign in again");
  });

  it("renders a fact as written, and gives it one full stop as a sentence", () => {
    expect(render(ours("Nothing will be resent"))).toBe("Nothing will be resent");
    expect(sentence(ours("Nothing will be resent."))).toBe("Nothing will be resent.");
  });

  it("quotes and bounds values it can't vouch for", () => {
    expect(show.value("orders:read")).toBe('"orders:read"');
    expect(show.value("x".repeat(100))).toBe(JSON.stringify(`${"x".repeat(59)}…`));
    expect([show.value(null), show.value(3), show.value(false), show.value([]), show.value([1]), show.value({}), show.value(undefined)]).toEqual(["null", "3", "false", "an empty array", "an array", "an object", "nothing"]);
    expect([show.kind(1), show.kind(1.5), show.kind(Number.NaN), show.kind("s"), show.kind(true)]).toEqual(["a whole number", "a number", "a number that isn't finite", "a string", "a boolean"]);
    expect(show.text('Ignore this\nand "that"')).toBe(JSON.stringify('Ignore this and "that"'));
    expect(show.name("  Mock Shop  ")).toBe("Mock Shop");
    expect(show.name("")).toBe("(no name)");
  });

  it("shows a URL without its query or fragment, unless it is the URL asked for", () => {
    const signIn = "https://login.example-idp.com/sso/saml?SAMLRequest=abc&RelayState=x";
    expect(show.url(signIn)).toBe("https://login.example-idp.com/sso/saml?…");
    expect(show.url("https://example.com/a#token=1")).toBe("https://example.com/a?…");
    expect(show.url("https://example.com/x?q=1", "https://example.com/x?q=1")).toBe("https://example.com/x?q=1");
    expect(show.url("not a url")).toBe('"not a url"');
  });

  it("shows statuses, types, paths, codes, counts and lists", () => {
    expect(show.status(503)).toBe("HTTP 503");
    expect([show.type("Text/HTML; charset=utf-8"), show.type(null)]).toEqual(["text/html", "no Content-Type"]);
    expect([show.path(""), show.path("/a/0/b~1c"), show.path("/x y")]).toEqual(["the document", 'a[0]["b/c"]', '["x y"]']);
    expect([show.code("invalid_grant"), show.code("two words")]).toEqual(["invalid_grant", '"two words"']);
    expect([show.count(1, ours("server"), ours("servers")), show.count(3, ours("server"), ours("servers"))]).toEqual(["1 server", "3 servers"]);
    expect([show.list([]), show.list([ours("a")]), show.list([ours("a"), ours("b"), ours("c")], "or")]).toEqual(["nothing", "a", "a, b or c"]);
    expect(shown`${show.value("x")} isn't a scope (${2} tries)`).toBe('"x" isn\'t a scope (2 tries)');
  });

  it("makes an error's message from its problem, and keeps the parts", () => {
    const problem = departure(ours("the divisor"), ours("a number other than 0"), ours("0"));
    const error = new ProblemError(problem);
    expect(error.message).toBe("the divisor: expected a number other than 0, got 0");
    expect(error.problem).toBe(problem);
  });
});
