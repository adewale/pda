// Per-deployment secrets, set with `wrangler secret put`. `wrangler types`
// cannot see them, so they are declared here; `config.ts` still treats each
// one as possibly missing and names it if it is.
interface SignInSecrets {
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** JSON array of private ES256 JWKs, each with `kid`; the first signs. */
  POPPY_SIGNING_JWKS: string;
  /** Base64 of 32 random bytes: AES-GCM key for Account Tokens at rest. */
  TOKEN_ENC_KEY: string;
  /** Only while rotating `TOKEN_ENC_KEY`: the old key, so values it sealed still open (and are sealed again). */
  TOKEN_ENC_KEY_PREVIOUS?: string;
  /** A P-256 private JWK: the VAPID key for Web Push (src/web-push.ts). Without it, notifications are off. */
  WEB_PUSH_VAPID_JWK?: string;
}

interface Env extends SignInSecrets {}

declare namespace Cloudflare {
  interface Env extends SignInSecrets {}
}
