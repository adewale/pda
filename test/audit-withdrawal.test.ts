import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { decideLocal } from "../src/poppy/operations";
import { EndpointRequest } from "../src/poppy/outgoing";
import { signOut } from "../src/poppy/signout";
import { agent, cards, company, requests, signInDirect, tool, type Agent, type Company } from "./agent-helpers";

/**
 * An approval is the User's for one account in one Session (Ops 3, "Who can
 * approve it"; the stored binding in src/poppy/apis.ts). Withdrawing that
 * authority by signing out wins over an approval not yet sent: before the
 * decision, while its token is being prepared, and before an automatic
 * DPoP nonce retry. Nothing is sent once it is withdrawn.
 */

const exchange = (c: Company) => ({ domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });

/** The task request returned the Company's terms, still awaiting the User (Ops 4). */
async function terms(a: Agent, c: Company): Promise<Record<string, any>> {
  expect((await tool(a, "poppy_api_call", exchange(c))).isError).toBe(false);
  const card = (await cards(a)).find((item) => item.kind === "approval" && item.open && item.terms)!;
  expect(card).toMatchObject({ status: "pending" });
  return card;
}

/** Requests that carried the User's approval to the Company. */
const approvals = async (c: Company) => (await requests(c)).filter((request) => request.headers["poppy-approval"]);

describe("approval authorization and withdrawal", () => {
  it("reports changing local authority rather than a Company refusal when preparation exhausts its attempts", async () => {
    const a = await agent();
    const c = await company();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const token = vi.spyOn(client, "token").mockImplementation(async () => {
        client.abandonSession(C.issuer, "main");
        client.sessionFor(C, "main");
        return null;
      });
      const remote = vi.spyOn(client.host, "fetcher");
      try {
        await expect(client.resource(C, EndpointRequest.to(C, {
          method: "POST", url: C.conversations!.endpoint, body: { message: { id: "not-sent", text: "Hello" } }
        }))).rejects.toMatchObject({ code: "approval_changed", message: expect.stringContaining("Session") });
        expect(token).toHaveBeenCalledTimes(4);
        expect(remote).not.toHaveBeenCalled();
      } finally { token.mockRestore(); remote.mockRestore(); }
    });
  });

  it("never sends an approval the User gives after signing out of the account it was for; asked again, its terms wait for a fresh decision", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    const card = await terms(a, c);
    await a.stub.poppyFrame({ type: "poppy.signout", issuer: c.hosts.issuer, account: "default" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect((await cards(a)).find((item) => item.approvalId === card.approvalId)).toMatchObject({
      open: false,
      status: "failed",
      result: expect.stringContaining("[approval_changed]")
    });
    expect(await approvals(c)).toEqual([]);
    expect((await c.stub.state()).performs).toBe(0);
    // Approving it again sends nothing: it was decided.
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: card.approvalId, decision: "approve" });
    expect(await approvals(c)).toEqual([]);

    // Signed in again, the User asks afresh. The Company answers with the same unexpired revision (Ops 4),
    // so its card, one per revision, waits again, now for the new request; approved, it goes once.
    await signInDirect(a, c);
    const fresh = await terms(a, c);
    expect(fresh).toMatchObject({ approvalId: card.approvalId, open: true, status: "pending" });
    await a.stub.poppyFrame({ type: "poppy.approval", approvalId: fresh.approvalId, decision: "approve" });
    expect((await c.stub.state()).performs).toBe(1);
    expect(await approvals(c)).toHaveLength(1);
  });

  it("does not dispatch an approval after sign-out while its token preparation is suspended", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    const card = await terms(a, c);
    await runInDurableObject(a.stub, async (instance) => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const heldToken = await client.token(C, { label: "main" });
      expect(heldToken).not.toBeNull();
      let releaseToken!: () => void;
      let tokenStarted!: () => void;
      const started = new Promise<void>((resolve) => { tokenStarted = resolve; });
      const wait = new Promise<void>((resolve) => { releaseToken = resolve; });
      const token = vi.spyOn(client, "token").mockImplementationOnce(async () => { tokenStarted(); await wait; return heldToken; });
      try {
        const pending = decideLocal(client, card.approvalId, "approve");
        await started;
        await signOut(client, C.issuer, "default");
        releaseToken();
        await pending;
      } finally {
        releaseToken(); token.mockRestore(); notified.mockRestore();
      }
    });
    expect(await approvals(c)).toEqual([]);
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find((item) => item.approvalId === card.approvalId)).toMatchObject({ open: false, status: "failed", result: expect.stringContaining("[approval_changed]") });
  });

  it("rechecks withdrawn authority before an automatic DPoP nonce retry", async () => {
    const a = await agent();
    const c = await company({ dpopTokens: true });
    await signInDirect(a, c);
    const card = await terms(a, c);
    const sent: string[] = [];
    await runInDurableObject(a.stub, async (instance) => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      let releaseResponse!: (response: Response) => void;
      let requestStarted!: () => void;
      const started = new Promise<void>((resolve) => { requestStarted = resolve; });
      const originalFetch = client.host.fetcher;
      // The approved request reaches a stand-in for the Company, which asks for a nonce once the User has signed out.
      const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async (request) => {
        if (request.url.endsWith("/exchanges") && request.headers.get("Poppy-Approval")) {
          sent.push(request.url);
          requestStarted();
          return new Promise<Response>((resolve) => { releaseResponse = resolve; });
        }
        return originalFetch(request);
      });
      try {
        const pending = decideLocal(client, card.approvalId, "approve");
        await started;
        await signOut(client, C.issuer, "default");
        releaseResponse(Response.json({ error: "use_dpop_nonce" }, { status: 401, headers: { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"', "DPoP-Nonce": "nonce-audit" } }));
        await pending;
      } finally {
        remote.mockRestore(); notified.mockRestore();
      }
    });
    // Sent once, and not again with the nonce: the authority it was sent under is gone.
    expect(sent).toHaveLength(1);
    expect(await approvals(c)).toEqual([]);
    expect((await c.stub.state()).performs).toBe(0);
    expect((await cards(a)).find((item) => item.approvalId === card.approvalId)).toMatchObject({ open: false, status: "failed", result: expect.stringContaining("[approval_changed]") });
  });
});
