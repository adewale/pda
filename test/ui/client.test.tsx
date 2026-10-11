import { readFileSync } from "node:fs";
import path from "node:path";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="root"></div>';
  meRequests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      meRequests.push(String(input));
      return new Response("Sign in first", { status: 401 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** Loads the page fresh at `/{search}`, as the browser would. */
async function openPage(search: string) {
  window.history.replaceState(null, "", `/${search}`);
  let page: typeof import("../../src/client.tsx") | undefined;
  await act(async () => {
    page = await import("../../src/client.tsx");
  });
  await screen.findByRole("heading", { name: "Personal agent" });
  return page!;
}

describe("sign-in page", () => {
  it("knows every code the Worker sends", async () => {
    const { SIGN_IN_ERRORS } = await openPage("");
    expect(WORKER_CODES).toContain("not_allowed");
    expect(WORKER_CODES.length).toBeGreaterThanOrEqual(6);
    for (const code of WORKER_CODES) expect(SIGN_IN_ERRORS).toHaveProperty(code);
  });

  it.each(WORKER_CODES)("shows the message for signin_error=%s, then drops it from the address", async (code) => {
    const { SIGN_IN_ERRORS } = await openPage(`?signin_error=${code}`);
    expect(meRequests).toEqual(["/api/me"]);
    expect(screen.getByRole("alert").textContent).toBe(SIGN_IN_ERRORS[code]);
    expect(screen.getByRole("link", { name: "Sign in with Google" }).getAttribute("href")).toBe("/auth/google");
    expect(screen.getByRole("link", { name: "Sign in with GitHub" }).getAttribute("href")).toBe("/auth/github");
    expect(window.location.search).toBe("");
  });

  it("explains the allowlist when the account isn't on it", async () => {
    await openPage("?signin_error=not_allowed");
    expect(screen.getByRole("alert").textContent).toMatch(/isn't on this agent's allowlist/);
  });

  it("shows a general message for a code it doesn't know, as text", async () => {
    await openPage("?signin_error=%3Cimg%20src%3Dx%3E");
    expect(screen.getByRole("alert").textContent).toBe("Sign-in failed. Please try again.");
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows no message without a signin_error", async () => {
    await openPage("");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
