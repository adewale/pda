/**
 * What the build tells every wide event (src/log.ts) about itself: the
 * commit it was built from (`git rev-parse --short HEAD`, or "unknown"
 * outside a git checkout) and the Worker's compatibility date, from the
 * Wrangler file it runs under. Used as Vite `define`s by vite.config.ts and
 * the test configs; the runtime adds the version id and tag from the
 * `CF_VERSION_METADATA` binding.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function buildDefines(wranglerPath: string): Record<string, string> {
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    // Not a git checkout (a tarball, a container): the events say so.
  }
  const date = /"compatibility_date"\s*:\s*"([^"]+)"/.exec(readFileSync(wranglerPath, "utf8"))?.[1] ?? "unknown";
  return { __PDA_COMMIT__: JSON.stringify(commit), __PDA_COMPATIBILITY_DATE__: JSON.stringify(date) };
}
