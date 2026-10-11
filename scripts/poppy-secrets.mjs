// Prints a new Poppy secret to stdout, for piping into `wrangler secret put`:
//   node scripts/poppy-secrets.mjs signing-keys | npx wrangler secret put POPPY_SIGNING_JWKS
//   node scripts/poppy-secrets.mjs token-key    | npx wrangler secret put TOKEN_ENC_KEY
// Signing keys: a current and a next ES256 key, so the next one is published
// before it signs (Guides, "Rotating keys"). To rotate, move "next" first and
// add a new "next"; keep a retired key until its signatures have expired.
import { exportJWK, generateKeyPair } from "jose";

const kind = process.argv[2];
if (kind === "signing-keys") {
  const date = new Date().toISOString().slice(0, 10);
  const keys = [];
  for (const role of ["current", "next"]) {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    keys.push({ ...(await exportJWK(privateKey)), kid: `${date}-${role}`, alg: "ES256", use: "sig" });
  }
  process.stdout.write(JSON.stringify(keys));
} else if (kind === "token-key") {
  process.stdout.write(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"));
} else {
  console.error("Usage: node scripts/poppy-secrets.mjs signing-keys|token-key");
  process.exit(1);
}
