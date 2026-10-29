#!/bin/sh
# build.sh <repo> <base|head> <out>: render PoppyCard from <repo>'s own source and CSS, built by Vite with React and Tailwind.
set -e
repo=$1; which=$2; out=$3; here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$repo/.shot"
cp "$here/fixtures.mjs" "$repo/.shot/fixtures.mjs"
cat > "$repo/.shot/index.html" <<HTML
<!doctype html><html><head><meta charset="utf-8"></head><body class="bg-kumo-base"><div id="root" style="width:560px;padding:16px"></div><script type="module" src="./entry.tsx"></script></body></html>
HTML
cat > "$repo/.shot/entry.tsx" <<TSX
import "../src/styles.css";
import { createRoot } from "react-dom/client";
import { PoppyCard } from "../src/poppy-ui";
import { $which as cards } from "./fixtures.mjs";
createRoot(document.getElementById("root")!).render(<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{cards.map((card: any) => <PoppyCard key={card.id} card={card} send={() => true} />)}</div>);
TSX
cat > "$repo/.shot/vite.config.mjs" <<JS
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default { root: "$repo", base: "./", plugins: [react(), tailwindcss()], logLevel: "warn", build: { outDir: "$out", emptyOutDir: true, rollupOptions: { input: "$repo/.shot/index.html" } } };
JS
(cd "$repo" && node node_modules/vite/bin/vite.js build --config .shot/vite.config.mjs)
rm -rf "$repo/.shot"
