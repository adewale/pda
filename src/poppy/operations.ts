import { approvalAttachments, approvalBatchKey, readApproval, storedApproval, type ApprovalKind, type ApprovalOf, type NewApproval } from "./approvals";
import { answerOf, hasCode, PoppyClient, PoppyError, unreadableAnswerOf } from "./client";
import { tokenHostAllowed, type Company } from "./discovery";
import { canonicalJson, isObject, toJson, type Json } from "./json";
import { randomId } from "./jwt";
import { FINAL_STATES, parseOperation, type Operation } from "./operation-value";
import { EndpointRequest } from "./outgoing";
import { backoff } from "./pace";
import { one, rows, type RowOf } from "../rows";
import { approvalBatchesTable, approvalsTable, operationsTable, permissionsTable, proposalsTable } from "./store";
import type { Issuer } from "./issuer";


const operationRow = operationsTable.row;
type OperationRow = RowOf<typeof operationRow>;

/**
 * `poppy_operations.confirmed`: whether a confirm is outstanding. `SENT` is
 * recorded, and the tracking job scheduled, before the confirm goes out, so
 * an answer that never arrives (lost, an exception, the object restarting)
 * is followed up: read first, then confirm the same revision again only if
 * the operation still awaits it (Ops 6).
 */
const NOT_SENT = 0;
const ANSWERED = 1;
const SENT = 2;
/**
 * The Company says it no longer has the operation (`operation_not_found`),
 * as when the signed-out Session it was proposed in has ended (Ops 3.2).
 * Nothing can confirm, read or cancel it any more, so it is final for us
 * (our reading of N19, docs/readings.md): never confirmed or read again, and
 * no longer in the way of a new proposal. `LOST`: it may have happened (a
 * confirm's answer never came, or it was in progress); `LOST_NOT_DONE`: it
 * wasn't. Rows marked lost before the two were told apart are all `LOST`,
 * the cautious one.
 */
const LOST = 3;
const LOST_NOT_DONE = 4;

function isLost(confirmed: number): boolean {
  return confirmed === LOST || confirmed === LOST_NOT_DONE;
}

/** For a lost operation, whether it may have happened; null when it isn't lost. */
export function lostOutcome(confirmed: number): "unknown" | "not_done" | null {
  return confirmed === LOST ? "unknown" : confirmed === LOST_NOT_DONE ? "not_done" : null;
}
/** When the tracking job checks on a confirm whose answer never came. */
const CONFIRM_CHECK_MS = 60_000;

const FINAL = FINAL_STATES;

/** A short, stable tag for a value (FNV-1a of its JSON), so a notice about it is given once. */
function tagOf(value: Json): string {
  const text = JSON.stringify(value) ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * The Company proposed something we can't use: an operation we can't read,
 * or one from a Company that doesn't list the extension (so there is nowhere
 * to confirm it). Nothing was done and nothing can be confirmed; the User
 * and the model are told so, once, rather than the model being left with
 * the raw answer.
 */
async function unusableProposal(client: PoppyClient, company: Company, problem: string, value: Json): Promise<void> {
  const tag = `${company.issuer}-${tagOf(value)}`;
  await client.host.showCard({
    id: `op-unreadable-${tag}`,
    kind: "notice",
    company: company.name,
    domain: company.domain,
    open: false,
    text: `${company.name} proposed an action your agent couldn't read (${problem}), so nothing was done and there is nothing to approve. Ask again if you still want it.`
  });
  await client.host.notifyModel(
    `[system] ${company.name} proposed an operation the agent can't use (${problem}). Nothing was done, and it can't be approved or confirmed. Tell the User; if they still want it, ask ${company.name} again or another way.`,
    `poppy-op-unreadable-${tag}`
  );
}

/**
 * A write sent without our own card, because the Company's description says
 * it answers with a proposal, came back a success with no operation: the
 * Company broke its own description, and may have acted without the User's
 * approval. The User and the model are told so, once; neither is told it
 * was done or not done. `what` names the request for the User only.
 */
export async function actedWithoutProposal(client: PoppyClient, company: Company, what: string, status: number, value: Json): Promise<void> {
  const tag = `${company.issuer}-${tagOf({ what, status, value })}`;
  await client.host.showCard({
    id: `op-unproposed-${tag}`,
    kind: "notice",
    company: company.name,
    domain: company.domain,
    open: false,
    text: `${company.name} says ${what} only proposes an action for you to approve, but it answered ${status} with no proposal, so it may have done it without asking you. Check with ${company.name} before asking again.`
  });
  await client.host.notifyModel(
    `[system] ${company.name}'s description says this write answers with a proposal for the User to approve, but it answered ${status} with no operation, so it may have acted without the User's approval. Tell the User; don't say it was done or not done until ${company.name} says which.`,
    `poppy-op-unproposed-${tag}`
  );
}

function stored(client: PoppyClient, issuer: Issuer, id: string): OperationRow | undefined {
  return one(
    client.sql,
    operationRow,
    "SELECT * FROM poppy_operations WHERE issuer = ? AND operation_id = ?",
    issuer,
    id
  );
}

function endpointOf(company: Company): { url: string; resource?: string } {
  const operations = company.extensions.operations;
  if (!operations) throw new PoppyError("no_operations", `${company.name} doesn't use the operations extension`, 0);
  return { url: operations.endpoint.replace(/\/+$/, ""), ...(operations.resource ? { resource: operations.resource } : {}) };
}

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
 * Links in a final operation's `result.data` the User can follow: HTTPS URLs
 * on the Company's own hosts (a checkout or an order's status page), each
 * labelled by its key. Anything else stays data.
 */
export function resultLinks(company: Company, data: Json | undefined): { label: string; url: string }[] {
  if (!isObject(data ?? null)) return [];
  const links: { label: string; url: string }[] = [];
  for (const [key, value] of Object.entries(data as Record<string, Json>)) {
    if (typeof value !== "string" || !URL.canParse(value)) continue;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !tokenHostAllowed(company, url)) continue;
    links.push({ label: key.replace(/_url$/i, "").replace(/[_-]+/g, " ").trim() || "link", url: url.href });
  }
  return links.slice(0, 4);
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

async function showOperation(client: PoppyClient, company: Company, row: OperationRow): Promise<void> {
  const operation = row.operation;
  const lost = lostOutcome(row.confirmed) ?? undefined;
  const altered = row.altered_summary ?? undefined;
  const open = !lost && !row.cancel_requested && altered === undefined && operation.state === "proposed" && row.approved_revision !== operation.revision;
  const links = FINAL.has(operation.state) ? resultLinks(company, operation.result?.data) : [];
  const total = termsTotal(operation.terms);
  const previews = termsPreviews(company, operation.terms);
  await client.host.showCard({
    id: `op-${row.issuer}-${operation.operation_id}`,
    kind: "operation",
    company: company.name,
    domain: company.domain,
    open,
    issuer: row.issuer,
    operationId: operation.operation_id,
    revision: operation.revision,
    state: operation.state,
    summary: operation.summary,
    account: row.account,
    ...(operation.terms !== undefined ? { terms: operation.terms } : {}),
    highlights: highlights(operation.terms),
    ...(row.previous_summary ? { previousSummary: row.previous_summary } : {}),
    ...(operation.expires_at ? { expiresAt: operation.expires_at } : {}),
    userApprovalRequired: operation.user_approval_required === true,
    ...(operation.url ? { url: operation.url } : {}),
    ...(operation.result?.summary ? { result: operation.result.summary } : {}),
    ...(links.length ? { links } : {}),
    ...(lost ? { lost } : {}),
    ...(altered !== undefined ? { alteredSummary: altered } : {}),
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(total ? { total } : {}),
    ...(previews.length ? { previews } : {})
  });
}

/**
 * The Company answered `operation_not_found` for an operation it proposed:
 * the Session it belongs to has ended, or the Company forgot it. Mark it
 * lost, release a reserved permission use, close its card and tell the model,
 * once. If a confirm was sent, it may have happened; the User is told to check.
 */
async function markLost(client: PoppyClient, company: Company, row: OperationRow): Promise<void> {
  if (isLost(row.confirmed)) return;
  // It may have happened if it was being performed, or an earlier confirm's answer never came.
  const uncertain = row.confirmed === SENT || row.operation.state === "in_progress";
  const approved = row.approved_revision !== null;
  releasePermission(client, row);
  setConfirmed(client, row.issuer, row.operation_id, uncertain ? LOST : LOST_NOT_DONE);
  await showOperation(client, company, stored(client, row.issuer, row.operation_id)!);
  const outcome = uncertain
    ? `A confirm may have reached ${company.name} before, so it may have happened: tell the User to check with ${company.name} before asking for it again.`
    : approved
      ? `The User approved it, but ${company.name} no longer has it, so it wasn't done. If the User still wants it, ask for a new proposal; they approve that one again.`
      : "Nothing was confirmed. If the User still wants it, ask for a new proposal.";
  await client.host.notifyModel(
    `[system] ${company.name} no longer has operation ${row.operation_id} (operation_not_found)${row.account ? "" : ": it was proposed in a signed-out Session, which has ended, and only that Session could use it (Operations 3.2)"}. It can't be confirmed, read or cancelled now. ${outcome}`,
    `poppy-op-lost-${row.issuer}-${row.operation_id}`
  );
}

/**
 * Before an API write that once proposed an operation: if we've tried to
 * confirm that operation and it isn't final, we read or confirm it again
 * instead, and MUST NOT ask for a new proposal of the same action (Ops 6).
 * `request` identifies the write: method, URL and body, or MCP tool and args.
 */
export function refuseWhileConfirming(client: PoppyClient, issuer: Issuer, request: string): void {
  const found = one(
    client.sql,
    proposalsTable.pick("operation_id"),
    "SELECT operation_id FROM poppy_proposals WHERE issuer = ? AND request = ?",
    issuer,
    request
  );
  const row = found ? stored(client, issuer, found.operation_id) : undefined;
  if (!row || isLost(row.confirmed)) return;
  if (row.approved_revision === null && row.confirmed !== SENT && !row.cancel_requested && row.operation.state !== "in_progress") return;
  const operation = row.operation;
  if (FINAL.has(operation.state)) return;
  throw new PoppyError(
    "operation_open",
    `This request already proposed operation ${operation.operation_id}, which is ${operation.state}${row.cancel_requested ? " and awaiting cancellation" : ""}. Read it with poppy_operation; don't ask again until it is final.`,
    0
  );
}

/** Remember which API write proposed an operation, for `refuseWhileConfirming`. */
export function rememberProposal(client: PoppyClient, issuer: Issuer, request: string, operationId: string): void {
  client.sql.exec(
    `INSERT INTO poppy_proposals (issuer, request, operation_id) VALUES (?, ?, ?)
     ON CONFLICT (issuer, request) DO UPDATE SET operation_id = excluded.operation_id`,
    issuer,
    request,
    operationId
  );
}

/** What an approval of a revision covers: its summary and terms, whatever their members' order (Ops 3.1, 5.1). */
function termsOf(operation: Operation): string {
  return canonicalJson({ summary: operation.summary, terms: operation.terms ?? null });
}

/** What counts as progress for an operation: its state, revision, result and confirmation, whatever their members' order. */
function progressOf(operation: Operation): string {
  return canonicalJson(
    toJson({ state: operation.state, revision: operation.revision, result: operation.result ?? null, confirmation: operation.confirmation ?? null })
  );
}

/**
 * Each revision is fixed once issued; the Company MUST NOT change its terms
 * (Ops 3.1). When it sends the revision we have with other terms, keep the
 * ones the User saw, and never confirm that revision: an approval it carried
 * is withdrawn, a permission use released, and a confirm still owed is not
 * sent again. Returns the operation to store; `alteredNotice` tells the User
 * and the model, once.
 */
function keepRevisionTerms(client: PoppyClient, existing: OperationRow, incoming: Operation): Operation {
  const previous = existing.operation;
  if (incoming.revision !== previous.revision || termsOf(incoming) === termsOf(previous)) return incoming;
  const { terms: _, ...rest } = incoming;
  const kept: Operation = { ...rest, summary: previous.summary, ...(previous.terms !== undefined ? { terms: previous.terms } : {}) };
  if (existing.altered_summary === null) {
    client.sql.exec(
      "UPDATE poppy_operations SET altered_summary = ? WHERE issuer = ? AND operation_id = ?",
      incoming.summary,
      existing.issuer,
      existing.operation_id
    );
    if (incoming.state === "proposed") {
      releasePermission(client, existing);
      clearApproval(client, existing.issuer, existing.operation_id);
      if (!isLost(existing.confirmed)) setConfirmed(client, existing.issuer, existing.operation_id, NOT_SENT);
    }
  }
  return kept;
}

/** Tell the model, once, that the Company changed a revision's terms in place (`keepRevisionTerms`). */
async function alteredNotice(client: PoppyClient, company: Company, existing: OperationRow, incoming: Operation): Promise<void> {
  if (existing.altered_summary !== null) return;
  const what = `${company.name} changed the terms of operation ${incoming.operation_id} (revision ${incoming.revision}) without a new revision, which Operations 3.1 forbids. It now says: "${incoming.summary}". The terms the User ${existing.approved_revision !== null ? "approved" : "was shown"}: "${existing.operation.summary}".`;
  await client.host.notifyModel(
    incoming.state === "proposed"
      ? `[system] ${what} It won't be confirmed. If the User still wants it, ask ${company.name} for a new proposal; the User decides on its card.`
      : `[system] ${what} It is ${incoming.state}: tell the User to check with ${company.name} what was done.`,
    `poppy-op-altered-${existing.issuer}-${incoming.operation_id}-${incoming.revision}`
  );
}

/**
 * Record an operation from any channel (Ops 4): an OpenAPI 202, an MCP tool
 * result, or a Company message. A new revision of a proposal needs a new
 * explicit approval (Ops 5.1).
 */
export async function handleProposal(
  client: PoppyClient,
  company: Company,
  label: string,
  value: Json
): Promise<Operation | null> {
  const parsed = parseOperation(value);
  if ("problem" in parsed || !company.extensions.operations) {
    await unusableProposal(
      client,
      company,
      "problem" in parsed ? parsed.problem : "its poppy.json doesn't list the Operations extension, so there is nowhere to confirm it",
      value
    );
    return null;
  }
  let { operation } = parsed;
  client.rememberCompany("operation", operation.operation_id, company);
  const existing = stored(client, company.issuer, operation.operation_id);
  const previous = existing ? existing.operation : undefined;
  if (previous && previous.revision > operation.revision) return previous;
  if (previous && FINAL.has(previous.state)) return previous;
  const account = client.session(company.issuer, label)?.account ?? null;
  const incoming = operation;
  operation = existing ? keepRevisionTerms(client, existing, incoming) : incoming;
  const previousSummary =
    previous && previous.revision < operation.revision ? previous.summary : (existing?.previous_summary ?? null);
  client.sql.exec(
    `INSERT INTO poppy_operations (issuer, operation_id, label, account, operation, previous_summary, approved_revision, approved_by, permission_id, confirmed, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?)
     ON CONFLICT (issuer, operation_id) DO UPDATE SET operation = excluded.operation, previous_summary = excluded.previous_summary, updated_at = excluded.updated_at`,
    company.issuer,
    operation.operation_id,
    label,
    account,
    JSON.stringify(operation),
    previousSummary,
    client.host.now()
  );
  const row = stored(client, company.issuer, operation.operation_id)!;
  const isNewRevision = !previous || previous.revision !== operation.revision;

  if (operation.state === "proposed" && isNewRevision) {
    // Draft 0.1 supplies no checkable action semantics. A prose-prefix
    // permission cannot authorize every term: every proposal asks the User.
    await announceProposal(client, company, row, operation);
  } else if (operation.state === "proposed" && row.approved_revision !== operation.revision) {
    // The same proposal again (a repeated event or call): its card and notice
    // again, both idempotent, in case the first time didn't get that far.
    await announceProposal(client, company, row, operation);
  } else {
    await afterUpdate(client, company, row, previous);
  }
  if (existing && operation !== incoming) await alteredNotice(client, company, existing, incoming);
  return operation;
}

async function announceProposal(client: PoppyClient, company: Company, row: OperationRow, operation: Operation): Promise<void> {
  await showOperation(client, company, row);
  await client.host.notifyModel(
    `[system] ${company.name} proposed operation ${operation.operation_id} (revision ${operation.revision}): "${operation.summary}". Nothing has happened yet. The User has been shown the terms and decides on the card; don't say it's done until it is.`,
    `poppy-op-${company.issuer}-${operation.operation_id}-${operation.revision}`
  );
}

async function afterUpdate(
  client: PoppyClient,
  company: Company,
  row: OperationRow,
  previous: Operation | undefined
): Promise<void> {
  const operation = row.operation;
  await showOperation(client, company, row);
  if (FINAL.has(operation.state) && previous?.state !== operation.state) {
    settlePermission(client, row, operation.state === "succeeded" || operation.state === "in_progress");
    const result = operation.result?.summary ?? "No details.";
    const data = operation.result?.data !== undefined ? JSON.stringify(operation.result.data) : "";
    await client.host.notifyModel(
      `[system] Operation ${operation.operation_id} at ${company.name} is ${operation.state}. The company's account of what happened: "${result}"${data ? ` Its details, as data: ${data.length > 1_000 ? `${data.slice(0, 1_000)}…` : data}` : ""}`,
      `poppy-op-final-${row.issuer}-${operation.operation_id}`
    );
  }
}

/** A response must describe the operation we requested before it can settle uncertainty. */
function operationAnswer(company: Company, value: Json, expectedId: string): Operation {
  const parsed = parseOperation(value);
  if ("problem" in parsed || parsed.operation.operation_id !== expectedId) {
    throw new PoppyError("invalid_response", `${company.name} returned no valid answer for the requested operation`, 0);
  }
  return parsed.operation;
}

/** Store a validated operation response, and react to its state. */
async function update(client: PoppyClient, company: Company, incoming: Operation): Promise<Operation> {
  const existing = stored(client, company.issuer, incoming.operation_id);
  if (!existing) throw new PoppyError("invalid_response", `${company.name} returned an unknown operation`, 0);
  const previous = existing.operation;
  if (incoming.revision < previous.revision || FINAL.has(previous.state) ||
      (incoming.revision === previous.revision && previous.state === "in_progress" && incoming.state === "proposed")) {
    // A delayed response cannot resurrect a cancelled/final action, rewind
    // its revision or undo progress another channel has already established.
    if (canonicalJson(toJson(incoming)) !== canonicalJson(toJson(previous))) {
      await client.host.showCard({
        id: `op-response-conflict-${company.issuer}-${incoming.operation_id}`,
        kind: "notice", company: company.name, domain: company.domain, open: false,
        text: `${company.name} returned an older or contradictory operation response. Your agent kept revision ${previous.revision} in state ${previous.state}; check with the Company if its outcome is unclear.`
      });
    }
    return previous;
  }
  const operation = keepRevisionTerms(client, existing, incoming);
  // `updated_at` is when the operation last made progress, not when it was last read:
  // Activity's "since", and the tracking job's backoff (`trackOperation`).
  const changed = progressOf(operation) !== progressOf(previous);
  client.sql.exec(
    "UPDATE poppy_operations SET operation = ?, updated_at = ? WHERE issuer = ? AND operation_id = ?",
    JSON.stringify(operation),
    changed ? client.host.now() : existing.updated_at,
    company.issuer,
    operation.operation_id
  );
  await afterUpdate(client, company, stored(client, company.issuer, operation.operation_id)!, previous);
  if (operation !== incoming) await alteredNotice(client, company, existing, incoming);
  // Tracking starts when the operation goes in progress; after that the job sets its own pace.
  if (operation.state === "in_progress" && previous.state !== "in_progress") {
    await client.host.schedule(
      "poppy-operation",
      client.host.now() + 5_000,
      { issuer: company.issuer, id: operation.operation_id },
      `op-${company.issuer}-${operation.operation_id}`
    );
  }
  return operation;
}

/**
 * The User approved revision `revision` on the card: confirm exactly that
 * revision (Ops 5.2). The model can't reach this. Legacy standing-permission
 * callers are retained at the type boundary but cannot authorize a request.
 */
export async function approveAndConfirm(
  client: PoppyClient,
  issuer: Issuer,
  operationId: string,
  revision: number,
  approvedBy: "user" | "standing_permission",
  permissionId?: string
): Promise<void> {
  const row = stored(client, issuer, operationId);
  if (!row || isLost(row.confirmed)) return;
  const operation = row.operation;
  // An approval covers one revision; a stale card can't approve newer terms, nor a revision the Company changed in place.
  if (operation.revision !== revision || operation.state !== "proposed" || row.altered_summary !== null || row.cancel_requested) return;
  // Existing generic grants are retained for inspection/removal only. They
  // never create an authorization, including calls made by older adapters.
  if (approvedBy !== "user" || permissionId) return;
  if (row.approved_revision === revision && row.approved_by === "user") {
    // A failed recovery-job write can leave valid approval but no request.
    // Resume that decision without renewing it. SENT may also mean an unknown
    // earlier outcome, so reconcile before retrying; an active attempt owns it.
    if (!client.inFlight.has(CONFIRMING(issuer, operationId))) {
      if (row.confirmed === SENT) await trackOperation(client, issuer, operationId);
      else await confirm(client, issuer, operationId);
    }
    return;
  }
  if (row.confirmed === SENT) return;
  releasePermission(client, row);
  client.sql.exec(
    "UPDATE poppy_operations SET approved_revision = ?, approved_by = ?, permission_id = ?, approval_generation = approval_generation + 1 WHERE issuer = ? AND operation_id = ?",
    revision,
    approvedBy,
    permissionId ?? null,
    issuer,
    operationId
  );
  await confirm(client, issuer, operationId);
}

function setConfirmed(client: PoppyClient, issuer: Issuer, operationId: string, value: number): void {
  client.sql.exec("UPDATE poppy_operations SET confirmed = ? WHERE issuer = ? AND operation_id = ?", value, issuer, operationId);
}

async function scheduleTracking(client: PoppyClient, issuer: Issuer, operationId: string, at: number): Promise<void> {
  await client.host.schedule("poppy-operation", at, { issuer, id: operationId }, `op-${issuer}-${operationId}`);
}

/** Restore follow-up when durable intent survived but its tracking job did not. */
export async function recoverOperations(client: PoppyClient): Promise<void> {
  for (const row of rows(client.sql, operationRow,
    "SELECT * FROM poppy_operations WHERE approved_by = 'standing_permission'")) {
    await retireStandingApproval(client, row);
  }
  for (const row of rows(client.sql, operationRow,
    "SELECT * FROM poppy_operations WHERE confirmed = ? OR cancel_requested = 1 OR json_extract(operation, '$.state') = 'in_progress'", SENT)) {
    if (isLost(row.confirmed) || FINAL.has(row.operation.state)) continue;
    if (!client.host.hasJob(`op-${row.issuer}-${row.operation_id}`)) {
      await scheduleTracking(client, row.issuer, row.operation_id, client.host.now());
    }
  }
}

const CONFIRMING = (issuer: Issuer, operationId: string) => `confirm|${issuer}|${operationId}`;

/** Retire approvals created by the old prose heuristic without losing unknown outcomes. */
async function retireStandingApproval(client: PoppyClient, row: OperationRow): Promise<void> {
  // Recovery snapshots several rows, then yields while refreshing each card.
  // A later row may already carry a newer explicit decision when we reach it.
  const live = stored(client, row.issuer, row.operation_id);
  if (!live) return;
  row = live;
  if (row.approved_by !== "standing_permission" || FINAL.has(row.operation.state) || isLost(row.confirmed)) return;
  const uncertain = row.confirmed === SENT || row.operation.state === "in_progress";
  if (uncertain) {
    client.sql.exec(
      "UPDATE poppy_operations SET cancel_requested = 1, approved_revision = NULL, approved_by = NULL, approval_generation = approval_generation + 1 WHERE issuer = ? AND operation_id = ? AND approved_by = 'standing_permission'",
      row.issuer, row.operation_id
    );
    await scheduleTracking(client, row.issuer, row.operation_id, client.host.now());
  } else {
    releasePermission(client, row);
    clearApproval(client, row.issuer, row.operation_id);
  }
  await showOperation(client, client.companyByIssuer(row.issuer), stored(client, row.issuer, row.operation_id)!);
}

/** Rechecked immediately before every actual fetch, including transport retries. */
function assertConfirmation(client: PoppyClient, row: OperationRow): void {
  const current = stored(client, row.issuer, row.operation_id);
  if (!current || current.cancel_requested || current.approval_generation !== row.approval_generation ||
      current.approved_by !== "user" || current.approved_revision !== row.approved_revision ||
      current.label !== row.label || current.account !== row.account ||
      (client.session(row.issuer, row.label)?.account ?? null) !== row.account ||
      current.operation.revision !== row.approved_revision || current.operation.state !== "proposed" || current.altered_summary !== null) {
    throw new PoppyError("approval_changed", "Confirmation stopped: this revision no longer has the User's approval", 0);
  }
}

/**
 * POST `/confirm` for the approved revision (Ops 5.2). Never for a final
 * operation, and never twice at once. The intent and its follow-up are
 * recorded before sending, so a lost answer is checked on (Ops 6).
 */
export async function confirm(client: PoppyClient, issuer: Issuer, operationId: string): Promise<void> {
  const row = stored(client, issuer, operationId);
  if (!row || row.approved_revision === null || !row.approved_by || isLost(row.confirmed)) return;
  if (row.approved_by === "standing_permission") {
    await retireStandingApproval(client, row);
    return;
  }
  if (row.cancel_requested) return;
  if (FINAL.has(row.operation.state) || row.altered_summary !== null) return;
  const signedInAccount = client.session(issuer, row.label)?.account ?? null;
  if (row.account === null && signedInAccount !== null && row.confirmed !== SENT) {
    // A signed-out proposal can survive signing into the same Session. Bind
    // its next decision to the now-known account, rather than silently
    // rejecting every future retry or carrying old authority across sign-in.
    clearApproval(client, issuer, operationId);
    client.sql.exec("UPDATE poppy_operations SET account = ? WHERE issuer = ? AND operation_id = ?", signedInAccount, issuer, operationId);
    await showOperation(client, client.companyByIssuer(issuer), stored(client, issuer, operationId)!);
    await client.host.notifyModel(
      `[system] Operation ${operationId} was approved before sign-in identified the account. The User must approve its exact revision again on the card; it has not been confirmed.`,
      `poppy-op-account-approval-${issuer}-${operationId}-${row.approved_revision}`
    );
    return;
  }
  const key = CONFIRMING(issuer, operationId);
  if (client.inFlight.has(key)) return;
  // Reserve synchronously: persisting the follow-up yields, so another
  // approval could otherwise enter before the first request is marked busy.
  client.inFlight.add(key);
  let dispatched = false;
  try {
    const company = await client.resumeCompany(issuer, "operation", operationId);
    const endpoint = endpointOf(company);
    setConfirmed(client, issuer, operationId, SENT);
    await scheduleTracking(client, issuer, operationId, client.host.now() + CONFIRM_CHECK_MS);
    try {
      const { body, headers } = await client.resourceJson(
        company,
        EndpointRequest.to(company, {
          method: "POST",
          url: `${endpoint.url}/${encodeURIComponent(operationId)}/confirm`,
          body: { revision: row.approved_revision, approved_by: row.approved_by }
        }),
        {
          label: row.label,
          ...(endpoint.resource ? { resource: endpoint.resource } : {}),
          beforeDispatch: () => {
            assertConfirmation(client, row);
            dispatched = true;
          }
        }
      );
      const answer = operationAnswer(company, body, operationId);
      if (answer.revision !== row.approved_revision) {
        throw new PoppyError("invalid_response", `${company.name} returned no confirmed outcome for the approved revision`, 0);
      }
      if (answer.state === "proposed") {
        // Observe same-revision terms tampering before rejecting the invalid
        // transition. update() preserves the approved terms and warns the User;
        // an unchanged proposal remains SENT and is read back by tracking.
        await update(client, company, answer);
        throw new PoppyError("invalid_response", `${company.name} returned no confirmed outcome for the approved revision`, 0);
      }
      const latest = stored(client, issuer, operationId);
      if (latest?.approval_generation === row.approval_generation) setConfirmed(client, issuer, operationId, ANSWERED);
      const operation = await update(client, company, answer);
      if (operation.state === "in_progress") {
        const retryAfter = Number(headers.get("Retry-After") ?? "5");
        await scheduleTracking(
          client,
          issuer,
          operationId,
          client.host.now() + Math.max(1, Number.isFinite(retryAfter) ? retryAfter : 5) * 1000
        );
      }
    } catch (error) {
      const current = stored(client, issuer, operationId);
      if (hasCode(error, "approval_changed")) {
        // No new attempt was sent. An earlier unknown attempt still needs
        // reconciliation; a withdrawal keeps its durable cancellation job.
        if (!dispatched && row.confirmed !== SENT) setConfirmed(client, issuer, operationId, NOT_SENT);
        if (current?.cancel_requested) await scheduleTracking(client, issuer, operationId, client.host.now());
        return;
      }
      if (current && current.approval_generation !== row.approval_generation) {
        // A late refusal belongs to the old authorization, not a later User
        // decision. Never restore or clear the newer decision from here.
        if (current.cancel_requested) {
          if (error instanceof PoppyError && error.status >= 400 && error.status < 500 && !error.is("rate_limited") && row.confirmed !== SENT) {
            // The first attempt was definitely refused. Settle only this
            // operation's live reservation, never the captured row twice.
            releasePermission(client, current);
            setConfirmed(client, issuer, operationId, NOT_SENT);
          }
          await scheduleTracking(client, issuer, operationId, client.host.now());
        }
        return;
      }
      if (!(error instanceof PoppyError) || error.status >= 500 || error.is("invalid_response")) {
        // No answer we can trust: read, then confirm again only if still needed, with the same id (Ops 6).
        await scheduleTracking(client, issuer, operationId, client.host.now() + 5_000);
        return;
      }
      if (error.is("rate_limited")) {
        // Not acted on: after Retry-After the tracking job reads, then confirms.
        await scheduleTracking(client, issuer, operationId, client.host.now() + (error.detail.retryAfter ?? 30) * 1000);
        return;
      }
      if (error.is("operation_not_found")) {
        await markLost(client, company, row);
        return;
      }
      // The Company answered, so no confirm is outstanding.
      setConfirmed(client, issuer, operationId, NOT_SENT);
      if (error.is("terms_changed")) {
        releasePermission(client, row);
        clearApproval(client, issuer, operationId);
        const current = isObject(error.detail.body) ? error.detail.body.operation : undefined;
        if (current !== undefined) await handleProposal(client, company, row.label, current);
        return;
      }
      if (error.is("user_approval_required")) {
        releasePermission(client, row);
        clearApproval(client, issuer, operationId);
        const current = { ...row.operation, user_approval_required: true };
        client.sql.exec("UPDATE poppy_operations SET operation = ? WHERE issuer = ? AND operation_id = ?", JSON.stringify(current), issuer, operationId);
        await showOperation(client, company, stored(client, issuer, operationId)!);
        return;
      }
      if (error.is("insufficient_scope", "sign_in_required")) {
        // The approval stands; confirm again after sign-in (see retryApproved).
        await client.host.notifyModel(
          `[system] Confirming operation ${operationId} at ${company.name} needs the User signed in (${error.code}${error.detail.scope ? `, scopes "${error.detail.scope}"` : ""}). Call poppy_sign_in; it will be confirmed after sign-in.`,
          `poppy-op-auth-${issuer}-${operationId}-${row.approved_revision}`
        );
        return;
      }
      releasePermission(client, row);
      await client.host.notifyModel(
        `[system] ${company.name} refused to confirm operation ${operationId} (${error.code}).`,
        `poppy-op-error-${issuer}-${operationId}-${error.code}`
      );
    }
  } finally {
    client.inFlight.delete(key);
  }
}

function clearApproval(client: PoppyClient, issuer: Issuer, operationId: string): void {
  client.sql.exec(
    "UPDATE poppy_operations SET approved_revision = NULL, approved_by = NULL, permission_id = NULL, approval_generation = approval_generation + 1 WHERE issuer = ? AND operation_id = ?",
    issuer,
    operationId
  );
}

/** GET the operation and store what the Company says; throws a PoppyError if it can't be read. */
async function readOperation(
  client: PoppyClient,
  company: Company,
  row: OperationRow
): Promise<{ operation: Operation; retryAfter: number }> {
  const endpoint = endpointOf(company);
  const response = await client.resourceJson(
    company,
    EndpointRequest.to(company, { method: "GET", url: `${endpoint.url}/${encodeURIComponent(row.operation_id)}` }),
    { label: row.label, ...(endpoint.resource ? { resource: endpoint.resource } : {}) }
  );
  const retryAfter = Number(response.headers.get("Retry-After") ?? "5");
  return {
    operation: await update(client, company, operationAnswer(company, response.body, row.operation_id)),
    retryAfter: Math.max(1, Number.isFinite(retryAfter) ? retryAfter : 5)
  };
}

/**
 * Approved operations waiting on a sign-in: read each first, since it may
 * have been confirmed elsewhere, revised or ended meanwhile, and confirm it
 * only if it still awaits the approved revision. A final one never is.
 */
export async function retryApproved(client: PoppyClient, issuer: Issuer): Promise<void> {
  for (const row of rows(
    client.sql,
    operationRow,
    "SELECT * FROM poppy_operations WHERE issuer = ? AND approved_revision IS NOT NULL AND confirmed = ?",
    issuer,
    NOT_SENT
  )) {
    if (FINAL.has(row.operation.state)) continue;
    if (row.approved_by === "standing_permission") {
      await retireStandingApproval(client, row);
      continue;
    }
    let operation: Operation;
    try {
      ({ operation } = await readOperation(client, await client.resumeCompany(issuer, "operation", row.operation_id), row));
    } catch (error) {
      if (!(error instanceof PoppyError)) throw error;
      if (error.is("operation_not_found")) await markLost(client, client.companyByIssuer(issuer), row);
      continue;
    }
    const current = stored(client, issuer, row.operation_id);
    if (operation.state === "proposed" && current?.approved_revision === operation.revision && current.confirmed === NOT_SENT) {
      await confirm(client, issuer, row.operation_id);
    }
  }
}

/**
 * The durable tracking job (Ops 6): read the operation; if a confirm's
 * answer was lost and it still awaits the approved revision, confirm that
 * revision again. A final operation is neither read nor confirmed again.
 * Returns when to run next.
 */
export async function trackOperation(client: PoppyClient, issuer: Issuer, operationId: string): Promise<number | null> {
  const row = stored(client, issuer, operationId);
  if (!row || isLost(row.confirmed)) return null;
  const known = row.operation;
  if (FINAL.has(known.state)) return null;
  // A proposal with no confirm outstanding has nothing to follow up.
  if (known.state === "proposed" && row.confirmed !== SENT && !row.cancel_requested) return null;
  const company = await client.resumeCompany(issuer, "operation", operationId);
  let read;
  try {
    read = await readOperation(client, company, row);
  } catch (error) {
    if (hasCode(error, "rate_limited")) {
      return client.host.now() + (error.detail.retryAfter ?? 30) * 1000;
    }
    if (hasCode(error, "operation_not_found")) {
      await markLost(client, company, row);
      return null;
    }
    return client.host.now() + 30_000;
  }
  const { operation } = read;
  const reconciled = stored(client, issuer, operationId)!;
  if (reconciled.cancel_requested && !FINAL.has(operation.state)) {
    try {
      await cancelOperation(client, issuer, operationId);
    } catch {
      return client.host.now() + 30_000;
    }
    return FINAL.has(stored(client, issuer, operationId)!.operation.state) ? null : client.host.now() + 5_000;
  }
  if (operation.state === "proposed") {
    const current = stored(client, issuer, operationId)!;
    if (current.confirmed !== SENT) return null;
    if (current.approved_revision !== operation.revision) {
      // Revised since the approval, which covered only the old revision: the card asks again.
      setConfirmed(client, issuer, operationId, NOT_SENT);
      return null;
    }
    // This object is still waiting on that confirm's answer.
    if (client.inFlight.has(CONFIRMING(issuer, operationId))) return client.host.now() + CONFIRM_CHECK_MS;
    await confirm(client, issuer, operationId);
    return null;
  }
  if (operation.state === "in_progress") {
    // At least the Company's Retry-After, and slower the longer nothing changes: a
    // Company can't keep the agent polling every second (interop scenario XT).
    const quietFor = client.host.now() - stored(client, issuer, operationId)!.updated_at;
    return client.host.now() + Math.max(read.retryAfter * 1000, backoff(quietFor, 0));
  }
  return null;
}

/** Decline a proposal, or ask the Company to stop one in progress (Ops 7). */
export async function cancelOperation(client: PoppyClient, issuer: Issuer, operationId: string): Promise<void> {
  const row = stored(client, issuer, operationId);
  if (!row || isLost(row.confirmed) || FINAL.has(row.operation.state)) return;
  // Withdrawal is durable before the first await. A failed cancellation,
  // restart or a late response must never restore authority to confirm.
  client.sql.exec(
    "UPDATE poppy_operations SET cancel_requested = 1, approved_revision = NULL, approved_by = NULL, approval_generation = approval_generation + 1 WHERE issuer = ? AND operation_id = ? AND cancel_requested = 0",
    issuer, operationId
  );
  if (row.confirmed !== SENT && row.operation.state !== "in_progress") releasePermission(client, row);
  await scheduleTracking(client, issuer, operationId, client.host.now() + 5_000);
  const company = await client.resumeCompany(issuer, "operation", operationId);
  const endpoint = endpointOf(company);
  await showOperation(client, company, stored(client, issuer, operationId)!);
  const key = `cancel|${issuer}|${operationId}`;
  if (client.inFlight.has(key)) return;
  client.inFlight.add(key);
  let body: Json;
  try {
    ({ body } = await client.resourceJson(
      company,
      EndpointRequest.to(company, { method: "POST", url: `${endpoint.url}/${encodeURIComponent(operationId)}/cancel` }),
      { label: row.label, ...(endpoint.resource ? { resource: endpoint.resource } : {}) }
    ));
  } catch (error) {
    if (hasCode(error, "operation_not_found")) {
      await markLost(client, company, row);
      return;
    }
    await client.host.showCard({
      id: `op-cancel-${issuer}-${operationId}`, kind: "notice", company: company.name, domain: company.domain, open: false,
      text: `${company.name} hasn't accepted the cancellation yet. Your agent won't confirm it again and will keep checking and retrying the cancellation; an earlier request may already have reached the Company.`
    });
    throw error;
  } finally {
    client.inFlight.delete(key);
  }
  await update(client, company, operationAnswer(company, body, operationId));
}

export function operation(client: PoppyClient, issuer: Issuer, operationId: string): Operation | undefined {
  const row = stored(client, issuer, operationId);
  return row ? row.operation : undefined;
}

// ---------------------------------------------------------------- Standing permissions

const permissionRow = permissionsTable.row;
type PermissionRow = RowOf<typeof permissionRow>;

export function addPermission(
  client: PoppyClient,
  permission: { issuer: Issuer; account: string; action: string; maxAmount?: string; currency?: string; maxUses?: number; expiresAt?: number }
): string {
  const id = randomId("perm_");
  client.sql.exec(
    `INSERT INTO poppy_permissions (id, issuer, account, action, max_amount, currency, max_uses, uses, reserved, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    id,
    permission.issuer,
    permission.account,
    permission.action.trim().toLowerCase(),
    permission.maxAmount ?? null,
    permission.currency ?? null,
    permission.maxUses ?? null,
    permission.expiresAt ?? null,
    Date.now()
  );
  return id;
}

export async function removePermission(client: PoppyClient, id: string): Promise<void> {
  const pending = rows(client.sql, operationRow, "SELECT * FROM poppy_operations WHERE permission_id = ?", id);
  // Tombstone the associated approvals synchronously before any notification.
  for (const row of pending) {
    if (FINAL.has(row.operation.state) || isLost(row.confirmed)) continue;
    const uncertain = row.confirmed === SENT || row.operation.state === "in_progress";
    client.sql.exec(
      "UPDATE poppy_operations SET approved_revision = NULL, approved_by = NULL, approval_generation = approval_generation + 1, cancel_requested = ? WHERE issuer = ? AND operation_id = ?",
      uncertain ? 1 : row.cancel_requested, row.issuer, row.operation_id
    );
    if (!uncertain) releasePermission(client, row);
  }
  client.sql.exec("DELETE FROM poppy_permissions WHERE id = ?", id);
  for (const row of pending) {
    const current = stored(client, row.issuer, row.operation_id)!;
    if (current.cancel_requested && !FINAL.has(current.operation.state)) await scheduleTracking(client, row.issuer, row.operation_id, client.host.now());
    await showOperation(client, client.companyByIssuer(row.issuer), current);
  }
}

export function permissions(client: PoppyClient): PermissionRow[] {
  return rows(client.sql, permissionRow, "SELECT * FROM poppy_permissions ORDER BY created_at");
}

/**
 * The `terms` keys a standing permission lets through as they are, besides
 * money and dates: the ones that say which record the action is on, from the
 * draft's own example (Ops 3: `order_id`, `item_id`, `replacement_sku`, beside
 * `price_difference`). The Company names its keys (Ops 3), so anything else,
 * whatever it is called, is a term we can't check, and the User decides.
 */
const DESCRIPTIVE_TERMS = new Set(["order_id", "item_id", "replacement_sku"]);

/** Words that, right after the action, say the summary isn't that action: "Exchange nothing: …". */
const NEGATIONS = new Set(["not", "no", "nothing", "none", "never", "neither", "nor", "without"]);

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

/**
 * The summary begins with the permission's action, word for word ("exchange"
 * covers "Exchange the Stormline Jacket…"), and the word after it isn't a
 * negation. Anywhere else in the summary isn't enough: "Not an exchange:
 * delete all saved addresses" contains the word too.
 */
export function summaryStartsWithAction(summary: string, action: string): boolean {
  const want = words(action);
  const have = words(summary);
  if (want.length === 0 || !want.every((word, index) => have[index] === word)) return false;
  const next = have[want.length];
  return next === undefined || !NEGATIONS.has(next);
}

/** The most digits a money amount may have before and after its point: beyond these we can't check it, and the User decides. */
const MONEY_INTEGER_DIGITS = 15;
const MONEY_FRACTION_DIGITS = 6;
const MONEY_SCALE = 10n ** BigInt(MONEY_FRACTION_DIGITS);

/**
 * A decimal amount as an exact count of millionths, or null: a plain decimal
 * (a string like "12.50", or a JSON number whose shortest form is one), at
 * most 15 digits before the point and 6 after. No exponents, no rounding, so
 * a limit check can't be fooled by a value a float can't hold.
 */
export function exactAmount(value: unknown): bigint | null {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : typeof value === "string" ? value : "";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const digits = whole!.replace(/^0+(?=\d)/, "");
  if (digits.length > MONEY_INTEGER_DIGITS || fraction.length > MONEY_FRACTION_DIGITS) return null;
  const units = BigInt(digits) * MONEY_SCALE + BigInt(fraction.padEnd(MONEY_FRACTION_DIGITS, "0"));
  return sign ? -units : units;
}

/** A money term: an object of exactly `amount` (a bounded decimal, `exactAmount`) and `currency` (three capital letters). */
function moneyOf(value: Json): { units: bigint; currency: string } | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("amount" in value) || !("currency" in value)) return null;
  const { amount, currency } = value;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  const units = exactAmount(amount);
  return units === null ? null : { units, currency };
}

/** A date or time term: a key that names one, never a renewal or repeat, with an ISO 8601 value. */
function isDateTerm(key: string, value: Json): boolean {
  if (!/(date|_at$|_on$|time|deadline|until)/i.test(key) || /(renew|recur|repeat|trial|charge|bill|interval|period)/i.test(key)) return false;
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * Whether a permission covers every term (Ops 5.1). `terms` must be a
 * non-empty object, every member of which is one of: a money term; a date;
 * or a descriptive key above, as a string. With a maximum, every money term
 * is in the permission's currency and their amounts together, credits
 * counted as charges, come to no more than it: the maximum is what the
 * operation may cost in all, not what each line may (our reading of S20).
 * A permission without a maximum is for any amount, as the page offers it.
 * Anything else (a flag, a number without a currency, a recurrence, a nested
 * or unknown term) we can't check, and a permission with a maximum needs at
 * least one money term to check it against. Otherwise the User decides
 * (Guides, Operations).
 */
export function termsCovered(terms: Json | undefined, limit: { maxAmount: string | null; currency: string | null }): boolean {
  if (terms === undefined || !isObject(terms) || Object.keys(terms).length === 0) return false;
  let money = 0;
  let total = 0n;
  for (const [key, value] of Object.entries(terms)) {
    const found = moneyOf(value);
    if (found) {
      if (limit.maxAmount !== null && found.currency !== limit.currency) return false;
      total += found.units < 0n ? -found.units : found.units;
      money += 1;
    } else if (!(DESCRIPTIVE_TERMS.has(key) && typeof value === "string") && !isDateTerm(key, value)) {
      return false;
    }
  }
  if (limit.maxAmount === null) return true;
  // Exact: millionths on both sides, so neither rounding nor an oversized value can pass a limit.
  const max = exactAmount(limit.maxAmount);
  return max !== null && max >= 0n && money > 0 && total <= max;
}

/** Release this operation's live reservation exactly once. */
function releasePermission(client: PoppyClient, row: OperationRow): void {
  settlePermission(client, row, false);
}

/** A final state settles a reserved use: counted if the action happened, released if not. */
function settlePermission(client: PoppyClient, row: OperationRow, used: boolean): void {
  // Claim the live reservation once. A concurrent cancellation may already
  // have released the snapshot a late confirm response still carries.
  const live = stored(client, row.issuer, row.operation_id)?.permission_id;
  if (!live) return;
  const claimed = client.sql.exec(
    "UPDATE poppy_operations SET permission_id = NULL WHERE issuer = ? AND operation_id = ? AND permission_id = ? RETURNING ? AS permission_id",
    row.issuer, row.operation_id, live, live
  ).toArray()[0];
  if (typeof claimed?.permission_id !== "string") return;
  client.sql.exec(
    used
      ? "UPDATE poppy_permissions SET reserved = MAX(0, reserved - 1), uses = uses + 1 WHERE id = ?"
      : "UPDATE poppy_permissions SET reserved = MAX(0, reserved - 1) WHERE id = ?",
    claimed.permission_id
  );
}

// ---------------------------------------------------------------- Local approvals

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
  fixedId?: string
): Promise<string> {
  const id = fixedId ?? randomId("apr_");
  const stored = storedApproval(approval);
  const attachments = approvalAttachments(stored);
  const existing = one(client.sql, approvalRow, "SELECT * FROM poppy_approvals WHERE id = ?", id);
  if (existing && (existing.issuer !== company.issuer || existing.label !== label || existing.request !== stored || existing.summary !== summary)) {
    throw new PoppyError("approval_changed", "This tool call already proposed a different request. Use a new call for fresh approval.", 0);
  }
  if (existing && existing.status !== "pending") return id;
  if (!existing) {
    client.rememberCompany("approval", id, company);
    client.sql.exec(
      "INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      id,
      company.issuer,
      label,
      summary,
      stored,
      Date.now()
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
    ...attachments,
    ...batchKeyOf(company.issuer, stored)
  });
  return id;
}

function batchKeyOf(issuer: string, request: string): { batchKey?: string } {
  const key = approvalBatchKey(issuer, request);
  return key ? { batchKey: key } : {};
}

const approvalRow = approvalsTable.pick("id", "issuer", "label", "summary", "request", "status");

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
  const card = (status: "approved" | "declined" | "done" | "refused" | "failed" | "unknown", result?: string, answer?: { status: number; error?: string }) =>
    client.host.showCard({
      id: `approval-${id}`,
      kind: "approval",
      company: company.name,
      domain: company.domain,
      open: false,
      approvalId: id,
      summary: row.summary,
      status,
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
    // No answer marked: the agent refused it before sending, couldn't get a Session Token, or couldn't read the answer.
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
