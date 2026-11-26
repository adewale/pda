import { describe, expect, it } from "vitest";
import { budgetDomain, isAllowed, maySignIn, onDemo, parseAllowlist, readOwners } from "../src/allowlist";
import { ConfigError } from "../src/config";
import { departure, ours } from "../src/diagnostic";

const google = (email: string | null, domain: string | null = null) =>
  ({ provider: "google", sub: "g", email, domain }) as const;
const github = (id: number) => ({ provider: "github", sub: String(id), email: null, domain: null }) as const;

const EMPTY = { emails: [], domains: [], github: {} };

describe("parseAllowlist", () => {
  it("normalizes case and matches each kind of entry", () => {
    const list = parseAllowlist("SIGNIN_ALLOWLIST", {
      emails: [" Ada@Example.com "],
      domains: ["Corp.Example"],
      github: { ada: 1001 }
    });
    expect(isAllowed(google("ada@example.COM"), list)).toBe(true);
    expect(isAllowed(google("someone@corp.example", "corp.example"), list)).toBe(true);
    expect(isAllowed(google("someone@corp.example"), list)).toBe(false);
    expect(isAllowed(google(null, "elsewhere.example"), list)).toBe(false);
    expect(isAllowed(github(1001), list)).toBe(true);
    expect(isAllowed({ ...github(1002), email: "ada@example.com" }, list)).toBe(false);
  });

  it("accepts the var as a JSON string", () => {
    const list = parseAllowlist("DEMO_ALLOWLIST", JSON.stringify({ emails: [], domains: [], github: { a: 1 } }));
    expect(list.githubIds.has("1")).toBe(true);
  });

  it("names the problem, and the var, when the var is missing or malformed", () => {
    for (const value of [
      undefined,
      "not json",
      [],
      { emails: [], domains: [] },
      { emails: ["nobody"], domains: [], github: {} },
      { emails: [], domains: ["@corp.example"], github: {} },
      { emails: [], domains: [], github: { ada: "ada" } },
      { emails: [], domains: [], github: {}, users: [] }
    ]) {
      expect(() => parseAllowlist("DEMO_ALLOWLIST", value)).toThrow(ConfigError);
      expect(() => parseAllowlist("DEMO_ALLOWLIST", value)).toThrow(/^DEMO_ALLOWLIST/);
    }
  });

  it("names a bad address by its position, never the address, since a configuration error is served to whoever asked", () => {
    const bad = () => parseAllowlist("DEMO_ALLOWLIST", { emails: ["ada@example.com", "alice@corp"], domains: [], github: {} });
    expect(bad).toThrow("DEMO_ALLOWLIST.emails: expected email addresses, got entry 1, which isn't one");
    expect(bad).not.toThrow(/alice/);
  });
});

describe("OWNERS", () => {
  it("must name at least one person, and never a domain", () => {
    expect(() => readOwners({ OWNERS: { emails: [], github: {} } })).toThrow(new ConfigError(departure(ours("OWNERS"), ours("at least one operator (an email or a GitHub id)"), ours("nobody"), ours("Name this deployment's operators"))));
    expect(() => readOwners({})).toThrow(new ConfigError(departure(ours("OWNERS"), ours("an object with emails and github"), ours("nothing"))));
    expect(() => readOwners({ OWNERS: { emails: [], domains: ["corp.example"], github: {} } })).toThrow(new ConfigError(departure(ours("OWNERS"), ours("an object with emails and github"), ours('one with "domains" too'))));
    expect(readOwners({ OWNERS: { emails: ["op@example.com"], github: {} } }).emails.has("op@example.com")).toBe(true);
  });
});

describe("who may sign in, and who is on the demo", () => {
  const base = {
    OWNERS: { emails: ["op@example.com"], github: { op: 7 } },
    SIGNIN_ALLOWLIST: { emails: ["friend@example.com"], domains: [], github: {} },
    DEMO_ALLOWLIST: { emails: ["demo@example.com"], domains: [], github: {} }
  };

  it("lets in owners and the sign-in allowlist when SIGNUP is allowlist, and nobody else", () => {
    const env = { ...base, SIGNUP: "allowlist" };
    expect(maySignIn(google("op@example.com"), env)).toBe(true);
    expect(maySignIn(github(7), env)).toBe(true);
    expect(maySignIn(google("friend@example.com"), env)).toBe(true);
    expect(maySignIn(google("stranger@example.com"), env)).toBe(false);
  });

  it("lets anyone in when SIGNUP is open, without reading the sign-in allowlist", () => {
    const env = { ...base, SIGNUP: "open", SIGNIN_ALLOWLIST: undefined };
    expect(maySignIn(google("stranger@example.com"), env)).toBe(true);
    expect(maySignIn(github(99), env)).toBe(true);
  });

  it("fails closed, naming the setting, while OWNERS or SIGNUP isn't set", () => {
    expect(() => maySignIn(google("friend@example.com"), { ...base, SIGNUP: "allowlist", OWNERS: { emails: [], github: {} } })).toThrow(/^OWNERS/);
    expect(() => maySignIn(google("friend@example.com"), { ...base, SIGNUP: undefined })).toThrow(/SIGNUP/);
    expect(() => maySignIn(google("friend@example.com"), { ...base, SIGNUP: "everyone" })).toThrow(new ConfigError(departure(ours("SIGNUP"), ours("allowlist or open"), ours('"everyone"'))));
  });

  it("puts owners and the demo allowlist on the demo, and nobody else", () => {
    expect(onDemo(google("op@example.com"), base)).toBe(true);
    expect(onDemo(google("demo@example.com"), base)).toBe(true);
    expect(onDemo(google("friend@example.com"), base)).toBe(false);
    expect(onDemo(google("op@example.com"), { ...base, DEMO_ALLOWLIST: EMPTY })).toBe(true);
  });

  it("shares a Workspace domain's demo budget, and one for every personal account", () => {
    expect(budgetDomain(google("a@corp.example", "Corp.Example"))).toBe("corp.example");
    expect(budgetDomain(google("a@gmail.example"))).toBe("personal");
    expect(budgetDomain(github(7))).toBe("personal");
  });
});
