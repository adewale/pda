import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decideLocal, recoverInterruptedApprovals } from "../src/poppy/operations";
import { agent, cards, company, requests, signInDirect } from "./agent-helpers";
import { tool } from "./agent-helpers";

async function pending() {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: {
    item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m"
  } })).isError).toBe(false);
  const card = (await cards(a)).find(card => card.kind === "approval" && card.open);
  if (!card) throw new Error("Expected the User's approval card");
  return { a, c, card };
}

describe("approval receipts cannot change a committed Company outcome", () => {
  it("preserves a successful action when publishing its receipt fails, and recovery never resends it", async () => {
    const { a, c, card } = await pending();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const show = client.host.showCard;
      let interrupted = false;
      const showing = vi.spyOn(client.host, "showCard").mockImplementation(async (next, options) => {
        if (!interrupted && next.kind === "approval" && next.status === "done") {
          interrupted = true;
          throw new Error("receipt publication interrupted");
        }
        await show(next, options);
      });
      try {
        const result = await decideLocal(client, card.approvalId, "approve").then(
          () => ({ ok: true as const }), error => ({ ok: false as const, error })
        );
        expect(interrupted).toBe(true);
        expect(client.sql.exec("SELECT status, notification_pending FROM poppy_approvals WHERE id = ?", card.approvalId).one())
          .toEqual({ status: "done", notification_pending: 1 });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected the receipt publication failure");
        expect(result.error).toMatchObject({ message: "receipt publication interrupted" });
      } finally { showing.mockRestore(); }
    });
    expect((await c.stub.state()).performs).toBe(1);
    const sent = await requests(c);
    await a.stub.poppyRestart();
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    await a.stub.poppyRestart();
    expect(await requests(c)).toEqual(sent);
    expect((await c.stub.state()).performs).toBe(1);
    expect(JSON.parse(await a.stub.poppySql("SELECT status, notification_pending FROM poppy_approvals WHERE id = ?", card.approvalId)))
      .toEqual([{ status: "done", notification_pending: 0 }]);
    expect((await cards(a)).filter(item => item.kind === "approval")).toHaveLength(1);
    expect((await a.stub.poppyNotices()).filter(text => text.includes("Done, as the User approved"))).toHaveLength(1);
  });

  it.each(["aged", "dismissed"] as const)("repairs a pending terminal receipt after restart while preserving its %s timestamp", async history => {
    const { a, c, card } = await pending();
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    // This is the persisted state at a process death after committing done and before writing its card.
    const old = history === "dismissed" ? 0 : Date.now() - 2 * 60 * 60_000;
    await a.stub.poppySql("UPDATE poppy_cards SET card = json_set(card, '$.status', 'approved'), updated_at = ? WHERE id = ?", old, card.id);
    await a.stub.poppySql("UPDATE poppy_approvals SET notification_pending = 1 WHERE id = ?", card.approvalId);
    const sent = await requests(c);
    await a.stub.poppyRestart();
    const [saved] = JSON.parse(await a.stub.poppySql("SELECT card, open, updated_at FROM poppy_cards WHERE id = ?", card.id));
    expect(JSON.parse(saved.card)).toMatchObject({ kind: "approval", status: "done", open: false });
    expect(saved).toMatchObject({ open: 0, updated_at: old });
    expect(await requests(c)).toEqual(sent);
    expect((await c.stub.state()).performs).toBe(1);
    const repaired = await a.stub.poppySql("SELECT card, open, updated_at FROM poppy_cards WHERE id = ?", card.id);
    await a.stub.poppyRestart();
    expect(await a.stub.poppySql("SELECT card, open, updated_at FROM poppy_cards WHERE id = ?", card.id)).toBe(repaired);
  });

  it("repairs a declined receipt after its card write fails without sending the declined action", async () => {
    const { a, c, card } = await pending();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const show = client.host.showCard;
      const showing = vi.spyOn(client.host, "showCard").mockImplementation(async (next, options) => {
        if (next.kind === "approval" && next.status === "declined") throw new Error("declined receipt interrupted");
        await show(next, options);
      });
      try {
        await expect(decideLocal(client, card.approvalId, "decline")).rejects.toThrow("declined receipt interrupted");
        expect(client.sql.exec("SELECT status, notification_pending FROM poppy_approvals WHERE id = ?", card.approvalId).one())
          .toEqual({ status: "declined", notification_pending: 1 });
      } finally { showing.mockRestore(); }
      await recoverInterruptedApprovals(client);
    });
    expect((await cards(a)).find(item => item.id === card.id)).toMatchObject({ open: false, status: "declined" });
    expect((await c.stub.state()).performs).toBe(0);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(0);
  });
});
