import { approvalAttachments, readApproval, storedApproval, type ApprovalKind, type ApprovalOf, type NewApproval } from "./approvals";
import { answerOf, hasCode, PoppyClient, PoppyError } from "./client";
import { tokenHostAllowed, type Company } from "./discovery";
import { isObject, type Json } from "./json";
import { randomId } from "./jwt";
import { FINAL_STATES, parseOperation, type Operation } from "./operation-value";
import { EndpointRequest } from "./outgoing";
import { one, rows, type RowOf } from "../rows";
import { approvalsTable, operationsTable, permissionsTable, proposalsTable } from "./store";
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

async function showOperation(client: PoppyClient, company: Company, row: OperationRow): Promise<void> {
  const operation = row.operation;
  const lost = lostOutcome(row.confirmed) ?? undefined;
  const open = !lost && operation.state === "proposed" && row.approved_revision !== operation.revision;
  const links = FINAL.has(operation.state) ? resultLinks(company, operation.result?.data) : [];
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
    ...(row.approved_by ? { approvedBy: row.approved_by } : {})
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
  if (!row || row.approved_revision === null || isLost(row.confirmed)) return;
  const operation = row.operation;
  if (FINAL.has(operation.state)) return;
  throw new PoppyError(
    "operation_open",
    `This request already proposed operation ${operation.operation_id}, which has been confirmed and is ${operation.state}. Read it with poppy_operation; don't ask again until it is final.`,
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

/**
 * Record an operation from any channel (Ops 4): an OpenAPI 202, an MCP tool
 * result, or a Company message. A new revision of a proposal needs a new
 * approval, unless a standing permission covers it (Ops 5.1).
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
  const { operation } = parsed;
  const existing = stored(client, company.issuer, operation.operation_id);
  const previous = existing ? existing.operation : undefined;
  if (previous && previous.revision > operation.revision) return previous;
  if (previous && FINAL.has(previous.state)) return previous;
  const account = client.session(company.issuer, label)?.account ?? null;
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
    Date.now()
  );
  const row = stored(client, company.issuer, operation.operation_id)!;
  const isNewRevision = !previous || previous.revision !== operation.revision;

  if (operation.state === "proposed" && isNewRevision) {
    const permission = operation.user_approval_required ? undefined : matchPermission(client, company, row, operation);
    if (permission) {
      await approveAndConfirm(client, company.issuer, operation.operation_id, operation.revision, "standing_permission", permission);
      return operation;
    }
    await announceProposal(client, company, row, operation);
  } else if (operation.state === "proposed" && row.approved_revision !== operation.revision) {
    // The same proposal again (a repeated event or call): its card and notice
    // again, both idempotent, in case the first time didn't get that far.
    await announceProposal(client, company, row, operation);
  } else {
    await afterUpdate(client, company, row, previous);
  }
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

/** Store the operation the Company returned, and react to its state. */
async function update(client: PoppyClient, company: Company, value: Json): Promise<Operation | null> {
  const parsed = parseOperation(value);
  if ("problem" in parsed) return null;
  const { operation } = parsed;
  const existing = stored(client, company.issuer, operation.operation_id);
  if (!existing) return null;
  const previous = existing.operation;
  client.sql.exec(
    "UPDATE poppy_operations SET operation = ?, updated_at = ? WHERE issuer = ? AND operation_id = ?",
    JSON.stringify(operation),
    Date.now(),
    company.issuer,
    operation.operation_id
  );
  await afterUpdate(client, company, stored(client, company.issuer, operation.operation_id)!, previous);
  if (operation.state === "in_progress") {
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
 * The User approved revision `revision` on the card (or a standing
 * permission covers it): confirm exactly that revision (Ops 5.2). The model
 * can't reach this; only the card's buttons and standing permissions can.
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
  // An approval covers one revision; a stale card can't approve newer terms.
  if (operation.revision !== revision || operation.state !== "proposed") return;
  if (approvedBy === "standing_permission" && operation.user_approval_required) return;
  if (permissionId && !reserve(client, permissionId)) return;
  client.sql.exec(
    "UPDATE poppy_operations SET approved_revision = ?, approved_by = ?, permission_id = ? WHERE issuer = ? AND operation_id = ?",
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

const CONFIRMING = (issuer: Issuer, operationId: string) => `confirm|${issuer}|${operationId}`;

/**
 * POST `/confirm` for the approved revision (Ops 5.2). Never for a final
 * operation, and never twice at once. The intent and its follow-up are
 * recorded before sending, so a lost answer is checked on (Ops 6).
 */
export async function confirm(client: PoppyClient, issuer: Issuer, operationId: string): Promise<void> {
  const row = stored(client, issuer, operationId);
  if (!row || row.approved_revision === null || !row.approved_by || isLost(row.confirmed)) return;
  if (FINAL.has(row.operation.state)) return;
  const key = CONFIRMING(issuer, operationId);
  if (client.inFlight.has(key)) return;
  const company = client.companyByIssuer(issuer);
  const endpoint = endpointOf(company);
  setConfirmed(client, issuer, operationId, SENT);
  await scheduleTracking(client, issuer, operationId, client.host.now() + CONFIRM_CHECK_MS);
  client.inFlight.add(key);
  try {
    const { body, headers } = await client.resourceJson(
      company,
      EndpointRequest.to(company, {
        method: "POST",
        url: `${endpoint.url}/${encodeURIComponent(operationId)}/confirm`,
        body: { revision: row.approved_revision, approved_by: row.approved_by }
      }),
      { label: row.label, ...(endpoint.resource ? { resource: endpoint.resource } : {}) }
    );
    setConfirmed(client, issuer, operationId, ANSWERED);
    const operation = await update(client, company, body);
    if (operation?.state === "in_progress") {
      const retryAfter = Number(headers.get("Retry-After") ?? "5");
      await scheduleTracking(
        client,
        issuer,
        operationId,
        client.host.now() + Math.max(1, Number.isFinite(retryAfter) ? retryAfter : 5) * 1000
      );
    }
  } catch (error) {
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
  } finally {
    client.inFlight.delete(key);
  }
}

function clearApproval(client: PoppyClient, issuer: Issuer, operationId: string): void {
  client.sql.exec(
    "UPDATE poppy_operations SET approved_revision = NULL, approved_by = NULL, permission_id = NULL WHERE issuer = ? AND operation_id = ?",
    issuer,
    operationId
  );
}

/** GET the operation and store what the Company says; throws a PoppyError if it can't be read. */
async function readOperation(
  client: PoppyClient,
  company: Company,
  row: OperationRow
): Promise<{ operation: Operation | null; retryAfter: number }> {
  const endpoint = endpointOf(company);
  const response = await client.resourceJson(
    company,
    EndpointRequest.to(company, { method: "GET", url: `${endpoint.url}/${encodeURIComponent(row.operation_id)}` }),
    { label: row.label, ...(endpoint.resource ? { resource: endpoint.resource } : {}) }
  );
  const retryAfter = Number(response.headers.get("Retry-After") ?? "5");
  return {
    operation: await update(client, company, response.body),
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
    let operation: Operation | null;
    try {
      ({ operation } = await readOperation(client, client.companyByIssuer(issuer), row));
    } catch (error) {
      if (!(error instanceof PoppyError)) throw error;
      if (error.is("operation_not_found")) await markLost(client, client.companyByIssuer(issuer), row);
      continue;
    }
    const current = stored(client, issuer, row.operation_id);
    if (operation?.state === "proposed" && current?.approved_revision === operation.revision && current.confirmed === NOT_SENT) {
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
  if (known.state === "proposed" && row.confirmed !== SENT) return null;
  const company = client.companyByIssuer(issuer);
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
  if (!operation) return null;
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
  if (operation.state === "in_progress") return client.host.now() + read.retryAfter * 1000;
  return null;
}

/** Decline a proposal, or ask the Company to stop one in progress (Ops 7). */
export async function cancelOperation(client: PoppyClient, issuer: Issuer, operationId: string): Promise<void> {
  const row = stored(client, issuer, operationId);
  if (!row || isLost(row.confirmed)) return;
  const company = client.companyByIssuer(issuer);
  const endpoint = endpointOf(company);
  releasePermission(client, row);
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
    throw error;
  }
  await update(client, company, body);
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

export function removePermission(client: PoppyClient, id: string): void {
  client.sql.exec("DELETE FROM poppy_permissions WHERE id = ?", id);
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

/** A money term: an object of exactly `amount` (a decimal number) and `currency` (three capital letters). */
function moneyOf(value: Json): { amount: number; currency: string } | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("amount" in value) || !("currency" in value)) return null;
  const { amount, currency } = value;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  if (typeof amount === "number" ? !Number.isFinite(amount) : typeof amount !== "string" || !/^-?\d+(\.\d+)?$/.test(amount)) return null;
  return { amount: Number(amount), currency };
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
 * non-empty object, every member of which is one of: a money term, in the
 * permission's currency and within its maximum when it has one (a
 * permission without one is for any amount, as the page offers it); a date;
 * or a descriptive key above, as a string. Anything else (a flag, a number
 * without a currency, a recurrence, a nested or unknown term) we can't
 * check, and a permission with a maximum needs at least one money term to
 * check it against. Otherwise the User decides (Guides, Operations).
 */
export function termsCovered(terms: Json | undefined, limit: { maxAmount: string | null; currency: string | null }): boolean {
  if (terms === undefined || !isObject(terms) || Object.keys(terms).length === 0) return false;
  let money = 0;
  for (const [key, value] of Object.entries(terms)) {
    const found = moneyOf(value);
    if (found) {
      if (limit.maxAmount !== null && (found.currency !== limit.currency || !(found.amount <= Number(limit.maxAmount)))) return false;
      money += 1;
    } else if (!(DESCRIPTIVE_TERMS.has(key) && typeof value === "string") && !isDateTerm(key, value)) {
      return false;
    }
  }
  return limit.maxAmount === null || money > 0;
}

/**
 * A standing permission covers an operation only if it is for this Company
 * and account, hasn't expired or run out of uses, the summary begins with
 * its action, and it covers every term (`termsCovered`).
 */
function matchPermission(client: PoppyClient, company: Company, row: OperationRow, operation: Operation): string | undefined {
  if (!row.account) return undefined;
  for (const permission of rows(
    client.sql,
    permissionRow,
    "SELECT * FROM poppy_permissions WHERE issuer = ? AND account = ?",
    company.issuer,
    row.account
  )) {
    if (permission.expires_at !== null && permission.expires_at <= Date.now()) continue;
    if (permission.max_uses !== null && permission.uses + permission.reserved >= permission.max_uses) continue;
    if (!summaryStartsWithAction(operation.summary, permission.action)) continue;
    if (!termsCovered(operation.terms, { maxAmount: permission.max_amount, currency: permission.currency })) continue;
    return permission.id;
  }
  return undefined;
}

/** Reserve one use before confirming, so two tasks can't both take the last one. */
function reserve(client: PoppyClient, id: string): boolean {
  const before = one(client.sql, permissionsTable.pick("reserved"), "SELECT reserved FROM poppy_permissions WHERE id = ?", id);
  client.sql.exec(
    "UPDATE poppy_permissions SET reserved = reserved + 1 WHERE id = ? AND (max_uses IS NULL OR uses + reserved < max_uses)",
    id
  );
  const after = one(client.sql, permissionsTable.pick("reserved"), "SELECT reserved FROM poppy_permissions WHERE id = ?", id);
  return !!before && !!after && after.reserved === before.reserved + 1;
}

function releasePermission(client: PoppyClient, row: OperationRow): void {
  if (!row.permission_id) return;
  client.sql.exec("UPDATE poppy_permissions SET reserved = MAX(0, reserved - 1) WHERE id = ?", row.permission_id);
  client.sql.exec("UPDATE poppy_operations SET permission_id = NULL WHERE issuer = ? AND operation_id = ?", row.issuer, row.operation_id);
}

/** A final state settles a reserved use: counted if the action happened, released if not. */
function settlePermission(client: PoppyClient, row: OperationRow, used: boolean): void {
  if (!row.permission_id) return;
  client.sql.exec(
    used
      ? "UPDATE poppy_permissions SET reserved = MAX(0, reserved - 1), uses = uses + 1 WHERE id = ?"
      : "UPDATE poppy_permissions SET reserved = MAX(0, reserved - 1) WHERE id = ?",
    row.permission_id
  );
  client.sql.exec("UPDATE poppy_operations SET permission_id = NULL WHERE issuer = ? AND operation_id = ?", row.issuer, row.operation_id);
}

// ---------------------------------------------------------------- Local approvals

/** How an approved local action of one kind is carried out (registered by the APIs and browser). */
export type ApprovalExecutor<K extends ApprovalKind> = (client: PoppyClient, company: Company, approval: ApprovalOf<K>, label: string) => Promise<string>;
const executors: { [K in ApprovalKind]?: ApprovalExecutor<K> } = {};

export function registerExecutor<K extends ApprovalKind>(kind: K, executor: ApprovalExecutor<K>): void {
  (executors as Record<K, ApprovalExecutor<K>>)[kind] = executor;
}

function run<K extends ApprovalKind>(client: PoppyClient, company: Company, approval: ApprovalOf<K>, label: string): Promise<string> {
  const executor = executors[approval.kind] as ApprovalExecutor<K> | undefined;
  if (!executor) throw new Error(`No executor for ${approval.kind}`);
  return executor(client, company, approval, label);
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
  if (existing && existing.status !== "pending") return id;
  if (!existing) {
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
    ...attachments
  });
  return id;
}

const approvalRow = approvalsTable.pick("id", "issuer", "label", "summary", "request", "status");

export async function decideLocal(client: PoppyClient, id: string, decision: "approve" | "decline"): Promise<void> {
  const row = one(client.sql, approvalRow, "SELECT * FROM poppy_approvals WHERE id = ?", id);
  if (!row || row.status !== "pending") return;
  const company = client.companyByIssuer(row.issuer);
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
      ...approvalAttachments(row.request)
    });
  if (decision === "decline") {
    client.sql.exec("UPDATE poppy_approvals SET status = 'declined' WHERE id = ?", id);
    await card("declined");
    await client.host.notifyModel(`[system] The User declined: ${row.summary}`, `poppy-approval-${id}`);
    return;
  }
  // A request stored in another form, or tampered with, is never sent.
  const read = readApproval(row.request);
  if (!read.ok) {
    const result = `Not sent: this approval can't be sent, because ${read.problem}. Nothing was sent; ask again if you still want it.`;
    client.sql.exec("UPDATE poppy_approvals SET status = 'failed', result = ? WHERE id = ?", result, id);
    await card("failed", result);
    await client.host.notifyModel(`[system] The User approved, but the stored request couldn't be sent (${read.problem}), so nothing was sent: ${row.summary}. Ask again if the User still wants it.`, `poppy-approval-${id}`);
    return;
  }
  // Marked before the call: if the object dies mid-call it is never retried (Safety).
  client.sql.exec("UPDATE poppy_approvals SET status = 'executing' WHERE id = ?", id);
  try {
    const result = await run(client, company, read.value, row.label);
    client.sql.exec("UPDATE poppy_approvals SET status = 'done', result = ? WHERE id = ?", result, id);
    await card("done", result);
    await client.host.notifyModel(`[system] Done, as the User approved: ${row.summary}. Result: ${result}`, `poppy-approval-${id}`);
  } catch (error) {
    // A Company's refusal keeps its code, as tool failures show it.
    const message = error instanceof PoppyError ? `${error.message} [${error.code}]` : error instanceof Error ? error.message : String(error);
    const answer = answerOf(error);
    const name = company.name;
    if (answer === "none") {
      // Sent, and no answer came: it may have happened (Safety). Never retried.
      const result = `Sent as you approved, but no answer came from ${name}, so it may or may not have reached them. Check with ${name} before asking again.`;
      client.sql.exec("UPDATE poppy_approvals SET status = 'unknown', result = ? WHERE id = ?", result, id);
      await card("unknown", result);
      await client.host.notifyModel(
        `[system] Sent as the User approved, but no answer came from ${name} (${message}), so it may or may not have happened: ${row.summary}. Tell the User to check with ${name}; it won't be retried automatically.`,
        `poppy-approval-${id}`
      );
      return;
    }
    if (typeof answer === "number") {
      // The Company answered, and not with success: sent as approved, not done as far as it says.
      const code = error instanceof PoppyError && error.code !== `http_${answer}` ? error.code : undefined;
      const answered = `${answer}${code ? ` (${code})` : ""}`;
      const result = `Sent as you approved, but ${name} answered ${answered}. Nothing changed unless ${name} says otherwise.`;
      client.sql.exec("UPDATE poppy_approvals SET status = 'refused', result = ? WHERE id = ?", result, id);
      await card("refused", result, { status: answer, ...(code ? { error: code } : {}) });
      await client.host.notifyModel(
        `[system] Sent as the User approved, but ${name} answered ${answered}, so it wasn't done as far as ${name} says: ${row.summary}. Don't tell the User it was done. ${message}`,
        `poppy-approval-${id}`
      );
      return;
    }
    // No answer marked: the agent refused it before sending, couldn't get a Session Token, or couldn't read the answer.
    client.sql.exec("UPDATE poppy_approvals SET status = 'failed', result = ? WHERE id = ?", message, id);
    await card("failed", message);
    await client.host.notifyModel(`[system] The approved action failed: ${row.summary}. ${message}`, `poppy-approval-${id}`);
  }
}

/** After a restart: approvals left mid-call have an unknown outcome; say so, never retry. */
export async function recoverInterruptedApprovals(client: PoppyClient): Promise<void> {
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
    await client.host.notifyModel(
      `[system] An approved action was interrupted and its outcome is unknown: ${row.summary}. Tell the User to check with ${company}; it won't be retried automatically.`,
      `poppy-approval-${row.id}`
    );
  }
}
