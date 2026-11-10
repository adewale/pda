/**
 * Our client against the mock Company serving the 0.4 draft of 10 November
 * (spec/draft-0.4-retrieved-2026-11-10), alone or beside 0.3 (3.4). Every
 * test also passes the strict check in agent-helpers: the mock recorded no
 * violation or warning, and what the agent sent passes the 0.4 kit's schemas.
 */
import { describe, expect, it } from "vitest";
import { agent, cards, company, requests, signInDirect, tool, until, type Agent, type Company } from "./agent-helpers";
import type { MockConfig, MockRequest } from "./mock-company";
import type { AgentPayload } from "./mock-company/types";

const V4: Partial<MockConfig> = { protocolVersion: "0.4" };

/** Requests to the Company's APIs and MCP server, which carry the Session header (5.2). */
const resourceRequests = (all: readonly MockRequest[], c: Company) =>
  all.filter((request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/.well-known/") || url.pathname === "/openapi.json") return false;
    return url.hostname === `api.${c.domain}` || url.hostname === `mcp.${c.domain}`;
  });

describe("0.4: choosing a version and declaring it (3.4)", () => {
  it.each([
    ["serves 0.4 alone", V4],
    ["serves 0.4 and links 0.3", { ...V4, linkedVersion: "0.3" }],
    ["serves 0.3 and links 0.4", { protocolVersion: "0.3", linkedVersion: "0.4" }]
  ] as const)("chooses 0.4 from a Company that %s, and declares it on every Session request", async (_, config) => {
    const c = await company(config);
    const a = await agent();
    const read = await tool(a, "poppy_api_call", { domain: c.domain, operation: "searchProducts", params: { q: "jacket" } });
    expect(read.isError, read.text).toBe(false);
    const resources = resourceRequests(await requests(c), c);
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.every((request) => request.headers["poppy-version"] === "0.4")).toBe(true);
    // The mock lists Operations 3, so the Session declares it (3.3).
    expect(new Set(resources.map((request) => request.headers["poppy-extensions"]))).toEqual(new Set([`"operations";v="3"`]));
    const linked = (await requests(c)).filter((request) => new URL(request.url).pathname.startsWith("/poppy/v"));
    // A 0.4 poppy.json needs no other document; a 0.3 one links the 0.4 document, which is fetched once.
    expect(linked.map((request) => new URL(request.url).pathname)).toEqual(config.protocolVersion === "0.3" ? ["/poppy/v0.4.json"] : []);
  });
});

/** What the agent sent the mock, decoded (test/kit-schemas.ts). */
const sent = async (c: Company): Promise<AgentPayload[]> => (await c.stub.state()).sent.map((payload) => JSON.parse(payload) as AgentPayload);
const EXCHANGE = { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" };

describe("0.4: approving an operation (Operations 3, 5, 6)", () => {
  it("sends a User's approval at an API with approver, approved_at, input_type and the approval's ID as reference", async () => {
    const c = await company(V4);
    const a = await agent();
    await signInDirect(a, c);
    const before = Math.floor(Date.now() / 1000);
    await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    const card = (await cards(a)).find((item) => item.kind === "approval" && item.open)!;
    expect(card.terms.summary).toContain("Exchange the Stormline Jacket (M)");
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.operations).toEqual([expect.objectContaining({ state: "succeeded", approvedBy: "user" })]);
    const header = (await requests(c)).map((request) => request.headers["poppy-approval"]).find(Boolean)!;
    const match = /^operation_id="exc_[\w-]+", revision="[\w-]+", approver="user", approved_at=(\d+), input_type="tap", reference="([\w-]+)"$/.exec(header);
    expect(match, header).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(before);
    expect(match![2]).toBe(card.approvalId);
  });

  it("sends the same statement in an MCP tool call's _meta", async () => {
    const c = await company(V4);
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "exchange_item", args: EXCHANGE });
    const card = (await cards(a)).find((item) => item.kind === "approval" && item.open)!;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    const approvals = (await sent(c)).flatMap((payload) => {
      const meta = (payload.json as { params?: { _meta?: Record<string, unknown> } } | undefined)?.params?._meta?.["personalagentprotocol.org/approval"];
      return meta === undefined ? [] : [meta];
    });
    expect(approvals).toEqual([{ operation_id: expect.any(String), revision: expect.any(String), approver: "user", approved_at: expect.any(Number), input_type: "tap", reference: card.approvalId }]);
  });

  it("sends the statement in a conversation's extensions.operations.approval", async () => {
    const c = await company(V4);
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_message", { domain: c.domain, text: "Please exchange order ord_7Hk2 for the insulated one." });
    const card = await until(async () => (await cards(a)).find((item) => item.kind === "approval" && item.open));
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    await until(async () => (await c.stub.state()).performs === 1);
    const approvals = (await sent(c)).flatMap((payload) => {
      const approval = (payload.json as { message?: { extensions?: { operations?: { approval?: unknown } } } } | undefined)?.message?.extensions?.operations?.approval;
      return approval === undefined ? [] : [approval];
    });
    expect(approvals).toEqual([expect.objectContaining({ approver: "user", input_type: "tap", reference: card.approvalId, approved_at: expect.any(Number) })]);
  });

  it("shows every value in terms, labelled, when an operation has no summary, and binds the approval to them", async () => {
    const c = await company({ ...V4, omitOperationSummary: true });
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_mcp_call", { domain: c.domain, tool: "exchange_item", args: EXCHANGE });
    const card = (await cards(a)).find((item) => item.kind === "approval" && item.open)!;
    expect(card.terms.summary).toBe("The terms: order_id: ord_7Hk2; item_id: itm_4Qa; replacement_sku: stormline-insulated-m; price_difference.amount: 70.00; price_difference.currency: USD.");
    // Nothing to compare an amount with: the terms are what the User reads.
    expect(card.terms.differences).toBeUndefined();
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
  });
});

describe("0.4: request IDs (8.3)", () => {
  it("puts an id on every conversation POST, unique for the User, and none on the message, which takes its request's", async () => {
    const c = await company(V4);
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await tool(a, "poppy_handoff", { conversation: first.conversationId, summary: "The jacket isn't warm enough; the user wants an exchange." });
    await tool(a, "poppy_close", { conversation: first.conversationId });
    const posts = (await sent(c)).filter((payload) => payload.method === "POST" && new URL(payload.url).pathname.includes("/poppy/conversations"));
    const bodies = posts.map((payload) => payload.json as { id?: string; message?: { id?: string } });
    expect(posts.map((payload) => new URL(payload.url).pathname.replace(/cnv_[\w-]+/, "{id}"))).toEqual([
      "/poppy/conversations", "/poppy/conversations/{id}/messages", "/poppy/conversations/{id}/handoff", "/poppy/conversations/{id}/close"
    ]);
    expect(bodies.every((body) => typeof body.id === "string" && body.message?.id === undefined)).toBe(true);
    expect(new Set(bodies.map((body) => body.id)).size).toBe(bodies.length);
    expect((await c.stub.state()).conversations[0]!.status).toBe("closed");
  });
});

describe("0.4: conversation state (8.5 to 8.7, 8.9, 8.12)", () => {
  const state = async (a: Agent, id: string) =>
    (JSON.parse(await a.stub.poppySql(`SELECT status, responder, working, handoff FROM poppy_conversations WHERE id = '${id}'`)) as Record<string, unknown>[])[0];

  it("reads working, handoff, responder and closed, withdraws a handoff, and closes only when the Company says it has", async () => {
    const c = await company(V4);
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    const id = first.conversationId as string;
    await a.stub.poppyReadNow(id);
    expect(await state(a, id)).toEqual({ status: "idle", responder: "agent", working: 0, handoff: "none" });
    await tool(a, "poppy_handoff", { conversation: id, summary: "The jacket isn't warm enough; the user wants an exchange." });
    await a.stub.poppyReadNow(id);
    expect(await state(a, id)).toEqual({ status: "queued", responder: "agent", working: 0, handoff: "pending" });
    const cancelled = await tool(a, "poppy_handoff_cancel", { conversation: id });
    expect(cancelled.isError, cancelled.text).toBe(false);
    await a.stub.poppyReadNow(id);
    expect(await state(a, id)).toEqual({ status: "idle", responder: "agent", working: 0, handoff: "none" });
    const closing = JSON.parse((await tool(a, "poppy_close", { conversation: id })).text);
    expect(closing.status).toBe("closing");
    await a.stub.poppyReadNow(id);
    expect(await state(a, id)).toEqual({ status: "closed", responder: "agent", working: 0, handoff: "none" });
    expect((await c.stub.state()).conversations[0]!.status).toBe("closed");
  });

  it("reads while the Company is still working before it closes, since a close may drop requests not yet acted on (8.12)", async () => {
    // The mock stays working after a handoff it never queues, so the agent's read finds it working.
    const c = await company({ ...V4, neverQueued: true });
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    const id = first.conversationId as string;
    await tool(a, "poppy_handoff", { conversation: id, summary: "The jacket isn't warm enough; the user wants an exchange." });
    await a.stub.poppyReadNow(id);
    expect(await state(a, id)).toMatchObject({ status: "working", working: 1 });
    const mark = (await requests(c)).length;
    await tool(a, "poppy_close", { conversation: id });
    const after = (await requests(c)).slice(mark).map((request) => `${request.method} ${new URL(request.url).pathname.split("/").at(-1)}`);
    expect(after.indexOf("GET events")).toBeGreaterThanOrEqual(0);
    expect(after.indexOf("GET events")).toBeLessThan(after.indexOf("POST close"));
  });

  it("is told when a person joins, from a state event in a stream that also reports working", async () => {
    const c = await company({ ...V4, streaming: true });
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.humanJoin(first.conversationId, "Hi, I'm Sam. I can help with that.");
    await a.stub.poppyWaitForNotice("A person at");
    expect(await state(a, first.conversationId)).toEqual({ status: "idle", responder: "human", working: 0, handoff: "none" });
  });

  it("can't withdraw a handoff in a 0.3 conversation, which has no way to", async () => {
    const c = await company();
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    const refused = await tool(a, "poppy_handoff_cancel", { conversation: first.conversationId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no way to withdraw");
  });
});

describe("0.4: task coverage from the tasks endpoint (9)", () => {
  const tasksRequests = async (c: Company) => (await requests(c)).filter((request) => request.url === `${c.hosts.api}/poppy/tasks`);

  it("gets the tasks response with the Session header and no token, even signed in, and reuses it only in its Session", async () => {
    const c = await company({ ...V4, feedback: true });
    const a = await agent();
    const found = JSON.parse((await tool(a, "poppy_discover", { domain: c.domain })).text);
    expect(found.excludedTasks.tasks.map((entry: { task: string }) => entry.task)).toEqual(["Close an account", "Send a gift card"]);
    expect(found.feedback).toContain("accepted");
    await tool(a, "poppy_discover", { domain: c.domain });
    expect(await tasksRequests(c)).toHaveLength(1);
    expect((await requests(c)).some((request) => request.url.endsWith("/poppy/excluded-tasks.json"))).toBe(false);
    // Another Session, signed in, gets its own response, still with no token; the mock records a token as a violation.
    expect((await signInDirect(a, c, ["orders:read"], {}, { session: "parallel" }))?.callback.status).toBe(200);
    const excluded = { domain: c.domain, task: "Close an account", description: "The User wanted to close their account." };
    expect(JSON.parse((await tool(a, "poppy_feedback", { ...excluded, session: "parallel" })).text).status).toBe("not sent");
    expect(JSON.parse((await tool(a, "poppy_feedback", excluded)).text).status).toBe("not sent");
    const fetched = await tasksRequests(c);
    expect(fetched).toHaveLength(2);
    expect(fetched.every((request) => request.headers["poppy-session"] !== undefined && request.headers.authorization === undefined)).toBe(true);
  });

  it("sends feedback to the endpoint the tasks response names, never about an excluded task", async () => {
    const c = await company({ ...V4, feedback: true, feedbackAlternative: true });
    const a = await agent();
    const excluded = JSON.parse((await tool(a, "poppy_feedback", { domain: c.domain, task: "close an account.", description: "The User wanted to close their account." })).text);
    expect(excluded.status).toBe("not sent");
    const args = { domain: c.domain, task: "Pay with a gift card", description: "The User wanted to pay with a gift card; no API or page takes one." };
    const first = JSON.parse((await tool(a, "poppy_feedback", args)).text);
    expect(first.status).toBe("sent");
    expect(first.companySays.alternative.references).toEqual([{ type: "web", url: `${c.hosts.web}/checkout` }]);
    const reports = (await requests(c)).filter((request) => request.url.endsWith("/poppy/feedback"));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.headers["poppy-session"]).toBeDefined();
    expect(reports[0]!.headers.authorization).toBeUndefined();
    expect(await tasksRequests(c)).toHaveLength(1);
  });

  it("takes no feedback and lists nothing excluded when the Company lists no tasks endpoint", async () => {
    const c = await company({ ...V4, excludedTasks: false });
    const a = await agent();
    const found = JSON.parse((await tool(a, "poppy_discover", { domain: c.domain })).text);
    expect(found.feedback).toBe("not offered");
    expect(found.excludedTasks).toBeUndefined();
    const refused = await tool(a, "poppy_feedback", { domain: c.domain, task: "Pay with a gift card", description: "No API or page takes one." });
    expect(refused.isError).toBe(true);
    expect(await tasksRequests(c)).toHaveLength(0);
  });
});
