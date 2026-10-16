import { describe, expect, it, vi } from "vitest";
import { answered, dismissFailed, retryFailed, takeWaiting, unanswered, type Outgoing } from "../../src/use-pi-session";
import { gs, property, recordTransitions } from "./hegel";

// These properties drive the real reducers without opening a React socket.
vi.mock("agents/react", () => ({ useAgent: () => { throw new Error("no socket in a reducer property"); } }));

type Entry = { text: string; whenBusy: "followUp" | "steer"; phase: "queued" | "inflight" | "rejected"; error?: string };
const STATES = { queued: "waiting", inflight: "sent", rejected: "failed" } as const;

describe("outbox reconnect model", () => {
  it("keeps a mixed 100,000-message backlog intact across reconnects within linear input-traversal budgets", () => {
    // An overload regression, not a claimed supported queue size or a timed
    // benchmark. Count input visits instead of using machine-dependent ms.
    const count = 100_000;
    const initial: readonly Outgoing[] = Object.freeze(Array.from({ length: count }, (_, i) => Object.freeze({
      id: `scale-${i}`, text: `message ${i} café 🚲`, whenBusy: i % 2 ? "steer" as const : "followUp" as const,
      state: i % 3 === 0 ? "waiting" as const : i % 3 === 1 ? "sent" as const : "failed" as const,
      ...(i % 3 === 2 ? { error: `refused-${i}` } : {})
    })));
    const expected = new Map(initial.map((item) => [item.id, { ...item }]));
    let actual = initial;
    const serialize = (items: readonly Outgoing[]) => JSON.stringify(items, ["id", "text", "whenBusy", "state", "error"]);
    function bounded<T>(input: readonly Outgoing[], passes: number, operation: (tracked: readonly Outgoing[]) => T): T {
      let visits = 0;
      const tracked = new Proxy(input, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) visits++;
          return Reflect.get(target, key, receiver);
        }
      });
      const result = operation(tracked);
      expect(visits).toBeLessThanOrEqual(passes * input.length);
      return result;
    }
    function agrees() {
      // Compare every declared field and entry in a stable key order,
      // avoiding millions of test-framework object comparisons at this scale.
      expect(serialize(actual)).toBe(serialize([...expected.values()]));
      expect(new Set(actual.map((item) => item.id)).size).toBe(actual.length);
    }
    // Acknowledgements at both ends and in the middle must never reappear.
    for (const id of ["scale-0", "scale-50000", "scale-99999"]) {
      actual = bounded(actual, 1, (items) => answered(items, id));
      expected.delete(id);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const waiting = [...expected.values()].filter((item) => item.state === "waiting");
      const sent = bounded(actual, 2, takeWaiting);
      expect(serialize(sent.send)).toBe(serialize(waiting)); // exact payload, mode and order
      actual = sent.outbox;
      for (const item of waiting) expected.set(item.id, { ...item, state: "sent" });
      agrees();
      actual = bounded(actual, 1, unanswered);
      for (const [id, item] of expected) if (item.state === "sent") expected.set(id, { ...item, state: "waiting" });
      agrees(); // failed entries stay failed and acknowledged entries stay absent
    }
    actual = bounded(actual, 1, (items) => retryFailed(items, "scale-2"));
    const retried = expected.get("scale-2")!;
    expected.set("scale-2", { id: retried.id, text: retried.text, whenBusy: retried.whenBusy, state: "waiting" });
    actual = bounded(actual, 1, (items) => dismissFailed(items, "scale-5"));
    expected.delete("scale-5");
    actual = bounded(actual, 1, (items) => answered(items, "scale-1", "connection refused"));
    expected.set("scale-1", { ...expected.get("scale-1")!, state: "failed", error: "connection refused" });
    agrees();
    // Frozen inputs also expose mutation; check the original payload and state.
    expect(initial[0]).toEqual({ id: "scale-0", text: "message 0 café 🚲", whenBusy: "followUp", state: "waiting" });
    expect(initial[2]).toMatchObject({ state: "failed", error: "refused-2" });
  });

  it("preserves payloads and operation IDs, resends only unanswered messages and never resurrects acknowledged messages", property((tc) => {
    let actual: readonly Outgoing[] = [];
    const expected = new Map<string, Entry>();
    const acknowledged = new Set<string>();
    const removed = new Set<string>();
    let nextId = 0;
    const counts: Record<string, number> = {};
    const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 100 }));
    for (let index = 0; index < steps; index++) {
      const failed = [...expected].filter(([, entry]) => entry.phase === "rejected").map(([id]) => id);
      const enabled: Array<"enqueue" | "send" | "disconnect" | "ack" | "fail" | "retry" | "dismiss"> = ["enqueue"];
      if (expected.size) enabled.push("ack", "fail");
      if ([...expected.values()].some((entry) => entry.phase === "queued")) enabled.push("send");
      if ([...expected.values()].some((entry) => entry.phase === "inflight")) enabled.push("disconnect");
      if (failed.length) enabled.push("retry", "dismiss");
      // Start with a generated payload so every history reaches real work.
      // Most subsequent actions use valid prerequisites/IDs. A smaller class
      // deliberately probes current, previously removed and never allocated IDs.
      const intentional = index > 0 && tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0;
      const command = index === 0 ? "enqueue" : tc.draw(gs.sampledFrom(intentional
        ? ["send", "disconnect", "ack", "fail", "retry", "dismiss"] as const : enabled));
      tc.note(`${index}: ${command}; completed=${JSON.stringify(counts)}`);
      let changed = false;
      const before = structuredClone(actual);
      for (const item of actual) Object.freeze(item);
      Object.freeze(actual);
      const prior = actual;
      const usesId = ["ack", "fail", "retry", "dismiss"].includes(command);
      const idClasses = ["unknown", ...(expected.size ? ["current"] : []), ...(removed.size ? ["removed"] : [])];
      const idClass = intentional && usesId ? tc.draw(gs.sampledFrom(idClasses)) : "enabled";
      const id = idClass === "removed" ? tc.draw(gs.sampledFrom([...removed]))
        : idClass === "current" ? tc.draw(gs.sampledFrom([...expected.keys()]))
        : intentional || ["enqueue", "send", "disconnect"].includes(command) ? `operation-${nextId}`
        : tc.draw(gs.sampledFrom(command === "retry" || command === "dismiss" ? failed : [...expected.keys()]));
      if (command === "enqueue") {
        changed = true;
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
        changed = shouldSend.length > 0;
        const result = takeWaiting(actual);
        expect(result.send.map((entry) => entry.id)).toEqual(shouldSend);
        for (const item of result.send) {
          expect(item).toMatchObject({ id: item.id, text: expected.get(item.id)!.text, whenBusy: expected.get(item.id)!.whenBusy });
        }
        actual = result.outbox;
      } else if (command === "disconnect") {
        changed = [...expected.values()].some((entry) => entry.phase === "inflight");
        for (const entry of expected.values()) if (entry.phase === "inflight") entry.phase = "queued";
        actual = unanswered(actual);
      } else if (command === "ack") {
        changed = expected.has(id);
        if (expected.has(id)) { acknowledged.add(id); removed.add(id); }
        expected.delete(id);
        actual = answered(actual, id);
      } else if (command === "fail") {
        const error = tc.draw(gs.text({ maxSize: 100 }));
        const entry = expected.get(id);
        changed = !!entry && (entry.phase !== "rejected" || entry.error !== error);
        if (entry) { entry.phase = "rejected"; entry.error = error; }
        actual = answered(actual, id, error);
      } else if (command === "retry") {
        const entry = expected.get(id);
        changed = entry?.phase === "rejected";
        if (changed) { entry!.phase = "queued"; delete entry!.error; }
        actual = retryFailed(actual, id);
      } else {
        changed = expected.get(id)?.phase === "rejected";
        if (changed) { expected.delete(id); removed.add(id); }
        actual = dismissFailed(actual, id);
      }
      const transition = `${command}.${changed ? "changed" : `intentional-no-op${usesId ? `.${idClass}` : ""}`}`;
      counts[transition] = (counts[transition] ?? 0) + 1;
      expect(prior).toEqual(before);
      expect(actual).toEqual([...expected].map(([key, entry]) => ({
        id: key, text: entry.text, whenBusy: entry.whenBusy, state: STATES[entry.phase],
        ...(entry.error !== undefined ? { error: entry.error } : {})
      })));
      expect(actual.some((item) => acknowledged.has(item.id))).toBe(false);
      expect(new Set(actual.map((item) => item.id)).size).toBe(actual.length);
    }
    recordTransitions("outbox (state changes and intentional no-ops separated)", counts, steps);
  }));
});
