import path from "node:path";
import { execFileSync } from "node:child_process";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair } from "jose";
import { configDefaults, defineConfig } from "vitest/config";
import { buildDefines } from "../scripts/build-info.ts";
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
  // The Web Push VAPID key: a P-256 private JWK, as `poppy-secrets.mjs vapid-key` prints one.
  const { privateKey: vapid } = await generateKeyPair("ES256", { extractable: true });
  const { kty, crv, x, y, d } = await exportJWK(vapid);
  return {
    POPPY_SIGNING_JWKS: JSON.stringify(keys),
    TOKEN_ENC_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    WEB_PUSH_VAPID_JWK: JSON.stringify({ kty, crv, x, y, d })
  };
}

/**
 * A Workers-runtime test project. The pool creates local Miniflare/workerd
 * runtimes for its isolated file workers. Tests that reset every Durable
 * Object (`abortAllDurableObjects`) remain in their own config, preserving
 * that boundary if file-worker isolation or pooling changes.
 */
export async function workersConfig(options: { name: string; include: string[]; exclude?: string[] }) {
  return defineConfig({
  // As the build: the commit and compatibility date on every wide event (src/log.ts).
  define: {
    ...buildDefines(path.join(testsDir, "wrangler.jsonc")),
    // Markdown, license texts and the protocol snapshots (HTML/manifests in spec/) are documentation.
    // Keep this Git inventory independent of the scanner's list of source roots.
    __TEST_TEMPLATE_FILES__: JSON.stringify(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: path.join(testsDir, ".."), encoding: "utf8"
    }).split("\0").filter((file) => file && !file.endsWith(".md") && !/(^|\/)LICENSE$/.test(file) && !file.startsWith("spec/")))
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") },
      miniflare: {
        outboundService: fakeProviders,
        bindings: await poppySecrets(),
        // This fake deliberately keeps its protocol state and evidence in memory.
        // Only the fake is pinned: real agent lifecycle/eviction tests still run.
        durableObjects: { MOCK_COMPANY: { className: "MockCompany", useSQLite: true, unsafePreventEviction: true } }
      }
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
