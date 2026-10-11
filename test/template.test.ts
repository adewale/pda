/**
 * The committed template is what every fork deploys: it must name nobody,
 * point at nobody's host, and refuse to run until its deployer says who it is
 * for and where it lives.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deploymentProblems, type DeploymentEnv } from "../src/deployment";
import devVarsExample from "../.dev.vars.example?raw";
import deploymentExample from "../deployment.example.json?raw";
import envTypes from "../env.d.ts?raw";
import indexHtml from "../index.html?raw";
import packageJson from "../package.json?raw";
import viteConfig from "../vite.config.ts?raw";
import wranglerConfig from "../wrangler.jsonc?raw";
import { fetchWorker, ORIGIN, person, sessionCookie, wsRequest } from "./agent-helpers";

const sources: Record<string, string> = {
  ...import.meta.glob(["../src/**/*", "../scripts/**/*", "../public/**/*"], { query: "?raw", import: "default", eager: true }),
  "../.dev.vars.example": devVarsExample,
  "../deployment.example.json": deploymentExample,
  "../env.d.ts": envTypes,
  "../index.html": indexHtml,
  "../package.json": packageJson,
  "../vite.config.ts": viteConfig,
  "../wrangler.jsonc": wranglerConfig
} as Record<string, string>;

/** The author's identities and host, which an unedited fork would otherwise let in or call. */
const AUTHOR = [/adewale/i, /43644/, /4397978/, /ToddKerpelman/i, /sierra\.ai/i, /@gmail\.com/i, /adewale-883/i];

/** The template's vars, from wrangler.jsonc (whose comments are whole lines). */
function templateVars(): DeploymentEnv {
  const json = wranglerConfig
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return (JSON.parse(json) as { vars: DeploymentEnv }).vars;
}

describe("the committed template", () => {
  it("reads every file a fork deploys", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(40);
    expect(Object.keys(sources)).toContain("../src/index.ts");
    expect(Object.keys(sources)).toContain("../scripts/poppy-validate.ts");
  });

  it("holds no author hosts or identities", () => {
    const found = Object.entries(sources).flatMap(([file, text]) =>
      AUTHOR.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`)
    );
    expect(found).toEqual([]);
  });

  it("names no workers.dev host except the example's placeholder", () => {
    const found = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(/[\w.-]*\.workers\.dev/g)].map((match) => match[0]).filter((host) => host !== "personal-agent.your-subdomain.workers.dev").map((host) => `${file}: ${host}`)
    );
    expect(found).toEqual([]);
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
});
