import { DurableObject } from "cloudflare:workers";

/**
 * What the demo lane has spent, per UTC day, in US dollars, from pi-ai's
 * `usage.cost` (catalog prices, so an estimate: Unified Billing adds its fee
 * on top). The agent checks both totals before every demo model call and
 * refuses the call once either cap is reached; the cost is added after the
 * call. So a cap can be overshot by at most the calls already in flight, one
 * per agent. Gateway spend limits are only a backstop behind this.
 */

/** The UTC day of `now`, as `YYYY-MM-DD`: caps reset at midnight UTC. */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The next midnight UTC after `now`, in epoch ms. */
export function nextUtcMidnight(now: number = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

const LEDGER = `CREATE TABLE IF NOT EXISTS model_spend (
  day TEXT PRIMARY KEY,
  cost_usd REAL NOT NULL,
  calls INTEGER NOT NULL
)`;

/** One person's demo spend, in their own agent's SQLite. */
export class Ledger {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(LEDGER);
  }

  spent(day: string): number {
    const row = this.#sql.exec("SELECT cost_usd FROM model_spend WHERE day = ?", day).toArray()[0];
    return row ? Number(row.cost_usd) : 0;
  }

  add(day: string, costUsd: number, now = Date.now()): void {
    this.#sql.exec(
      `INSERT INTO model_spend (day, cost_usd, calls) VALUES (?, ?, 1)
       ON CONFLICT (day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, calls = calls + 1`,
      day,
      costUsd
    );
    // A week is plenty for a daily cap.
    this.#sql.exec("DELETE FROM model_spend WHERE day < ?", utcDay(now - 7 * 86_400_000));
  }
}

/**
 * One per budget domain (a Google Workspace domain, or `personal`): the demo
 * spend of everyone in it, per UTC day, shared across their agents.
 */
export class DomainBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(LEDGER);
  }

  async spent(day: string): Promise<number> {
    return new Ledger(this.ctx.storage.sql).spent(day);
  }

  async add(day: string, costUsd: number, now = Date.now()): Promise<number> {
    const ledger = new Ledger(this.ctx.storage.sql);
    ledger.add(day, costUsd, now);
    return ledger.spent(day);
  }
}
