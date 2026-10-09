declare namespace Cloudflare {
  interface Env {
    /** The test Access key's private half, from vitest.config.ts. */
    TEST_ACCESS_PRIVATE_JWK: string;
    TEAM_DOMAIN: string;
    POLICY_AUD: string;
  }
}
