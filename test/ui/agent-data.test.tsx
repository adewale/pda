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

it("reports refused revocation without claiming the agent was deleted", async () => {
  const fetcher = vi.fn(async () => Response.json({ error: "Local data is retained for revocation retry.", companies: ["shop.example"] }, { status: 409 }));
  vi.stubGlobal("fetch", fetcher);
  render(<AgentDataSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Delete my agent" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Deletion confirmation" }), { target: { value: "DELETE" } });
  fireEvent.click(screen.getByRole("button", { name: "Permanently delete my agent" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("shop.example"));
  expect(screen.getByRole("alert").textContent).toContain("retained");
  expect(fetcher).toHaveBeenCalledWith("/api/agent-data", expect.objectContaining({ method: "DELETE", headers: { "X-PDA-Delete": "delete-my-agent" } }));
});
