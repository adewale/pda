/**
 * Local approvals: a request the agent makes only once the User has
 * approved it on a card of ours. Any write, an upload of the User's files, a
 * website form, and an operation a Company returned (0.3 Operations 2,
 * `operations-v2.ts`) wait here: the exact request is stored, checked again
 * when approved, and sent once. Also what a card shows of an operation's
 * terms, and where they disagree with its summary or the request (Ops 5).
 */
import { approvalAttachments, approvalBatchKey, readApproval, storedApproval, type ApprovalKind, type ApprovalOf, type NewApproval } from "./approvals";
import { answerOf, PoppyClient, PoppyError, unreadableAnswerOf } from "./client";
import { tokenHostAllowed, type Company } from "./discovery";
import { isObject, type Json } from "./json";
import { randomId } from "./jwt";
import type { OperationV2 } from "./operations-v2";
import type { ApprovalTerms } from "./wire";
import { one, rows } from "../rows";
import { approvalBatchesTable, approvalsTable } from "./store";

/**
 * What the Guides ask an approval to point out (Operations section): costs,
 * dates and conditions found in `terms`, and whether the action can be undone.
 */
export function highlights(terms: Json | undefined): string[] {
  const found: string[] = [];
  let reversibility: string | null = null;
  const walk = (value: Json, path: string) => {
    if (!isObject(value)) {
      if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value.amount === "string" || typeof value.amount === "number") {
      found.push(`Cost (${path || "amount"}): ${value.amount}${typeof value.currency === "string" ? ` ${value.currency}` : ""}`);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const where = path ? `${path}.${key}` : key;
      if (/(date|_at$|time|deadline|until|from)/i.test(key) && typeof item === "string") {
        found.push(`Date (${where}): ${item}`);
      } else if (/(reversible|undo|cancellable|refundable)/i.test(key) && typeof item === "boolean") {
        // Before conditions, whose `cancel` and `refund` would otherwise take `cancellable` and `refundable`.
        reversibility = item ? "The company says this can be undone." : "The company says this can't be undone.";
      } else if (/(condition|cancel|refund|fee|penalt|restock)/i.test(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
        found.push(`Condition (${where}): ${String(item)}`);
      }
      walk(item, where);
    }
  };
  if (terms !== undefined) walk(terms, "");
  found.push(reversibility ?? "The company hasn't said whether this can be undone.");
  return found;
}

/**
 * The total `terms` name, shown large on the card: the `{ amount, currency }`
 * under a key with "total" in it (and not "sub") nearest the top, "total"
 * or "grand_total" first. None when terms don't name
 * one; the card then has no large figure, and the highlights still list every cost.
 */
export function termsTotal(terms: Json | undefined): { amount: string; currency: string } | undefined {
  let level: Json[] = terms === undefined ? [] : [terms];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next: Json[] = [];
    for (const value of level) {
      if (Array.isArray(value)) next.push(...value);
      if (!isObject(value)) continue;
      // "total" or "grand_total" before any other total at the same depth; a subtotal never.
      const totals = Object.entries(value)
        .filter(([key]) => /total/i.test(key) && !/sub/i.test(key))
        .sort(([a], [b]) => Number(!/^(grand[_ -]?)?total$/i.test(a)) - Number(!/^(grand[_ -]?)?total$/i.test(b)));
      for (const [, item] of totals) {
        if (isObject(item) && (typeof item.amount === "string" || typeof item.amount === "number") && typeof item.currency === "string") {
          return { amount: String(item.amount), currency: item.currency };
        }
      }
      next.push(...Object.values(value));
    }
    level = next;
  }
  return undefined;
}

/**
 * Previews `terms` link to, such as a print's crop: HTTPS URLs on the
 * Company's own hosts under a key with "preview" in it, each labelled by
 * where it is ("items 1 preview"). The page links them; it never loads them,
 * since its Content-Security-Policy takes images from our origin only.
 */
export function termsPreviews(company: Company, terms: Json | undefined): { label: string; url: string }[] {
  const found: { label: string; url: string }[] = [];
  const walk = (value: Json, path: string[], inPreview: boolean) => {
    if (found.length >= 12) return;
    if (typeof value === "string") {
      if (!inPreview || !URL.canParse(value)) return;
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || !tokenHostAllowed(company, url)) return;
      found.push({ label: path.join(" ").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "preview", url: url.href });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, String(index + 1)], inPreview));
    else if (isObject(value)) for (const [key, item] of Object.entries(value)) walk(item, [...path, key], inPreview || /preview/i.test(key));
  };
  if (terms !== undefined) walk(terms, [], false);
  return found;
}

/** The longest value a difference quotes, so a Company's long string can't fill the card. */
const QUOTE_LIMIT = 80;
const quoted = (value: string | number | boolean) => {
  const text = String(value);
  return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
};

/** Every number written in a text, commas dropped: "$1,070.50 more" → [1070.5]. */
function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, ""))).filter(Number.isFinite);
}

type Scalar = string | number | boolean;
const isScalar = (value: Json | undefined): value is Scalar => typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** The scalar at exactly `path` in a value, if there is one: what the request asked for in that place. */
function scalarAtPath(value: Json | undefined, path: readonly (string | number)[]): Scalar | undefined {
  let at: Json | undefined = value;
  for (const segment of path) {
    if (typeof segment === "number") at = Array.isArray(at) ? at[segment] : undefined;
    else at = isObject(at) && Object.hasOwn(at, segment) ? at[segment] : undefined;
  }
  return isScalar(at) ? at : undefined;
}

/** Every scalar under `key` anywhere in a value, breadth first, to six levels: what the request asked for under that name. */
function scalarsAt(value: Json | undefined, key: string): Scalar[] {
  const found: Scalar[] = [];
  let level: Json[] = value === undefined ? [] : [value];
  for (let depth = 0; depth < 6 && level.length; depth++) {
    const next: Json[] = [];
    for (const item of level) {
      if (Array.isArray(item)) next.push(...item);
      if (!isObject(item)) continue;
      const named = Object.hasOwn(item, key) ? item[key] : undefined;
      if (isScalar(named)) found.push(named);
      next.push(...Object.values(item));
    }
    level = next;
  }
  return found;
}

/**
 * Where an operation's terms disagree with its summary or with the request
 * that returned it (Ops 5: the agent "SHOULD check that they agree with the
 * `summary` and with what it asked for ... and point out any difference").
 * Two checks, both mechanical: every amount the terms name appears as a
 * number in the summary (its size: a refund of -20.00 may be written
 * "20.00"), and every scalar the terms name has the request's value: the
 * request's at the same place, or, where the request has none there, one
 * of the request's under the same key, if it used that key. So an order of
 * several items, each with its own `sku`, agrees with itself. Wording,
 * dates and anything else the summary says are left to the User, who
 * reads it in full.
 */
export function termsDifferences(operation: Pick<OperationV2, "summary" | "terms">, asked: Json | undefined): string[] {
  const differences: string[] = [];
  const written = numbersIn(operation.summary);
  const walk = (value: Json, path: string, segments: readonly (string | number)[]) => {
    if (differences.length >= 8) return;
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`, [...segments, index]));
    if (!isObject(value)) return;
    if (typeof value.amount === "string" || typeof value.amount === "number") {
      const amount = Number(value.amount);
      const currency = typeof value.currency === "string" ? ` ${value.currency}` : "";
      if (!Number.isFinite(amount) || !written.includes(Math.abs(amount))) {
        differences.push(`The terms name ${quoted(value.amount)}${quoted(currency)} (${path || "amount"}), which the summary doesn't mention.`);
      }
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const where = path ? `${path}.${key}` : key;
      if (isScalar(item)) {
        const here = scalarAtPath(asked, [...segments, key]);
        const sent = here === undefined ? scalarsAt(asked, key) : [here];
        if (sent.length > 0 && !sent.some((value) => String(value) === String(item))) {
          differences.push(`The terms say ${where} is ${quoted(item)}, but the request asked for ${quoted(sent[0]!)}.`);
        }
      } else {
        walk(item, where, [...segments, key]);
      }
    }
  };
  if (operation.terms !== undefined) walk(operation.terms, "", []);
  return differences.slice(0, 8);
}

/** What the approval card shows of an operation (Ops 5): the Company's summary, its expiry, and what its terms name. */
export function approvalTerms(company: Company, operation: OperationV2, asked: Json | undefined): ApprovalTerms {
  const total = termsTotal(operation.terms);
  const previews = termsPreviews(company, operation.terms);
  const differences = termsDifferences(operation, asked);
  return {
    summary: operation.summary.trim(),
    expiresAt: operation.expires_at,
    highlights: highlights(operation.terms),
    ...(total ? { total } : {}),
    ...(previews.length ? { previews } : {}),
    ...(differences.length ? { differences } : {})
  };
}

// ---------------------------------------------------------------- Local approvals

/**
 * What an executor throws when the request it sent, as the User approved
 * it, came back with an operation of the Company's (Ops 4): our card's
 * request was sent, and nothing is done until the User approves the
 * Company's terms on the card that now waits.
 */
export class TermsRequested extends Error {
  constructor(readonly result: string) {
    super(result);
  }
}

/** How an approved local action of one kind is carried out (registered by the APIs and browser). */
export type ApprovalExecution = { readonly beforeDispatch: () => void };
export type ApprovalExecutor<K extends ApprovalKind> = (client: PoppyClient, company: Company, approval: ApprovalOf<K>, label: string, execution: ApprovalExecution) => Promise<string>;
const executors: { [K in ApprovalKind]?: ApprovalExecutor<K> } = {};

export function registerExecutor<K extends ApprovalKind>(kind: K, executor: ApprovalExecutor<K>): void {
  (executors as Record<K, ApprovalExecutor<K>>)[kind] = executor;
}

function run<K extends ApprovalKind>(client: PoppyClient, company: Company, approval: ApprovalOf<K>, label: string, execution: ApprovalExecution): Promise<string> {
  const executor = executors[approval.kind] as ApprovalExecutor<K> | undefined;
  if (!executor) throw new Error(`No executor for ${approval.kind}`);
  return executor(client, company, approval, label, execution);
}

/**
 * A write no operation covers (any write at a Company without the
 * extension, or one whose description doesn't say it proposes), an upload,
 * or a website submit waits for the User's click: the exact request is
 * stored, and only an approval makes it, once (spec, Safety). Returns the
 * approval id.
 */
export async function proposeLocal(
  client: PoppyClient,
  company: Company,
  label: string,
  summary: string,
  approval: NewApproval,
  /** A fixed id, so a replayed tool call shows the same card rather than a second one. */
  fixedId?: string,
  /** An operation's terms, for a Company's approval (Ops 5). */
  terms?: ApprovalTerms
): Promise<string> {
  const id = fixedId ?? randomId("apr_");
  const stored = storedApproval(approval);
  const attachments = approvalAttachments(stored);
  const existing = one(client.sql, approvalRow, "SELECT * FROM poppy_approvals WHERE id = ?", id);
  // A Company's terms have one card per revision (operations-v2.ts `approvalCardId`), so a new request of
  // the User's that the Company answers with the same revision asks for the same terms again (Ops 4).
  const askedAgain = terms !== undefined && existing !== undefined && existing.issuer === company.issuer && existing.label === label && existing.summary === summary && existing.request !== stored;
  if (askedAgain) {
    // Sent already: its outcome stands, and the Company performs it at most once (Ops 7).
    if (existing.status !== "pending" && existing.status !== "declined" && existing.status !== "failed") return id;
    // Waiting, declined, or never sent: the card waits for the User's decision on the newest request.
    client.sql.exec(
      "UPDATE poppy_approvals SET request = ?, terms = ?, status = 'pending', result = NULL WHERE id = ? AND status = ?",
      stored,
      JSON.stringify(terms),
      id,
      existing.status
    );
  } else if (existing && (existing.issuer !== company.issuer || existing.label !== label || existing.request !== stored || existing.summary !== summary)) {
    throw new PoppyError("approval_changed", "This tool call already proposed a different request. Use a new call for fresh approval.", 0);
  }
  if (existing && !askedAgain && existing.status !== "pending") return id;
  if (!existing) {
    client.rememberCompany("approval", id, company);
    client.sql.exec(
      "INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at, terms) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
      id,
      company.issuer,
      label,
      summary,
      stored,
      Date.now(),
      terms ? JSON.stringify(terms) : null
    );
  }
  await client.host.showCard({
    id: `approval-${id}`,
    kind: "approval",
    company: company.name,
    domain: company.domain,
    open: true,
    approvalId: id,
    summary,
    status: "pending",
    ...(terms ? { terms } : {}),
    ...attachments,
    ...batchKeyOf(company.issuer, stored)
  });
  return id;
}

function batchKeyOf(issuer: string, request: string): { batchKey?: string } {
  const key = approvalBatchKey(issuer, request);
  return key ? { batchKey: key } : {};
}

const approvalRow = approvalsTable.pick("id", "issuer", "label", "summary", "request", "status", "terms");

/**
 * Decide one local approval and do what it says. Returns what the model is to
 * be told, or null when it was already decided; the caller tells the model,
 * once for one card and once for a batch (`decideLocal`, `decideLocalBatch`).
 */
async function decideOne(client: PoppyClient, id: string, decision: "approve" | "decline"): Promise<string | null> {
  const row = one(client.sql, approvalRow, "SELECT * FROM poppy_approvals WHERE id = ?", id);
  if (!row || row.status !== "pending") return null;
  const company = await client.resumeCompany(row.issuer, "approval", id);
  // Discovery may have yielded to another decision. Only one handler may
  // claim this exact pending request, including a decline racing an approval.
  const claimed = client.sql.exec(
    "UPDATE poppy_approvals SET status = ? WHERE id = ? AND status = 'pending' AND issuer = ? AND label = ? AND request = ? AND summary = ? RETURNING id",
    decision === "decline" ? "declined" : "executing", id, row.issuer, row.label, row.request, row.summary
  ).toArray();
  if (claimed.length === 0) return null;
  const card = (status: "approved" | "declined" | "done" | "terms" | "refused" | "failed" | "unknown", result?: string, answer?: { status: number; error?: string }) =>
    client.host.showCard({
      id: `approval-${id}`,
      kind: "approval",
      company: company.name,
      domain: company.domain,
      open: false,
      approvalId: id,
      summary: row.summary,
      status,
      ...(row.terms ? { terms: row.terms } : {}),
      ...(result ? { result } : {}),
      ...(answer ? { answer } : {}),
      ...approvalAttachments(row.request),
      ...batchKeyOf(row.issuer, row.request)
    });
  if (decision === "decline") {
    await card("declined");
    return `[system] The User declined: ${row.summary}`;
  }
  // A request stored in another form, or tampered with, is never sent.
  const read = readApproval(row.request);
  if (!read.ok) {
    const result = `Not sent: this approval can't be sent, because ${read.problem}. Nothing was sent; ask again if you still want it.`;
    client.sql.exec("UPDATE poppy_approvals SET status = 'failed', result = ? WHERE id = ?", result, id);
    await card("failed", result);
    return `[system] The User approved, but the stored request couldn't be sent (${read.problem}), so nothing was sent: ${row.summary}. Ask again if the User still wants it.`;
  }
  // The card says it is being sent, so a page shows each one's progress (a batch's tiles, the step that asked).
  await card("approved");
  try {
    const result = await run(client, company, read.value, row.label, { beforeDispatch: () => {
      const current = one(client.sql, approvalRow, "SELECT * FROM poppy_approvals WHERE id = ?", id);
      if (!current || current.status !== "executing" || current.request !== row.request || current.issuer !== row.issuer || current.label !== row.label) {
        throw new PoppyError("approval_changed", "The stored approval changed; no further attempt will be sent", 0);
      }
    } });
    client.sql.exec("UPDATE poppy_approvals SET status = 'done', result = ? WHERE id = ?", result, id);
    await card("done", result);
    return `[system] Done, as the User approved: ${row.summary}. Result: ${result}`;
  } catch (error) {
    if (error instanceof TermsRequested) {
      client.sql.exec("UPDATE poppy_approvals SET status = 'terms', result = ? WHERE id = ?", error.result, id);
      await card("terms", error.result);
      return `[system] Sent as the User approved, and ${company.name} asks the User to approve its exact terms first, on a new card; nothing has happened yet: ${row.summary}. Don't tell the User it was done.`;
    }
    // A Company's refusal keeps its code, as tool failures show it.
    const message = error instanceof PoppyError ? `${error.message} [${error.code}]` : error instanceof Error ? error.message : String(error);
    const answer = answerOf(error);
    const name = company.name;
    const unreadableStatus = unreadableAnswerOf(error);
    if (unreadableStatus !== undefined) {
      const result = `Sent as you approved; ${name} answered HTTP ${unreadableStatus}, but its response could not be read or validated. It may have processed the request. Check with ${name} before asking again; this request will not be resent automatically.`;
      client.sql.exec("UPDATE poppy_approvals SET status = 'unknown', result = ? WHERE id = ?", result, id);
      await card("unknown", result, { status: unreadableStatus });
      return `[system] The approved request reached ${name} and answered HTTP ${unreadableStatus}, but its result could not be read or validated. It may have happened. Tell the User to check with ${name}; do not retry automatically: ${row.summary}.`;
    }
    if (answer === "none") {
      // Sent, and no answer came: it may have happened (Safety). Never retried.
      const result = `Sent as you approved, but no answer came from ${name}, so it may or may not have reached them. Check with ${name} before asking again.`;
      client.sql.exec("UPDATE poppy_approvals SET status = 'unknown', result = ? WHERE id = ?", result, id);
      await card("unknown", result);
      return `[system] Sent as the User approved, but no answer came from ${name} (${message}), so it may or may not have happened: ${row.summary}. Tell the User to check with ${name}; it won't be retried automatically.`;
    }
    if (typeof answer === "number") {
      // The Company answered, and not with success: sent as approved, not done as far as it says.
      const code = error instanceof PoppyError && error.code !== `http_${answer}` ? error.code : undefined;
      const answered = `${answer}${code ? ` (${code})` : ""}`;
      const result = `Sent as you approved, but ${name} answered ${answered}. Nothing changed unless ${name} says otherwise.`;
      client.sql.exec("UPDATE poppy_approvals SET status = 'refused', result = ? WHERE id = ?", result, id);
      await card("refused", result, { status: answer, ...(code ? { error: code } : {}) });
      return `[system] Sent as the User approved, but ${name} answered ${answered}, so it wasn't done as far as ${name} says: ${row.summary}. Don't tell the User it was done. ${message}`;
    }
    // No answer marked: the agent refused it before sending, couldn't get an access token, or couldn't read the answer.
    client.sql.exec("UPDATE poppy_approvals SET status = 'failed', result = ? WHERE id = ?", message, id);
    await card("failed", message);
    return `[system] The approved action failed: ${row.summary}. ${message}`;
  }
}

/** Decide one local approval, from its own card, and tell the model what happened. */
export async function decideLocal(client: PoppyClient, id: string, decision: "approve" | "decline"): Promise<void> {
  const notice = await decideOne(client, id, decision);
  if (notice) await client.host.notifyModel(notice, `poppy-approval-${id}`);
}

/** The most approvals one card decides: a print shop keeps 100 photos a Session. */
export const BATCH_LIMIT = 100;

/**
 * Approvals the User decided together on one card (`poppy.approvals`). Every
 * one must still be waiting and share one batch key (`approvalBatchKey`):
 * uploads of the User's photos to one Company's same method and URL. A batch
 * that mixes anything else is refused whole, so a request can't ride along
 * on another's card. They are sent one at a time, each recorded on its own
 * row, and the model is told once, when all are done, rather than starting
 * a turn for each. Ones already decided are skipped, so a replay is harmless.
 */
export async function decideLocalBatch(client: PoppyClient, decisions: readonly { approvalId: string; decision: "approve" | "decline" }[]): Promise<void> {
  const ids = decisions.map((item) => item.approvalId);
  if (decisions.length === 0 || decisions.length > BATCH_LIMIT || new Set(ids).size !== ids.length) {
    throw new PoppyError("batch_refused", `Decide 1 to ${BATCH_LIMIT} different requests at once.`, 0);
  }
  const waiting = decisions.flatMap((item) => {
    const row = one(client.sql, approvalRow, "SELECT * FROM poppy_approvals WHERE id = ?", item.approvalId);
    return row && row.status === "pending" ? [{ ...item, row }] : [];
  });
  if (waiting.length === 0) return;
  const keys = new Set(waiting.map((item) => approvalBatchKey(item.row.issuer, item.row.request)));
  if (keys.size !== 1 || keys.has(undefined)) {
    throw new PoppyError("batch_refused", "These requests can't be decided together. Decide each on its own card.", 0);
  }
  const batch = randomId("apb_");
  client.sql.exec(
    "INSERT INTO poppy_approval_batches (id, ids, told, created_at) VALUES (?, ?, 0, ?)",
    batch,
    JSON.stringify(waiting.map((item) => item.approvalId)),
    Date.now()
  );
  const lines: string[] = [];
  for (const item of waiting) {
    try {
      const notice = await decideOne(client, item.approvalId, item.decision);
      if (notice) lines.push(notice.replace(/^\[system\] /, ""));
    } catch (error) {
      // One that couldn't be decided doesn't stop the rest; the model hears why.
      lines.push(`This one couldn't be decided (${error instanceof PoppyError ? error.code : "error"}): ${item.row.summary}`);
    }
  }
  await tellBatch(client, batch, lines);
}

async function tellBatch(client: PoppyClient, batch: string, lines: readonly string[]): Promise<void> {
  if (lines.length) {
    await client.host.notifyModel(
      `[system] The User decided ${lines.length === 1 ? "this request" : `${lines.length} requests together`} on one card:\n${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}`,
      `poppy-approvals-${batch}`
    );
  }
  client.sql.exec("UPDATE poppy_approval_batches SET told = 1 WHERE id = ?", batch);
}

const BATCH_STATUS: Record<string, string> = {
  declined: "The User declined",
  done: "Done, as the User approved",
  refused: "Sent as the User approved, but the Company refused it, so it wasn't done as far as the Company says",
  failed: "The approved action failed",
  unknown: "Its outcome is unknown: it may or may not have happened, and it won't be retried automatically"
};

/**
 * After a restart: a batch the agent stopped part way through. Run after
 * `recoverInterruptedApprovals`, so one stopped mid-call already reads
 * unknown. The model is told what each row says; one still waiting keeps its
 * card, for the User to decide again.
 */
export async function recoverApprovalBatches(client: PoppyClient): Promise<void> {
  for (const batch of rows(client.sql, approvalBatchesTable.pick("id", "ids"), "SELECT id, ids FROM poppy_approval_batches WHERE told = 0")) {
    let ids: unknown;
    try {
      ids = JSON.parse(batch.ids);
    } catch {
      ids = [];
    }
    const lines = (Array.isArray(ids) ? ids : []).flatMap((id) => {
      const row = typeof id === "string" ? one(client.sql, approvalsTable.pick("summary", "status", "result"), "SELECT summary, status, result FROM poppy_approvals WHERE id = ?", id) : undefined;
      const status = row ? BATCH_STATUS[row.status] : undefined;
      if (!row || !status) return [];
      return [`${status}: ${row.summary}.${row.status === "done" && row.result ? ` Result: ${row.result}` : ""}`];
    });
    await tellBatch(client, batch.id, lines);
  }
}

/** After a restart: approvals left mid-call have an unknown outcome; say so, never retry. */
export async function recoverInterruptedApprovals(client: PoppyClient): Promise<void> {
  // One in a batch the model hasn't heard about yet is told with its batch (recoverApprovalBatches).
  const batched = new Set(
    rows(client.sql, approvalBatchesTable.pick("ids"), "SELECT ids FROM poppy_approval_batches WHERE told = 0").flatMap((row) => {
      try {
        const ids: unknown = JSON.parse(row.ids);
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      } catch {
        return [];
      }
    })
  );
  for (const row of rows(client.sql, approvalRow, "SELECT * FROM poppy_approvals WHERE status = 'executing'")) {
    let company = "the company";
    try {
      company = client.companyByIssuer(row.issuer).name;
    } catch {
      // Unknown issuer; keep the generic name.
    }
    client.sql.exec(
      "UPDATE poppy_approvals SET status = 'unknown', result = ? WHERE id = ?",
      `Interrupted after you approved, so it may or may not have reached ${company}. Check with ${company} before asking again.`,
      row.id
    );
    await client.host.showCard({
      id: `approval-${row.id}`,
      kind: "approval",
      company,
      open: false,
      approvalId: row.id,
      summary: row.summary,
      status: "unknown",
      ...(row.terms ? { terms: row.terms } : {}),
      result: `It may have happened: check with ${company} before asking again.`,
      ...approvalAttachments(row.request)
    });
    if (batched.has(row.id)) continue;
    await client.host.notifyModel(
      `[system] An approved action was interrupted and its outcome is unknown: ${row.summary}. Tell the User to check with ${company}; it won't be retried automatically.`,
      `poppy-approval-${row.id}`
    );
  }
}
