/**
 * Every code a `PoppyError` can carry. Ours are a closed set, so a typo in a
 * comparison or a new refusal nobody listed is a type error; a Company's come
 * in through `companyErrorCode`, the one place its `error` member becomes a
 * code, and are either one the draft defines or a short token it sent.
 */

/** Codes the agent raises itself: refusals before anything is sent, and failures of its own. */
export const AGENT_ERROR_CODES = [
  "company_changed",
  "approval_changed",
  "batch_refused",
  "bad_api",
  "browser_join_failed",
  "conversation_not_found",
  "extension_required",
  "interrupted",
  "invalid_args",
  "invalid_body",
  "invalid_params",
  "invalid_request",
  "invalid_response",
  "invalid_scope",
  "mcp_error",
  "mcp_session_expired",
  "no_api",
  "no_attachment",
  "no_company_agent",
  "no_operation",
  "no_operations",
  "no_tool",
  "operation_open",
  "outside_poppy_session",
  "protocol_endpoint",
  "rate_limited",
  "refused",
  "server_error",
  "timeout",
  "too_large",
  "unusable_proposal",
  "untrusted_host",
  "untrusted_server"
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

/**
 * Codes the drafts, the Operations extension and the OAuth RFCs they build
 * on define for a Company to answer (spec 4.2, 4.3, 6, 7.13; Ops 9; 0.3's 7
 * and 8.13, Ops 2 4, Mediated Sign-In 5; RFC 6749, 8628, 8707, 9449).
 */
export const PROTOCOL_ERROR_CODES = [
  "access_denied",
  "account_mismatch",
  "approval_required",
  "authorization_pending",
  "code_required",
  "conversation_closed",
  "conversation_not_found",
  "cursor_expired",
  "direct_conversation_open",
  "expired_token",
  "extension_required",
  "insufficient_scope",
  "invalid_client",
  "invalid_cursor",
  "invalid_dpop_proof",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "invalid_session",
  "invalid_target",
  "invalid_token",
  "message_id_conflict",
  "operation_not_found",
  "rate_limited",
  "server_error",
  "sign_in_required",
  "slow_down",
  "temporarily_unavailable",
  "terms_changed",
  "unauthorized_client",
  "unsupported_grant_type",
  "use_dpop_nonce",
  "user_approval_required"
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/** A code the agent or the draft defines: what code comparisons may name. */
export type KnownErrorCode = AgentErrorCode | ProtocolErrorCode;

/** An HTTP error the Company gave no code for. */
export type HttpErrorCode = `http_${number}`;

declare const COMPANY_CODE: unique symbol;
/** A code a Company sent that the draft doesn't define (`not_available`, say): a short token, never free text. */
export type CompanyErrorCode = string & { readonly [COMPANY_CODE]: true };

export type PoppyErrorCode = AgentErrorCode | ProtocolErrorCode | HttpErrorCode | CompanyErrorCode;

const PROTOCOL = new Set<string>(PROTOCOL_ERROR_CODES);
const TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/i;

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === "string" && PROTOCOL.has(value);
}

/**
 * The code for what a Company answered: its `error` member when that is a
 * code the draft defines or a short token, else `http_<status>`. A Company's
 * `error` reaches the model's tool results and the User's receipts, so text
 * that isn't a token (a sentence, an instruction) never becomes a code.
 */
export function companyErrorCode(error: unknown, status: number): ProtocolErrorCode | CompanyErrorCode | HttpErrorCode {
  if (isProtocolErrorCode(error)) return error;
  if (typeof error === "string" && TOKEN.test(error)) return error as CompanyErrorCode;
  return `http_${status}`;
}
