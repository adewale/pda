import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import type { TranscriptMessage } from "../protocol";

/**
 * The page's side of compaction. pi places a summary of earlier
 * conversation in an entry of kind `pi.compaction`, whose model message is a
 * user message, so the example's view would show it as something the person
 * said. The page shows it as a notice instead, and after a reload asks the
 * agent for the entries before it (`src/history.ts`), which pi's snapshot
 * leaves out, so the person can still scroll back to them.
 */

/** The kind of the entry pi-durable places a summary in. */
export const SUMMARY_KIND = "pi.compaction";

/** The words the page shows in place of a summary. */
export const SUMMARY_NOTICE = "Earlier conversation summarised";

/** Every entry the events carry. */
function entriesOf(events: readonly AgentEvent[]): EntryRecord[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case "snapshot":
        return [...event.entries];
      case "entry_appended":
      case "message_end":
        return [event.entry];
      default:
        return [];
    }
  });
}

/** Ids, as the transcript names messages, of the summaries among `entries`. */
export function summaryIds(entries: readonly EntryRecord[]): string[] {
  return entries.filter((entry) => entry.kind === SUMMARY_KIND).map((entry) => String(entry.id));
}

/** What a batch of events means for the page's history. */
export function historyFromEvents(events: readonly AgentEvent[]): {
  /** Summaries the events carry. */
  readonly summaries: string[];
  /** A snapshot starts with a summary: ask for the entries before this id. */
  readonly askBefore: number | null;
  /** A snapshot, or a reset: earlier messages fetched before no longer apply. */
  readonly clear: boolean;
} {
  let askBefore: number | null = null;
  let clear = false;
  for (const event of events) {
    if (event.type === "snapshot") {
      clear = true;
      askBefore = null;
      const head = event.entries[0];
      if (head?.kind === SUMMARY_KIND && head.head !== undefined) askBefore = Number(head.head);
    } else if ((event.type === "entry_appended" || event.type === "message_end") && event.entry.kind === "pi.reset") {
      clear = true;
      askBefore = null;
    }
  }
  return { summaries: summaryIds(entriesOf(events)), askBefore, clear };
}

/** Message ids are pi entry ids; `live` (the message being streamed) sorts last. */
function order(id: string): number {
  const number = Number(id);
  return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
}

/**
 * The earlier messages and the view's, once each, in the order pi wrote
 * them. pi's snapshot puts a summary first (it heads the model's context);
 * by entry id it sits where it was made, after the messages it kept, as it
 * does when it arrives live.
 */
export function withEarlier(earlier: readonly TranscriptMessage[], messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
  if (earlier.length === 0 && !messages.some((message, index) => index > 0 && order(message.id) < order(messages[index - 1]!.id))) {
    return messages;
  }
  const seen = new Set<string>();
  const all: TranscriptMessage[] = [];
  for (const message of [...earlier, ...messages]) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    all.push(message);
  }
  return all.sort((a, b) => order(a.id) - order(b.id));
}
