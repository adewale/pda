import "../../../src/styles.css";
import { createRoot } from "react-dom/client";
import { Transcript } from "../../../src/ui/transcript";
import { stepDecisions } from "../../../src/ui/steps";
import { needsYou, PoppyCard } from "../../../src/poppy-ui";
import type { Card } from "../../../src/poppy/wire";
import type { TranscriptMessage } from "../../../src/protocol";

// Same completed exchange and legacy record in both states. The regression
// tests exercise the real Worker/SQLite transitions; this fixture shows how
// their resulting card states render in the production components.
const before = new URLSearchParams(location.search).get("state") === "before";
const parent: Card = {
  id: "approval-apr_request", kind: "approval", approvalId: "apr_request", company: "Shop", domain: "shop.example",
  open: false, summary: "Exchange the jacket at Shop", status: before ? "terms" : "done",
  result: before ? "Shop asks you to approve its exact terms first, on the next card. Nothing has happened yet."
    : JSON.stringify({ status: 201, body: { exchange_id: "exchange_1" } })
};
const child: Card = { ...parent, id: "approval-apr2_terms", approvalId: "apr2_terms", status: "done" };
const messages: TranscriptMessage[] = [
  { id: "user", role: "user", timestamp: 1793264400000, parts: [{ type: "text", text: "Exchange my jacket at shop.example" }] },
  { id: "call", role: "assistant", timestamp: 1793264401000, parts: [{ type: "tool-call", id: "call-a", name: "poppy_mcp_call", arguments: { domain: "shop.example", tool: "exchange_item" } }] },
  { id: "result", role: "tool", timestamp: 1793264402000, parts: [{ type: "tool-result", id: "call-a", name: "poppy_mcp_call", content: [{ type: "text", text: "{}" }], details: { proposed: "apr_request" }, error: false }] }
];
// This retired wire shape is deliberately unsupported by the 0.3 renderer.
const oldOperation = { id: "operation-old", kind: "operation", company: "Shop", domain: "shop.example", open: true, summary: "Buy the jacket", operationId: "old", state: "proposed" };
const legacy = before ? oldOperation as unknown as Card : {
  id: "operation-old", kind: "notice", company: "Shop", domain: "shop.example", open: false,
  text: "This Operations 1 request was retired locally after the protocol update. This update did not cancel or confirm anything at the Company. Check its outcome there before starting it again."
} satisfies Card;
const attention = needsYou([legacy]).length;

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-3xl space-y-8 p-6 text-kumo-strong">
    <section className="space-y-4"><h1 className="text-xl font-semibold">Completed jacket exchange</h1>
      <p className="text-sm text-kumo-subtle">The Company performed the approved exchange once.</p>
      <Transcript messages={messages} live={null} runningTools={[]} decisions={stepDecisions([parent, child])} />
      <PoppyCard card={parent} send={() => true} />
    </section>
    <section className="space-y-4"><h2 className="text-lg font-semibold">Retired Operations 1 request</h2>
      <p className="text-sm text-kumo-subtle">{attention} {attention === 1 ? "request needs" : "requests need"} you</p>
      <PoppyCard card={legacy} send={() => true} />
    </section>
  </main>
);
