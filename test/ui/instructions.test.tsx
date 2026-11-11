import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { clientFrame } from "../../src/poppy/frames";
import { toIssuer } from "../../src/poppy/issuer";
import type { PoppyClientFrame, StandingInstruction } from "../../src/poppy/wire";
import { ConnectionProvider } from "../../src/ui/connection";
import { InstructionsSection } from "../../src/ui/instructions";

/**
 * The User's standing instructions on the Companies page (0.4 Operations 5;
 * decision 44): only this page writes them, so what it sends must decode as
 * the agent decodes a page frame.
 */
const issuer = toIssuer("https://auth.shop.example");

const written: StandingInstruction = {
  id: "ins_1",
  issuer,
  company: "Shop",
  account: "default",
  text: "Go ahead with any exchange under $100",
  conditions: [{ kind: "at_most", path: ["price_difference"], amount: "100.00", currency: "USD" }],
  budget: { amount: "150.00", currency: "USD", days: 7 },
  createdAt: Date.parse("2026-11-11T09:00:00Z"),
  withdrawnAt: null,
  approvals: [{ approvalId: "apr2_1", summary: "Exchange the Stormline Jacket", status: "done", spend: "used", amount: "70.00", currency: "USD", at: Date.parse("2026-11-11T10:00:00Z") }]
};

function renderSection(instructions: readonly StandingInstruction[], connected = true) {
  const send = vi.fn((_: PoppyClientFrame) => true);
  render(
    <ConnectionProvider connected={connected}>
      <InstructionsSection issuer={issuer} company="Shop" accounts={["default"]} instructions={instructions} send={send} />
    </ConnectionProvider>
  );
  return send;
}

describe("standing instructions on the Companies page", () => {
  it("shows an instruction in the User's words, its conditions, limit and what it approved, and withdraws it", () => {
    const send = renderSection([written]);
    expect(screen.getByText("“Go ahead with any exchange under $100”")).toBeTruthy();
    expect(screen.getByText(/price_difference is at most 100\.00 USD; at most 150\.00 USD in any 7 days · account default/)).toBeTruthy();
    expect(screen.getByText(/Exchange the Stormline Jacket/).parentElement!.textContent).toContain("done; 70.00 USD counted");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(send).toHaveBeenCalledWith({ type: "poppy.instruction.withdraw", id: "ins_1" });
  });

  it("sends a new instruction the agent's own decoder accepts", () => {
    const send = renderSection([]);
    expect(screen.getByText(/asks you to approve each of Shop's operations/)).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add instruction" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("In your words"), { target: { value: " Exchanges under $100 " } });
    fireEvent.change(screen.getByLabelText("Amount in the terms"), { target: { value: "price_difference" } });
    fireEvent.change(screen.getByLabelText("At most"), { target: { value: "100.00" } });
    fireEvent.change(screen.getByLabelText(/In total at most/), { target: { value: "150" } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    const frame = send.mock.calls[0]![0];
    expect(frame).toEqual({
      type: "poppy.instruction.add",
      issuer,
      account: null,
      text: "Exchanges under $100",
      conditions: [{ kind: "at_most", path: ["price_difference"], amount: "100.00", currency: "USD" }],
      budget: { amount: "150", currency: "USD", days: 7 }
    });
    expect(clientFrame(JSON.parse(JSON.stringify(frame)), "frame")).toEqual(frame);
  });

  it("doesn't send an amount that isn't a decimal, or anything while disconnected", () => {
    renderSection([], false);
    fireEvent.change(screen.getByLabelText("In your words"), { target: { value: "Exchanges" } });
    fireEvent.change(screen.getByLabelText("Amount in the terms"), { target: { value: "price_difference" } });
    fireEvent.change(screen.getByLabelText("At most"), { target: { value: "1e3" } });
    expect((screen.getByRole("button", { name: "Add instruction" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("At most"), { target: { value: "100" } });
    expect((screen.getByRole("button", { name: "Add instruction" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
