/**
 * Reminders and scheduled tasks, as rows in the person's own Durable Object
 * SQLite: what (the User's words, verbatim), when next (UTC ms), how it
 * repeats (never, daily, weekdays or weekly, at a wall-clock time in the
 * zone it was set in), and how its runs went. When a row is due is worked
 * out here, with the clock tools' zone-aware date maths (`clock.ts`), so a
 * daily 09:00 stays 09:00 across a clock change. No Worker APIs beyond
 * `SqlStorage`'s shape; the alarm that runs a row is `src/schedules.ts`.
 */
import { addToInstant, checkZone, civil, dayNumber, instantOf, parseDuration, parseMoment, TimeError, viewMoment, wallAt } from "./clock";
import { secretProblem } from "./memory-store";
import { literal } from "../decode";
import { integer, nullable, one, rows, table, text, textOf, type RowOf } from "../rows";

/** Most reminders and tasks waiting to run, per agent. */
export const MAX_ACTIVE_SCHEDULES = 20;
/** Longest reminder text or task instruction, in characters. */
export const MAX_SCHEDULE_CHARS = 1000;
/** How far ahead a one-off time may be. */
export const MAX_AHEAD_MS = 366 * 86_400_000;
/** A task that fails this many runs in a row is paused. */
export const PAUSE_AFTER_FAILURES = 3;
/** Finished rows (done, failed or cancelled) kept, the most recently finished first, so the list stays bounded. */
export const KEEP_FINISHED = 100;
/**
 * How long to wait before showing a reminder again after its card couldn't
 * be shown: a minute, five, then thirty. After the last, the run has failed.
 */
export const REMINDER_RETRIES_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
/** Tries at showing one reminder: the first and each retry. */
export const REMINDER_ATTEMPTS = REMINDER_RETRIES_MS.length + 1;
/** Run records kept, newest first, for Activity. */
export const KEEP_RUNS = 200;

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type ScheduleKind = "reminder" | "task";
export type Repeat = "daily" | "weekdays" | "weekly";
/** `failed`: a one-off whose run failed (a reminder that couldn't be shown, a task that didn't run). */
export type ScheduleStatus = "active" | "paused" | "done" | "failed" | "cancelled";

/** How a row repeats: never, or at `time` (HH:MM) every day, every weekday (Monday to Friday) or every `weekday`. */
export type Recurrence =
  | { readonly repeat: "none" }
  | { readonly repeat: "daily" | "weekdays"; readonly time: string }
  | { readonly repeat: "weekly"; readonly time: string; readonly weekday: Weekday };

export type Schedule = {
  readonly id: string;
  readonly kind: ScheduleKind;
  /** The reminder's text or the task's instruction, as the User said it. */
  readonly text: string;
  /** When it runs next, in UTC ms (a retry's time while one waits); null once finished. */
  readonly nextRun: number | null;
  readonly recurrence: Recurrence;
  /** The IANA zone its times are in: the User's when it was set. */
  readonly timeZone: string;
  readonly createdAt: number;
  /** What created it: the tool call, so a replayed call finds the same row. */
  readonly createdFrom: string;
  readonly status: ScheduleStatus;
  /** Task runs that failed in a row. */
  readonly failures: number;
  readonly lastRun: number | null;
  readonly lastOutcome: string | null;
  /** Why it is paused, when something other than failed runs paused it. */
  readonly pausedReason: string | null;
  /** Tries at showing the reminder now due that failed; 0 when none is being retried. */
  readonly attempts: number;
  /** When the run being retried was due; null when none is. `nextRun` is then the retry's time. */
  readonly retryDue: number | null;
  /** When it was done, failed or cancelled; null while active or paused. */
  readonly finishedAt: number | null;
};

export type RunOutcome = "reminded" | "started" | "done" | "failed";

export type ScheduleRun = {
  readonly id: number;
  readonly scheduleId: string;
  readonly kind: ScheduleKind;
  readonly text: string;
  readonly dueAt: number;
  readonly ranAt: number;
  readonly outcome: RunOutcome;
  readonly detail: string | null;
  readonly operationId: string;
};

/** A refusal, worded for the model or the page. */
export class ScheduleError extends Error {
  override name = "ScheduleError";
}

const SCHEDULES = `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('reminder', 'task')),
    text TEXT NOT NULL,
    next_run INTEGER,
    recurrence TEXT NOT NULL CHECK (recurrence IN ('none', 'daily', 'weekdays', 'weekly')),
    local_time TEXT,
    weekday TEXT,
    time_zone TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_from TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'done', 'failed', 'cancelled')),
    failures INTEGER NOT NULL DEFAULT 0,
    last_run INTEGER,
    last_outcome TEXT,
    paused_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    retry_due INTEGER,
    finished_at INTEGER
  )`;

const RUNS = `CREATE TABLE IF NOT EXISTS schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    ran_at INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('reminded', 'started', 'done', 'failed')),
    detail TEXT,
    operation_id TEXT NOT NULL UNIQUE
  )`;

/**
 * Make the tables, or bring an older `schedules` up to date. One made before
 * reminders were retried has neither `failed` in its status check nor the
 * retry columns, and SQLite can't change a check in place: its rows are
 * copied into a new table, with every column it had.
 */
export function migrateSchedules(sql: SqlStorage): void {
  sql.exec(SCHEDULES);
  sql.exec(RUNS);
  const columns = (sql.exec("PRAGMA table_info(schedules)").toArray() as { name: string }[]).map((column) => column.name);
  if (columns.includes("finished_at")) return;
  sql.exec("ALTER TABLE schedules RENAME TO schedules_before_retries");
  sql.exec(SCHEDULES);
  const kept = columns.join(", ");
  sql.exec(`INSERT INTO schedules (${kept}) SELECT ${kept} FROM schedules_before_retries`);
  sql.exec("UPDATE schedules SET finished_at = COALESCE(last_run, created_at) WHERE status IN ('done', 'cancelled')");
  sql.exec("DROP TABLE schedules_before_retries");
}

// ---------------------------------------------------------------- When

/** `HH:MM` on a 24-hour clock. */
export function parseLocalTime(time: unknown): { hour: number; minute: number } {
  const match = typeof time === "string" ? /^(\d{1,2}):(\d{2})$/.exec(time.trim()) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new ScheduleError(`${JSON.stringify(time)} isn't a time of day on a 24-hour clock, such as 09:00 or 17:30`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function formatLocalTime(time: { hour: number; minute: number }): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

/**
 * The first time `recurrence` names strictly after `after`, in `zone`: the
 * wall-clock time on the next matching day, through `instantOf`, so a time a
 * clock change skips moves forward by the gap and one it repeats is the
 * earlier.
 */
export function nextOccurrence(recurrence: Exclude<Recurrence, { repeat: "none" }>, after: number, zone: string): number {
  const { hour, minute } = parseLocalTime(recurrence.time);
  const today = wallAt(after, zone);
  const start = dayNumber(today.year, today.month, today.day);
  for (let offset = 0; offset <= 8; offset++) {
    const day = start + offset;
    const weekday = (((day + 3) % 7) + 7) % 7;
    if (recurrence.repeat === "weekdays" && weekday > 4) continue;
    if (recurrence.repeat === "weekly" && WEEKDAYS[weekday] !== recurrence.weekday) continue;
    const date = civil(day);
    const at = instantOf({ ...date, hour, minute, second: 0, millisecond: 0 }, zone);
    if (at > after) return at;
  }
  throw new ScheduleError("No time matches that repeat");
}

export type EveryInput = { readonly repeat?: unknown; readonly time?: unknown; readonly weekday?: unknown };
export type WhenInput = { readonly at?: unknown; readonly in?: unknown; readonly every?: EveryInput };

/**
 * When a new row first runs, and how it repeats, from exactly one of `at` (a
 * local date and time in `zone`, or one with an offset), `in` (an ISO 8601
 * duration from now) or `every`. A one-off time must be in the future and
 * within a year.
 */
export function resolveWhen(input: WhenInput, now: number, zone: string): { nextRun: number; recurrence: Recurrence } {
  const given = (["at", "in", "every"] as const).filter((key) => input[key] !== undefined && input[key] !== null);
  if (given.length !== 1) throw new ScheduleError("Give exactly one of at (a local date and time), in (a duration such as PT2H) or every (a repeat)");
  try {
    if (given[0] === "every") {
      const every = input.every!;
      const repeat = every.repeat;
      if (repeat !== "daily" && repeat !== "weekdays" && repeat !== "weekly") {
        throw new ScheduleError("every.repeat is daily, weekdays or weekly; nothing repeats more often than daily");
      }
      const time = formatLocalTime(parseLocalTime(every.time));
      let recurrence: Recurrence;
      if (repeat === "weekly") {
        const weekday = typeof every.weekday === "string" ? WEEKDAYS.find((name) => name.toLowerCase() === (every.weekday as string).trim().toLowerCase()) : undefined;
        if (!weekday) throw new ScheduleError("A weekly repeat needs every.weekday, such as Monday");
        recurrence = { repeat, time, weekday };
      } else {
        recurrence = { repeat, time };
      }
      return { nextRun: nextOccurrence(recurrence, now, zone), recurrence };
    }
    let at: number;
    if (given[0] === "at") {
      if (typeof input.at !== "string") throw new ScheduleError("at is a date and time, such as 2026-10-12T17:00");
      const moment = parseMoment(input.at, zone, now);
      if (moment.kind !== "instant" || /^(now|today)$/i.test(input.at.trim())) {
        throw new ScheduleError(`at needs a date and a time, such as ${input.at.trim().slice(0, 10)}T09:00`);
      }
      at = moment.instant;
    } else {
      const duration = parseDuration(input.in);
      at = addToInstant(now, duration, zone);
    }
    if (at <= now) throw new ScheduleError(`That time has passed: it was ${viewMoment(at, zone).iso}. Give a time in the future`);
    if (at - now > MAX_AHEAD_MS) throw new ScheduleError("That's more than a year away; reminders and tasks go at most a year ahead");
    return { nextRun: at, recurrence: { repeat: "none" } };
  } catch (error) {
    if (error instanceof TimeError) throw new ScheduleError(error.message);
    throw error;
  }
}

/** "every weekday at 09:00", "once". */
export function describeRecurrence(recurrence: Recurrence): string {
  switch (recurrence.repeat) {
    case "none":
      return "once";
    case "daily":
      return `every day at ${recurrence.time}`;
    case "weekdays":
      return `every weekday at ${recurrence.time}`;
    case "weekly":
      return `every ${recurrence.weekday} at ${recurrence.time}`;
  }
}

// ---------------------------------------------------------------- The store

export const schedulesTable = table("schedules", {
  id: text,
  kind: textOf(literal("reminder", "task")),
  text,
  next_run: nullable(integer),
  recurrence: textOf(literal("none", "daily", "weekdays", "weekly")),
  local_time: nullable(text),
  weekday: nullable(text),
  time_zone: text,
  created_at: integer,
  created_from: text,
  status: textOf(literal("active", "paused", "done", "failed", "cancelled")),
  failures: integer,
  last_run: nullable(integer),
  last_outcome: nullable(text),
  paused_reason: nullable(text),
  attempts: integer,
  retry_due: nullable(integer),
  finished_at: nullable(integer)
});
const scheduleRow = schedulesTable.row;
type Row = RowOf<typeof scheduleRow>;

const COLUMNS = "id, kind, text, next_run, recurrence, local_time, weekday, time_zone, created_at, created_from, status, failures, last_run, last_outcome, paused_reason, attempts, retry_due, finished_at";

function toRecurrence(row: Row): Recurrence {
  if (row.recurrence === "weekly") return { repeat: "weekly", time: String(row.local_time), weekday: (WEEKDAYS.find((day) => day === row.weekday) ?? "Monday") as Weekday };
  if (row.recurrence === "daily" || row.recurrence === "weekdays") return { repeat: row.recurrence, time: String(row.local_time) };
  return { repeat: "none" };
}

function toSchedule(row: Row): Schedule {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    nextRun: row.next_run,
    recurrence: toRecurrence(row),
    timeZone: row.time_zone,
    createdAt: row.created_at,
    createdFrom: row.created_from,
    status: row.status,
    failures: row.failures,
    lastRun: row.last_run,
    lastOutcome: row.last_outcome,
    pausedReason: row.paused_reason,
    attempts: row.attempts,
    retryDue: row.retry_due,
    finishedAt: row.finished_at
  };
}

export const runsTable = table("schedule_runs", {
  id: integer,
  schedule_id: text,
  kind: text,
  text,
  due_at: integer,
  ran_at: integer,
  outcome: textOf(literal("reminded", "started", "done", "failed")),
  detail: nullable(text),
  operation_id: text
});
const runRow = runsTable.row;
type RunRow = RowOf<typeof runRow>;

function toRun(row: RunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    kind: row.kind === "task" ? "task" : "reminder",
    text: row.text,
    dueAt: row.due_at,
    ranAt: row.ran_at,
    outcome: row.outcome,
    detail: row.detail,
    operationId: row.operation_id
  };
}

/** A new id the model and the page name a row by: `sch_` and ten letters and digits. */
function newId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `sch_${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

export type NewSchedule = {
  readonly kind: ScheduleKind;
  readonly text: unknown;
  readonly when: WhenInput;
  readonly timeZone: string;
  readonly createdFrom: string;
};

export class ScheduleStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    migrateSchedules(sql);
    this.#sql = sql;
    this.#now = now;
  }

  get(id: string): Schedule | undefined {
    if (typeof id !== "string") return undefined;
    const row = one(this.#sql, scheduleRow, `SELECT ${COLUMNS} FROM schedules WHERE id = ?`, id);
    return row ? toSchedule(row) : undefined;
  }

  /** Rows with these statuses, soonest first, then newest. */
  list(statuses: readonly ScheduleStatus[] = ["active", "paused"]): Schedule[] {
    const marks = statuses.map(() => "?").join(", ");
    return rows(this.#sql, scheduleRow, `SELECT ${COLUMNS} FROM schedules WHERE status IN (${marks}) ORDER BY next_run IS NULL, next_run, created_at DESC`, ...statuses).map(toSchedule);
  }

  activeCount(): number {
    return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'").toArray()[0]?.n ?? 0);
  }

  /**
   * Keep a new reminder or task. A second call from the same tool call (a
   * replay) returns the row the first made. Refuses, saying why, empty,
   * long or secret-looking text, a time that has passed or is more than a
   * year away, and any new row once 20 are active.
   */
  create(input: NewSchedule): { schedule: Schedule; created: boolean } {
    const existing = one(this.#sql, scheduleRow, `SELECT ${COLUMNS} FROM schedules WHERE created_from = ?`, input.createdFrom);
    if (existing) return { schedule: toSchedule(existing), created: false };
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const what = input.kind === "task" ? "A task's instruction" : "A reminder";
    if (!text) throw new ScheduleError(`${what} needs some text`);
    if (text.length > MAX_SCHEDULE_CHARS) throw new ScheduleError(`${what} is at most ${MAX_SCHEDULE_CHARS} characters; this one is ${text.length}`);
    const problem = secretProblem(text);
    if (problem) throw new ScheduleError(`Not set: ${problem}. Reminders and tasks never keep passwords, codes, keys, tokens or card numbers; say it without the secret`);
    let zone: string;
    try {
      zone = checkZone(input.timeZone);
    } catch (error) {
      throw new ScheduleError(error instanceof Error ? error.message : String(error));
    }
    const now = this.#now();
    const { nextRun, recurrence } = resolveWhen(input.when, now, zone);
    if (this.activeCount() >= MAX_ACTIVE_SCHEDULES) {
      throw new ScheduleError(`There are already ${MAX_ACTIVE_SCHEDULES} reminders and tasks waiting, the most an agent keeps. Cancel one first`);
    }
    const row = one(
      this.#sql,
      scheduleRow,
      `INSERT INTO schedules (id, kind, text, next_run, recurrence, local_time, weekday, time_zone, created_at, created_from, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active') RETURNING ${COLUMNS}`,
      newId(),
      input.kind,
      text,
      nextRun,
      recurrence.repeat,
      recurrence.repeat === "none" ? null : recurrence.time,
      recurrence.repeat === "weekly" ? recurrence.weekday : null,
      zone,
      now,
      input.createdFrom
    )!;
    this.#prune();
    return { schedule: toSchedule(row), created: true };
  }

  /** Cancel an active or paused row, or dismiss a failed one; null if there is none to cancel. */
  cancel(id: string): Schedule | null {
    const found = this.get(id);
    if (!found || (found.status !== "active" && found.status !== "paused" && found.status !== "failed")) return null;
    this.#sql.exec("UPDATE schedules SET status = 'cancelled', next_run = NULL, finished_at = ? WHERE id = ?", this.#now(), id);
    this.#prune();
    return this.get(id)!;
  }

  /** When the run a row's job is for was due: the retried run's time while a retry waits, else its next run. */
  dueAt(schedule: Schedule): number | null {
    return schedule.retryDue ?? schedule.nextRun;
  }

  /**
   * After a run that was due at `dueAt`: a one-off is done, or failed when
   * `finish` says so; a repeat moves to its next time after both `dueAt` and
   * now, so a late alarm doesn't run it twice to catch up. A retry ends.
   */
  advance(id: string, dueAt: number, outcome: string, finish: "done" | "failed" = "done"): Schedule | undefined {
    const found = this.get(id);
    if (!found) return undefined;
    const now = this.#now();
    if (found.recurrence.repeat === "none") {
      this.#sql.exec(
        "UPDATE schedules SET status = CASE WHEN status = 'active' THEN ? ELSE status END, next_run = NULL, last_run = ?, last_outcome = ?, retry_due = NULL, finished_at = ? WHERE id = ?",
        finish,
        now,
        outcome,
        now,
        id
      );
      this.#prune();
    } else {
      const next = nextOccurrence(found.recurrence, Math.max(dueAt, now), found.timeZone);
      this.#sql.exec("UPDATE schedules SET next_run = ?, last_run = ?, last_outcome = ?, attempts = 0, retry_due = NULL WHERE id = ?", next, now, outcome, id);
    }
    return this.get(id);
  }

  /**
   * The card for a reminder due at `dueAt` couldn't be shown: count the try
   * and, while tries are left, run it again after the next wait
   * (`REMINDER_RETRIES_MS`). Returns the retry's time, or null when every
   * try has failed and the caller records the run as failed.
   */
  retry(id: string, dueAt: number): number | null {
    const found = this.get(id);
    if (!found) return null;
    const attempts = found.attempts + 1;
    const wait = REMINDER_RETRIES_MS[attempts - 1];
    if (wait === undefined) {
      this.#sql.exec("UPDATE schedules SET attempts = ? WHERE id = ?", attempts, id);
      return null;
    }
    const at = this.#now() + wait;
    this.#sql.exec("UPDATE schedules SET attempts = ?, retry_due = ?, next_run = ?, last_outcome = 'retrying' WHERE id = ?", attempts, dueAt, at, id);
    return at;
  }

  /** A task run went well: its count of failures in a row starts again. */
  succeeded(id: string, outcome: string): void {
    this.#sql.exec("UPDATE schedules SET failures = 0, last_outcome = ? WHERE id = ?", outcome, id);
  }

  /**
   * A task run failed: count it, mark a one-off failed rather than done, and
   * pause the task at the third in a row. Returns whether this paused it.
   */
  failed(id: string, outcome: string): boolean {
    this.#sql.exec(
      "UPDATE schedules SET failures = failures + 1, last_outcome = ?, status = CASE WHEN status = 'done' AND recurrence = 'none' THEN 'failed' ELSE status END WHERE id = ?",
      outcome,
      id
    );
    const found = this.get(id);
    if (found && found.status === "active" && found.failures >= PAUSE_AFTER_FAILURES) {
      this.#sql.exec("UPDATE schedules SET status = 'paused' WHERE id = ?", id);
      return true;
    }
    return false;
  }

  /** Pause an active row, keeping when it was next due, and say why. False if it wasn't active. */
  pause(id: string, reason: string): boolean {
    const found = this.get(id);
    if (!found || found.status !== "active") return false;
    this.#sql.exec("UPDATE schedules SET status = 'paused', paused_reason = ? WHERE id = ?", reason, id);
    return true;
  }

  /**
   * Start again every row paused for `reason`: a repeat at its next time
   * after now, a one-off at its own time, or at once if that has passed.
   * Returns the rows started again.
   */
  resume(reason: string): Schedule[] {
    const now = this.#now();
    const paused = rows(this.#sql, scheduleRow, `SELECT ${COLUMNS} FROM schedules WHERE status = 'paused' AND paused_reason = ?`, reason).map(toSchedule);
    for (const schedule of paused) {
      if (schedule.recurrence.repeat === "none") {
        // A one-off keeps a retry it was waiting on, so its card keeps its id.
        this.#sql.exec("UPDATE schedules SET status = 'active', paused_reason = NULL, next_run = ? WHERE id = ?", Math.max(schedule.nextRun ?? now, now), schedule.id);
      } else if (schedule.nextRun !== null && schedule.nextRun > now) {
        this.#sql.exec("UPDATE schedules SET status = 'active', paused_reason = NULL WHERE id = ?", schedule.id);
      } else {
        // A repeat goes on to its next time, and a retry of a time it missed is dropped.
        const next = nextOccurrence(schedule.recurrence, now, schedule.timeZone);
        this.#sql.exec("UPDATE schedules SET status = 'active', paused_reason = NULL, next_run = ?, attempts = 0, retry_due = NULL WHERE id = ?", next, schedule.id);
      }
    }
    return paused.map((schedule) => this.get(schedule.id)!);
  }

  // ---------------------------------------------------------------- Runs

  /** The run for this operation id, if one was recorded (a repeated alarm finds it). */
  run(operationId: string): ScheduleRun | undefined {
    const row = one(this.#sql, runRow, "SELECT * FROM schedule_runs WHERE operation_id = ?", operationId);
    return row ? toRun(row) : undefined;
  }

  recordRun(schedule: Schedule, dueAt: number, outcome: RunOutcome, operationId: string, detail: string | null = null): ScheduleRun {
    this.#sql.exec(
      "INSERT OR IGNORE INTO schedule_runs (schedule_id, kind, text, due_at, ran_at, outcome, detail, operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      schedule.id,
      schedule.kind,
      schedule.text,
      dueAt,
      this.#now(),
      outcome,
      detail,
      operationId
    );
    this.#sql.exec("DELETE FROM schedule_runs WHERE id NOT IN (SELECT id FROM schedule_runs ORDER BY id DESC LIMIT ?)", KEEP_RUNS);
    return this.run(operationId)!;
  }

  finishRun(operationId: string, outcome: "done" | "failed", detail: string | null): void {
    this.#sql.exec("UPDATE schedule_runs SET outcome = ?, detail = ? WHERE operation_id = ? AND outcome = 'started'", outcome, detail, operationId);
  }

  /** Task runs whose outcome isn't known yet. */
  started(): ScheduleRun[] {
    return rows(this.#sql, runRow, "SELECT * FROM schedule_runs WHERE outcome = 'started' ORDER BY id").map(toRun);
  }

  runs(limit = KEEP_RUNS): ScheduleRun[] {
    return rows(this.#sql, runRow, "SELECT * FROM schedule_runs ORDER BY id DESC LIMIT ?", limit).map(toRun);
  }

  /**
   * Keep only the `KEEP_FINISHED` most recently finished rows, in one
   * statement. Every change that finishes a row calls it, so however many
   * finish together (one alarm running many due jobs), no more are kept.
   */
  #prune(): void {
    this.#sql.exec(
      `DELETE FROM schedules WHERE status IN ('done', 'failed', 'cancelled') AND id NOT IN (
         SELECT id FROM schedules WHERE status IN ('done', 'failed', 'cancelled') ORDER BY COALESCE(finished_at, created_at) DESC, rowid DESC LIMIT ?)`,
      KEEP_FINISHED
    );
  }
}

/** One row as the model reads it. */
export function scheduleLine(schedule: Schedule): string {
  const next = schedule.nextRun === null ? "not scheduled" : `next ${viewMoment(schedule.nextRun, schedule.timeZone).iso} (${schedule.timeZone})`;
  const failures = schedule.failures ? `, ${schedule.failures} failed run${schedule.failures === 1 ? "" : "s"} in a row` : "";
  return `- [${schedule.id}] ${schedule.kind}, ${describeRecurrence(schedule.recurrence)}, ${next}, ${schedule.status}${failures}: ${schedule.text}`;
}
