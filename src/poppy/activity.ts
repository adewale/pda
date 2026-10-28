import { writtenBy } from "./message-author";
import type { PoppyClient } from "./client";
import { lostOutcome } from "./operations";
import { object } from "../decode";
import { integer, newestRows, nullable, one, rows, text } from "../rows";
import { accountsTable, approvalsTable, conversationsTable, messagesTable, operationsTable, signInsTable, type Sql } from "./store";
import type { ActivityAccess, ActivityEntry, ActivityResult, ActivityTask, PoppyServerFrame } from "./wire";
import type { Issuer } from "./issuer";
import { pendingSignOuts, signOutForModel, signOutRecords, type SignOutRecord } from "./signout";

/**
 * The page's Activity view, built from the agent's own tables rather than
 * from cards, so it keeps what happened after a card's hour is up. Each
 * query names its columns: sign-in secrets, state hashes, sealed tokens and
 * stored requests are never read here, so they can't reach the page.
 */

/** How many log lines the page gets, newest first; no table gives it more than its newest this many. */
export const ACTIVITY_LOG_LIMIT = 200;

/** Longest quoted text in an entry. */
const QUOTE_LIMIT = 280;

function clip(text: string, limit = QUOTE_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** View, or view and change, from Poppy's built-in scopes; null when only custom scopes say. */
export function accessOf(scope: string): ActivityAccess | null {
  const scopes = new Set(scope.split(" ").filter(Boolean));
  if (scopes.has("poppy:write")) return "view_and_change";
  if (scopes.has("poppy:read")) return "view";
  return null;
}

const operationRow = operationsTable.pick("issuer", "operation_id", "account", "operation", "approved_revision", "approved_by", "confirmed", "updated_at");

/** Operations not final as far as the Company last said, newest first, through the index on their state: never the whole history. */
function openOperations(sql: Sql) {
  return rows(
    sql,
    operationRow,
    `SELECT issuer, operation_id, account, operation, approved_revision, approved_by, confirmed, updated_at FROM poppy_operations
     WHERE json_extract(operation, '$.state') IN ('proposed', 'in_progress') ORDER BY updated_at DESC`
  );
}

/** `kind` is read out of the stored request (`json_extract`); the request itself never is. */
const approvalColumns = approvalsTable.columns;
const approvalRow = object({
  id: approvalColumns.id,
  issuer: approvalColumns.issuer,
  summary: approvalColumns.summary,
  status: approvalColumns.status,
  result: approvalColumns.result,
  created_at: approvalColumns.created_at,
  kind: nullable(text)
});

const signInRow = signInsTable.pick("id", "type", "issuer", "account", "scopes", "status", "expires_at", "created_at");

const conversationRow = conversationsTable.pick("id", "issuer", "quarantined", "direct", "status", "responder", "last_event_at", "created_at");

/** A reminder or task that ran (src/tools/schedule-store.ts `schedule_runs`). */
const scheduleRunRow = object({ id: integer, kind: text, text, ran_at: integer, outcome: text, detail: nullable(text) });

/** A message we sent, and whether its conversation is a Direct Conversation (null: not one we know). */
const messageColumns = messagesTable.columns;
const messageRow = object({
  id: messageColumns.id,
  issuer: messageColumns.issuer,
  conversation_id: messageColumns.conversation_id,
  body: messageColumns.body,
  created_at: messageColumns.created_at,
  in_direct: nullable(integer)
});

const OPERATION_RESULT: Record<string, ActivityResult> = {
  proposed: "waiting",
  in_progress: "in_progress",
  succeeded: "done",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired"
};

const APPROVAL_RESULT: Record<string, ActivityResult> = {
  pending: "waiting",
  executing: "in_progress",
  done: "done",
  declined: "declined",
  refused: "failed",
  failed: "failed",
  unknown: "unknown"
};

const SIGN_IN_RESULT: Record<string, ActivityResult> = {
  pending: "waiting",
  code: "waiting",
  sent: "in_progress",
  used: "in_progress",
  exchanging: "in_progress",
  exchanged: "in_progress",
  stored: "in_progress",
  done: "done",
  failed: "failed",
  // Ran out of time: the Company said so (`expired`, `expired_token`), or our own deadline passed.
  expired: "expired"
};

const SIGN_IN_WAY: Record<string, string> = {
  direct: "on its own page",
  device: "with a code on another device",
  mediated: "through this page"
};

/**
 * Everything still open at every Company, for the model (`poppy_status` with
 * no domain): operations not final, approvals not decided or not finished,
 * sign-ins under way, open conversations, the accounts signed in, and
 * sign-outs the Company hasn't accepted (its access still live there). From
 * the same tables as the Activity view, naming only the columns it shows, so
 * it never holds a token, key, code, state hash or stored request. The
 * Company's own words are labelled as the Company's.
 */
export function openAtCompanies(client: PoppyClient, now = Date.now()) {
  const sql = client.sql;
  const known = new Map<string, { company: string; domain: string | null }>();
  const where = (issuer: Issuer) => {
    let found = known.get(issuer);
    if (!found) {
      try {
        const company = client.companyByIssuer(issuer);
        found = { company: company.name, domain: company.domain };
      } catch {
        found = { company: URL.canParse(issuer) ? new URL(issuer).host : issuer, domain: null };
      }
      known.set(issuer, found);
    }
    return found;
  };

  const operations = openOperations(sql).flatMap((row) => {
    const operation = row.operation;
    // One the Company no longer has (N19) is final for us, whatever its last state said.
    if (lostOutcome(row.confirmed) || (operation.state !== "proposed" && operation.state !== "in_progress")) return [];
    const approved = row.approved_revision !== null && row.approved_revision === operation.revision;
    return [
      {
        ...where(row.issuer),
        operation: row.operation_id,
        revision: operation.revision,
        state: operation.state,
        companySays: operation.summary,
        decision:
          operation.state === "in_progress"
            ? "approved; the company is carrying it out"
            : approved
              ? "approved by the User; confirming"
              : "waiting for the User, on a card on their page"
      }
    ];
  });

  const approvals = rows(
    sql,
    approvalsTable.pick("id", "issuer", "summary", "status", "created_at"),
    "SELECT id, issuer, summary, status, created_at FROM poppy_approvals WHERE status IN ('pending', 'executing') ORDER BY created_at DESC"
  ).map((row) => ({
    ...where(row.issuer),
    approval: row.id,
    action: row.summary,
    state: row.status === "pending" ? "waiting for the User, on a card on their page" : "approved by the User; being carried out"
  }));

  const signIns = rows(
    sql,
    signInsTable.pick("id", "type", "issuer", "account", "scopes", "status", "expires_at"),
    "SELECT id, type, issuer, account, scopes, status, expires_at FROM poppy_signins WHERE status NOT IN ('done', 'failed', 'expired') ORDER BY created_at DESC"
  )
    .filter((row) => !((row.status === "pending" || row.status === "code") && row.expires_at <= now))
    .map((row) => ({
      ...where(row.issuer),
      signIn: row.type,
      account: row.account === "default" ? null : row.account,
      scopes: row.scopes,
      state: row.status === "pending" || row.status === "code" ? "waiting for the User" : "finishing",
      until: new Date(row.expires_at).toISOString()
    }));

  const conversations = rows(
    sql,
    conversationsTable.pick("id", "issuer", "direct", "status", "responder"),
    "SELECT id, issuer, direct, status, responder FROM poppy_conversations WHERE status != 'closed' AND quarantined = 0 ORDER BY last_event_at DESC"
  ).map((row) => ({
    ...where(row.issuer),
    conversation: row.id,
    status: row.status,
    responder: row.responder,
    direct: !!row.direct
  }));

  const accounts = rows(
    sql,
    accountsTable.pick("issuer", "account", "scope", "expires_at"),
    "SELECT issuer, account, scope, expires_at FROM poppy_accounts WHERE expires_at IS NULL OR expires_at > ?",
    now
  ).map((row) => ({
    ...where(row.issuer),
    account: row.account,
    scope: row.scope,
    ...(row.expires_at !== null ? { expires: new Date(row.expires_at).toISOString() } : {})
  }));

  // Signed out here, but the Company hasn't accepted revoking the token: its access is still live there.
  const signOutsNotAccepted = pendingSignOuts(client).map((row) => ({ ...where(row.issuer), ...signOutForModel(row) }));

  return { operations, approvals, signIns, conversations, accounts, signOutsNotAccepted };
}

export function buildActivity(client: PoppyClient, now = Date.now()): Extract<PoppyServerFrame, { type: "poppy.activity" }> {
  const sql = client.sql;
  const names = new Map<string, string>();
  const name = (issuer: Issuer): string => {
    let found = names.get(issuer);
    if (found === undefined) {
      try {
        found = client.companyByIssuer(issuer).name;
      } catch {
        found = URL.canParse(issuer) ? new URL(issuer).host : issuer;
      }
      names.set(issuer, found);
    }
    return found;
  };
  const log: ActivityEntry[] = [];
  const inProgress: ActivityTask[] = [];

  // Each table gives the log only its newest rows (`newestRows`, through an index on its time), so the log's limit
  // bounds what is read however long the history; what is still under way comes from its own query, small and whole.
  const newest = (table: string, columns: string, time: string) => newestRows(table, columns, time, ACTIVITY_LOG_LIMIT);

  // Operations (Ops): the Company's summary and result, verbatim.
  const operationColumns = "issuer, operation_id, account, operation, approved_revision, approved_by, confirmed, updated_at";
  const recentOperations = rows(sql, operationRow, ...newest("poppy_operations", operationColumns, "updated_at"));
  // Which of them reached us through the Company's agent: looked up by id (an index on the inbox), not by reading the inbox.
  const operationsFromAgent = new Set(
    recentOperations.length === 0
      ? []
      : rows(
          sql,
          object({ id: text, issuer: conversationsTable.columns.issuer }),
          `SELECT DISTINCT json_extract(i.event, '$.message.operation.operation_id') AS id, c.issuer AS issuer FROM poppy_inbox i
           JOIN poppy_conversations c ON c.id = i.conversation_id AND c.quarantined = 0
           WHERE json_extract(i.event, '$.message.operation.operation_id') IN (SELECT value FROM json_each(?))`,
          JSON.stringify(recentOperations.map((row) => row.operation_id))
        ).map((row) => JSON.stringify([row.issuer, row.id]))
  );
  for (const row of recentOperations) {
    const operation = row.operation;
    const company = name(row.issuer);
    const approved = row.approved_revision !== null && row.approved_revision === operation.revision;
    // The Company no longer has it (N19): final for us, done or not as far as we know.
    const lost = lostOutcome(row.confirmed);
    const result: ActivityResult = lost
      ? lost === "unknown"
        ? "unknown"
        : "expired"
      : operation.state === "proposed" && approved
        ? "in_progress"
        : (OPERATION_RESULT[operation.state] ?? "unknown");
    log.push({
      id: `op-${row.issuer}-${row.operation_id}`,
      at: row.updated_at,
      kind: "operation",
      issuer: row.issuer,
      company,
      account: row.account,
      what: `${company} proposed`,
      quote: operation.summary,
      quoteBy: "company",
      how: operationsFromAgent.has(JSON.stringify([row.issuer, row.operation_id])) ? "company_agent" : "api",
      access: "view_and_change",
      decidedBy: row.approved_by === "user" ? "you" : row.approved_by === "standing_permission" ? "standing_permission" : null,
      result,
      ...(lost
        ? {
            outcome:
              lost === "unknown"
                ? `${company} no longer has it, and it may have happened: check with ${company}.`
                : `${company} no longer has it, and it wasn't done.`,
            outcomeBy: "agent" as const
          }
        : operation.result?.summary
          ? { outcome: clip(operation.result.summary), outcomeBy: "company" as const }
          : {})
    });
  }
  for (const row of openOperations(sql)) {
    const operation = row.operation;
    if (lostOutcome(row.confirmed)) continue;
    const company = name(row.issuer);
    const approved = row.approved_revision !== null && row.approved_revision === operation.revision;
    if (operation.state === "in_progress") {
      inProgress.push({
        id: `op-${row.issuer}-${row.operation_id}`,
        kind: "operation",
        issuer: row.issuer,
        company,
        what: `${company} is carrying out`,
        quote: operation.summary,
        quoteBy: "company",
        since: row.updated_at,
        stop: { type: "poppy.operation", issuer: row.issuer, operationId: row.operation_id, revision: operation.revision, decision: "cancel" }
      });
    } else if (operation.state === "proposed" && approved && !row.confirmed) {
      inProgress.push({
        id: `op-${row.issuer}-${row.operation_id}`,
        kind: "operation",
        issuer: row.issuer,
        company,
        what: `Confirming with ${company}`,
        quote: operation.summary,
        quoteBy: "company",
        note: "Approved. It's confirmed as soon as the account is signed in.",
        since: row.updated_at
      });
    }
  }

  // Local approvals: writes no operation covers, uploads and website submits.
  for (const row of rows(
    sql,
    approvalRow,
    ...newest("poppy_approvals", "id, issuer, summary, json_extract(request, '$.kind') AS kind, status, result, created_at", "created_at")
  )) {
    const company = name(row.issuer);
    const result = APPROVAL_RESULT[row.status] ?? "unknown";
    // What an approved API call returned stays out of the log; what the website showed, and why something failed, go in.
    // A failure can carry a Company's arbitrary error_description. Keep those
    // words on its approval card and out of the Activity/diagnostics surface.
    const outcome = row.status === "failed"
      ? "The approved request could not be completed. See its approval card for details."
      : row.result && (result !== "done" || row.kind === "browse-submit") ? clip(row.result) : undefined;
    log.push({
      id: `approval-${row.id}`,
      at: row.created_at,
      kind: "approval",
      issuer: row.issuer,
      company,
      account: null,
      what: "Asked you to approve",
      quote: row.summary,
      quoteBy: "agent",
      how: row.kind === "browse-submit" ? "website" : "api",
      access: "view_and_change",
      decidedBy: row.status === "pending" ? null : "you",
      result,
      ...(outcome ? { outcome, outcomeBy: "agent" as const } : {})
    });
  }
  for (const row of rows(
    sql,
    approvalsTable.pick("id", "issuer", "summary", "created_at"),
    "SELECT id, issuer, summary, created_at FROM poppy_approvals WHERE status = 'executing'"
  )) {
    const company = name(row.issuer);
    inProgress.push({
      id: `approval-${row.id}`,
      kind: "approval",
      issuer: row.issuer,
      company,
      what: `Doing what you approved at ${company}`,
      quote: row.summary,
      quoteBy: "agent",
      since: row.created_at
    });
  }

  // Sign-ins: type, scopes and outcome only.
  const signInColumns = "id, type, issuer, account, scopes, status, expires_at, created_at";
  const timedOut = (row: { status: string; expires_at: number }) => (row.status === "pending" || row.status === "code") && row.expires_at <= now;
  for (const row of rows(sql, signInRow, ...newest("poppy_signins", signInColumns, "created_at"))) {
    const company = name(row.issuer);
    const result: ActivityResult = timedOut(row) ? "expired" : (SIGN_IN_RESULT[row.status] ?? "unknown");
    log.push({
      id: `signin-${row.id}`,
      at: row.created_at,
      kind: "sign_in",
      issuer: row.issuer,
      company,
      account: row.account === "default" ? null : row.account,
      what: `Sign-in at ${company} ${SIGN_IN_WAY[row.type] ?? ""}`.trim(),
      how: "sign_in",
      access: accessOf(row.scopes),
      decidedBy: result === "done" ? "you" : null,
      result
    });
  }
  for (const row of rows(
    sql,
    signInRow,
    `SELECT ${signInColumns} FROM poppy_signins WHERE status = 'pending' AND type = 'device' AND expires_at > ?`,
    now
  )) {
    const company = name(row.issuer);
    inProgress.push({
      id: `signin-${row.id}`,
      kind: "device_sign_in",
      issuer: row.issuer,
      company,
      what: `Waiting for you to sign in at ${company} on another device`,
      since: row.created_at,
      until: row.expires_at,
      stop: { type: "poppy.signin.cancel", signInId: row.id }
    });
  }

  // Revocations: the User's sign-outs, where the agent stops using the account at once, and the tokens a
  // step-up replaced, where the account stays signed in with the new one. The Company may take longer to accept.
  const codeOf = (row: SignOutRecord) => row.last_error ?? "no_answer";
  const tries = (row: SignOutRecord) => `${row.attempts} ${row.attempts === 1 ? "try" : "tries"}`;
  for (const row of signOutRecords(client, ACTIVITY_LOG_LIMIT)) {
    const company = name(row.issuer);
    const stepUp = row.reason === "step_up";
    const access = stepUp ? "the access it replaced" : "the access it granted";
    const code = codeOf(row);
    const outcome =
      row.status === "pending"
        ? `${company} hasn't accepted it yet (${code}) after ${tries(row)}, so ${access} is still live there. Your agent will try again.`
        : row.status === "stopped"
          ? `${company} didn't accept it (${code}) after ${tries(row)}, and your agent has stopped trying. ${access[0]!.toUpperCase()}${access.slice(1)} stays live there until it expires or you revoke it at ${company}.`
          : row.status === "expired"
            ? "The access had already ended, so there was nothing to revoke."
            : row.attempts > 1
              ? `${company} accepted it after ${tries(row)}.`
              : undefined;
    log.push({
      id: `signout-${row.id}`,
      at: row.created_at,
      kind: "sign_out",
      issuer: row.issuer,
      company,
      account: row.account === "default" ? null : row.account,
      what: stepUp ? `Revoking the access at ${company} that more access replaced` : `Signed out of ${company}`,
      how: "sign_in",
      access: accessOf(row.scope),
      // The User asked for a sign-out; a step-up's revocation is the agent's own.
      decidedBy: stepUp ? null : "you",
      result: row.status === "pending" ? "in_progress" : row.status === "stopped" ? "failed" : "done",
      ...(outcome ? { outcome, outcomeBy: "agent" as const } : {})
    });
  }
  // Open revocations come from their own query, so an old one still shows however long the log is.
  for (const row of pendingSignOuts(client)) {
    if (row.status !== "pending") continue;
    const company = name(row.issuer);
    const stepUp = row.reason === "step_up";
    inProgress.push({
      id: `signout-${row.id}`,
      kind: "sign_out",
      issuer: row.issuer,
      company,
      what: stepUp ? `Asking ${company} to revoke the access that more access replaced` : `Asking ${company} to revoke the access you signed out of`,
      note: stepUp
        ? `Not accepted yet (${codeOf(row)}). Your agent uses only the new access; the old access stays live at ${company} until it accepts.`
        : `Not accepted yet (${codeOf(row)}). Your agent no longer uses the account; the access stays live at ${company} until it accepts.`,
      since: row.created_at
    });
  }

  // Conversations with the Company's agent, and Direct Conversations.
  const conversationColumns = "id, issuer, quarantined, direct, status, responder, last_event_at, created_at";
  for (const row of rows(sql, conversationRow, ...newest("poppy_conversations", conversationColumns, "created_at"))) {
    if (row.quarantined) continue;
    const company = name(row.issuer);
    log.push({
      id: `conversation-${row.id}`,
      at: row.created_at,
      kind: "conversation",
      issuer: row.issuer,
      company,
      account: null,
      what: row.direct ? `You talked with ${company} directly` : `Conversation with ${company}'s agent`,
      how: row.direct ? "direct" : "company_agent",
      access: null,
      decidedBy: row.direct ? "you" : null,
      result: row.status !== "closed" ? "in_progress" : "done"
    });
  }
  for (const row of rows(sql, conversationRow, `SELECT ${conversationColumns} FROM poppy_conversations WHERE status != 'closed' AND quarantined = 0`)) {
    const company = name(row.issuer);
    inProgress.push({
      id: `conversation-${row.id}`,
      kind: "conversation",
      issuer: row.issuer,
      company,
      what: row.direct ? `Your conversation with ${company}` : `Listening for replies from ${company}'s agent`,
      note:
        row.responder === "human"
          ? `A person at ${company} is answering.`
          : row.status === "working" || row.status === "queued"
            ? `${company}'s agent is working on it.`
            : `${company}'s agent is answering.`,
      since: row.last_event_at,
      stop: { type: "poppy.direct.close", conversationId: row.id }
    });
  }

  // Messages we sent; context-only updates aren't news. Whether one was in a Direct Conversation is the conversation's to say.
  for (const row of rows(
    sql,
    messageRow,
    `SELECT m.id AS id, m.issuer AS issuer, m.conversation_id AS conversation_id, m.body AS body, m.created_at AS created_at,
       c.direct AS in_direct FROM poppy_messages m LEFT JOIN poppy_conversations c ON c.id = m.conversation_id
     ORDER BY m.created_at DESC LIMIT ?`,
    ACTIVITY_LOG_LIMIT
  )) {
    let body: { parent_conversation_id?: string; message?: { sender?: string; author?: unknown; text?: unknown; data?: unknown } };
    try {
      body = JSON.parse(row.body);
    } catch {
      continue;
    }
    const message = body.message;
    if (!message || (typeof message.text !== "string" && message.data === undefined)) continue;
    const company = name(row.issuer);
    const human = writtenBy(message) === "human";
    const isDirect = human || !!body.parent_conversation_id || row.in_direct === 1;
    log.push({
      id: `message-${row.id}`,
      at: row.created_at,
      kind: "message",
      issuer: row.issuer,
      company,
      account: null,
      what: human ? `You wrote to ${company}` : typeof message.text === "string" ? `Wrote to ${company}'s agent` : `Sent details to ${company}'s agent`,
      ...(typeof message.text === "string" ? { quote: clip(message.text), quoteBy: human ? ("you" as const) : ("agent" as const) } : {}),
      how: isDirect ? "direct" : "company_agent",
      access: null,
      decidedBy: null,
      result: "done"
    });
  }

  // Reminders and scheduled tasks that ran (src/schedules.ts): the User's own words, and how it went.
  const hasRuns = one(sql, object({ name: text }), "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedule_runs'") !== undefined;
  if (hasRuns) {
    for (const row of rows(
      sql,
      scheduleRunRow,
      "SELECT id, kind, text, ran_at, outcome, detail FROM schedule_runs ORDER BY id DESC LIMIT ?",
      ACTIVITY_LOG_LIMIT
    )) {
      const reminder = row.kind === "reminder";
      log.push({
        id: `scheduled-${row.id}`,
        at: row.ran_at,
        kind: "scheduled",
        issuer: "",
        company: "Your agent",
        account: null,
        what: reminder ? (row.outcome === "failed" ? "Couldn't remind you" : "Reminded you") : row.outcome === "failed" ? "Couldn't run your scheduled task" : "Ran your scheduled task",
        quote: clip(row.text),
        quoteBy: "you",
        how: "schedule",
        access: null,
        decidedBy: "you",
        result: row.outcome === "failed" ? "failed" : row.outcome === "started" ? "in_progress" : "done",
        ...(row.detail ? { outcome: clip(row.detail), outcomeBy: "agent" as const } : {})
      });
    }
  }

  log.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  inProgress.sort((a, b) => b.since - a.since || a.id.localeCompare(b.id));
  return { type: "poppy.activity", inProgress, log: log.slice(0, ACTIVITY_LOG_LIMIT) };
}
