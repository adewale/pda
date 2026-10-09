import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

/** Must match TEAM_DOMAIN in test/wrangler.jsonc. */
const TEAM_DOMAIN = "https://test-team.cloudflareaccess.com";
const KID = "test-key";

// Access is simulated without touching the code: a fresh RS256 key per run,
// whose public half is served at the real certs URL. The tests sign tokens
// with the private half.
const { publicKey, privateKey } = await generateKeyPair("RS256", {
  extractable: true
});
const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256" };
const privateJwk = { ...(await exportJWK(privateKey)), kid: KID, alg: "RS256" };

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") },
      miniflare: {
        bindings: { TEST_ACCESS_PRIVATE_JWK: JSON.stringify(privateJwk) },
        outboundService: (request: Request) => {
          if (request.url === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
            return Response.json({ keys: [publicJwk] });
          }
          return new Response("No network in tests", { status: 502 });
        }
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
    name: "personal-agent",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
