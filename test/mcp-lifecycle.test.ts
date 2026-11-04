/**
 * Our MCP client against servers of each era (spec 7; MCP 2026-07-28
 * Versioning, "Backward Compatibility"): one that speaks only 2026-07-28,
 * one that speaks both, and one that speaks only 2025-06-18. Each mock mode
 * enforces its own version's wire rules, and every test also passes the
 * strict check in agent-helpers, so a successful call proves the client sent
 * that version's headers and metadata. The request sequences the mock saw
 * prove which lifecycle was negotiated, and how.
 */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { listMcpTools } from "../src/poppy/apis";
import { hasCode } from "../src/poppy/client";
import { isObject } from "../src/poppy/json";
import { agent, cards, company, requests, signInDirect, tool, until, type Agent, type Company } from "./agent-helpers";
import type { MockConfig } from "./mock-company";

const MODERN_ONLY: Partial<MockConfig> = { mcpVersions: ["2026-07-28"] };
const DUAL_ERA: Partial<MockConfig> = { mcpVersions: ["2026-07-28", "2025-06-18"] };
const LEGACY_ONLY: Partial<MockConfig> = { mcpVersions: ["2025-06-18"] };
const EXCHANGE = { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" };

const PROBE_MODERN = ["server/discover modern 200"];
const PROBE_LEGACY = ["server/discover modern 400", "initialize legacy 200", "notifications/initialized legacy 202"];

const ERAS = [
  { name: "only 2026-07-28", config: MODERN_ONLY, era: "modern", opens: PROBE_MODERN },
  { name: "both versions", config: DUAL_ERA, era: "modern", opens: PROBE_MODERN },
  { name: "only 2025-06-18", config: LEGACY_ONLY, era: "legacy", opens: PROBE_LEGACY }
] as const;

/** What the mock's MCP server saw since `from`: method, lifecycle and status. */
async function mcpSeen(c: Company, from = 0): Promise<string[]> {
  return (await c.stub.state()).mcp.slice(from).map((exchange) => `${exchange.method} ${exchange.lifecycle} ${exchange.status}`);
}

async function mcpCount(c: Company): Promise<number> {
  return (await c.stub.state()).mcp.length;
}

const search = (a: Agent, c: Company, extra: Record<string, unknown> = {}) =>
  tool(a, "poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" }, ...extra });

describe.each(ERAS)("a server that speaks $name", ({ config, era, opens }) => {
  it("negotiates its lifecycle with a discovery probe, then lists and calls under it", async () => {
    const c = await company(config);
    const a = await agent();
    const called = await search(a, c);
    expect(called.isError).toBe(false);
    expect(called.text).toContain("Stormline Jacket");
    expect(await mcpSeen(c)).toEqual([...opens, `tools/list ${era} 200`, `tools/call ${era} 200`]);
    // The era and the catalogue are cached: the next call is the call alone.
    const mark = await mcpCount(c);
    expect((await search(a, c)).isError).toBe(false);
    expect(await mcpSeen(c, mark)).toEqual([`tools/call ${era} 200`]);
  });

  it("carries the Session header on every request, and Mcp-Session-Id only in a 2025-06-18 session", async () => {
    const c = await company(config);
    const a = await agent();
    expect((await search(a, c)).isError).toBe(false);
    const mcp = (await requests(c)).filter((request) => new URL(request.url).pathname === "/mcp");
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp.every((request) => request.headers["poppy-session"] !== undefined)).toBe(true);
    const exchanges = (await c.stub.state()).mcp;
    expect(exchanges.every((exchange) => exchange.poppySession)).toBe(true);
    expect(exchanges.filter((exchange) => exchange.lifecycle === "modern").some((exchange) => exchange.mcpSessionId)).toBe(false);
    if (era === "modern") {
      expect(mcp.some((request) => request.headers["mcp-session-id"] !== undefined)).toBe(false);
      const call = mcp.find((request) => request.headers["mcp-method"] === "tools/call")!;
      expect(call.headers).toMatchObject({ "mcp-protocol-version": "2026-07-28", "mcp-name": "search_products", "mcp-param-query": "jacket" });
    } else {
      // Every request after initialize carries the session it opened, and the version it negotiated.
      const opened = mcp.findIndex((request) => request.status === 200);
      expect(mcp.slice(opened + 1).every((request) => request.headers["mcp-session-id"] && request.headers["mcp-protocol-version"] === "2025-06-18")).toBe(true);
    }
  });

  it("sends a signed-in call again with the User's approval in _meta, beside 2026-07-28's protocol fields when it applies (Ops 6)", async () => {
    const c = await company(config);
    const a = await agent();
    await signInDirect(a, c);
    const asked = await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "exchange_item", args: EXCHANGE });
    expect(asked.isError).toBe(false);
    const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    const mark = await mcpCount(c);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    // The strict modern mode refuses a call without the protocol fields, so a performed exchange proves both rode in _meta.
    expect((await c.stub.state()).performs).toBe(1);
    expect(await mcpSeen(c, mark)).toEqual([`tools/call ${era} 200`]);
    const approved = (await requests(c)).filter((request) => new URL(request.url).pathname === "/mcp" && request.status === 200).at(-1)!;
    if (era === "modern") expect(approved.headers).toMatchObject({ "mcp-name": "exchange_item", "mcp-param-order-id": "ord_7Hk2" });
  });
});

describe("a server whose era changes", () => {
  it("probes a server cached as 2025-06-18 again when its initialize is answered as 2026-07-28, then continues under 2026-07-28", async () => {
    const c = await company(LEGACY_ONLY);
    const a = await agent();
    expect((await search(a, c)).isError).toBe(false);
    await c.stub.configure(MODERN_ONLY);
    const mark = await mcpCount(c);
    // Another Poppy Session needs its own entry, so it opens one under the cached era.
    expect((await search(a, c, { session: "second" })).isError).toBe(false);
    expect(await mcpSeen(c, mark)).toEqual(["initialize legacy 400", "server/discover modern 200", "tools/list modern 200", "tools/call modern 200"]);
  });

  it("never sends a refused tools/call again: a 2025-06-18 session's call answered as 2026-07-28 is reported, and the next request probes", async () => {
    const c = await company(LEGACY_ONLY);
    const a = await agent();
    expect((await search(a, c)).isError).toBe(false);
    await c.stub.configure(MODERN_ONLY);
    let mark = await mcpCount(c);
    const refused = await search(a, c);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Nothing was done");
    // A 2026-07-28-only server reads every request as 2026-07-28, and tells this one, sent in the old session, what it speaks.
    const [sent] = (await c.stub.state()).mcp.slice(mark);
    expect(sent).toMatchObject({ method: "tools/call", status: 400, code: -32022, protocolVersion: "2025-06-18", mcpSessionId: true });
    expect(await mcpSeen(c, mark)).toHaveLength(1);
    mark = await mcpCount(c);
    expect((await search(a, c)).isError).toBe(false);
    expect(await mcpSeen(c, mark)).toEqual(["server/discover modern 200", "tools/list modern 200", "tools/call modern 200"]);
  });

  it("falls back from a server cached as 2026-07-28 to 2025-06-18 for a read, asking it once more under the new lifecycle", async () => {
    const c = await company(MODERN_ONLY);
    const a = await agent();
    expect((await search(a, c)).isError).toBe(false);
    await c.stub.configure(LEGACY_ONLY);
    const mark = await mcpCount(c);
    const listed = await tool(a, "poppy_mcp_list", { domain: c.domain, session: "second" });
    expect(listed.isError).toBe(false);
    expect(await mcpSeen(c, mark)).toEqual(["tools/list modern 400", ...PROBE_LEGACY, "tools/list legacy 200"]);
  });

  it("doesn't send an approved tools/call again after the server answers it as the other era: nothing was done, and the User is told", async () => {
    const c = await company(MODERN_ONLY);
    const a = await agent();
    await signInDirect(a, c);
    expect((await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "exchange_item", args: EXCHANGE })).isError).toBe(false);
    const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    await c.stub.configure(LEGACY_ONLY);
    const mark = await mcpCount(c);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect(await mcpSeen(c, mark)).toEqual(["tools/call modern 400"]);
    expect((await c.stub.state()).performs).toBe(0);
    // Refused: the Company answered, so the outcome is known, and no unknown-outcome hold is needed.
    const card = await until(async () => (await cards(a)).find((item) => item.approvalId === terms.approvalId && item.status === "refused"));
    expect(card.result).toContain("answered 400");
  });
});

describe("a tools/call whose outcome is unknown", () => {
  it.each(ERAS)("is never sent again, under any lifecycle, when the answer to an approved call to a server of $name is lost", async ({ config, era }) => {
    const c = await company(config);
    const a = await agent();
    await signInDirect(a, c);
    expect((await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "exchange_item", args: EXCHANGE })).isError).toBe(false);
    const terms = await until(async () => (await cards(a)).find((card) => card.kind === "approval" && card.open));
    const mark = await mcpCount(c);
    // The approved call reaches the Company, which acts, and its answer is lost.
    await a.stub.poppyFault({ method: "POST", url: "/mcp", mode: "throw" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: terms.approvalId, decision: "approve" });
    expect(await a.stub.poppyFaultsLeft()).toBe(0);
    const held = await until(async () => (await cards(a)).find((item) => item.approvalId === terms.approvalId && item.status === "unknown"));
    expect(held.status).toBe("unknown");
    expect((await c.stub.state()).performs).toBe(1);
    // One tools/call, and no probe, handshake or second attempt after it.
    expect(await mcpSeen(c, mark)).toEqual([`tools/call ${era} 200`]);
  });
});

describe("an ordinary failure under 2026-07-28", () => {
  it.each([
    { what: "a Poppy error", status: 400, body: { error: "invalid_session" }, code: "invalid_session" },
    { what: "a missing client capability", status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32021, message: "Missing required client capability", data: { requiredCapabilities: { elicitation: {} } } } }, code: "mcp_error" },
    { what: "a server error", status: 500, body: { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, code: "mcp_error" }
  ])("keeps its structured body and changes no lifecycle: $what", async ({ status, body, code }) => {
    const c = await company(MODERN_ONLY);
    const a = await agent();
    expect((await search(a, c)).isError).toBe(false);
    const mark = await mcpCount(c);
    const outcome = await runInDurableObject(a.stub, async (instance) => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const original = client.resource.bind(client);
      const methods: string[] = [];
      const outgoing = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
        const sent = request.init().body;
        if (isObject(sent) && typeof sent.method === "string") methods.push(sent.method);
        if (isObject(sent) && sent.method === "tools/list") return Response.json(body, { status });
        return original(target, request, options);
      });
      try {
        // Another Poppy Session, so its entry has no catalogue yet; the server's era is cached.
        const failure = await listMcpTools(client, C, "second").then(() => null, (error: unknown) => error);
        return { methods, code: hasCode(failure, "mcp_error", "invalid_session") ? failure.code : String(failure), body: hasCode(failure, "mcp_error", "invalid_session") ? failure.detail.body ?? null : null };
      } finally { outgoing.mockRestore(); }
    });
    expect(outcome.methods).toEqual(["tools/list"]);
    expect(outcome.code).toBe(code);
    expect(outcome.body).toEqual(isObject(body) && isObject(body.error) ? body.error : body);
    // Still 2026-07-28: no probe or handshake, then or on the next call.
    expect((await search(a, c, { session: "second" })).isError).toBe(false);
    expect(await mcpSeen(c, mark)).toEqual(["tools/list modern 200", "tools/call modern 200"]);
  });
});

describe("a header mismatch on a 2026-07-28 tools/call", () => {
  it("is reported with its body and not sent again, and the next call reads the tool list first", async () => {
    const c = await company(MODERN_ONLY);
    const a = await agent();
    expect((await search(a, c)).isError).toBe(false);
    const mark = await mcpCount(c);
    const mismatch = { jsonrpc: "2.0", id: null, error: { code: -32020, message: "Header mismatch: Mcp-Param-Query" } };
    const sent = await runInDurableObject(a.stub, async (instance) => {
      const client = instance.poppy.client;
      const methods: string[] = [];
      const original = client.resource.bind(client);
      const outgoing = vi.spyOn(client, "resource").mockImplementation(async (target, request, options) => {
        const body = request.init().body;
        if (isObject(body) && typeof body.method === "string") methods.push(body.method);
        if (isObject(body) && body.method === "tools/call") return Response.json(mismatch, { status: 400 });
        return original(target, request, options);
      });
      try {
        const refused = await instance.poppyTool("poppy_mcp_call", { domain: c.domain, tool: "search_products", args: { query: "jacket" } });
        return { refused, methods };
      } finally { outgoing.mockRestore(); }
    });
    expect(sent.refused.isError).toBe(true);
    expect(sent.refused.text).toContain("Header mismatch");
    expect(sent.methods).toEqual(["tools/call"]);
    // The catalogue was fresh for another five minutes, but the mismatch dropped it.
    expect((await search(a, c)).isError).toBe(false);
    expect(await mcpSeen(c, mark)).toEqual(["tools/list modern 200", "tools/call modern 200"]);
  });
});
