import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decideLocal } from "../src/poppy/operations";
import { signOut } from "../src/poppy/signout";
import { agent, cards, company, requests, signInDirect, tool, until, type Agent, type Company } from "./agent-helpers";

/** A Company Agent's operation, waiting for a decision in the signed-in Session. */
async function terms(a: Agent, c: Company) {
  await signInDirect(a, c);
  expect((await tool(a, "poppy_message", { domain: c.domain, text: "Please exchange the jacket on my order" })).isError).toBe(false);
  return until(async () => (await cards(a)).find(card => card.kind === "approval" && card.open));
}

const messagePosts = (all: Awaited<ReturnType<typeof requests>>) =>
  all.filter(request => request.method === "POST" && request.url.includes("/conversations/"));

describe("conversation approval authority", () => {
  it("sends a bound conversation approval while its account and Session still match", async () => {
    const c = await company();
    const a = await agent();
    const card = await terms(a, c);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    // A message acknowledgement confirms delivery, not the later Company's action.
    expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "unknown", open: false, result: expect.stringContaining("message was accepted") });
  });

  it("refuses a conversation approval after signing out, before sending its message", async () => {
    const c = await company();
    const a = await agent();
    const card = await terms(a, c);
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    const before = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect(messagePosts((await requests(c)).slice(before))).toEqual([]);
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "failed", result: expect.stringContaining("[approval_changed]") });
  });

  it("keeps a conversation approval withdrawn after signing back in to the same account and Session", async () => {
    const c = await company();
    const a = await agent();
    const card = await terms(a, c);
    const sid = await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer);
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await signInDirect(a, c);
    expect(await a.stub.poppySql("SELECT session_id FROM poppy_sessions WHERE issuer = ? AND label = 'main'", c.hosts.issuer)).toBe(sid);
    const before = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect(messagePosts((await requests(c)).slice(before))).toEqual([]);
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "failed", result: expect.stringContaining("[approval_changed]") });
  });

  it("accepts an older binding without a generation only before any sign-out", async () => {
    const c = await company();
    const a = await agent();
    const card = await terms(a, c);
    await a.stub.poppySql("UPDATE poppy_approvals SET request = json_remove(request, '$.binding.authorityGeneration') WHERE id = ?", card.approvalId);
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
  });

  it("refuses an older conversation approval that has no account and Session binding", async () => {
    const c = await company();
    const a = await agent();
    const card = await terms(a, c);
    await a.stub.poppySql("UPDATE poppy_approvals SET request = json_remove(request, '$.binding') WHERE id = ?", card.approvalId);
    const before = (await requests(c)).length;
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect(messagePosts((await requests(c)).slice(before))).toEqual([]);
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "failed", result: expect.stringContaining("can't be sent") });
  });

  it("does not send a conversation approval after sign-out during Session-header signing", async () => {
    // Revocation may fail at the Company. Local withdrawal must still prevent use of its valid access token.
    const c = await company({ refuseRevocations: 1 });
    const a = await agent();
    const card = await terms(a, c);
    const sent: string[] = [];
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const originalFetch = client.host.fetcher;
      const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
        if (request.method === "POST" && request.url.includes("/conversations/")) sent.push(request.url);
        return originalFetch(request);
      });
      let release!: () => void;
      let signingStarted!: () => void;
      const started = new Promise<void>(resolve => { signingStarted = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      const originalHeader = client.sessionHeader.bind(client);
      const header = vi.spyOn(client, "sessionHeader").mockImplementation(async (...args) => {
        if (args[2].method === "POST" && args[2].url.includes("/conversations/")) {
          signingStarted();
          await wait;
        }
        return originalHeader(...args);
      });
      try {
        const pending = decideLocal(client, card.approvalId, "approve");
        await started;
        expect(sent).toEqual([]);
        await signOut(client, C.issuer, "default");
        expect(client.session(C.issuer, "main")?.signed_in).toBe(0);
        expect(sent).toEqual([]);
        release();
        await pending;
      } finally {
        release(); header.mockRestore(); remote.mockRestore(); notified.mockRestore();
      }
    });
    expect(sent).toEqual([]);
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "failed", result: expect.stringContaining("[approval_changed]") });
  });

  it("rechecks conversation approval authority before a DPoP nonce retry", async () => {
    const c = await company({ dpopTokens: true });
    const a = await agent();
    const card = await terms(a, c);
    const sent: string[] = [];
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      let release!: (response: Response) => void;
      let requestStarted!: () => void;
      const started = new Promise<void>(resolve => { requestStarted = resolve; });
      const originalFetch = client.host.fetcher;
      const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
        if (request.method === "POST" && request.url.includes("/conversations/")) {
          sent.push(request.url);
          requestStarted();
          if (sent.length > 1) return Response.json({ error: "insufficient_scope" }, { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' } });
          return new Promise<Response>(resolve => { release = resolve; });
        }
        return originalFetch(request);
      });
      try {
        const pending = decideLocal(client, card.approvalId, "approve");
        await started;
        await signOut(client, C.issuer, "default");
        release(Response.json({ error: "use_dpop_nonce" }, { status: 401, headers: { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"', "DPoP-Nonce": "conversation-audit-nonce" } }));
        await pending;
      } finally {
        remote.mockRestore(); notified.mockRestore();
      }
    });
    expect(sent).toHaveLength(1);
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "failed", result: expect.stringContaining("[approval_changed]") });
  });
});
