/**
 * What a person's export contains. Nothing is exported by default: a table or
 * column reaches the file only by being listed here, so a credential added
 * later stays out until someone decides otherwise. `test/agent-data.test.ts`
 * fails when a live table or column has no classification.
 */
const columns = (names: string) => names.split(" ");

/** Personal records, by table: the columns a person gets back. */
const EXPORTED: Readonly<Record<string, readonly string[]>> = {
  agent_flow_log: columns("flow_id seq at line"),
  agent_log: columns("seq at kind level line"),
  agent_profile: columns("slot provider sub email domain updated_at"),
  attachment_chunks: columns("id part seq bytes"),
  attachments: columns("id name type size preview_type created_at"),
  memories: columns("id text source created_at"),
  model_budget_calls: columns("id day domain reserved_usd cost_usd shared_settled"),
  model_paused: columns("operation_id text created_at"),
  model_spend: columns("day cost_usd calls"),
  pi_conversations: columns("id owner_conversation_id owner_task_id record"),
  pi_document_revisions: columns("document_id seq kind version content"),
  pi_documents: columns("id kind family key_value scope_kind owner_id created_at retired_at record"),
  pi_entries: columns("id conversation_id head commit_seq record"),
  pi_submissions: columns("id conversation_id request_id status record"),
  pi_tasks: columns("id conversation_id kind status abort_requested background record"),
  poppy_accounts: columns("issuer account scope expires_at updated_at"),
  poppy_approval_batches: columns("id ids told created_at notification"),
  poppy_approvals: columns("id issuer label summary request status result created_at terms terms_approval_id action_key action_owner operation_id notification_pending notification notification_batch_id resolution_notification_pending resolution_notification outcome_resolution outcome_resolved_at approver instruction_id"),
  poppy_cards: columns("id card open updated_at"),
  poppy_conversation_quarantine: columns("kind source_id payload quarantined_at"),
  poppy_conversations: columns("id issuer remote_id quarantined retired_at label parent direct status responder cursor context last_event_at created_at protocol_version extensions working handoff"),
  poppy_handovers: columns("id issuer label url step state binding looked created_at started_at ended_at"),
  poppy_inbox: columns("seq conversation_id event created_at"),
  poppy_instruction_spend: columns("approval_id instruction_id amount currency state at"),
  poppy_instructions: columns("id issuer account text conditions budget created_at withdrawn_at"),
  poppy_intents: columns("call_key value created_at"),
  poppy_messages: columns("id issuer conversation_id body created_at"),
  poppy_protocol_log: columns("seq key issuer at step method url status error outcome summary result"),
  poppy_sessions: columns("issuer label session_id account signed_in scope updated_at used_account authority_generation declared"),
  poppy_signins: columns("id type issuer label account scopes interval_seconds expires_at status created_at"),
  poppy_signouts: columns("id issuer account reason scope expires_at status attempts last_error next_at created_at updated_at"),
  poppy_user_ids: columns("issuer user_id"),
  push_subscriptions: columns("created_at last_status last_sent_at"),
  schedule_runs: columns("id schedule_id kind text due_at ran_at outcome detail operation_id"),
  schedules: columns("id kind text next_run recurrence local_time weekday time_zone created_at created_from status failures last_run last_outcome paused_reason attempts retry_due finished_at task_access"),
  task_company_selection: columns("slot companies"),
  turn_sources: columns("request_id source task_policy task_access task_bound")
};

/** Secrets, or values that act like them, marked as left out so the file doesn't look incomplete. */
const CREDENTIALS: Readonly<Record<string, readonly string[]>> = {
  poppy_accounts: ["token"],
  // A Browser Run session holding the Session's cookies, while the User has control (Browser Control 5).
  poppy_handovers: ["browser"],
  poppy_signins: ["state_hash", "secret"],
  poppy_signouts: ["token"],
  // A push endpoint is an unguessable address that reaches the device.
  push_subscriptions: ["endpoint", "p256dh", "auth"]
};

/** Left out whole: credentials, and the machinery of queues, caches and schema versions, which hold nothing about the person. */
const WITHHELD_TABLES: ReadonlySet<string> = new Set([
  "agent_data_state", "browser_sessions", "cf_agents_jobs", "model_keys", "pi_durable_metadata", "pi_durable_schema",
  "pi_record_ids", "poppy_conversation_migration", "poppy_domains", "poppy_events", "poppy_task_calls",
  "poppy_task_contexts", "read_url_renders"
]);

/** One-time sign-in values held inside a card, which no column filter would see: `state`, a device's user code. */
const CARD_SECRETS = ["url", "verificationUri", "verificationUriComplete", "userCode"];

function withoutSignInSecrets(card: unknown): unknown {
  if (typeof card !== "string") return card;
  let parsed: unknown;
  try { parsed = JSON.parse(card); } catch { return card; }
  if (typeof parsed !== "object" || parsed === null || !("kind" in parsed) || typeof parsed.kind !== "string" || !parsed.kind.startsWith("signin_")) return card;
  const kept = { ...parsed } as Record<string, unknown>;
  for (const field of CARD_SECRETS) if (field in kept) kept[field] = { omitted: "credential" };
  return JSON.stringify(kept);
}

/** An open SQL cursor locks its table, and an export can outlive its reader, so rows are read in batches. */
const BATCH_ROWS = 100;
/** A photo chunk is large, so these go one at a time and a collection is never held in memory. */
const BATCH_ROWS_BY_TABLE: Readonly<Record<string, number>> = { attachment_chunks: 1 };

export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const isApplicationTable = (name: string) => !name.startsWith("sqlite_") && !name.startsWith("_cf") && !name.startsWith("__cf");
const encoder = new TextEncoder();

function storedTables(sql: SqlStorage): string[] {
  return sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map(row => String(row.name)).filter(isApplicationTable);
}

function storedColumns(sql: SqlStorage, table: string): string[] {
  return sql.exec(`PRAGMA table_info(${quote(table)})`).toArray().map(row => String(row.name));
}

/** Stored tables and columns nobody has classified. They are withheld; the test requires this to be empty. */
export function unclassifiedStorage(sql: SqlStorage): string[] {
  return storedTables(sql).filter(table => !WITHHELD_TABLES.has(table)).flatMap(table => {
    const exported = EXPORTED[table];
    if (!exported) return [table];
    return storedColumns(sql, table).filter(column => !exported.includes(column) && !CREDENTIALS[table]?.includes(column)).map(column => `${table}.${column}`);
  });
}

function portable(table: string, row: Record<string, SqlStorageValue>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof ArrayBuffer) {
      let binary = "";
      for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
      record[key] = { encoding: "base64", data: btoa(binary) };
    } else record[key] = table === "poppy_cards" && key === "card" ? withoutSignInSecrets(value) : value;
  }
  for (const column of CREDENTIALS[table] ?? []) record[column] = { omitted: "credential" };
  return record;
}

/** Streams personal records and photo chunks; a 100 MiB photo collection is never buffered as one response. */
export function exportAgentData(sql: SqlStorage, now = Date.now()): ReadableStream<Uint8Array> {
  const tables = storedTables(sql).flatMap(name => {
    const stored = storedColumns(sql, name);
    const selected = (EXPORTED[name] ?? []).filter(column => stored.includes(column));
    return selected.length ? [{ name, selected }] : [];
  });
  const unclassified = unclassifiedStorage(sql);
  function* chunks(): Generator<string> {
    yield JSON.stringify({ format: "pda-personal-data", version: 1, exportedAt: new Date(now).toISOString(), ...(unclassified.length ? { withheldUnclassified: unclassified } : {}),
      note: "This export contains personal data. Stored credentials and browser sessions are omitted. Records are read while the export streams; concurrent activity may change them. Photos are base64 chunks: join each photo's chunks by id, part and seq." }).slice(0, -1) + ',"tables":{';
    for (let index = 0; index < tables.length; index++) {
      const { name, selected } = tables[index]!;
      yield `${index ? "," : ""}${JSON.stringify(name)}:[`;
      let first = true;
      const limit = BATCH_ROWS_BY_TABLE[name] ?? BATCH_ROWS;
      let after = Number.MIN_SAFE_INTEGER;
      for (;;) {
        // `.toArray()` finishes each read: no cursor is left open while this generator is suspended.
        const batch = sql.exec(`SELECT rowid AS export_rowid, ${selected.map(quote).join(", ")} FROM ${quote(name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`, after, limit).toArray();
        for (const { export_rowid: rowid, ...row } of batch) {
          after = Number(rowid);
          yield `${first ? "" : ","}${JSON.stringify(portable(name, row))}`;
          first = false;
        }
        if (batch.length < limit) break;
      }
      yield "]";
    }
    yield "}}";
  }
  const records = chunks();
  return new ReadableStream({
    pull(controller) {
      try {
        const next = records.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) { controller.error(error); }
    },
    cancel() { records.return(undefined); }
  });
}
