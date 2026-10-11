import path from "node:path";
import { defineConfig } from "vitest/config";

const interopDir = import.meta.dirname;

/**
 * The interop harness's own pieces, in Node: scenario interpolation and
 * expectations, the cell runner, trace checks, attribution and the report.
 * No Docker here; `npm run interop` runs the grid itself.
 */
export default defineConfig({
  root: path.join(interopDir, ".."),
  test: {
    name: "interop",
    environment: "node",
    include: [path.join(interopDir, "test/**/*.test.ts")]
  }
});
