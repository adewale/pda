/**
 * Narrow, deterministic safeguards for text the model proposes sending.
 * These catch recognizable credential/contact formats; they cannot decide
 * whether every name or sentence contains personal information.
 */
import { credentialProblem, secretProblem } from "../tools/memory-store";
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
  return hasCredential(text ?? "", data === undefined ? "" : fields(data));
}

function hasCredential(prose: string, details: string): boolean {
  return credentialProblem(prose) !== null || credentialProblem(details) !== null;
}

/** Only the latest Company's message can request verification; ordinary delivery details aren't verification. */
export function requestsVerification(messages: readonly Json[]): boolean {
  const latest = [...messages].reverse().find((message) => isObject(message) && message.role === "company" && typeof message.text === "string");
  if (!isObject(latest) || typeof latest.text !== "string") return false;
  // The purpose may precede the request in another sentence. Check negation
  // beside each: a warning such as "we never ask for a code" asks for nothing.
  const clauses = latest.text.replace(/’/g, "'").split(/[.!?;\n]+|\bbut\b/i);
  const negation = /\b(?:no|not|never|don't|doesn't|won't|mustn't|shouldn't|cannot|can't|avoid|stop)\b/i;
  const verification = clauses.some(clause => {
    const purpose = /\b(?:verif(?:y|ication)|identity|authenticate|authentication)\b/i.exec(clause);
    return purpose !== null && !negation.test(clause.slice(0, purpose.index));
  });
  if (!verification) return false;
  return clauses.some(clause => {
    const verb = /\b(?:send|give|provide|enter|reply|tell|share|confirm)\b/i.exec(clause);
    if (!verb) return false;
    const detail = /\b(?:codes?|passwords?|passcode|pin|otp|email|e-mail|phone|date of birth|personal details|account details)\b/i.exec(clause.slice(verb.index + verb[0].length));
    if (!detail) return false;
    const beforeDetail = clause.slice(0, verb.index + verb[0].length + detail.index);
    return !negation.test(beforeDetail);
  });
}

const EMAIL = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}\b/i;
const PHONE = /(?:\+\d[\d ()-]{7,}\d|\(\d{2,4}\)\s*\d[\d -]{5,}\d)/;
const NAMED_PHONE = /\b(?:phone|telephone|mobile|contact)(?:\s+(?:number|no\.?))?\s*[:=]?\s*(?:\+?\d[\d ()-]{6,}\d)/i;
const PERSONAL_DETAIL = /\b(?:(?:my|customer(?:'s)?|user(?:'s)?|full|first|last)\s+name|(?:postal|home|delivery|billing)\s+address|date of birth)\s*(?:is\s+|[:=]\s*)\S/i;

/** A harmless refusal or task question must not be replaced just because verification was requested. */
export const MESSAGE_POLICIES = ["send", "request_authorization", "reject"] as const;
export type MessagePolicy = typeof MESSAGE_POLICIES[number];

/** Inspect the payload once; ordinary task details do not become verification replies by proximity alone. */
export function classifyMessage(messages: readonly Json[], text: string | undefined, data: Json | undefined): MessagePolicy {
  const prose = text ?? "", details = data === undefined ? "" : fields(data);
  const credential = hasCredential(prose, details);
  if (!requestsVerification(messages)) return credential ? "reject" : "send";
  const proposed = `${prose}\n${details}`;
  const verification = credential
    || /^\s*\d{4,8}\s*$/.test(prose)
    || EMAIL.test(proposed) || PHONE.test(proposed) || NAMED_PHONE.test(proposed) || PERSONAL_DETAIL.test(proposed)
    || /(?:^|\n)(?:name|email|email address|phone|phone number|dob|personal details|account details):\s*\S/i.test(details);
  return verification ? "request_authorization" : "send";
}

/** Sent instead of an unsafe verification reply. It contains no part of the attempted text or fields. */
export const REQUEST_AUTHORIZATION = "Please send an authorization event with the scopes needed to verify the User, so they can sign in through the Personal Agent. Do not request verification codes, passwords or personal details in conversation messages.";

/** Recognizable feedback identifiers are refused; a description still needs the model to keep it general. */
export function feedbackHasPersonalData(task: string, description: string): boolean {
  const text = `${task}\n${description}`;
  if (secretProblem(text) !== null) return true;
  if (EMAIL.test(text) || PHONE.test(text) || NAMED_PHONE.test(text)) return true;
  if (/\b(?:ord|order|acct|account|customer|booking|reservation|invoice|tracking)_[A-Z0-9_-]{3,}\b/i.test(text)) return true;
  if (/\b(?:order|account|customer|booking|reservation|invoice|tracking|membership)(?:\s+(?:id|number|no\.?|reference))?\s*(?:[:#=]\s*|is\s+)(?=[A-Z0-9_-]*\d)[A-Z0-9_-]{3,}/i.test(text)) return true;
  return PERSONAL_DETAIL.test(text);
}
