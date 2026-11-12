/**
 * Standing instructions and agent approvals (0.4 Operations 5; decision 44).
 *
 * The User writes an instruction on their own page, never the model: it
 * names one Company, optionally one account there, and conditions on an
 * operation's `terms`. When a Company returns an operation, a deterministic
 * check compares the revision's `terms` with the User's instructions. Only
 * a full match approves it as the agent (`approver: "agent"`); anything the
 * check can't decide goes to the User's card. A budget over a period
 * reserves its amount when an approval is decided and releases it when the
 * approval goes unused. Tools may read instructions; nothing but the page's
 * own frames writes them.
 */
import { array, DecodeError, integer, jsonText, literal, nullable, object, optional, string, tagged, tryDecode, type Decoder } from "../decode";
import { one, rows } from "../rows";
import { scopeSet, type PoppyClient } from "./client";
import { BROWSER_SIGN_IN, type Company } from "./discovery";
import type { Issuer } from "./issuer";
import { isObject, type Json } from "./json";
import { randomId } from "./jwt";
import { operationsVersion, type OperationV2 } from "./operations-v2";
import { approvalsTable, instructionsTable, instructionSpendTable } from "./store";
import { wasDeclined } from "./declines";

/** One value a condition accepts: what `terms` holds at its path. */
export type Plain = string | number | boolean;

/** A condition on the value at `path` in an operation's `terms`, a list of member names from its top. */
export type Condition =
  /** A money object, `{ "amount": "70.00", "currency": "USD" }` (Ops 3), of at most `amount` in exactly `currency`. */
  | { readonly kind: "at_most"; readonly path: readonly string[]; readonly amount: string; readonly currency: string }
  | { readonly kind: "one_of"; readonly path: readonly string[]; readonly values: readonly Plain[] }
  | { readonly kind: "equals"; readonly path: readonly string[]; readonly value: Plain };

/** A limit on what the instruction's `at_most` condition approves over a rolling period. */
export type Budget = { readonly amount: string; readonly currency: string; readonly days: number };

export type Instruction = {
  readonly id: string;
  readonly issuer: Issuer;
  /** The account it covers; null for any account, or signed out. */
  readonly account: string | null;
  /** The User's own words, shown wherever it approved something. */
  readonly text: string;
  readonly conditions: readonly Condition[];
  readonly budget: Budget | null;
  readonly createdAt: number;
  readonly withdrawnAt: number | null;
};

function refuse(at: string, expected: string): never {
  throw new DecodeError(`${at || "the value"}: expected ${expected}`);
}
const plain: Decoder<Plain> = (value, at) => typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
  ? value : refuse(at, "a string, number or true or false");
const path: Decoder<readonly string[]> = (value, at) => {
  const names = array(string)(value, at);
  return names.length === 0 || names.length > 8 || names.some((name) => name.length === 0 || name.length > 128) ? refuse(at, "one to eight member names") : names;
};
const amount: Decoder<string> = (value, at) => {
  const text = string(value, at);
  return DECIMAL.test(text) ? text : refuse(at, "a decimal amount such as 20.00");
};
const currency: Decoder<string> = (value, at) => {
  const text = string(value, at);
  return /^[A-Z]{3}$/.test(text) ? text : refuse(at, "a three-letter currency code");
};
export const conditionDecoder: Decoder<Condition> = tagged("kind", {
  at_most: object({ kind: literal("at_most"), path, amount, currency }),
  one_of: object({ kind: literal("one_of"), path, values: array(plain) }),
  equals: object({ kind: literal("equals"), path, value: plain })
});
export const budgetDecoder: Decoder<Budget> = object({ amount, currency, days: integer });

/** What the page sends to add an instruction; checked again here, since it comes over the socket. */
export const newInstructionDecoder = object({
  issuer: string,
  account: optional(nullable(string)),
  text: string,
  conditions: array(conditionDecoder),
  budget: optional(nullable(budgetDecoder))
});
export type NewInstruction = ReturnType<typeof newInstructionDecoder>;

// ---------------------------------------------------------------- Money

/** A decimal amount as `terms` and instructions write it: no sign, no exponent, at most six decimals. */
const DECIMAL = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/;
const SCALE = 6;

/** A decimal amount in millionths, exactly; null when it isn't one we compare. */
function units(value: Json | undefined): bigint | null {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : null;
  if (text === null || !DECIMAL.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole!) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, "0"));
}

/** At least two decimals, as money is written: 70.00, 0.125. */
function formatUnits(value: bigint): string {
  const whole = value / 10n ** BigInt(SCALE);
  const fraction = (value % 10n ** BigInt(SCALE)).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

// ---------------------------------------------------------------- Storage

type InstructionRow = ReturnType<typeof instructionRow>;
const instructionRow = instructionsTable.pick("id", "issuer", "account", "text", "conditions", "budget", "created_at", "withdrawn_at");

function fromRow(row: InstructionRow): Instruction | null {
  // Stored by us, but read back as data: one that no longer decodes approves nothing.
  const conditions = tryDecode(jsonText(array(conditionDecoder)), row.conditions, "instruction conditions");
  const budget = row.budget === null ? { ok: true as const, value: null } : tryDecode(jsonText(budgetDecoder), row.budget, "instruction budget");
  if (!conditions.ok || !budget.ok) return null;
  return { id: row.id, issuer: row.issuer, account: row.account, text: row.text, conditions: conditions.value, budget: budget.value, createdAt: row.created_at, withdrawnAt: row.withdrawn_at };
}

/** Every instruction, newest first; withdrawn ones too, for the ledger. */
export function instructions(client: PoppyClient, issuer?: Issuer): Instruction[] {
  const found = issuer
    ? rows(client.sql, instructionRow, "SELECT * FROM poppy_instructions WHERE issuer = ? ORDER BY created_at DESC", issuer)
    : rows(client.sql, instructionRow, "SELECT * FROM poppy_instructions ORDER BY created_at DESC");
  return found.flatMap((row) => fromRow(row) ?? []);
}

export function instruction(client: PoppyClient, id: string): Instruction | undefined {
  const row = one(client.sql, instructionRow, "SELECT * FROM poppy_instructions WHERE id = ?", id);
  return row ? fromRow(row) ?? undefined : undefined;
}

/**
 * Add an instruction the User wrote on their page. Refused when it can't
 * work as written: no conditions, an at-most limit alongside a budget in
 * another currency, or a budget without exactly one at-most condition.
 */
export function addInstruction(client: PoppyClient, input: NewInstruction, now = Date.now()): Instruction {
  const text = input.text.trim();
  if (!text || text.length > 500) throw new InstructionRefused("Write the instruction in your own words, in at most 500 characters.");
  if (input.conditions.length === 0 || input.conditions.length > 10) throw new InstructionRefused("An instruction needs one to ten conditions on the Company's terms.");
  const limits = input.conditions.filter((condition) => condition.kind === "at_most");
  const budget = input.budget ?? null;
  if (budget) {
    if (limits.length !== 1) throw new InstructionRefused("A limit over a period needs exactly one amount condition to count against.");
    if (budget.currency !== limits[0]!.currency) throw new InstructionRefused("A limit over a period must be in the same currency as the amount condition.");
    if (budget.days < 1 || budget.days > 366) throw new InstructionRefused("A period is 1 to 366 days.");
  }
  const id = randomId("ins_");
  client.sql.exec(
    "INSERT INTO poppy_instructions (id, issuer, account, text, conditions, budget, created_at, withdrawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    id, input.issuer, input.account ?? null, text, JSON.stringify(input.conditions), budget ? JSON.stringify(budget) : null, now
  );
  return instruction(client, id)!;
}

/** Withdraw an instruction: nothing it approved that hasn't been sent yet is sent (Ops 5). */
export function withdrawInstruction(client: PoppyClient, id: string, now = Date.now()): void {
  client.sql.exec("UPDATE poppy_instructions SET withdrawn_at = ? WHERE id = ? AND withdrawn_at IS NULL", now, id);
  // Its pending reservations go back; what was sent stays counted.
  client.sql.exec("UPDATE poppy_instruction_spend SET state = 'released' WHERE instruction_id = ? AND state = 'reserved' AND approval_id IN (SELECT id FROM poppy_approvals WHERE status IN ('pending', 'declined', 'failed', 'refused'))", id);
}

export class InstructionRefused extends Error {}

// ---------------------------------------------------------------- The check

/** Why the check didn't approve: shown to nobody but tests and the decision record, never sent anywhere. */
export type NoMatch = { readonly approved: false; readonly reason: string };
export type Match = { readonly approved: true; readonly instruction: Instruction; readonly spend: { readonly amount: string; readonly currency: string } | null };

function at(terms: Json, names: readonly string[]): Json | undefined {
  let value: Json | undefined = terms;
  for (const name of names) {
    if (!isObject(value) || !Object.hasOwn(value, name)) return undefined;
    value = value[name];
  }
  return value;
}

/** Whether `terms` meet one condition: false for a missing key, another currency, or a value the check can't compare. */
function meets(terms: Json, condition: Condition): boolean {
  const value = at(terms, condition.path);
  if (condition.kind === "at_most") {
    if (!isObject(value) || value.currency !== condition.currency) return false;
    const asked = units(value.amount);
    const limit = units(condition.amount);
    return asked !== null && limit !== null && asked <= limit;
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return false;
  return condition.kind === "one_of" ? condition.values.some((accepted) => accepted === value) : condition.value === value;
}

/**
 * Whether the Session's access could make an irreversible change (4.7
 * `scope_hints`): a scope the Company marks irreversible, or describes with
 * no hint, which counts as irreversible as on sign-in cards. An agent never
 * approves where one is held. `poppy:browser-sign-in` allows nothing beyond
 * the other scopes unless the website is `web.unscoped` (0.4 6), when it is
 * the account's full access there.
 */
function irreversible(company: Company, scope: string): boolean {
  for (const name of scopeSet(scope)) {
    if (name === BROWSER_SIGN_IN && !company.web?.unscoped) continue;
    const hint = Object.hasOwn(company.scopeHints ?? {}, name) ? company.scopeHints![name] : undefined;
    if (!hint || hint.changes === "irreversible") return true;
  }
  return false;
}

/**
 * The deterministic check (Ops 5): does an instruction the User wrote cover
 * this revision's terms? Under Operations 3 only, at this Company and
 * account, and only when every condition of one instruction holds and its
 * budget has room. Nothing from the Company but `terms` is read, and
 * nothing the model wrote at all.
 */
export function check(
  client: PoppyClient,
  company: Company,
  operation: Pick<OperationV2, "terms">,
  session: { readonly account: string | null; readonly scope: string },
  now = Date.now()
): Match | NoMatch {
  if (operationsVersion(company) !== "3") return { approved: false, reason: "agent approvals need Operations 3" };
  const terms = operation.terms;
  if (!isObject(terms)) return { approved: false, reason: "no terms" };
  if (session.account && irreversible(company, session.scope)) return { approved: false, reason: "the Session's access can make changes that can't be undone" };
  const active = instructions(client, company.issuer).filter((item) => item.withdrawnAt === null && (item.account === null || item.account === session.account));
  for (const candidate of active) {
    if (!candidate.conditions.every((condition) => meets(terms, condition))) continue;
    // The ledger shows the amount an instruction's amount condition approved, budget or not.
    const limit = candidate.conditions.find((condition): condition is Extract<Condition, { kind: "at_most" }> => condition.kind === "at_most");
    const value = limit ? at(terms, limit.path) : undefined;
    const asked = isObject(value) ? units(value.amount) : null;
    if (!candidate.budget) return { approved: true, instruction: candidate, spend: limit && asked !== null ? { amount: formatUnits(asked), currency: limit.currency } : null };
    const room = units(candidate.budget.amount);
    if (asked === null || room === null) continue;
    const since = now - candidate.budget.days * 86_400_000;
    const spent = rows(client.sql, instructionSpendTable.pick("amount"),
      "SELECT amount FROM poppy_instruction_spend WHERE instruction_id = ? AND currency = ? AND state != 'released' AND at >= ?", candidate.id, candidate.budget.currency, since)
      .reduce((sum, row) => sum + (units(row.amount) ?? 0n), 0n);
    if (spent + asked > room) continue;
    return { approved: true, instruction: candidate, spend: { amount: formatUnits(asked), currency: candidate.budget.currency } };
  }
  return { approved: false, reason: active.length ? "no instruction covers these terms" : "no instruction for this Company and account" };
}

// ---------------------------------------------------------------- Deciding

/**
 * A revision the check approved, recorded before the job that sends it
 * runs: the instruction, and the amount its budget reserves. A later
 * revision of the same operation is checked again on its own card.
 */
export function recordAgentDecision(client: PoppyClient, approvalId: string, match: Match, now = Date.now()): void {
  client.sql.exec(
    "INSERT OR IGNORE INTO poppy_instruction_spend (approval_id, instruction_id, amount, currency, state, at) VALUES (?, ?, ?, ?, 'reserved', ?)",
    approvalId, match.instruction.id, match.spend?.amount ?? "0", match.spend?.currency ?? "", now
  );
}

/** The instruction an approval was decided on, while it still stands; undefined once withdrawn. */
export function standingInstructionFor(client: PoppyClient, approvalId: string): Instruction | undefined {
  const spend = one(client.sql, instructionSpendTable.pick("instruction_id"), "SELECT instruction_id FROM poppy_instruction_spend WHERE approval_id = ?", approvalId);
  const found = spend ? instruction(client, spend.instruction_id) : undefined;
  return found && found.withdrawnAt === null ? found : undefined;
}

/**
 * After an agent approval finishes: what was done counts against the
 * budget; what wasn't sent, was refused or failed releases it. An unknown
 * outcome stays reserved, since it may have been performed.
 */
export function settleSpend(client: PoppyClient, approvalId: string): void {
  const status = one(client.sql, approvalsTable.pick("status", "approver"), "SELECT status, approver FROM poppy_approvals WHERE id = ?", approvalId);
  if (!status) return;
  const state = status.approver !== "agent" ? "released"
    : status.status === "done" ? "used"
    : status.status === "unknown" || status.status === "executing" ? "reserved"
    : "released";
  client.sql.exec("UPDATE poppy_instruction_spend SET state = ? WHERE approval_id = ? AND state = 'reserved'", state, approvalId);
}

/** What the ledger shows of an instruction's approvals: each approval it decided, and its outcome. */
export function ledger(client: PoppyClient, instructionId: string): { readonly approvalId: string; readonly state: "reserved" | "used" | "released"; readonly amount: string; readonly currency: string; readonly at: number }[] {
  return rows(client.sql, instructionSpendTable.pick("approval_id", "state", "amount", "currency", "at"),
    "SELECT approval_id, state, amount, currency, at FROM poppy_instruction_spend WHERE instruction_id = ? ORDER BY at DESC", instructionId)
    .map((row) => ({ approvalId: row.approval_id, state: row.state, amount: row.amount, currency: row.currency, at: row.at }));
}

/** An instruction as the model may read it: the User's words and conditions, never writable. */
export function instructionForModel(item: Instruction): Json {
  return {
    instruction: item.id,
    text: item.text,
    account: item.account,
    conditions: item.conditions.map((condition) => ({ ...condition, path: [...condition.path] })) as unknown as Json,
    ...(item.budget ? { budget: { ...item.budget } } : {}),
    note: "Written by the User on their page. You can't add, change or withdraw instructions; the User does that on the Companies page."
  };
}

/**
 * When a Company returns an operation: if the check finds an instruction
 * that covers its terms, record the decision and queue the job that sends
 * it (`decideAsAgent`), so it runs after the request that returned the
 * operation, never inside it. Otherwise the User's card stays as it is.
 */
export async function considerAgentApproval(client: PoppyClient, company: Company, approvalId: string, operation: Pick<OperationV2, "operation_id" | "terms">, label: string): Promise<boolean> {
  const pending = one(client.sql, approvalsTable.pick("status"), "SELECT status FROM poppy_approvals WHERE id = ?", approvalId);
  if (pending?.status !== "pending") return false;
  if (!agentMayApprove(client, company, approvalId, operation.operation_id)) return false;
  const session = client.session(company.issuer, label);
  const match = check(client, company, operation, { account: session?.signed_in ? session.account : null, scope: session?.signed_in ? session.scope : "" });
  if (!match.approved) return false;
  recordAgentDecision(client, approvalId, match);
  await client.host.schedule("poppy-agent-approval", client.host.now(), { id: approvalId }, `agent-approval-${approvalId}`);
  return true;
}

/**
 * 0.4 Ops 5, 6: an operation the agent approved once, or one whose approval
 * the Company declined, is approved again only by the User. A new revision
 * answering the agent's approval, or after a decline, goes to the User's
 * card, so an agent never approves revisions in a loop.
 */
function agentMayApprove(client: PoppyClient, company: Company, approvalId: string, operationId: string): boolean {
  if (wasDeclined(client, company.issuer, operationId)) return false;
  return one(client.sql, approvalsTable.pick("id"),
    "SELECT id FROM poppy_approvals WHERE issuer = ? AND operation_id = ? AND approver = 'agent' AND id != ? LIMIT 1",
    company.issuer, operationId, approvalId) === undefined;
}
