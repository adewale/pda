/**
 * The runner's proof that a run tests what it says (interop/runner/expectations.ts):
 * each implementation is the profile, version and identity its registry entry names,
 * and the live identity is the one a public Company will fetch.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadKnownFailures, loadRegistry, loadScenarios } from "../runner/cli.ts";
import { checkLiveIdentity, manifestMismatch } from "../runner/expectations.ts";
import type { LiveIdentity } from "../runner/live-identity.ts";
import type { Manifest, RegistryEntry } from "../runner/types.ts";

const registry = loadRegistry();
const entry = (name: string): RegistryEntry => registry.implementations.find((item) => item.name === name)!;
const manifest = (fields: Partial<Manifest>): Manifest => ({ interop: 1, name: "x", role: "agent", commit: "c", poppy: ["0.1", "0.2"], scenarios: [], ...fields });

describe("each implementation is what the registry says", () => {
  it("passes an agent that runs its registry profile, and names one that doesn't", () => {
    expect(manifestMismatch(entry("strict-personal-agent"), manifest({ profile: "strict" }))).toBeNull();
    // 23 October: the live lane dropped the env, and the "strict" agent ran as plain pda.
    expect(manifestMismatch(entry("strict-personal-agent"), manifest({}))).toBe('strict-personal-agent runs profile null, but the registry sets "strict"');
    expect(manifestMismatch(entry("sloppy-personal-agent"), manifest({ profile: "lenient" }))).toMatch(/runs profile "lenient", but the registry sets "sloppy"/);
    expect(manifestMismatch(entry("pda"), manifest({}))).toBeNull();
  });

  it("checks the mock's profile and version, and that an adversary is one", () => {
    expect(manifestMismatch(entry("strict-company"), manifest({ role: "company", profile: "strict", poppy: ["0.1"] }))).toBeNull();
    expect(manifestMismatch(entry("strict-company"), manifest({ role: "company", profile: "lenient", poppy: ["0.1"] }))).toMatch(/registry sets "strict"/);
    expect(manifestMismatch(entry("lenient-company-v02"), manifest({ role: "company", poppy: ["0.2"] }))).toBeNull();
    expect(manifestMismatch(entry("lenient-company-v02"), manifest({ role: "company", poppy: ["0.1"] }))).toMatch(/registry sets Poppy 0\.2/);
    expect(manifestMismatch(entry("evil-personal-agent"), manifest({}))).toMatch(/isn't adversarial/);
    expect(manifestMismatch(entry("evil-personal-agent"), manifest({ adversarial: true }))).toBeNull();
  });

  it("checks that an agent given the live identity signs as it", () => {
    const live = "https://agent.example/poppy/interop/client.json";
    expect(manifestMismatch(entry("pda"), manifest({ client_id: live }), live)).toBeNull();
    expect(manifestMismatch(entry("pda"), manifest({ client_id: "https://pda.agent.interop.test/poppy/client.json" }), live)).toMatch(/signs as .*, not the live identity/);
    expect(manifestMismatch(entry("pda"), manifest({}), live)).toMatch(/signs as null/);
  });

  it("puts every honest agent that can run locally on Print with Poppy's allowlist", () => {
    // Twice an agent was refused there for a missing line: the fakes (23 October), Datalayer's 0.2 agents (24 October).
    const adapter = readFileSync(path.resolve(import.meta.dirname, "../impls/print-with-poppy-company/adapter.mjs"), "utf8");
    const listed = adapter.slice(adapter.indexOf("const GRID_AGENTS"), adapter.indexOf("];", adapter.indexOf("const GRID_AGENTS")));
    const honest = registry.implementations.filter((item) => item.role === "agent" && item.build && !item.adversarial && !item.vectorsOnly);
    const missing = honest.filter((item) => !listed.includes(`https://${item.name}.agent.interop.test/`)).map((item) => item.name);
    expect(missing).toEqual([]);
  });
});

describe("the registry's other promises", () => {
  it("names only registered implementations and existing scenarios in the known failures", () => {
    // A rename that misses an entry would leave it matching nothing, and a run would never say so.
    const scenarios = new Set(loadScenarios().map((scenario) => scenario.id));
    const has = (role: string, name: string) => name === "*" || registry.implementations.some((item) => item.role === role && item.name === name);
    const orphans = loadKnownFailures()
      .filter((known) => !has("agent", known.agent) || !has("company", known.company) || (known.scenario !== "*" && !scenarios.has(known.scenario)))
      .map((known) => `${known.agent} × ${known.company} × ${known.scenario}`);
    expect(orphans).toEqual([]);
  });

  it("limits each live Company whose owner or notes limit what it may be sent", () => {
    const limits = Object.fromEntries(registry.implementations.filter((item) => item.liveScenarios).map((item) => [item.name, item.liveScenarios]));
    expect(limits).toMatchObject({
      "print-with-poppy-live": ["D"],
      "print-with-poppy-sandbox-live": ["D", "S0"],
      "alpine-retail-live": ["D", "S0", "N", "C"],
      "ilmer-live": ["D", "S0", "C"]
    });
  });
});

describe("the live identity, as a Company fetches it", () => {
  const origin = "https://agent.example";
  const identity: LiveIdentity = {
    clientId: `${origin}/poppy/interop/client.json`,
    key: { kty: "EC", crv: "P-256", x: "xx", y: "yy", d: "dd", kid: "interop-1", alg: "ES256", use: "sig" }
  };
  const serving = (overrides: Record<string, Response | (() => Response)> = {}): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const override = overrides[url];
      if (override) return typeof override === "function" ? override() : override;
      if (url === identity.clientId) return Response.json({ client_id: identity.clientId, token_endpoint_auth_method: "private_key_jwt", jwks_uri: `${origin}/poppy/interop/jwks.json` });
      if (url === `${origin}/poppy/interop/jwks.json`) return Response.json({ keys: [{ kty: "EC", crv: "P-256", x: "xx", y: "yy", kid: "interop-1" }] });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

  it("passes an identity whose documents name it and hold its key", async () => {
    expect(await checkLiveIdentity(identity, serving(), origin)).toEqual({ problems: [], warnings: [] });
  });

  it("stops at a client_id that answers 404, as the workers.dev identity did after the move", async () => {
    const { problems } = await checkLiveIdentity(identity, serving({ [identity.clientId]: new Response("gone", { status: 404 }) }), origin);
    expect(problems).toEqual([`${identity.clientId} answered 404`]);
  });

  it("stops at a redirect, or at JSON served as text/plain", async () => {
    const redirect = await checkLiveIdentity(identity, serving({ [identity.clientId]: new Response(null, { status: 308, headers: { location: "https://elsewhere.example/" } }) }), origin);
    expect(redirect.problems[0]).toMatch(/answered 308 \(a redirect/);
    const text = await checkLiveIdentity(identity, serving({ [identity.clientId]: new Response("{}", { headers: { "content-type": "text/plain" } }) }), origin);
    expect(text.problems[0]).toMatch(/served as text\/plain, not JSON/);
  });

  it("stops when the published key isn't the runner's, by kid or by public point", async () => {
    const jwks = `${origin}/poppy/interop/jwks.json`;
    const other = await checkLiveIdentity(identity, serving({ [jwks]: () => Response.json({ keys: [{ kty: "EC", crv: "P-256", x: "xx", y: "yy", kid: "interop-2" }] }) }), origin);
    expect(other.problems).toEqual([`${jwks} has no key interop-1: the Worker doesn't publish the runner's key`]);
    const swapped = await checkLiveIdentity(identity, serving({ [jwks]: () => Response.json({ keys: [{ kty: "EC", crv: "P-256", x: "zz", y: "yy", kid: "interop-1" }] }) }), origin);
    expect(swapped.problems[0]).toMatch(/same kid, another public key/);
  });

  it("stops at a document naming another client_id or keys on another origin", async () => {
    const named = await checkLiveIdentity(identity, serving({ [identity.clientId]: () => Response.json({ client_id: "https://other.example/c.json", token_endpoint_auth_method: "private_key_jwt", jwks_uri: "https://other.example/jwks.json" }) }), origin);
    expect(named.problems).toEqual(expect.arrayContaining([expect.stringMatching(/names client_id/), expect.stringMatching(/another origin/)]));
  });

  it("only warns when the identity lives somewhere other than PUBLIC_ORIGIN, a supported static host", async () => {
    const result = await checkLiveIdentity(identity, serving(), "https://poppydemoagent.example");
    expect(result.problems).toEqual([]);
    expect(result.warnings[0]).toMatch(/PUBLIC_ORIGIN serves https:\/\/poppydemoagent\.example\/poppy\/interop\/client\.json/);
  });
});
