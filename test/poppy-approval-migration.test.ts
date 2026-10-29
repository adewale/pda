import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { storedApproval, type NewApproval } from "../src/poppy/approvals";
import { PoppyClient } from "../src/poppy/client";
import { decideLocal, proposeLocal } from "../src/poppy/operations";
import { migrate } from "../src/poppy/store";
import { agent, company, requests } from "./agent-helpers";

it("finishes legacy approval identity inspection once, including unreadable rows, across proposals, decisions and restart", async () => {
  const a = await agent();
  const c = await company();
  await runInDurableObject(a.stub, async instance => {
    const original = instance.poppy.client;
    const C = await original.company(c.domain);
    const sql = original.sql;
    const approval: NewApproval = { kind: "mcp", call: { apiUrl: C.apis.find(api => api.type === "mcp")!.url, tool: "exchange_item", args: { order_id: "ord_7Hk2" } } };
    // Restore the previous schema, including an already-derived identity.
    if (sql.exec("PRAGMA table_info(poppy_approvals)").toArray().some(column => column.name === "action_identity_checked")) {
      sql.exec("DROP INDEX IF EXISTS poppy_approvals_unchecked_action");
      sql.exec("ALTER TABLE poppy_approvals DROP COLUMN action_identity_checked");
    }
    sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
      INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at)
      SELECT 'legacy_' || i, ?, 'main', 'Old unreadable request', CASE WHEN i % 2 = 0 THEN '{}' ELSE 'not json' END, 'done', i FROM n`, C.issuer);
    sql.exec("INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at) VALUES ('legacy_readable', ?, 'main', 'Readable request', ?, 'done', 201)", C.issuer, storedApproval(approval));
    sql.exec("INSERT INTO poppy_approvals (id, issuer, label, summary, request, status, created_at, action_key, action_owner) VALUES ('derived', ?, 'main', 'Derived request', ?, 'done', 202, 'existing-key', 'existing-owner')", C.issuer, storedApproval(approval));
    migrate(sql);

    const scans: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
    const counting = new Proxy(sql, { get(target, key) {
      if (key === "exec") return (query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = target.exec(query, ...bindings);
        if (/SELECT\b[\s\S]*\bFROM poppy_approvals\b/.test(query) && /WHERE action_(key IS NULL|identity_checked = 0)/.test(query)) scans.push(cursor);
        return cursor;
      };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const client = () => new PoppyClient({ ...original.host, sql: counting });
    const first = client();
    await proposeLocal(first, C, "main", "Fresh request", approval, "fresh_1");
    expect(scans.reduce((sum, cursor) => sum + cursor.rowsRead, 0)).toBeGreaterThanOrEqual(201);
    scans.length = 0;
    await decideLocal(first, "fresh_1", "decline");
    await proposeLocal(first, C, "main", "Another request", approval, "fresh_2");
    migrate(sql);
    const restarted = client();
    await decideLocal(restarted, "fresh_2", "decline");
    await proposeLocal(restarted, C, "main", "After restart", approval, "fresh_3");
    // An empty partial-index lookup can count one row; it must not revisit the 200 payloads.
    expect(scans.reduce((sum, cursor) => sum + cursor.rowsRead, 0)).toBeLessThanOrEqual(scans.length);
    expect(sql.exec("SELECT action_key, action_owner FROM poppy_approvals WHERE id = 'derived'").toArray()).toEqual([{ action_key: "existing-key", action_owner: "existing-owner" }]);
    expect(sql.exec("SELECT action_key FROM poppy_approvals WHERE id = 'legacy_readable'").toArray()[0]?.action_key).toEqual(expect.any(String));
    expect(sql.exec("SELECT COUNT(*) AS n FROM poppy_approvals WHERE id LIKE 'legacy_%' AND action_key IS NULL").toArray()).toEqual([{ n: 200 }]);
    // The completion marker never makes an unreadable request executable.
    sql.exec("UPDATE poppy_approvals SET status = 'pending' WHERE id = 'legacy_1'");
    restarted.rememberCompany("approval", "legacy_1", C);
    await decideLocal(restarted, "legacy_1", "approve");
    expect(sql.exec("SELECT status FROM poppy_approvals WHERE id = 'legacy_1'").toArray()).toEqual([{ status: "failed" }]);
    sql.exec("UPDATE poppy_approvals SET status = 'unknown' WHERE id = 'legacy_2'");
    await expect(proposeLocal(restarted, C, "main", "Held request", approval, "held")).rejects.toThrow("unknown outcome");
  });
  expect((await requests(c)).filter(request => request.method === "POST")).toEqual([]);
});
