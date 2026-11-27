import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { TranscriptMessage } from "../../src/protocol";
import { projectEntries } from "../../src/transcript";
import { FIRST_CONVERSATION, firstGap, followResets, shownMessages, SUMMARY_NOTICE } from "../../src/ui/history";
import { Transcript } from "../../src/ui/transcript";

/**
 * The page's history (`src/ui/history.ts`): pi gives the model its summary
 * as a user message in a `pi.compaction` entry, which the example projects
 * as a `summary` message and the page shows as a notice, where pi placed it;
 * the page follows resets as they arrive, not as paging back finds them.
 */

const SUMMARY_TEXT =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## The User's goals\nA size L jumper.\n</summary>";

function entry(id: number, kind: string, role: "user" | "assistant", text: string, head?: number): EntryRecord {
  const model =
    role === "user"
      ? [{ role, content: text, timestamp: id }]
      : [{ role, content: [{ type: "text", text }], api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: id }];
  return { id, conversationId: 1, kind, model, ...(head === undefined ? {} : { head }) } as unknown as EntryRecord;
}

const earlier = [entry(2, "pi.user", "user", "Find me a jumper"), entry(3, "pi.assistant", "assistant", "Which size?")];
const kept = [entry(5, "pi.user", "user", "Size L"), entry(6, "pi.assistant", "assistant", "Found one.")];
const summary = entry(9, "pi.compaction", "user", SUMMARY_TEXT, 5);
const after = entry(10, "pi.user", "user", "Buy it");
const reset = (id: number) => ({ id, conversationId: 1, kind: "pi.reset", head: id }) as unknown as EntryRecord;
const gap = (after: number, upTo: number): TranscriptMessage => ({ id: `gap-${after}-${upTo}`, role: "gap", parts: [], timestamp: 0, after: after as EntryId, upTo: upTo as EntryId });

describe("followResets", () => {
  it("starts where the first view is, even after a reset made before the page loaded", () => {
    expect(followResets(FIRST_CONVERSATION, projectEntries([reset(4), after]))).toMatchObject({ epoch: 0, newest: 4, seen: 10 });
    expect(followResets(FIRST_CONVERSATION, projectEntries([...kept, after]))).toMatchObject({ epoch: 0, newest: null, seen: 10 });
  });

  it("starts from an empty first view, and counts what turns up before a later window as new", () => {
    const empty = followResets(FIRST_CONVERSATION, []);
    expect(empty).toEqual({ epoch: 0, newest: null, seen: 0, whole: true });
    // Back after another tab cleared chat and wrote on: the view starts at 2, with entry 1 still to load.
    const back = followResets(empty, projectEntries([entry(2, "pi.user", "user", "One"), entry(3, "pi.user", "user", "Two")]), true);
    expect(back).toMatchObject({ epoch: 0, seen: 0 });
    expect(followResets(back, projectEntries([reset(1), entry(2, "pi.user", "user", "One"), entry(3, "pi.user", "user", "Two")]))).toMatchObject({ epoch: 1, newest: 1, seen: 3 });
  });

  it("pages back without starting anything when the first view held only the newest entries", () => {
    const loaded = followResets(FIRST_CONVERSATION, projectEntries([after]), true);
    expect(loaded).toEqual({ epoch: 0, newest: null, seen: 10, whole: false });
    expect(followResets(loaded, projectEntries([reset(4), ...kept, after]), false)).toMatchObject({ epoch: 0, newest: null });
  });

  it("moves on for a reset that arrives live, or after a reconnect, once each", () => {
    const loaded = followResets(FIRST_CONVERSATION, projectEntries([...kept, after]));
    const live = followResets(loaded, projectEntries([...kept, after, reset(12)]));
    expect(live).toMatchObject({ epoch: 1, newest: 12, seen: 12 });
    expect(followResets(live, projectEntries([reset(12), entry(13, "pi.user", "user", "Hello")]))).toMatchObject({ epoch: 1, newest: 12, seen: 13 });
    expect(followResets(live, projectEntries([reset(20)]))).toMatchObject({ epoch: 2, newest: 20, seen: 20 });
  });

  it("starts nothing for a reset found by paging back, older than what the page had", () => {
    const loaded = followResets(FIRST_CONVERSATION, projectEntries([...kept, after]));
    expect(followResets(loaded, projectEntries([reset(4), ...kept, after]))).toMatchObject({ epoch: 0, newest: null, seen: 10 });
  });

  it("moves on for a reset found in the gap a reconnect left, newer than what the page had", () => {
    const loaded = followResets(FIRST_CONVERSATION, projectEntries([...kept, after]));
    // Back after a while: the view starts at 40, with what lies between 10 and 40 still to load.
    const back = followResets(loaded, [...projectEntries([...kept, after]), gap(10, 40), ...projectEntries([entry(40, "pi.user", "user", "Latest")])]);
    expect(back).toMatchObject({ epoch: 0, newest: null, seen: 10 });
    // Loading the gap finds the other tab's reset at 20: from it on is the conversation now.
    expect(followResets(back, projectEntries([reset(20), entry(40, "pi.user", "user", "Latest")]))).toMatchObject({ epoch: 1, newest: 20, seen: 40 });
  });

  it("never goes back, when a later view no longer holds the reset", () => {
    const live = followResets(followResets(FIRST_CONVERSATION, projectEntries([after])), projectEntries([after, reset(12)]));
    expect(followResets(live, projectEntries([summary, after]))).toEqual(live);
  });
});

describe("gaps", () => {
  it("shows no gap, and names the first one to load", () => {
    const messages = [...projectEntries(kept), gap(6, 9), ...projectEntries([after]), gap(10, 12)];
    expect(shownMessages(messages).map((message) => message.id)).toEqual(["5", "6", "10"]);
    expect(firstGap(messages)?.id).toBe("gap-6-9");
    const none = projectEntries([...kept, after]);
    expect(shownMessages(none)).toBe(none);
    expect(firstGap(none)).toBeNull();
  });
});

describe("the transcript after a compaction", () => {
  const messages: TranscriptMessage[] = projectEntries([...earlier, ...kept, summary, after]);

  it("shows the summary as a notice, not as something the User said, with the messages before it still there", () => {
    const { container } = render(<Transcript messages={messages} live={null} runningTools={[]} />);
    expect(screen.getByText(SUMMARY_NOTICE)).toBeTruthy();
    expect(SUMMARY_NOTICE).toBe("Earlier conversation summarised");
    expect(screen.getByText("Find me a jumper")).toBeTruthy();
    expect(screen.getByText("Buy it")).toBeTruthy();
    // pi's wrapper for the model isn't shown; the summary itself is behind a disclosure.
    expect(container.textContent).not.toContain("The conversation history before this point was compacted");
    const notice = container.querySelector("[data-summary]")!;
    expect(notice.querySelector("details")!.textContent).toContain("A size L jumper.");
    // In order: what came before, what was kept, the notice, what came after.
    const text = container.textContent!;
    expect(text.indexOf("Find me a jumper")).toBeLessThan(text.indexOf("Size L"));
    expect(text.indexOf("Found one.")).toBeLessThan(text.indexOf(SUMMARY_NOTICE));
    expect(text.indexOf(SUMMARY_NOTICE)).toBeLessThan(text.indexOf("Buy it"));
  });

  it("shows a user message as the User's when it isn't a summary, whatever it says", () => {
    const said = projectEntries([entry(9, "pi.user", "user", SUMMARY_TEXT)]);
    const { container } = render(<Transcript messages={said} live={null} runningTools={[]} />);
    expect(screen.queryByText(SUMMARY_NOTICE)).toBeNull();
    expect(container.textContent).toContain("The conversation history before this point was compacted");
  });
});
