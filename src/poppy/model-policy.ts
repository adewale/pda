/**
 * Narrow, deterministic safeguards for text the model proposes sending.
 * These catch recognizable credential/contact formats; they cannot decide
 * whether every name or sentence contains personal information.
 */
import { secretProblem } from "../tools/memory-store";
import { isObject, type Json } from "./json";

/** Include field names so a structured password or verification_code is checked as a named value. */
function fields(value: Json): string {
  if (Array.isArray(value)) return value.map(fields).join("\n");
  if (isObject(value)) return Object.entries(value).map(([key, item]) =>
    `${key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ")}: ${fields(item)}`
  ).join("\n");
  return value === null ? "" : String(value);
}

/** An agent message must not carry a recognizable credential, in prose or structured fields. */
export function messageHasCredential(text: string | undefined, data: Json | undefined): boolean {
  const prose = text ?? "";
  return /^\s*\d{4,8}\s*$/.test(prose)
    || secretProblem(prose) !== null
    || (data !== undefined && secretProblem(fields(data)) !== null);
}

/** Only the latest Company's message can request verification; ordinary delivery details aren't verification. */
export function requestsVerification(messages: readonly Json[]): boolean {
  const latest = [...messages].reverse().find((message) => isObject(message) && message.role === "company" && typeof message.text === "string");
  if (!isObject(latest) || typeof latest.text !== "string") return false;
  const text = latest.text;
  return /\b(?:verif(?:y|ication)|identity|authenticate|authentication)\b/i.test(text)
    && /\b(?:send|give|provide|enter|reply|tell|share|confirm)\b/i.test(text)
    && /\b(?:codes?|password|passcode|pin|otp|email|e-mail|phone|date of birth|personal details|account details)\b/i.test(text);
}

/** Sent instead of an unsafe verification reply. It contains no part of the attempted text or fields. */
export const REQUEST_AUTHORIZATION = "Please send an authorization event with the scopes needed to verify the User, so they can sign in through the Personal Agent. Do not request verification codes, passwords or personal details in conversation messages.";

/** Recognizable feedback identifiers are refused; a description still needs the model to keep it general. */
export function feedbackHasPersonalData(task: string, description: string): boolean {
  const text = `${task}\n${description}`;
  if (secretProblem(text) !== null) return true;
  if (/\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}\b/i.test(text)) return true;
  if (/(?:\+\d[\d ()-]{7,}\d|\(\d{2,4}\)\s*\d[\d -]{5,}\d)/.test(text)) return true;
  if (/\b(?:phone|telephone|mobile|contact)(?:\s+(?:number|no\.?))?\s*[:=]?\s*(?:\+?\d[\d ()-]{6,}\d)/i.test(text)) return true;
  if (/\b(?:ord|order|acct|account|customer|booking|reservation|invoice|tracking)_[A-Z0-9_-]{3,}\b/i.test(text)) return true;
  if (/\b(?:order|account|customer|booking|reservation|invoice|tracking|membership)(?:\s+(?:id|number|no\.?|reference))?\s*(?:[:#=]\s*|is\s+)(?=[A-Z0-9_-]*\d)[A-Z0-9_-]{3,}/i.test(text)) return true;
  return /\b(?:(?:my|customer(?:'s)?|user(?:'s)?|full|first|last)\s+name|(?:postal|home|delivery|billing)\s+address|date of birth)\s*(?:is\s+|[:=]\s*)\S/i.test(text);
}
