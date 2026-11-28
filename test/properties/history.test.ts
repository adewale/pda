import { describe, expect, it } from "vitest";
import type { PiClientMessage, PiServerMessage } from "../../src/protocol";
import { PiSessionMirror } from "../../src/mirror";
import { FIRST_CONVERSATION, firstGap, followResets, shownMessages, type Conversation } from "../../src/ui/history";
import { gs, propertyAsync } from "./hegel";

/**
 * The page's history (`src/ui/history.ts`, with Cloudflare's
 * `PiSessionMirror`) against a model of the agent's side: one transcript,
 * a window over it as pi's `session.watch()` keeps one, its operations, and
 * `entries` pages. The window is a few entries, so reconnects leave gaps and
 * the page pages back often. Random appends, resets, disconnects,
 * reconnects and loads; after each load the page must show what the agent
 * has since its newest reset, and must follow every reset made after it
 * loaded, never one made before.
 */

type Entry = { readonly id: number; readonly conversationId: 1; readonly kind: string; readonly model?: readonly object[] };

/** pi's window: the newest `MIN` entries, grown by appends to `MAX`, then cut back to `MIN`. */
const MIN = 3;
const MAX = 6;

function said(id: number, text: string): Entry {
  return { id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: id }] };
}
function answered(id: number, text: string): Entry {
  return {
    id, conversationId: 1, kind: "pi.assistant",
    model: [{ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: id }]
  };
}
function reset(id: number): Entry {
  return { id, conversationId: 1, kind: "pi.reset" };
}

/** The agent's side: the transcript, and the window the one socket watches. */
class Agent {
  readonly entries: Entry[] = [];
  window: Entry[] | null = null;
  #page = 0;

  constructor(readonly deliver: (message: PiServerMessage) => void) {}

  append(make: (id: number) => Entry): Entry {
    const entry = make(this.entries.length + 1);
    this.entries.push(entry);
    if (this.window) {
      this.deliver({ type: "ops", session: "1", ops: [["p", ["entries"], this.window.length, 0, [entry]]] } as unknown as PiServerMessage);
      this.window = [...this.window, entry];
      if (this.window.length > MAX) {
        const drop = this.window.length - MIN;
        const before = this.window[drop - 1]!.id;
        this.deliver({ type: "ops", session: "1", ops: [["p", ["entries"], 0, drop, []], ["s", ["before"], before]] } as unknown as PiServerMessage);
        this.window = this.window.slice(drop);
      }
    }
    return entry;
  }

  /** A frame from the page. */
  receive(message: PiClientMessage): void {
    if (message.type === "watch") {
      const after = message.from === undefined ? [] : this.entries.filter((entry) => entry.id >= message.from!);
      const fits = message.from !== undefined && after.length <= MAX;
      this.window = fits ? after : this.entries.slice(-MIN);
      const first = this.window[0]?.id;
      const before = first === undefined ? this.entries.at(-1)?.id : first > 1 ? first - 1 : undefined;
      this.deliver({ type: "view", session: "1", view: { conversation: { id: 1 }, entries: this.window, ...(before === undefined ? {} : { before }), docs: { "pi.live": {} } } } as unknown as PiServerMessage);
    } else if (message.type === "entries") {
      const { minEntryId, maxEntryId, order } = message.query;
      const inRange = this.entries.filter((entry) => (minEntryId === undefined || entry.id >= minEntryId) && (maxEntryId === undefined || entry.id <= maxEntryId));
      const ordered = order === "ascending" ? inRange : [...inRange].reverse();
      const items = ordered.slice(0, message.limit);
      this.#page++;
      this.deliver({ type: "result", id: message.id, result: { items, ...(ordered.length > items.length ? { next: `page-${this.#page}` } : {}) } } as unknown as PiServerMessage);
    }
  }

  /** What the page should show once loaded: from the newest reset on. */
  active(): Entry[] {
    let start = 0;
    this.entries.forEach((entry, index) => { if (entry.kind === "pi.reset") start = index; });
    return this.entries.slice(start);
  }
}

type Step = "said" | "answered" | "reset" | "disconnect" | "reconnect" | "load";

const steps = gs.arrays(gs.sampledFrom<Step>(["said", "answered", "said", "answered", "reset", "disconnect", "reconnect", "load"]), { minSize: 1, maxSize: 40 });
const earlierSteps = gs.arrays(gs.sampledFrom<"said" | "answered" | "reset">(["said", "answered", "reset"]), { maxSize: 12 });

describe("the page's history against a model of pi's view", () => {
  it("shows what the agent has since its newest reset, and follows each reset made after the page loaded", propertyAsync(async (tc) => {
    let conversation: Conversation = FIRST_CONVERSATION;
    let connected = false;
    /** Resets made after the page had its first view: the ones it must follow. */
    const followed = new Set<number>();
    let loaded = false;
    const mirror = new PiSessionMirror((view) => {
      const next = followResets(conversation, view.messages, view.earlier);
      // A new conversation only for a reset made after the page loaded, and newer than the last one followed.
      if (next.epoch !== conversation.epoch) {
        expect(next.newest, "the reset a new conversation starts at").not.toBeNull();
        expect(followed.has(next.newest!), `reset ${next.newest} was made before the page loaded`).toBe(true);
        expect(next.newest!, "resets are followed in order").toBeGreaterThan(conversation.newest ?? 0);
      }
      conversation = next;
    });
    const agent = new Agent((message) => { if (connected) mirror.receive(message); });
    const make = { said: (id: number) => said(id, `said ${id}`), answered: (id: number) => answered(id, `answer ${id}`), reset };

    // What happened before the page opened, then the page opens.
    for (const step of tc.draw(earlierSteps)) agent.append(make[step]);
    const connect = () => { connected = true; mirror.open((message) => agent.receive(message)); };
    // The first view arrives as the page connects: every reset from now on is one it must follow.
    connect();
    loaded = true;
    const load = async () => {
      for (let pages = 0; pages < 200; pages++) {
        const view = mirror.view, gap = firstGap(view.messages);
        if (gap) await mirror.fillGap(gap);
        else if (view.earlier) await mirror.loadEarlier();
        else return;
      }
      throw new Error("the history never finished loading");
    };

    for (const step of tc.draw(steps)) {
      if (step === "said" || step === "answered") agent.append(make[step]);
      else if (step === "reset") {
        // Recorded first: a connected page hears of it as it is appended.
        if (loaded) followed.add(agent.entries.length + 1);
        agent.append(reset);
      } else if (step === "disconnect" && connected) {
        connected = false;
        agent.window = null;
        mirror.close();
      } else if (step === "reconnect" && !connected) connect();
      else if (step === "load" && connected) {
        await load();
        expect(shownMessages(mirror.view.messages).map((message) => message.id)).toEqual(agent.active().map((entry) => String(entry.id)));
        const newest = Math.max(0, ...followed);
        if (newest > 0) expect(conversation.newest, "the newest reset made since the page loaded").toBe(newest);
      }
    }
    if (!connected) connect();
    await load();
    expect(shownMessages(mirror.view.messages).map((message) => message.id)).toEqual(agent.active().map((entry) => String(entry.id)));
    const newest = Math.max(0, ...followed);
    if (newest > 0) expect(conversation.newest).toBe(newest);
  }, { testCases: 300 }));
});
