import { PoppyClient, PoppyError } from "./client";
import type { Company } from "./discovery";
import { isObject, type Json } from "./json";
import { randomId } from "./jwt";
import { one, rows } from "./store";

/** An operation as the Company sends it (Ops 3). */
export type Operation = {
  readonly operation_id: string;
  readonly revision: number;
  readonly state: "proposed" | "in_progress" | "succeeded" | "failed" | "cancelled" | "expired";
  readonly summary: string;
  readonly terms?: Json;
  readonly expires_at?: string;
  readonly user_approval_required?: boolean;
  readonly url?: string;
  readonly confirmation?: Json;
  readonly result?: { readonly summary: string; readonly data?: Json } | null;
};

type OperationRow = {
  issuer: string;
  operation_id: string;
  label: string;
  account: string | null;
  operation: string;
  previous_summary: string | null;
  approved_revision: number | null;
  approved_by: string | null;
  permission_id: string | null;
  confirmed: number;
};

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
/** When the tracking job checks on a confirm whose answer never came. */
const CONFIRM_CHECK_MS = 60_000;

const FINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const STATES = new Set(["proposed", "in_progress", ...FINAL]);
const ID = /^[A-Za-z0-9_-]{1,256}$/;

function parseOperation(value: Json): Operation | null {
  if (!isObject(value)) return null;
  const { operation_id, revision, state, summary } = value;
  if (
    typeof operation_id !== "string" ||
    !ID.test(operation_id) ||
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    typeof state !== "string" ||
    !STATES.has(state) ||
    typeof summary !== "string"
  ) {
    return null;
  }
  return value as unknown as Operation;
}

function stored(client: PoppyClient, issuer: string, id: string): OperationRow | undefined {
  return one<OperationRow>(
    client.sql,
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

/** Money terms: every `{ amount, currency }` object in `terms`. */
function moneyTerms(terms: Json | undefined): { amount: number; currency: string }[] {
  const found: { amount: number; currency: string }[] = [];
  const walk = (value: Json) => {
    if (Array.isArray(value)) value.forEach(walk);
    if (!isObject(value)) return;
    if ((typeof value.amount === "string" || typeof value.amount === "number") && typeof value.currency === "string") {
      found.push({ amount: Number(value.amount), currency: value.currency });
      return;
    }
    Object.values(value).forEach(walk);
  };
  if (terms !== undefined) walk(terms);
  return found;
}

async function showOperation(client: PoppyClient, company: Company, row: OperationRow): Promise<void> {
  const operation = JSON.parse(row.operation) as Operation;
  const open = operation.state === "proposed" && row.approved_revision !== operation.revision;
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
    ...(row.approved_by ? { approvedBy: row.approved_by } : {})
  });
}

/**
 * Record an operation from any channel (Ops 4): an OpenAPI 202, an MCP tool
 * result, or a Company message. A new revision of a proposal needs a new
 * approval, unless a standing permission covers it (Ops 5.1).
 */
/**
 * Before an API write that once proposed an operation: if we've tried to
 * confirm that operation and it isn't final, we read or confirm it again
 * instead, and MUST NOT ask for a new proposal of the same action (Ops 6).
 * `request` identifies the write: method, URL and body, or MCP tool and args.
 */
export function refuseWhileConfirming(client: PoppyClient, issuer: string, request: string): void {
  const found = one<{ operation_id: string }>(
    client.sql,
    "SELECT operation_id FROM poppy_proposals WHERE issuer = ? AND request = ?",
    issuer,
    request
  );
  const row = found ? stored(client, issuer, found.operation_id) : undefined;
  if (!row || row.approved_revision === null) return;
  const operation = JSON.parse(row.operation) as Operation;
  if (FINAL.has(operation.state)) return;
  throw new PoppyError(
    "operation_open",
    `This request already proposed operation ${operation.operation_id}, which has been confirmed and is ${operation.state}. Read it with poppy_operation; don't ask again until it is final.`,
    0
  );
}

/** Remember which API write proposed an operation, for `refuseWhileConfirming`. */
export function rememberProposal(client: PoppyClient, issuer: string, request: string, operationId: string): void {
  client.sql.exec(
    `INSERT INTO poppy_proposals (issuer, request, operation_id) VALUES (?, ?, ?)
     ON CONFLICT (issuer, request) DO UPDATE SET operation_id = excluded.operation_id`,
    issuer,
    request,
    operationId
  );
}

export async function handleProposal(
  client: PoppyClient,
  company: Company,
  label: string,
  value: Json
): Promise<Operation | null> {
  const operation = parseOperation(value);
  if (!operation || !company.extensions.operations) return null;
  const existing = stored(client, company.issuer, operation.operation_id);
  const previous = existing ? (JSON.parse(existing.operation) as Operation) : undefined;
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
  const operation = JSON.parse(row.operation) as Operation;
  await showOperation(client, company, row);
  if (FINAL.has(operation.state) && previous?.state !== operation.state) {
    settlePermission(client, row, operation.state === "succeeded" || operation.state === "in_progress");
    const result = operation.result?.summary ?? "No details.";
    await client.host.notifyModel(
      `[system] Operation ${operation.operation_id} at ${company.name} is ${operation.state}. The company's account of what happened: "${result}"`,
      `poppy-op-final-${row.issuer}-${operation.operation_id}`
    );
  }
}

/** Store the operation the Company returned, and react to its state. */
async function update(client: PoppyClient, company: Company, value: Json): Promise<Operation | null> {
  const operation = parseOperation(value);
  if (!operation) return null;
  const existing = stored(client, company.issuer, operation.operation_id);
  if (!existing) return null;
  const previous = JSON.parse(existing.operation) as Operation;
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
  issuer: string,
  operationId: string,
  revision: number,
  approvedBy: "user" | "standing_permission",
  permissionId?: string
): Promise<void> {
  const row = stored(client, issuer, operationId);
  if (!row) return;
  const operation = JSON.parse(row.operation) as Operation;
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

function setConfirmed(client: PoppyClient, issuer: string, operationId: string, value: number): void {
  client.sql.exec("UPDATE poppy_operations SET confirmed = ? WHERE issuer = ? AND operation_id = ?", value, issuer, operationId);
}

async function scheduleTracking(client: PoppyClient, issuer: string, operationId: string, at: number): Promise<void> {
  await client.host.schedule("poppy-operation", at, { issuer, id: operationId }, `op-${issuer}-${operationId}`);
}

const CONFIRMING = (issuer: string, operationId: string) => `confirm|${issuer}|${operationId}`;

/**
 * POST `/confirm` for the approved revision (Ops 5.2). Never for a final
 * operation, and never twice at once. The intent and its follow-up are
 * recorded before sending, so a lost answer is checked on (Ops 6).
 */
export async function confirm(client: PoppyClient, issuer: string, operationId: string): Promise<void> {
  const row = stored(client, issuer, operationId);
  if (!row || row.approved_revision === null || !row.approved_by) return;
  if (FINAL.has((JSON.parse(row.operation) as Operation).state)) return;
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
      {
        method: "POST",
        url: `${endpoint.url}/${encodeURIComponent(operationId)}/confirm`,
        body: { revision: row.approved_revision, approved_by: row.approved_by }
      },
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
    if (!(error instanceof PoppyError) || error.status >= 500 || error.code === "invalid_response") {
      // No answer we can trust: read, then confirm again only if still needed, with the same id (Ops 6).
      await scheduleTracking(client, issuer, operationId, client.host.now() + 5_000);
      return;
    }
    if (error.code === "rate_limited") {
      // Not acted on: after Retry-After the tracking job reads, then confirms.
      await scheduleTracking(client, issuer, operationId, client.host.now() + (error.detail.retryAfter ?? 30) * 1000);
      return;
    }
    // The Company answered, so no confirm is outstanding.
    setConfirmed(client, issuer, operationId, NOT_SENT);
    if (error.code === "terms_changed") {
      releasePermission(client, row);
      clearApproval(client, issuer, operationId);
      const current = isObject(error.detail.body) ? error.detail.body.operation : undefined;
      if (current !== undefined) await handleProposal(client, company, row.label, current);
      return;
    }
    if (error.code === "user_approval_required") {
      releasePermission(client, row);
      clearApproval(client, issuer, operationId);
      const current = { ...(JSON.parse(row.operation) as Operation), user_approval_required: true };
      client.sql.exec("UPDATE poppy_operations SET operation = ? WHERE issuer = ? AND operation_id = ?", JSON.stringify(current), issuer, operationId);
      await showOperation(client, company, stored(client, issuer, operationId)!);
      return;
    }
    if (error.code === "insufficient_scope" || error.code === "sign_in_required") {
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

function clearApproval(client: PoppyClient, issuer: string, operationId: string): void {
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
    { method: "GET", url: `${endpoint.url}/${encodeURIComponent(row.operation_id)}` },
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
export async function retryApproved(client: PoppyClient, issuer: string): Promise<void> {
  for (const row of rows<OperationRow>(
    client.sql,
    "SELECT * FROM poppy_operations WHERE issuer = ? AND approved_revision IS NOT NULL AND confirmed = ?",
    issuer,
    NOT_SENT
  )) {
    if (FINAL.has((JSON.parse(row.operation) as Operation).state)) continue;
    let operation: Operation | null;
    try {
      ({ operation } = await readOperation(client, client.companyByIssuer(issuer), row));
    } catch (error) {
      if (!(error instanceof PoppyError)) throw error;
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
export async function trackOperation(client: PoppyClient, issuer: string, operationId: string): Promise<number | null> {
  const row = stored(client, issuer, operationId);
  if (!row) return null;
  const known = JSON.parse(row.operation) as Operation;
  if (FINAL.has(known.state)) return null;
  // A proposal with no confirm outstanding has nothing to follow up.
  if (known.state === "proposed" && row.confirmed !== SENT) return null;
  const company = client.companyByIssuer(issuer);
  let read;
  try {
    read = await readOperation(client, company, row);
  } catch (error) {
    if (error instanceof PoppyError && error.code === "rate_limited") {
      return client.host.now() + (error.detail.retryAfter ?? 30) * 1000;
    }
    if (error instanceof PoppyError && error.code === "operation_not_found") return null;
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
export async function cancelOperation(client: PoppyClient, issuer: string, operationId: string): Promise<void> {
  const row = stored(client, issuer, operationId);
  if (!row) return;
  const company = client.companyByIssuer(issuer);
  const endpoint = endpointOf(company);
  releasePermission(client, row);
  const { body } = await client.resourceJson(
    company,
    { method: "POST", url: `${endpoint.url}/${encodeURIComponent(operationId)}/cancel` },
    { label: row.label, ...(endpoint.resource ? { resource: endpoint.resource } : {}) }
  );
  await update(client, company, body);
}

export function operation(client: PoppyClient, issuer: string, operationId: string): Operation | undefined {
  const row = stored(client, issuer, operationId);
  return row ? (JSON.parse(row.operation) as Operation) : undefined;
}

// ---------------------------------------------------------------- Standing permissions

type PermissionRow = {
  id: string;
  issuer: string;
  account: string;
  action: string;
  max_amount: string | null;
  currency: string | null;
  max_uses: number | null;
  uses: number;
  reserved: number;
  expires_at: number | null;
};

export function addPermission(
  client: PoppyClient,
  permission: { issuer: string; account: string; action: string; maxAmount?: string; currency?: string; maxUses?: number; expiresAt?: number }
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
  return rows<PermissionRow>(client.sql, "SELECT * FROM poppy_permissions ORDER BY created_at");
}

/**
 * A standing permission covers an operation only if it is for this Company
 * and account, the action matches, it hasn't expired or run out of uses,
 * and every money term is within its limit. A limit the terms don't let us
 * check means asking the User instead (Guides, Operations).
 */
function matchPermission(client: PoppyClient, company: Company, row: OperationRow, operation: Operation): string | undefined {
  if (!row.account) return undefined;
  const summary = operation.summary.toLowerCase();
  for (const permission of rows<PermissionRow>(
    client.sql,
    "SELECT * FROM poppy_permissions WHERE issuer = ? AND account = ?",
    company.issuer,
    row.account
  )) {
    if (permission.expires_at !== null && permission.expires_at <= Date.now()) continue;
    if (permission.max_uses !== null && permission.uses + permission.reserved >= permission.max_uses) continue;
    if (!summary.includes(permission.action)) continue;
    if (permission.max_amount !== null) {
      const money = moneyTerms(operation.terms);
      if (money.length === 0) continue;
      const limit = Number(permission.max_amount);
      if (money.some((term) => term.currency !== permission.currency || !(term.amount <= limit))) continue;
    }
    return permission.id;
  }
  return undefined;
}

/** Reserve one use before confirming, so two tasks can't both take the last one. */
function reserve(client: PoppyClient, id: string): boolean {
  const before = one<{ reserved: number }>(client.sql, "SELECT reserved FROM poppy_permissions WHERE id = ?", id);
  client.sql.exec(
    "UPDATE poppy_permissions SET reserved = reserved + 1 WHERE id = ? AND (max_uses IS NULL OR uses + reserved < max_uses)",
    id
  );
  const after = one<{ reserved: number }>(client.sql, "SELECT reserved FROM poppy_permissions WHERE id = ?", id);
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

/** How an approved local action is carried out, by kind (registered by the APIs and browser). */
export type ApprovalExecutor = (client: PoppyClient, request: Json, label: string) => Promise<string>;
const executors = new Map<string, ApprovalExecutor>();

export function registerExecutor(kind: string, executor: ApprovalExecutor): void {
  executors.set(kind, executor);
}

/**
 * At a Company without the operations extension, a write waits for the
 * User's click: the exact request is stored, and only an approval makes it,
 * once (spec, Safety). Returns the approval id.
 */
export async function proposeLocal(
  client: PoppyClient,
  company: Company,
  label: string,
  kind: string,
  summary: string,
  request: Json
): Promise<string> {
  const id = randomId("apr_");
  client.sql.exec(
    "INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    id,
    company.issuer,
    label,
    summary,
    JSON.stringify({ kind, request }),
    Date.now()
  );
  await client.host.showCard({ id: `approval-${id}`, kind: "approval", company: company.name, domain: company.domain, open: true, approvalId: id, summary, status: "pending" });
  return id;
}

type ApprovalRow = { id: string; issuer: string; label: string; summary: string; request: string; status: string };

export async function decideLocal(client: PoppyClient, id: string, decision: "approve" | "decline"): Promise<void> {
  const row = one<ApprovalRow>(client.sql, "SELECT * FROM poppy_approvals WHERE id = ?", id);
  if (!row || row.status !== "pending") return;
  const company = client.companyByIssuer(row.issuer);
  const card = (status: "approved" | "declined" | "done" | "failed" | "unknown", result?: string) =>
    client.host.showCard({
      id: `approval-${id}`,
      kind: "approval",
      company: company.name,
      domain: company.domain,
      open: false,
      approvalId: id,
      summary: row.summary,
      status,
      ...(result ? { result } : {})
    });
  if (decision === "decline") {
    client.sql.exec("UPDATE poppy_approvals SET status = 'declined' WHERE id = ?", id);
    await card("declined");
    await client.host.notifyModel(`[system] The User declined: ${row.summary}`, `poppy-approval-${id}`);
    return;
  }
  // Marked before the call: if the object dies mid-call it is never retried (Safety).
  client.sql.exec("UPDATE poppy_approvals SET status = 'executing' WHERE id = ?", id);
  const { kind, request } = JSON.parse(row.request) as { kind: string; request: Json };
  const executor = executors.get(kind);
  try {
    if (!executor) throw new Error(`No executor for ${kind}`);
    const result = await executor(client, request, row.label);
    client.sql.exec("UPDATE poppy_approvals SET status = 'done', result = ? WHERE id = ?", result, id);
    await card("done", result);
    await client.host.notifyModel(`[system] Done, as the User approved: ${row.summary}. Result: ${result}`, `poppy-approval-${id}`);
  } catch (error) {
    // A Company's refusal keeps its code, as tool failures show it.
    const message = error instanceof PoppyError ? `${error.message} [${error.code}]` : error instanceof Error ? error.message : String(error);
    client.sql.exec("UPDATE poppy_approvals SET status = 'failed', result = ? WHERE id = ?", message, id);
    await card("failed", message);
    await client.host.notifyModel(`[system] The approved action failed: ${row.summary}. ${message}`, `poppy-approval-${id}`);
  }
}

/** After a restart: approvals left mid-call have an unknown outcome; say so, never retry. */
export async function recoverInterruptedApprovals(client: PoppyClient): Promise<void> {
  for (const row of rows<ApprovalRow>(client.sql, "SELECT * FROM poppy_approvals WHERE status = 'executing'")) {
    client.sql.exec("UPDATE poppy_approvals SET status = 'unknown' WHERE id = ?", row.id);
    let company = "the company";
    try {
      company = client.companyByIssuer(row.issuer).name;
    } catch {
      // Unknown issuer; keep the generic name.
    }
    await client.host.showCard({
      id: `approval-${row.id}`,
      kind: "approval",
      company,
      open: false,
      approvalId: row.id,
      summary: row.summary,
      status: "unknown",
      result: "Interrupted; check with the company whether it happened."
    });
    await client.host.notifyModel(
      `[system] An approved action was interrupted and its outcome is unknown: ${row.summary}. Tell the User to check with ${company}; it won't be retried automatically.`,
      `poppy-approval-${row.id}`
    );
  }
}
