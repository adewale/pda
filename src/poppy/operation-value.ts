import { boolean, DecodeError, json, string, type Decoder } from "../decode";
import { isObject, type Json } from "./json";

/**
 * An operation (Ops 3), decoded once: from a Company's answer, a message or
 * a proposal, and again from the row it is stored in. Its own module so the
 * table declaration (store.ts) and the extension's code (operations.ts) share
 * one decoder.
 */

export const OPERATION_STATES = ["proposed", "in_progress", "succeeded", "failed", "cancelled", "expired"] as const;
export type OperationState = (typeof OPERATION_STATES)[number];
export const FINAL_STATES: ReadonlySet<OperationState> = new Set(["succeeded", "failed", "cancelled", "expired"]);

/** An operation as the Company sends it (Ops 3), with only the members this agent reads, each of its type. */
export type Operation = {
  readonly operation_id: string;
  readonly revision: number;
  readonly state: OperationState;
  readonly summary: string;
  readonly terms?: Json;
  readonly expires_at?: string;
  readonly user_approval_required?: boolean;
  readonly url?: string;
  readonly confirmation?: Json;
  readonly result?: { readonly summary: string; readonly data?: Json } | null;
};

/**
 * Why an `operation_id` can't be used, or null if it can. It is the
 * Company's own (it MAY be its record's id, Ops 3), so any text is taken:
 * 1 to 256 characters, none a control character, no space at either end,
 * not `.` or `..` (which a URL would resolve away), and well-formed Unicode.
 * It goes into URLs percent-encoded.
 */
export function operationIdProblem(id: unknown): string | null {
  if (typeof id !== "string") return "it has no operation_id";
  const length = [...id].length;
  if (length < 1 || length > 256) return "its operation_id isn't 1 to 256 characters";
  if (/\p{Cc}/u.test(id)) return "its operation_id has a control character";
  if (id.trim() !== id) return "its operation_id starts or ends with a space";
  if (id === "." || id === "..") return "its operation_id is a dot segment";
  try {
    encodeURIComponent(id);
  } catch {
    return "its operation_id isn't well-formed Unicode";
  }
  return null;
}

function isState(value: unknown): value is OperationState {
  return (OPERATION_STATES as readonly unknown[]).includes(value);
}

/** An optional member of the wrong type is left out, as one the Company didn't send: the operation is still usable. */
function member<T>(value: unknown, decoder: Decoder<T>): T | undefined {
  if (value === undefined) return undefined;
  try {
    return decoder(value, "");
  } catch (error) {
    if (error instanceof DecodeError) return undefined;
    throw error;
  }
}

function resultOf(value: unknown): Operation["result"] | undefined {
  if (value === null) return null;
  if (!isObject(value) || typeof value.summary !== "string") return undefined;
  const data = member(value.data, json);
  return { summary: value.summary, ...(data !== undefined ? { data } : {}) };
}

/** The operation `value` is, or why it can't be used: its four required members are checked, the optional ones kept only when well typed. */
export function parseOperation(value: unknown): { operation: Operation } | { problem: string } {
  if (!isObject(value)) return { problem: "it isn't an object" };
  const { operation_id, revision, state, summary } = value;
  const idProblem = operationIdProblem(operation_id);
  if (idProblem || typeof operation_id !== "string") return { problem: idProblem ?? "it has no operation_id" };
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return { problem: "its revision isn't a whole number from 1" };
  if (!isState(state)) return { problem: "its state isn't one the Operations extension defines" };
  if (typeof summary !== "string") return { problem: "it has no summary" };
  const terms = member(value.terms, json);
  const expiresAt = member(value.expires_at, string);
  const approvalRequired = member(value.user_approval_required, boolean);
  const url = member(value.url, string);
  const confirmation = member(value.confirmation, json);
  const result = resultOf(value.result);
  return {
    operation: {
      operation_id,
      revision,
      state,
      summary,
      ...(terms !== undefined ? { terms } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(approvalRequired !== undefined ? { user_approval_required: approvalRequired } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(confirmation !== undefined ? { confirmation } : {}),
      ...(result !== undefined ? { result } : {})
    }
  };
}

/** The operation a row stores, as JSON text: decoded like any other. */
export const storedOperation: Decoder<Operation> = (value, at) => {
  if (typeof value !== "string") throw new DecodeError(`${at}: expected an operation's JSON`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DecodeError(`${at}: expected an operation's JSON`);
  }
  const read = parseOperation(parsed);
  if ("problem" in read) throw new DecodeError(`${at}: ${read.problem}`);
  return read.operation;
};
