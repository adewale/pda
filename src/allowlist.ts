import { ConfigError, readSignup, type ConfigEnv } from "./config.ts";
import type { Identity } from "./session";

/**
 * Lists of people, as Wrangler vars. Three use this format:
 *
 * - `OWNERS`: who runs this deployment. Always allowed to sign in, always on
 *   the demo. Required and non-empty, so an unconfigured copy fails closed.
 *   Emails and GitHub accounts only: an owner is a person, not a domain.
 * - `SIGNIN_ALLOWLIST`: who may sign in when `SIGNUP` is `allowlist`.
 * - `DEMO_ALLOWLIST`: who the operator pays model calls for, up to the
 *   daily caps. Everyone else needs their own key.
 *
 * Checked at sign-in and on every request, so removing someone takes effect
 * on their next request. Their agent checks too, against the identity it
 * stored, before every model call and before each reminder or task runs:
 * someone who can no longer sign in gets no model calls (not even on their
 * own key), and their reminders and tasks pause (src/schedules.ts).
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

export type ListEnv = ConfigEnv & {
  readonly OWNERS?: unknown;
  readonly SIGNIN_ALLOWLIST?: unknown;
  readonly DEMO_ALLOWLIST?: unknown;
};

function strings(name: string, value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ConfigError(`${name} .${key} must be a list of strings`);
  }
  return (value as string[]).map((entry) => entry.trim().toLowerCase());
}

/** One list; missing or malformed is a config error naming `name`. Empty lets nobody in. */
export function parseAllowlist(name: string, raw: unknown, options: { domains?: boolean } = {}): Allowlist {
  const fail = (detail: string): never => {
    throw new ConfigError(`${name} ${detail}`);
  };
  const withDomains = options.domains ?? true;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      fail("is not valid JSON");
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(withDomains ? "must be an object with emails, domains and github" : "must be an object with emails and github");
  }
  const { emails, domains, github, ...extra } = raw as Record<string, unknown>;
  const unknown = Object.keys(extra);
  if (!withDomains && domains !== undefined) unknown.unshift("domains");
  if (unknown.length > 0) fail(`has unknown keys: ${unknown.join(", ")}`);

  const emailList = strings(name, emails, "emails");
  for (const email of emailList) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`.emails has an invalid address: ${email}`);
  }
  const domainList = withDomains ? strings(name, domains, "domains") : [];
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

/** `OWNERS`: required, and must name at least one person. */
export function readOwners(env: ListEnv): Allowlist {
  const owners = parseAllowlist("OWNERS", env.OWNERS, { domains: false });
  if (owners.emails.size === 0 && owners.githubIds.size === 0) {
    throw new ConfigError("OWNERS is empty: name this deployment's operators (an email or a GitHub id)");
  }
  return owners;
}

export function readSigninAllowlist(env: ListEnv): Allowlist {
  return parseAllowlist("SIGNIN_ALLOWLIST", env.SIGNIN_ALLOWLIST);
}

export function readDemoAllowlist(env: ListEnv): Allowlist {
  return parseAllowlist("DEMO_ALLOWLIST", env.DEMO_ALLOWLIST);
}

/** Whether this signed-in identity is on the list. */
export function isAllowed(identity: Pick<Identity, "provider" | "sub" | "email" | "domain">, allowlist: Allowlist): boolean {
  if (identity.provider === "github") return allowlist.githubIds.has(identity.sub);
  const email = identity.email?.toLowerCase();
  if (email && allowlist.emails.has(email)) return true;
  const domain = identity.domain?.toLowerCase();
  return !!domain && allowlist.domains.has(domain);
}

/**
 * Whether this identity may use the app: an owner always; otherwise anyone
 * when `SIGNUP` is `open`, or someone on `SIGNIN_ALLOWLIST`. `OWNERS` is
 * read every time, so a copy nobody has configured lets nobody in.
 */
export function maySignIn(identity: Pick<Identity, "provider" | "sub" | "email" | "domain">, env: ListEnv): boolean {
  if (isAllowed(identity, readOwners(env))) return true;
  if (readSignup(env) === "open") return true;
  return isAllowed(identity, readSigninAllowlist(env));
}

/** Whether the operator pays for this identity's model calls (up to the caps). */
export function onDemo(identity: Pick<Identity, "provider" | "sub" | "email" | "domain">, env: ListEnv): boolean {
  return isAllowed(identity, readOwners(env)) || isAllowed(identity, readDemoAllowlist(env));
}

/**
 * Whose shared daily demo budget this identity spends: its Google Workspace
 * domain, or `personal` for personal Google accounts and GitHub accounts,
 * which share one.
 */
export function budgetDomain(identity: Pick<Identity, "domain">): string {
  return identity.domain?.toLowerCase() || "personal";
}
