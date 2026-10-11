import path from "node:path";
import { defineConfig } from "vitest/config";

const here = import.meta.dirname;
const root = path.join(here, "../..");
const shared = path.join(root, "interop/impls/shared");

/** A deep local run (`HEGEL_CASES=5000`) gets time to finish; the default run keeps the usual limit. */
const deep = Number(process.env.HEGEL_CASES ?? "0") > 0;

/**
 * Property-based tests with Hegel (hegel.dev), in Node: Hegel's engine loads
 * through FFI, which workerd doesn't have. Our pure code runs here as it
 * ships; `cloudflare:workers` is the interop adapters' small shim, and the
 * mock Company's import of our Worker is a stub (its tests serve our client
 * metadata to it directly).
 */
export default defineConfig({
  root,
  resolve: {
    alias: [
      { find: /^cloudflare:workers$/, replacement: path.join(shared, "cloudflare-workers.ts") },
      { find: /^\.\.\/\.\.\/src\/index$/, replacement: path.join(shared, "no-worker.ts") }
    ]
  },
  test: {
    name: "properties",
    environment: "node",
    include: [path.join(here, "**/*.test.ts")],
    testTimeout: deep ? 0 : 30_000
  }
});
