import { describe, expect, it, vi } from "vitest";
import { answered, dismissFailed, retryFailed, takeWaiting, unanswered, type Outgoing } from "../../src/use-pi-session";
import { gs, property } from "./hegel";

// These properties drive the real reducers without opening a React socket.
vi.mock("agents/react", () => ({ useAgent: () => { throw new Error("no socket in a reducer property"); } }));

type Entry = { text: string; whenBusy: "followUp" | "steer"; phase: "queued" | "inflight" | "rejected"; error?: string };
const STATES = { queued: "waiting", inflight: "sent", rejected: "failed" } as const;

describe("outbox reconnect model", () => {
  it("handles 100,000 pending messages through send, reconnect, acknowledgement, retry and dismissal", () => {
    const count = 100_000;
    const initial: Outgoing[] = Array.from({ length: count }, (_, i) => ({ id: `scale-${i}`, text: `message ${i}`, whenBusy: "followUp", state: "waiting" }));
    const sent = takeWaiting(initial);
    expect(sent.send).toEqual(initial);
    const reconnected = unanswered(sent.outbox);
    expect(reconnected).toEqual(initial);
    const acknowledged = answered(reconnected, "scale-50000");
    expect(acknowledged).toHaveLength(count - 1);
    expect(answered(acknowledged, "scale-50000")).toEqual(acknowledged);
    const failed = answered(acknowledged, "scale-50001", "not accepted");
    expect(retryFailed(failed, "scale-50001")).toEqual(acknowledged);
    const dismissed = dismissFailed(failed, "scale-50001");
    expect(dismissed).toHaveLength(count - 2);
    expect(dismissed.some((item) => item.id === "scale-50000" || item.id === "scale-50001")).toBe(false);
    expect(initial[50000]!.state).toBe("waiting");
  });

  it("preserves payloads and operation IDs, resends only unanswered messages and never resurrects acknowledged messages", property((tc) => {
    let actual: readonly Outgoing[] = [];
    const expected = new Map<string, Entry>();
    const acknowledged = new Set<string>();
    let nextId = 0;
    const commands = tc.draw(gs.arrays(gs.sampledFrom(["enqueue", "send", "disconnect", "ack", "fail", "retry", "dismiss"] as const), { minSize: 1, maxSize: 100 }));
    // A generated sequence is allowed to start disconnected and to receive
    // repeated or late acknowledgements, including ones for removed IDs.
    for (const [index, command] of commands.entries()) {
      tc.note(`${index}: ${command}`);
      const before = structuredClone(actual);
      for (const item of actual) Object.freeze(item);
      Object.freeze(actual);
      const prior = actual;
      const id = `operation-${tc.draw(gs.integers({ minValue: 0, maxValue: nextId }))}`;
      if (command === "enqueue") {
        const fresh = `operation-${nextId++}`;
        const text = tc.draw(gs.text({ maxSize: 200 }));
        const whenBusy = tc.draw(gs.sampledFrom(["followUp", "steer"] as const));
        expected.set(fresh, { text, whenBusy, phase: "queued" });
        actual = [...actual, { id: fresh, text, whenBusy, state: "waiting" }];
      } else if (command === "send") {
        const shouldSend: string[] = [];
        for (const [key, entry] of expected) if (entry.phase === "queued") {
          shouldSend.push(key);
          entry.phase = "inflight";
        }
        const result = takeWaiting(actual);
        expect(result.send.map((entry) => entry.id)).toEqual(shouldSend);
        for (const item of result.send) {
          expect(item).toMatchObject({ id: item.id, text: expected.get(item.id)!.text, whenBusy: expected.get(item.id)!.whenBusy });
        }
        actual = result.outbox;
      } else if (command === "disconnect") {
        for (const entry of expected.values()) if (entry.phase === "inflight") entry.phase = "queued";
        actual = unanswered(actual);
      } else if (command === "ack") {
        if (expected.has(id)) acknowledged.add(id);
        expected.delete(id);
        actual = answered(actual, id);
      } else if (command === "fail") {
        const error = tc.draw(gs.text({ maxSize: 100 }));
        const entry = expected.get(id);
        if (entry) { entry.phase = "rejected"; entry.error = error; }
        actual = answered(actual, id, error);
      } else if (command === "retry") {
        const entry = expected.get(id);
        if (entry?.phase === "rejected") { entry.phase = "queued"; delete entry.error; }
        actual = retryFailed(actual, id);
      } else {
        if (expected.get(id)?.phase === "rejected") expected.delete(id);
        actual = dismissFailed(actual, id);
      }
      expect(prior).toEqual(before);
      expect(actual).toEqual([...expected].map(([key, entry]) => ({
        id: key, text: entry.text, whenBusy: entry.whenBusy, state: STATES[entry.phase],
        ...(entry.error !== undefined ? { error: entry.error } : {})
      })));
      expect(actual.some((item) => acknowledged.has(item.id))).toBe(false);
      expect(new Set(actual.map((item) => item.id)).size).toBe(actual.length);
    }
  }));
});
