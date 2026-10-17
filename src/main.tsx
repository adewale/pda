import { createRoot } from "react-dom/client";
import { App } from "./client";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
