import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair } from "jose";
import { configDefaults, defineConfig } from "vitest/config";
// Google and GitHub, faked as the outbound service; the file says how tests drive them.
import { fakeProviders } from "./fake-providers.ts";

const testsDir = import.meta.dirname;

/** The Personal Agent's Poppy signing keys and token key, fresh per run. */
async function poppySecrets() {
  const keys = [];
  for (const kid of ["test-current", "test-next"]) {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    keys.push({ ...(await exportJWK(privateKey)), kid, alg: "ES256", use: "sig" });
  }
  return {
    POPPY_SIGNING_JWKS: JSON.stringify(keys),
    TOKEN_ENC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")
  };
}

/**
 * A Workers-runtime test project. Each config gets its own workerd runtime,
 * shared by every file it includes; tests that reset every Durable Object
 * (`abortAllDurableObjects`) live in their own config so they can't reset
 * objects another file is using mid-test.
 */
export async function workersConfig(options: { name: string; include: string[]; exclude?: string[] }) {
  return defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") },
      miniflare: { outboundService: fakeProviders, bindings: await poppySecrets() }
    })
  ],
  resolve: {
    // One copy of each pi package, so the harness and the tests share pi's
    // module state.
    dedupe: [
      "@earendil-works/chord",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry"
    ]
  },
  test: {
    name: options.name,
    include: options.include.map((glob) => path.join(testsDir, glob)),
    exclude: [...configDefaults.exclude, ...(options.exclude ?? []).map((glob) => path.join(testsDir, glob))],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
  });
}
