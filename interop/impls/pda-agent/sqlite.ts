/**
 * The part of the Durable Object `SqlStorage` API that src/poppy uses
 * (`exec(query, ...bindings)` and its cursor's `toArray`, `one` and
 * iteration), over Node's built-in SQLite. Both are SQLite, so the queries
 * run unchanged.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

function binding(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

class Cursor<T> implements Iterable<T> {
  readonly #rows: T[];
  #next = 0;
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;

  constructor(rows: T[], changes: number) {
    this.#rows = rows;
    this.columnNames = rows[0] ? Object.keys(rows[0] as object) : [];
    this.rowsRead = rows.length;
    this.rowsWritten = changes;
  }

  toArray(): T[] {
    const rest = this.#rows.slice(this.#next);
    this.#next = this.#rows.length;
    return rest;
  }

  one(): T {
    if (this.#rows.length !== 1) throw new Error(`Expected exactly one row, got ${this.#rows.length}`);
    return this.#rows[0]!;
  }

  next(): IteratorResult<T> {
    return this.#next < this.#rows.length ? { done: false, value: this.#rows[this.#next++]! } : { done: true, value: undefined };
  }

  raw(): IterableIterator<unknown[]> {
    return this.toArray().map((row) => Object.values(row as object))[Symbol.iterator]();
  }

  [Symbol.iterator](): Iterator<T> {
    return this;
  }
}

/** A fresh in-memory database behind the `SqlStorage` interface. */
export function memorySql(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  const storage = {
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      const params = bindings.map(binding);
      // `all` runs any statement; for one that returns no rows it is [].
      const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
      const rows = statement.all(...params) as Record<string, unknown>[];
      const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
      return new Cursor(rows.map((row) => ({ ...row })), after - before);
    },
    get databaseSize() {
      return 0;
    }
  };
  return storage as unknown as SqlStorage;
}
