import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import type { TranscriptMessage } from "../../src/protocol";
import { projectEntries } from "../../src/transcript";
import { historyFromEvents, SUMMARY_NOTICE, withEarlier } from "../../src/ui/history";
import { Transcript } from "../../src/ui/transcript";

/**
 * The page after a compaction (`src/ui/history.ts`): pi gives the model its
 * summary as a user message, and the page shows it as a notice instead;
 * after a reload, pi's snapshot starts at the summary, so the page asks the
 * agent for the messages before it and shows them above it.
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

function snapshot(entries: EntryRecord[]): AgentEvent {
  return { type: "snapshot", entries, tools: [], compactions: [], inbox: [], agent: {}, usage: {} } as unknown as AgentEvent;
}

describe("historyFromEvents", () => {
  it("asks for the entries before the first one a summary kept, when a snapshot starts with a summary", () => {
    expect(historyFromEvents([snapshot([summary, ...kept, after])])).toEqual({ summaries: ["9"], askBefore: 5, clear: true });
  });

  it("asks for nothing when the snapshot has no summary, and still clears what was fetched", () => {
    expect(historyFromEvents([snapshot([...kept, after])])).toEqual({ summaries: [], askBefore: null, clear: true });
  });

  it("names a summary that arrives live, without clearing anything", () => {
    expect(historyFromEvents([{ type: "entry_appended", entry: summary } as unknown as AgentEvent])).toEqual({ summaries: ["9"], askBefore: null, clear: false });
  });

  it("clears on a reset, as pi's own view does", () => {
    const reset = { id: 12, conversationId: 1, kind: "pi.reset", head: 12 } as unknown as EntryRecord;
    expect(historyFromEvents([{ type: "entry_appended", entry: reset } as unknown as AgentEvent]).clear).toBe(true);
  });
});

describe("withEarlier", () => {
  it("puts the earlier messages first and the summary where it was made, once each, as it does live", () => {
    const fromSnapshot = projectEntries([summary, ...kept, after]);
    const merged = withEarlier(projectEntries(earlier), fromSnapshot);
    expect(merged.map((message) => message.id)).toEqual(["2", "3", "5", "6", "9", "10"]);
    const live = projectEntries([...earlier, ...kept, summary, after]);
    expect(withEarlier([], live).map((message) => message.id)).toEqual(merged.map((message) => message.id));
    expect(withEarlier(projectEntries(earlier), [...projectEntries(earlier), ...fromSnapshot]).map((message) => message.id)).toEqual(["2", "3", "5", "6", "9", "10"]);
  });

  it("returns the view's own list when there is nothing to merge or reorder", () => {
    const messages = projectEntries([...kept, after]);
    expect(withEarlier([], messages)).toBe(messages);
  });
});

describe("the transcript after a compaction", () => {
  const messages: TranscriptMessage[] = [...withEarlier(projectEntries(earlier), projectEntries([summary, ...kept, after]))];

  it("shows the summary as a notice, not as something the User said, with the messages before it still there", () => {
    const { container } = render(<Transcript messages={messages} live={null} runningTools={[]} summaries={new Set(["9"])} />);
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

  it("shows a user message as the User's when it isn't a summary", () => {
    const { container } = render(<Transcript messages={messages} live={null} runningTools={[]} />);
    expect(screen.queryByText(SUMMARY_NOTICE)).toBeNull();
    expect(container.textContent).toContain("The conversation history before this point was compacted");
  });
});
