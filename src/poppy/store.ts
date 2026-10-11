import { ConfigError } from "../config";
import { base64url } from "./jwt";

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
CREATE TABLE IF NOT EXISTS poppy_idempotency (
  request_hash TEXT PRIMARY KEY,
  key TEXT NOT NULL,
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
  PRIMARY KEY (issuer, operation_id)
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
`;

export type Sql = SqlStorage;

export function migrate(sql: Sql): void {
  for (const statement of SCHEMA.split(";")) {
    if (statement.trim()) sql.exec(statement);
  }
}

/** Rows of a query as plain objects. */
export function rows<T>(sql: Sql, query: string, ...bindings: unknown[]): T[] {
  return sql.exec(query, ...bindings).toArray() as unknown as T[];
}

export function one<T>(sql: Sql, query: string, ...bindings: unknown[]): T | undefined {
  return rows<T>(sql, query, ...bindings)[0];
}

/**
 * Encryption at rest for Account Tokens and pending sign-in secrets: AES-GCM
 * under `TOKEN_ENC_KEY`, with additional data binding each value to where it
 * belongs, so a ciphertext copied to another row fails to decrypt.
 */
export class Sealer {
  readonly #key: Promise<CryptoKey>;

  constructor(env: { readonly TOKEN_ENC_KEY?: string }) {
    const encoded = env.TOKEN_ENC_KEY?.trim();
    if (!encoded) throw new ConfigError("Missing required setting TOKEN_ENC_KEY");
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    } catch {
      throw new ConfigError("TOKEN_ENC_KEY must be base64");
    }
    if (raw.byteLength !== 32) throw new ConfigError("TOKEN_ENC_KEY must be 32 bytes, base64");
    this.#key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
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
    return base64url(out);
  }

  async open(sealed: string, context: string): Promise<string> {
    const padded = sealed.replace(/-/g, "+").replace(/_/g, "/");
    const bytes: Uint8Array<ArrayBuffer> = Uint8Array.from(
      atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
      (char) => char.charCodeAt(0)
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(context) },
      await this.#key,
      bytes.slice(12)
    );
    return new TextDecoder().decode(plain);
  }
}

/**
 * A value fixed for one tool call, created on its first run and returned
 * unchanged if Pi replays the call after a crash: message ids, idempotency
 * keys. This is what makes those tools `replay: "safe"`.
 */
export function intent(sql: Sql, callKey: string, create: () => string): string {
  const existing = one<{ value: string }>(sql, "SELECT value FROM poppy_intents WHERE call_key = ?", callKey);
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
