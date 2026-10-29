/**
 * What the chat shows of each request the agent put on a card: the outcome on
 * the step that asked for it, not in a pile under the conversation. Pure, so
 * it is tested on its own (test/ui/operation-status.test.tsx).
 */
import type { TranscriptMessage } from "../protocol";
import type { ActivityEntry, ActivityResult, Card } from "../poppy/wire";
import { resultFacts } from "./result-facts";
import { proposedBy, type ToolDecision } from "./tool-line";
import { approvalResult, checkedOutcomeText, type ApprovalDecision } from "../poppy/approval-outcome";

type ApprovalCard = Extract<Card, { kind: "approval" }>;
type Photo = NonNullable<ApprovalCard["attachments"]>[number];

/** One approval's outcome, for the step that asked for it. */
export type ApprovalStep = ToolDecision & {
  /** The Company's HTTP status, when it answered. */
  readonly httpStatus: number | null;
  /** Its error code, when it answered with one. */
  readonly code: string | null;
  /** A few plain facts from what it answered (`resultFacts`); never a URL. */
  readonly facts: readonly string[];
  readonly attachments: readonly Photo[];
  readonly company: string;
};

function fromActivity(result: ActivityResult): ToolDecision["result"] {
  switch (result) {
    case "cancelled":
      return "declined";
    case "expired":
      return "failed";
    default:
      return result;
  }
}

/**
 * Fresh cards and Activity entries take precedence while present. Requested
 * durable decisions retain older outcomes after both presentation lists expire.
 */
export function stepDecisions(cards: readonly Card[], log: readonly ActivityEntry[] = [], durable: Readonly<Record<string, ApprovalDecision>> = {}): { approvals: ReadonlyMap<string, ApprovalStep> } {
  const approvals = new Map<string, ApprovalStep>();
  for (const card of cards) {
    if (card.kind !== "approval") continue;
    const { status: httpStatus, facts } = card.status === "done" ? resultFacts(card.result) : { status: card.answer?.status ?? null, facts: [] };
    approvals.set(card.approvalId, {
      result: approvalResult(card.status, card.outcomeResolution),
      photos: (card.attachments ?? []).map((photo) => photo.name),
      httpStatus,
      code: card.answer?.error ?? null,
      facts: card.outcomeResolution ? [checkedOutcomeText(card.company, card.outcomeResolution.outcome)] : facts,
      attachments: card.attachments ?? [],
      company: card.company
    });
  }
  for (const entry of log) {
    if (entry.kind === "approval" && entry.id.startsWith("approval-")) {
      const id = entry.id.slice("approval-".length);
      if (!approvals.has(id)) approvals.set(id, {
        result: fromActivity(entry.result), httpStatus: null, code: null,
        facts: entry.outcomeBy === "you" && entry.outcome ? [entry.outcome] : [],
        attachments: [], company: entry.company
      });
    }
  }
  for (const item of Object.values(durable)) {
    if (!approvals.has(item.approvalId)) approvals.set(item.approvalId, {
      result: item.result, httpStatus: null, code: null, attachments: [], company: item.company,
      facts: item.outcomeResolution ? [checkedOutcomeText(item.company, item.outcomeResolution.outcome)] : []
    });
  }
  return { approvals };
}

/** The approvals a step in the conversation asked for: their outcome shows on that step, so they need no line of their own. */
export function approvalsOnSteps(messages: readonly TranscriptMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-result") continue;
      const proposed = proposedBy({ error: part.error, ...(part.details !== undefined ? { details: part.details } : {}) });
      if (proposed) ids.add(proposed.approvalId);
    }
  }
  return ids;
}

/**
 * Requests waiting for the User, with uploads that may be decided together
 * gathered into batches: two or more open, pending approvals with the same
 * `batchKey` (the User's photos to one Company's same method and URL). Every
 * other card stays on its own, in order; a batch takes its first card's place.
 */
export type PanelEntry = { readonly kind: "card"; readonly card: Card } | { readonly kind: "batch"; readonly key: string; readonly cards: readonly ApprovalCard[] };

export function approvalBatches(cards: readonly Card[]): PanelEntry[] {
  const groups = new Map<string, ApprovalCard[]>();
  for (const card of cards) {
    if (card.kind === "approval" && card.open && card.status === "pending" && card.batchKey !== undefined) {
      const group = groups.get(card.batchKey) ?? [];
      group.push(card);
      groups.set(card.batchKey, group);
    }
  }
  const placed = new Set<string>();
  return cards.flatMap((card): PanelEntry[] => {
    const key = card.kind === "approval" && card.open && card.status === "pending" ? card.batchKey : undefined;
    const group = key === undefined ? undefined : groups.get(key);
    if (key === undefined || !group || group.length < 2) return [{ kind: "card", card }];
    if (placed.has(key)) return [];
    placed.add(key);
    return [{ kind: "batch", key, cards: group }];
  });
}

/** "Send your photo “a.jpg” (JPEG, 1 MB) to Acme: POST /photos" → "Acme: POST /photos": where a photo upload goes. */
function uploadTarget(entry: ActivityEntry): string | null {
  if (entry.kind !== "approval" || !entry.quote) return null;
  const match = /^Send your photos? “.*?” \([^)]*\) to (.+)$/s.exec(entry.quote);
  return match ? match[1]! : null;
}

/** A photo upload approved within this long of the one beside it counts as the same batch in Activity. */
const BATCH_WINDOW_MS = 10 * 60_000;

/**
 * Activity's log, newest first, with photo uploads to one Company's same
 * address, one after another, gathered into one row that opens to show each.
 */
export function activityGroups(entries: readonly ActivityEntry[]): ({ readonly kind: "entry"; readonly entry: ActivityEntry } | { readonly kind: "uploads"; readonly target: string; readonly entries: readonly ActivityEntry[] })[] {
  const out: ({ kind: "entry"; entry: ActivityEntry } | { kind: "uploads"; target: string; entries: ActivityEntry[] })[] = [];
  for (const entry of entries) {
    const target = uploadTarget(entry);
    const last = out.at(-1);
    const previous = last?.kind === "uploads" ? last.entries.at(-1)! : last?.kind === "entry" ? last.entry : undefined;
    if (target && previous && previous.issuer === entry.issuer && uploadTarget(previous) === target && Math.abs(previous.at - entry.at) <= BATCH_WINDOW_MS) {
      if (last!.kind === "uploads") last!.entries.push(entry);
      else out[out.length - 1] = { kind: "uploads", target, entries: [previous, entry] };
      continue;
    }
    out.push({ kind: "entry", entry });
  }
  return out;
}
