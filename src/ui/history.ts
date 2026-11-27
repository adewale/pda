import type { TranscriptMessage } from "../protocol";

/**
 * The page's side of the transcript's history. pi's conversation view holds
 * a window of the newest entries; the example's `PiSessionMirror` merges each
 * view into pi's `ConversationTranscript` and pages earlier entries in, back
 * to the newest reset, summaries included where pi placed them. A summary of
 * earlier conversation is projected as a `summary` message, which the page
 * shows as a notice; a `gap` stands for entries the page skipped after a
 * stall or a reconnect, until they are loaded.
 */

/** The words the page shows in place of a summary. */
export const SUMMARY_NOTICE = "Earlier conversation summarised";

/** The messages the page shows: everything but gaps, which are loaded instead. */
export function shownMessages(messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
  return messages.some((message) => message.role === "gap") ? messages.filter((message) => message.role !== "gap") : messages;
}

/** The first gap among `messages`, to load next, or null. */
export function firstGap(messages: readonly TranscriptMessage[]): Extract<TranscriptMessage, { role: "gap" }> | null {
  for (const message of messages) if (message.role === "gap") return message;
  return null;
}

/**
 * Which conversation the page is in. `epoch` counts the resets this page has
 * seen arrive since it loaded; `newest` is the newest reset's entry id, `null`
 * when there has been none, and `undefined` until the first view; `seen` is
 * the newest entry id the page has had.
 */
export type Conversation = {
  readonly epoch: number;
  readonly newest: number | null | undefined;
  readonly seen: number;
};

export const FIRST_CONVERSATION: Conversation = { epoch: 0, newest: undefined, seen: 0 };

/** Entry ids of messages; `live` and gaps have none. */
function entryId(message: TranscriptMessage): number | null {
  if (message.role === "gap") return null;
  const id = Number(message.id);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Moves to a new conversation on a reset newer than every entry the page had
 * (one made live, or in another tab while this one was away). The first view
 * only sets where the page starts: a reset made before the page loaded is the
 * conversation it loaded into. A reset found by paging back is older than
 * entries the page already had, so it starts nothing. The count never goes
 * back. pi projects a reset, and nothing else, as a `notice`.
 */
export function followResets(conversation: Conversation, messages: readonly TranscriptMessage[]): Conversation {
  let { epoch, newest, seen } = conversation;
  let newestSeen = seen;
  let found: number | null = null;
  for (const message of messages) {
    const id = entryId(message);
    if (id === null) continue;
    newestSeen = Math.max(newestSeen, id);
    if (message.role === "notice" && (found === null || id > found)) found = id;
  }
  if (newest === undefined) {
    if (messages.length === 0) return conversation;
    return { epoch, newest: found, seen: newestSeen };
  }
  if (found !== null && found > seen && (newest === null || found > newest)) {
    epoch++;
    newest = found;
  }
  return { epoch, newest, seen: newestSeen };
}
