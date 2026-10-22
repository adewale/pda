import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";
import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { Streamdown, type Components } from "streamdown";
import source from "../../docs/ecosystem.md?raw";
import { ECOSYSTEM_SOURCE, PROJECT_URL } from "./project";

/** Repository links keep working when the Markdown is read outside GitHub. */
function documentLink(href: string): string {
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return href;
  return new URL(href, `${PROJECT_URL}/blob/main/docs/`).href;
}

function textOf(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : typeof child === "string" || typeof child === "number" ? String(child) : "").join("");
}

/** Match GitHub's heading fragments, including the two hyphens around an em dash. */
function headingId(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
}

const COMPONENTS: Components = {
  h2: ({ children }) => <h2 id={headingId(textOf(children))}>{children}</h2>,
  h3: ({ children }) => <h3 id={headingId(textOf(children))}>{children}</h3>,
  a: ({ href, children }) => <a href={documentLink(href ?? "")}>{children}</a>,
  table: ({ children }) => <div className="ecosystem-table" role="region" aria-label="Ecosystem comparison table" tabIndex={0}><table>{children}</table></div>
};

// One source of truth. The current summary stays visible; dated evidence is a disclosure.
const body = source.replace(/^# The Poppy ecosystem\s*\n/, "")
  .replace(/<a id="[^"]+"><\/a>/g, "")
  // Resolve document links before the renderer's URL checks, which refuse bare relative paths.
  .replace(/\]\(([^)\s]+)\)/g, (_match, href: string) => `](${documentLink(href)})`)
  .replace(/```mermaid\n[\s\S]*?```/g, `[View the interoperability diagram on GitHub](${ECOSYSTEM_SOURCE}#how-they-work-together)`);
const historyAt = body.indexOf("## Dated implementation catalogue");
const summaryAt = body.indexOf("## Current ecosystem");
const introduction = summaryAt < 0 ? "" : body.slice(0, summaryAt);
const current = body.slice(Math.max(0, summaryAt), historyAt < 0 ? undefined : historyAt);
const historical = historyAt < 0 ? "" : `## Survey method and related research\n\n${introduction}\n${body.slice(historyAt)}`;
const currentHeading = /^## (Current ecosystem[^\n]*)/m.exec(current)?.[1];
const updated = /updated \*\*([^*]+)\*\*/.exec(source)?.[1];
const historicalIds = new Set([...historical.matchAll(/^#{2,3} (.+)$/gm)].map(match => headingId(match[1]!)));

function fragment(): string {
  try { return decodeURIComponent(window.location.hash.slice(1)); } catch { return ""; }
}

function Markdown({ children }: { children: string }) {
  return <Streamdown mode="static" controls={false} components={COMPONENTS} linkSafety={{ enabled: false }} className="ecosystem-prose">{children}</Streamdown>;
}

export default function Ecosystem() {
  const [open, setOpen] = useState(() => historicalIds.has(fragment()));
  // Following a deep link to an older result opens its disclosure before scrolling.
  useEffect(() => {
    const reveal = () => {
      const id = fragment();
      if (historicalIds.has(id)) setOpen(true);
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView?.());
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
  useEffect(() => {
    if (open) document.getElementById(fragment())?.scrollIntoView?.();
  }, [open]);
  return <article>
    <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">The Poppy ecosystem</h1>
    <p className="mt-4 max-w-[65ch] text-lg leading-8 text-kumo-subtle">Personal Agents, Companies and the tools that connect them, with dated sources and interoperability evidence.</p>
    {updated ? <p className="mt-3 text-sm text-kumo-subtle">Last updated {updated}. Each observation keeps its own date.</p> : null}
    <a className="public-link mt-3 inline-flex min-h-11 items-center gap-2 text-sm" href={ECOSYSTEM_SOURCE}>Read the source on GitHub <ArrowUpRightIcon size={16} aria-hidden /></a>
    <nav aria-label="On this page" className="my-8 flex flex-wrap gap-x-6 gap-y-3 border-y border-kumo-line py-4 text-sm">
      {currentHeading ? <a className="public-link" href={`#${headingId(currentHeading)}`}>Current ecosystem</a> : null}
      <a className="public-link" href="#upstream-heads-versus-retained-grid-pins">Upstream revisions</a>
      <a className="public-link" href="#scorecard">Historical scorecard</a>
    </nav>
    <p className="mb-5 text-sm text-kumo-subtle sm:hidden">Scroll tables sideways to read all columns.</p>
    <Markdown>{current}</Markdown>
    {historical ? <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="mt-10 border-y border-kumo-line py-5">
      <summary className="cursor-pointer text-lg font-semibold">Historical catalogue and interoperability results</summary>
      <p className="my-4 max-w-[65ch] leading-7 text-kumo-subtle">These records describe the revisions and dates stated in each section. They do not certify current upstream implementations.</p>
      {open ? <Markdown>{historical}</Markdown> : null}
    </details> : null}
  </article>;
}
