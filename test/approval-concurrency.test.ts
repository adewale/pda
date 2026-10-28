import { expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { decideLocal } from "../src/poppy/operations";
import { agent, cards, company, signInDirect, tool } from "./agent-helpers";

it("concurrent decisions of one pending write dispatch at most once after discovery expiry", async () => {
  const c = await company({ operations: false, exchangeTakesIdempotencyKey: false });
  const a = await agent();
  await signInDirect(a, c);
  const proposed = await tool(a, "poppy_api_call", {
    domain: c.domain,
    operation: "POST /orders/{order_id}/exchanges",
    params: { order_id: "ord_7Hk2" },
    body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
  });
  expect(proposed.text).toContain("Waiting for the User's approval");
  const card = (await cards(a)).find(item => item.kind === "approval" && item.open)!;
  await a.stub.poppySql("UPDATE poppy_domains SET expires_at = 0");
  const decision = { type: "poppy.approval", approvalId: card.approvalId, decision: "approve" };
  await Promise.all([a.stub.poppyFrame(decision), a.stub.poppyFrame(decision)]);
  const state = await c.stub.state();
  expect(state.performs).toBe(1);
  expect((await a.stub.poppyNotices()).filter(text => text.includes("Done, as the User approved"))).toHaveLength(1);
});

it("concurrent decision handlers claim an approval before asynchronous work", async () => {
  const c = await company({ operations: false, exchangeTakesIdempotencyKey: false });
  const a = await agent();
  await signInDirect(a, c);
  await tool(a, "poppy_api_call", {
    domain: c.domain,
    operation: "POST /orders/{order_id}/exchanges",
    params: { order_id: "ord_7Hk2" },
    body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
  });
  const card = (await cards(a)).find(item => item.kind === "approval" && item.open)!;
  await runInDurableObject(a.stub, async instance => {
    await Promise.all([
      decideLocal(instance.poppy.client, card.approvalId, "approve"),
      decideLocal(instance.poppy.client, card.approvalId, "approve")
    ]);
  });
  expect((await c.stub.state()).performs).toBe(1);
});

for (const first of ["approve", "decline"] as const) {
  it(`keeps the first ${first} decision when approval and decline overlap`, async () => {
    const c = await company({ operations: false, exchangeTakesIdempotencyKey: false });
    const a = await agent();
    await signInDirect(a, c);
    await tool(a, "poppy_api_call", {
      domain: c.domain,
      operation: "POST /orders/{order_id}/exchanges",
      params: { order_id: "ord_7Hk2" },
      body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
    });
    const card = (await cards(a)).find(item => item.kind === "approval" && item.open)!;
    await runInDurableObject(a.stub, async instance => {
      await Promise.all([
        decideLocal(instance.poppy.client, card.approvalId, first),
        decideLocal(instance.poppy.client, card.approvalId, first === "approve" ? "decline" : "approve")
      ]);
    });
    expect((await c.stub.state()).performs).toBe(first === "approve" ? 1 : 0);
    expect((await cards(a)).find(item => item.id === card.id)).toMatchObject({ status: first === "approve" ? "done" : "declined" });
    expect((await a.stub.poppyNotices()).filter(text => text.includes(card.summary))).toHaveLength(1);
  });
}
