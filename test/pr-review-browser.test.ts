import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { agent, cards, company, requests, signInDirect, tool } from "./agent-helpers";

async function pending(transport: "OpenAPI" | "MCP") {
  const c = await company();
  const a = await agent();
  await signInDirect(a, c);
  const held = transport === "OpenAPI"
    ? await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } })
    : await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "exchange_item", args: { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
  expect(held.isError, held.text).toBe(false);
  const id = JSON.parse(held.details).proposed;
  expect((await cards(a)).find(card => card.approvalId === id)).toMatchObject({ terms: expect.any(Object), status: "pending" });
  expect((await c.stub.state()).performs).toBe(0);
  return { a, c, id };
}

describe("Company-approved write outcomes", () => {
  for (const [transport, failure] of [["OpenAPI", "stream"], ["MCP", "stream"], ["MCP", "invalid-json"]] as const) {
    it(`keeps an actual ${transport} write with ${failure} response failure uncertain and never repeats its approval`, async () => {
      const { a, c, id } = await pending(transport);
      let receivedStatus = 0;
      await runInDurableObject(a.stub, async instance => {
        const client = instance.poppy.client;
        const resource = client.resource.bind(client);
        const fault = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
          const response = await resource(target, request, options);
          const init = request.init();
          const targetCall = init.method === "POST" && (transport === "OpenAPI" ? init.url.endsWith("/exchanges")
            : typeof init.body === "object" && init.body !== null && "method" in init.body && init.body.method === "tools/call");
          if (!targetCall) return response;
          receivedStatus = response.status;
          await response.body?.cancel();
          const body = failure === "stream" ? new ReadableStream({ start(controller) { controller.error(new Error("Synthetic response body failed after headers")); } }) : "{";
          return new Response(body, { status: response.status, headers: response.headers });
        });
        try { await instance.poppyFrame({ type: "poppy.approval", approvalId: id, decision: "approve" }); }
        finally { fault.mockRestore(); }
      });
      expect((await c.stub.state()).performs).toBe(1);
      const receipt = (await cards(a)).find(card => card.approvalId === id)!;
      expect(receipt).toMatchObject({ status: "unknown", answer: { status: receivedStatus } });
      expect(receipt.result).toContain("may have");
      const before = (await requests(c)).length;
      await a.stub.poppyFrame({ type: "poppy.approval", approvalId: id, decision: "approve" });
      expect((await requests(c)).length).toBe(before);
      expect((await c.stub.state()).performs).toBe(1);
    });
  }

  it("does not label an explicit MCP tool error as a completed approved action", async () => {
    const { a, c, id } = await pending("MCP");
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const resource = client.resource.bind(client);
      const peerError = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
        const body = request.init().body;
        if (typeof body === "object" && body !== null && "method" in body && body.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Synthetic tool failure" }] } });
        return resource(target, request, options);
      });
      try { await instance.poppyFrame({ type: "poppy.approval", approvalId: id, decision: "approve" }); }
      finally { peerError.mockRestore(); }
    });
    expect((await cards(a)).find(card => card.approvalId === id)).toMatchObject({ status: "refused", answer: { status: 200, error: "mcp_error" } });
    expect((await c.stub.state()).performs).toBe(0);
  });

  it("does not claim an approved MCP tool was sent when fresh Session initialization fails", async () => {
    const { a, c, id } = await pending("MCP");
    await evictDurableObject(a.stub);
    let toolCalls = 0;
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const resource = client.resource.bind(client);
      const fault = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
        const body = request.init().body;
        if (typeof body === "object" && body !== null && "method" in body) {
          if (body.method === "initialize") return new Response("Unavailable", { status: 503 });
          if (body.method === "tools/call") toolCalls++;
        }
        return resource(target, request, options);
      });
      try { await instance.poppyFrame({ type: "poppy.approval", approvalId: id, decision: "approve" }); }
      finally { fault.mockRestore(); }
    });
    expect(toolCalls).toBe(0);
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(card => card.approvalId === id)).toMatchObject({ status: "failed" });
  });

  it("returns actual ordinary signed-in pages, API products and MCP products without extra reviews", async () => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    for (const [name, args, needle] of [
      ["poppy_browse", { domain: c.domain, action: "open", url: "/orders" }, "Signed in as acct_ada"],
      ["poppy_api_call", { domain: c.domain, operation: "GET /products", params: { q: "jacket" } }, "Stormline Jacket"],
      ["poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } }, "Stormline Jacket"]
    ] as const) {
      const result = await a.stub.poppyTool(name, args);
      expect(result.isError, result.text).toBe(false);
      expect(result.text).toContain(needle);
    }
    expect((await requests(c)).some(request => new URL(request.url).pathname === "/orders")).toBe(true);
    expect((await requests(c)).some(request => request.url.includes("/products?"))).toBe(true);
    expect((await cards(a)).filter(card => card.kind === "approval")).toEqual([]);
  });
});
