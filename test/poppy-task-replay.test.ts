import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { callMcpTool, callOpenApi, listMcpTools } from "../src/poppy/apis";
import { readApproval } from "../src/poppy/approvals";
import { decideLocal } from "../src/poppy/operations";
import { signOut } from "../src/poppy/signout";
import { isObject, parseStrictJson, type Json } from "../src/poppy/json";
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
    // Replay belongs to the original attempt, not to the account's current
    // withdrawal generation. It must return that result, never send anew.
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await signInDirect(a, c);
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

  it("restores a recorded MCP outcome even when refreshed annotations now call the tool read-only", async () => {
    const c = await company({ operations: false });
    const a = await agent();
    await signInDirect(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const target = await client.company(c.domain);
      const request = { tool: "exchange_item", args, callKey: "annotation-replay" };
      const first = await callMcpTool(client, target, "main", request);
      // Change the real cached description, not the call or its saved result.
      const description = (await listMcpTools(client, target, "main")).find(value => isObject(value) && value.name === "exchange_item");
      if (!isObject(description)) throw new Error("Expected MCP description");
      description.annotations = { readOnlyHint: true };
      const remote = vi.spyOn(client.host, "fetcher");
      try {
        await expect(callMcpTool(client, target, "main", request)).resolves.toEqual(first);
        expect(remote).not.toHaveBeenCalled();
      } finally { remote.mockRestore(); }
    });
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

  it.each(["openapi", "mcp"] as const)("obtains fresh %s terms instead of coalescing into an expired decision", async channel => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    const first = JSON.parse((await ask(a, c.domain, channel, "expired-original")).details);
    const expired = new Date(Date.now() - 1_000).toISOString();
    await a.stub.poppySql("UPDATE poppy_approvals SET terms = json_set(terms, '$.expiresAt', ?), request = json_set(request, '$.call.approval.expires_at', ?) WHERE id = ?", expired, expired, first.proposed);
    const again = await ask(a, c.domain, channel, "fresh-after-expiry");
    expect(again.isError, again.text).toBe(false);
    const next = JSON.parse(again.details).proposed;
    expect(next).not.toBe(first.proposed);
    expect((await cards(a)).find(card => card.approvalId === first.proposed)).toMatchObject({ open: false, status: "failed", result: expect.stringContaining("expired") });
    expect((await cards(a)).filter(card => card.kind === "approval" && card.open)).toEqual([expect.objectContaining({ approvalId: next, status: "pending" })]);
    expect((await c.stub.state()).performs).toBe(0);
  });

  it.each(["openapi", "mcp"] as const)("recovers a known expired Session for an unapproved %s task, and replays its original terms", async channel => {
    const c = await company({ endSessionsOnSignOut: true });
    const a = await agent();
    await signInDirect(a, c);
    const warm = () => channel === "mcp" ? tool(a, "poppy_mcp_list", { domain: c.domain }) : tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
    await warm();
    const originalSession = await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer);
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await signInDirect(a, c);
    expect(await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer)).toBe(originalSession);
    const first = await ask(a, c.domain, channel, "known-session-refusal");
    expect(first.isError, first.text).toBe(false);
    expect(JSON.parse(first.details)).toMatchObject({ proposed: expect.any(String) });
    expect(await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer)).not.toBe(originalSession);
    expect((await c.stub.state()).performs).toBe(0);
    await a.stub.poppyRestart();
    await warm();
    const before = (await requests(c)).length;
    const replay = await ask(a, c.domain, channel, "known-session-refusal");
    expect(replay.isError, replay.text).toBe(false);
    expect(JSON.parse(replay.details)).toEqual(JSON.parse(first.details));
    expect((await requests(c)).slice(before)).toEqual([]);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: JSON.parse(first.details).proposed, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
  });

  it.each(["openapi", "mcp"] as const)("keeps returned %s terms bound to the transport account when sign-out overtakes the response", async channel => {
    const c = await company();
    const a = await agent();
    await signInDirect(a, c);
    if (channel === "mcp") await tool(a, "poppy_mcp_list", { domain: c.domain });
    else await tool(a, "poppy_api_call", { domain: c.domain, operation: "listOrders" });
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const target = await client.company(c.domain);
      const original = client.session(target.issuer, "main")!;
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const read = client.readBody.bind(client);
      let paused = false;
      const body = vi.spyOn(client, "readBody").mockImplementation(async (...args) => {
        const value = await read(...args);
        if (!paused && value.includes('"operation_id"')) { paused = true; entered(); await held; }
        return value;
      });
      const pending = channel === "openapi" ? callOpenApi(client, target, "main", { ...openapi, callKey: "withdrawn-response" })
        : callMcpTool(client, target, "main", { tool: "exchange_item", args, callKey: "withdrawn-response" });
      try {
        await ready;
        await signOut(client, target.issuer, "default");
        release();
        const result = await pending;
        if (!isObject(result) || typeof result.proposed !== "string") throw new Error("Expected returned Company terms");
        const row = client.sql.exec("SELECT request FROM poppy_approvals WHERE id = ?", result.proposed).toArray()[0];
        if (typeof row?.request !== "string") throw new Error("Expected stored decision");
        expect(readApproval(row.request)).toMatchObject({ ok: true, value: { binding: { account: original.account, sessionId: original.session_id, authorityGeneration: original.authority_generation } } });
        const remote = vi.spyOn(client.host, "fetcher");
        try {
          await decideLocal(client, result.proposed, "approve");
          expect(remote.mock.calls.filter(([request]) => request.method === "POST" && (request.url.endsWith("/exchanges") || request.url === c.hosts.mcpUrl))).toEqual([]);
        } finally { remote.mockRestore(); }
      } finally { release(); body.mockRestore(); await pending; }
    });
    expect((await c.stub.state()).performs).toBe(0);
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
          expect(result).toEqual({ status: 201, body, poppyTask: { id: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/), result: "done" } });
        } finally { outgoing.mockRestore(); }
      });
    } catch (error) { unexpected = String(error); }
    expect((await c.stub.state()).performs).toBe(1);
    expect(unexpected).toBeUndefined();
  });
});
