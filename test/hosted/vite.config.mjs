/** Build only frontend assets; never reads deployment.local.json or the production deploy redirect. */
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { buildDefines } from "../../scripts/build-info.ts";
const root = path.resolve(import.meta.dirname, "../..");
export default defineConfig({
  root,
  define: buildDefines(path.join(import.meta.dirname, "pda.wrangler.jsonc")),
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom", "@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/pi-telemetry"] }
});
