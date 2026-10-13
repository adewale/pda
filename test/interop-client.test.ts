import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { deploymentProblems, type DeploymentEnv } from "../src/deployment";
import { readInteropKeys } from "../src/poppy/interop-client";
import { validateClient } from "../src/validator/validate";
import { fetchWorker } from "./agent-helpers";
import worker from "./worker";

/**
 * The interop test client (src/poppy/interop-client.ts): the live lane's
 * public identity, a second Poppy client the Worker publishes only when the
 * deployment sets INTEROP_LIVE_JWKS, separate from the real one.
 */

/** PUBLIC_ORIGIN in test/wrangler.jsonc. */
const ORIGIN = "https://agent.test";
const CLIENT = `${ORIGIN}/poppy/interop/client.json`;
const JWKS = `${ORIGIN}/poppy/interop/jwks.json`;

/** A key pair as scripts/interop-live-identity.mjs makes one: the public set the deployer pastes, and the private JWK. */
async function interopKey(kid = "interop-test") {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const { kty, crv, x, y, d } = await exportJWK(privateKey);
  return { publicSet: { keys: [{ kty, crv, x, y, kid, alg: "ES256", use: "sig" }] }, privateJwk: { kty, crv, x, y, d, kid } };
}

/** The test deployment with INTEROP_LIVE_JWKS set. */
function configured(jwks: unknown): Partial<Env> {
  return { INTEROP_LIVE_JWKS: jwks } as unknown as Partial<Env>;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("the interop test client, unconfigured (the committed template)", () => {
  it("answers 404 for both documents and anything else under /poppy/interop/", async () => {
    for (const url of [CLIENT, JWKS, `${ORIGIN}/poppy/interop/`, `${ORIGIN}/poppy/interop/callback`]) {
      expect((await fetchWorker(new Request(url))).status, url).toBe(404);
    }
  });

  it("treats an empty INTEROP_LIVE_JWKS as off", async () => {
    expect(readInteropKeys({ INTEROP_LIVE_JWKS: "" })).toBeNull();
    expect(readInteropKeys({ INTEROP_LIVE_JWKS: "  " })).toBeNull();
    expect(readInteropKeys({})).toBeNull();
    expect((await fetchWorker(new Request(CLIENT), configured(""))).status).toBe(404);
  });
});

describe("the interop test client, configured", () => {
  it("serves client metadata whose client_id is its own URL, with no redirect URI", async () => {
    const { publicSet } = await interopKey();
    const doc = await json(await fetchWorker(new Request(CLIENT), configured(publicSet)));
    expect(doc).toEqual({
      client_id: CLIENT,
      client_name: "Durable Personal Agent (interop tests)",
      jwks_uri: JWKS,
      token_endpoint_auth_method: "private_key_jwt",
      extensions: { operations: { version: "1" } }
    });
  });

  it("takes the key set as an object or as its JSON, and serves only the public members", async () => {
    const { publicSet } = await interopKey();
    for (const value of [publicSet, JSON.stringify(publicSet), { keys: [{ ...publicSet.keys[0], extra: "dropped" }] }]) {
      const jwks = await json(await fetchWorker(new Request(JWKS), configured(value)));
      expect(jwks).toEqual(publicSet);
      for (const key of jwks.keys as Record<string, unknown>[]) {
        expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
      }
    }
  });

  it("refuses a private key, so one pasted by mistake is never served", async () => {
    const { privateJwk } = await interopKey();
    const leaked = { keys: [privateJwk] };
    expect(() => readInteropKeys({ INTEROP_LIVE_JWKS: leaked })).toThrow(/holds a private key/);
    // The deploy check stops it before upload; a Worker that has it anyway fails closed.
    expect(deploymentProblems({ ...(env as unknown as DeploymentEnv), INTEROP_LIVE_JWKS: leaked })).toEqual([
      "INTEROP_LIVE_JWKS holds a private key; it takes only the public key set that scripts/interop-live-identity.mjs prints"
    ]);
    const response = await fetchWorker(new Request(JWKS), configured(leaked));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(privateJwk.d);
  });

  it("refuses malformed key sets", () => {
    for (const value of ["{", { keys: [] }, { keys: [{ kty: "RSA", n: "x", e: "AQAB", kid: "r" }] }, { keys: [{ kty: "EC", crv: "P-256", x: "a", y: "b" }] }, [1]]) {
      expect(() => readInteropKeys({ INTEROP_LIVE_JWKS: value }), JSON.stringify(value)).toThrow(/INTEROP_LIVE_JWKS/);
    }
  });

  it("never shares a key with the real client", async () => {
    const real = (await json(await fetchWorker(new Request(`${ORIGIN}/poppy/jwks.json`)))).keys as Record<string, unknown>[];
    const response = await fetchWorker(new Request(JWKS), configured({ keys: [real[0]] }));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("INTEROP_LIVE_JWKS shares a key with POPPY_SIGNING_JWKS; the interop client needs its own");
  });

  it("serves only on PUBLIC_ORIGIN, only GET and HEAD", async () => {
    const { publicSet } = await interopKey();
    expect((await fetchWorker(new Request("https://elsewhere.example/poppy/interop/client.json"), configured(publicSet))).status).toBe(404);
    expect((await fetchWorker(new Request(CLIENT, { method: "HEAD" }), configured(publicSet))).status).toBe(200);
    expect((await fetchWorker(new Request(CLIENT, { method: "POST" }), configured(publicSet))).status).toBe(405);
    expect((await fetchWorker(new Request(`${ORIGIN}/poppy/interop/callback`), configured(publicSet))).status).toBe(404);
  });

  it("leaves the real client's documents as they are", async () => {
    const { publicSet } = await interopKey();
    for (const path of ["/poppy/client.json", "/poppy/jwks.json"]) {
      const before = await json(await fetchWorker(new Request(`${ORIGIN}${path}`)));
      const after = await json(await fetchWorker(new Request(`${ORIGIN}${path}`), configured(publicSet)));
      expect(after, path).toEqual(before);
    }
    const real = await json(await fetchWorker(new Request(`${ORIGIN}/poppy/client.json`), configured(publicSet)));
    expect(real.client_id).toBe(`${ORIGIN}/poppy/client.json`);
    const realKids = ((await json(await fetchWorker(new Request(`${ORIGIN}/poppy/jwks.json`), configured(publicSet)))).keys as { kid: string }[]).map((key) => key.kid);
    expect(realKids).not.toContain("interop-test");
  });

  it("passes the validator: valid client metadata and keys, with only the note that it can't use Direct Sign-In", async () => {
    const { publicSet } = await interopKey();
    const vars = { ...env, ...configured(publicSet) } as Env;
    const report = await validateClient(async (request) => worker.fetch(request, vars), CLIENT);
    expect(report.outcome).toBe("valid");
    expect(report.counts).toMatchObject({ error: 0, warning: 0 });
    expect(report.documents.map((document) => document.kind)).toEqual(["client-metadata", "jwks"]);
    expect(report.messages.map((message) => message.id)).toEqual(["client-no-redirects"]);
    expect(report.refused).toBe(false);
  });
});
