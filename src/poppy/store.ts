import { ConfigError } from "../config";
import { base64url, fromBase64url } from "../base64url";
import { migrateProtocolLog } from "./protocol-log";
import { flag, literal } from "../decode";
import { integer, integerOf, nullable, one, table, text, textOf } from "../rows";
import { issuerDecoder } from "./issuer";
import { storedOperation } from "./operation-value";

/**
 * Poppy state in the person's SQLite, beside Pi's `pi_*` tables. Session
 * Tokens and DPoP keys are deliberately absent: they live only in memory.
 */
const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS poppy_operations (
  issuer TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  label TEXT NOT NULL,
  account TEXT,
  operation TEXT NOT NULL,
  previous_summary TEXT,
  approved_revision INTEGER,
  approved_by TEXT,
  permission_id TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  altered_summary TEXT,
  PRIMARY KEY (issuer, operation_id)
);
CREATE TABLE IF NOT EXISTS poppy_proposals (
  issuer TEXT NOT NULL,
  request TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY (issuer, request)
);
CREATE TABLE IF NOT EXISTS poppy_permissions (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  account TEXT NOT NULL,
  action TEXT NOT NULL,
  max_amount TEXT,
  currency TEXT,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
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
CREATE INDEX IF NOT EXISTS poppy_operations_updated ON poppy_operations (updated_at);
CREATE INDEX IF NOT EXISTS poppy_operations_state ON poppy_operations (json_extract(operation, '$.state'));
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
  // Agents created before 13 October 2026: add the column in place.
  if (!sql.exec("PRAGMA table_info(poppy_operations)").toArray().some((column) => column.name === "altered_summary")) {
    sql.exec("ALTER TABLE poppy_operations ADD COLUMN altered_summary TEXT");
  }
  // After the tables its triggers watch.
  migrateProtocolLog(sql);
}

// ---------------------------------------------------------------- Rows

/** Each table's columns as `SCHEMA` declares them, so a row read back is decoded, not cast (src/rows.ts). */
const issuerColumn = textOf(issuerDecoder);

export const domainsTable = table("poppy_domains", { domain: text, issuer: nullable(issuerColumn), company: text, expires_at: integer });
export const userIdsTable = table("poppy_user_ids", { issuer: issuerColumn, user_id: text });
export const sessionsTable = table("poppy_sessions", {
  issuer: issuerColumn,
  label: text,
  session_id: text,
  account: nullable(text),
  signed_in: integerOf(flag),
  scope: text,
  updated_at: integer
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
 * Sign-outs (spec 4.9). While the Company hasn't accepted the revocation,
 * `token` holds the Account Token, still sealed as it was in
 * `poppy_accounts`, so it can be sent again; once it has, or the token has
 * expired, `token` is null and the row is only a record for Activity.
 */
export const signOutsTable = table("poppy_signouts", {
  id: text,
  issuer: issuerColumn,
  account: text,
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
export const eventsTable = table("poppy_events", { conversation_id: text, event_id: text });
export const inboxTable = table("poppy_inbox", { seq: integer, conversation_id: text, event: text, created_at: integer });
export const messagesTable = table("poppy_messages", { id: text, issuer: issuerColumn, conversation_id: nullable(text), body: text, created_at: integer });
export const operationsTable = table("poppy_operations", {
  issuer: issuerColumn,
  operation_id: text,
  label: text,
  account: nullable(text),
  operation: textOf(storedOperation),
  previous_summary: nullable(text),
  approved_revision: nullable(integer),
  approved_by: nullable(textOf(literal("user", "standing_permission"))),
  permission_id: nullable(text),
  confirmed: integer,
  updated_at: integer,
  /** Set when the Company changed a revision's terms in place (Ops 3.1 forbids it): what it then said. */
  altered_summary: nullable(text)
});
export const proposalsTable = table("poppy_proposals", { issuer: issuerColumn, request: text, operation_id: text });
export const permissionsTable = table("poppy_permissions", {
  id: text,
  issuer: issuerColumn,
  account: text,
  action: text,
  max_amount: nullable(text),
  currency: nullable(text),
  max_uses: nullable(integer),
  uses: integer,
  reserved: integer,
  expires_at: nullable(integer),
  created_at: integer
});
export const approvalsTable = table("poppy_approvals", {
  id: text,
  issuer: issuerColumn,
  label: text,
  summary: text,
  request: text,
  status: text,
  result: nullable(text),
  created_at: integer
});
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
 * Encryption at rest for Account Tokens, pending sign-in secrets and model
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
