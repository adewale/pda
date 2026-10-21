import { DurableObject } from "cloudflare:workers";

/**
 * What the demo lane has spent, per UTC day, in US dollars, from pi-ai's
 * `usage.cost` (catalog prices, so an estimate: Unified Billing adds its fee
 * on top). The agent checks both totals before every demo model call and
 * refuses the call once either cap is reached; the cost is added after the
 * call. Before admission a call holds up to half the person's allowance in
 * this ledger and reserves available room in the domain's ledger. Unknown
 * outcomes retain that liability; known costs have an idempotent durable
 * settlement outbox. These remain soft catalog-dollar caps: a provider can
 * charge more than the reservation, and Unified Billing adds its fee.
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

const CALLS = `CREATE TABLE IF NOT EXISTS model_budget_calls (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  domain TEXT NOT NULL,
  reserved_usd REAL NOT NULL,
  cost_usd REAL,
  shared_settled INTEGER NOT NULL DEFAULT 0
)`;

export type BudgetCall = { id: string; day: string; domain: string; reservedUsd: number };
export type BudgetSettlement = BudgetCall & { costUsd: number };
export type SharedBudget = {
  spent(day: string): Promise<number>;
  charged(day: string): Promise<number>;
  reserve(id: string, day: string, requestedUsd: number, capUsd: number): Promise<{ accepted: boolean; reservedUsd: number }>;
  settle(id: string, day: string, costUsd: number): Promise<void>;
};

function dollars(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error("Budget amount must be finite and nonnegative");
}

function callOf(row: Record<string, SqlStorageValue>): BudgetCall {
  if (typeof row.id !== "string" || typeof row.day !== "string" || typeof row.domain !== "string" || typeof row.reserved_usd !== "number") {
    throw new Error("Malformed model budget row");
  }
  return { id: row.id, day: row.day, domain: row.domain, reservedUsd: row.reserved_usd };
}

/** One person's demo spend, in their own agent's SQLite. */
export class Ledger {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(LEDGER);
    sql.exec(CALLS);
  }

  spent(day: string): number {
    return this.#total(day, true);
  }

  /** Observed usage only, for queue preflight; actual admission always includes holds. */
  charged(day: string): number {
    return this.#total(day, false);
  }

  #total(day: string, holds: boolean): number {
    const row = this.#sql.exec("SELECT cost_usd FROM model_spend WHERE day = ?", day).toArray()[0];
    const calls = this.#sql.exec(`SELECT COALESCE(SUM(${holds ? "COALESCE(cost_usd, reserved_usd)" : "cost_usd"}), 0) AS total FROM model_budget_calls WHERE day = ?`, day).one();
    return (row ? Number(row.cost_usd) : 0) + Number(calls.total);
  }

  add(day: string, costUsd: number, now = Date.now()): void {
    dollars(costUsd);
    this.#sql.exec(
      `INSERT INTO model_spend (day, cost_usd, calls) VALUES (?, ?, 1)
       ON CONFLICT (day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, calls = calls + 1`,
      day,
      costUsd
    );
    // A week is plenty for a daily cap.
    this.#sql.exec("DELETE FROM model_spend WHERE day < ?", utcDay(now - 7 * 86_400_000));
  }

  /** Synchronous local admission, before any RPC can yield to another call. */
  begin(day: string, domain: string, capUsd: number): BudgetCall | null {
    dollars(capUsd);
    const remaining = capUsd - this.spent(day);
    if (remaining <= 0) return null;
    // Foreground generation and background compaction may overlap. At most
    // two unresolved calls (including unknown outcomes after restart) can
    // consume a day's room; repeatedly halving the remainder would admit
    // an unbounded number of unknown liabilities.
    const unresolved = this.#sql.exec("SELECT COUNT(*) AS n FROM model_budget_calls WHERE day = ? AND cost_usd IS NULL", day).one();
    if (Number(unresolved.n) >= 2) return null;
    const reservedUsd = Math.min(remaining, capUsd / 2);
    const call = { id: crypto.randomUUID(), day, domain, reservedUsd };
    this.#sql.exec("INSERT INTO model_budget_calls (id, day, domain, reserved_usd) VALUES (?, ?, ?, ?)", call.id, day, domain, reservedUsd);
    return call;
  }

  reserve(call: BudgetCall, reservedUsd: number): BudgetCall {
    dollars(reservedUsd);
    if (reservedUsd <= 0 || reservedUsd > call.reservedUsd) throw new Error("Invalid shared budget reservation");
    this.#sql.exec("UPDATE model_budget_calls SET reserved_usd = ? WHERE id = ? AND cost_usd IS NULL", reservedUsd, call.id);
    return { ...call, reservedUsd };
  }

  /** No vendor call started and the shared reservation was definitively denied. */
  denied(call: BudgetCall): void {
    this.#sql.exec("DELETE FROM model_budget_calls WHERE id = ? AND cost_usd IS NULL", call.id);
  }

  /** Cost and outbox become durable in one statement; the old ledger is not also incremented. */
  complete(call: BudgetCall, costUsd: number): void {
    dollars(costUsd);
    this.#sql.exec("UPDATE model_budget_calls SET cost_usd = ? WHERE id = ? AND cost_usd IS NULL", costUsd, call.id);
    const row = this.#sql.exec("SELECT cost_usd FROM model_budget_calls WHERE id = ?", call.id).one();
    if (row.cost_usd !== costUsd) throw new Error("Model settlement conflicts with its recorded cost");
  }

  pending(): BudgetSettlement[] {
    return this.#sql.exec("SELECT * FROM model_budget_calls WHERE cost_usd IS NOT NULL AND shared_settled = 0").toArray().map(row => {
      if (typeof row.cost_usd !== "number") throw new Error("Malformed model settlement");
      return { ...callOf(row), costUsd: row.cost_usd };
    });
  }

  acknowledged(id: string): void {
    this.#sql.exec("UPDATE model_budget_calls SET shared_settled = 1 WHERE id = ? AND cost_usd IS NOT NULL", id);
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
    ctx.storage.sql.exec(CALLS);
  }

  async spent(day: string): Promise<number> {
    return new Ledger(this.ctx.storage.sql).spent(day);
  }

  async charged(day: string): Promise<number> {
    return new Ledger(this.ctx.storage.sql).charged(day);
  }

  async add(day: string, costUsd: number, now = Date.now()): Promise<number> {
    const ledger = new Ledger(this.ctx.storage.sql);
    ledger.add(day, costUsd, now);
    return ledger.spent(day);
  }

  /** One synchronous SQLite admission: competing agents cannot reserve the same room. */
  async reserve(id: string, day: string, requestedUsd: number, capUsd: number): Promise<{ accepted: boolean; reservedUsd: number }> {
    dollars(requestedUsd);
    dollars(capUsd);
    if (requestedUsd <= 0) return { accepted: false, reservedUsd: 0 };
    const sql = this.ctx.storage.sql;
    const existing = sql.exec("SELECT * FROM model_budget_calls WHERE id = ?", id).toArray()[0];
    if (existing) {
      if (existing.day !== day) throw new Error("Budget admission day conflict");
      return { accepted: true, reservedUsd: Number(existing.reserved_usd) };
    }
    const room = capUsd - new Ledger(sql).spent(day);
    if (room <= 0) return { accepted: false, reservedUsd: 0 };
    const reservedUsd = Math.min(requestedUsd, room);
    sql.exec("INSERT INTO model_budget_calls (id, day, domain, reserved_usd) VALUES (?, ?, '', ?)", id, day, reservedUsd);
    return { accepted: true, reservedUsd };
  }

  /** Applied once even when a reply was lost; never releases a hold on an unknown outcome. */
  async settle(id: string, day: string, costUsd: number): Promise<void> {
    dollars(costUsd);
    const row = this.ctx.storage.sql.exec("SELECT * FROM model_budget_calls WHERE id = ?", id).toArray()[0];
    if (!row || row.day !== day) throw new Error("No matching budget admission");
    if (row.cost_usd !== null && row.cost_usd !== costUsd) throw new Error("Shared settlement cost conflict");
    this.ctx.storage.sql.exec("UPDATE model_budget_calls SET cost_usd = ?, shared_settled = 1 WHERE id = ? AND cost_usd IS NULL", costUsd, id);
  }

}
