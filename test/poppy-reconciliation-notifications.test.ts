import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { resolveApprovalOutcome } from "../src/poppy/operations";
import { agent, cards, company, requests, signInDirect, tool } from "./agent-helpers";

async function uncertain() {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
  const parent = (await cards(a)).find(item => item.kind === "approval" && item.open)!;
  await a.stub.poppyFrame({ type: "poppy.approval", approvalId: parent.approvalId, decision: "approve" });
  const card = (await cards(a)).find(item => item.kind === "approval" && item.open)!;
  await a.stub.poppyFault({ method: "POST", url: "/exchanges", mode: "throw" });
  await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
  expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "unknown" });
  expect((await c.stub.state()).performs).toBe(1);
  return { a, c, card, parent };
}

describe("durable User reconciliation notifications", () => {
  it.each(["card", "notify-before", "notify-after"] as const)("retains a checked outcome through %s failure, restart and conflicting retry", async failure => {
    const { a, c, card, parent } = await uncertain();
    const originalReceipt = await a.stub.poppySql("SELECT request, status, result FROM poppy_approvals WHERE id = ?", card.approvalId);
    const before = (await requests(c)).length;
    const attempted = await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const originalNotify = client.host.notifyModel;
      const originalCard = client.host.showCard;
      const attempts: { text: string; id: string }[] = [];
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => {
        if (!text.includes("The User checked")) return originalNotify(text, id);
        attempts.push({ text, id });
        if (failure === "notify-after") await originalNotify(text, id);
        throw new Error("reconciliation interrupted");
      });
      const showing = vi.spyOn(client.host, "showCard").mockImplementation(async (next, options) => {
        if (failure === "card" && next.kind === "approval" && next.outcomeResolution) throw new Error("reconciliation interrupted");
        await originalCard(next, options);
      });
      try {
        await expect(resolveApprovalOutcome(client, card.approvalId, "performed")).rejects.toThrow("reconciliation interrupted");
      } finally { notify.mockRestore(); showing.mockRestore(); }
      return attempts;
    });
    expect(await a.stub.poppySql("SELECT request, status, result FROM poppy_approvals WHERE id = ?", card.approvalId)).toBe(originalReceipt);
    await a.stub.poppyRestart();
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: parent.approvalId, outcome: "not_performed" });
    const deliveries: { text: string; operation_id: string }[] = JSON.parse(await a.stub.poppySql("SELECT text, operation_id FROM test_notices WHERE text LIKE '%The User checked%' ORDER BY seq"));
    expect(deliveries).toHaveLength(failure === "notify-after" ? 2 : 1);
    expect(new Set(deliveries.map(item => item.text)).size).toBe(1);
    expect(new Set(deliveries.map(item => item.operation_id)).size).toBe(1);
    expect(deliveries[0].text).toContain("this action happened");
    if (attempted.length) expect(deliveries[0]).toEqual({ text: attempted[0].text, operation_id: attempted[0].id });
    const execution = JSON.parse(await a.stub.poppySql("SELECT json_extract(notification, '$.id') AS id FROM poppy_approvals WHERE id = ?", card.approvalId));
    expect(deliveries[0].operation_id).not.toBe(execution[0].id);
    for (const receipt of [card, parent]) expect((await cards(a)).find(item => item.approvalId === receipt.approvalId)?.outcomeResolution.outcome).toBe("performed");
    await a.stub.poppyRestart();
    expect(JSON.parse(await a.stub.poppySql("SELECT COUNT(*) AS n FROM test_notices WHERE text LIKE '%The User checked%'"))[0].n).toBe(deliveries.length);
    expect((await requests(c)).length).toBe(before);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("reports a normal checked outcome once and does not replay historical resolutions", async () => {
    const { a, c, card } = await uncertain();
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome: "performed" });
    expect((await a.stub.poppyNotices()).filter(text => text.includes("The User checked"))).toHaveLength(1);
    await a.stub.poppySql("INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at, outcome_resolution, outcome_resolved_at) VALUES (?, ?, 'main', 'Historical action', '{}', 'unknown', ?, 'performed', ?)", "historical-resolution", c.hosts.issuer, Date.now() - 1000, Date.now() - 1000);
    await a.stub.poppyRestart();
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome: "performed" });
    expect((await a.stub.poppyNotices()).filter(text => text.includes("The User checked"))).toHaveLength(1);
    expect((await c.stub.state()).performs).toBe(1);
  });
});
