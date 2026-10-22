/**
 * The committed template is what every fork deploys: it must name nobody,
 * point at nobody's host, and refuse to run until its deployer says who it is
 * for and where it lives.
 *
 * What is scanned: every committed file a fork inherits except
 * documentation (Markdown, `docs/` artifacts, licenses and protocol snapshots in `spec/`). That is the code (`src/`, `scripts/`, `public/`), the tests
 * (`test/`), the interop harness (`interop/`, its registry and known
 * failures included), CI (`.github/`, `.githooks/`) and the root config
 * files. Documentation (`*.md`) may name the live deployment: the README
 * links to it, and a fork's copy of a link deploys nothing. Ignored paths
 * (`interop/results/`, Python and Hegel caches) aren't committed, so they
 * aren't scanned.
 *
 * Whose identities: never written here. They come from the deployer's own
 * untracked `deployment.local.json` when it exists (the emails, domains,
 * GitHub logins and ids, and origins it sets); without it that check is
 * skipped and the generic ones still run.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deploymentProblems, type DeploymentEnv } from "../src/deployment";
import devVarsExample from "../.dev.vars.example?raw";
import dockerIgnore from "../.dockerignore?raw";
import gitIgnore from "../.gitignore?raw";
import deploymentExample from "../deployment.example.json?raw";
import envTypes from "../env.d.ts?raw";
import indexHtml from "../index.html?raw";
import packageLock from "../package-lock.json?raw";
import packageJson from "../package.json?raw";
import tsconfig from "../tsconfig.json?raw";
import viteConfig from "../vite.config.ts?raw";
import wranglerConfig from "../wrangler.jsonc?raw";
import { fetchWorker, ORIGIN, person, sessionCookie, wsRequest } from "./agent-helpers";
// A glob leaves out the file that holds it.
import thisTest from "./template.test.ts?raw";

/** Git's independent inventory, injected by the Node test config. */
declare const __TEST_TEMPLATE_FILES__: readonly string[];

/** Vite names a glob's files relative to this one (`./x.ts` here, `../src/x.ts` elsewhere); these are relative to the repository. */
function fromRoot(files: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([key, text]) => [key.startsWith("./") ? `test/${key.slice(2)}` : key.replace(/^\.\.\//, ""), text as string]));
}

/** Every scanned file's text, by its path in the repository. */
const sources: Record<string, string> = {
  ...fromRoot(import.meta.glob(
    [
      "../src/**/*",
      "../scripts/**/*",
      "../public/**/*",
      "../test/**/*",
      "../interop/**/*",
      "../.github/**/*",
      "../.githooks/*",
      "../.nvmrc",
      // Documentation may name the live deployment.
      "!**/*.md",
      "!**/LICENSE",
      // Not committed (.gitignore).
      "!**/node_modules/**",
      "!../interop/results/**",
      // The live lane's private key and client_id (scripts/interop-live-identity.mjs).
      "!../interop/.live-identity.json",
      "!**/.venv/**",
      "!**/.hypothesis/**",
      "!**/__pycache__/**",
      "!**/.pytest_cache/**",
      "!**/.hegel/**",
      "!**/.DS_Store"
    ],
    { query: "?raw", import: "default", eager: true, exhaustive: true }
  )),
  ".dev.vars.example": devVarsExample,
  ".dockerignore": dockerIgnore,
  ".gitignore": gitIgnore,
  "deployment.example.json": deploymentExample,
  "env.d.ts": envTypes,
  "index.html": indexHtml,
  "package-lock.json": packageLock,
  "package.json": packageJson,
  "tsconfig.json": tsconfig,
  "vite.config.ts": viteConfig,
  "wrangler.jsonc": wranglerConfig,
  "test/template.test.ts": thisTest
};

/** The deployer's untracked vars, if this checkout has them. Never committed (.gitignore). */
const localFile = Object.values(import.meta.glob("../deployment.local.json", { query: "?raw", import: "default", eager: true }))[0] as
  | string
  | undefined;

/** Hosts a committed non-doc file may name under workers.dev: the example's placeholder, and other projects' public demo Companies the validator's fixtures copy. */
const WORKERS_DEV_ALLOWED = new Set([
  "personal-agent.your-subdomain.workers.dev",
  "poppy-receiver.roundtrip.workers.dev",
  "poppy-caller.roundtrip.workers.dev"
]);

/** Names reserved for examples and tests (RFC 2606, RFC 6761): the only domains committed config and code may give an identity. */
const RESERVED_DOMAIN = /(?:^|\.)(?:example|test|invalid|localhost|example\.com|example\.net|example\.org)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * This repository's own URL: the `source` of the interop registry's
 * `owner: "self"` entries. A fork inherits it, and it is right there: it says
 * where those images' code comes from, and known failures link to its
 * issues. The About page also links to the public source project. This URL
 * grants no deployment access; the exception is limited to source attribution.
 */
const registry = JSON.parse(sources["interop/registry.json"]!) as { implementations: { owner?: string; source?: string }[] };
const REPO_URLS = new Set(registry.implementations.filter((entry) => entry.owner === "self").map((entry) => entry.source));
const REPO_URL_ALLOWED_IN = new Set(["interop/registry.json", "interop/known-failures.json", "src/public/project.ts"]);

/**
 * Other projects the interop harness pins, as `owner/repo`, from the
 * registry's GitHub `source` URLs. A login that owns one of them is named by
 * that reference because it is a public upstream, not because it is on the
 * deployer's lists, so the reference is taken out before the identity scan
 * (the same login anywhere else still fails it).
 */
const UPSTREAM_REPOS = new Set(
  registry.implementations
    .filter((entry) => entry.owner !== "self")
    .map((entry) => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(entry.source ?? "")?.[1])
    .filter((repo): repo is string => repo !== undefined)
);

/** A file's text with this repository's own URL taken out, where it is allowed. */
function withoutRepoUrl(file: string, text: string): string {
  if (!REPO_URL_ALLOWED_IN.has(file)) return text;
  let out = text;
  for (const url of REPO_URLS) if (url) out = out.split(url).join("");
  return out;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Lists = { emails?: unknown; domains?: unknown; github?: unknown };

/** One identity the deployer set, as a pattern bounded so a longer name or number doesn't match by accident. */
type Needle = { readonly what: string; readonly pattern: RegExp };

/** Every identity and origin `deployment.local.json` sets. Patterns, never printed values: a failure names the kind and file. */
function localIdentities(text: string): Needle[] {
  const vars = JSON.parse(text) as Record<string, unknown>;
  const read = (value: unknown): unknown => (typeof value === "string" && value.trim().startsWith("{") ? JSON.parse(value) : value);
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : []);
  const needles: Needle[] = [];
  for (const name of ["OWNERS", "SIGNIN_ALLOWLIST", "DEMO_ALLOWLIST"]) {
    const lists = (read(vars[name]) ?? {}) as Lists;
    for (const email of strings(lists.emails)) needles.push({ what: `an email in ${name}`, pattern: new RegExp(`(?<![\\w.+-])${escape(email)}(?![\\w-])`, "i") });
    for (const domain of strings(lists.domains)) needles.push({ what: `a domain in ${name}`, pattern: new RegExp(`(?<![\\w.-])${escape(domain)}(?![\\w-])`, "i") });
    const github = lists.github && typeof lists.github === "object" ? (lists.github as Record<string, unknown>) : {};
    for (const [login, id] of Object.entries(github)) {
      needles.push({ what: `a GitHub login in ${name}`, pattern: new RegExp(`(?<![A-Za-z0-9-])${escape(login)}(?![A-Za-z0-9-])`, "i") });
      if (typeof id === "number" || (typeof id === "string" && id !== "")) {
        needles.push({ what: `a GitHub id in ${name}`, pattern: new RegExp(`(?<![A-Za-z0-9])${escape(String(id))}(?![A-Za-z0-9])`) });
      }
    }
  }
  for (const name of ["PUBLIC_ORIGIN", "POPPY_LOGO_URI"]) {
    const value = vars[name];
    if (typeof value !== "string" || value === "") continue;
    const host = new URL(value).hostname;
    if (WORKERS_DEV_ALLOWED.has(host)) continue;
    needles.push({ what: `the host of ${name}`, pattern: new RegExp(`(?<![\\w.-])${escape(host)}(?![\\w-])`, "i") });
  }
  return needles;
}

/** The files that hold one of `needles`, as "file: what"; never the value. */
function filesNaming(needles: readonly Needle[]): string[] {
  return Object.entries(sources).flatMap(([file, text]) => {
    let scanned = withoutRepoUrl(file, text);
    for (const repo of UPSTREAM_REPOS) scanned = scanned.replace(new RegExp(`(?<![\\w.-])${escape(repo)}(?![\\w-])`, "gi"), "");
    return needles.filter((needle) => needle.pattern.test(scanned)).map((needle) => `${file}: ${needle.what}`);
  });
}

/** The template's vars, from wrangler.jsonc (whose comments are whole lines). */
function templateVars(): DeploymentEnv {
  const json = wranglerConfig
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return (JSON.parse(json) as { vars: DeploymentEnv }).vars;
}

describe("the committed template", () => {
  it("reads every committed file a fork inherits but its docs", () => {
    const files = Object.keys(sources);
    expect(files.sort()).toEqual([...__TEST_TEMPLATE_FILES__].sort());
    expect(files.length).toBeGreaterThan(250);
    for (const file of [
      "src/index.ts",
      "scripts/poppy-validate.ts",
      "test/template.test.ts",
      "test/wrangler.jsonc",
      "test/hypothesis/uv.lock",
      "interop/registry.json",
      "interop/known-failures.json",
      "interop/runner/cli.ts",
      ".github/workflows/ci.yml",
      ".githooks/pre-push",
      "package.json",
      "wrangler.jsonc"
    ]) {
      expect(files, file).toContain(file);
    }
    expect(files.filter((file) => file.endsWith(".md"))).toEqual([]);
    expect(files.filter((file) => /(?:^|\/)(?:node_modules|interop\/results|\.venv|\.hypothesis|__pycache__|\.pytest_cache|\.hegel)\//.test(file))).toEqual([]);
    expect(files).not.toContain("deployment.local.json");
    expect(files).not.toContain("interop/.live-identity.json");
  });

  it("holds none of the deployer's identities or origins (from deployment.local.json, when this checkout has one)", (context) => {
    if (localFile === undefined) context.skip();
    const needles = localIdentities(localFile!);
    expect(needles.length).toBeGreaterThan(0);
    expect(filesNaming(needles)).toEqual([]);
  });

  it("knows the upstream repositories the harness pins, so their owners' names in those references aren't identities", () => {
    expect(UPSTREAM_REPOS.size).toBeGreaterThan(5);
    expect(UPSTREAM_REPOS).toContain("spenciefy/print-with-poppy");
    for (const repo of UPSTREAM_REPOS) expect(repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  it("names this repository's own URL only in the interop references and public source attribution", () => {
    expect(REPO_URLS.size).toBe(1);
    const [url] = [...REPO_URLS];
    expect(url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    const elsewhere = Object.entries(sources)
      .filter(([file, text]) => !REPO_URL_ALLOWED_IN.has(file) && text.includes(url!))
      .map(([file]) => file);
    expect(elsewhere).toEqual([]);
  });

  it("gives an email address only at a name reserved for examples", () => {
    const found = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(EMAIL)].filter((match) => !RESERVED_DOMAIN.test(match[1]!)).map((match) => `${file}: ${match[0]}`)
    );
    expect(found).toEqual([]);
  });

  it("names no workers.dev host except the example's placeholder and other projects' public demos", () => {
    const found = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(/[\w.-]*\.workers\.dev/g)].map((match) => match[0]).filter((host) => !WORKERS_DEV_ALLOWED.has(host)).map((host) => `${file}: ${host}`)
    );
    expect(found).toEqual([]);
  });

  it("commits empty identity placeholders, and example identities only at reserved names", () => {
    const vars = templateVars() as unknown as Record<string, unknown>;
    expect(vars.OWNERS).toEqual({ emails: [], github: {} });
    expect(vars.SIGNIN_ALLOWLIST).toEqual({ emails: [], domains: [], github: {} });
    expect(vars.DEMO_ALLOWLIST).toEqual({ emails: [], domains: [], github: {} });
    expect(vars.PUBLIC_ORIGIN).toBe("");
    expect(vars.POPPY_LOGO_URI).toBe("");
    // The interop test client is off until a deployer sets its public keys.
    expect(vars.INTEROP_LIVE_JWKS).toBe("");
    expect(JSON.parse(deploymentExample).INTEROP_LIVE_JWKS).toBe("");

    // The example file and the test deployment show the shape with reserved names only.
    const testVars = JSON.parse(
      sources["test/wrangler.jsonc"]!
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n")
    ) as { vars: Record<string, unknown> };
    for (const [file, shown] of [
      ["deployment.example.json", JSON.parse(deploymentExample) as Record<string, unknown>],
      ["test/wrangler.jsonc", testVars.vars]
    ] as const) {
      for (const name of ["OWNERS", "SIGNIN_ALLOWLIST", "DEMO_ALLOWLIST"]) {
        const lists = (shown[name] ?? {}) as { emails?: string[]; domains?: string[] };
        for (const email of lists.emails ?? []) expect(email.split("@")[1], `${file} ${name}`).toMatch(RESERVED_DOMAIN);
        for (const domain of lists.domains ?? []) expect(domain, `${file} ${name}`).toMatch(RESERVED_DOMAIN);
      }
      for (const name of ["PUBLIC_ORIGIN", "POPPY_LOGO_URI"]) {
        const value = shown[name];
        if (typeof value !== "string" || value === "") continue;
        const host = new URL(value).hostname;
        expect(WORKERS_DEV_ALLOWED.has(host) || RESERVED_DOMAIN.test(host), `${file} ${name}`).toBe(true);
      }
    }
  });

  it("is unconfigured: it names who must be set, and where the agent lives", () => {
    const problems = deploymentProblems(templateVars());
    expect(problems.some((problem) => problem.startsWith("OWNERS is empty"))).toBe(true);
    expect(problems).toContain("Missing required setting PUBLIC_ORIGIN");
    expect(templateVars().SIGNUP).toBe("allowlist");
  });

  it("fails closed: every signed-in route refuses until OWNERS and PUBLIC_ORIGIN are set", async () => {
    const template = templateVars() as unknown as Partial<Env>;
    const cookie = await sessionCookie(person());
    for (const request of [
      new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } }),
      new Request(`${ORIGIN}/api/entitlement`, { headers: { Cookie: cookie } }),
      new Request(`${ORIGIN}/auth/github`),
      wsRequest({ cookie })
    ]) {
      const response = await fetchWorker(request, template);
      expect(response.status).toBe(500);
      expect(await response.text()).toMatch(/^OWNERS/);
    }
    const configured = { ...template, OWNERS: { emails: ["op@example.com"], github: {} } } as unknown as Partial<Env>;
    const noOrigin = await fetchWorker(new Request(`${ORIGIN}/api/me`, { headers: { Cookie: cookie } }), configured);
    expect(await noOrigin.text()).toBe("Missing required setting PUBLIC_ORIGIN");
  });

  it("is configured by the example file's shape", () => {
    const vars = { ...templateVars(), ...(JSON.parse(deploymentExample) as DeploymentEnv) };
    expect(deploymentProblems(vars)).toEqual([]);
    // The test deployment is configured too.
    expect(deploymentProblems(env as unknown as DeploymentEnv)).toEqual([]);
  });

  it("refuses a build whose SIGNIN_PROVIDERS a config merge appended to, before anything is uploaded", () => {
    const vars = { ...templateVars(), ...(JSON.parse(deploymentExample) as DeploymentEnv) };
    const appended = { ...vars, SIGNIN_PROVIDERS: ["github", "google", "github"] } as unknown as DeploymentEnv;
    expect(deploymentProblems(appended)).toEqual(["SIGNIN_PROVIDERS lists a provider twice"]);
  });
});
