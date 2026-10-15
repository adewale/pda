import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const uiDir = import.meta.dirname;

/**
 * The page, in happy-dom rather than the
 * Workers runtime. Files here end in `.test.tsx`, so the Workers suite
 * (`test/**` `*.test.ts`) never picks them up.
 */
export default defineConfig({
  plugins: [react()],
  root: path.join(uiDir, "../.."),
  resolve: { dedupe: ["react", "react-dom"] },
  test: {
    name: "page",
    environment: "happy-dom",
    include: [path.join(uiDir, "**/*.test.tsx")],
    setupFiles: [path.join(uiDir, "setup.ts")],
    // The smoke test dynamically imports the whole app. A cold transform can
    // exceed Vitest's 5s default and leave its async act running into the next test.
    testTimeout: 30_000,
    restoreMocks: true
  }
});
