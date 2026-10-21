import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { conversation, readConversation, recentMessages, sendMessage } from "../src/poppy/conversations";
import { migrate } from "../src/poppy/store";
import type { Json } from "../src/poppy/json";
import { agent, company } from "./agent-helpers";

/** Actual Worker storage and endpoint construction; only peer answers are controlled. */
it("isolates equal remote IDs, rejects cross-company handles, and validates response and child bindings", async () => {
  const a = await agent();
  const ca = await company();
  const cb = await company();
  await runInDurableObject(a.stub, async (instance) => {
    const client = instance.poppy.client;
    const A = await client.company(ca.domain);
    const B = await client.company(cb.domain);
    const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
    const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
    const pushed = vi.spyOn(client.host, "pushDirect").mockImplementation(() => {});
    let answer: Json = { conversation_id: "cnv_shared", status: "working", responder: "agent", events: [] };
    const outgoing: { issuer: string; url: string; body: Json | undefined }[] = [];
    const resourceJson = vi.spyOn(client, "resourceJson").mockImplementation(async (target, request) => {
      const init = request.init();
      outgoing.push({ issuer: target.issuer, url: init.url, body: init.body });
      return { status: 201, body: answer, headers: new Headers() };
    });
    let restoreResource: (() => void) | undefined;
    const send = (target: typeof A, key: string, extra: { conversationId?: string; parentConversationId?: string; sender?: "agent" | "human" } = {}) =>
      sendMessage(client, target, { label: "main", callKey: key, sender: "agent", text: "Hello", ...extra });
    try {
      answer = { conversation_id: "cnv_shared", status: "working", responder: "agent", events: [
        { id: "evt_same", type: "message", message: { id: "msg_A", role: "company", sender: "agent", text: "A message" } }
      ] };
      const first = await send(A, "audit-a");
      client.sql.exec("UPDATE poppy_conversations SET cursor = ? WHERE id = ?", "cursor_for_A", first.conversationId);
      answer = { conversation_id: "cnv_shared", status: "working", responder: "human", events: [
        { id: "evt_same", type: "message", message: { id: "msg_B", role: "company", sender: "agent", text: "B message" } }
      ] };
      const second = await send(B, "audit-b-collision");
      expect(second.conversationId).not.toBe(first.conversationId);
      expect(conversation(client, first.conversationId)).toMatchObject({ issuer: A.issuer, remote_id: "cnv_shared", status: "working", responder: "agent", cursor: "cursor_for_A" });
      expect(conversation(client, second.conversationId)).toMatchObject({ issuer: B.issuer, remote_id: "cnv_shared", responder: "human" });
      expect(recentMessages(client, first.conversationId).map((m) => (m as { text?: string }).text)).toEqual(["A message"]);
      expect(recentMessages(client, second.conversationId).map((m) => (m as { text?: string }).text)).toEqual(["B message"]);
      expect(new Set(scheduled.mock.calls.map((call) => call[3])).size).toBe(2);

      const before = outgoing.length;
      const rejected = await instance.poppyTool("poppy_message", { domain: cb.domain, conversation: first.conversationId, text: "Continue this task" });
      expect(rejected.isError).toBe(true);
      expect(rejected.details).toContain("conversation_not_found");
      expect(outgoing).toHaveLength(before);
      const sent = await instance.poppyTool("poppy_message", { domain: cb.domain, conversation: second.conversationId, text: "Continue B" });
      expect(sent.isError).toBe(false);
      expect(outgoing).toHaveLength(before + 1);
      expect(new URL(outgoing.at(-1)!.url).pathname).toBe(`${new URL(B.conversations!.endpoint).pathname}/cnv_shared/messages`);
      expect(new URL(outgoing.at(-1)!.url).searchParams.has("cursor")).toBe(false);

      answer = { conversation_id: "cnv_other", status: "closed", responder: "agent", events: [] };
      await expect(send(B, "audit-response-switch", { conversationId: second.conversationId })).rejects.toMatchObject({ code: "invalid_response" });
      expect(conversation(client, first.conversationId)?.status).toBe("working");
      expect(conversation(client, second.conversationId)?.status).toBe("working");
      answer = { conversation_id: "cnv_shared", status: "working", responder: "agent", events: [] };
      await expect(sendMessage(client, B, { label: "another-session", callKey: "audit-account-collision", sender: "agent", text: "Another account's message" })).rejects.toMatchObject({ code: "invalid_response" });
      expect(conversation(client, second.conversationId)?.label).toBe("main");

      answer = { conversation_id: "cnv_child", status: "working", responder: "human", events: [] };
      const childA = await send(A, "audit-a-child", { parentConversationId: first.conversationId, sender: "human" });
      const childB = await send(B, "audit-b-child", { parentConversationId: second.conversationId, sender: "human" });
      expect(childB.conversationId).not.toBe(childA.conversationId);
      expect(outgoing.at(-1)!.body).toMatchObject({ parent_conversation_id: "cnv_shared" });
      answer = { conversation_id: "cnv_other_parent", status: "working", responder: "agent", events: [] };
      const otherParent = await send(B, "audit-other-parent");
      answer = { conversation_id: "cnv_other_child", status: "working", responder: "human", events: [] };
      const otherChild = await send(B, "audit-other-child", { parentConversationId: otherParent.conversationId, sender: "human" });
      let eventId = 0;
      let child = "cnv_shared"; // Exists at B, but is not a Direct child.
      const resource = vi.spyOn(client, "resource").mockImplementation(async (_target, request) => {
        expect(new URL(request.init().url).pathname).toBe(`${new URL(B.conversations!.endpoint).pathname}/cnv_shared/events`);
        return new Response(JSON.stringify({ events: [{ id: `evt_close_${++eventId}`, type: "direct_closed", conversation_id: child }], has_more: false }), { headers: { "Content-Type": "application/json" } });
      });
      restoreResource = () => resource.mockRestore();
      await readConversation(client, second.conversationId, 0);
      expect(conversation(client, second.conversationId)?.status).toBe("working");
      expect(pushed).not.toHaveBeenCalled();
      child = "cnv_unknown";
      await readConversation(client, second.conversationId, 0);
      expect(pushed).not.toHaveBeenCalled();
      child = "cnv_other_child";
      await readConversation(client, second.conversationId, 0);
      expect(conversation(client, otherChild.conversationId)?.status).toBe("working");
      expect(pushed).not.toHaveBeenCalled();
      child = "cnv_child";
      await readConversation(client, second.conversationId, 0);
      expect(conversation(client, childB.conversationId)?.status).toBe("closed");
      expect(conversation(client, childA.conversationId)?.status).toBe("working");
      expect(pushed).toHaveBeenCalledTimes(1);
      expect(pushed).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: childB.conversationId, company: B.name }));

      // A fresh view of the client still resolves the immutable stored mapping.
      expect(client.sql.exec("SELECT id FROM poppy_conversations WHERE issuer = ? AND remote_id = ? AND quarantined = 0", B.issuer, "cnv_shared").toArray()).toEqual([{ id: second.conversationId }]);
    } finally {
      restoreResource?.(); resourceJson.mockRestore(); pushed.mockRestore(); notified.mockRestore(); scheduled.mockRestore();
    }
  });
});

it("quarantines legacy history and rejects stale handles without replaying remote work", async () => {
  const a = await agent();
  const c = await company();
  await runInDurableObject(a.stub, async (instance) => {
    const client = instance.poppy.client;
    const C = await client.company(c.domain);
    const sql = client.sql;
    // Restore the pre-isolation schema. Its inbox cannot prove which Company supplied content.
    sql.exec("DROP INDEX poppy_conversation_remote");
    sql.exec("ALTER TABLE poppy_conversations DROP COLUMN remote_id");
    sql.exec("ALTER TABLE poppy_conversations DROP COLUMN quarantined");
    sql.exec("INSERT INTO poppy_conversations (id, issuer, label, parent, direct, status, responder, cursor, context, last_event_at, created_at) VALUES ('cnv_legacy', ?, 'main', NULL, 0, 'working', 'agent', 'untrusted_cursor', NULL, 1, 1)", C.issuer);
    sql.exec("INSERT INTO poppy_inbox (conversation_id, event, created_at) VALUES ('cnv_legacy', ?, 1)", JSON.stringify({ id: "evt_old", type: "message", message: { id: "msg_old", role: "company", text: "Legacy content" } }));
    let interrupted = false;
    const crash = {
      exec(query: string, ...bindings: unknown[]) {
        if (!interrupted && query === "DELETE FROM poppy_inbox") {
          interrupted = true;
          throw new Error("simulated migration interruption");
        }
        return sql.exec(query, ...bindings as (string | number | null | ArrayBuffer)[]);
      }
    } as unknown as SqlStorage;
    expect(() => migrate(crash)).toThrow("simulated migration interruption");
    expect(sql.exec("SELECT state FROM poppy_conversation_migration WHERE slot = 1").toArray()).toEqual([{ state: "pending" }]);
    migrate(sql);
    migrate(sql); // Crash/restart re-entry does not erase the archive or unquarantine anything.
    expect(conversation(client, "cnv_legacy")).toBeUndefined();
    expect(sql.exec("SELECT remote_id, quarantined, status, cursor FROM poppy_conversations WHERE id = 'cnv_legacy'").toArray()).toEqual([{ remote_id: "cnv_legacy", quarantined: 1, status: "closed", cursor: null }]);
    expect(sql.exec("SELECT * FROM poppy_inbox").toArray()).toEqual([]);
    expect(sql.exec("SELECT payload FROM poppy_conversation_quarantine WHERE kind = 'inbox'").toArray()).toHaveLength(1);
    expect(sql.exec("SELECT payload FROM poppy_conversation_quarantine WHERE kind = 'conversation'").toArray()[0]?.payload).toContain("untrusted_cursor");
    expect(sql.exec("SELECT card FROM poppy_cards WHERE id = 'conversation-isolation-update'").toArray()[0]?.card).toContain("stopped locally");
    const outbound = vi.spyOn(client, "resourceJson");
    await expect(sendMessage(client, C, { label: "main", callKey: "legacy-replay", conversationId: "cnv_legacy", sender: "agent", text: "Continue" })).rejects.toMatchObject({ code: "conversation_not_found" });
    expect(await readConversation(client, "cnv_legacy", 0)).toBeNull();
    expect(outbound).not.toHaveBeenCalled();
    outbound.mockRestore();
    const fresh = vi.spyOn(client, "resourceJson").mockResolvedValue({ status: 201, headers: new Headers(), body: { conversation_id: "cnv_legacy", status: "working", responder: "agent", events: [] } });
    const scheduled = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
    try {
      const next = await sendMessage(client, C, { label: "main", callKey: "new-scoped-thread", sender: "agent", text: "Start a new conversation" });
      expect(next.conversationId).not.toBe("cnv_legacy");
      expect(conversation(client, next.conversationId)).toMatchObject({ issuer: C.issuer, remote_id: "cnv_legacy", quarantined: 0 });
      fresh.mockClear();
      expect(await readConversation(client, "cnv_legacy", 0)).toBeNull();
      expect(fresh).not.toHaveBeenCalled();
    } finally { fresh.mockRestore(); scheduled.mockRestore(); }
  });
});
