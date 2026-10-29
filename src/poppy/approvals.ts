import { ATTACHMENT_TYPES, type AttachmentInfo } from "../attachments";
import { array, boolean, integer, json, literal, nullable, object, optional, record, string, tagged, tryDecode, type Decoded, type Decoder } from "../decode";
import { isObject } from "./json";

/**
 * The form a local approval's request is stored in (`poppy_approvals.request`).
 * A row in any other form, from before a deploy or tampered with, can't be
 * sent: `readApproval` refuses it and the card says why. Version 1 was
 * `{ kind, request: { issuer, call | submission }, attachments? }`, read back
 * with a cast.
 */
export const APPROVAL_VERSION = 2;

const scalar: Decoder<string | number | boolean> = (value, at) =>
  typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : string(value, at);

const attachment = object({
  id: string,
  name: string,
  type: literal(...ATTACHMENT_TYPES),
  size: integer
});

/** 0.3: the operation revision the User approved, sent with the request that returned it (Ops 6). */
const approvalV2 = object({ operation_id: string, revision: string, expires_at: string });

/** An OpenAPI call (apis.ts `OpenApiCall`), as the model asked for it. */
const openApiCall = object({
  apiUrl: string,
  operation: string,
  params: record(scalar),
  body: optional(json),
  files: optional(record(string)),
  idempotencyKey: optional(string),
  approval: optional(approvalV2)
});

const mcpCall = object({ apiUrl: string, tool: string, args: json, approval: optional(approvalV2) });
// Older bindings precede the first withdrawal generation and are interpreted as generation zero.
const binding = object({ account: nullable(string), sessionId: string, authorityGeneration: optional(integer) });

/** Exactly what a website form sends (browser.ts `FormSubmission`). */
const submission = object({
  from: string,
  method: literal("GET", "POST"),
  action: string,
  enctype: literal("application/x-www-form-urlencoded", "multipart/form-data"),
  fields: array(object({ name: string, value: string, hidden: boolean }))
});

const approval = tagged("kind", {
  /** `method` and `url` are what the card showed; the call is checked again and must still make exactly them. */
  openapi: object({ v: literal(APPROVAL_VERSION), kind: literal("openapi"), call: openApiCall, method: string, url: string, binding: optional(binding), attachments: optional(array(attachment)) }),
  mcp: object({ v: literal(APPROVAL_VERSION), kind: literal("mcp"), call: mcpCall, binding: optional(binding) }),
  "browse-submit": object({ v: literal(APPROVAL_VERSION), kind: literal("browse-submit"), submission, binding: optional(object({ account: nullable(string), sessionId: nullable(string), contextId: string, authorityGeneration: optional(integer) })) }),
  /** 0.3: an operation a Company Agent returned in a conversation; approved, it goes back in a message's `approval` (Ops 6). */
  "message-approval": object({ v: literal(APPROVAL_VERSION), kind: literal("message-approval"), conversationId: string, approval: approvalV2, binding })
});

export type StoredApproval = Decoded<typeof approval>;
export type ApprovalKind = StoredApproval["kind"];
export type ApprovalOf<K extends ApprovalKind> = Extract<StoredApproval, { kind: K }>;
/** An approval as a caller makes one; the version is added when it is stored. */
export type NewApproval = { [K in ApprovalKind]: Omit<ApprovalOf<K>, "v"> }[ApprovalKind];

export function storedApproval(value: NewApproval): string {
  return JSON.stringify({ v: APPROVAL_VERSION, ...value });
}

/** A stored approval, or why it can't be sent. */
export function readApproval(text: string): { ok: true; value: StoredApproval } | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: "it isn't readable" };
  }
  const version = isObject(parsed) ? (parsed.v ?? 1) : null;
  if (version !== APPROVAL_VERSION) {
    return { ok: false, problem: `it was stored in a form (version ${typeof version === "number" ? version : "unknown"}) this version of the agent doesn't send` };
  }
  const decoded = tryDecode(approval, parsed, "approval");
  return decoded.ok ? decoded : { ok: false, problem: `it isn't one this agent stored (${decoded.problem})` };
}

/**
 * The User's files a stored approval sends or sent, for its card: read from
 * any version, since only the card shows them; none if they can't be read.
 */
export function approvalAttachments(text: string): { attachments?: readonly AttachmentInfo[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const read = tryDecode(optional(array(attachment)), isObject(parsed) ? parsed.attachments : undefined, "attachments");
  return read.ok && read.value?.length ? { attachments: read.value } : {};
}

/**
 * Which approvals may be decided together on one card: uploads of the
 * User's photos to one Company's same method and URL. A batch never spans
 * Companies, endpoints or kinds of request, so nothing else can ride in it
 * unseen. Undefined for every other approval, and for one that can't be read.
 */
export function approvalBatchKey(issuer: string, text: string): string | undefined {
  const read = readApproval(text);
  if (!read.ok || read.value.kind !== "openapi" || !read.value.attachments?.length) return undefined;
  return `${issuer} ${read.value.method} ${read.value.url}`;
}
