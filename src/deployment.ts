import { readOwners, readSigninAllowlist, readDemoAllowlist, type ListEnv } from "./allowlist.ts";
import { ConfigError, readModelConfig, readSignInProviders, readSignup, readDemoCaps } from "./config.ts";
import { readIdentity } from "./poppy/keys.ts";
import { readPrivacyContact } from "./privacy.ts";

/**
 * Who a deployment is for and where it lives: the settings the committed
 * template leaves empty, so a copy nobody has configured fails closed. The
 * Worker checks them on every request; `scripts/check-deployment.ts` checks
 * the built config before `npm run deploy` uploads it, so a deploy without
 * the deployer's `deployment.local.json` stops instead of replacing their
 * production values with the template's empty ones.
 *
 * Plain functions over vars, with explicit `.ts` imports, so Node can run
 * them in the deploy script as well.
 */
export type DeploymentEnv = ListEnv & {
  readonly PUBLIC_ORIGIN?: string;
  readonly POPPY_CLIENT_NAME?: string;
  readonly POPPY_LOGO_URI?: string;
};

const CHECKS: ReadonlyArray<(env: DeploymentEnv) => unknown> = [
  readOwners,
  (env) => (readSignup(env) === "allowlist" ? readSigninAllowlist(env) : null),
  readDemoAllowlist,
  readIdentity,
  readModelConfig,
  readDemoCaps,
  readSignInProviders,
  readPrivacyContact
];

/** Every problem with the deployment's vars, each naming its setting; empty when it is configured. */
export function deploymentProblems(env: DeploymentEnv): string[] {
  const problems: string[] = [];
  for (const check of CHECKS) {
    try {
      check(env);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(error.message);
    }
  }
  return problems;
}

/** Throws the first problem as a `ConfigError`. */
export function checkDeployment(env: DeploymentEnv): void {
  const [first] = deploymentProblems(env);
  if (first !== undefined) throw new ConfigError(first);
}
