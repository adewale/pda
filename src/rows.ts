import { DecodeError, integer as wholeNumber, object, string, type Decoded, type Decoder, type ObjectOf } from "./decode";

/**
 * Rows read back from the agent's SQLite, decoded rather than cast. Each table
 * declares its columns once (`table`), each column its SQLite type, whether
 * it may be NULL, and the decoder its values pass through, so a row that
 * doesn't match its table's declaration throws a `DecodeError` naming the
 * column instead of flowing on as the wrong type. `test/rows.test.ts` checks
 * every declaration against the migrated schema.
 */

type SqlType = "TEXT" | "INTEGER";

/** A column's decoder, with what it says about the schema. */
export type Column<T> = Decoder<T> & { readonly sqlType: SqlType; readonly nullable: boolean };

function column<T>(sqlType: SqlType, decoder: Decoder<T>, nullable = false): Column<T> {
  return Object.assign((value: unknown, at: string) => decoder(value, at), { sqlType, nullable });
}

export const text: Column<string> = column("TEXT", string);
export const integer: Column<number> = column("INTEGER", wholeNumber);

/** A TEXT column whose values pass `decoder` (an issuer, say). */
export function textOf<T>(decoder: Decoder<T>): Column<T> {
  return column("TEXT", decoder);
}

/** An INTEGER column whose values pass `decoder` (a 0 or 1 flag, say). */
export function integerOf<T>(decoder: Decoder<T>): Column<T> {
  return column("INTEGER", decoder);
}

/** A column that may be NULL. */
export function nullable<T>(of: Column<T>): Column<T | null> {
  return column(of.sqlType, (value, at) => (value === null ? null : of(value, at)), true);
}

type Columns = Record<string, Column<unknown>>;

export type Table<C extends Columns> = {
  readonly name: string;
  readonly columns: C;
  /** Every column: for `SELECT *` or a query that names them all. */
  readonly row: Decoder<ObjectOf<C>>;
  /** Some columns, for a query that selects only those. */
  pick<K extends keyof C & string>(...names: K[]): Decoder<ObjectOf<Pick<C, K>>>;
};

/** Every table declared, for the check against the schema. */
export const TABLES: Table<Columns>[] = [];

export function table<C extends Columns>(name: string, columns: C): Table<C> {
  const declared: Table<C> = {
    name,
    columns,
    row: object(columns),
    pick: (...names) => object(Object.fromEntries(names.map((key) => [key, columns[key]!])) as Pick<C, (typeof names)[number]>)
  };
  TABLES.push(declared as unknown as Table<Columns>); // Widened only to be listed; nothing reads a row through this entry.
  return declared;
}

/** A row type, from its table or a pick of it. */
export type RowOf<D> = Decoded<D>;

/** Where a row came from, for a decoding error: the table the query reads. */
function source(query: string): string {
  return `${/\bFROM\s+(\w+)/i.exec(query)?.[1] ?? "query"} row`;
}

/** The rows of a query, each decoded. */
export function rows<T>(sql: SqlStorage, decoder: Decoder<T>, query: string, ...bindings: unknown[]): T[] {
  return sql
    .exec(query, ...bindings)
    .toArray()
    .map((row, index) => {
      try {
        return decoder(row, source(query));
      } catch (error) {
        if (error instanceof DecodeError) throw new DecodeError(`${error.message} (row ${index} of: ${query.replace(/\s+/g, " ").slice(0, 120)})`);
        throw error;
      }
    });
}

/** The first row of a query, decoded, or undefined. */
export function one<T>(sql: SqlStorage, decoder: Decoder<T>, query: string, ...bindings: unknown[]): T | undefined {
  return rows(sql, decoder, query, ...bindings)[0];
}

/** A row that only says something exists (`SELECT 1 AS found …`). */
export const found = object({ found: integer });
