#!/usr/bin/env node
/**
 * Run by `npm run deploy` between `vite build` and `wrangler deploy`: reads
 * the config the build wrote (the one `wrangler deploy` will upload, found
 * through `.wrangler/deploy/config.json`) and refuses to go on if its vars
 * don't say who the deployment is for and where it lives. Without the
 * deployer's `deployment.local.json` the build holds the template's empty
 * values, and uploading them would replace the production ones; this stops
 * that before anything is sent. It also resolves the models the vars name in
 * the catalogs this build ships (`src/model-catalog.ts`), so a dependency that
 * renamed one stops the deploy instead of failing every call after it.
 *
 * Exit status: 0 configured, 1 not configured, 2 no build to check.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { deploymentProblems, type DeploymentEnv } from "../src/deployment.ts";
import { modelCatalogProblems } from "../src/model-catalog.ts";

const root = path.resolve(import.meta.dirname, "..");
const redirect = path.join(root, ".wrangler", "deploy", "config.json");
if (!existsSync(redirect)) {
  process.stderr.write("check-deployment: no build found; run `vite build` first.\n");
  process.exit(2);
}
const { configPath } = JSON.parse(readFileSync(redirect, "utf8")) as { configPath: string };
const built = JSON.parse(readFileSync(path.resolve(path.dirname(redirect), configPath), "utf8")) as { vars?: DeploymentEnv };
const vars = built.vars ?? {};
const configured = deploymentProblems(vars);
// The catalogs are asked only about settings that parse; the others are already reported.
const problems = configured.length > 0 ? configured : modelCatalogProblems(vars);
if (problems.length > 0) {
  process.stderr.write(
    [
      "check-deployment: not deploying; this build isn't configured:",
      ...problems.map((problem) => `  - ${problem}`),
      "",
      configured.length > 0
        ? "Set these in deployment.local.json (copy deployment.example.json), then run `npm run deploy` again."
        : "Name models the installed catalogs list, in wrangler.jsonc or deployment.local.json, then run `npm run deploy` again.",
      ""
    ].join("\n")
  );
  process.exit(1);
}
process.stdout.write("check-deployment: configured.\n");
