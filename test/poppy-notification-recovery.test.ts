import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decideLocal, recoverInterruptedApprovals } from "../src/poppy/operations";
import { agent, cards, company, signInDirect } from "./agent-helpers";
import { legacyTool as tool } from "./legacy-approval";

async function pending() {
  const c = await company({ operations: false });
  const a = await agent();
  await signInDirect(a, c);
  expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } })).isError).toBe(false);
  const card = (await cards(a)).find(card => card.kind === "approval" && card.open)!;
  return { a, c, card };
}

describe("durable approval notifications", () => {
  it.each([false, true])("recovers a committed approval with delivery-before-failure=%s and preserves the exact notification", async delivered => {
    const { a, c, card } = await pending();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const original = client.host.notifyModel;
      const calls: { text: string; id: string }[] = [];
      let first = true;
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => {
        calls.push({ text, id });
        if (first) {
          first = false;
          if (delivered) await original(text, id);
          throw new Error("interrupted notification");
        }
        await original(text, id);
      });
      try {
        await expect(decideLocal(client, card.approvalId, "approve")).rejects.toThrow("interrupted notification");
        expect(client.sql.exec("SELECT status, notification_pending FROM poppy_approvals WHERE id = ?", card.approvalId).toArray()).toEqual([{ status: "done", notification_pending: 1 }]);
        await recoverInterruptedApprovals(client);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual(calls[0]);
        expect(client.sql.exec("SELECT notification_pending FROM poppy_approvals WHERE id = ?", card.approvalId).toArray()).toEqual([{ notification_pending: 0 }]);
        await recoverInterruptedApprovals(client);
        expect(calls).toHaveLength(2);
      } finally { notify.mockRestore(); }
    });
    await a.stub.poppyRestart();
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("gives a new User decision on a reused terms card a new notification identity", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const ids: string[] = [];
    let termsId;
    for (let attempt = 0; attempt < 2; attempt++) {
      await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
      const parent = (await cards(a)).find(card => card.kind === "approval" && card.open)!;
      await a.stub.poppyFrame({ type: "poppy.approval", approvalId: parent.approvalId, decision: "approve" });
      const terms = (await cards(a)).find(card => card.kind === "approval" && card.open)!;
      if (termsId) expect(terms.approvalId).toBe(termsId);
      termsId = terms.approvalId;
      await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "decline" });
      const [{ id }] = JSON.parse(await a.stub.poppySql("SELECT json_extract(notification, '$.id') AS id FROM poppy_approvals WHERE id = ?", terms.approvalId));
      ids.push(id);
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect((await c.stub.state()).performs).toBe(0);
  });
});
