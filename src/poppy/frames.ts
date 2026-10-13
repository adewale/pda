import { array, boolean, integer, literal, nullable, number, object, optional, record, string, tagged, type Decoder } from "../decode";
import type { HistoryFrame } from "../history";
import { issuerDecoder } from "./issuer";
import type { PoppyClientFrame, PoppyServerFrame } from "./wire";

/**
 * The page's frames, decoded where they arrive rather than cast: the page's
 * to the agent (capability.ts), every member checked, since they carry the
 * User's decisions; and the agent's to the page (use-pi-session.ts).
 */

const decision = literal("approve", "decline");

/** Page → agent. */
export const clientFrame: Decoder<PoppyClientFrame> = tagged("type", {
  "poppy.context": object({ type: literal("poppy.context"), locale: optional(string), time_zone: optional(string) }),
  "poppy.activity": object({ type: literal("poppy.activity") }),
  "poppy.credentials": object({ type: literal("poppy.credentials"), signInId: string, values: record(string) }),
  "poppy.code": object({ type: literal("poppy.code"), signInId: string, code: string }),
  "poppy.signin.cancel": object({ type: literal("poppy.signin.cancel"), signInId: string }),
  "poppy.operation": object({
    type: literal("poppy.operation"),
    issuer: issuerDecoder,
    operationId: string,
    revision: integer,
    decision: literal("approve", "decline", "cancel")
  }),
  "poppy.approval": object({ type: literal("poppy.approval"), approvalId: string, decision }),
  "poppy.direct.start": object({ type: literal("poppy.direct.start"), conversationId: string, text: string }),
  "poppy.direct.decline": object({ type: literal("poppy.direct.decline"), conversationId: string }),
  "poppy.direct.say": object({ type: literal("poppy.direct.say"), conversationId: string, text: string }),
  "poppy.direct.close": object({ type: literal("poppy.direct.close"), conversationId: string }),
  "poppy.signout": object({ type: literal("poppy.signout"), issuer: issuerDecoder, account: string }),
  "poppy.permission.add": object({
    type: literal("poppy.permission.add"),
    issuer: issuerDecoder,
    account: string,
    action: string,
    maxAmount: optional(string),
    currency: optional(string),
    maxUses: optional(integer),
    expiresAt: optional(number)
  }),
  "poppy.permission.remove": object({ type: literal("poppy.permission.remove"), id: string }),
  "poppy.card.dismiss": object({ type: literal("poppy.card.dismiss"), id: string }),
  "poppy.protocol": object({ type: literal("poppy.protocol"), key: string }),
  "poppy.diagnostics": object({ type: literal("poppy.diagnostics") })
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
  "poppy.direct": object({ type: literal("poppy.direct"), update: built<Extract<PoppyServerFrame, { type: "poppy.direct" }>["update"]>() }),
  "poppy.settings": object({
    type: literal("poppy.settings"),
    accounts: array(built<Extract<PoppyServerFrame, { type: "poppy.settings" }>["accounts"][number]>()),
    permissions: array(built<Extract<PoppyServerFrame, { type: "poppy.settings" }>["permissions"][number]>())
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
  "poppy.diagnostics": object({ type: literal("poppy.diagnostics"), text: string, at: number })
});

/** The answer to the page's `history.before`. */
export const historyFrame: Decoder<HistoryFrame> = object({
  type: literal("history"),
  before: integer,
  entries: array(built<HistoryFrame["entries"][number]>()),
  more: boolean
});
