import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DecodeError } from "../src/decode";
import { rows, TABLES } from "../src/rows";
// Importing the modules that declare tables fills TABLES.
import "../src/poppy/store";
import "../src/poppy/protocol-log";
import "../src/tools/memory-store";
import "../src/tools/turn-authority";
import "../src/tools/schedule-store";
import "../src/web-push";
import { RenderLimiter } from "../src/tools/render";
import { agent, company, signInDirect, tool } from "./agent-helpers";

/**
 * Rows are decoded, not cast (src/rows.ts). Every table's declaration is
 * checked against the schema a fresh agent migrates, and after a journey
 * that writes every Poppy table, every row it holds decodes, through each
 * table's own decoder and through the queries that read them for the page.
 */

type Info = { name: string; type: string; notnull: number; pk: number };

describe("decoded rows", () => {
  it("declares every table it reads, each column as the migrated schema has it", async () => {
    const a = await agent();
    await a.stub.poppyActivity(); // Migrates the Poppy tables; the agent made the rest when it started, but for one.
    const schema = await runInDurableObject(a.stub, (_, state) => {
      new RenderLimiter(state.storage.sql, () => Date.now());
      const sql = state.storage.sql;
      const names = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => String(row.name));
      return Object.fromEntries(names.map((name) => [name, sql.exec(`PRAGMA table_info("${name}")`).toArray() as unknown as Info[]]));
    });
    const declared = new Map(TABLES.map((table) => [table.name, table]));
    expect(Object.keys(schema).filter((name) => name.startsWith("poppy_") && !declared.has(name)), "Poppy tables with no declaration").toEqual([]);
    for (const table of TABLES) {
      const columns = schema[table.name] ?? [];
      expect(columns.length, `${table.name} is in the schema`).toBeGreaterThan(0);
      const byName = new Map(columns.map((column) => [column.name, column]));
      expect(columns.map((column) => column.name).filter((name) => !(name in table.columns)), `${table.name}: columns not declared`).toEqual([]);
      for (const [name, column] of Object.entries(table.columns)) {
        const found = byName.get(name);
        expect(found, `${table.name}.${name} is in the schema`).toBeDefined();
        expect(found!.type, `${table.name}.${name}'s type`).toBe(column.sqlType);
        // A column the schema lets be NULL must be declared nullable. A primary key is taken as never NULL: an
        // INTEGER one can't be, and SQLite's leniency for a TEXT one is a quirk our code never relies on.
        const schemaNullable = found!.notnull === 0 && found!.pk === 0;
        expect(column.nullable, `${table.name}.${name} nullable`).toBe(schemaNullable);
      }
    }
  });

  it("decodes every row a journey writes, and refuses one that doesn't match its table", async () => {
    const c = await company({ operations: false });
    const shop = await company();
    const a = await agent();
    await signInDirect(a, c);
    await signInDirect(a, shop);
    await tool(a, "poppy_message", { domain: c.domain, text: "hello" });
    const write = { operation: "exchangeItem", params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } };
    await tool(a, "poppy_api_call", { domain: c.domain, ...write });
    await tool(a, "poppy_api_call", { domain: shop.domain, ...write });
    await a.stub.poppyFrame({ type: "poppy.permission.add", issuer: shop.hosts.issuer, account: "default", action: "exchange", maxAmount: "100", currency: "USD", maxUses: 1 });
    // The queries the page's views run, aggregates and json_extract included.
    await a.stub.poppyActivity();
    await a.stub.poppyProtocolIndex();
    await a.stub.poppyProtocol(shop.hosts.issuer);

    let decoded = 0;
    const present = new Set((JSON.parse(await a.stub.poppySql("SELECT name FROM sqlite_master WHERE type = 'table'")) as { name: string }[]).map((row) => row.name));
    for (const table of TABLES.filter((declared) => present.has(declared.name))) {
      const stored = JSON.parse(await a.stub.poppySql(`SELECT * FROM "${table.name}"`)) as unknown[];
      for (const row of stored) table.row(row, `${table.name} row`);
      decoded += stored.length;
      if (["poppy_sessions", "poppy_conversations", "poppy_operations", "poppy_approvals", "poppy_permissions", "poppy_protocol_log"].includes(table.name)) {
        expect(stored.length, `${table.name} has rows`).toBeGreaterThan(0);
      }
    }
    expect(decoded).toBeGreaterThan(0);

    // A row that doesn't match is a clear error, naming the column, not a value of the wrong type.
    const fake = { exec: () => ({ toArray: () => [{ issuer: "shop.example", label: "main" }] }) } as unknown as SqlStorage;
    const sessions = TABLES.find((table) => table.name === "poppy_sessions")!;
    expect(() => rows(fake, sessions.row, "SELECT * FROM poppy_sessions")).toThrow(DecodeError);
    expect(() => rows(fake, sessions.row, "SELECT * FROM poppy_sessions")).toThrow(/poppy_sessions row\.issuer: expected an issuer/);
  });
});
