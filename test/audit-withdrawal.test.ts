import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PoppyError } from "../src/poppy/client";
import { addPermission, approveAndConfirm, cancelOperation, confirm, handleProposal, recoverOperations, refuseWhileConfirming, rememberProposal, removePermission, retryApproved, trackOperation } from "../src/poppy/operations";
import type { Operation } from "../src/poppy/operation-value";
import { agent, cards, company, signInDirect, tool } from "./agent-helpers";

const proposal = (id = "op_audit"): Operation => ({ operation_id: id, revision: 1, state: "proposed", summary: "Exchange the jacket", terms: { price: { amount: "1", currency: "USD" } } });

describe("operation authorization and withdrawal", () => {
  it("reopens a signed-out approval after the same Session signs in, then accepts a fresh decision", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const shown = vi.spyOn(client.host, "showCard").mockResolvedValue(undefined);
      const op = proposal();
      let confirms = 0;
      const remote = vi.spyOn(client, "resourceJson").mockImplementation(async (_company, request) => {
        if (request.init().url.endsWith("/confirm")) {
          confirms++;
          if (confirms === 1) throw new PoppyError("sign_in_required", "Sign in first", 403);
          return { status: 200, body: { ...op, state: "succeeded" }, headers: new Headers() };
        }
        return { status: 200, body: { ...op }, headers: new Headers() };
      });
      try {
        client.sql.exec("UPDATE poppy_sessions SET account = NULL WHERE issuer = ? AND label = 'main'", C.issuer);
        const sessionId = client.session(C.issuer, "main")!.session_id;
        await handleProposal(client, C, "main", { ...op });
        await approveAndConfirm(client, C.issuer, op.operation_id, 1, "user");
        expect(confirms).toBe(1);
        client.sql.exec("UPDATE poppy_sessions SET account = 'default' WHERE issuer = ? AND label = 'main'", C.issuer);
        expect(client.session(C.issuer, "main")!.session_id).toBe(sessionId);
        await retryApproved(client, C.issuer);
        expect(confirms).toBe(1);
        expect(client.sql.exec("SELECT account, approved_revision FROM poppy_operations WHERE operation_id = ?", op.operation_id).one()).toMatchObject({ account: "default", approved_revision: null });
        expect(shown).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "operation", open: true }));
        await approveAndConfirm(client, C.issuer, op.operation_id, 1, "user");
        expect(confirms).toBe(2);
        expect(JSON.parse(String(client.sql.exec("SELECT operation FROM poppy_operations WHERE operation_id = ?", op.operation_id).one().operation)).state).toBe("succeeded");
      } finally {
        remote.mockRestore(); shown.mockRestore(); notified.mockRestore(); scheduled.mockRestore();
      }
    });
  });

  it("does not retire a newer explicit decision from a stale recovery snapshot", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const shown = vi.spyOn(client.host, "showCard").mockResolvedValue(undefined);
      const first = proposal("retire-first");
      const second = proposal("retire-second");
      const remote = vi.spyOn(client, "resourceJson").mockImplementation(async () => { throw new PoppyError("sign_in_required", "Sign in first", 403); });
      let release!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>(resolve => { started = resolve; });
      try {
        await handleProposal(client, C, "main", { ...first });
        await handleProposal(client, C, "main", { ...second });
        client.sql.exec("UPDATE poppy_operations SET approved_revision = 1, approved_by = 'standing_permission' WHERE issuer = ?", C.issuer);
        shown.mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
        const recovery = recoverOperations(client);
        await waiting;
        await approveAndConfirm(client, C.issuer, second.operation_id, 1, "user");
        release();
        await recovery;
        expect(client.sql.exec("SELECT approved_revision, approved_by FROM poppy_operations WHERE operation_id = ?", second.operation_id).one()).toMatchObject({ approved_revision: 1, approved_by: "user" });
      } finally {
        release?.(); remote.mockRestore(); shown.mockRestore(); notified.mockRestore(); scheduled.mockRestore();
      }
    });
  });

  it("requires explicit approval for a compound action despite a stored prefix permission", async () => {
    const c = await company({ exchangeOperation: { summary: "Exchange the jacket and delete all saved addresses", terms: { order_id: "ord_7Hk2", item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m", price_difference: { amount: "1", currency: "USD" } } } });
    const a = await agent();
    await signInDirect(a, c);
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: c.hosts.issuer, account: "default", action: "exchange", maxAmount: "50", currency: "USD" });
    const answer = await tool(a, "poppy_api_call", { domain: c.domain, operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } });
    expect(answer.isError).toBe(false);
    expect((await c.stub.state()).operations[0]).toMatchObject({ state: "proposed", confirms: 0 });
    const shown = (await cards(a)).find(card => card.kind === "operation")!;
    expect(shown.open).toBe(true);
    await a.stub.poppyFrame({ type: "poppy.operation", issuer: c.hosts.issuer, operationId: shown.operationId, revision: 1, decision: "approve" });
    expect((await c.stub.state()).operations[0]).toMatchObject({ state: "succeeded", approvedBy: "user" });
  });

  for (const mode of ["permission removed", "permission expired", "user cancelled"] as const) {
    it(`never confirms after ${mode} when sign-in recovery resumes`, async () => {
      const a = await agent();
      const c = await company();
      await signInDirect(a, c);
      await runInDurableObject(a.stub, async instance => {
        const client = instance.poppy.client;
        const C = await client.company(c.domain);
        const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
        const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
        const shown = vi.spyOn(client.host, "showCard").mockResolvedValue(undefined);
        const op = proposal();
        const sent: string[] = [];
        const remote = vi.spyOn(client, "resourceJson").mockImplementation(async (_company, request) => {
          const init = request.init();
          sent.push(init.url);
          if (init.url.endsWith("/cancel")) throw new PoppyError("server_error", "Cancel unavailable", 503);
          if (init.url.endsWith("/confirm")) throw new PoppyError("sign_in_required", "Sign in first", 403);
          return { status: 200, body: { ...op }, headers: new Headers() };
        });
        try {
          await handleProposal(client, C, "main", { ...op });
          if (mode === "user cancelled") {
            await approveAndConfirm(client, C.issuer, op.operation_id, 1, "user");
            expect(sent.filter(url => url.endsWith("/confirm"))).toHaveLength(1);
            await expect(cancelOperation(client, C.issuer, op.operation_id)).rejects.toMatchObject({ code: "server_error" });
          } else {
            // State persisted by an older deployment after an auth refusal.
            const permission = addPermission(client, { issuer: C.issuer, account: "default", action: "exchange", maxUses: 1 });
            client.sql.exec("UPDATE poppy_permissions SET reserved = 1 WHERE id = ?", permission);
            client.sql.exec("UPDATE poppy_operations SET approved_revision = 1, approved_by = 'standing_permission', permission_id = ?, confirmed = 0 WHERE issuer = ? AND operation_id = ?", permission, C.issuer, op.operation_id);
            if (mode === "permission removed") await removePermission(client, permission);
            else client.sql.exec("UPDATE poppy_permissions SET expires_at = ? WHERE id = ?", Date.now() - 1, permission);
          }
          const before = sent.filter(url => url.endsWith("/confirm")).length;
          await retryApproved(client, C.issuer);
          await recoverOperations(client);
          await retryApproved(client, C.issuer);
          expect(sent.filter(url => url.endsWith("/confirm"))).toHaveLength(before);
          const row = client.sql.exec("SELECT approved_revision, approved_by, cancel_requested FROM poppy_operations WHERE issuer = ? AND operation_id = ?", C.issuer, op.operation_id).one();
          expect(row.approved_revision).toBeNull();
          expect(row.approved_by).toBeNull();
          if (mode === "user cancelled") expect(row.cancel_requested).toBe(1);
        } finally {
          remote.mockRestore(); shown.mockRestore(); notified.mockRestore(); scheduled.mockRestore();
        }
      });
    });
  }

  it("keeps tracking an unknown legacy confirmation and cancels it instead of abandoning or confirming again", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const shown = vi.spyOn(client.host, "showCard").mockResolvedValue(undefined);
      const op = proposal();
      const sent: string[] = [];
      const remote = vi.spyOn(client, "resourceJson").mockImplementation(async (_company, request) => {
        const init = request.init();
        sent.push(`${init.method} ${init.url}`);
        return { status: 200, body: { ...op, state: init.url.endsWith("/cancel") ? "cancelled" : "proposed" }, headers: new Headers() };
      });
      try {
        await handleProposal(client, C, "main", { ...op });
        const permission = addPermission(client, { issuer: C.issuer, account: "default", action: "exchange", maxUses: 1 });
        client.sql.exec("UPDATE poppy_permissions SET reserved = 1 WHERE id = ?", permission);
        client.sql.exec("UPDATE poppy_operations SET approved_revision = 1, approved_by = 'standing_permission', permission_id = ?, confirmed = 2 WHERE issuer = ? AND operation_id = ?", permission, C.issuer, op.operation_id);
        await recoverOperations(client);
        expect(scheduled).toHaveBeenCalled();
        rememberProposal(client, C.issuer, "audit-repeat", op.operation_id);
        expect(() => refuseWhileConfirming(client, C.issuer, "audit-repeat")).toThrow(/don't ask again until it is final/);
        expect(client.sql.exec("SELECT cancel_requested FROM poppy_operations WHERE operation_id = ?", op.operation_id).one().cancel_requested).toBe(1);
        expect(await trackOperation(client, C.issuer, op.operation_id)).toBeNull();
        expect(sent.some(url => url.endsWith("/confirm"))).toBe(false);
        expect(sent.some(url => url.startsWith("GET "))).toBe(true);
        expect(sent.some(url => url.endsWith("/cancel"))).toBe(true);
        expect(client.sql.exec("SELECT reserved FROM poppy_permissions WHERE id = ?", permission).one().reserved).toBe(0);
        expect(JSON.parse(String(client.sql.exec("SELECT operation FROM poppy_operations WHERE operation_id = ?", op.operation_id).one().operation)).state).toBe("cancelled");
      } finally {
        remote.mockRestore(); shown.mockRestore(); notified.mockRestore(); scheduled.mockRestore();
      }
    });
  });

  it("does not dispatch a confirm after cancellation while token preparation is suspended", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const op = proposal();
      const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const shown = vi.spyOn(client.host, "showCard").mockResolvedValue(undefined);
      await handleProposal(client, C, "main", { ...op });
      const heldToken = await client.token(C, { label: "main" });
      let releaseToken!: () => void;
      let tokenStarted!: () => void;
      const started = new Promise<void>(resolve => { tokenStarted = resolve; });
      const wait = new Promise<void>(resolve => { releaseToken = resolve; });
      const token = vi.spyOn(client, "token").mockImplementationOnce(async () => { tokenStarted(); await wait; return heldToken; });
      const sent: string[] = [];
      const originalFetch = client.host.fetcher;
      const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
        if (new URL(request.url).pathname.includes("/operations/")) {
          sent.push(request.url);
          return Response.json({ ...op, state: "cancelled" });
        }
        return originalFetch(request);
      });
      try {
        const pending = approveAndConfirm(client, C.issuer, op.operation_id, 1, "user");
        await started;
        await cancelOperation(client, C.issuer, op.operation_id);
        releaseToken();
        await pending;
        expect(sent.some(url => url.endsWith("/confirm"))).toBe(false);
        expect(sent.some(url => url.endsWith("/cancel"))).toBe(true);
      } finally {
        releaseToken(); remote.mockRestore(); token.mockRestore(); shown.mockRestore(); notified.mockRestore(); scheduled.mockRestore();
      }
    });
  });

  it("rechecks withdrawn authority before an automatic DPoP nonce retry", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const op = proposal();
      const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const shown = vi.spyOn(client.host, "showCard").mockResolvedValue(undefined);
      await handleProposal(client, C, "main", { ...op });
      await client.token(C, { label: "main" });
      let releaseResponse!: (response: Response) => void;
      let requestStarted!: () => void;
      const started = new Promise<void>(resolve => { requestStarted = resolve; });
      const sent: string[] = [];
      const originalFetch = client.host.fetcher;
      const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
        if (request.url.endsWith("/confirm")) {
          sent.push(request.url);
          requestStarted();
          return new Promise<Response>(resolve => { releaseResponse = resolve; });
        }
        if (request.url.endsWith("/cancel")) return Response.json({ ...op, state: "cancelled" });
        return originalFetch(request);
      });
      try {
        const pending = approveAndConfirm(client, C.issuer, op.operation_id, 1, "user");
        await started;
        await cancelOperation(client, C.issuer, op.operation_id);
        releaseResponse(Response.json({ error: "use_dpop_nonce" }, { status: 401, headers: { "WWW-Authenticate": 'DPoP error="use_dpop_nonce"', "DPoP-Nonce": "nonce-audit" } }));
        await pending;
        expect(sent).toHaveLength(1);
      } finally {
        remote.mockRestore(); shown.mockRestore(); notified.mockRestore(); scheduled.mockRestore();
      }
    });
  });

  for (const change of ["cancelled", "new revision"] as const) {
    it(`keeps ${change} when a delayed original confirmation succeeds`, async () => {
      const a = await agent();
      const c = await company();
      await signInDirect(a, c);
      await runInDurableObject(a.stub, async instance => {
        const client = instance.poppy.client;
        const C = await client.company(c.domain);
        const op = proposal();
        const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
        const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
        const shown = vi.spyOn(client.host, "showCard").mockResolvedValue(undefined);
        let release!: (value: { status: number; body: Operation; headers: Headers }) => void;
        let requestStarted!: () => void;
        const started = new Promise<void>(resolve => { requestStarted = resolve; });
        const remote = vi.spyOn(client, "resourceJson").mockImplementation(async (_company, request) => {
          if (request.init().url.endsWith("/cancel")) return { status: 200, body: { ...op, state: "cancelled" }, headers: new Headers() };
          requestStarted();
          return new Promise(resolve => { release = resolve; });
        });
        try {
          await handleProposal(client, C, "main", { ...op });
          const pending = approveAndConfirm(client, C.issuer, op.operation_id, 1, "user");
          await started;
          if (change === "cancelled") await cancelOperation(client, C.issuer, op.operation_id);
          else await handleProposal(client, C, "main", { ...op, revision: 2, summary: "Exchange the jacket for another size" });
          release({ status: 200, body: { ...op, state: "in_progress" }, headers: new Headers() });
          await pending;
          const kept = JSON.parse(String(client.sql.exec("SELECT operation FROM poppy_operations WHERE issuer = ? AND operation_id = ?", C.issuer, op.operation_id).one().operation));
          expect(kept).toMatchObject(change === "cancelled" ? { revision: 1, state: "cancelled" } : { revision: 2, state: "proposed" });
          expect(shown).toHaveBeenCalledWith(expect.objectContaining({ kind: "notice", text: expect.stringContaining("older or contradictory") }));
        } finally {
          remote.mockRestore(); shown.mockRestore(); notified.mockRestore(); scheduled.mockRestore();
        }
      });
    });
  }

  it("settles each reservation once when cancellation and the original confirmation refusal race", async () => {
    const a = await agent();
    const c = await company();
    await signInDirect(a, c);
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const shown = vi.spyOn(client.host, "showCard").mockResolvedValue(undefined);
      let rejectFirst!: (reason: unknown) => void;
      const remote = vi.spyOn(client, "resourceJson").mockImplementation(async (_company, request) => {
        const init = request.init();
        if (init.url.endsWith("/cancel")) throw new PoppyError("server_error", "Cancel unavailable", 503);
        return new Promise((_resolve, reject) => { rejectFirst = reject; });
      });
      try {
        for (const id of ["op_first", "op_second"]) await handleProposal(client, C, "main", { ...proposal(id) });
        const permission = addPermission(client, { issuer: C.issuer, account: "default", action: "exchange", maxUses: 2 });
        client.sql.exec("UPDATE poppy_permissions SET reserved = 2 WHERE id = ?", permission);
        // Legacy reservations survive a deploy. A first-party User approval
        // can still be reconciled while another old reservation is outstanding.
        client.sql.exec("UPDATE poppy_operations SET approved_revision = 1, approved_by = 'user', permission_id = ? WHERE issuer = ?", permission, C.issuer);
        const first = confirm(client, C.issuer, "op_first");
        // Scheduling yields before the resource call.
        await Promise.resolve(); await Promise.resolve();
        await expect(cancelOperation(client, C.issuer, "op_first")).rejects.toMatchObject({ code: "server_error" });
        rejectFirst(new PoppyError("invalid_request", "Original confirm refused", 400));
        await first;
        await expect(cancelOperation(client, C.issuer, "op_first")).rejects.toMatchObject({ code: "server_error" });
        expect(client.sql.exec("SELECT permission_id FROM poppy_operations WHERE issuer = ? AND operation_id = ?", C.issuer, "op_second").one().permission_id).toBe(permission);
        expect(client.sql.exec("SELECT reserved FROM poppy_permissions WHERE id = ?", permission).one().reserved).toBe(1);
      } finally {
        remote.mockRestore(); shown.mockRestore(); notified.mockRestore(); scheduled.mockRestore();
      }
    });
  });
});
