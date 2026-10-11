/**
 * Bundles one of our adapters into a single ES module for Node, inside its
 * Docker build: `node build.mjs <entry.ts> <out.mjs>`.
 *
 * `cloudflare:workers` becomes a small shim (cloudflare-workers.ts) and the
 * mock Company's import of the Worker (`src/index`) becomes a stub
 * (no-worker.ts); everything else is our code as it ships, plus jose.
 */
import path from "node:path";
import { build } from "esbuild";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: node build.mjs <entry.ts> <out.mjs>");
  process.exit(2);
}
const shared = import.meta.dirname;

/** @type {import("esbuild").Plugin} */
const workersShim = {
  name: "workers-shim",
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: path.join(shared, "cloudflare-workers.ts") }));
    b.onResolve({ filter: /\/src\/index$/ }, (args) =>
      args.importer.includes(`${path.sep}mock-company${path.sep}`) ? { path: path.join(shared, "no-worker.ts") } : undefined
    );
  }
};

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "inline",
  plugins: [workersShim],
  logLevel: "warning"
});
