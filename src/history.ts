import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Cursor, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import { LifecycleCapability } from "agents/lifecycle";
import { plainUnits, type Units } from "./log";

/**
 * The messages before a summary, for the page. pi's snapshot holds only the
 * model's active context, which after a compaction starts at the summary;
 * the entries before it are still in storage. The page asks for them with
 * `history.before` and shows them above the summary's notice, so a reload
 * doesn't lose what the person can scroll back to.
 */

/** page → agent: entries before `before`, newest first in the agent, oldest first on the wire. */
export type HistoryRequest = { readonly type: "history.before"; readonly before: number };

/** agent → page: up to `HISTORY_PAGE` entries before `before`, oldest first; `more` when older ones remain. */
export type HistoryFrame = {
  readonly type: "history";
  readonly before: number;
  readonly entries: readonly EntryRecord[];
  readonly more: boolean;
};

/** Entries per answer; the page asks again from the oldest while `more`. */
export const HISTORY_PAGE = 500;

/**
 * The root conversation's entries before `before`, oldest first, back to the
 * newest reset (included: the page shows a reset as a notice, and nothing
 * before it, as pi's own view does).
 */
export async function entriesBefore(harness: PiHarness, before: number, limit = HISTORY_PAGE): Promise<{ entries: EntryRecord[]; more: boolean }> {
  if (!Number.isSafeInteger(before) || before <= 1) return { entries: [], more: false };
  const pi = await harness.pi();
  const conversation = await pi.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
  if (!conversation) return { entries: [], more: false };
  const found: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await conversation.entries(
      { maxEntryId: (before - 1) as EntryId, order: "descending" },
      100,
      cursor,
      BACKGROUND_CONTEXT
    );
    for (const entry of page.items) {
      // Prompt and tool definitions: the page never shows them.
      if (entry.kind === "pi.system") continue;
      found.push(entry);
      if (entry.kind === "pi.reset") return { entries: found.reverse(), more: false };
      if (found.length > limit) {
        found.pop();
        return { entries: found.reverse(), more: true };
      }
    }
    if (page.next === undefined) return { entries: found.reverse(), more: false };
    cursor = page.next;
  }
}

/** Answers the page's `history.before` frames; everything else goes on to the next capability. */
export class TranscriptHistory extends LifecycleCapability {
  readonly #harness: PiHarness;
  readonly #units: Units;

  constructor(harness: PiHarness, units: Units = plainUnits) {
    super("history");
    this.#harness = harness;
    this.#units = units;
  }

  async onWebSocketMessage(socket: WebSocket, message: string | ArrayBuffer | ArrayBufferView): Promise<boolean> {
    if (typeof message !== "string" || !message.includes('"history.before"')) return false;
    let frame: Partial<HistoryRequest>;
    try {
      frame = JSON.parse(message) as Partial<HistoryRequest>;
    } catch {
      return false;
    }
    if (frame?.type !== "history.before") return false;
    const before = Number(frame.before);
    try {
      const { entries, more } = await entriesBefore(this.#harness, before);
      const answer: HistoryFrame = { type: "history", before, entries, more };
      socket.send(JSON.stringify(answer));
    } catch (error) {
      // A read that worked needs no event; one that failed gets its own.
      await this.#units.frame("history.before", {}, async (event) => void event.fail(error));
    }
    return true;
  }
}
