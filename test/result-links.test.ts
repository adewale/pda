import { describe, expect, it } from "vitest";
import { inspectResultLinks, resultLinks } from "../src/poppy/result-links";

describe("links returned after an API action", () => {
  it("counts rejection reasons without retaining values or Company field names", () => {
    const report = inspectResultLinks({
      checkout_url: "https://checkout.example/pay?signature=KEEP-PRIVATE#receipt",
      bad_url: "not-a-url", plain_url: "http://shop.example/pay", local_url: "https://localhost/pay",
      login_url: "https://user:pw@shop.example/pay", token_url: "https://shop.example/private?secret=PRIVATE",
      broken_url: "https://shop.example/pay\nnext"
    });
    expect(report.links).toHaveLength(1);
    expect(report.rejected).toEqual({ invalid_url: 1, not_https: 1, private_host: 1, url_credentials: 1, credential_field: 1, whitespace: 1 });
    expect(JSON.stringify(report.rejected)).not.toMatch(/KEEP-PRIVATE|PRIVATE|checkout|login|localhost/);
  });

  it("bounds hostile labels and removes directional controls without changing signed hrefs", () => {
    const url = "https://checkout.example/pay?signature=a%2Fb%2Bc#receipt";
    const result = resultLinks({ ["x".repeat(1_900_000)]: { ["Checkout \u202Eurl"]: url } });
    expect(result).toHaveLength(1);
    expect(result[0]!.label.length).toBeLessThanOrEqual(256);
    expect(result[0]!.label).not.toContain("\u202E");
    expect(result[0]!.url).toBe(url);
  });
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
