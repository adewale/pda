import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { id as logId } from "../src/log";
import { FLOW_DIAGNOSTIC_LIMITS } from "../src/flow-diagnostics";
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

  it("bounds each flow by event count and UTF-8 bytes, and evicts only the oldest flow buffers", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const asked = JSON.parse((await tool(a, "poppy_api_call", { domain: c.domain, ...write })).details);
    await runInDurableObject(a.stub, instance => {
      const sql = instance.poppy.client.sql;
      for (let n = 0; n < FLOW_DIAGNOSTIC_LIMITS.events + 5; n++) instance.log.event("ws", { approval_id: logId(asked.proposed), retention_marker: n }).emit();
      const count = sql.exec("SELECT count(*) AS n FROM agent_flow_log").one();
      expect(Number(count.n)).toBe(FLOW_DIAGNOSTIC_LIMITS.events);
      const part = logId("x".repeat(150));
      if (!part) throw new Error("Expected a synthetic safe ID");
      const payload = Array.from({ length: 1000 }, () => part);
      for (let n = 0; n < 3; n++) instance.log.event("ws", { approval_id: logId(asked.proposed), test_payload: payload }).emit();
      const bytes = sql.exec("SELECT sum(length(CAST(line AS BLOB))) AS n FROM agent_flow_log").one();
      expect(Number(bytes.n)).toBeGreaterThan(0);
      expect(Number(bytes.n)).toBeLessThanOrEqual(FLOW_DIAGNOSTIC_LIMITS.bytes);
      // Valid-shaped synthetic lifecycle records isolate the retention contract;
      // they do not claim that these Company actions actually ran.
      for (let n = 0; n <= FLOW_DIAGNOSTIC_LIMITS.flows; n++) {
        const key = `req_retention_${n}`;
        sql.exec("INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at) SELECT ?, issuer, label, summary, request, 'done', created_at FROM poppy_approvals WHERE id = ?", key, asked.proposed);
        instance.log.event("ws", { approval_id: logId(key), retention_marker: n }).emit();
      }
      expect(Number(sql.exec("SELECT count(DISTINCT flow_id) AS n FROM agent_flow_log").one().n)).toBe(FLOW_DIAGNOSTIC_LIMITS.flows);
      expect(Number(sql.exec("SELECT count(*) AS n FROM agent_flow_log WHERE flow_id = 'req_retention_0'").one().n)).toBe(0);
      expect(instance.log.flowDiagnostics(`req_retention_${FLOW_DIAGNOSTIC_LIMITS.flows}`)).toContain(`\"retention_marker\":${FLOW_DIAGNOSTIC_LIMITS.flows}`);
    });
    expect((await c.stub.state()).performs).toBe(0);
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
