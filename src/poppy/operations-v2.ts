/**
 * Operations, version 2 (0.3 Ops) and version 3 (0.4 Ops): a Company refuses
 * a write that needs approval with the operation, its terms; the User
 * approves that one revision on our card; and the same request goes again
 * with the approval, which the Company performs at most once. No confirm or
 * cancel. The request travels in the local approval machinery (operations.ts
 * `proposeLocal`), so the approved request is stored exactly, checked again
 * before it is sent, and sent once. Version 3 requires `terms`, makes
 * `summary` optional, and has each approval say who approved it.
 */
import type { Company } from "./discovery";
import { array, object, optional, string } from "../decode";
import { isObject, type Json } from "./json";
import { sha256 } from "./jwt";
import type { ApprovalTerms } from "./wire";

/** An approval's terms as `poppy_approvals.terms` stores them (operations.ts `approvalTerms`). */
export const approvalTermsDecoder = object({
  summary: string,
  expiresAt: string,
  highlights: array(string),
  total: optional(object({ amount: string, currency: string })),
  previews: optional(array(object({ label: string, url: string }))),
  differences: optional(array(string))
}) satisfies (value: unknown, at: string) => ApprovalTerms;

/** An operation as the Company returns it (Ops 3), after the checks below: version 2 always has `summary`, version 3 always `terms`. */
export type OperationV2 = {
  readonly operation_id: string;
  readonly revision: string;
  readonly summary?: string;
  readonly terms?: Json;
  readonly expires_at: string;
};

/** What an approval names (Ops 6), and when it stops being accepted. */
export type ApprovalV2 = { readonly operation_id: string; readonly revision: string; readonly expires_at: string };

/**
 * What a version 3 approval also says (0.4 Ops 6), added as it is sent and
 * never stored with the request: who approved, when, how the User answered,
 * and our approval record's ID as `reference`.
 */
export type ApprovalStatement = {
  readonly approver: "user" | "agent";
  readonly approved_at: number;
  readonly input_type?: string;
  readonly reference: string;
};
export type SentApproval = Pick<ApprovalV2, "operation_id" | "revision"> & Partial<ApprovalStatement>;
/** A stored approval with its statement, as an executor sends it. */
export type ApprovalToSend = ApprovalV2 & Partial<ApprovalStatement>;

/** The Operations version a Company's Sessions use: 3 under 0.4, 2 under 0.3, and none when it doesn't list the extension. */
export function operationsVersion(company: Company): "2" | "3" | null {
  if (!company.extensions.operations) return null;
  return company.protocolVersion === "0.3" ? "2" : "3";
}

/** Whether an approval at this Company holds in another Session of the same agent and User (0.4 Ops 3; `sameAuthority`). */
export function approvesAcrossSessions(company: Company): boolean {
  return operationsVersion(company) === "3";
}

/**
 * The statement a version 3 approval carries (0.4 Ops 6), or nothing under
 * version 2. Every approval so far is the User's, given by pressing the
 * card's button; `reference` is the approval's own ID, unique per approval
 * and derived per Company or random, so it never reaches two Companies.
 */
export function approvalStatement(company: Company, approval: { readonly approvalId: string; readonly approvedAt: number }): Partial<ApprovalStatement> {
  if (operationsVersion(company) !== "3") return {};
  return { approver: "user", approved_at: Math.floor(approval.approvedAt / 1000), input_type: "tap", reference: approval.approvalId };
}

/** A stored approval as it is sent: with the statement under version 3 (0.4 Ops 6). */
export function toSend(company: Company, approval: ApprovalV2, execution: { readonly approvalId: string; readonly approvedAt: number }): ApprovalToSend {
  return { ...approval, ...approvalStatement(company, execution) };
}

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Check calendar fields before Date.parse, which rolls 30 February into March. */
function validExpiry(value: string): boolean {
  const match = RFC3339.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : MONTH_DAYS[month - 1];
  return days !== undefined && day >= 1 && day <= days
    && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59
    && (match[7] === undefined || (Number(match[7]) <= 23 && Number(match[8]) <= 59))
    && Number.isFinite(Date.parse(value));
}
/** The longest summary we show: the Company's words, which the User reads in full. */
const SUMMARY_LIMIT = 4_000;

/**
 * An operation, or why it can't be used: ids with the characters of
 * Conversation IDs, an RFC 3339 `expires_at`, and its terms (Ops 3). Under
 * version 2 a summary, and `terms` an object when present; under version 3
 * `terms` an object, and a summary when present. Without a summary the
 * card shows every value in `terms`, so they must fit on it.
 */
export function parseOperationV2(value: Json | undefined, version: "2" | "3" = "2"): OperationV2 | { readonly problem: string } {
  if (!isObject(value)) return { problem: "it isn't an object" };
  const { operation_id: id, revision, summary, terms, expires_at: expiresAt } = value;
  if (typeof id !== "string" || !ID.test(id)) return { problem: "its operation_id isn't 1 to 256 URL-safe characters" };
  if (typeof revision !== "string" || !ID.test(revision)) return { problem: "its revision isn't 1 to 256 URL-safe characters" };
  if (version === "3" ? summary !== undefined && typeof summary !== "string" : typeof summary !== "string" || summary.trim() === "") return { problem: "it has no summary" };
  if (typeof summary === "string" && summary.length > SUMMARY_LIMIT) return { problem: "its summary is too long to show" };
  if (version === "3" && terms === undefined) return { problem: "it has no terms" };
  if (terms !== undefined && !isObject(terms)) return { problem: "its terms aren't an object" };
  if (typeof expiresAt !== "string" || !validExpiry(expiresAt)) return { problem: "its expires_at isn't an RFC 3339 time" };
  // A blank summary says nothing, so the terms are shown instead.
  const shown = typeof summary === "string" && summary.trim() !== "" ? summary : undefined;
  const operation: OperationV2 = { operation_id: id, revision, ...(shown !== undefined ? { summary: shown } : {}), ...(terms !== undefined ? { terms } : {}), expires_at: expiresAt };
  if (shown === undefined && described(operation).length > SUMMARY_LIMIT) return { problem: "it has no summary, and its terms are too long to show" };
  return operation;
}

/**
 * Every value in `terms`, each labelled with its path, such as
 * `price_difference.amount: 70.00`. Nothing is left out or reworded, so
 * the User decides on the exact terms (Ops 5).
 */
export function labelledTerms(terms: Json | undefined): string[] {
  const lines: string[] = [];
  const walk = (value: Json, path: string) => {
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${path}: (none)`);
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (isObject(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0 && path) lines.push(`${path}: (none)`);
      for (const [key, item] of entries) walk(item, path ? `${path}.${key}` : key);
    } else {
      lines.push(`${path}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  };
  if (terms !== undefined) walk(terms, "");
  return lines;
}

/** What the card says the terms are: the Company's summary, or else every value in `terms` (Ops 3, 5). */
export function described(operation: Pick<OperationV2, "summary" | "terms">): string {
  return operation.summary?.trim() ?? `The terms: ${labelledTerms(operation.terms).join("; ")}.`;
}

/** Whether an approval can still be sent: before the revision's `expires_at` (Ops 3, "Expiry"). */
export function approvable(approval: ApprovalV2, now: number): boolean {
  return Date.parse(approval.expires_at) > now;
}

/** An RFC 9651 String: printable ASCII, with `"` and `\` escaped (RFC 9651 4.1.6). */
export function sfString(value: string): string {
  if (!/^[\x20-\x7e]*$/.test(value)) throw new Error("Not an RFC 9651 String");
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/**
 * `Poppy-Approval`: a Dictionary with `operation_id` and `revision` as
 * Strings (Ops 6), and under version 3 the statement's members, with
 * `approved_at` as an Integer.
 */
export function approvalHeader(approval: SentApproval): string {
  return Object.entries(approvalJson(approval))
    .map(([key, value]) => `${key}=${typeof value === "number" ? String(value) : sfString(value)}`)
    .join(", ");
}

/** The approval as JSON, for MCP's `_meta` and a message's `approval` (Ops 6). */
export function approvalJson(approval: SentApproval): { operation_id: string; revision: string } & Partial<ApprovalStatement> {
  const { operation_id, revision, approver, approved_at, input_type, reference } = approval;
  return {
    operation_id,
    revision,
    ...(approver !== undefined ? { approver } : {}),
    ...(approved_at !== undefined ? { approved_at } : {}),
    // Never with an agent approval (0.4 Ops 6).
    ...(input_type !== undefined && approver === "user" ? { input_type } : {}),
    ...(reference !== undefined ? { reference } : {})
  };
}

/**
 * The card's words: the Company's name and the revision's summary, as the
 * Company wrote it (Ops 5). The card shows it as text, so a link, image or
 * HTML in it is shown, never followed or loaded (Ops 3, "Formatting").
 */
export function approvalSummary(company: Company, operation: OperationV2): string {
  return `${company.name} asks for your approval before it does this: ${described(operation)} (Approval needed by ${operation.expires_at}.)`;
}

/** One card per revision, so a replayed answer shows the same card rather than a second one. */
export async function approvalCardId(company: Company, operation: OperationV2): Promise<string> {
  return `apr2_${(await sha256(`${company.issuer} ${operation.operation_id} ${operation.revision}`)).slice(0, 22)}`;
}

/** What the model is told: nothing has happened; the User decides (Ops 5). */
export function approvalForModel(company: Company, operation: OperationV2, status: number, approvalId: string): Json {
  return {
    status,
    // The card's approval id, so the chat shows the User's decision on the step that asked.
    proposed: approvalId,
    approval_required: { issuer: company.issuer, operation_id: operation.operation_id, revision: operation.revision, summary: described(operation), expires_at: operation.expires_at },
    note: "Nothing has happened yet. The User decides on the approval card; don't treat the action as done, and don't approve it for them."
  };
}
