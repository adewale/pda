import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { ArrowUpRightIcon } from "@phosphor-icons/react";
import { PROJECT_URL } from "./project";
import { useFollowDeviceTheme } from "../ui/settings";

const Ecosystem = lazy(() => import("./ecosystem"));

function Layout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-kumo-canvas text-kumo-default">
    <a href="#main" className="sr-only focus:not-sr-only focus:block focus:p-4">Skip to content</a>
    <header className="mx-auto max-w-[1080px] px-6">
      <nav aria-label="Site" className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b-2 border-ink py-3">
        <a href="/" className="font-semibold text-kumo-strong">Poppy Demo Agent</a>
        <a href="/about" className="public-link text-sm">About</a>
      </nav>
    </header>
    <main id="main" tabIndex={-1} className="mx-auto max-w-[1080px] px-6 py-10 outline-none sm:py-16">{children}</main>
    <footer className="mx-auto max-w-[1080px] px-6">
      <nav aria-label="Footer" className="flex flex-wrap gap-6 border-t-2 border-ink py-5 text-sm text-kumo-subtle">
        <a className="public-link" href="/">Back to your agent</a>
        <a className="public-link" href="/privacy">Privacy</a>
      </nav>
    </footer>
  </div>;
}

function About() {
  return <article className="max-w-3xl">
    <p className="mb-3 text-sm font-medium text-kumo-subtle">An open source Personal Agent</p>
    <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">About Poppy Demo Agent</h1>
    <p className="mt-6 max-w-[65ch] text-lg leading-8">Poppy Demo Agent (PDA) demonstrates how a Personal Agent can work with companies through <a className="public-link" href="https://personalagentprotocol.org/">Poppy, the Personal Agent Protocol</a>.</p>
    <p className="mt-4 max-w-[65ch] leading-7">Your agent can talk to Company Agents, use their APIs and bring proposed actions back to you for approval. This is alpha software built around a draft protocol.</p>
    <section className="mt-10 border-t border-kumo-line pt-7" aria-labelledby="source-heading">
      <h2 id="source-heading" className="text-xl font-semibold">Built in the open</h2>
      <p className="mt-3 max-w-[65ch] leading-7">The code, setup instructions and interoperability research are in our GitHub project. You can read how it works, run your own copy or report an issue.</p>
      <a className="public-link mt-4 inline-flex min-h-11 items-center gap-2 font-medium" href={PROJECT_URL}>View the GitHub project <ArrowUpRightIcon size={16} aria-hidden /></a>
    </section>
    <section className="mt-8 border-t border-kumo-line pt-7" aria-labelledby="research-heading">
      <h2 id="research-heading" className="text-xl font-semibold">Tools and research</h2>
      <dl className="mt-5 grid gap-6 sm:grid-cols-2">
        <div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
          <dt><a className="public-link inline-flex min-h-11 items-center text-lg font-semibold" href="/validator">Validator <span aria-hidden className="ml-2">→</span></a></dt>
          <dd className="mt-2 leading-7 text-kumo-subtle">Check a Company’s discovery documents or a Personal Agent’s metadata and keys against the draft. No sign-in needed.</dd>
        </div>
        <div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
          <dt><a className="public-link inline-flex min-h-11 items-center text-lg font-semibold" href="/ecosystem">Ecosystem map <span aria-hidden className="ml-2">→</span></a></dt>
          <dd className="mt-2 leading-7 text-kumo-subtle">Explore the agents, Companies, SDKs and tools around Poppy, with sources, observation dates and interoperability results.</dd>
        </div>
      </dl>
    </section>
  </article>;
}

/** Public information never asks for an identity or opens an agent socket. */
export default function PublicPage({ page }: { page: "about" | "ecosystem" }) {
  useFollowDeviceTheme();
  useEffect(() => {
    document.title = `${page === "about" ? "About" : "Ecosystem map"} · Poppy Demo Agent`;
  }, [page]);
  return <Layout>{page === "about" ? <About /> : <Suspense fallback={<p role="status">Loading the ecosystem map…</p>}><Ecosystem /></Suspense>}</Layout>;
}
