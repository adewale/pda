/**
 * Operations version 3 (0.4 Ops): a Company refuses
 * a write that needs approval with the operation, its terms; the User
 * approves that one revision on our card; and the same request goes again
 * with the approval, which the Company performs at most once. No confirm or
 * cancel. The request travels in the local approval machinery (operations.ts
 * `proposeLocal`), so the approved request is stored exactly, checked again
 * before it is sent, and sent once. An operation has `terms` and may leave
 * out `summary`, and each approval says who approved it.
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

/** An operation as the Company returns it (Ops 3), after the checks below: it always has `terms`. */
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
 * What an approval also says (Ops 6), added as it is sent and
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

/** The Operations version a Company's Sessions use: 3, or none when it doesn't list the extension. */
export function operationsVersion(company: Company): "3" | null {
  return company.extensions.operations ? "3" : null;
}

/** Whether an approval at this Company holds in another Session of the same agent and User (Ops 3; `sameAuthority`). */
export function approvesAcrossSessions(company: Company): boolean {
  return operationsVersion(company) === "3";
}

/**
 * The statement an approval carries (Ops 6), or nothing at a Company that
 * doesn't list Operations: the User's, given by pressing the card's button, or the
 * agent's, on a standing instruction the User wrote (instructions.ts), with
 * no `input_type`. `reference` is the approval's own ID, the ledger entry
 * the User sees, unique per approval and derived per Company or random, so
 * it never reaches two Companies.
 */
export function approvalStatement(company: Company, approval: { readonly approvalId: string; readonly approvedAt: number; readonly approver?: "user" | "agent" }): Partial<ApprovalStatement> {
  if (operationsVersion(company) !== "3") return {};
  const approvedAt = Math.floor(approval.approvedAt / 1000);
  if (approval.approver === "agent") return { approver: "agent", approved_at: approvedAt, reference: approval.approvalId };
  return { approver: "user", approved_at: approvedAt, input_type: "tap", reference: approval.approvalId };
}

/** A stored approval as it is sent, with its statement (Ops 6). */
export function toSend(company: Company, approval: ApprovalV2, execution: { readonly approvalId: string; readonly approvedAt: number; readonly approver?: "user" | "agent" }): ApprovalToSend {
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
 * Conversation IDs, an RFC 3339 `expires_at`, `terms` an object, and a
 * summary when present. Without a summary the card shows every value in
 * `terms`, so they must fit on it.
 */
export function parseOperationV2(value: Json | undefined): OperationV2 | { readonly problem: string } {
  if (!isObject(value)) return { problem: "it isn't an object" };
  const { operation_id: id, revision, summary, terms, expires_at: expiresAt } = value;
  if (typeof id !== "string" || !ID.test(id)) return { problem: "its operation_id isn't 1 to 256 URL-safe characters" };
  if (typeof revision !== "string" || !ID.test(revision)) return { problem: "its revision isn't 1 to 256 URL-safe characters" };
  if (summary !== undefined && typeof summary !== "string") return { problem: "its summary isn't a string" };
  if (typeof summary === "string" && summary.length > SUMMARY_LIMIT) return { problem: "its summary is too long to show" };
  if (terms === undefined) return { problem: "it has no terms" };
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

/** One RFC 9651 bare item: a String's value, or null for another type, which a reader ignores. Undefined: not an item. */
function bareItem(rest: string): { readonly value: string | null; readonly rest: string } | undefined {
  if (rest.startsWith('"')) {
    let text = "";
    for (let i = 1; i < rest.length; i++) {
      const char = rest[i]!;
      if (char === "\\") {
        const next = rest[i + 1];
        if (next !== '"' && next !== "\\") return undefined;
        text += next;
        i++;
      } else if (char === '"') return { value: text, rest: rest.slice(i + 1) };
      else if (char < " " || char > "~") return undefined;
      else text += char;
    }
    return undefined;
  }
  const other = /^(?:\?[01]|:[A-Za-z0-9+/=]*:|-?\d{1,15}(?:\.\d{1,3})?|[A-Za-z*][!#$%&'*+\-.^_`|~:/\w]*|@-?\d{1,15}|%"(?:[^"\\]|\\.)*")/.exec(rest)?.[0];
  return other ? { value: null, rest: rest.slice(other.length) } : undefined;
}

/** Parameters after an item or inner list, which carry nothing a reader needs here. */
function skipParameters(rest: string): string | undefined {
  while (rest.startsWith(";")) {
    const key = /^;[ ]*[a-z*][a-z0-9_\-.*]*/.exec(rest)?.[0];
    if (!key) return undefined;
    rest = rest.slice(key.length);
    if (rest.startsWith("=")) {
      const item = bareItem(rest.slice(1));
      if (!item) return undefined;
      rest = item.rest;
    }
  }
  return rest;
}

/**
 * An RFC 9651 Dictionary's String members, by key, the last of a repeated
 * key winning (RFC 9651 4.2.2); members of other types are left out. Null
 * when the field doesn't parse, so it is ignored as a whole.
 */
export function dictionaryStrings(field: string): Record<string, string> | null {
  const members: Record<string, string> = {};
  let rest = field.replace(/^[ \t]+/, "");
  while (rest !== "") {
    const key = /^[a-z*][a-z0-9_\-.*]*/.exec(rest)?.[0];
    if (!key) return null;
    rest = rest.slice(key.length);
    let value: string | null = null;
    if (rest.startsWith("=")) {
      rest = rest.slice(1);
      if (rest.startsWith("(")) {
        rest = rest.slice(1);
        for (;;) {
          rest = rest.replace(/^ +/, "");
          if (rest.startsWith(")")) { rest = rest.slice(1); break; }
          const item = bareItem(rest);
          const after = item && skipParameters(item.rest);
          if (after === undefined || !/^[ )]/.test(after)) return null;
          rest = after;
        }
      } else {
        const item = bareItem(rest);
        if (!item) return null;
        value = item.value;
        rest = item.rest;
      }
    }
    const after = skipParameters(rest);
    if (after === undefined) return null;
    rest = after;
    delete members[key];
    if (value !== null) members[key] = value;
    rest = rest.replace(/^[ \t]*/, "");
    if (rest === "") break;
    if (!rest.startsWith(",")) return null;
    rest = rest.slice(1).replace(/^[ \t]*/, "");
    if (rest === "") return null;
  }
  return members;
}

/** A website's reference to an operation (0.4 Ops 4): at most 2048 of these characters. */
const OPERATION_REF = /^[A-Za-z0-9_.-]{1,2048}$/;

/**
 * `Poppy-Operation` (0.4 Ops 4): the Session the website handled the
 * request as, and the reference. Null for a header that isn't one, which
 * is ignored.
 */
export function parseOperationHeader(field: string): { readonly sid: string; readonly ref: string } | null {
  const members = dictionaryStrings(field);
  const sid = members?.sid;
  const ref = members?.ref;
  return sid !== undefined && ref !== undefined && sid !== "" && OPERATION_REF.test(ref) ? { sid, ref } : null;
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
