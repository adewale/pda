#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Unknown inputs run everything. Only known documentation and frontend inputs
// may omit the server/process/Company-kit checks.
export function scope(paths, full = false) {
  let runtime = full, specialist = full;
  for (const file of paths) {
    // This Markdown is imported into the public page; it is a runtime input.
    if (file === "docs/ecosystem.md") { runtime = true; continue; }
    if (/\.md$/.test(file) || file.startsWith("docs/") || file === "LICENSE" || file === "NOTICE.md") continue;
    runtime = true;
    const frontend = file.startsWith("src/ui/") || file.startsWith("test/ui/") || file.startsWith("public/") ||
      ["src/client.tsx", "src/poppy-ui.tsx", "src/use-pi-session.ts", "index.html"].includes(file);
    if (!frontend) specialist = true;
  }
  return { runtime, specialist };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const full = process.env.EVENT_NAME !== "pull_request";
  const paths = full ? [] : execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", process.env.BASE_SHA, "HEAD"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const selected = scope(paths, full);
  for (const [key, value] of Object.entries(selected)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(selected);
}
