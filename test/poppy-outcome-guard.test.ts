import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decideLocal, recoverApprovalBatches, resolveApprovalOutcome } from "../src/poppy/operations";
import { agent, cards, company, connect, requests, signInDirect, until, type Agent, type Company } from "./agent-helpers";
import { legacyTool as tool } from "./legacy-approval";
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
  expect((await ask(a, c, channel)).isError).toBe(false);
  const parent = await until(async () => (await cards(a)).find(card => card.kind === "approval" && card.open));
  await a.stub.poppyFrame({ type: "poppy.approval", approvalId: parent.approvalId, decision: "approve" });
  const child = await until(async () => (await cards(a)).find(card => card.kind === "approval" && card.open && card.approvalId !== parent.approvalId));
  return { a, c, parent, child };
}

async function loseOutcome(channel: Channel, mode: "throw" | "lose" = "throw") {
  const context = await awaitingTerms(channel);
  await context.a.stub.poppyFault({ method: "POST", url: channel === "openapi" ? "/exchanges" : "/mcp", mode });
  await context.a.stub.poppyFrame({ type: "poppy.approval", approvalId: context.child.approvalId, decision: "approve" });
  for (const card of [context.parent, context.child]) expect((await cards(context.a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "unknown" });
  return context;
}

describe("an unknown approved action needs reconciliation before fresh approval", () => {
  it("repairs reconciled receipts after restart without undoing dismissal or renewing their age", async () => {
    const { a, c, parent, child } = await loseOutcome("openapi");
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: parent.approvalId, outcome: "performed" });
    await a.stub.poppyFrame({ type: "poppy.card.dismiss", id: parent.id });
    const aged = Date.now() - 2 * 60 * 60_000;
    await a.stub.poppySql("UPDATE poppy_cards SET updated_at = ? WHERE id = ?", aged, child.id);
    const before = await a.stub.poppySql("SELECT id, updated_at FROM poppy_cards WHERE id IN (?, ?) ORDER BY id", parent.id, child.id);
    await a.stub.poppyRestart();
    expect(await a.stub.poppySql("SELECT id, updated_at FROM poppy_cards WHERE id IN (?, ?) ORDER BY id", parent.id, child.id)).toBe(before);
    expect(JSON.parse(before).find((row: { id: string }) => row.id === parent.id).updated_at).toBe(0);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("recovers batch notifications with the User's checked outcome and its provenance", async () => {
    const { a, parent } = await loseOutcome("openapi");
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: parent.approvalId, outcome: "performed" });
    await a.stub.poppySql("INSERT INTO poppy_approval_batches (id, ids, told, created_at) VALUES (?, ?, 0, ?)", "reconciled-batch", JSON.stringify([parent.approvalId]), Date.now());
    await runInDurableObject(a.stub, async instance => recoverApprovalBatches(instance.poppy.client));
    const note = (await a.stub.poppyNotices()).find(text => text.includes("The User decided this request"));
    expect(note).toContain("You checked with");
    expect(note).toContain("this action happened");
    expect(note).toContain("original uncertain receipt");
    expect(note).not.toContain("Its outcome is unknown");
  });

  it("reads an old decision over the authenticated socket after its receipt and Activity entry disappear", async () => {
    const { a, c, parent, child } = await loseOutcome("openapi");
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: parent.approvalId, outcome: "performed" });
    for (const card of [parent, child]) await a.stub.poppyFrame({ type: "poppy.card.dismiss", id: card.id });
    await a.stub.poppySql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 205)
      INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at)
      SELECT 'apr_later_' || i, ?, 'main', 'Later action', '{}', 'done', ? + i FROM n`, c.hosts.issuer, Date.now());
    const activity = JSON.parse(await a.stub.poppyActivity());
    expect(activity.log.some((entry: { id: string }) => entry.id === parent.id)).toBe(false);
    const { socket, client } = await connect(a.identity);
    socket.send(JSON.stringify({ type: "poppy.approvals.read", ids: [parent.approvalId, "apr_missing"] }));
    await client.until(() => client.frames.some(frame => frame.type === "poppy.approvals.state"));
    const frame = serverFrame(client.frames.find(frame => frame.type === "poppy.approvals.state"), "lookup reply");
    if (frame.type !== "poppy.approvals.state") throw new Error("Expected approval decisions");
    expect(frame.decisions).toHaveLength(1);
    expect(frame.decisions[0]).toMatchObject({ approvalId: parent.approvalId, result: "done", outcomeResolution: { outcome: "performed" } });
    expect(JSON.stringify(frame)).not.toContain("request");
    const durable = Object.fromEntries(frame.decisions.map(item => [item.approvalId, item]));
    expect(stepDecisions([], activity.log, durable).approvals.get(parent.approvalId)).toMatchObject({ result: "done", facts: [expect.stringContaining("You checked with")] });
    expect((await c.stub.state()).performs).toBe(1);
    socket.close();
    const other = await agent();
    const elsewhere = await connect(other.identity);
    elsewhere.socket.send(JSON.stringify({ type: "poppy.approvals.read", ids: [parent.approvalId] }));
    await elsewhere.client.until(() => elsewhere.client.frames.some(frame => frame.type === "poppy.approvals.state"));
    expect(elsewhere.client.frames.find(frame => frame.type === "poppy.approvals.state")).toMatchObject({ decisions: [] });
    elsewhere.socket.close();
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
    expect((await c.stub.state()).performs).toBe(1);
    // A changed value cannot establish a different business action. Read-only verification remains available.
    expect((await ask(a, c, channel, "stormline-insulated-l")).isError).toBe(true);
    expect((await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" })).isError).toBe(false);
    const elsewhere = await company();
    await signInDirect(a, elsewhere);
    expect((await ask(a, elsewhere, channel)).isError).toBe(false);
  });

  it("holds writes across interfaces, ignored parameters and replacement Sessions at the same Company", async () => {
    const { a, c } = await loseOutcome("openapi");
    // The MCP tool would describe the same exchange through another interface and may return a fresh operation id.
    expect((await ask(a, c, "mcp")).isError).toBe(true);
    const ignored = await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m", trace_id: "fresh-request" } });
    expect(ignored.isError).toBe(true);
    expect(ignored.text).toContain("unknown outcome");
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      client.abandonSession(C.issuer, "main");
    });
    expect((await ask(a, c, "openapi")).isError).toBe(true);
    await signInDirect(a, c);
    expect((await ask(a, c, "mcp")).isError).toBe(true);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it.each(channels)("rechecks a pre-created %s card after another attempt becomes unknown", async channel => {
    const { a, c, child } = await awaitingTerms(channel);
    expect((await ask(a, c, channel)).isError).toBe(false);
    const second = await until(async () => (await cards(a)).find(card => card.kind === "approval" && card.open && card.approvalId !== child.approvalId));
    await a.stub.poppyFault({ method: "POST", url: channel === "openapi" ? "/exchanges" : "/mcp", mode: "throw" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: child.approvalId, decision: "approve" });
    const before = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: second.approvalId, decision: "approve" });
    expect((await requests(c)).slice(before).filter(request => request.method === "POST")).toEqual([]);
    expect((await c.stub.state()).performs).toBe(1);
    expect((await cards(a)).find(card => card.approvalId === second.approvalId)).toMatchObject({ status: "failed", result: expect.stringContaining("unknown outcome") });
  });

  it.each(channels)("keeps a %s server failure uncertain rather than inviting a fresh operation", async channel => {
    const { a, c, child } = await awaitingTerms(channel);
    await a.stub.poppyFault({ method: "POST", url: channel === "openapi" ? "/exchanges" : "/mcp", mode: "error" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: child.approvalId, decision: "approve" });
    expect((await cards(a)).find(card => card.approvalId === child.approvalId)).toMatchObject({ status: "unknown", answer: { status: 500 } });
    expect((await ask(a, c, channel)).isError).toBe(true);
    expect((await c.stub.state()).performs).toBe(0);
  });

  it.each([202, 503])("keeps HTTP %s after the Company performed an approved API write uncertain until the User checks", async status => {
    const { a, c, parent, child } = await awaitingTerms("openapi");
    const originalStatuses = await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const original = client.resource.bind(client);
      const seen: number[] = [];
      const outgoing = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
        const sent = request.init();
        const response = await original(target, request, options);
        if (sent.method === "POST" && sent.url.endsWith("/exchanges") && new Headers(sent.headers).has("Poppy-Approval")) {
          // The strict Company really performs the approved action and returns 201.
          // Only its transport-visible reply changes: acceptance or a server failure cannot prove completion.
          seen.push(response.status);
          return new Response(response.body, { status, headers: response.headers });
        }
        return response;
      });
      try { await decideLocal(client, child.approvalId, "approve"); } finally { outgoing.mockRestore(); }
      return seen;
    });
    expect(originalStatuses).toEqual([201]);
    expect((await c.stub.state()).performs).toBe(1);
    for (const card of [parent, child]) expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "unknown", open: false });
    const approvedWrites = () => requests(c).then(all => all.filter(request => request.method === "POST" && request.url.endsWith("/exchanges") && request.headers["poppy-approval"]));
    expect(await approvedWrites()).toHaveLength(1);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: child.approvalId, decision: "approve" });
    await a.stub.poppyRestart();
    const blocked = await ask(a, c, "openapi");
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("unknown outcome");
    expect(await approvedWrites()).toHaveLength(1);
    const beforeResolution = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: parent.approvalId, outcome: "performed" });
    expect((await requests(c)).length).toBe(beforeResolution);
    for (const card of [parent, child]) expect((await cards(a)).find(item => item.approvalId === card.approvalId)?.outcomeResolution.outcome).toBe("performed");
    // Checking an outcome permits a new proposal, while neither checking nor proposing resends it.
    expect((await ask(a, c, "openapi")).isError).toBe(false);
    expect(await approvedWrites()).toHaveLength(1);
    expect((await c.stub.state()).performs).toBe(1);
  });

  for (const outcome of ["performed", "not_performed"] as const) {
    it.each(channels)(`records the User's ${outcome} reconciliation for %s without resending or rewriting the receipt`, async channel => {
      const { a, c, parent, child } = await loseOutcome(channel, outcome === "performed" ? "throw" : "lose");
      const original = await a.stub.poppySql("SELECT id, status, result FROM poppy_approvals WHERE id IN (?, ?) ORDER BY id", parent.approvalId, child.approvalId);
      const before = (await requests(c)).length;
      await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: parent.approvalId, outcome });
      expect((await requests(c)).length).toBe(before);
      expect(await a.stub.poppySql("SELECT id, status, result FROM poppy_approvals WHERE id IN (?, ?) ORDER BY id", parent.approvalId, child.approvalId)).toBe(original);
      for (const card of [parent, child]) {
        expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "unknown", outcomeResolution: { outcome, at: expect.any(Number) } });
      }
      const activity = JSON.parse(await a.stub.poppyActivity()) as { log: { id: string; result: string; outcomeBy?: string; outcome?: string }[] };
      expect(activity.log.find(item => item.id === parent.id)).toMatchObject({ result: outcome === "performed" ? "done" : "failed", outcomeBy: "you", outcome: expect.stringContaining("You checked") });
      // A replay cannot replace the first reconciliation or send anything.
      await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: parent.approvalId, outcome: outcome === "performed" ? "not_performed" : "performed" });
      expect((await cards(a)).find(item => item.approvalId === parent.approvalId)?.outcomeResolution.outcome).toBe(outcome);
      expect((await requests(c)).length).toBe(before);
      await a.stub.poppyRestart();
      expect((await ask(a, c, channel)).isError).toBe(false);
      expect((await c.stub.state()).performs).toBe(outcome === "performed" ? 1 : 0);
    });
  }

  it.each(channels)("does not let reconciliation authorize a pending %s action", async channel => {
    const { a, c, child } = await awaitingTerms(channel);
    await runInDurableObject(a.stub, async instance => {
      await expect(resolveApprovalOutcome(instance.poppy.client, child.approvalId, "not_performed")).rejects.toMatchObject({ code: "invalid_request" });
    });
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(card => card.approvalId === child.approvalId)).toMatchObject({ status: "pending" });
  });

  it("keeps one reconciliation when opposite decisions on linked receipts overlap", async () => {
    const { a, c, parent, child } = await loseOutcome("openapi");
    const before = (await requests(c)).length;
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const original = client.host.showCard;
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      let reentered = false;
      const showing = vi.spyOn(client.host, "showCard").mockImplementation(async card => {
        await original(card);
        if (!reentered && card.kind === "approval" && card.outcomeResolution) {
          reentered = true;
          await resolveApprovalOutcome(client, child.approvalId, "not_performed");
        }
      });
      try {
        await resolveApprovalOutcome(client, parent.approvalId, "performed");
        expect(reentered).toBe(true);
        expect(notified).toHaveBeenCalledTimes(1);
      } finally { showing.mockRestore(); notified.mockRestore(); }
    });
    for (const card of [parent, child]) expect((await cards(a)).find(item => item.approvalId === card.approvalId)?.outcomeResolution.outcome).toBe("performed");
    expect((await requests(c)).length).toBe(before);
  });

  it("restores reconciled receipts after interruption between the durable assertion and the page update", async () => {
    const { a, c, parent, child } = await loseOutcome("openapi");
    const before = (await requests(c)).length;
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const showing = vi.spyOn(client.host, "showCard").mockRejectedValueOnce(new Error("receipt interrupted"));
      try {
        await expect(resolveApprovalOutcome(client, parent.approvalId, "performed")).rejects.toThrow("receipt interrupted");
      } finally { showing.mockRestore(); }
    });
    expect((await cards(a)).find(card => card.approvalId === parent.approvalId)?.outcomeResolution).toBeUndefined();
    await a.stub.poppyRestart();
    for (const card of [parent, child]) expect((await cards(a)).find(item => item.approvalId === card.approvalId)?.outcomeResolution.outcome).toBe("performed");
    // A conflicting replay repairs from the stored winner; it cannot change it or send another write.
    await a.stub.poppyFrame({ type: "poppy.approval.resolve", approvalId: child.approvalId, outcome: "not_performed" });
    for (const card of [parent, child]) expect((await cards(a)).find(item => item.approvalId === card.approvalId)?.outcomeResolution.outcome).toBe("performed");
    expect((await requests(c)).length).toBe(before);
    expect((await c.stub.state()).performs).toBe(1);
  });
});
