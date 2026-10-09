// Per-deployment secrets, set with `wrangler secret put`. `wrangler types`
// cannot see them, so they are declared here; `config.ts` still treats each
// one as possibly missing and names it if it is.
interface SignInSecrets {
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

interface Env extends SignInSecrets {}

declare namespace Cloudflare {
  interface Env extends SignInSecrets {}
}
