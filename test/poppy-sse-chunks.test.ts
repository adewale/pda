import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { conversation, readConversation, recentMessages, sendMessage } from "../src/poppy/conversations";
import { MAX_SSE_CHARS } from "../src/poppy/sse";
import { agent, company } from "./agent-helpers";

/** Exercise actual conversation parsing/storage; only the peer's event stream is controlled. */
describe("conversation SSE transport chunk boundaries", () => {
  it.each(["\r\n", "\n", "\r"])("retains multiline events and opaque cursors across every byte split with %j line endings", async newline => {
    const a = await agent();
    const c = await company();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const schedule = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const fetcher = client.host.fetcher;
      let chunks: Uint8Array[] = [];
      let read = 0;
      let cancelled = 0;
      const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
        if (!new URL(request.url).pathname.endsWith("/events")) return fetcher(request);
        ++read;
        let next = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (next < chunks.length) controller.enqueue(chunks[next++]!);
            else controller.close();
          },
          cancel() { ++cancelled; }
        }), { headers: { "Content-Type": "text/event-stream" } });
      });
      try {
        const opened = await sendMessage(client, C, { label: "main", callKey: "stream-open", sender: "agent", text: "Hello" });
        notified.mockClear();
        const eventId = "evt_opaque_Zyx_0";
        const content = "A café receipt 🙂 survives transport fragmentation.";
        const wire = [
          ": a keep-alive comment",
          `id: ${eventId}`,
          'data: {"id":"' + eventId + '","type":"message",',
          'data: "created_at":"2026-10-29T00:00:00Z","message":{"id":"msg_reply","role":"company",',
          'data: "author":{"type":"agent"},"text":' + JSON.stringify(content) + '}}',
          "", ""
        ].join(newline);
        const bytes = new TextEncoder().encode(wire);
        for (let cut = 1; cut < bytes.byteLength; ++cut) {
          client.sql.exec("DELETE FROM poppy_events WHERE conversation_id = ?", opened.conversationId);
          client.sql.exec("DELETE FROM poppy_inbox WHERE conversation_id = ?", opened.conversationId);
          client.sql.exec("UPDATE poppy_conversations SET cursor = NULL WHERE id = ?", opened.conversationId);
          notified.mockClear();
          chunks = [bytes.slice(0, cut), bytes.slice(cut)];
          await readConversation(client, opened.conversationId, 0);
          expect(recentMessages(client, opened.conversationId), `message at byte split ${cut}`).toMatchObject([{ text: content }]);
          expect(conversation(client, opened.conversationId)?.cursor, `cursor at byte split ${cut}`).toBe(eventId);
          expect(notified, `delivery at byte split ${cut}`).toHaveBeenCalledTimes(1);
          await readConversation(client, opened.conversationId, 0);
          expect(recentMessages(client, opened.conversationId), `replay at byte split ${cut}`).toHaveLength(1);
          expect(notified, `duplicate delivery at byte split ${cut}`).toHaveBeenCalledTimes(1);
        }
        expect(read).toBe((bytes.byteLength - 1) * 2);
        // A completed peer stream is closed rather than cancelled; bounded reads
        // still leave no reader locks or background scheduling behind.
        expect(cancelled).toBe(0);
      } finally { remote.mockRestore(); notified.mockRestore(); schedule.mockRestore(); }
    });
  }, 30_000);

  it.each(["unfinished event", "complete event", "unfinished message"])("cancels an oversized %s while retaining committed messages and cursor", async kind => {
    const a = await agent();
    const c = await company();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const schedule = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      const pushed = vi.spyOn(client.host, "pushDirect").mockImplementation(() => {});
      let restoreRemote = () => {};
      try {
        const parent = await sendMessage(client, C, { label: "main", callKey: "large-parent", sender: "agent", text: "Hello" });
        const opened = await sendMessage(client, C, { label: "main", callKey: "large-child", parentConversationId: parent.conversationId, sender: "human", text: "Please help" });
        client.sql.exec("DELETE FROM poppy_inbox WHERE conversation_id = ?", opened.conversationId);
        const saved = { id: "evt_committed", type: "message", created_at: "2026-10-29T00:00:00Z", message: { id: "msg_committed", role: "company", author: { type: "agent" }, text: "Keep this complete message." } };
        const frame = (value: unknown, id?: string, type?: string) => `${id ? `id: ${id}\n` : ""}${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
        const chunks = [frame(saved, saved.id)];
        if (kind === "unfinished message") {
          const part = "a".repeat(MAX_SSE_CHARS / 2 + 1);
          chunks.push(frame({ message_id: "msg_partial", text: part }, undefined, "text-delta"));
          chunks.push(frame({ message_id: "msg_partial", text: part }, undefined, "text-delta"));
        } else chunks.push(`data: ${"x".repeat(MAX_SSE_CHARS + 1)}${kind === "complete event" ? "\n\n" : ""}`);
        let index = 0;
        let cancelled = 0;
        const fetcher = client.host.fetcher;
        const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request => {
          if (!new URL(request.url).pathname.endsWith("/events")) return fetcher(request);
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) { if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]!)); },
            cancel() { ++cancelled; }
          }), { headers: { "Content-Type": "text/event-stream" } });
        });
        restoreRemote = () => remote.mockRestore();
        await expect(readConversation(client, opened.conversationId, 0)).rejects.toMatchObject({ code: "invalid_response" });
        expect(cancelled).toBe(1);
        expect(conversation(client, opened.conversationId)).toMatchObject({ cursor: saved.id, status: opened.status });
        expect(recentMessages(client, opened.conversationId)).toMatchObject([{ text: saved.message.text }]);
        expect(pushed.mock.calls.at(-1)?.[0]).toMatchObject({ conversationId: opened.conversationId, partial: null });
        if (kind === "unfinished message") expect(pushed.mock.calls.some(([update]) => update.partial?.text.length === MAX_SSE_CHARS / 2 + 1)).toBe(true);
      } finally { restoreRemote(); pushed.mockRestore(); notified.mockRestore(); schedule.mockRestore(); }
    });
  });

  it("accepts a stream larger than the event bound when each complete event stays within it", async () => {
    const a = await agent();
    const c = await company();
    await runInDurableObject(a.stub, async instance => {
      const client = instance.poppy.client;
      const C = await client.company(c.domain);
      const schedule = vi.spyOn(client.host, "schedule").mockResolvedValue(undefined);
      const notified = vi.spyOn(client.host, "notifyModel").mockResolvedValue(undefined);
      let restoreRemote = () => {};
      try {
        const opened = await sendMessage(client, C, { label: "main", callKey: "many-events", sender: "agent", text: "Hello" });
        client.sql.exec("DELETE FROM poppy_inbox WHERE conversation_id = ?", opened.conversationId);
        notified.mockClear();
        const text = "a".repeat(Math.floor(MAX_SSE_CHARS * 0.4));
        const wire = [0, 1, 2].map(i => {
          const event = { id: `evt_large_${i}`, type: "message", created_at: "2026-10-29T00:00:00Z", message: { id: `msg_large_${i}`, role: "company", author: { type: "agent" }, text } };
          return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
        }).join("");
        expect(wire.length).toBeGreaterThan(MAX_SSE_CHARS);
        const fetcher = client.host.fetcher;
        const remote = vi.spyOn(client.host, "fetcher").mockImplementation(async request =>
          new URL(request.url).pathname.endsWith("/events") ? new Response(wire, { headers: { "Content-Type": "text/event-stream" } }) : fetcher(request));
        restoreRemote = () => remote.mockRestore();
        await readConversation(client, opened.conversationId, 0);
        expect(recentMessages(client, opened.conversationId)).toHaveLength(3);
        expect(notified).toHaveBeenCalledTimes(3);
        expect(conversation(client, opened.conversationId)?.cursor).toBe("evt_large_2");
      } finally { restoreRemote(); notified.mockRestore(); schedule.mockRestore(); }
    });
  });
});
