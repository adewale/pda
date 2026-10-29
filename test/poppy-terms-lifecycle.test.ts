import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decideLocal, recoverInterruptedApprovals } from "../src/poppy/operations";
import { serverFrame } from "../src/poppy/frames";
import { stepDecisions } from "../src/ui/steps";
import { agent, cards, company, requests, signInDirect, tool, until } from "./agent-helpers";

function decisions(value: unknown) {
  const frame = serverFrame({ type: "poppy.cards", cards: value }, "cards");
  if (frame.type !== "poppy.cards") throw new Error("Expected cards");
  return stepDecisions(frame.cards);
}

async function asking(channel: "openapi" | "mcp", approveParent?: (a: Awaited<ReturnType<typeof agent>>, id: string) => Promise<void>) {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  const args = { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" };
  const answer = channel === "openapi"
    ? await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: args.order_id }, body: { item_id: args.item_id, replacement_sku: args.replacement_sku } })
    : await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "exchange_item", args });
  const parent = await until(async () => (await cards(a)).find(card => card.kind === "approval" && card.open));
  expect(JSON.parse(answer.details)).toMatchObject({ proposed: parent.approvalId });
  if (approveParent) await approveParent(a, parent.approvalId);
  else await a.stub.poppyFrame({ type: "poppy.approval", approvalId: parent.approvalId, decision: "approve" });
  const child = await until(async () => (await cards(a)).find(card => card.kind === "approval" && card.approvalId !== parent.approvalId));
  if (!approveParent) expect((await cards(a)).find(card => card.approvalId === parent.approvalId)).toMatchObject({ status: "terms" });
  return { a, c, parent, child };
}

describe("the tool request follows its Company's terms approval", () => {
  it.each(["openapi", "mcp"] as const)("never revives a withdrawn %s approval after signing into the same account", async channel => {
    const { a, c, parent, child } = await asking(channel);
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await signInDirect(a, c);
    const before = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: child.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(0);
    expect((await requests(c)).slice(before).filter(request => request.method === "POST")).toEqual([]);
    for (const id of [parent.approvalId, child.approvalId]) {
      expect((await cards(a)).find(card => card.approvalId === id)).toMatchObject({ status: "failed" });
    }
  });

  it("follows revised Company terms through to the original tool step", async () => {
    const { a, c, parent, child } = await asking("openapi");
    await a.stub.poppySql("UPDATE poppy_approvals SET request = json_set(request, '$.call.approval.revision', 'r-the-company-dropped') WHERE id = ?", child.approvalId);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: child.approvalId, decision: "approve" });
    const revised = await until(async () => (await cards(a)).find(card => card.kind === "approval" && card.open));
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(card => card.approvalId === parent.approvalId)).toMatchObject({ status: "terms" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: revised.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    expect(decisions(await cards(a)).approvals.get(parent.approvalId)?.result).toBe("done");
  });

  it("settles a child decided before its parent records the link", async () => {
    const { a, c, parent } = await asking("openapi", async (a, id) => {
      await runInDurableObject(a.stub, async instance => {
        const client = instance.poppy.client;
        const show = client.host.showCard;
        const notify = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
        let reentered = false;
        const showing = vi.spyOn(client.host, "showCard").mockImplementation(async card => {
          await show(card);
          if (!reentered && card.kind === "approval" && card.open && card.approvalId.startsWith("apr2_")) {
            reentered = true;
            await decideLocal(client, card.approvalId, "approve");
          }
        });
        try {
          await decideLocal(client, id, "approve");
          expect(reentered).toBe(true);
        } finally { showing.mockRestore(); notify.mockRestore(); }
      });
    });
    expect((await c.stub.state()).performs).toBe(1);
    expect(decisions(await cards(a)).approvals.get(parent.approvalId)?.result).toBe("done");
  });

  it.each(["openapi", "mcp"] as const)("resolves the original %s step after the User approves the terms", async channel => {
    const { a, c, parent, child } = await asking(channel);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: child.approvalId, decision: "approve" });
    const all = await cards(a);
    expect((await c.stub.state()).performs).toBe(1);
    expect(all.find(card => card.approvalId === parent.approvalId)).toMatchObject({ status: "done", open: false });
    expect(decisions(all).approvals.get(parent.approvalId)?.result).toBe("done");
    const activity = JSON.parse(await a.stub.poppyActivity()) as { log: { id: string; result: string }[] };
    expect(activity.log.find(entry => entry.id === parent.id)?.result).toBe("done");
    // Replayed clicks cannot perform the action again through either card.
    for (const card of [parent, child]) await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
  });

  it.each(["openapi", "mcp"] as const)("resolves the original %s step when the User declines the terms", async channel => {
    const { a, c, parent, child } = await asking(channel);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: child.approvalId, decision: "decline" });
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(card => card.approvalId === parent.approvalId)).toMatchObject({ status: "declined", open: false });
    expect(decisions(await cards(a)).approvals.get(parent.approvalId)?.result).toBe("declined");
  });

  it("keeps both steps uncertain when a restart interrupted the terms approval", async () => {
    const { a, c, parent, child } = await asking("openapi");
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const notify = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      try {
        client.sql.exec("UPDATE poppy_approvals SET status = 'executing' WHERE id = ?", child.approvalId);
        await recoverInterruptedApprovals(client);
      } finally { notify.mockRestore(); }
    });
    const all = await cards(a);
    expect((await c.stub.state()).performs).toBe(0);
    for (const id of [parent.approvalId, child.approvalId]) {
      expect(all.find(card => card.approvalId === id)).toMatchObject({ status: "unknown", open: false });
      expect(decisions(all).approvals.get(id)?.result).toBe("unknown");
    }
  });
});
