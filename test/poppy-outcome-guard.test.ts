import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decideLocal, resolveApprovalOutcome } from "../src/poppy/operations";
import { agent, cards, company, connect, requests, signInDirect, tool, type Agent, type Company } from "./agent-helpers";
import { stepDecisions } from "../src/ui/steps";
import { serverFrame } from "../src/poppy/frames";

type Channel = "openapi" | "mcp";
const channels = ["openapi", "mcp"] as const;
async function ask(a: Agent, c: Company, channel: Channel, sku = "stormline-insulated-m") {
  return channel === "openapi"
    ? tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: sku } })
    : tool(a, "poppy_mcp_call", { domain: c.domain, tool: "exchange_item", args: { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: sku } });
}
async function awaitingTerms(channel: Channel) {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  const result = await ask(a, c, channel);
  expect(result.isError).toBe(false);
  const card = (await cards(a)).find(card => card.kind === "approval" && card.open)!;
  expect(JSON.parse(result.details).proposed).toBe(card.approvalId);
  const [{ id: taskId }] = JSON.parse(await a.stub.poppySql("SELECT id FROM poppy_approvals WHERE id GLOB 'req_*'"));
  return { a, c, card, taskId };
}
async function linked(a: Agent, taskId: string, cardId: string, status: string, resolution?: string) {
  const stored = JSON.parse(await a.stub.poppySql("SELECT id, status, outcome_resolution FROM poppy_approvals WHERE id IN (?, ?)", taskId, cardId));
  expect(stored).toHaveLength(2);
  for (const row of stored) expect(row).toMatchObject({ status, outcome_resolution: resolution ?? null });
  expect((await cards(a)).filter(card => card.kind === "approval")).toHaveLength(1);
}
async function loseOutcome(channel: Channel, mode: "throw" | "lose" = "throw") {
  const context = await awaitingTerms(channel);
  await context.a.stub.poppyFault({ method: "POST", url: channel === "openapi" ? "/exchanges" : "/mcp", mode });
  await context.a.stub.poppyFrame({ type: "poppy.approval", approvalId: context.card.approvalId, decision: "approve" });
  await linked(context.a, context.taskId, context.card.approvalId, "unknown");
  return context;
}

describe("an unknown approved action needs reconciliation before fresh approval", () => {
  it.each(["aged", "dismissed"] as const)("repairs reconciled receipts without renewing their %s timestamp", async history => {
    const { a, c, card } = await loseOutcome("openapi");
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome: "performed" });
    const at = history === "dismissed" ? 0 : Date.now() - 2 * 60 * 60_000;
    if (history === "dismissed") await a.stub.poppyFrame({ type: "poppy.card.dismiss", id: card.id });
    else await a.stub.poppySql("UPDATE poppy_cards SET updated_at = ? WHERE id = ?", at, card.id);
    await a.stub.poppyRestart();
    expect(JSON.parse(await a.stub.poppySql("SELECT updated_at FROM poppy_cards WHERE id = ?", card.id))).toEqual([{ updated_at: at }]);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("reads a decision over the authenticated socket after its receipt and Activity entry disappear", async () => {
    const { a, c, card } = await loseOutcome("openapi");
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome: "performed" });
    await a.stub.poppyFrame({ type: "poppy.card.dismiss", id: card.id });
    await a.stub.poppySql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 205)
      INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at)
      SELECT 'apr_later_' || i, ?, 'main', 'Later action', '{}', 'done', ? + i FROM n`, c.hosts.issuer, Date.now());
    const activity = JSON.parse(await a.stub.poppyActivity());
    expect(activity.log.some((entry: { id: string }) => entry.id === card.id)).toBe(false);
    const { socket, client } = await connect(a.identity);
    socket.send(JSON.stringify({ type: "poppy.approvals.read", ids: [card.approvalId, "apr_missing"] }));
    await client.until(() => client.frames.some(frame => frame.type === "poppy.approvals.state"));
    const frame = serverFrame(client.frames.find(frame => frame.type === "poppy.approvals.state"), "lookup reply");
    if (frame.type !== "poppy.approvals.state") throw new Error("Expected approval decisions");
    expect(frame.decisions).toEqual([expect.objectContaining({ approvalId: card.approvalId, result: "done", outcomeResolution: { outcome: "performed", at: expect.any(Number) } })]);
    expect(JSON.stringify(frame)).not.toContain("request");
    const durable = Object.fromEntries(frame.decisions.map(item => [item.approvalId, item]));
    expect(stepDecisions([], activity.log, durable).approvals.get(card.approvalId)).toMatchObject({ result: "done", facts: [expect.stringContaining("You checked with")] });
    socket.close();
    const other = await connect((await agent()).identity);
    other.socket.send(JSON.stringify({ type: "poppy.approvals.read", ids: [card.approvalId] }));
    await other.client.until(() => other.client.frames.some(frame => frame.type === "poppy.approvals.state"));
    expect(other.client.frames.find(frame => frame.type === "poppy.approvals.state")).toMatchObject({ decisions: [] });
    other.socket.close();
    expect((await c.stub.state()).performs).toBe(1);
  });

  it.each(channels)("blocks a fresh identical %s action after an unknown outcome and restart", async channel => {
    const { a, c } = await loseOutcome(channel);
    expect((await c.stub.state()).performs).toBe(1);
    await a.stub.poppyRestart();
    const before = await cards(a);
    const repeated = await ask(a, c, channel);
    expect(repeated.isError).toBe(true);
    expect(repeated.text).toContain("unknown outcome");
    expect((await cards(a)).filter(card => card.kind === "approval" && card.open)).toEqual([]);
    expect((await cards(a)).map(card => card.id)).toEqual(before.map(card => card.id));
    expect((await ask(a, c, channel, "stormline-insulated-l")).isError).toBe(true);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
    const elsewhere = await company();
    await signInDirect(a, elsewhere);
    expect((await ask(a, elsewhere, channel)).isError).toBe(false);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("holds writes across interfaces, ignored parameters and replacement Sessions at the same Company", async () => {
    const { a, c } = await loseOutcome("openapi");
    expect((await ask(a, c, "mcp")).isError).toBe(true);
    const ignored = await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m", trace_id: "fresh-request" } });
    expect(ignored.isError).toBe(true);
    expect(ignored.text).toContain("unknown outcome");
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      client.abandonSession((await client.company(c.domain)).issuer, "main");
    });
    expect((await ask(a, c, "openapi")).isError).toBe(true);
    await signInDirect(a, c);
    expect((await ask(a, c, "mcp")).isError).toBe(true);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it.each(channels)("rechecks a pre-created %s card after another attempt becomes unknown", async channel => {
    const { a, c, card } = await awaitingTerms(channel);
    expect((await ask(a, c, channel, "stormline-insulated-l")).isError).toBe(false);
    const second = (await cards(a)).find(item => item.kind === "approval" && item.open && item.approvalId !== card.approvalId)!;
    expect(second).toBeDefined();
    await a.stub.poppyFault({ method: "POST", url: channel === "openapi" ? "/exchanges" : "/mcp", mode: "throw" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    const before = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: second.approvalId, decision: "approve" });
    expect((await requests(c)).slice(before).filter(request => request.method === "POST")).toEqual([]);
    expect((await c.stub.state()).performs).toBe(1);
    expect((await cards(a)).find(item => item.approvalId === second.approvalId)).toMatchObject({ status: "failed", result: expect.stringContaining("unknown outcome") });
  });

  it.each(channels)("keeps a %s server failure uncertain rather than inviting a fresh operation", async channel => {
    const { a, c, card } = await awaitingTerms(channel);
    await a.stub.poppyFault({ method: "POST", url: channel === "openapi" ? "/exchanges" : "/mcp", mode: "error" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "unknown", answer: { status: 500 } });
    expect((await ask(a, c, channel)).isError).toBe(true);
    expect((await c.stub.state()).performs).toBe(0);
  });

  it.each([202, 503])("keeps HTTP %s after the Company performed an approved API write uncertain until the User checks", async status => {
    const { a, c, card, taskId } = await awaitingTerms("openapi");
    const originalStatuses = await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const original = client.resource.bind(client);
      const seen: number[] = [];
      const outgoing = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
        const sent = request.init();
        const response = await original(target, request, options);
        if (sent.method === "POST" && sent.url.endsWith("/exchanges") && new Headers(sent.headers).has("Poppy-Approval")) {
          seen.push(response.status);
          return new Response(response.body, { status, headers: response.headers });
        }
        return response;
      });
      try { await decideLocal(client, card.approvalId, "approve"); } finally { outgoing.mockRestore(); }
      return seen;
    });
    expect(originalStatuses).toEqual([201]);
    expect((await c.stub.state()).performs).toBe(1);
    await linked(a, taskId, card.approvalId, "unknown");
    const approved = () => requests(c).then(all => all.filter(request => request.method === "POST" && request.url.endsWith("/exchanges") && request.headers["poppy-approval"]));
    expect(await approved()).toHaveLength(1);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    await a.stub.poppyRestart();
    expect((await ask(a, c, "openapi")).text).toContain("unknown outcome");
    expect(await approved()).toHaveLength(1);
    const before = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome: "performed" });
    expect((await requests(c)).length).toBe(before);
    await linked(a, taskId, card.approvalId, "unknown", "performed");
    expect((await ask(a, c, "openapi")).isError).toBe(false);
    expect(await approved()).toHaveLength(1);
  });

  for (const outcome of ["performed", "not_performed"] as const) {
    it.each(channels)(`records the User's ${outcome} reconciliation for %s without resending or rewriting the receipt`, async channel => {
      const { a, c, card, taskId } = await loseOutcome(channel, outcome === "performed" ? "throw" : "lose");
      const original = await a.stub.poppySql("SELECT id, status, result FROM poppy_approvals WHERE id IN (?, ?) ORDER BY id", taskId, card.approvalId);
      const before = (await requests(c)).length;
      await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome });
      expect((await requests(c)).length).toBe(before);
      expect(await a.stub.poppySql("SELECT id, status, result FROM poppy_approvals WHERE id IN (?, ?) ORDER BY id", taskId, card.approvalId)).toBe(original);
      await linked(a, taskId, card.approvalId, "unknown", outcome);
      const activity = JSON.parse(await a.stub.poppyActivity());
      expect(activity.log.find((entry: { id: string }) => entry.id === card.id)).toMatchObject({ result: outcome === "performed" ? "done" : "failed", outcomeBy: "you", outcome: expect.stringContaining("You checked") });
      await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome: outcome === "performed" ? "not_performed" : "performed" });
      await linked(a, taskId, card.approvalId, "unknown", outcome);
      expect((await requests(c)).length).toBe(before);
      await a.stub.poppyRestart();
      expect((await ask(a, c, channel)).isError).toBe(false);
      expect((await c.stub.state()).performs).toBe(outcome === "performed" ? 1 : 0);
    });
  }

  it.each(channels)("does not let reconciliation authorize a pending %s action", async channel => {
    const { a, c, card } = await awaitingTerms(channel);
    await runInDurableObject(a.stub, async instance => {
      await expect(resolveApprovalOutcome(instance.poppy.client, card.approvalId, "not_performed")).rejects.toMatchObject({ code: "invalid_request" });
    });
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "pending" });
  });

  it("keeps one reconciliation when opposite decisions on linked records overlap", async () => {
    const { a, c, card, taskId } = await loseOutcome("openapi");
    const before = (await requests(c)).length;
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const original = client.host.showCard;
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      let reentered = false;
      const showing = vi.spyOn(client.host, "showCard").mockImplementation(async (next, options) => {
        await original(next, options);
        if (!reentered && next.kind === "approval" && next.outcomeResolution) { reentered = true; await resolveApprovalOutcome(client, card.approvalId, "not_performed"); }
      });
      try { await resolveApprovalOutcome(client, card.approvalId, "performed"); expect(reentered).toBe(true); expect(notified).toHaveBeenCalledTimes(1); }
      finally { showing.mockRestore(); notified.mockRestore(); }
    });
    await linked(a, taskId, card.approvalId, "unknown", "performed");
    expect((await requests(c)).length).toBe(before);
  });

  it("restores reconciled receipts after interruption between the durable assertion and page update", async () => {
    const { a, c, card, taskId } = await loseOutcome("openapi");
    const before = (await requests(c)).length;
    await runInDurableObject(a.stub, async instance => {
      const showing = vi.spyOn(instance.poppy.client.host, "showCard").mockRejectedValueOnce(new Error("receipt interrupted"));
      try { await expect(resolveApprovalOutcome(instance.poppy.client, card.approvalId, "performed")).rejects.toThrow("receipt interrupted"); }
      finally { showing.mockRestore(); }
    });
    expect((await cards(a)).find(item => item.approvalId === card.approvalId)?.outcomeResolution).toBeUndefined();
    await a.stub.poppyRestart();
    await linked(a, taskId, card.approvalId, "unknown", "performed");
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: card.approvalId, outcome: "not_performed" });
    await linked(a, taskId, card.approvalId, "unknown", "performed");
    expect((await requests(c)).length).toBe(before);
    expect((await c.stub.state()).performs).toBe(1);
  });
});
