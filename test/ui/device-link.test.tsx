import { describe, expect, it } from "vitest";
import type { Company } from "../../src/poppy/discovery";
import { deviceLink } from "../../src/poppy/signin";
import { gs, property } from "../properties/hegel";
import { toIssuer } from "../../src/poppy/issuer";

/**
 * Which device sign-in links reach a card at all (spec 4.3): the host of the
 * Company's issuer or of a URL in its `protected_resources`, or a subdomain
 * of either, and nothing else, not even its device endpoint's host. The page checks
 * again before it renders one (`poppy-ui.test.tsx`); this is the check where
 * the card is made, from the Company's device authorization response.
 */

const company = {
  protocolVersion: "0.3",
  issuer: toIssuer("https://login.acme-id.example"),
  name: "Acme",
  domain: "acme.example",
  // The hosts of the issuer's `protected_resources` (3.2).
  poppyDomains: ["acme.example"],
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
    "https://eu.login.acme-id.example/device",
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
    // The device endpoint's host is neither the issuer's nor a protected resource's.
    "https://device.acme-auth.example/activate",
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

  /** The Company's hosts: its protected resource's and its issuer's, and their subdomains. */
  const onCompany = (hostname: string) =>
    ["acme.example", "login.acme-id.example"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));

  it(
    "returns exactly the HTTPS links on the Company's hosts, unchanged",
    property((tc) => {
      // Hosts the Company owns (so many links are accepted) and lookalikes it doesn't.
      const label = gs.fromRegex("[a-z0-9]([a-z0-9-]{0,6}[a-z0-9])?", { fullmatch: true });
      const host = tc.draw(
        gs.oneOf(
          gs.sampledFrom(["acme.example", "www.acme.example", "ACME.Example", "login.acme-id.example"]),
          label.map((sub) => `${sub}.acme.example`),
          label.map((sub) => `${sub}.login.acme-id.example`),
          gs.sampledFrom(["evil.example", "acme.example.evil.example", "evilacme.example", "acme-id.example", "acme-auth.example", "device.acme-auth.example"]),
          label.map((name) => `${name}.example`)
        )
      );
      const scheme = tc.draw(gs.sampledFrom(["https", "HTTPS", "http", "javascript", "data", "ftp"]));
      const userinfo = tc.draw(gs.sampledFrom(["", "", "", "user:pass@", "user@"]));
      const path = tc.draw(gs.fromRegex("(/[A-Za-z0-9_~-]{0,8}){0,3}(\\?user_code=[A-Z0-9-]{1,9})?", { fullmatch: true }));
      const value = `${scheme}://${userinfo}${host}${path}`;
      const accepted = scheme.toLowerCase() === "https" && userinfo === "" && onCompany(host.toLowerCase());
      expect(deviceLink(company, value), value).toBe(accepted ? new URL(value).href : null);
    })
  );

  it(
    "returns only HTTPS links on the Company's hosts, whatever the text",
    property((tc) => {
      const drawn = tc.draw(gs.urls());
      const value = tc.draw(
        gs.oneOf(gs.sampledFrom(["https", "http", "javascript", "data", "ftp"]).map((scheme) => drawn.replace(/^[a-z]+:/, `${scheme}:`)), gs.text())
      );
      const link = deviceLink(company, value);
      if (link === null) return;
      const url = new URL(link);
      expect(url.protocol).toBe("https:");
      expect(onCompany(url.hostname)).toBe(true);
    })
  );
});
