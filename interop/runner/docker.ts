/** The `docker` CLI, as the runner uses it. */
import { execFile, execFileSync } from "node:child_process";

/**
 * `env` adds to the docker CLI's own environment, for `-e NAME` arguments
 * that take their value from it: a secret passed so stays out of the
 * command line (and out of `ps`).
 */
export function docker(args: string[], options: { quiet?: boolean; env?: Readonly<Record<string, string>> } = {}): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", options.quiet ? "pipe" : "inherit"],
      maxBuffer: 64 * 1024 * 1024,
      ...(options.env && Object.keys(options.env).length ? { env: { ...process.env, ...options.env } } : {})
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() ?? "";
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }
}

/** A build, streamed to a log, in the background of other work. */
export function dockerAsync(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}` });
    });
  });
}

/** Bound concurrent builds while retaining registry order in their results. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Concurrency must be a positive whole number");
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Default subdomains of `<name>.company.interop.test` that resolve to the proxy. */
export const DEFAULT_SUBDOMAINS = ["www", "auth", "api", "mcp", "cdn", "uk", "app", "login", "id", "accounts", "oauth", "chat", "agent"] as const;

/** Every name the proxy answers for, as network aliases. */
export function proxyAliases(agents: readonly string[], companies: readonly { name: string; subdomains?: readonly string[] }[]): string[] {
  const names = new Set<string>(["runner.interop.test"]);
  for (const agent of agents) names.add(`${agent}.agent.interop.test`);
  for (const company of companies) {
    const domain = `${company.name}.company.interop.test`;
    names.add(domain);
    for (const sub of [...DEFAULT_SUBDOMAINS, ...(company.subdomains ?? [])]) names.add(`${sub}.${domain}`);
  }
  return [...names];
}
