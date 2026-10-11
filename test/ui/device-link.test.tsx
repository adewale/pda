import { describe, expect, it } from "vitest";
import type { Company } from "../../src/poppy/discovery";
import { deviceLink } from "../../src/poppy/signin";
import { gs, property } from "../properties/hegel";

/**
 * Which device sign-in links reach a card at all (spec 4.6). The page checks
 * again before it renders one (`poppy-ui.test.tsx`); this is the check where
 * the card is made, from the Company's device authorization response.
 */

const company = {
  issuer: "https://login.acme-id.example",
  name: "Acme",
  domain: "acme.example",
  endpoints: {
    token: "https://login.acme-id.example/token",
    revocation: "https://login.acme-id.example/revoke",
    deviceAuthorization: "https://device.acme-auth.example/device_authorization"
  }
} as unknown as Company;

describe("deviceLink", () => {
  it.each([
    "https://acme.example/device",
    "https://www.acme.example/device?user_code=WDJB-MJHT",
    "https://auth.acme.example/device",
    "https://login.acme-id.example/device",
    "https://device.acme-auth.example/activate",
    "HTTPS://ACME.EXAMPLE/device"
  ])("accepts %s", (uri) => {
    expect(deviceLink(company, uri)).toBe(new URL(uri).href);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://acme.example/device",
    "https://evil.example/device",
    "https://acme.example.evil.example/device",
    "https://evilacme.example/device",
    "https://user:pass@acme.example/device",
    "//acme.example/device",
    "/device",
    "",
    "not a url"
  ])("refuses %s", (uri) => {
    expect(deviceLink(company, uri)).toBeNull();
  });

  it("refuses anything that isn't a string", () => {
    for (const value of [undefined, null, 42, {}, ["https://acme.example/"]]) expect(deviceLink(company, value)).toBeNull();
  });

  it(
    "returns only HTTPS links on the Company's hosts",
    property((tc) => {
      const drawn = tc.draw(gs.urls());
      const value = tc.draw(
        gs.oneOf(gs.sampledFrom(["https", "http", "javascript", "data", "ftp"]).map((scheme) => drawn.replace(/^[a-z]+:/, `${scheme}:`)), gs.text())
      );
      const link = deviceLink(company, value);
      if (link === null) return;
      const url = new URL(link);
      expect(url.protocol).toBe("https:");
      expect(
        url.hostname === "acme.example" ||
          url.hostname.endsWith(".acme.example") ||
          ["login.acme-id.example", "device.acme-auth.example"].includes(url.hostname)
      ).toBe(true);
    })
  );
});
