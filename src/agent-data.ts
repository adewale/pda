import type { BrowserIdentity } from "./session";
import { SESSION_TTL_SECONDS } from "./session";
import { isApplicationTable, quote } from "./agent-data-export";
import { array, jsonText, object, string } from "./decode";
import { integer, nullable, one, rows, table, text, textOf } from "./rows";

const stateTable = table("agent_data_state", {
  slot: integer, deleting: integer, deleted_before: integer, receipt: nullable(text),
  request_receipts: text, revocation_waivers: textOf(jsonText(array(string)))
});

const joined = object({ value: string });

/** Minimal deletion state survives erasure without retaining a person's profile or credentials. */
export class AgentData {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS agent_data_state (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), deleting INTEGER NOT NULL DEFAULT 0,
      deleted_before INTEGER NOT NULL DEFAULT 0, receipt TEXT,
      request_receipts TEXT NOT NULL DEFAULT '[]',
      revocation_waivers TEXT NOT NULL DEFAULT '[]'
    )`);
    const stored = storage.sql.exec("PRAGMA table_info(agent_data_state)").toArray().map(row => row.name);
    for (const name of ["request_receipts", "revocation_waivers"]) {
      if (!stored.includes(name)) storage.sql.exec(`ALTER TABLE agent_data_state ADD COLUMN ${name} TEXT NOT NULL DEFAULT '[]'`);
    }
    storage.sql.exec("INSERT OR IGNORE INTO agent_data_state (slot) VALUES (1)");
  }

  #state<K extends keyof typeof stateTable.columns>(...names: K[]) {
    const state = one(this.storage.sql, stateTable.pick(...names), `SELECT ${names.join(", ")} FROM agent_data_state WHERE slot = 1`);
    if (!state) throw new Error("Agent data state is missing");
    return state;
  }

  get deleting(): boolean { return this.#state("deleting").deleting === 1; }

  admits(identity: BrowserIdentity, allowDeleting = false): boolean {
    const state = this.#state("deleting", "deleted_before");
    const issuedAt = identity.sessionCreatedAt ?? identity.sessionExpiresAt - SESSION_TTL_SECONDS * 1000;
    return (allowDeleting || state.deleting === 0) && issuedAt > state.deleted_before;
  }

  /** The first caller's waivers stand: a joining caller or a retry after a crash cannot change them. */
  begin(receipt?: string, waivers: readonly string[] = []): void {
    if (!this.deleting) {
      this.storage.sql.exec("UPDATE agent_data_state SET deleting = 1, receipt = NULL, request_receipts = '[]', revocation_waivers = ? WHERE slot = 1", JSON.stringify(waivers));
    }
    if (receipt) this.join(receipt);
  }

  /** The unrevoked credentials the person agreed to abandon, each one by its own id. */
  get waivers(): ReadonlySet<string> {
    return new Set(this.#state("revocation_waivers").revocation_waivers);
  }

  /** Every concurrent HTTP caller can verify the one erasure it joined after the object resets. */
  join(receipt: string): void {
    this.storage.sql.exec(`UPDATE agent_data_state SET request_receipts = json_insert(request_receipts, '$[#]', ?)
      WHERE slot = 1 AND deleting = 1 AND NOT EXISTS (SELECT 1 FROM json_each(request_receipts) WHERE value = ?)`, receipt, receipt);
  }

  cancel(): void { this.storage.sql.exec("UPDATE agent_data_state SET deleting = 0, request_receipts = '[]', revocation_waivers = '[]' WHERE slot = 1"); }

  completed(receipt: string): boolean {
    const { receipt: erased } = this.#state("receipt");
    if (erased === null) return false;
    return erased === receipt || rows(this.storage.sql, joined, "SELECT value FROM agent_data_state, json_each(request_receipts) WHERE slot = 1 AND value = ?", receipt).length > 0;
  }

  async erase(receipt: string): Promise<void> {
    const deletedBefore = Date.now();
    // Never deleteAll() then recreate the cutoff: a crash between those writes would readmit old cookies.
    // Application SQL and KV records disappear in the same transaction that preserves the receipt.
    this.storage.transactionSync(() => {
      const tables = this.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map(row => String(row.name)).filter(name => isApplicationTable(name) && name !== "agent_data_state");
      for (const name of tables) this.storage.sql.exec(`DROP TABLE ${quote(name)}`);
      for (const [key] of [...this.storage.kv.list()]) this.storage.kv.delete(key);
      // New cookies carry millisecond issuance. Legacy signed cookies infer issuance from their fixed TTL.
      this.storage.sql.exec("UPDATE agent_data_state SET deleting = 0, deleted_before = ?, receipt = ?, revocation_waivers = '[]' WHERE slot = 1", deletedBefore, receipt);
    });
    await this.storage.deleteAlarm();
    await this.storage.sync();
  }
}
