import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { saveAttachment } from "../src/attachments";
import { decideLocal, decideLocalBatch, recoverApprovalBatches, recoverInterruptedApprovals } from "../src/poppy/operations";
import { agent, cards, company, requests, tool } from "./agent-helpers";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function waitingPhotos() {
  const a = await agent();
  const c = await company({ printShop: true });
  const photos = await runInDurableObject(a.stub, async instance => [1, 2].map(index => {
    const bytes = new Uint8Array(1000).fill(index);
    bytes.set([0xff, 0xd8, 0xff]);
    return saveAttachment(instance.poppy.client.sql, { name: `photo${index}.jpg`, bytes });
  }));
  for (const [index, photo] of photos.entries()) await tool(a, "poppy_api_call", { domain: c.domain, operation: "uploadPhoto", files: { photo: photo.id } }, `notice-race-photo-${index}`);
  const waiting = (await cards(a)).filter(card => card.kind === "approval" && card.open);
  expect(waiting).toHaveLength(2);
  return { a, c, waiting };
}

const photoPosts = (all: Awaited<ReturnType<typeof requests>>) => all.filter(request => request.method === "POST" && new URL(request.url).pathname === "/photos");

describe("batch notifications belong only to the decisions the batch claimed", () => {
  it("keeps a concurrent single decision's pending notice when a batch skips that decision", async () => {
    const { a, c, waiting } = await waitingPhotos();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const batchPaused = gate(), resumeBatch = gate(), singlePaused = gate(), resumeSingle = gate();
      const resume = client.resumeCompany.bind(client);
      let holdResume = true;
      const discovery = vi.spyOn(client, "resumeCompany").mockImplementation(async (...args) => {
        if (holdResume && args[1] === "approval" && args[2] === waiting[0].approvalId) {
          holdResume = false; batchPaused.release(); await resumeBatch.promise;
        }
        return resume(...args);
      });
      const fetch = client.host.fetcher;
      let holdUpload = true;
      const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
        if (holdUpload && request.method === "POST" && new URL(request.url).pathname === "/photos") {
          holdUpload = false; singlePaused.release(); await resumeSingle.promise;
        }
        return fetch(request);
      });
      const notices: { text: string; id: string }[] = [];
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => { notices.push({ text, id }); });
      const pending: Promise<unknown>[] = [];
      try {
        const batch = decideLocalBatch(client, waiting.map(card => ({ approvalId: card.approvalId, decision: "approve" })));
        pending.push(batch);
        await batchPaused.promise;
        const single = decideLocal(client, waiting[0].approvalId, "approve");
        pending.push(single);
        await singlePaused.promise;
        resumeBatch.release();
        await batch;
        expect(notices).toHaveLength(1);
        expect(notices[0].text).toContain("photo2.jpg");
        expect(notices[0].text).not.toContain("photo1.jpg");
        expect(client.sql.exec("SELECT status, notification_pending FROM poppy_approvals WHERE id = ?", waiting[0].approvalId).one())
          .toEqual({ status: "executing", notification_pending: 1 });
        resumeSingle.release();
        await single;
        expect(notices).toHaveLength(2);
        expect(notices[1].text).toContain("photo1.jpg");
        expect(notices[1].id).not.toBe(notices[0].id);
      } finally {
        resumeBatch.release(); resumeSingle.release(); await Promise.allSettled(pending);
        discovery.mockRestore(); remote.mockRestore(); notify.mockRestore();
      }
    });
    expect(photoPosts(await requests(c))).toHaveLength(2);
  });

  it("retains a completed single decision's failed notification while another batch acknowledges its own work", async () => {
    const { a, c, waiting } = await waitingPhotos();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const batchPaused = gate(), resumeBatch = gate();
      const resume = client.resumeCompany.bind(client);
      let holdResume = true;
      const discovery = vi.spyOn(client, "resumeCompany").mockImplementation(async (...args) => {
        if (holdResume && args[1] === "approval" && args[2] === waiting[0].approvalId) {
          holdResume = false; batchPaused.release(); await resumeBatch.promise;
        }
        return resume(...args);
      });
      const singleNotices: { text: string; id: string }[] = [], batchNotices: { text: string; id: string }[] = [];
      let failOnce = true;
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => {
        if (id.startsWith(`poppy-approval-${waiting[0].approvalId}-`)) {
          singleNotices.push({ text, id });
          if (failOnce) { failOnce = false; throw new Error("single notice acknowledgement lost"); }
        } else batchNotices.push({ text, id });
      });
      const pending: Promise<unknown>[] = [];
      try {
        const batch = decideLocalBatch(client, waiting.map(card => ({ approvalId: card.approvalId, decision: "approve" })));
        pending.push(batch);
        await batchPaused.promise;
        await expect(decideLocal(client, waiting[0].approvalId, "approve")).rejects.toThrow("single notice acknowledgement lost");
        expect(singleNotices).toHaveLength(1);
        resumeBatch.release();
        await batch;
        expect(batchNotices).toHaveLength(1);
        expect(batchNotices[0].text).not.toContain("photo1.jpg");
        expect(client.sql.exec("SELECT status, notification_pending FROM poppy_approvals WHERE id = ?", waiting[0].approvalId).one())
          .toEqual({ status: "done", notification_pending: 1 });
        await recoverInterruptedApprovals(client);
        expect(singleNotices).toHaveLength(2);
        expect(singleNotices[1]).toEqual(singleNotices[0]);
        await recoverInterruptedApprovals(client);
        await recoverApprovalBatches(client);
        expect(singleNotices).toHaveLength(2);
        expect(batchNotices).toHaveLength(1);
      } finally {
        resumeBatch.release(); await Promise.allSettled(pending);
        discovery.mockRestore(); notify.mockRestore();
      }
    });
    expect(photoPosts(await requests(c))).toHaveLength(2);
  });

  it("recovers a batch-owned callback once without sending individual notices or repeating uploads", async () => {
    const { a, c, waiting } = await waitingPhotos();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const notices: { text: string; id: string }[] = [];
      let failOnce = true;
      const notify = vi.spyOn(client.host, "notifyModel").mockImplementation(async (text, id) => {
        notices.push({ text, id });
        if (failOnce) { failOnce = false; throw new Error("batch notice acknowledgement lost"); }
      });
      try {
        await expect(decideLocalBatch(client, waiting.map(card => ({ approvalId: card.approvalId, decision: "approve" })))).rejects.toThrow("batch notice acknowledgement lost");
        expect(notices).toHaveLength(1);
        await recoverInterruptedApprovals(client);
        expect(notices).toHaveLength(1);
        await recoverApprovalBatches(client);
        expect(notices).toHaveLength(2);
        expect(notices[1]).toEqual(notices[0]);
        expect(notices[0].id).toMatch(/^poppy-approvals-/);
        await recoverInterruptedApprovals(client);
        await recoverApprovalBatches(client);
        expect(notices).toHaveLength(2);
      } finally { notify.mockRestore(); }
    });
    const sent = photoPosts(await requests(c));
    expect(sent).toHaveLength(2);
    await a.stub.poppyRestart();
    expect(photoPosts(await requests(c))).toEqual(sent);
  });
});
