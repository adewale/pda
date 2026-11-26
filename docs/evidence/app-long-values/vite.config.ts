import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The page's production components and styles, served with a fixture in place of the agent's socket (see README.md). */
const root = path.resolve(import.meta.dirname, "../../..");

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  define: { __PDA_COMMIT__: JSON.stringify("evidence"), __PDA_COMPATIBILITY_DATE__: JSON.stringify("evidence") },
  server: { fs: { allow: [root] }, strictPort: true },
  resolve: { dedupe: ["react", "react-dom"] }
});
