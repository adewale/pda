import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import type { TranscriptMessage } from "../../src/protocol";
import type { ActivityEntry, Card } from "../../src/poppy/wire";
import { toIssuer } from "../../src/poppy/issuer";
import { stepDecisions } from "../../src/ui/steps";
import { Transcript } from "../../src/ui/transcript";

it("equal operation IDs at different Companies do not share the displayed outcome", () => {
  const cards: Card[] = [
    { id: "op-a", kind: "operation", issuer: toIssuer("https://a.example"), company: "Company A", domain: "a.example", operationId: "42", revision: 1, state: "proposed", open: true, summary: "Exchange at A", highlights: [], account: null, userApprovalRequired: true },
    { id: "op-b", kind: "operation", issuer: toIssuer("https://b.example"), company: "Company B", domain: "b.example", operationId: "42", revision: 1, state: "succeeded", open: false, summary: "Exchange at B", highlights: [], account: null, userApprovalRequired: true }
  ];
  const messages: TranscriptMessage[] = [
    { id: "user", role: "user", parts: [{ type: "text", text: "Exchange at a.example" }], timestamp: 1000 },
    { id: "call", role: "assistant", parts: [{ type: "tool-call", id: "call-a", name: "poppy_api_call", arguments: { domain: "a.example", operation: "POST /exchanges" } }], timestamp: 1100 },
    { id: "result", role: "tool", parts: [{ type: "tool-result", id: "call-a", name: "poppy_api_call", content: [{ type: "text", text: "{}" }], details: { proposed: { operation_id: "42" } }, error: false }], timestamp: 1200 }
  ];
  const { container } = render(<Transcript messages={messages} live={null} runningTools={[]} decisions={stepDecisions(cards)} />);
  expect(container.querySelector('[data-tool="poppy_api_call"]')!.getAttribute("data-status")).toBe("waiting");
});

const entry = (issuer: string, id: string, result: ActivityEntry["result"]): ActivityEntry => ({
  id: `op-${issuer}-${id}`, at: 1, kind: "operation", issuer: toIssuer(issuer), company: "Shop",
  account: null, what: "Exchange proposed", how: "api", access: "view_and_change", decidedBy: "you", result
});

it("retains each Company's outcome after its cards expire and matches the whole operation ID", () => {
  const a = "https://a.example/auth";
  const b = "https://b.example/auth";
  const decisions = stepDecisions([], [entry(b, "42", "done"), entry(a, "order-42", "failed"), entry(a, "42", "waiting")]);
  expect(decisions.operation("42", a, "a.example")?.result).toBe("waiting");
  expect(decisions.operation("42", b, "b.example")?.result).toBe("done");
  expect(decisions.operation("order-42", a, "a.example")?.result).toBe("failed");
  expect(decisions.operation("42", undefined, "a.example")).toBeUndefined();
});

it("shows the scoped historical outcome in the transcript after cards expire", () => {
  const issuer = "https://a.example/auth";
  const messages: TranscriptMessage[] = [
    { id: "user", role: "user", parts: [{ type: "text", text: "Exchange at a.example" }], timestamp: 1000 },
    { id: "call", role: "assistant", parts: [{ type: "tool-call", id: "call-a", name: "poppy_api_call", arguments: { domain: "a.example", operation: "POST /exchanges" } }], timestamp: 1100 },
    { id: "result", role: "tool", parts: [{ type: "tool-result", id: "call-a", name: "poppy_api_call", content: [{ type: "text", text: "{}" }], details: { proposed: { issuer, operation_id: "42" } }, error: false }], timestamp: 1200 }
  ];
  const { container } = render(<Transcript messages={messages} live={null} runningTools={[]} decisions={stepDecisions([], [entry("https://b.example/auth", "42", "waiting"), entry(issuer, "42", "done")])} />);
  expect(container.querySelector('[data-tool="poppy_api_call"]')!.getAttribute("data-status")).toBe("done");
});

it("does not guess an issuer for a legacy proposal when its domain has conflicting identities", () => {
  const card = (issuer: string): Card => ({
    id: `op-${issuer}-42`, kind: "operation", issuer: toIssuer(issuer), domain: "shop.example", company: "Shop",
    operationId: "42", revision: 1, state: "succeeded", open: false, summary: "Exchange", account: null, highlights: [], userApprovalRequired: true
  });
  const decisions = stepDecisions([card("https://shop.example/auth/old"), card("https://shop.example/auth/new")]);
  expect(decisions.operation("42", undefined, "shop.example")).toBeUndefined();
});
