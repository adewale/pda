import { array, boolean, integer, literal, nullable, number, object, optional, record, refuse, string, tagged, type Decoder } from "../decode";
import { ours, shown } from "../diagnostic";
import { APPROVAL_READ_LIMIT, isApprovalId, isDiagnosticFlowId } from "./approval-outcome";
import { issuerDecoder } from "./issuer";
import type { PoppyClientFrame, PoppyServerFrame } from "./wire";

/**
 * The page's frames, decoded where they arrive rather than cast: the page's
 * to the agent (capability.ts), every member checked, since they carry the
 * User's decisions; and the agent's to the page (use-pi-session.ts).
 */

const decision = literal("approve", "decline");
const approvalIds: Decoder<readonly string[]> = (value, at) => {
  if (!Array.isArray(value) || value.length > APPROVAL_READ_LIMIT) refuse(at, shown`a list of at most ${APPROVAL_READ_LIMIT} approval ids`, value);
  const ids = array(string)(value, at);
  const bad = ids.find(id => !isDiagnosticFlowId(id));
  if (bad !== undefined) refuse(at, ours("approval ids"), bad);
  return ids;
};

const flowId: Decoder<string> = (value, at) => {
  const decoded = string(value, at);
  if (!isDiagnosticFlowId(decoded)) refuse(at, ours("a diagnostic flow id"), decoded);
  return decoded;
};
const linkChecks: Decoder<Extract<PoppyClientFrame, { type: "poppy.result_links.checked" }>["checks"]> = (value, at) => {
  if (!Array.isArray(value) || value.length > 12) refuse(at, ours("a list of at most 12 link checks"), value);
  const checks = array(object({ index: integer, attribute_equal: boolean, resolved_equal: boolean }))(value, at);
  // The index that breaks the rule, as the value got: out of range, or repeated.
  const stray = checks.find((check, position) => check.index < 0 || check.index >= 12 || checks.findIndex(other => other.index === check.index) !== position);
  if (stray !== undefined) refuse(at, ours("link checks with distinct indexes from 0 to 11"), stray.index);
  return checks;
};

/** Page → agent. */
export const clientFrame: Decoder<PoppyClientFrame> = tagged("type", {
  "poppy.context": object({ type: literal("poppy.context"), locale: optional(string), time_zone: optional(string) }),
  "poppy.activity": object({ type: literal("poppy.activity") }),
  "poppy.approvals.read": object({ type: literal("poppy.approvals.read"), ids: approvalIds }),
  "poppy.credentials": object({ type: literal("poppy.credentials"), signInId: string, values: record(string) }),
  "poppy.code": object({ type: literal("poppy.code"), signInId: string, code: string }),
  "poppy.signin.cancel": object({ type: literal("poppy.signin.cancel"), signInId: string }),
  "poppy.approval": object({ type: literal("poppy.approval"), approvalId: string, decision }),
  "poppy.approval.resolve": object({ type: literal("poppy.approval.resolve"), approvalId: string, outcome: literal("performed", "not_performed") }),
  "poppy.approvals": object({ type: literal("poppy.approvals"), decisions: array(object({ approvalId: string, decision })) }),
  "poppy.direct.start": object({ type: literal("poppy.direct.start"), conversationId: string, text: string, eventId: optional(string) }),
  "poppy.direct.decline": object({ type: literal("poppy.direct.decline"), conversationId: string }),
  "poppy.direct.say": object({ type: literal("poppy.direct.say"), conversationId: string, text: string }),
  "poppy.direct.close": object({ type: literal("poppy.direct.close"), conversationId: string }),
  "poppy.signout": object({ type: literal("poppy.signout"), issuer: issuerDecoder, account: string }),
  "poppy.revoke.retry": object({ type: literal("poppy.revoke.retry"), id: string }),
  "poppy.card.dismiss": object({ type: literal("poppy.card.dismiss"), id: string }),
  // Their conditions are checked in full by the agent (instructions.ts) before anything is stored.
  "poppy.instruction.add": object({
    type: literal("poppy.instruction.add"),
    issuer: issuerDecoder,
    account: optional(nullable(string)),
    text: string,
    conditions: array(built<Extract<PoppyClientFrame, { type: "poppy.instruction.add" }>["conditions"][number]>()),
    budget: optional(nullable(built<NonNullable<Extract<PoppyClientFrame, { type: "poppy.instruction.add" }>["budget"]>>()))
  }),
  "poppy.instruction.withdraw": object({ type: literal("poppy.instruction.withdraw"), id: string }),
  "poppy.browser.take": object({ type: literal("poppy.browser.take"), handoverId: string }),
  "poppy.browser.view": object({ type: literal("poppy.browser.view"), handoverId: string }),
  "poppy.browser.return": object({ type: literal("poppy.browser.return"), handoverId: string }),
  "poppy.browser.cancel": object({ type: literal("poppy.browser.cancel"), handoverId: string }),
  "poppy.protocol": object({ type: literal("poppy.protocol"), key: string }),
  "poppy.diagnostics": object({ type: literal("poppy.diagnostics"), flowId: optional(flowId) }),
  "poppy.result_links.checked": object({ type: literal("poppy.result_links.checked"), cardId: string, checks: linkChecks })
});

/**
 * Items the agent's own code built in the same frame shape (cards, activity
 * entries, protocol rows, transcript entries): checked to be objects, then
 * taken as typed. Decoding each of their many members on the page would
 * repeat the server's types for no gain: the server and page ship together,
 * and a page left open across a deploy reloads on its next connect.
 */
function built<T>(): Decoder<T> {
  return (value, at) => {
    object({})(value, at);
    return value as T; // Checked to be an object above; its members are the agent's own (see above).
  };
}

/** Agent → page. */
export const serverFrame: Decoder<PoppyServerFrame> = tagged("type", {
  "poppy.cards": object({ type: literal("poppy.cards"), cards: array(built<Extract<PoppyServerFrame, { type: "poppy.cards" }>["cards"][number]>()) }),
  "poppy.approvals.state": object({ type: literal("poppy.approvals.state"), ids: array(string), decisions: array(built<Extract<PoppyServerFrame, { type: "poppy.approvals.state" }>["decisions"][number]>()) }),
  "poppy.direct": object({ type: literal("poppy.direct"), update: built<Extract<PoppyServerFrame, { type: "poppy.direct" }>["update"]>() }),
  "poppy.settings": object({
    type: literal("poppy.settings"),
    accounts: array(built<Extract<PoppyServerFrame, { type: "poppy.settings" }>["accounts"][number]>()),
    signOuts: array(built<Extract<PoppyServerFrame, { type: "poppy.settings" }>["signOuts"][number]>()),
    instructions: array(built<Extract<PoppyServerFrame, { type: "poppy.settings" }>["instructions"][number]>())
  }),
  "poppy.activity": object({
    type: literal("poppy.activity"),
    inProgress: array(built<Extract<PoppyServerFrame, { type: "poppy.activity" }>["inProgress"][number]>()),
    log: array(built<Extract<PoppyServerFrame, { type: "poppy.activity" }>["log"][number]>())
  }),
  "poppy.protocol.index": object({
    type: literal("poppy.protocol.index"),
    companies: array(built<Extract<PoppyServerFrame, { type: "poppy.protocol.index" }>["companies"][number]>())
  }),
  "poppy.protocol": object({
    type: literal("poppy.protocol"),
    key: string,
    company: string,
    domain: nullable(string),
    issuer: nullable(issuerDecoder),
    entries: array(built<Extract<PoppyServerFrame, { type: "poppy.protocol" }>["entries"][number]>())
  }),
  "poppy.diagnostics": object({ type: literal("poppy.diagnostics"), text: string, at: number, flowId: optional(flowId) }),
  "poppy.browser.view": object({ type: literal("poppy.browser.view"), handoverId: string, url: string, expiresAt: number })
});
