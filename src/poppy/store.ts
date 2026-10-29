import { ConfigError } from "../config";
import { base64url, fromBase64url } from "../base64url";
import { migrateProtocolLog } from "./protocol-log";
import { flag, jsonText, literal } from "../decode";
import { integer, integerOf, nullable, one, table, text, textOf } from "../rows";
import { issuerDecoder } from "./issuer";
import { approvalTermsDecoder } from "./operations-v2";
import { protocolRevision, supportsProtocol } from "./protocol-version";
import { isObject } from "./json";

/**
 * Poppy state in the person's SQLite, beside Pi's `pi_*` tables. Session
 * Tokens and DPoP keys are deliberately absent: they live only in memory.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS poppy_task_contexts (
  kind TEXT NOT NULL,
  task_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  company TEXT NOT NULL,
  PRIMARY KEY (kind, issuer, task_id)
);
CREATE TABLE IF NOT EXISTS poppy_domains (
  domain TEXT PRIMARY KEY,
  issuer TEXT,
  company TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_user_ids (
  issuer TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_sessions (
  issuer TEXT NOT NULL,
  label TEXT NOT NULL,
  session_id TEXT NOT NULL,
  account TEXT,
  signed_in INTEGER NOT NULL,
  scope TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  used_account TEXT,
  authority_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (issuer, label)
);
CREATE TABLE IF NOT EXISTS poppy_accounts (
  issuer TEXT NOT NULL,
  account TEXT NOT NULL,
  token TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, account)
);
CREATE TABLE IF NOT EXISTS poppy_signouts (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  account TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'sign_out',
  token TEXT,
  scope TEXT NOT NULL,
  expires_at INTEGER,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  next_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_signins (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  issuer TEXT NOT NULL,
  label TEXT NOT NULL,
  account TEXT NOT NULL,
  scopes TEXT NOT NULL,
  state_hash TEXT,
  secret TEXT NOT NULL,
  interval_seconds INTEGER,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_conversations (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  remote_id TEXT NOT NULL DEFAULT '',
  quarantined INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  parent TEXT,
  direct INTEGER NOT NULL,
  status TEXT NOT NULL,
  responder TEXT NOT NULL,
  cursor TEXT,
  context TEXT,
  last_event_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_conversation_quarantine (
  kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL,
  PRIMARY KEY (kind, source_id)
);
CREATE TABLE IF NOT EXISTS poppy_conversation_migration (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_events (
  conversation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, event_id)
);
CREATE TABLE IF NOT EXISTS poppy_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  event TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_messages (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  conversation_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_approvals (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  request TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  terms TEXT,
  terms_approval_id TEXT
);
-- Approvals decided together on one card (operations.ts decideLocalBatch): the model is told once, when every one is done.
-- A row with told = 0 after a restart is told then, from what its approvals' rows say.
CREATE TABLE IF NOT EXISTS poppy_approval_batches (
  id TEXT PRIMARY KEY,
  ids TEXT NOT NULL,
  told INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_intents (
  call_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poppy_cards (
  id TEXT PRIMARY KEY,
  card TEXT NOT NULL,
  open INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Activity (src/poppy/activity.ts) reads each table's newest rows by time and its open work by state, never a whole table.
CREATE INDEX IF NOT EXISTS poppy_approvals_created ON poppy_approvals (created_at);
CREATE INDEX IF NOT EXISTS poppy_approvals_status ON poppy_approvals (status);
CREATE INDEX IF NOT EXISTS poppy_signins_created ON poppy_signins (created_at);
CREATE INDEX IF NOT EXISTS poppy_signins_status ON poppy_signins (status);
CREATE INDEX IF NOT EXISTS poppy_signouts_created ON poppy_signouts (created_at);
CREATE INDEX IF NOT EXISTS poppy_signouts_pending ON poppy_signouts (created_at) WHERE token IS NOT NULL;
CREATE INDEX IF NOT EXISTS poppy_conversations_created ON poppy_conversations (created_at);
CREATE INDEX IF NOT EXISTS poppy_conversations_open ON poppy_conversations (last_event_at) WHERE status != 'closed';
CREATE INDEX IF NOT EXISTS poppy_messages_created ON poppy_messages (created_at);
CREATE INDEX IF NOT EXISTS poppy_inbox_operation ON poppy_inbox (json_extract(event, '$.message.operation.operation_id'));
`;

export type Sql = SqlStorage;

export function migrate(sql: Sql): void {
  for (const statement of SCHEMA.split(";")) {
    if (statement.trim()) sql.exec(statement);
  }
  // Operations 1 (0.1, 0.2), which 0.3 replaced (decision 37): its tables go, and their protocol-log triggers with them.
  for (const name of ["poppy_operations", "poppy_proposals", "poppy_permissions"]) sql.exec(`DROP TABLE IF EXISTS ${name}`);
  // Agents created before 14 October 2026: every revocation till then was a sign-out.
  if (!sql.exec("PRAGMA table_info(poppy_signouts)").toArray().some((column) => column.name === "reason")) {
    sql.exec("ALTER TABLE poppy_signouts ADD COLUMN reason TEXT NOT NULL DEFAULT 'sign_out'");
  }
  // Agents created before 28 October 2026: which account a 0.3 Session was used with, after it continues signed out.
  if (!sql.exec("PRAGMA table_info(poppy_sessions)").toArray().some((column) => column.name === "used_account")) {
    sql.exec("ALTER TABLE poppy_sessions ADD COLUMN used_account TEXT");
  }
  // A sign-out changes local authority even when a later sign-in keeps the protocol's sid.
  if (!sql.exec("PRAGMA table_info(poppy_sessions)").toArray().some((column) => column.name === "authority_generation")) {
    sql.exec("ALTER TABLE poppy_sessions ADD COLUMN authority_generation INTEGER NOT NULL DEFAULT 0");
  }
  // Agents created before 28 October 2026: what an approval card shows of a Company's terms (Ops 5).
  if (!sql.exec("PRAGMA table_info(poppy_approvals)").toArray().some((column) => column.name === "terms")) {
    sql.exec("ALTER TABLE poppy_approvals ADD COLUMN terms TEXT");
  }
  // The Company's terms card that continues an approved request, so both show its eventual outcome.
  if (!sql.exec("PRAGMA table_info(poppy_approvals)").toArray().some((column) => column.name === "terms_approval_id")) {
    sql.exec("ALTER TABLE poppy_approvals ADD COLUMN terms_approval_id TEXT");
  }
  retireIncompatibleSignIns(sql);
  retireOperationCards(sql);
  migrateConversationIdentity(sql);
  // After the tables its triggers watch.
  migrateProtocolLog(sql);
}

/** Pending credentials must not keep every new task in an incompatible recovery loop. */
function retireIncompatibleSignIns(sql: Sql): void {
  const pending = sql.exec(`SELECT s.id, s.issuer, c.company FROM poppy_signins s
    LEFT JOIN poppy_task_contexts c ON c.kind = 'signin' AND c.task_id = s.id AND c.issuer = s.issuer
    WHERE s.status NOT IN ('done', 'failed', 'expired')`).toArray();
  for (const row of pending) {
    let company: Record<string, unknown> = {};
    if (typeof row.company === "string") {
      try {
        const parsed: unknown = JSON.parse(row.company);
        if (isObject(parsed)) company = parsed;
      } catch { /* No trustworthy context to resume. */ }
    }
    const version = company.protocolVersion;
    // All current sign-ins store this immutable context before their row. Missing contexts are legacy or unreadable.
    if (typeof version === "string" && supportsProtocol(version) &&
        (company.specificationRevision === undefined || company.specificationRevision === protocolRevision(version))) continue;
    const card = {
      id: `signin-${row.id}`,
      kind: "notice",
      company: typeof company.name === "string" ? company.name : String(row.issuer),
      ...(typeof company.domain === "string" ? { domain: company.domain } : {}),
      open: false,
      text: "This unfinished sign-in could not be resumed after the protocol update. No credentials were resent. Start a new sign-in if the task still needs your account."
    };
    // Put the explanation first: an interrupted migration can repeat it before making the row terminal.
    sql.exec("INSERT OR REPLACE INTO poppy_cards (id, card, open, updated_at) VALUES (?, ?, 0, ?)", card.id, JSON.stringify(card), Date.now());
    // Retain any sealed answer for reconciliation; never decrypt, replay or expose it during migration.
    sql.exec("UPDATE poppy_signins SET status = 'failed' WHERE id = ?", row.id);
  }
}

/** Operations 1 cards outlive their removed tables; turn them into visible, dismissible history. */
function retireOperationCards(sql: Sql): void {
  for (const row of sql.exec("SELECT id, card, open, updated_at FROM poppy_cards WHERE json_valid(card) AND json_extract(card, '$.kind') = 'operation'").toArray()) {
    const previous: unknown = JSON.parse(String(row.card));
    if (!isObject(previous)) continue;
    const card = {
      id: String(row.id),
      kind: "notice",
      company: typeof previous.company === "string" ? previous.company : "",
      ...(typeof previous.domain === "string" ? { domain: previous.domain } : {}),
      open: false,
      text: "This Operations 1 request was retired locally after the protocol update. This update did not cancel or confirm anything at the Company. Check its outcome there before starting it again."
    };
    // Do not bring every historical receipt back into the last-hour card list.
    sql.exec("UPDATE poppy_cards SET card = ?, open = 0, updated_at = ? WHERE id = ?", JSON.stringify(card), row.open ? Date.now() : row.updated_at, row.id);
  }
}

/** Old inboxes lack their source issuer, so a collision cannot be untangled safely. */
function migrateConversationIdentity(sql: Sql): void {
  const columns = sql.exec("PRAGMA table_info(poppy_conversations)").toArray();
  if (!columns.some((column) => column.name === "remote_id")) {
    // Persist the intent first: every later step is safe to repeat after a crash.
    sql.exec("INSERT OR REPLACE INTO poppy_conversation_migration (slot, state) VALUES (1, 'pending')");
    sql.exec("ALTER TABLE poppy_conversations ADD COLUMN remote_id TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((column) => column.name === "quarantined")) {
    sql.exec("ALTER TABLE poppy_conversations ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0");
  }
  const pending = sql.exec("SELECT state FROM poppy_conversation_migration WHERE slot = 1").toArray()[0]?.state === "pending";
  if (pending) {
    const at = Date.now();
    for (const [kind, source, key] of [["conversation", "poppy_conversations", "id"], ["inbox", "poppy_inbox", "seq"], ["event", "poppy_events", null], ["message", "poppy_messages", "id"], ["card", "poppy_cards WHERE json_extract(card, '$.conversationId') IS NOT NULL", "id"]] as const) {
      for (const row of sql.exec(`SELECT * FROM ${source}`)) {
        const sourceId = key ? String(row[key]) : JSON.stringify([row.conversation_id, row.event_id]);
        sql.exec("INSERT OR IGNORE INTO poppy_conversation_quarantine (kind, source_id, payload, quarantined_at) VALUES (?, ?, ?, ?)", kind, sourceId, JSON.stringify(row), at);
      }
    }
    sql.exec("UPDATE poppy_conversations SET remote_id = id, quarantined = 1, status = 'closed', cursor = NULL, context = NULL");
    sql.exec("DELETE FROM poppy_inbox");
    sql.exec("DELETE FROM poppy_events");
    sql.exec("UPDATE poppy_messages SET conversation_id = NULL WHERE conversation_id IS NOT NULL");
    sql.exec("DELETE FROM poppy_cards WHERE json_extract(card, '$.conversationId') IS NOT NULL");
    if (sql.exec("SELECT 1 FROM poppy_conversations LIMIT 1").toArray().length) {
      const card = { id: "conversation-isolation-update", kind: "notice", company: "", open: true, text: "Earlier Company conversation records had uncertain company attribution and were quarantined during a security update. Those conversations were stopped locally; this did not cancel them at the Companies. Ask your agent to start a new conversation. No messages were resent." };
      sql.exec("INSERT OR REPLACE INTO poppy_cards (id, card, open, updated_at) VALUES (?, ?, 1, ?)", card.id, JSON.stringify(card), at);
    }
    sql.exec("UPDATE poppy_conversation_migration SET state = 'done' WHERE slot = 1");
  }
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS poppy_conversation_remote ON poppy_conversations (issuer, remote_id) WHERE quarantined = 0");
}

// ---------------------------------------------------------------- Rows

/** Each table's columns as `SCHEMA` declares them, so a row read back is decoded, not cast (src/rows.ts). */
const issuerColumn = textOf(issuerDecoder);

export const taskContextsTable = table("poppy_task_contexts", { kind: text, task_id: text, issuer: issuerColumn, company: text });
export const domainsTable = table("poppy_domains", { domain: text, issuer: nullable(issuerColumn), company: text, expires_at: integer });
export const userIdsTable = table("poppy_user_ids", { issuer: issuerColumn, user_id: text });
export const sessionsTable = table("poppy_sessions", {
  issuer: issuerColumn,
  label: text,
  session_id: text,
  account: nullable(text),
  signed_in: integerOf(flag),
  scope: text,
  updated_at: integer,
  /** 0.3: the account the Session was used with, kept after it continues signed out (5.4, 5.5); null before 0.3. */
  used_account: nullable(text),
  /** Local authorization epoch, independent of the Session's protocol identity. */
  authority_generation: integer
});
export const accountsTable = table("poppy_accounts", {
  issuer: issuerColumn,
  account: text,
  token: text,
  scope: text,
  expires_at: nullable(integer),
  updated_at: integer
});
/**
 * Refresh tokens to revoke (spec 4.6): the User's sign-outs, and the
 * tokens a step-up replaced. While the Company hasn't accepted the
 * revocation, `token` holds the refresh token, still sealed as it was in
 * `poppy_accounts`, so it can be sent again; once it has, or the token has
 * expired, `token` is null and the row is only a record for Activity.
 */
export const signOutsTable = table("poppy_signouts", {
  id: text,
  issuer: issuerColumn,
  account: text,
  /** `sign_out`: the User signed out of the account. `step_up`: a sign-in for more scopes replaced this token, and the account stays signed in with the new one. */
  reason: textOf(literal("sign_out", "step_up")),
  token: nullable(text),
  scope: text,
  expires_at: nullable(integer),
  /** `pending`: the agent tries again at `next_at`. `stopped`: it has stopped trying. `revoked`, `expired`: done. */
  status: textOf(literal("pending", "stopped", "revoked", "expired")),
  attempts: integer,
  /** The code the Company last answered, or ours when no answer came. */
  last_error: nullable(text),
  next_at: nullable(integer),
  created_at: integer,
  updated_at: integer
});
export const signInsTable = table("poppy_signins", {
  id: text,
  type: textOf(literal("direct", "device", "mediated")),
  issuer: issuerColumn,
  label: text,
  account: text,
  scopes: text,
  state_hash: nullable(text),
  secret: text,
  interval_seconds: nullable(integer),
  expires_at: integer,
  status: text,
  created_at: integer
});
export const conversationsTable = table("poppy_conversations", {
  id: text,
  issuer: issuerColumn,
  remote_id: text,
  quarantined: integerOf(flag),
  label: text,
  parent: nullable(text),
  direct: integer,
  status: text,
  responder: text,
  cursor: nullable(text),
  context: nullable(text),
  last_event_at: integer,
  created_at: integer
});
export const conversationQuarantineTable = table("poppy_conversation_quarantine", { kind: text, source_id: text, payload: text, quarantined_at: integer });
export const conversationMigrationTable = table("poppy_conversation_migration", { slot: integer, state: textOf(literal("pending", "done")) });
export const eventsTable = table("poppy_events", { conversation_id: text, event_id: text });
export const inboxTable = table("poppy_inbox", { seq: integer, conversation_id: text, event: text, created_at: integer });
export const messagesTable = table("poppy_messages", { id: text, issuer: issuerColumn, conversation_id: nullable(text), body: text, created_at: integer });
export const approvalsTable = table("poppy_approvals", {
  id: text,
  issuer: issuerColumn,
  label: text,
  summary: text,
  request: text,
  status: text,
  result: nullable(text),
  created_at: integer,
  terms: nullable(textOf(jsonText(approvalTermsDecoder))),
  terms_approval_id: nullable(text)
});
export const approvalBatchesTable = table("poppy_approval_batches", { id: text, ids: text, told: integer, created_at: integer });
export const intentsTable = table("poppy_intents", { call_key: text, value: text, created_at: integer });
export const cardsTable = table("poppy_cards", { card: text, id: text, open: integer, updated_at: integer });

/** The format of everything `Sealer.seal` writes: `v1.<base64url(iv | ciphertext)>`. */
const SEALED_PREFIX = "v1.";

function importKey(name: string, encoded: string | undefined): Promise<CryptoKey> | null {
  const value = encoded?.trim();
  if (!value) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    throw new ConfigError(`${name} must be base64`);
  }
  if (raw.byteLength !== 32) throw new ConfigError(`${name} must be 32 bytes, base64`);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encryption at rest for refresh tokens, pending sign-in secrets and model
 * keys: AES-GCM under `TOKEN_ENC_KEY`, with additional data binding each
 * value to where it belongs, so a ciphertext copied to another row fails to
 * decrypt.
 *
 * Values are written as `v1.<base64url>`. For rotation, the old key goes in
 * `TOKEN_ENC_KEY_PREVIOUS`: values it sealed still open, and `openChecked`
 * says so, so their owner can seal them again under the new key. Values
 * written before the prefix existed (no `v1.`) still open, and count as stale.
 */
export class Sealer {
  readonly #key: Promise<CryptoKey>;
  readonly #previous: Promise<CryptoKey> | null;

  constructor(env: { readonly TOKEN_ENC_KEY?: string; readonly TOKEN_ENC_KEY_PREVIOUS?: string }) {
    const key = importKey("TOKEN_ENC_KEY", env.TOKEN_ENC_KEY);
    if (!key) throw new ConfigError("Missing required setting TOKEN_ENC_KEY");
    this.#key = key;
    this.#previous = importKey("TOKEN_ENC_KEY_PREVIOUS", env.TOKEN_ENC_KEY_PREVIOUS);
  }

  async seal(plaintext: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
      await this.#key,
      new TextEncoder().encode(plaintext)
    );
    const out = new Uint8Array(12 + sealed.byteLength);
    out.set(iv);
    out.set(new Uint8Array(sealed), 12);
    return SEALED_PREFIX + base64url(out);
  }

  /** The plaintext; throws if the value was sealed for another context or under neither key. */
  async open(sealed: string, context: string): Promise<string> {
    return (await this.openChecked(sealed, context)).plaintext;
  }

  /**
   * The plaintext, and whether the value is current: sealed under
   * `TOKEN_ENC_KEY` in the `v1.` format. A stale value should be sealed again.
   */
  async openChecked(sealed: string, context: string): Promise<{ plaintext: string; current: boolean }> {
    const versioned = sealed.startsWith(SEALED_PREFIX);
    const body = versioned ? sealed.slice(SEALED_PREFIX.length) : sealed;
    const bytes = fromBase64url(body);
    const decrypt = async (key: Promise<CryptoKey>) =>
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(context) },
          await key,
          bytes.slice(12)
        )
      );
    try {
      return { plaintext: await decrypt(this.#key), current: versioned };
    } catch (error) {
      if (!this.#previous) throw error;
      return { plaintext: await decrypt(this.#previous), current: false };
    }
  }
}

/**
 * A value fixed for one tool call, created on its first run and returned
 * unchanged if Pi replays the call after a crash: message ids, idempotency
 * keys. This is what makes those tools `replay: "safe"`.
 */
export function intent(sql: Sql, callKey: string, create: () => string): string {
  const existing = one(sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", callKey);
  if (existing) return existing.value;
  const value = create();
  sql.exec(
    "INSERT INTO poppy_intents (call_key, value, created_at) VALUES (?, ?, ?)",
    callKey,
    value,
    Date.now()
  );
  return value;
}

/**
 * True the first time it is asked for `callKey`, false ever after, including
 * when Pi replays the call after a crash: for a write that has no
 * idempotency key, so a replay can't send it twice.
 */
export function firstTime(sql: Sql, callKey: string): boolean {
  const mine = crypto.randomUUID();
  return intent(sql, callKey, () => mine) === mine;
}
