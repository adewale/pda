import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { callOpenApi } from "../src/poppy/apis";
import { parseStrictJson, type Json } from "../src/poppy/json";
import { resultLinks } from "../src/poppy/result-links";
import { agent, cards, company, requests, signInDirect, tool } from "./agent-helpers";

const args = { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" };
const openapi = { operation: "exchangeItem", params: { order_id: args.order_id }, body: { item_id: args.item_id, replacement_sku: args.replacement_sku } };
async function ask(a: Awaited<ReturnType<typeof agent>>, domain: string, channel: "openapi" | "mcp", callId: string) {
  return channel === "openapi"
    ? tool(a, "poppy_api_call", { domain, ...openapi }, callId)
    : tool(a, "poppy_mcp_call", { domain, tool: "exchange_item", args }, callId);
}

describe("durable task replay adversarial regressions", () => {
  it.each(["openapi", "mcp"] as const)("does not send again when replaying a %s call that reused terms before they completed", async channel => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const first = await ask(a, c.domain, channel, "original");
    const reused = await ask(a, c.domain, channel, "reused");
    const approvalId = JSON.parse(first.details).proposed;
    expect(JSON.parse(reused.details).proposed).toBe(approvalId);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    await a.stub.poppyRestart();
    // Warm harmless token/tool metadata reads separately, so the negative
    // oracle concerns business requests rather than MCP initialization.
    if (channel === "mcp") await tool(a, "poppy_mcp_list", { domain: c.domain });
    else await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
    const before = (await requests(c)).length;
    const replay = await ask(a, c.domain, channel, "reused");
    expect(replay.isError).toBe(false);
    expect((await requests(c)).slice(before).filter(request => request.method === "POST" && (channel === "openapi" ? request.url.endsWith("/exchanges") : request.url === c.hosts.mcpUrl)).map(request => ({ method: request.method, path: new URL(request.url).pathname, status: request.status }))).toEqual([]);
    expect((await cards(a)).filter(card => card.kind === "approval" && card.open)).toEqual([]);
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("does not repeat a routine effect when another current task call claimed its pending request", async () => {
    const c = await company({ operations: false });
    const a = await agent();
    await signInDirect(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const target = await client.lookup(c.domain);
      if (!("issuer" in target)) throw new Error("Expected API Company");
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const resume = client.resumeCompany.bind(client);
      let blocked = false;
      const paused = vi.spyOn(client, "resumeCompany").mockImplementation(async (...args) => {
        if (!blocked && args[1] === "approval") { blocked = true; entered(); await held; }
        return resume(...args);
      });
      const first = callOpenApi(client, target, "main", { ...openapi, callKey: "concurrent-original" });
      try {
        await ready;
        const reused = await callOpenApi(client, target, "main", { ...openapi, callKey: "concurrent-reused" });
        expect(reused).toMatchObject({ status: 201 });
        release();
        expect(await first).toEqual(reused);
        expect(await callOpenApi(client, target, "main", { ...openapi, callKey: "concurrent-reused" })).toEqual(reused);
      } finally { release(); paused.mockRestore(); await first; }
    });
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("bounds Company-controlled result-link labels without truncating the href", () => {
    const body = { ["x".repeat(1_900_000)]: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`item${i}_url`, `https://shop.example/pay/${i}`])) };
    expect(JSON.stringify(body).length).toBeLessThan(2_000_000);
    const links = resultLinks(body);
    expect(links).toHaveLength(12);
    expect(links.map(link => link.label.length)).toEqual(Array(12).fill(expect.any(Number)));
    expect(Math.max(...links.map(link => link.label.length))).toBeLessThanOrEqual(256);
  });

  it("does not place directional controls before the destination label", () => {
    const links = resultLinks({ ["Checkout \u202Eurl"]: "https://moc.knab.dev/pay" });
    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe("https://moc.knab.dev/pay");
    expect(links[0]!.label.includes("\u202E")).toBe(false);
  });

  it("returns a valid successful task result at the inbound JSON depth boundary", async () => {
    const c = await company({ operations: false });
    const a = await agent();
    await signInDirect(a, c);
    let body: Json = { checkout_url: `${c.hosts.web}/checkout?session=synthetic` };
    for (let i = 0; i < 63; i++) body = { nested: body };
    expect(parseStrictJson(JSON.stringify(body))).toEqual(body);
    let unexpected: string | undefined;
    try {
      await runInDurableObject(a.stub, async instance => {
        const client = instance.poppy.client;
        const send = client.resource.bind(client);
        const outgoing = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
          const response = await send(target, request, options);
          return response.status === 201 ? Response.json(body, { status: 201 }) : response;
        });
        try {
          const target = await client.lookup(c.domain);
          if (!("issuer" in target)) throw new Error("Expected API Company");
          const result = await callOpenApi(client, target, "main", { ...openapi, callKey: "deep-result" });
          expect(result).toEqual({ status: 201, body });
        } finally { outgoing.mockRestore(); }
      });
    } catch (error) { unexpected = String(error); }
    expect((await c.stub.state()).performs).toBe(1);
    expect(unexpected).toBeUndefined();
  });
});
