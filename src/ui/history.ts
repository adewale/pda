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
 * the newest entry id the page has had with nothing missing before it: the
 * entries after a gap a reconnect left, and those inside it once loaded, are
 * new to the page. `whole`: the first view held the conversation from its
 * start, so entries that later turn up before the window (pi's transcript
 * marks no gap after an empty first view) are new too.
 */
export type Conversation = {
  readonly epoch: number;
  readonly newest: number | null | undefined;
  readonly seen: number;
  readonly whole: boolean;
};

export const FIRST_CONVERSATION: Conversation = { epoch: 0, newest: undefined, seen: 0, whole: false };

/** Entry ids of messages; `live` and gaps have none. */
function entryId(message: TranscriptMessage): number | null {
  if (message.role === "gap") return null;
  const id = Number(message.id);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Moves to a new conversation on a reset newer than every entry the page had
 * (one made live, or in another tab while this one was away, even one that
 * arrives later, in the gap a reconnect left). The first view, empty or not,
 * only sets where the page starts: a reset made before the page loaded is the
 * conversation it loaded into. A reset found by paging back is older than
 * entries the page already had, so it starts nothing. The count never goes
 * back. pi projects a reset, and nothing else, as a `notice`. `earlier`: the
 * view's own flag, that entries before its first message are still to load.
 */
export function followResets(conversation: Conversation, messages: readonly TranscriptMessage[], earlier = false): Conversation {
  let { epoch, newest, seen } = conversation;
  const { whole } = conversation;
  let newestSeen = seen;
  let found: number | null = null;
  // A gap, or entries before the window of a page that had the whole conversation, are missing: what follows is new.
  let contiguous = newest === undefined || !(whole && earlier);
  for (const message of messages) {
    if (message.role === "gap") contiguous = false;
    const id = entryId(message);
    if (id === null) continue;
    if (contiguous) newestSeen = Math.max(newestSeen, id);
    if (message.role === "notice" && (found === null || id > found)) found = id;
  }
  if (newest === undefined) return { epoch, newest: found, seen: newestSeen, whole: !earlier };
  if (found !== null && found > seen && (newest === null || found > newest)) {
    epoch++;
    newest = found;
  }
  return { epoch, newest, seen: newestSeen, whole };
}
