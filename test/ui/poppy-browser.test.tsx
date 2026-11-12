import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PoppyCards } from "../../src/poppy-ui";
import { BrowserViews, type BrowserView } from "../../src/ui/poppy-browser";
import type { Card, PoppyClientFrame } from "../../src/poppy/wire";
import { reducePoppy, type PoppyView } from "../../src/use-pi-session";

/**
 * The browser-control card (0.4 Browser Control 5): only the User's page
 * takes, hands back or cancels control, and the live view link, which
 * controls the browser, comes only from a frame sent to this page.
 */

const EMPTY: PoppyView = { cards: [], decisions: {}, accounts: [], signOuts: [], instructions: [], direct: {}, activity: null, protocol: { companies: null, logs: {} } };

const step = (state: Extract<Card, { kind: "browser_control" }>["state"], patch: Partial<Extract<Card, { kind: "browser_control" }>> = {}): Card => ({
  id: "handover-hnd_1",
  kind: "browser_control",
  company: "Acme Air",
  domain: "acme.example",
  open: state === "offered" || state === "user",
  handoverId: "hnd_1",
  step: "submit the form #checkin",
  url: "https://acme.example/bookings/bkg_4Rt9",
  state,
  ...patch
});

function renderCard(card: Card, views: Record<string, BrowserView> = {}) {
  const sent: PoppyClientFrame[] = [];
  const send = vi.fn((frame: PoppyClientFrame) => sent.push(frame) > 0);
  render(
    <BrowserViews.Provider value={views}>
      <PoppyCards view={{ ...EMPTY, cards: [card] }} send={send} />
    </BrowserViews.Provider>
  );
  return { sent };
}

describe("the browser-control card", () => {
  it("offers control, and sends take or Not now from this page", () => {
    const { sent } = renderCard(step("offered"));
    expect(screen.getByText("Take a step on Acme Air's website yourself?")).toBeTruthy();
    expect(screen.getByText(/leaves this step to you: submit the form #checkin, on/)).toBeTruthy();
    expect(screen.getByText("acme.example/bookings/bkg_4Rt9")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(sent).toEqual([{ type: "poppy.browser.take", handoverId: "hnd_1" }]);
  });

  it("turns the offer down with Not now", () => {
    const { sent } = renderCard(step("offered"));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(sent).toEqual([{ type: "poppy.browser.cancel", handoverId: "hnd_1" }]);
  });

  it("links the live view while it lasts, opening it in a new tab without an opener", () => {
    renderCard(step("user"), { hnd_1: { url: "https://live.example/view/1", expiresAt: Date.now() + 60_000 } });
    const link = screen.getByRole("link", { name: /Open the browser/ });
    expect(link.getAttribute("href")).toBe("https://live.example/view/1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it.each([
    ["none has come", {}, "Open the browser"],
    ["it has expired", { hnd_1: { url: "https://live.example/view/1", expiresAt: Date.now() - 1 } }, "Get a new link to the browser"],
    ["it isn't HTTPS", { hnd_1: { url: "javascript:alert(1)", expiresAt: Date.now() + 60_000 } }, "Get a new link to the browser"]
  ] as const)("asks for a live view link when %s", (_, views, label) => {
    const { sent } = renderCard(step("user"), views);
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(sent).toEqual([{ type: "poppy.browser.view", handoverId: "hnd_1" }]);
  });

  it.each([
    ["Hand back", "poppy.browser.return"],
    ["Cancel", "poppy.browser.cancel"]
  ] as const)("ends control only on %s", (name, type) => {
    const { sent } = renderCard(step("user"));
    fireEvent.click(screen.getByRole("button", { name }));
    expect(sent).toEqual([{ type, handoverId: "hnd_1" }]);
  });

  it.each([
    ["returned", "You handed the browser back after the step: submit the form #checkin."],
    ["cancelled", "You cancelled your control of the browser for the step: submit the form #checkin."],
    ["declined", "You left this step for later: submit the form #checkin."]
  ] as const)("keeps a receipt once %s", (state, text) => {
    renderCard(step(state));
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hand back" })).toBeNull();
  });

  it("keeps the live view frame in the page's memory, by handover", () => {
    const next = reducePoppy(EMPTY, { type: "poppy.browser.view", handoverId: "hnd_1", url: "https://live.example/view/1", expiresAt: 5 });
    expect(next.browserViews).toEqual({ hnd_1: { url: "https://live.example/view/1", expiresAt: 5 } });
  });
});
