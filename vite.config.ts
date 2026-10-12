import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { buildDefines } from "./scripts/build-info.ts";

/**
 * The deployer's own vars: who the deployment is for (`OWNERS`, the
 * allowlists) and where it lives (`PUBLIC_ORIGIN`, `POPPY_LOGO_URI`), from
 * the untracked `deployment.local.json`, laid over `wrangler.jsonc`'s empty
 * template values for `vite dev` and `vite build`. Only vars the template
 * declares may be set, so a misspelt name fails instead of being ignored.
 * `npm run deploy` then refuses a build that is still unconfigured
 * (`scripts/check-deployment.ts`), so a missing file can't replace the
 * production values with empty ones.
 */
const LOCAL_VARS = path.join(import.meta.dirname, "deployment.local.json");

function localVars(declared: Record<string, unknown>): Record<string, unknown> {
  if (!existsSync(LOCAL_VARS)) return {};
  const vars = JSON.parse(readFileSync(LOCAL_VARS, "utf8")) as Record<string, unknown>;
  const unknown = Object.keys(vars).filter((name) => !(name in declared));
  if (unknown.length > 0) {
    throw new Error(`deployment.local.json sets vars wrangler.jsonc doesn't declare: ${unknown.join(", ")}`);
  }
  return vars;
}

export default defineConfig({
  // The commit and compatibility date every wide event carries (src/log.ts).
  define: buildDefines(path.join(import.meta.dirname, "wrangler.jsonc")),
  plugins: [
    react(),
    // Assigned, not returned: the plugin deep-merges a returned config, which
    // would append a local list (SIGNIN_PROVIDERS) to the template's.
    cloudflare({
      config: (config) => {
        config.vars = { ...config.vars, ...localVars(config.vars ?? {}) };
      }
    }),
    tailwindcss()
  ],
  resolve: {
    // One copy of each pi package, so the harness and the app share pi's
    // module state.
    dedupe: [
      "react",
      "react-dom",
      "@earendil-works/chord",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry"
    ]
  }
});
