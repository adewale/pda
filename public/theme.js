// The stored or system theme, before the page draws: a file rather than an
// inline script, so the Content-Security-Policy can allow scripts from this
// origin only (src/csp.ts).
(() => {
  let stored = null;
  try {
    stored = localStorage.getItem("theme");
  } catch {}
  const mode = stored || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-mode", mode);
  document.documentElement.style.colorScheme = mode;
})();
