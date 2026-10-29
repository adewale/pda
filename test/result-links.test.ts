import { describe, expect, it } from "vitest";
import { resultLinks } from "../src/poppy/result-links";

describe("links returned after an API action", () => {
  it("keeps signed checkout URLs byte-for-byte and labels external destinations", () => {
    const url = "https://checkout.example/pay/cs_example?session=a%2Fb%2Bc&return=%2Forders%3Fpaid%3D1#receipt";
    expect(resultLinks({ order: { checkout_url: url }, paymentUrl: url })).toEqual([{ label: "order checkout url · checkout.example", url }]);
  });

  it("does not turn summaries, credentials or unsafe destinations into links", () => {
    for (const url of ["http://shop.example/pay", "javascript:alert(1)", "https://user:pw@shop.example/pay", "https://127.0.0.1/pay", "https://localhost/pay", "https://shop.example/pay\nnext"]) {
      expect(resultLinks({ checkout_url: url })).toEqual([]);
    }
    expect(resultLinks({ summary: "https://shop.example/pay", access_token: { url: "https://shop.example/private" }, token_url: "https://shop.example/token" })).toEqual([]);
  });
});
