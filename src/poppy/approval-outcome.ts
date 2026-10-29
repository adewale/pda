/** Our task-dispatch records share recovery with approvals, but never imply a confirmation click. */
export function isTaskRequest(id: string): boolean { return id.startsWith("req_"); }

/** The original attempt and the User's later assertion are independent facts. */
export const APPROVAL_STATUSES = ["pending", "executing", "declined", "done", "terms", "refused", "failed", "unknown"] as const;
export type ApprovalStatus = typeof APPROVAL_STATUSES[number];
export type ApprovalCardStatus = Exclude<ApprovalStatus, "executing"> | "approved";
export type ApprovalResult = "waiting" | "in_progress" | "declined" | "done" | "failed" | "unknown";
export type CheckedOutcome = "performed" | "not_performed";
export type OutcomeResolution = { readonly outcome: CheckedOutcome; readonly at: number };

const RESULTS: Record<ApprovalStatus | "approved", ApprovalResult> = {
  pending: "waiting", executing: "in_progress", approved: "in_progress", declined: "declined",
  done: "done", terms: "waiting", refused: "failed", failed: "failed", unknown: "unknown"
};

export function approvalResult(status: ApprovalStatus | "approved", resolution?: OutcomeResolution): ApprovalResult {
  return resolution ? (resolution.outcome === "performed" ? "done" : "failed") : RESULTS[status];
}

/** Convert nullable database columns without inventing a partial assertion. */
export function storedResolution(row: { readonly outcome_resolution: CheckedOutcome | null; readonly outcome_resolved_at: number | null }): OutcomeResolution | undefined {
  return row.outcome_resolution !== null && row.outcome_resolved_at !== null
    ? { outcome: row.outcome_resolution, at: row.outcome_resolved_at } : undefined;
}

export function checkedOutcomeText(company: string, outcome: CheckedOutcome): string {
  return `You checked with ${company}: this action ${outcome === "performed" ? "happened" : "did not happen"}. The original uncertain receipt is retained; no request was resent.`;
}

/** A safe durable projection, separate from the bounded Activity feed and receipt visibility. */
export type ApprovalDecision = {
  readonly approvalId: string;
  readonly company: string;
  readonly result: ApprovalResult;
  readonly outcomeResolution?: OutcomeResolution;
};

export const APPROVAL_READ_LIMIT = 100;

export function isApprovalId(value: unknown): value is string {
  return typeof value === "string" && /^apr2?_[A-Za-z0-9_-]{1,256}$/.test(value);
}
