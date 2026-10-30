import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { saveAttachment } from "../src/attachments";
import { decideLocal, decideLocalBatch, proposeLocal, recoverApprovalBatches, recoverInterruptedApprovals, resolveApprovalOutcome } from "../src/poppy/operations";
import { migrate } from "../src/poppy/store";
import { agent, cards, company, requests, tool } from "./agent-helpers";

const photoPosts = (all: Awaited<ReturnType<typeof requests>>) => all.filter(request => request.method === "POST" && new URL(request.url).pathname === "/photos");

async function waitingPhotos(a: Awaited<ReturnType<typeof agent>>, c: Awaited<ReturnType<typeof company>>) {
  const photos = await runInDurableObject(a.stub, async instance => [1, 2].map(index => {
    const bytes = new Uint8Array(1000).fill(index);
    bytes.set([0xff, 0xd8, 0xff]);
    return saveAttachment(instance.poppy.client.sql, { name: `photo${index}.jpg`, bytes });
  }));
  for (const [index, photo] of photos.entries()) await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: photo.id } }, `batch-photo-${index}`);
  const waiting = (await cards(a)).filter(card => card.kind === "approval" && card.open);
  expect(waiting).toHaveLength(2);
  return waiting;
}

describe("durable batch approval notifications", () => {
  it("does not report a combined decision when single handlers claim every intended batch member", async () => {
    const a = await agent();
    const c = await company({ printShop: true });
    const waiting = await waitingPhotos(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      let reached!: () => void, release!: () => void;
      const paused = new Promise<void>(resolve => { reached = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      const original = client.resumeCompany.bind(client);
      let holdOnce = true;
      const discovery = vi.spyOn(client, "resumeCompany").mockImplementation(async (...args) => {
        if (holdOnce && args[1] === "approval") { holdOnce = false; reached(); await resumed; }
        return original(...args);
      });
      const notices: { text: string; id: string }[] = [];
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => { notices.push({ text, id }); });
      const batch = decideLocalBatch(client, waiting.map(card => ({ approvalId: card.approvalId, decision: "approve" })));
      try {
        await paused;
        for (const card of waiting) await decideLocal(client, card.approvalId, "approve");
        release();
        await batch;
        expect(notices).toHaveLength(2);
        expect(notices.every(notice => notice.id.startsWith("poppy-approval-"))).toBe(true);
        expect(client.sql.exec("SELECT ids, told FROM poppy_approval_batches").toArray()).toEqual([{ ids: "[]", told: 1 }]);
      } finally { release(); await Promise.allSettled([batch]); discovery.mockRestore(); notify.mockRestore(); }
    });
    expect(photoPosts(await requests(c))).toHaveLength(2);
  });

  it("recovers claimed batch members when its compatibility snapshot was not written", async () => {
    const a = await agent();
    const c = await company({ printShop: true });
    const waiting = await waitingPhotos(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const notices: { text: string; id: string }[] = [];
      let failOnce = true;
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => {
        if (failOnce) { failOnce = false; throw new Error("batch not delivered"); }
        notices.push({ text, id });
      });
      try {
        await expect(decideLocalBatch(client, waiting.map(card => ({ approvalId: card.approvalId, decision: "decline" })))).rejects.toThrow("batch not delivered");
        // The durable ownership claims survive even at a death before the IDs/payload snapshots.
        client.sql.exec("UPDATE poppy_approval_batches SET ids = '[]', notification = NULL");
        await recoverInterruptedApprovals(client);
        expect(notices).toEqual([]);
        await recoverApprovalBatches(client);
        expect(notices).toHaveLength(1);
        expect(notices[0].id).toMatch(/^poppy-approvals-/);
        for (const name of ["photo1.jpg", "photo2.jpg"]) expect(notices[0].text).toContain(name);
        expect(client.sql.exec("SELECT notification_pending FROM poppy_approvals").toArray()).toEqual([{ notification_pending: 0 }, { notification_pending: 0 }]);
      } finally { notify.mockRestore(); }
    });
    expect(photoPosts(await requests(c))).toEqual([]);
  });

  it("migrates legacy batches without adopting ambiguous individual notification ownership", async () => {
    const a = await agent();
    const c = await company({ printShop: true });
    const waiting = await waitingPhotos(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const notices: { text: string; id: string }[] = [];
      let failOnce = true;
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => {
        notices.push({ text, id });
        if (failOnce) { failOnce = false; throw new Error("legacy batch acknowledgement lost"); }
      });
      try {
        await expect(decideLocalBatch(client, waiting.map(card => ({ approvalId: card.approvalId, decision: "decline" })))).rejects.toThrow("legacy batch acknowledgement lost");
        const first = notices[0];
        client.sql.exec("DROP INDEX poppy_approvals_notification_batch");
        client.sql.exec("ALTER TABLE poppy_approvals DROP COLUMN notification_batch_id");
        migrate(client.sql);
        migrate(client.sql);
        expect(client.sql.exec("SELECT notification_batch_id FROM poppy_approvals").toArray()).toEqual([{ notification_batch_id: null }, { notification_batch_id: null }]);
        // An old intent snapshot cannot prove which handler owned a pending decision.
        await recoverInterruptedApprovals(client);
        expect(notices.filter(notice => notice.id.startsWith("poppy-approval-"))).toHaveLength(2);
        await recoverApprovalBatches(client);
        expect(notices.filter(notice => notice.id.startsWith("poppy-approvals-"))).toEqual([first, first]);
        expect(client.sql.exec("SELECT notification_pending FROM poppy_approvals").toArray()).toEqual([{ notification_pending: 0 }, { notification_pending: 0 }]);
        await recoverInterruptedApprovals(client);
        await recoverApprovalBatches(client);
        expect(notices).toHaveLength(4);
      } finally { notify.mockRestore(); }
    });
    expect(photoPosts(await requests(c))).toEqual([]);
  });

  it("retries the same exact batch payload even when recovery would format declined items differently", async () => {
    const a = await agent();
    const c = await company({ printShop: true });
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const api = C.apis.find(item => item.type === "openapi")!;
      await client.token(C, { label: "main" });
      const session = client.session(C.issuer, "main")!;
      const ids = [];
      for (const index of [1, 2]) ids.push(await proposeLocal(client, C, "main", `Photo ${index}`, {
        kind: "openapi", method: "POST", url: `${c.hosts.api}/photos`,
        binding: { account: session.account, sessionId: session.session_id, authorityGeneration: session.authority_generation },
        call: { apiUrl: api.url, operation: "uploadPhoto", params: {}, files: { photo: `unsent_${index}` } },
        attachments: [{ id: `unsent_${index}`, name: `photo${index}.jpg`, type: "image/jpeg", size: 10 }]
      }));
      const seen: { text: string; id: string }[] = [];
      let first = true;
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => {
        seen.push({ text, id });
        if (first) { first = false; throw new Error("Batch callback acknowledgement lost"); }
      });
      try {
        await expect(decideLocalBatch(client, ids.map(approvalId => ({ approvalId, decision: "decline" })))).rejects.toThrow("Batch callback acknowledgement lost");
        await recoverApprovalBatches(client);
        expect(seen).toHaveLength(2);
        expect(seen[1]).toEqual(seen[0]);
        await recoverApprovalBatches(client);
        expect(seen).toHaveLength(2);
      } finally { notify.mockRestore(); }
    });
    expect(photoPosts(await requests(c))).toEqual([]);
    expect((await c.stub.state()).performs).toBe(0);
  });

  it("preserves the original batch notice across a later User reconciliation without resending either upload", async () => {
    const a = await agent();
    const c = await company({ printShop: true });
    const waiting = await waitingPhotos(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const originalFetch = client.host.fetcher;
      let uploads = 0;
      const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
        const response = await originalFetch(request);
        if (request.method === "POST" && new URL(request.url).pathname === "/photos") {
          uploads++;
          await response.body?.cancel();
          throw new Error("Upload response lost after Company accepted it");
        }
        return response;
      });
      const batchCalls: { text: string; id: string }[] = [];
      let first = true;
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => {
        if (!id.startsWith("poppy-approvals-")) return;
        batchCalls.push({ text, id });
        if (first) { first = false; throw new Error("Batch callback acknowledgement lost"); }
      });
      try {
        await expect(decideLocalBatch(client, waiting.map(card => ({ approvalId: card.approvalId, decision: "approve" })))).rejects.toThrow("Batch callback acknowledgement lost");
        expect(uploads).toBe(1);
        const unknown = client.sql.exec("SELECT id FROM poppy_approvals WHERE status = 'unknown'").toArray()[0];
        expect(unknown?.id).toBe(waiting[0]!.approvalId);
        await resolveApprovalOutcome(client, String(unknown!.id), "performed");
        expect(client.sql.exec("SELECT outcome_resolution FROM poppy_approvals WHERE id = ?", unknown!.id).toArray()).toEqual([{ outcome_resolution: "performed" }]);
        await recoverApprovalBatches(client);
        expect(batchCalls).toHaveLength(2);
        expect(batchCalls[1]).toEqual(batchCalls[0]);
        expect(uploads).toBe(1);
        await recoverApprovalBatches(client);
        expect(batchCalls).toHaveLength(2);
      } finally { notify.mockRestore(); remote.mockRestore(); }
    });
    expect(photoPosts(await requests(c))).toHaveLength(1);
    expect((await c.stub.state()).performs).toBe(0);
  });
  it("repairs a committed upload receipt before acknowledging the batch after a card-write failure", async () => {
    const a = await agent();
    const c = await company({ printShop: true });
    const waiting = await waitingPhotos(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const original = client.host.showCard;
      let failOnce = true;
      const receipts = vi.spyOn(client.host, "showCard").mockImplementation(async (...args) => {
        if (failOnce && args[0].kind === "approval" && args[0].status === "done") {
          failOnce = false;
          throw new Error("Receipt write interrupted after upload committed");
        }
        return original(...args);
      });
      const notices: { text: string; id: string }[] = [];
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => { notices.push({ text, id }); });
      try {
        await decideLocalBatch(client, waiting.map(card => ({ approvalId: card.approvalId, decision: "approve" })));
        expect(notices).toHaveLength(1);
        expect(notices[0]!.text).toContain("Done, as the User approved");
        expect(notices[0]!.text).not.toContain("couldn't be decided");
        expect(client.sql.exec("SELECT status, notification_pending FROM poppy_approvals ORDER BY created_at").toArray()).toEqual([{ status: "done", notification_pending: 0 }, { status: "done", notification_pending: 0 }]);
      } finally { receipts.mockRestore(); notify.mockRestore(); }
    });
    for (const card of waiting) expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "done", open: false });
    expect(photoPosts(await requests(c))).toHaveLength(2);
    expect(photoPosts(await requests(c)).every(request => request.status === 201)).toBe(true);
    await a.stub.poppyRestart();
    for (const card of waiting) expect((await cards(a)).find(item => item.approvalId === card.approvalId)).toMatchObject({ status: "done", open: false });
    await a.stub.poppyFrame({ type: "poppy.approvals", decisions: waiting.map(card => ({ approvalId: card.approvalId, decision: "approve" })) });
    expect(photoPosts(await requests(c))).toHaveLength(2);
  });

});
