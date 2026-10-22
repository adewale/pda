import { readFileSync } from "node:fs";
import path from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, SIGN_IN_ERRORS } from "../../src/client";
import { ECOSYSTEM_SOURCE, PROJECT_URL } from "../../src/public/project";

/**
 * A smoke test of the page itself (`src/client.tsx`) when no one is signed
 * in: `/api/me` answers 401 and the sign-in page shows why the last sign-in
 * didn't complete, for every reason the Worker's OAuth callback gives.
 */

/** The `signin_error` codes `src/oauth.ts` can redirect with. */
const WORKER_CODES = [...readFileSync(path.join(import.meta.dirname, "../../src/oauth.ts"), "utf8").matchAll(/new SignInError\("([a-z_]+)"/g)]
  .map((match) => match[1]!)
  .filter((code, index, all) => all.indexOf(code) === index);

const meRequests: string[] = [];
let signInProviders: string[] = ["google", "github"];

beforeEach(() => {
  meRequests.length = 0;
  signInProviders = ["google", "github"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      meRequests.push(String(input));
      return String(input) === "/api/sign-in-options"
        ? Response.json({ providers: signInProviders })
        : new Response("Sign in first", { status: 401 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Mount the real page fresh; Testing Library unmounts it after each case.
 * Module loading happens during collection, outside an active React act().
 */
async function openPage(search: string) {
  window.history.replaceState(null, "", `/${search}`);
  render(<App />);
  await screen.findByRole("heading", { name: "Poppy Demo Agent" });
}

describe("sign-in page", () => {
  it("knows every code the Worker sends", async () => {
    await openPage("");
    expect(WORKER_CODES).toContain("not_allowed");
    expect(WORKER_CODES.length).toBeGreaterThanOrEqual(6);
    for (const code of WORKER_CODES) expect(SIGN_IN_ERRORS).toHaveProperty(code);
  });

  it.each(WORKER_CODES)("shows the message for signin_error=%s, then drops it from the address", async (code) => {
    await openPage(`?signin_error=${code}`);
    expect(meRequests).toEqual(["/api/me", "/api/sign-in-options"]);
    expect(screen.getByRole("alert").textContent).toBe(SIGN_IN_ERRORS[code]);
    expect(screen.getByRole("link", { name: "Sign in with Google" }).getAttribute("href")).toBe("/auth/google");
    expect(screen.getByRole("link", { name: "Sign in with GitHub" }).getAttribute("href")).toBe("/auth/github");
    expect(window.location.search).toBe("");
  });

  it("links the privacy policy from the sign-in page", async () => {
    await openPage("");
    expect(screen.getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("/privacy");
    expect(screen.getByRole("link", { name: "About" }).getAttribute("href")).toBe("/about");
    expect(document.querySelector('a[href="/ecosystem"]')).toBeNull();
  });

  it("says what the agent is, above the footer", async () => {
    await openPage("");
    expect(screen.getByText(/^Poppy Demo Agent \(PDA\) is a Personal Agent to demonstrate the use of Poppy/)).toBeTruthy();
  });

  it("shows only the sign-in buttons the deployment offers", async () => {
    signInProviders = ["github"];
    await openPage("");
    await screen.findByRole("link", { name: "Sign in with GitHub" });
    expect(screen.queryByRole("link", { name: "Sign in with Google" })).toBeNull();
  });

  it("explains the allowlist when the account isn't on it", async () => {
    await openPage("?signin_error=not_allowed");
    expect(screen.getByRole("alert").textContent).toMatch(/isn't on this agent's allowlist/);
  });

  it("shows a general message for a code it doesn't know, as text", async () => {
    await openPage("?signin_error=%3Cimg%20src%3Dx%3E");
    expect(screen.getByRole("alert").textContent).toBe("Sign-in failed. Try again.");
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows no message without a signin_error", async () => {
    await openPage("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});


describe("public information pages", () => {
  it.each(["/about", "/about/"])("opens %s without asking for an identity and links the project, validator and map", async (path) => {
    window.history.replaceState(null, "", path);
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "About Poppy Demo Agent" });
    expect(screen.getByRole("link", { name: /View the GitHub project/ }).getAttribute("href")).toBe(PROJECT_URL);
    expect(screen.getByRole("link", { name: /^Validator/ }).getAttribute("href")).toBe("/validator");
    expect(screen.getByRole("link", { name: /^Ecosystem map/ }).getAttribute("href")).toBe("/ecosystem");
    expect(document.title).toBe("About · Poppy Demo Agent");
    expect(meRequests).toEqual([]);
  });

  it("renders the source map with working repository links, scrollable tables and closed historical results", async () => {
    window.history.replaceState(null, "", "/ecosystem");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "The Poppy ecosystem" });
    expect(screen.getByRole("link", { name: /Read the source on GitHub/ }).getAttribute("href")).toBe(ECOSYSTEM_SOURCE);
    const heading = screen.getByRole("heading", { name: /^Current ecosystem/ });
    expect(screen.getByRole("link", { name: "Current ecosystem" }).getAttribute("href")).toBe(`#${heading.id}`);
    expect(screen.getByRole("link", { name: "local 0.2 copy" }).getAttribute("href")).toBe(`${PROJECT_URL}/blob/main/spec/draft-0.2-2026-10-19/README.md`);
    expect(screen.getAllByRole("region", { name: "Ecosystem comparison table" }).every(table => table.tabIndex === 0)).toBe(true);
    expect(document.querySelector("details")!.open).toBe(false);
    expect(document.querySelector('a[href="/ecosystem"]')).toBeNull();
    expect(meRequests).toEqual([]);
  });

  it("opens historical results when a section fragment is followed, including a direct deep link", async () => {
    window.history.replaceState(null, "", "/ecosystem#scorecard");
    render(<App />);
    await screen.findByRole("heading", { name: "Scorecard" });
    expect(document.querySelector("details")!.open).toBe(true);
    expect(screen.getByRole("link", { name: "View the interoperability diagram on GitHub" }).getAttribute("href")).toBe(`${ECOSYSTEM_SOURCE}#how-they-work-together`);
    act(() => { document.querySelector("details")!.open = false; });
    await waitFor(() => expect(document.querySelector("details")!.open).toBe(false));
    act(() => { window.location.hash = "open-fault-lines"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(() => expect(document.querySelector("details")!.open).toBe(true));
    expect(meRequests).toEqual([]);
  });
});
