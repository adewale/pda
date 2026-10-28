/**
 * Operations, version 2 (0.3 Ops): a Company refuses a write that needs the
 * User's approval with the operation, its terms in plain words; the User
 * approves that one revision on our card; and the same request goes again
 * with the approval, which the Company performs at most once. No endpoints,
 * no confirm or cancel, no standing permissions. The request travels in the
 * local approval machinery (operations.ts `proposeLocal`), so the approved
 * request is stored exactly, checked again before it is sent, and sent once.
 */
import type { Company } from "./discovery";
import { isObject, type Json } from "./json";
import { sha256 } from "./jwt";

/** An operation as the Company returns it (Ops 3), after the checks below. */
export type OperationV2 = {
  readonly operation_id: string;
  readonly revision: string;
  readonly summary: string;
  readonly terms?: Json;
  readonly expires_at: string;
};

/** What an approval names (Ops 6), and when it stops being accepted. */
export type ApprovalV2 = { readonly operation_id: string; readonly revision: string; readonly expires_at: string };

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
/** The longest summary we show: the Company's words, which the User reads in full. */
const SUMMARY_LIMIT = 4_000;

/**
 * An operation, or why it can't be used: ids with the characters of
 * Conversation IDs, a summary, `terms` an object when present, and an
 * RFC 3339 `expires_at` (Ops 3).
 */
export function parseOperationV2(value: Json | undefined): OperationV2 | { readonly problem: string } {
  if (!isObject(value)) return { problem: "it isn't an object" };
  const { operation_id: id, revision, summary, terms, expires_at: expiresAt } = value;
  if (typeof id !== "string" || !ID.test(id)) return { problem: "its operation_id isn't 1 to 256 URL-safe characters" };
  if (typeof revision !== "string" || !ID.test(revision)) return { problem: "its revision isn't 1 to 256 URL-safe characters" };
  if (typeof summary !== "string" || summary.trim() === "") return { problem: "it has no summary" };
  if (summary.length > SUMMARY_LIMIT) return { problem: "its summary is too long to show" };
  if (terms !== undefined && !isObject(terms)) return { problem: "its terms aren't an object" };
  if (typeof expiresAt !== "string" || !RFC3339.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) return { problem: "its expires_at isn't an RFC 3339 time" };
  return { operation_id: id, revision, summary, ...(terms !== undefined ? { terms } : {}), expires_at: expiresAt };
}

/** Whether an approval can still be sent: before the revision's `expires_at` (Ops 3, "Expiry"). */
export function approvable(approval: ApprovalV2, now: number): boolean {
  return Date.parse(approval.expires_at) > now;
}

/** An RFC 9651 String: printable ASCII, with `"` and `\` escaped (RFC 9651 4.1.6). */
function sfString(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new Error("Not an RFC 9651 String");
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/** `Poppy-Approval`: a Dictionary with `operation_id` and `revision` as Strings (Ops 6). */
export function approvalHeader(approval: Pick<ApprovalV2, "operation_id" | "revision">): string {
  return `operation_id=${sfString(approval.operation_id)}, revision=${sfString(approval.revision)}`;
}

/** The approval as JSON, for MCP's `_meta` and a message's `approval` (Ops 6). */
export function approvalJson(approval: Pick<ApprovalV2, "operation_id" | "revision">): { operation_id: string; revision: string } {
  return { operation_id: approval.operation_id, revision: approval.revision };
}

/**
 * The card's words: the Company's name and the revision's summary, as the
 * Company wrote it (Ops 5). The card shows it as text, so a link, image or
 * HTML in it is shown, never followed or loaded (Ops 3, "Formatting").
 */
export function approvalSummary(company: Company, operation: OperationV2): string {
  return `${company.name} asks for your approval before it does this: ${operation.summary.trim()} (Approval needed by ${operation.expires_at}.)`;
}

/** One card per revision, so a replayed answer shows the same card rather than a second one. */
export async function approvalCardId(company: Company, operation: OperationV2): Promise<string> {
  return `apr2_${(await sha256(`${company.issuer} ${operation.operation_id} ${operation.revision}`)).slice(0, 22)}`;
}

/** What the model is told: nothing has happened; the User decides (Ops 5). */
export function approvalForModel(company: Company, operation: OperationV2, status: number): Json {
  return {
    status,
    approval_required: { issuer: company.issuer, operation_id: operation.operation_id, revision: operation.revision, summary: operation.summary, expires_at: operation.expires_at },
    note: "Nothing has happened yet. The User decides on the approval card; don't treat the action as done, and don't approve it for them."
  };
}
