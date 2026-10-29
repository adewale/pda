import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decideLocal } from "../src/poppy/operations";
import { agent, cards, company, requests, signInDirect, tool, until, wideEvents } from "./agent-helpers";

const args = { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" };
async function ask(a: Awaited<ReturnType<typeof agent>>, domain: string, channel: "openapi" | "mcp", callId?: string) {
  return channel === "openapi"
    ? tool(a, "poppy_api_call", { domain, operation: "exchangeItem", params: { order_id: args.order_id }, body: { item_id: args.item_id, replacement_sku: args.replacement_sku } }, callId)
    : tool(a, "poppy_mcp_call", { domain, tool: "exchange_item", args }, callId);
}

describe("task requests use the Company's Operations 2 approval", () => {
  it.each(["openapi", "mcp"] as const)("sends the %s task request before asking, then waits for one exact-terms decision", async channel => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const before = (await a.stub.poppyNotices()).length;
    const asked = await ask(a, c.domain, channel);
    expect(asked.isError).toBe(false);
    const approvals = (await cards(a)).filter(card => card.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ open: true, status: "pending", terms: { summary: expect.stringContaining("Exchange the Stormline Jacket") } });
    expect(JSON.parse(asked.details)).toMatchObject({ proposed: approvals[0].approvalId });
    expect((await c.stub.state()).performs).toBe(0);
    // Waiting for the User is not a new model turn that can propose another order.
    expect((await a.stub.poppyNotices()).slice(before)).toEqual([]);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approvals[0].approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: approvals[0].approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
  });

  it.each(["openapi", "mcp"] as const)("reuses pending %s terms for a fresh model call without sending another business request", async channel => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const mark = await a.stub.poppyLogMark();
    const first = await ask(a, c.domain, channel, "first");
    const before = (await requests(c)).length;
    const again = await ask(a, c.domain, channel, "second");
    expect(JSON.parse(again.details).proposed).toBe(JSON.parse(first.details).proposed);
    expect((await requests(c)).slice(before)).toEqual([]);
    expect((await cards(a)).filter(card => card.kind === "approval" && card.open)).toHaveLength(1);
    expect((await c.stub.state()).performs).toBe(0);
    const calls = await until(async () => {
      const found = (await wideEvents(a, mark)).filter(event => event.agent_id === a.stub.id.toString().slice(0, 32)).flatMap(event => event.tool_calls ?? []).filter(call => call.call_id === "first" || call.call_id === "second");
      return found.length === 2 && found;
    });
    expect(calls.map(call => [call.call_id, call.reused_pending, call.approval_id])).toEqual([
      ["first", false, JSON.parse(first.details).proposed], ["second", true, JSON.parse(first.details).proposed]
    ]);
    expect(new Set(calls.map(call => call.task_request_id)).size).toBe(1);
    expect(calls[0].task_request_id).toMatch(/^req_/);
  });

  it("runs a task at a Company without Operations and replays its recorded result without a new write", async () => {
    const c = await company({ operations: false });
    const a = await agent();
    await signInDirect(a, c);
    const first = await ask(a, c.domain, "openapi", "routine-task");
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.details)).toMatchObject({ status: 201 });
    expect((await cards(a)).filter(card => card.kind === "approval")).toEqual([]);
    await a.stub.poppyRestart();
    const replay = await ask(a, c.domain, "openapi", "routine-task");
    expect(JSON.parse(replay.details)).toEqual(JSON.parse(first.details));
    expect((await requests(c)).filter(request => request.url.endsWith("/exchanges"))).toHaveLength(1);
    expect((await c.stub.state()).performs).toBe(1);
    const activity = JSON.parse(await a.stub.poppyActivity());
    expect(activity.log.filter((entry: { what: string }) => entry.what === "Requested for your task")).toHaveLength(1);
    expect(activity.log.some((entry: { what: string }) => entry.what === "Asked you to approve")).toBe(false);
  });

  it("holds new writes after a lost task response and keeps read-only verification available", async () => {
    const c = await company({ operations: false });
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFault({ method: "POST", url: "/exchanges", mode: "throw" });
    expect((await ask(a, c.domain, "openapi", "lost-task")).isError).toBe(true);
    const unknown = (await cards(a)).find(card => card.kind === "approval" && card.status === "unknown")!;
    expect(unknown.result).toContain("Sent for your task");
    expect(unknown.result).not.toContain("you approved");
    await a.stub.poppyRestart();
    const before = (await requests(c)).length;
    const again = await ask(a, c.domain, "openapi", "new-model-call");
    expect(again.isError).toBe(true);
    expect(again.text).toContain("unknown outcome");
    expect((await requests(c)).slice(before).filter(request => request.method === "POST" && request.url.endsWith("/exchanges"))).toEqual([]);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("keeps the internal task record hidden through uncertain terms, reconciliation and receipt expiry", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const asked = JSON.parse((await ask(a, c.domain, "openapi")).details);
    await a.stub.poppyFault({ method: "POST", url: "/exchanges", mode: "throw" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: asked.proposed, decision: "approve" });
    expect((await cards(a)).filter(card => card.kind === "approval")).toHaveLength(1);
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: asked.proposed, outcome: "performed" });
    expect((await cards(a)).filter(card => card.kind === "approval")).toHaveLength(1);
    await a.stub.poppySql("UPDATE poppy_cards SET updated_at = 0 WHERE id = ?", `approval-${asked.proposed}`);
    await a.stub.poppyRestart();
    // The test helper reads all stored cards, including expired ones. Only the
    // original terms receipt may remain, with its age preserved; no req_ receipt.
    expect((await cards(a)).filter(card => card.kind === "approval").map(card => card.approvalId)).toEqual([asked.proposed]);
    expect(JSON.parse(await a.stub.poppySql("SELECT updated_at FROM poppy_cards WHERE id = ?", `approval-${asked.proposed}`))).toEqual([{ updated_at: 0 }]);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("retains a complete approved response and checkout URL beyond the old 2000-character cut", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    await ask(a, c.domain, "openapi");
    const card = (await cards(a)).find(card => card.kind === "approval" && card.open)!;
    const checkout = `${c.hosts.web}/checkout/order-example?session=${"x".repeat(150)}&return=receipt#payment`;
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const send = client.resource.bind(client);
      const outgoing = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
        const response = await send(target, request, options);
        if (response.status !== 201) return response;
        return Response.json({ description: "a".repeat(2500), checkout_url: checkout }, { status: 201 });
      });
      try { await decideLocal(client, card.approvalId, "approve"); } finally { outgoing.mockRestore(); }
    });
    const receipt = (await cards(a)).find(item => item.approvalId === card.approvalId)!;
    expect(JSON.parse(receipt.result)).toMatchObject({ status: 201, body: { description: "a".repeat(2500), checkout_url: checkout } });
    expect((await a.stub.poppyNotices()).some(notice => notice.includes(checkout))).toBe(true);
    const linked = (await cards(a)).find(item => item.id === `result-${card.approvalId}`)!;
    expect(linked).toMatchObject({ kind: "notice", open: false, links: [{ label: "body checkout url · " + new URL(checkout).hostname, url: checkout }] });
    expect((await c.stub.state()).performs).toBe(1);
    const diagnostics = await a.stub.diagnostics();
    expect(diagnostics).not.toContain(checkout);
    expect(diagnostics).not.toContain("x".repeat(150));
    expect(diagnostics).not.toContain("a".repeat(2500));
  });
});
