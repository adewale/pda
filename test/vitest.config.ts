import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

/** Must match test/wrangler.jsonc. */
const GOOGLE_CLIENT = { id: "google-test-client", secret: "google-test-secret" };
const GITHUB_CLIENT = { id: "github-test-client", secret: "github-test-secret" };

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

/** Signs the fake Google ID tokens; the Worker does not check this signature. */
const idTokenKey = crypto.getRandomValues(new Uint8Array(32));

/**
 * A test authorization code is `ok:<user id>:<email>`; anything else is a bad
 * code. The fakes also insist on the client secret and a PKCE verifier.
 */
function parseCode(form: URLSearchParams, secret: string) {
  const [ok, id, email] = (form.get("code") ?? "").split(":");
  if (
    ok !== "ok" ||
    !id ||
    form.get("client_secret") !== secret ||
    !form.get("code_verifier") ||
    !form.get("redirect_uri")?.endsWith("/callback")
  ) {
    return null;
  }
  return { id, email: email ?? "" };
}

async function fakeProviders(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.href === "https://oauth2.googleapis.com/token") {
    const user = parseCode(new URLSearchParams(await request.text()), GOOGLE_CLIENT.secret);
    if (!user) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ email: user.email, email_verified: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience(GOOGLE_CLIENT.id)
      .setSubject(user.id)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(idTokenKey);
    return Response.json({ id_token: idToken, access_token: "unused" });
  }
  if (request.method === "POST" && url.href === "https://github.com/login/oauth/access_token") {
    const user = parseCode(new URLSearchParams(await request.text()), GITHUB_CLIENT.secret);
    // GitHub reports a bad code as a 200 with an `error` field.
    if (!user) return Response.json({ error: "bad_verification_code" });
    return Response.json({ access_token: `tok:${user.id}:${user.email}` });
  }
  if (url.origin === "https://api.github.com") {
    const [, id, email] = (request.headers.get("Authorization") ?? "")
      .replace(/^Bearer /, "")
      .split(":");
    if (!id || !request.headers.get("User-Agent")) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
    if (url.pathname === "/user") {
      return Response.json({ id: Number(id), login: `user${id}`, email: null });
    }
    if (url.pathname === "/user/emails") {
      return Response.json([
        { email: `other-${email}`, primary: false, verified: true },
        { email, primary: true, verified: true }
      ]);
    }
  }
  return new Response("No network in tests", { status: 502 });
}

export default defineConfig({
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
    name: "personal-agent",
    include: [path.join(testsDir, "**/*.test.ts")],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
