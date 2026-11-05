import type { BrowserIdentity } from "./session";
import { SESSION_TTL_SECONDS } from "./session";

/** Minimal deletion state survives erasure without retaining a person's profile or credentials. */
export class AgentData {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS agent_data_state (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), deleting INTEGER NOT NULL DEFAULT 0,
      deleted_before INTEGER NOT NULL DEFAULT 0, receipt TEXT
    )`);
    storage.sql.exec("INSERT OR IGNORE INTO agent_data_state (slot) VALUES (1)");
  }

  get deleting(): boolean { return this.storage.sql.exec("SELECT deleting FROM agent_data_state WHERE slot = 1").one().deleting === 1; }

  admits(identity: BrowserIdentity, allowDeleting = false): boolean {
    const state = this.storage.sql.exec("SELECT deleting, deleted_before FROM agent_data_state WHERE slot = 1").one();
    const issuedAt = identity.sessionCreatedAt ?? identity.sessionExpiresAt - SESSION_TTL_SECONDS * 1000;
    return (allowDeleting || state.deleting === 0) && issuedAt > Number(state.deleted_before);
  }

  begin(): void {
    this.storage.sql.exec("UPDATE agent_data_state SET deleting = 1 WHERE slot = 1");
  }

  cancel(): void { this.storage.sql.exec("UPDATE agent_data_state SET deleting = 0 WHERE slot = 1"); }

  completed(receipt: string): boolean {
    return this.storage.sql.exec("SELECT receipt FROM agent_data_state WHERE slot = 1").one().receipt === receipt;
  }

  async erase(receipt: string): Promise<void> {
    const deletedBefore = Date.now();
    // Never deleteAll() then recreate the cutoff: a crash between those writes would readmit old cookies.
    // Application SQL and KV records disappear in the same transaction that preserves the receipt.
    this.storage.transactionSync(() => {
      const tables = this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map(row => String(row.name)).filter(name => applicationTable(name) && name !== "agent_data_state");
      for (const name of tables) this.storage.sql.exec(`DROP TABLE ${quote(name)}`);
      for (const [key] of [...this.storage.kv.list()]) this.storage.kv.delete(key);
      // New cookies carry millisecond issuance. Legacy signed cookies infer issuance from their fixed TTL.
      this.storage.sql.exec("UPDATE agent_data_state SET deleting = 0, deleted_before = ?, receipt = ? WHERE slot = 1", deletedBefore, receipt);
    });
    await this.storage.deleteAlarm();
    await this.storage.sync();
  }
}

const OMIT_TABLES = new Set(["model_keys", "browser_sessions", "agent_data_state"]);
const OMIT_COLUMNS = new Set(["token", "secret", "sealed", "state_hash", "auth"]);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const applicationTable = (name: string) => !name.startsWith("sqlite_") && !name.startsWith("_cf") && !name.startsWith("__cf");
const encoder = new TextEncoder();

function portable(row: Record<string, SqlStorageValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (OMIT_COLUMNS.has(key)) return [key, { omitted: "credential" }];
    if (value instanceof ArrayBuffer) {
      let binary = "";
      for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
      return [key, { encoding: "base64", data: btoa(binary) }];
    }
    return [key, value];
  }));
}

/** Streams personal records and photo chunks; a 100 MiB photo collection is never buffered as one response. */
export function exportAgentData(sql: SqlStorage, now = Date.now()): ReadableStream<Uint8Array> {
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray()
    .map(row => String(row.name)).filter(name => applicationTable(name) && !OMIT_TABLES.has(name));
  function* chunks(): Generator<string> {
    yield JSON.stringify({ format: "pda-personal-data", version: 1, exportedAt: new Date(now).toISOString(),
      note: "This export contains personal data. Stored credentials and browser sessions are omitted. Records are read while the export streams; concurrent activity may change them. Photos are base64 chunks ordered by id, part and seq." }).slice(0, -1) + ',"tables":{';
    for (let index = 0; index < tables.length; index++) {
      const name = tables[index]!;
      yield `${index ? "," : ""}${JSON.stringify(name)}:[`;
      let first = true;
      const ordered = name === "attachment_chunks" ? " ORDER BY id, part, seq" : "";
      for (const row of sql.exec(`SELECT * FROM ${quote(name)}${ordered}`)) {
        yield `${first ? "" : ","}${JSON.stringify(portable(row))}`;
        first = false;
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
