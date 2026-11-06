import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentDataSettings } from "../../src/ui/agent-data";

afterEach(() => vi.unstubAllGlobals());

it("requires the explicit deletion phrase and lets the user cancel without sending a request", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<AgentDataSettings />);
  expect(screen.getByRole("link", { name: "Download my data" }).getAttribute("href")).toBe("/api/agent-data");
  fireEvent.click(screen.getByRole("button", { name: "Delete my agent" }));
  const remove = screen.getByRole("button", { name: "Permanently delete my agent" }) as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Deletion confirmation" }), { target: { value: "DELETE" } });
  expect(remove.disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Keep my agent" }));
  expect(fetcher).not.toHaveBeenCalled();
});

const refused = (...unrevoked: unknown[]) => Response.json({ error: "Your local data is retained.", unrevoked }, { status: 409 });
const SHOP = { id: "so_shop", company: "Shop", domain: "shop.example", account: "default", code: "invalid_client", liveUntil: null };
const OTHER = { id: "so_other", company: "Other", domain: "other.example", account: "default", code: "timeout", liveUntil: Date.UTC(2027, 0, 2) };

function startDeletion() {
  render(<AgentDataSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Delete my agent" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Deletion confirmation" }), { target: { value: "DELETE" } });
  fireEvent.click(screen.getByRole("button", { name: "Permanently delete my agent" }));
}

it("shows what couldn't be revoked and what abandoning it leaves, without claiming deletion", async () => {
  const fetcher = vi.fn(async () => refused(SHOP, OTHER));
  vi.stubGlobal("fetch", fetcher);
  startDeletion();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("shop.example"));
  const alert = screen.getByRole("alert").textContent!;
  expect(alert).toContain("Your local data is still here");
  expect(alert).toContain("doesn't accept this agent's identity");
  expect(alert).toContain("It didn't answer");
  expect(alert).toContain("destroys its only copy");
  expect(fetcher).toHaveBeenCalledWith("/api/agent-data", expect.objectContaining({ method: "DELETE", headers: { "X-PDA-Delete": "delete-my-agent" } }));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("abandons exactly the credentials it showed", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => refused(SHOP, OTHER));
  vi.stubGlobal("fetch", fetcher);
  startDeletion();
  fireEvent.click(await screen.findByRole("button", { name: "Delete anyway" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({ abandonRevocations: ["so_shop", "so_other"] });
});

it("retries revocation without abandoning anything", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => refused(SHOP));
  vi.stubGlobal("fetch", fetcher);
  startDeletion();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1]![1]!.body).toBeUndefined();
});

it("offers no abandonment when work is still finishing", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "A Company sign-in or action is still finishing.", unrevoked: [] }, { status: 409 })));
  startDeletion();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("still finishing"));
  expect(screen.queryByRole("button", { name: "Delete anyway" })).toBeNull();
});
