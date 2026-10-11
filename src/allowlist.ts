import { ConfigError } from "./config";
import type { Identity } from "./session";

/**
 * Who may sign in, from the `ALLOWLIST` var in `wrangler.jsonc`; change it
 * and redeploy. Checked at sign-in and on every request, so removing someone
 * locks them out on their next request.
 *
 * - `emails`: Google accounts whose verified email is one of these.
 * - `domains`: Google Workspace accounts of these domains (Google's `hd`
 *   claim), so a personal Google account that merely uses a work address does
 *   not count.
 * - `github`: GitHub accounts, as `login: numeric id`. The id is what is
 *   checked, because a login can be renamed and then claimed by someone else.
 *   Find an id with `gh api users/<login> --jq .id`.
 */
export type Allowlist = {
  readonly emails: ReadonlySet<string>;
  readonly domains: ReadonlySet<string>;
  readonly githubIds: ReadonlySet<string>;
};

function fail(detail: string): never {
  throw new ConfigError(`ALLOWLIST ${detail}`);
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`.${name} must be a list of strings`);
  }
  return (value as string[]).map((entry) => entry.trim().toLowerCase());
}

/** The allowlist; missing or malformed is a config error. Empty lets nobody in. */
export function readAllowlist(env: { readonly ALLOWLIST?: unknown }): Allowlist {
  let raw = env.ALLOWLIST;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      fail("is not valid JSON");
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("must be an object with emails, domains and github");
  }
  const { emails, domains, github, ...extra } = raw as Record<string, unknown>;
  if (Object.keys(extra).length > 0) fail(`has unknown keys: ${Object.keys(extra).join(", ")}`);

  const emailList = strings(emails, "emails");
  for (const email of emailList) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`.emails has an invalid address: ${email}`);
  }
  const domainList = strings(domains, "domains");
  for (const domain of domainList) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) fail(`.domains has an invalid domain: ${domain}`);
  }
  if (typeof github !== "object" || github === null || Array.isArray(github)) {
    fail(".github must be an object of login: numeric id");
  }
  const githubIds = Object.entries(github as Record<string, unknown>).map(([login, id]) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      fail(`.github.${login} must be the account's numeric id`);
    }
    return String(id);
  });
  return {
    emails: new Set(emailList),
    domains: new Set(domainList),
    githubIds: new Set(githubIds)
  };
}

/** Whether this signed-in identity is on the allowlist. */
export function isAllowed(identity: Identity, allowlist: Allowlist): boolean {
  if (identity.provider === "github") return allowlist.githubIds.has(identity.sub);
  const email = identity.email?.toLowerCase();
  if (email && allowlist.emails.has(email)) return true;
  const domain = identity.domain?.toLowerCase();
  return !!domain && allowlist.domains.has(domain);
}
