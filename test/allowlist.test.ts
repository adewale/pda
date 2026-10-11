import { describe, expect, it } from "vitest";
import { isAllowed, readAllowlist } from "../src/allowlist";
import { ConfigError } from "../src/config";

const google = (email: string | null, domain: string | null = null) =>
  ({ provider: "google", sub: "g", email, domain }) as const;

describe("readAllowlist", () => {
  it("normalizes case and matches each kind of entry", () => {
    const list = readAllowlist({
      ALLOWLIST: { emails: [" Ada@Example.com "], domains: ["Sierra.AI"], github: { adewale: 43644 } }
    });
    expect(isAllowed(google("ada@example.COM"), list)).toBe(true);
    expect(isAllowed(google("someone@sierra.ai", "sierra.ai"), list)).toBe(true);
    expect(isAllowed(google("someone@sierra.ai"), list)).toBe(false);
    expect(isAllowed(google(null, "elsewhere.example"), list)).toBe(false);
    expect(isAllowed({ provider: "github", sub: "43644", email: null, domain: null }, list)).toBe(true);
    expect(isAllowed({ provider: "github", sub: "43645", email: "ada@example.com", domain: null }, list)).toBe(false);
  });

  it("accepts the var as a JSON string", () => {
    const list = readAllowlist({ ALLOWLIST: JSON.stringify({ emails: [], domains: [], github: { a: 1 } }) });
    expect(list.githubIds.has("1")).toBe(true);
  });

  it("names the problem when the var is missing or malformed", () => {
    for (const ALLOWLIST of [
      undefined,
      "not json",
      [],
      { emails: [], domains: [] },
      { emails: ["nobody"], domains: [], github: {} },
      { emails: [], domains: ["@sierra.ai"], github: {} },
      { emails: [], domains: [], github: { adewale: "adewale" } },
      { emails: [], domains: [], github: {}, users: [] }
    ]) {
      expect(() => readAllowlist({ ALLOWLIST })).toThrow(ConfigError);
      expect(() => readAllowlist({ ALLOWLIST })).toThrow(/^ALLOWLIST/);
    }
  });
});
