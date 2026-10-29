import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import type { TranscriptMessage } from "../../src/protocol";
import type { ActivityEntry, ApprovalTerms, Card } from "../../src/poppy/wire";
import { toIssuer } from "../../src/poppy/issuer";
import { stepDecisions } from "../../src/ui/steps";
import { proposedBy } from "../../src/ui/tool-line";
import { Transcript } from "../../src/ui/transcript";

/**
 * What a step shows of an approval it asked for (src/ui/steps.ts): our own
 * card's (`apr_`), or the card for the terms a Company returned (`apr2_`,
 * Ops 4 and 5), from the cards while they last and Activity's log after.
 */

const TERMS: ApprovalTerms = {
  summary: "Exchange the Stormline Jacket (M) for the Insulated Jacket (M), for $70.00 more.",
  expiresAt: "2026-10-28T12:00:00Z",
  highlights: ["Cost (price_difference): 70.00 USD", "The company hasn't said whether this can be undone."],
  total: { amount: "70.00", currency: "USD" }
};

const approval = (approvalId: string, status: Extract<Card, { kind: "approval" }>["status"], patch: Partial<Extract<Card, { kind: "approval" }>> = {}): Card => ({
  id: `approval-${approvalId}`,
  kind: "approval",
  company: "Shop",
  domain: "shop.example",
  open: status === "pending",
  approvalId,
  summary: "Shop asks for your approval before it does this: Exchange the jacket",
  status,
  ...patch
});

function exchange(proposed: string): TranscriptMessage[] {
  return [
    { id: "user", role: "user", parts: [{ type: "text", text: "Exchange my jacket at shop.example" }], timestamp: 1000 },
    { id: "call", role: "assistant", parts: [{ type: "tool-call", id: "call-a", name: "poppy_mcp_call", arguments: { domain: "shop.example", tool: "exchange_item" } }], timestamp: 1100 },
    { id: "result", role: "tool", parts: [{ type: "tool-result", id: "call-a", name: "poppy_mcp_call", content: [{ type: "text", text: "{}" }], details: { status: 200, proposed }, error: false }], timestamp: 1200 }
  ];
}

const statusOf = (container: HTMLElement) => container.querySelector('[data-tool="poppy_mcp_call"]')!.getAttribute("data-status");

it("reads a Company's terms card (apr2_) and our own card (apr_) as the approval a step asked for, and nothing else", () => {
  expect(proposedBy({ error: false, details: { proposed: "apr2_AbCdEfGhIjKlMnOpQrStUv" } })).toEqual({ approvalId: "apr2_AbCdEfGhIjKlMnOpQrStUv" });
  expect(proposedBy({ error: false, details: { proposed: "apr_1" } })).toEqual({ approvalId: "apr_1" });
  // Ops 1's Company-scoped operation ids are gone; so are other prefixes and failed calls.
  expect(proposedBy({ error: false, details: { proposed: { operation_id: "op_1" } } })).toBeNull();
  expect(proposedBy({ error: false, details: { proposed: "apr3_1" } })).toBeNull();
  expect(proposedBy({ error: false, details: { proposed: "op_apr_1" } })).toBeNull();
  expect(proposedBy({ error: true, details: { proposed: "apr_1" } })).toBeNull();
});

it("shows a terms card's outcome on the step that asked for it: waiting, then done", () => {
  const id = "apr2_AbCdEfGhIjKlMnOpQrStUv";
  const waiting = render(<Transcript messages={exchange(id)} live={null} runningTools={[]} decisions={stepDecisions([approval(id, "pending", { terms: TERMS })])} />);
  expect(statusOf(waiting.container)).toBe("waiting");
  waiting.unmount();
  const done = render(<Transcript messages={exchange(id)} live={null} runningTools={[]} decisions={stepDecisions([approval(id, "done", { terms: TERMS, result: '{"status":200}' })])} />);
  expect(statusOf(done.container)).toBe("done");
});

it("never reads our card that ended in the Company's terms as done: they still wait for the User", () => {
  const decisions = stepDecisions([approval("apr_1", "terms", { result: "Shop asks you to approve its exact terms first, on the next card. Nothing has happened yet." })]);
  expect(decisions.approvals.get("apr_1")?.result).toBe("waiting");
  const { container } = render(<Transcript messages={exchange("apr_1")} live={null} runningTools={[]} decisions={decisions} />);
  expect(statusOf(container)).toBe("waiting");
});

const entry = (approvalId: string, result: ActivityEntry["result"], company = "Shop"): ActivityEntry => ({
  id: `approval-${approvalId}`, at: 1, kind: "approval", issuer: toIssuer("https://shop.example"), company,
  account: null, what: "Asked you to approve", how: "api", access: "view_and_change", decidedBy: "you", result
});

it("keeps each approval's outcome from Activity's log once its card has gone, by its whole id", () => {
  const decisions = stepDecisions([], [entry("apr2_A", "done"), entry("apr2_AB", "failed"), entry("apr_1", "waiting")]);
  expect(decisions.approvals.get("apr2_A")?.result).toBe("done");
  expect(decisions.approvals.get("apr2_AB")?.result).toBe("failed");
  expect(decisions.approvals.get("apr_1")?.result).toBe("waiting");
  expect(decisions.approvals.get("apr2_ABC")).toBeUndefined();
  const { container } = render(<Transcript messages={exchange("apr2_A")} live={null} runningTools={[]} decisions={decisions} />);
  expect(statusOf(container)).toBe("done");
});

it("prefers the card, which knows what the Company answered, over the log", () => {
  const decisions = stepDecisions([approval("apr2_A", "refused", { terms: TERMS, answer: { status: 409, error: "conflict" } })], [entry("apr2_A", "done")]);
  expect(decisions.approvals.get("apr2_A")).toMatchObject({ result: "failed", httpStatus: 409, code: "conflict" });
});
