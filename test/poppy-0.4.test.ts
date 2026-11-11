/**
 * Our client against the mock Company serving the 0.4 draft of 10 November
 * (spec/draft-0.4-retrieved-2026-11-10), alone or beside 0.3 (3.4). Every
 * test also passes the strict check in agent-helpers: the mock recorded no
 * violation or warning, and what the agent sent passes the 0.4 kit's schemas.
 */
import { decodeJwt } from "jose";
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

  it("gives the model the four fields as the Company sent them, and 0.3's status and responder in a 0.3 conversation", async () => {
    const c = await company(V4);
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    const id = first.conversationId as string;
    expect(first).not.toHaveProperty("status");
    expect(first).toMatchObject({ closed: false, handoff: "none", responder: "agent" });
    const handed = JSON.parse((await tool(a, "poppy_handoff", { conversation: id, summary: "The jacket isn't warm enough; the user wants an exchange." })).text);
    expect(Object.keys(handed).sort()).toEqual(["closed", "handoff", "responder", "working"]);
    await a.stub.poppyReadNow(id);
    const read = JSON.parse((await tool(a, "poppy_read", { conversation: id })).text);
    expect(read).toMatchObject({ conversation: id, closed: false, working: false, handoff: "pending", responder: "agent" });
    const status = JSON.parse((await tool(a, "poppy_status", { domain: c.domain })).text);
    expect(status.conversations).toEqual([{ conversation: id, closed: false, working: false, handoff: "pending", responder: "agent", direct: false }]);
    const old = await company();
    const earlier = JSON.parse((await tool(a, "poppy_message", { domain: old.domain, text: "hello" })).text);
    expect(Object.keys(JSON.parse((await tool(a, "poppy_read", { conversation: earlier.conversationId })).text)).sort()).toEqual(["conversation", "messages", "responder", "status"]);
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
    const c = await company({ ...V4, excludedTasks: false, skills: false });
    const a = await agent();
    const found = JSON.parse((await tool(a, "poppy_discover", { domain: c.domain })).text);
    expect(found.feedback).toBe("not offered");
    expect(found.excludedTasks).toBeUndefined();
    const refused = await tool(a, "poppy_feedback", { domain: c.domain, task: "Pay with a gift card", description: "No API or page takes one." });
    expect(refused.isError).toBe(true);
    expect(await tasksRequests(c)).toHaveLength(0);
  });
});

describe("0.4: a website that asks agents not to browse (6, web.disabled)", () => {
  it("reads its pages but never fills or sends a form, and points the model to the agent and APIs", async () => {
    const c = await company({ ...V4, webDisabled: true });
    const a = await agent();
    const found = JSON.parse((await tool(a, "poppy_discover", { domain: c.domain })).text);
    expect(found.website).toContain("readable only");
    const opened = await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: "/" });
    expect(opened.isError, opened.text).toBe(false);
    for (const step of [{ action: "fill", selector: "input[name=line1]", value: "1 Main St" }, { action: "submit", selector: "form" }]) {
      const refused = await tool(a, "poppy_browse", { domain: c.domain, ...step });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("asks agents not to use its website in a browser");
    }
    expect((await requests(c)).some((request) => request.method === "POST" && new URL(request.url).pathname === "/account/address")).toBe(false);
  });

  it("is a 0.4 member only: a 0.3 Company's website stays browsable", async () => {
    const c = await company({ protocolVersion: "0.3", webDisabled: true });
    const a = await agent();
    expect(JSON.parse((await tool(a, "poppy_discover", { domain: c.domain })).text).website).toBe("browsable in the session");
  });
});

describe("0.4: extension_required in a JSON body (3.3)", () => {
  it.each([
    ["an OpenAPI operation", "poppy_api_call", (c: Company) => ({ domain: c.domain, operation: "POST /orders/{order_id}/exchanges", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } })],
    ["an MCP tool", "poppy_mcp_call", (c: Company) => ({ domain: c.domain, tool: "exchange_item", args: EXCHANGE })]
  ] as const)("tells the model which extension %s requires, from the body rather than WWW-Authenticate", async (_, name, args) => {
    const c = await company({ ...V4, requiredExtension: "mock.test/gift-wrap" });
    const a = await agent();
    await signInDirect(a, c);
    const result = await tool(a, name, args(c));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.details)).toMatchObject({ error: "extension_required", extension: "mock.test/gift-wrap" });
    expect(result.text).toContain("requires the extension mock.test/gift-wrap, which this agent doesn't support");
    expect((await c.stub.state()).performs).toBe(0);
  });
});

describe("0.4: the Session header on website pages fetched without a browser (5.2; decision 44)", () => {
  const pages = async (c: Company) => (await requests(c)).filter((request) => {
    const url = new URL(request.url);
    return !url.pathname.startsWith("/.well-known/") && !url.pathname.startsWith("/poppy/") && (url.hostname === c.domain || url.hostname === `cdn.${c.domain}`);
  });

  it("signs each page on organization.domain, signed out even in a signed-in Session, and never one a redirect leaves it for", async () => {
    const c = await company({ ...V4, browserSession: false });
    const a = await agent();
    expect((await signInDirect(a, c, ["orders:read"]))?.callback.status).toBe(200);
    const opened = await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: `/go?to=${encodeURIComponent(`https://cdn.${c.domain}/orders`)}` });
    expect(opened.isError, opened.text).toBe(false);
    const [first, second] = await pages(c);
    expect(new URL(first!.url).pathname).toBe("/go");
    expect(first!.headers["poppy-session"]).toBeDefined();
    expect(first!.headers["poppy-version"]).toBe("0.4");
    // No token, so no ath either: the mock records one in the JWT (session-jwt.ath-without-token) or beside it (page.token).
    expect(first!.headers.authorization).toBeUndefined();
    expect(new URL(second!.url).hostname).toBe(`cdn.${c.domain}`);
    expect(second!.headers["poppy-session"]).toBeUndefined();
  });

  it("fetches a page once more without the header when the page refuses it with invalid_session", async () => {
    const c = await company({ ...V4, browserSession: false, pagesRefuseSession: true });
    const a = await agent();
    const opened = await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: "/orders" });
    expect(opened.isError, opened.text).toBe(false);
    expect((await pages(c)).map((request) => [request.status, request.headers["poppy-session"] !== undefined])).toEqual([[400, true], [200, false]]);
  });

  it.each([
    ["joins the Session as a browser where the Company lists browser_session_endpoint", V4],
    ["keeps 0.3's pages unsigned", { protocolVersion: "0.3", browserSession: false }]
  ] as const)("sends no header on a page when it %s", async (_, config) => {
    const c = await company(config);
    const a = await agent();
    const opened = await tool(a, "poppy_browse", { domain: c.domain, action: "open", url: "/orders" });
    expect(opened.isError, opened.text).toBe(false);
    const fetched = await pages(c);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((request) => request.headers["poppy-session"] === undefined)).toBe(true);
  });
});

describe("0.4: approvals across Sessions (Operations 3; decision 43)", () => {
  const exchange = (c: Company) => ({ domain: c.domain, operation: "POST /orders/{order_id}/exchanges", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
  const approveAfterSessionEnds = async (config: Partial<MockConfig>) => {
    const c = await company(config);
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_api_call", exchange(c));
    const card = (await cards(a)).find((item) => item.kind === "approval" && item.open)!;
    expect(await c.stub.endAllSessions()).toBeGreaterThan(0);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    return { c, a, card };
  };

  it("sends an approval in the new Session the agent starts after the Company ends the one that returned the operation", async () => {
    const { c } = await approveAfterSessionEnds(V4);
    expect((await c.stub.state()).performs).toBe(1);
    const exchanges = resourceRequests(await requests(c), c).filter((request) => request.method === "POST" && request.url.endsWith("/exchanges"));
    const sid = (request: MockRequest) => decodeJwt(request.headers["poppy-session"]!).sid;
    const returned = exchanges.find((request) => request.headers["poppy-approval"] === undefined)!;
    const performed = exchanges.filter((request) => request.headers["poppy-approval"] !== undefined).at(-1)!;
    expect(performed.status).toBe(201);
    expect(sid(performed)).not.toBe(sid(returned));
  });

  it("still never sends a signed-in approval after the User signs out", async () => {
    const c = await company(V4);
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_api_call", exchange(c));
    const card = (await cards(a)).find((item) => item.kind === "approval" && item.open)!;
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find((item) => item.approvalId === card.approvalId)?.status).not.toBe("done");
  });

  it("keeps a 0.3 approval in the Session that returned it", async () => {
    const { c, a, card } = await approveAfterSessionEnds({ protocolVersion: "0.3" });
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find((item) => item.approvalId === card.approvalId)).toMatchObject({ status: "failed" });
  });
});

describe("0.4: after version_unsupported (3.4)", () => {
  it("fetches poppy.json afresh, and sends a read once more in a new Session under the version it chooses", async () => {
    const c = await company({ ...V4, linkedVersion: "0.3" });
    const a = await agent();
    const search = { domain: c.domain, operation: "searchProducts", params: { q: "jacket" } };
    expect((await tool(a, "poppy_api_call", search)).isError).toBe(false);
    await c.stub.configure({ protocolVersion: "0.3", linkedVersion: null });
    const mark = (await requests(c)).length;
    const again = await tool(a, "poppy_api_call", search);
    expect(again.isError, again.text).toBe(false);
    const after = (await requests(c)).slice(mark);
    const searches = after.filter((request) => new URL(request.url).pathname === "/products");
    expect(searches.map((request) => [request.status, request.headers["poppy-version"] ?? null])).toEqual([[400, "0.4"], [200, null]]);
    expect(decodeJwt(searches[1]!.headers["poppy-session"]!).sid).not.toBe(decodeJwt(searches[0]!.headers["poppy-session"]!).sid);
    expect(after.filter((request) => new URL(request.url).pathname === "/.well-known/poppy.json")).toHaveLength(1);
  });

  it("doesn't send a conversation message again under another version, and says so", async () => {
    const c = await company({ ...V4, linkedVersion: "0.3" });
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.configure({ protocolVersion: "0.3", linkedVersion: null });
    const refused = await tool(a, "poppy_message", { domain: c.domain, conversation: first.conversationId, text: "and another thing" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no longer serves protocol version 0.4");
    const messages = (await requests(c)).filter((request) => request.method === "POST" && /\/messages$/.test(new URL(request.url).pathname));
    expect(messages.map((request) => request.status)).toEqual([400]);
  });
});

describe("0.4: a conversation keeps its versions (8.2)", () => {
  const sid = (request: MockRequest) => decodeJwt(request.headers["poppy-session"]!).sid;
  const conversationRequests = async (c: Company) => (await requests(c)).filter((request) => /\/conversations/.test(new URL(request.url).pathname));

  it("finishes a 0.3 conversation in a 0.3 Session of its own after the Company moves to 0.4, and leaves other work in 0.4", async () => {
    const c = await company({ protocolVersion: "0.3", keepsConversationVersions: true });
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.configure({ protocolVersion: "0.4", linkedVersion: "0.3" });
    await a.stub.poppySql("UPDATE poppy_domains SET expires_at = 0");
    const search = { domain: c.domain, operation: "searchProducts", params: { q: "jacket" } };
    expect((await tool(a, "poppy_api_call", search)).isError).toBe(false);
    const mark = (await conversationRequests(c)).length;
    const again = await tool(a, "poppy_message", { domain: c.domain, conversation: first.conversationId, text: "and another thing" });
    expect(again.isError, again.text).toBe(false);
    expect((await tool(a, "poppy_api_call", search)).isError).toBe(false);
    const messages = (await conversationRequests(c)).slice(mark).filter((request) => request.method === "POST");
    expect(messages.map((request) => [request.status, request.headers["poppy-version"] ?? null])).toEqual([[202, null]]);
    const searches = (await requests(c)).filter((request) => new URL(request.url).pathname === "/products");
    expect(searches.map((request) => request.headers["poppy-version"])).toEqual(["0.4", "0.4"]);
    // The 0.4 work kept its Session: the conversation's Session is another one, not a restart of it.
    expect(sid(searches[1]!)).toBe(sid(searches[0]!));
    expect(sid(messages[0]!)).not.toBe(sid(searches[0]!));
    // A new conversation starts in the version the agent now chooses.
    const fresh = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "a new question" })).text);
    expect(fresh.conversationId).not.toBe(first.conversationId);
    expect((await conversationRequests(c)).at(-1)!.headers["poppy-version"]).toBe("0.4");
  });

  it("keeps the conversation's Session signed in to the account its label uses", async () => {
    const c = await company({ protocolVersion: "0.3", keepsConversationVersions: true });
    const a = await agent();
    await signInDirect(a, c, ["orders:read"]);
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "where is my order?" })).text);
    await c.stub.configure({ protocolVersion: "0.4", linkedVersion: "0.3" });
    await a.stub.poppySql("UPDATE poppy_domains SET expires_at = 0");
    const mark = (await conversationRequests(c)).length;
    const again = await tool(a, "poppy_message", { domain: c.domain, conversation: first.conversationId, text: "thanks" });
    expect(again.isError, again.text).toBe(false);
    const [message] = (await conversationRequests(c)).slice(mark).filter((request) => request.method === "POST");
    expect(message!.headers.authorization).toBeTruthy();
    const sessions = JSON.parse(await a.stub.poppySql("SELECT label, account, signed_in FROM poppy_sessions ORDER BY label")) as { label: string; account: string | null; signed_in: number }[];
    const main = sessions.find((session) => session.label === "main")!;
    expect(sessions.find((session) => session.label === "main@0.3")).toMatchObject({ account: main.account, signed_in: 1 });
  });

  it("closes a conversation whose versions the Company no longer serves, and sends nothing in other versions", async () => {
    const c = await company({ protocolVersion: "0.3", keepsConversationVersions: true });
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    await c.stub.configure({ protocolVersion: "0.4", linkedVersion: null });
    await a.stub.poppySql("UPDATE poppy_domains SET expires_at = 0");
    const mark = (await conversationRequests(c)).length;
    const refused = await tool(a, "poppy_message", { domain: c.domain, conversation: first.conversationId, text: "and another thing" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no longer serves, so it can't continue");
    // A read already under way may still be answered version_unsupported; no message goes.
    expect((await conversationRequests(c)).slice(mark).filter((request) => request.method === "POST")).toEqual([]);
    const [row] = JSON.parse(await a.stub.poppySql(`SELECT status FROM poppy_conversations WHERE id = '${first.conversationId}'`)) as { status: string }[];
    expect(row!.status).toBe("closed");
  });
});

describe("0.4: poppy:browser-sign-in (6)", () => {
  const authorizations = async (c: Company) => (await requests(c)).filter((request) => new URL(request.url).pathname === "/poppy/browser-session/authorize");
  const open = (a: Agent, c: Company, url: string) => tool(a, "poppy_browse", { domain: c.domain, action: "open", url });

  it("joins the browser signed out when the sign-in lacks the scope, and says how to sign the website in", async () => {
    const c = await company(V4);
    const a = await agent();
    await signInDirect(a, c, ["orders:read"]);
    const page = await open(a, c, "/orders");
    expect(page.isError, page.text).toBe(false);
    expect(page.text).toContain("Signed out");
    expect(JSON.parse(page.text).note).toContain("poppy:browser-sign-in");
    const sent = await authorizations(c);
    expect(sent.map((request) => [request.status, request.headers.authorization ?? null])).toEqual([[204, null]]);
  });

  it("joins signed in with a sign-in that includes it", async () => {
    const c = await company(V4);
    const a = await agent();
    await signInDirect(a, c, ["orders:read", "poppy:browser-sign-in"]);
    const page = await open(a, c, "/orders");
    expect(page.text).toContain("Signed in as acct_ada");
    expect(JSON.parse(page.text)).not.toHaveProperty("note");
    const sent = await authorizations(c);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.authorization).toBeTruthy();
  });

  it("authorizes the same code again without the token when the Company refuses it for insufficient_scope", async () => {
    const c = await company(V4);
    const a = await agent();
    await signInDirect(a, c, ["orders:read"]);
    // The agent believes it holds the scope; the token doesn't.
    await a.stub.poppySql("UPDATE poppy_sessions SET scope = scope || ' poppy:browser-sign-in'");
    const page = await open(a, c, "/orders");
    expect(page.isError, page.text).toBe(false);
    expect(page.text).toContain("Signed out");
    const attempts = await authorizations(c);
    expect(attempts.map((request) => [request.status, !!request.headers.authorization])).toEqual([[403, true], [204, false]]);
    const codes = (await sent(c)).filter((payload) => payload.url.endsWith("/poppy/browser-session/authorize")).map((payload) => (payload.json as { code: string }).code);
    expect(codes).toHaveLength(2);
    expect(codes[1]).toBe(codes[0]);
  });

  it("never requests it from a Company without browser join", async () => {
    const c = await company({ ...V4, browserSession: false });
    const a = await agent();
    const refused = await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read", "poppy:browser-sign-in"], reason: "to see orders" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("no browser join");
  });

  it("reads web.unscoped before the scope is requested, and tells the model and the User what it gives", async () => {
    const c = await company({ ...V4, webUnscoped: true });
    const a = await agent();
    const found = JSON.parse((await tool(a, "poppy_discover", { domain: c.domain })).text);
    expect(found.website).toContain("gives everything the account can do there");
    await tool(a, "poppy_sign_in", { domain: c.domain, scopes: ["orders:read", "poppy:browser-sign-in"], reason: "to change the address on the website" });
    const card = (await cards(a)).find((item) => item.kind === "signin_link");
    expect(JSON.stringify(card)).toContain("On the website: anything your account can do there");
  });
});

describe("0.4: what a message took into account (8.4)", () => {
  it("sends the last cursor it handled on its messages, and reads as_of_request as a hint about the reply", async () => {
    const c = await company(V4);
    const a = await agent();
    const first = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, text: "hello" })).text);
    const id = first.conversationId as string;
    await a.stub.poppyReadNow(id);
    const cursor = (JSON.parse(await a.stub.poppySql(`SELECT cursor FROM poppy_conversations WHERE id = '${id}'`)) as { cursor: string }[])[0]!.cursor;
    expect(cursor).toBeTruthy();
    const second = JSON.parse((await tool(a, "poppy_message", { domain: c.domain, conversation: id, text: "hello again" })).text);
    const posts = (await sent(c)).map((payload) => payload.json as { id?: string; message?: { as_of_cursor?: string } } | undefined).filter((body) => body?.message);
    // The first message had read nothing; the second names the cursor it had handled.
    expect(posts.map((body) => body!.message!.as_of_cursor ?? null)).toEqual([null, cursor]);
    await a.stub.poppyReadNow(id);
    const inbox = (JSON.parse(await a.stub.poppySql(`SELECT event FROM poppy_inbox WHERE conversation_id = '${id}' ORDER BY seq`)) as { event: string }[])
      .map(({ event }) => (JSON.parse(event) as { message?: { role: string; as_of_request?: string } }).message)
      .filter((message) => message?.role === "company");
    expect(second.messageId).toBe(posts[1]!.id);
    expect(inbox.map((message) => message!.as_of_request)).toEqual([posts[0]!.id, posts[1]!.id]);
    await a.stub.poppyWaitForNotice("took into account your latest message");
  });
});
