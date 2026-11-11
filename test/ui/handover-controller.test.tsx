import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { controllerScript } from "../../src/poppy/handover";

/**
 * `navigator.poppy` in the browser handed to the User (0.4 Browser Control
 * 6), run as the browser runs it at the start of each document: in its own
 * context, with that document's location.
 */
function run(url: string, domain = "shop.example") {
  class Navigator {}
  const context = vm.createContext({ location: new URL(url), Navigator });
  vm.runInContext(controllerScript(domain), context);
  return { navigator: new Navigator() as { poppy?: { controller: string } }, context };
}

describe("navigator.poppy in the handover browser (Browser Control 6)", () => {
  it("is the User's on the Company's domain and its subdomains", () => {
    for (const url of ["https://shop.example/orders", "https://www.shop.example/", "https://SHOP.example./"]) {
      expect(run(url).navigator.poppy, url).toEqual({ controller: "user" });
    }
  });

  it("is undefined everywhere else, so other websites can't tell the browser is a Personal Agent's", () => {
    for (const url of ["https://other.example/", "https://shop.example.evil.test/", "https://notshop.example/", "http://shop.example/"]) {
      expect(run(url).navigator.poppy, url).toBeUndefined();
    }
  });

  it("is read-only: a page's script can't change it or define it again", () => {
    const { navigator, context } = run("https://shop.example/");
    expect(() => vm.runInContext(`"use strict"; Navigator.prototype.poppy.controller = "agent"`, context)).toThrow();
    expect(() => vm.runInContext(`Object.defineProperty(Navigator.prototype, "poppy", { value: { controller: "agent" } })`, context)).toThrow();
    expect(navigator.poppy?.controller).toBe("user");
  });
});
