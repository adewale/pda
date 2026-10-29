import { describe, expect, it } from "vitest";
import { ApprovalAcknowledgements } from "../impls/pda-agent/approval-delivery.ts";
import { storedApproval } from "../../src/poppy/approvals.ts";
import { runCell, type Driver } from "../runner/cell.ts";
import { loadScenarios } from "../runner/cli.ts";

const endpoint = "https://api.acme.company.interop.test/poppy/conversations";
const conversation = { id: "local_conversation", remote_id: "remote_conversation" };
const approval = { operation_id: "op_one", revision: "revision_one", expires_at: "2026-10-29T12:00:00Z" };
const row = { status: "unknown", request: storedApproval({ kind: "message-approval", conversationId: conversation.id, approval, binding: { account: "acct_ada", sessionId: "ses_one" } }) };
const request = () => new Request(`${endpoint}/${conversation.remote_id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { id: "msg_one", author: { type: "agent" }, approval: { operation_id: approval.operation_id, revision: approval.revision } } }) });
const response = (value: unknown, status = 202) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const acknowledgement = { conversation_id: conversation.remote_id, status: "working", responder: "agent" };

describe("approval message acknowledgement is delivery evidence, never completion evidence", () => {
  it("reports an acknowledged unknown message approval as sent with its outcome still unknown", async () => {
    const deliveries = new ApprovalAcknowledgements();
    await deliveries.observe(request(), response(acknowledgement));
    expect(deliveries.outcome(row, endpoint, conversation)).toEqual({ status: "sent", outcome: "unknown" });
    expect(deliveries.outcome({ ...row, status: "done" }, endpoint, conversation)).toBeNull();
  });
  it("keeps a lost response unknown even if the peer might have performed the action", () => {
    expect(new ApprovalAcknowledgements().outcome(row, endpoint, conversation)).toBeNull();
  });
  it("malformed, incomplete, error and wrong-conversation 2xx responses provide no valid acknowledgement", async () => {
    for (const body of [{}, { conversation_id: conversation.remote_id }, { ...acknowledgement, conversation_id: "different_conversation" }, { ...acknowledgement, error: "server_error" }]) {
      const deliveries = new ApprovalAcknowledgements();
      await deliveries.observe(request(), response(body));
      expect(deliveries.outcome(row, endpoint, conversation)).toBeNull();
    }
    const deliveries = new ApprovalAcknowledgements();
    await deliveries.observe(request(), new Response("{", { status: 202, headers: { "content-type": "application/json" } }));
    expect(deliveries.outcome(row, endpoint, conversation)).toBeNull();
  });
  it("does not reuse another operation, revision, endpoint or conversation's acknowledgement", async () => {
    const deliveries = new ApprovalAcknowledgements();
    await deliveries.observe(request(), response(acknowledgement));
    for (const next of [{ ...approval, revision: "different_revision" }, { ...approval, operation_id: "different_operation" }]) {
      expect(deliveries.outcome({ ...row, request: storedApproval({ kind: "message-approval", conversationId: conversation.id, approval: next, binding: { account: "acct_ada", sessionId: "ses_one" } }) }, endpoint, conversation)).toBeNull();
    }
    expect(deliveries.outcome(row, "https://api.other.company.interop.test/poppy/conversations", conversation)).toBeNull();
    expect(deliveries.outcome(row, endpoint, { ...conversation, remote_id: "other_remote" })).toBeNull();
    expect(deliveries.outcome(row, endpoint, { ...conversation, id: "other_local" })).toBeNull();
  });
});

describe("operation scenarios check delivery and actual effects independently", () => {
  for (const id of ["O", "ODUP"]) {
    const scenario = loadScenarios().find((item) => item.id === id)!;
    async function run(performed: number, result: unknown = { status: "sent", outcome: "unknown" }) {
      let checked = false;
      const driver: Driver = {
        agent: async (op) => ({ kind: "ok", result: op === "signin" ? { pending: { url: "https://auth.acme.company.interop.test/authorize" } } : op === "send" ? { conversation: "conversation_one" } : op === "approve_op" ? result : {} }),
        company: async (hook) => ({ kind: "ok", result: hook === "approve_authorization" ? { redirect: "https://pda.agent.interop.test/callback" } : hook === "propose_operation" ? { operation: "operation_one" } : hook === "performed_count" ? { performed: checked ? performed : (checked = true, 0) } : {} }),
        runner: async () => ({ kind: "ok" })
      };
      return runCell(scenario, { accounts: ["acct_ada"], scopes: { write: ["orders:write"] }, prompts: { operation: "Exchange the jacket" } }, driver);
    }
    it(`${id} passes delivery accepted/unknown only after exactly one independently observed effect`, async () => {
      expect((await run(1)).outcome).toBe("pass");
      expect((await run(0)).outcome).toBe("fail");
      expect((await run(2)).outcome).toBe("fail");
      expect((await run(1, { status: "done" })).outcome).toBe("fail");
    });
  }
});
