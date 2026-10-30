import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decideLocal, recoverInterruptedApprovals } from "../src/poppy/operations";
import { serverFrame } from "../src/poppy/frames";
import { stepDecisions } from "../src/ui/steps";
import { agent, cards, company, requests, signInDirect, tool } from "./agent-helpers";

function decisions(value: unknown) {
  const frame = serverFrame({ type: "poppy.cards", cards: value }, "cards");
  if (frame.type !== "poppy.cards") throw new Error("Expected cards");
  return stepDecisions(frame.cards);
}
const args = { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" };
const apiArgs = { operation: "exchangeItem", params: { order_id: args.order_id }, body: { item_id: args.item_id, replacement_sku: args.replacement_sku } };
const call = (domain: string, channel: "openapi" | "mcp") => channel === "openapi"
  ? { name: "poppy_api_call", args: { domain, ...apiArgs } }
  : { name: "poppy_mcp_call", args: { domain, tool: "exchange_item", args } };
async function asking(channel: "openapi" | "mcp") {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  const request = call(c.domain, channel);
  const answer = await tool(a, request.name, request.args);
  const terms = (await cards(a)).find(card => card.kind === "approval" && card.open)!;
  expect(JSON.parse(answer.details)).toMatchObject({ proposed: terms.approvalId });
  expect((await cards(a)).filter(card => card.kind === "approval")).toHaveLength(1);
  const [{ id: taskId }] = JSON.parse(await a.stub.poppySql("SELECT id FROM poppy_approvals WHERE id GLOB 'req_*'"));
  return { a, c, terms, taskId };
}

// Current 0.3 only: an internal task record and one visible Company-terms card.
describe("the tool request follows its Company's terms approval", () => {
  it.each(["openapi", "mcp"] as const)("never revives a withdrawn %s approval after signing into the same account", async channel => {
    const { a, c, terms, taskId } = await asking(channel);
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await signInDirect(a, c);
    const before = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(0);
    expect((await requests(c)).slice(before).filter(request => request.method === "POST")).toEqual([]);
    const rows = JSON.parse(await a.stub.poppySql("SELECT id, status FROM poppy_approvals WHERE id IN (?, ?)", taskId, terms.approvalId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row: { status: string }) => row.status === "failed")).toBe(true);
  });

  it.each(["openapi", "mcp"] as const)("follows revised %s Company terms through to the original tool step", async channel => {
    const { a, c, terms } = await asking(channel);
    await a.stub.poppySql("UPDATE poppy_approvals SET request = json_set(request, '$.call.approval.revision', 'r-the-company-dropped') WHERE id = ?", terms.approvalId);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    const revised = (await cards(a)).find(card => card.kind === "approval" && card.open)!;
    expect(revised.approvalId).not.toBe(terms.approvalId);
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(card => card.approvalId === terms.approvalId)).toMatchObject({ status: "terms" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: revised.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    expect(decisions(await cards(a)).approvals.get(terms.approvalId)?.result).toBe("done");
  });

  it.each(["openapi", "mcp"] as const)("settles %s terms decided before the initial task returns", async channel => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const request = call(c.domain, channel);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const show = client.host.showCard;
      const notify = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      let reentered = false;
      const showing = vi.spyOn(client.host, "showCard").mockImplementation(async (card, options) => {
        await show(card, options);
        if (!reentered && card.kind === "approval" && card.open) {
          reentered = true;
          await decideLocal(client, card.approvalId, "approve");
        }
      });
      try {
        const answer = await instance.poppyTool(request.name, request.args);
        expect(answer.isError).toBe(false);
        expect(JSON.parse(answer.details)).not.toHaveProperty("proposed");
        expect(reentered).toBe(true);
      } finally { showing.mockRestore(); notify.mockRestore(); }
    });
    expect((await c.stub.state()).performs).toBe(1);
    expect((await cards(a)).filter(card => card.kind === "approval")).toEqual([expect.objectContaining({ status: "done", open: false })]);
    expect(JSON.parse(await a.stub.poppySql("SELECT status FROM poppy_approvals WHERE id GLOB 'req_*'"))).toEqual([{ status: "done" }]);
  });

  it.each(["openapi", "mcp"] as const)("resolves the original %s step after the User approves the terms", async channel => {
    const { a, c, terms, taskId } = await asking(channel);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    expect((await cards(a)).filter(card => card.kind === "approval")).toEqual([expect.objectContaining({ approvalId: terms.approvalId, status: "done", open: false })]);
    expect(decisions(await cards(a)).approvals.get(terms.approvalId)?.result).toBe("done");
    const activity = JSON.parse(await a.stub.poppyActivity());
    expect(activity.log.find((entry: { id: string }) => entry.id === terms.id)?.result).toBe("done");
    expect(activity.log.some((entry: { id: string }) => entry.id === `approval-${taskId}`)).toBe(false);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
  });

  it.each(["openapi", "mcp"] as const)("resolves the original %s step when the User declines the terms", async channel => {
    const { a, c, terms, taskId } = await asking(channel);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "decline" });
    expect((await c.stub.state()).performs).toBe(0);
    expect(decisions(await cards(a)).approvals.get(terms.approvalId)?.result).toBe("declined");
    expect(JSON.parse(await a.stub.poppySql("SELECT status FROM poppy_approvals WHERE id = ?", taskId))).toEqual([{ status: "declined" }]);
  });

  it.each(["openapi", "mcp"] as const)("keeps the visible %s terms and internal task uncertain after interruption", async channel => {
    const { a, c, terms, taskId } = await asking(channel);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const notify = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      try {
        client.sql.exec("UPDATE poppy_approvals SET status = 'executing' WHERE id = ?", terms.approvalId);
        await recoverInterruptedApprovals(client);
      } finally { notify.mockRestore(); }
    });
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).filter(card => card.kind === "approval")).toEqual([expect.objectContaining({ approvalId: terms.approvalId, status: "unknown", open: false })]);
    expect(decisions(await cards(a)).approvals.get(terms.approvalId)?.result).toBe("unknown");
    const rows = JSON.parse(await a.stub.poppySql("SELECT status FROM poppy_approvals WHERE id IN (?, ?)", taskId, terms.approvalId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row: { status: string }) => row.status === "unknown")).toBe(true);
  });
});
