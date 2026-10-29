import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default {
  root: import.meta.dirname, base: "./", plugins: [react(), tailwindcss()],
  build: { outDir: "/tmp/pda-pr36-audit-evidence-dist", emptyOutDir: true }
};
