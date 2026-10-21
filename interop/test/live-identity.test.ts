import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { readInteropKeys } from "../../src/poppy/interop-client.ts";
import { migrate } from "../../src/poppy/store.ts";
import { toIssuer } from "../../src/poppy/issuer.ts";
import type { Company } from "../../src/poppy/discovery.ts";
import { memorySql } from "../impls/pda-agent/sqlite.ts";
import type { PoppyHost } from "../../src/poppy/client.ts";
import { LiveIdentityClient, liveIdentityFrom } from "../impls/pda-agent/live-identity.ts";
import { loadRegistry, selected } from "../runner/cli.ts";
import { LIVE_CLIENT_ID_VAR, LIVE_KEY_VAR, liveIdentityEnv, liveIdentityNotice, readLiveIdentity } from "../runner/live-identity.ts";
import type { RegistryEntry } from "../runner/types.ts";

/**
 * The live lane's identity (docs/interop-spec.md §10), without Docker: the
 * script that makes the key, the runner's choice of who gets it, and the
 * agent adapter signing as the interop test client the Worker publishes.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts", "interop-live-identity.mjs");
const ORIGIN = "https://agent.example";
const dir = mkdtempSync(path.join(tmpdir(), "live-identity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the script on a file of the test's own; stdout and stderr apart. */
function script(file: string, ...args: string[]): { stdout: string } {
  const stdout = execFileSync(process.execPath, [SCRIPT, "--file", file, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { stdout };
}

const registry = loadRegistry();
const entry = (role: string, name: string) => registry.implementations.find((item) => item.role === role && item.name === name)!;
const thirdPartyAgent = registry.implementations.find((item) => item.role === "agent" && item.owner !== "self" && item.build)!;

describe("scripts/interop-live-identity.mjs", () => {
  it("writes the private key to its file (mode 600) and prints only the public key set", () => {
    const file = path.join(dir, "made.json");
    const { stdout } = script(file, "--origin", ORIGIN);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(saved.client_id).toBe(`${ORIGIN}/poppy/interop/client.json`);
    expect(typeof saved.key.d).toBe("string");
    expect(stdout).not.toContain(saved.key.d);
    const printed = JSON.parse(stdout);
    expect(printed).toEqual({ keys: [{ kty: "EC", crv: "P-256", x: saved.key.x, y: saved.key.y, kid: saved.key.kid, alg: "ES256", use: "sig" }] });
    // The Worker takes exactly what it prints.
    expect(readInteropKeys({ INTEROP_LIVE_JWKS: stdout })).toEqual(printed.keys);
    // A second run keeps the key and prints the same set; --new replaces it.
    expect(script(file).stdout).toBe(stdout);
    expect(script(file, "--new", "--origin", ORIGIN).stdout).not.toBe(stdout);
  });

  it("refuses an origin the file wasn't made for", () => {
    const file = path.join(dir, "other.json");
    script(file, "--origin", ORIGIN);
    expect(() => script(file, "--origin", "https://elsewhere.example")).toThrow();
  });
});

describe("the runner's live identity", () => {
  const file = path.join(dir, "runner.json");
  script(file, "--origin", ORIGIN);
  const identity = readLiveIdentity(file)!;

  it("reads the script's file, and nothing when there is none", () => {
    expect(identity.clientId).toBe(`${ORIGIN}/poppy/interop/client.json`);
    expect(identity.key).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256" });
    expect(readLiveIdentity(path.join(dir, "missing.json"))).toBeNull();
  });

  it("refuses a malformed file without quoting the key", () => {
    const bad = path.join(dir, "bad.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    for (const value of [
      "{",
      JSON.stringify({ ...saved, version: 2 }),
      JSON.stringify({ ...saved, client_id: `${ORIGIN}/poppy/client.json` }),
      JSON.stringify({ ...saved, client_id: `http://agent.example/poppy/interop/client.json` }),
      JSON.stringify({ ...saved, key: { ...saved.key, d: undefined } })
    ]) {
      writeFileSync(bad, value);
      let message = "";
      try {
        readLiveIdentity(bad);
      } catch (error) {
        message = String(error);
      }
      expect(message, value.slice(0, 40)).toMatch(/bad\.json/);
      expect(message).not.toContain(saved.key.d);
    }
  });

  it("gives the key only to our own honest agent, and only in the live lane", () => {
    const pda = entry("agent", "pda");
    const live = liveIdentityEnv("live", pda, identity);
    expect(live.public).toEqual({ [LIVE_CLIENT_ID_VAR]: identity.clientId });
    expect(JSON.parse(live.secret[LIVE_KEY_VAR]!)).toEqual(identity.key);
    const none = { public: {}, secret: {} };
    expect(liveIdentityEnv("local", pda, identity)).toEqual(none);
    expect(liveIdentityEnv("live", pda, null)).toEqual(none);
    expect(liveIdentityEnv("live", entry("agent", "evil-agent"), identity)).toEqual(none);
    expect(liveIdentityEnv("live", thirdPartyAgent, identity)).toEqual(none);
    expect(liveIdentityEnv("live", entry("company", "pda-mock"), identity)).toEqual(none);
  });

  it("runs only our own agents in the live lane, so no third-party image ever sees the key", () => {
    const agents = selected(registry, "agent", null, "live");
    expect(agents.map((item: RegistryEntry) => item.name)).toContain("pda");
    expect(agents.every((item: RegistryEntry) => item.owner === "self")).toBe(true);
    expect(() => selected(registry, "agent", [thirdPartyAgent.name], "live")).toThrow(/No agent/);
    // The local lane still runs everyone's.
    expect(selected(registry, "agent", null, "local").map((item: RegistryEntry) => item.name)).toContain(thirdPartyAgent.name);
  });

  it("says why S0, N and C will fail when there's no identity", () => {
    expect(liveIdentityNotice(null)).toMatch(/S0, N and C.*invalid_client/);
    expect(liveIdentityNotice(null)).toContain("scripts/interop-live-identity.mjs");
    expect(liveIdentityNotice(identity)).toContain(identity.clientId);
    expect(liveIdentityNotice(identity)).not.toContain(identity.key.d!);
  });
});

describe("the agent adapter under the live identity", () => {
  const file = path.join(dir, "adapter.json");
  const printed = script(file, "--origin", ORIGIN).stdout;
  const identity = readLiveIdentity(file)!;
  const live = liveIdentityEnv("live", entry("agent", "pda"), identity);
  const env = { ...live.public, ...live.secret };

  it("takes the client_id and key the runner passes, both or neither", () => {
    expect(liveIdentityFrom({})).toBeNull();
    expect(liveIdentityFrom(env)).toMatchObject({ origin: ORIGIN, clientId: identity.clientId });
    expect(() => liveIdentityFrom({ INTEROP_LIVE_CLIENT_ID: identity.clientId })).toThrow(/go together/);
    expect(() => liveIdentityFrom({ ...env, INTEROP_LIVE_CLIENT_ID: `${ORIGIN}/poppy/client.json` })).toThrow(/poppy\/interop\/client\.json/);
    const { d: _private, ...publicOnly } = identity.key;
    expect(() => liveIdentityFrom({ ...env, INTEROP_LIVE_KEY: JSON.stringify(publicOnly) })).toThrow(/private P-256/);
  });

  it("signs client assertions as the interop client, which the Worker's public key set verifies", async () => {
    const liveIdentity = liveIdentityFrom(env)!;
    const hostEnv = {
      PUBLIC_ORIGIN: liveIdentity.origin,
      POPPY_CLIENT_NAME: "Poppy Demo Agent (interop tests)",
      POPPY_LOGO_URI: `${liveIdentity.origin}/logo.png`,
      POPPY_SIGNING_JWKS: liveIdentity.signingJwks,
      TOKEN_ENC_KEY: Buffer.from(new Uint8Array(32)).toString("base64"),
      CompanyLimiter: { getByName: () => ({ delay: async () => 0 }) }
    };
    const requests: Array<Pick<Request, "url" | "text">> = [];
    const sql = memorySql();
    migrate(sql);
    const host: PoppyHost = {
      env: hostEnv as unknown as Env, sql,
      fetcher: async (request) => { requests.push(request.clone()); return Response.json({}); },
      showCard: async () => undefined, notifyModel: async () => undefined,
      schedule: async () => undefined, hasJob: () => false, pushDirect: () => undefined,
      userContext: () => ({ user_available: true }), now: () => Date.now(),
      sleep: async () => { throw new Error("this fixture must not wait"); }
    };
    const client = new LiveIdentityClient(host, liveIdentity);
    expect(client.identity).toMatchObject({
      origin: ORIGIN,
      clientId: `${ORIGIN}/poppy/interop/client.json`,
      jwksUri: `${ORIGIN}/poppy/interop/jwks.json`,
      redirectUri: `${ORIGIN}/poppy/interop/callback`
    });
    // Capture the actual oauthRequest output; do not mint a substitute assertion.
    const audience = "https://auth.company.example/token";
    const company: Company = {
      issuer: toIssuer("https://auth.company.example"), domain: "company.example", name: "Fixture",
      protocolVersion: "0.1", endpoints: { token: audience, revocation: "https://auth.company.example/revoke" },
      signIn: {}, customScopes: {}, apis: [], extensions: {}
    };
    expect((await client.oauthRequest(company, audience, async () => ({ grant_type: "fixture" }), { dpop: false })).status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(audience);
    const form = new URLSearchParams(await requests[0]!.text());
    expect(form.get("client_id")).toBe(identity.clientId);
    const assertion = form.get("client_assertion")!;
    const [published] = readInteropKeys({ INTEROP_LIVE_JWKS: printed })!;
    expect(decodeProtectedHeader(assertion).kid).toBe(published!.kid);
    const { payload } = await jwtVerify(assertion, await importJWK(published!, "ES256"), { audience });
    expect(payload.iss).toBe(identity.clientId);
    expect(payload.sub).toBe(identity.clientId);
  });
});

it("uses matching public keys under a static-host path prefix", () => {
  const file = path.join(dir, "static-host.json");
  script(file, "--origin", ORIGIN);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.client_id = "https://static.example/repository/test/poppy/interop/client.json";
  writeFileSync(file, JSON.stringify(saved));
  const read = readLiveIdentity(file)!;
  const live = liveIdentityFrom({ INTEROP_LIVE_CLIENT_ID: read.clientId, INTEROP_LIVE_KEY: JSON.stringify(read.key) })!;
  const host = { env: { PUBLIC_ORIGIN: live.origin, POPPY_CLIENT_NAME: "Test", POPPY_LOGO_URI: "https://static.example/logo.svg", POPPY_SIGNING_JWKS: live.signingJwks, TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64") }, sql: memorySql() } as unknown as PoppyHost;
  const client = new LiveIdentityClient(host, live);
  expect(client.identity.clientId).toBe(saved.client_id);
  expect(client.identity.jwksUri).toBe("https://static.example/repository/test/poppy/interop/jwks.json");
});
