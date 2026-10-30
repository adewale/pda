import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { agent, cards, company, connect, signInDirect, tool, until } from "./agent-helpers";

const write = { operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } };

describe("one action's diagnostic export", () => {
  it("retains the action's events after unrelated events leave the newest-200 window", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const asked = JSON.parse((await tool(a, "poppy_api_call", { domain: c.domain, ...write }, "flow-original")).details);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: asked.proposed, decision: "approve" });
    const before = await until(async () => {
      const text = await runInDurableObject(a.stub, instance => instance.log.flowDiagnostics(asked.proposed));
      return text.includes('"call_id":"flow-original"') && text;
    });
    expect(before).toContain('"status":"done"');
    for (let i = 0; i < 205; i++) await a.stub.poppyFrame({ type: "poppy.card.dismiss", id: `unrelated-${i}` });
    expect(await a.stub.diagnostics()).not.toContain('"call_id":"flow-original"');
    await a.stub.poppyRestart();
    const after = await runInDurableObject(a.stub, instance => instance.log.flowDiagnostics(asked.proposed));
    expect(after).toContain('"call_id":"flow-original"');
    expect(after).toContain(asked.proposed);
    expect(after).not.toContain("unrelated-");
    expect(after).not.toContain("replacement_sku");
    expect(after).not.toContain("Stormline");
    expect(after).not.toContain(a.identity.email!);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("answers a flow lookup only on its owner's asking socket", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const asked = JSON.parse((await tool(a, "poppy_api_call", { domain: c.domain, ...write })).details);
    const own = await connect(a.identity);
    const otherAgent = await agent();
    const other = await connect(otherAgent.identity);
    own.socket.send(JSON.stringify({ type: "poppy.diagnostics", flowId: asked.proposed }));
    other.socket.send(JSON.stringify({ type: "poppy.diagnostics", flowId: asked.proposed }));
    await own.client.until(() => own.client.frames.some(frame => frame.type === "poppy.diagnostics"));
    await other.client.until(() => other.client.frames.some(frame => frame.type === "poppy.diagnostics"));
    const ownerText = own.client.frames.find(frame => frame.type === "poppy.diagnostics");
    const otherText = other.client.frames.find(frame => frame.type === "poppy.diagnostics");
    expect(ownerText).toMatchObject({ flowId: asked.proposed, text: expect.stringContaining('"status":"pending"') });
    expect(otherText).toMatchObject({ flowId: asked.proposed, text: expect.stringContaining("No retained records") });
    own.socket.close();
    other.socket.close();
  });

  it("records rendered-link equality counts, never signed URL values", async () => {
    const c = await company({ operations: false });
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_api_call", { domain: c.domain, ...write });
    const result = (await a.stub.poppySql("SELECT id FROM poppy_approvals WHERE id GLOB 'req_*'"));
    const [{ id }] = JSON.parse(result);
    await a.stub.poppySql("INSERT INTO poppy_cards (id, card, open, updated_at) VALUES (?, ?, 0, ?)", `result-${id}`, JSON.stringify({ id: `result-${id}`, kind: "notice", company: "Mock", open: false, text: "Result links", links: [{ label: "checkout", url: "https://checkout.example/pay?session=DO-NOT-EXPORT#secret" }] }), Date.now());
    await a.stub.poppyFrame({ type: "poppy.result_links.checked", cardId: `result-${id}`, checks: [{ index: 0, attribute_equal: true, resolved_equal: false }] });
    const text = await runInDurableObject(a.stub, instance => instance.log.flowDiagnostics(id));
    expect(text).toContain('"attribute_equal":1');
    expect(text).toContain('"resolved_different":1');
    expect(text).not.toContain("DO-NOT-EXPORT");
    expect(text).not.toContain("checkout.example");
    expect(text).not.toContain("#secret");
    expect((await c.stub.state()).performs).toBe(1);
  });
});
