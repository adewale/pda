import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { needsYou, PoppyCard, receipts } from "../../src/poppy-ui";
import { clientFrame } from "../../src/poppy/frames";
import type { ActivityEntry, Card } from "../../src/poppy/wire";
import type { TranscriptMessage } from "../../src/protocol";
import { toIssuer } from "../../src/poppy/issuer";
import { stepDecisions } from "../../src/ui/steps";
import { describeToolCall } from "../../src/ui/tool-line";
import { Transcript } from "../../src/ui/transcript";

const unknown: Extract<Card, { kind: "approval" }> = {
  id: "approval-uncertain", approvalId: "uncertain", kind: "approval", company: "Shop",
  domain: "shop.example", open: false, status: "unknown", summary: "Order the jacket",
  result: "The answer was lost. This action may have happened; check with Shop before trying again."
};

describe("recording an outcome checked with the Company", () => {
  it("describes an uncertain approved write without claiming that it failed", () => {
    const line = describeToolCall("poppy_api_call", { domain: "shop.example", operation: "POST /orders" },
      { error: false, details: { proposed: "uncertain" } }, new Map([["shop.example", "Shop"]]), { result: "unknown" });
    expect(line?.text).toBe("The outcome of the change you approved at Shop: orders is unknown");
    expect(line?.text).not.toContain("didn't go through");
  });
  it.each(["performed", "not_performed"] as const)("records %s only when the User clicks its explicit choice", outcome => {
    const send = vi.fn(() => true);
    render(<PoppyCard card={unknown} send={send} />);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText(/Record only what you have confirmed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: outcome === "performed" ? "I checked: it happened" : "I checked: it did not happen" }));
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "poppy.approval.resolve", approvalId: "uncertain", outcome });
  });

  it.each(["performed", "not_performed"] as const)("keeps the original receipt while showing the User's checked %s outcome", outcome => {
    const card = { ...unknown, outcomeResolution: { outcome, at: 1793264400000 } };
    const send = vi.fn(() => true);
    render(<PoppyCard card={card} send={send} />);
    expect(screen.getByText(unknown.result!)).toBeTruthy();
    expect(screen.getByText(/You reported that this action/).textContent).toContain(outcome === "performed" ? "happened" : "did not happen");
    expect(screen.queryByRole("button", { name: /I checked/ })).toBeNull();
    expect(needsYou([card])).toEqual([]);
    expect(receipts([card])).toEqual([card]);
    const step = stepDecisions([card]).approvals.get(card.approvalId);
    expect(step).toMatchObject({ result: outcome === "performed" ? "done" : "failed", httpStatus: null, code: null });
    expect(step?.facts).toEqual([expect.stringContaining(`You checked with Shop: this action ${outcome === "performed" ? "happened" : "did not happen"}`)]);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["done", "declined", "failed", "refused"] as const)("does not offer reconciliation for a %s request", status => {
    render(<PoppyCard card={{ ...unknown, status }} send={() => true} />);
    expect(screen.queryByRole("button", { name: /I checked/ })).toBeNull();
  });

  it.each(["performed", "not_performed"] as const)("keeps User attribution for %s when the receipt has expired or been dismissed", outcome => {
    const approvalId = "apr_reconciled";
    const attribution = `You checked with Shop: this action ${outcome === "performed" ? "happened" : "did not happen"}. The original uncertain receipt is retained; no request was resent.`;
    const entry: ActivityEntry = {
      id: `approval-${approvalId}`, kind: "approval", at: 1000, issuer: toIssuer("https://shop.example"), company: "Shop", account: null,
      what: "Asked you to approve", quote: "Order the jacket", quoteBy: "agent", how: "api", access: "view_and_change", decidedBy: "you",
      result: outcome === "performed" ? "done" : "failed", outcomeBy: "you", outcome: attribution
    };
    const messages: TranscriptMessage[] = [
      { id: "call", role: "assistant", timestamp: 1000, parts: [{ type: "tool-call", id: "call-1", name: "poppy_api_call", arguments: { domain: "shop.example", operation: "POST /orders" } }] },
      { id: "result", role: "tool", timestamp: 1100, parts: [{ type: "tool-result", id: "call-1", name: "poppy_api_call", content: [{ type: "text", text: "{}" }], details: { proposed: approvalId }, error: false }] }
    ];
    const decisions = stepDecisions([], [entry]);
    expect(decisions.approvals.get(approvalId)?.facts).toEqual([attribution]);
    const { container } = render(<Transcript messages={messages} live={null} runningTools={[]} decisions={decisions} />);
    expect(container.querySelector('[data-tool="poppy_api_call"]')?.textContent).toContain(attribution);
  });

  it("decodes only the two explicit outcomes, never an approval or free-form resolution", () => {
    expect(clientFrame({ type: "poppy.approval.resolve", approvalId: "uncertain", outcome: "not_performed" }, "frame"))
      .toEqual({ type: "poppy.approval.resolve", approvalId: "uncertain", outcome: "not_performed" });
    for (const outcome of ["approve", "try_again", "unknown", true, null]) {
      expect(() => clientFrame({ type: "poppy.approval.resolve", approvalId: "uncertain", outcome }, "frame")).toThrow();
    }
  });

  it("bounds read-only approval lookups and refuses malformed identifiers", () => {
    expect(clientFrame({ type: "poppy.approvals.read", ids: ["apr_old", "apr2_terms"] }, "frame")).toEqual({ type: "poppy.approvals.read", ids: ["apr_old", "apr2_terms"] });
    for (const ids of [Array.from({ length: 101 }, (_, i) => `apr_${i}`), ["../another-user"], [null]]) {
      expect(() => clientFrame({ type: "poppy.approvals.read", ids }, "frame")).toThrow();
    }
  });
});

describe("Company alternatives offered to the User", () => {
  it("renders validated HTTPS links as User-opened links and keeps Company prose inert", () => {
    const send = vi.fn(() => true);
    const { container } = render(<PoppyCard card={{ id: "coverage", kind: "notice", open: false, company: "Shop", text: "This task is excluded.", links: [
      { label: "Open the Company's alternative", url: "https://shop.example/help" },
      { label: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)" },
      { label: "HTTP alternative", url: "http://shop.example/help" }
    ] }} send={send} />);
    const link = screen.getByRole("link", { name: "Open the Company's alternative" });
    expect(link.getAttribute("href")).toBe("https://shop.example/help");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(container.querySelector("img, script")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
