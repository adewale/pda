/**
 * Reminders and scheduled tasks on the Durable Object's alarm: a Lifecycle
 * capability whose jobs are the rows of `schedules` (src/tools/schedule-store.ts),
 * one job per active row, at its next run.
 *
 * - A **reminder** shows an open notice card ("Reminder: …"), which the
 *   page puts in the needs-you tray, and goes to the User's devices by Web
 *   Push when they turned notifications on. No model call.
 * - A **task** starts a background model turn, as a Company message does,
 *   labelled `[scheduled task you set on <date>]` with the User's words
 *   verbatim. It gains no powers: writes still need an approval card or a
 *   standing permission. The model router meters it like any call; when the
 *   model can't be called (no key, a refused key, a demo cap), or the turn
 *   ends unanswered, the run fails. Three failures in a row pause the task.
 *
 * Before either runs, and before any notification goes out, the agent checks
 * that the person it belongs to may still sign in, by the identity it stored
 * and the deployment's lists as they are now. If not, the row is paused,
 * with `SIGNED_OUT` as the reason: no card, no push, no model call, and
 * nothing deleted. Their next signed-in request (after an owner puts them
 * back on a list) starts it again (`resumeSignedIn`).
 */
import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { id as loggedId, literal, plainUnits, reportError, type Units } from "./log";
import type { Card } from "./poppy/wire";
import { formatDate, wallAt } from "./tools/clock";
import { PAUSE_AFTER_FAILURES, ScheduleError, ScheduleStore, type NewSchedule, type Schedule } from "./tools/schedule-store";

import type { PushMessage } from "./web-push";

export type { PushMessage };

/** Why a reminder or task is paused when the person it belongs to was taken off the deployment's lists. */
export const SIGNED_OUT = "this account can no longer sign in";

/** A task's turn: started, or refused before any model call, with why. */
export type TaskStart = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** How a started turn ended. */
export type TaskEnd = { readonly status: "done" | "unanswered"; readonly reason?: string };

export type SchedulerOptions = {
  readonly storage: DurableObjectStorage;
  /** Now, in epoch ms: when rows are due. */
  readonly now: () => number;
  /** When the job queue should wake for a row due at `at`; the same instant in production. */
  readonly jobTime: (at: number) => number;
  readonly showCard: (card: Card) => Promise<void>;
  /** Start a background model turn for a task, or say why the model can't be called. */
  readonly startTask: (text: string, operationId: string) => Promise<TaskStart>;
  /** Wait for a started turn to end. */
  readonly taskEnded: (operationId: string) => Promise<TaskEnd>;
  /** Tell the User's subscribed devices; does nothing when they have none. */
  readonly push: (message: PushMessage) => Promise<void>;
  /** Whether the person this agent belongs to may sign in now, by the deployment's current lists. */
  readonly maySignIn: () => boolean;
  /** Something Activity shows changed. */
  readonly changed: () => void;
  /** Where each run writes its wide event (src/log.ts); `plainUnits` by default. */
  readonly units?: Units;
};

const JOB = "schedule-due";

function jobId(scheduleId: string): string {
  return `schedule:${scheduleId}`;
}

/** Longest text in a card or notification before it is cut. */
const SHORT = 140;

function short(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SHORT ? `${flat.slice(0, SHORT - 1)}…` : flat;
}

/** What the model reads when a task is due: a label, then the User's words as they said them. */
export function taskPrompt(schedule: Schedule): string {
  return `[scheduled task you set on ${formatDate(wallAt(schedule.createdAt, schedule.timeZone))}] ${schedule.text}`;
}

export class Scheduler extends LifecycleCapability {
  readonly store: ScheduleStore;
  readonly #options: SchedulerOptions;
  /** Turns being waited on, by operation id, so each is waited on once per isolate. */
  readonly #waiting = new Map<string, Promise<void>>();

  constructor(options: SchedulerOptions) {
    super("schedules");
    this.#options = options;
    this.store = new ScheduleStore(options.storage.sql, options.now);
  }

  /** A new reminder or task, with its job. Refusals are ScheduleErrors, worded for the model. */
  async create(input: NewSchedule): Promise<{ schedule: Schedule; created: boolean }> {
    const result = this.store.create(input);
    if (result.schedule.status === "active" && result.schedule.nextRun !== null) await this.#arm(result.schedule);
    return result;
  }

  /** Cancel one, and its job; null if there was nothing to cancel. */
  async cancel(id: string): Promise<Schedule | null> {
    const cancelled = this.store.cancel(id);
    if (cancelled) await this.lifecycle.jobs.cancel(jobId(id));
    return cancelled;
  }

  list(): Schedule[] {
    return this.store.list();
  }

  async #arm(schedule: Schedule): Promise<void> {
    await this.lifecycle.jobs.push({
      fn: JOB,
      time: this.#options.jobTime(schedule.nextRun!),
      payload: { id: schedule.id },
      id: jobId(schedule.id),
      singleflight: true
    });
  }

  /** On start: every active row has its job, and runs whose turn was left unsettled are waited on again. */
  override async onStart(): Promise<void> {
    for (const schedule of this.store.list(["active"])) {
      if (schedule.nextRun !== null && !this.lifecycle.jobs.get(jobId(schedule.id))) await this.#arm(schedule);
    }
    const unsettled = this.store.started();
    // After startup, which holds the input gate: a turn can't end while it's held.
    if (unsettled.length) setTimeout(() => unsettled.forEach((run) => this.#settle(run.scheduleId, run.operationId)), 0);
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (job.fn !== JOB) return;
    const id = (job.payload as { id?: unknown })?.id;
    const schedule = typeof id === "string" ? this.store.get(id) : undefined;
    if (!schedule || schedule.status !== "active" || schedule.nextRun === null) return;
    // Woken early (another clock, a stale job): wait for the row's own time.
    if (schedule.nextRun > this.#options.now()) return { rescheduleAt: this.#options.jobTime(schedule.nextRun) };
    const dueAt = schedule.nextRun;
    const units = this.#options.units ?? plainUnits;
    return units.job({ job: literal(JOB), schedule_id: loggedId(schedule.id), schedule_kind: literal(schedule.kind) }, async (event) => {
      if (!this.#maySignIn()) {
        // Taken off the lists: nothing runs, nothing is sent, and the row waits, paused, until they sign in again.
        this.store.pause(schedule.id, SIGNED_OUT);
        this.#options.changed();
        event.set({ outcome: literal("refused"), reason: literal("signed_out") });
        return;
      }
      try {
        await this.#run(schedule);
      } catch (error) {
        event.fail(error);
      }
      const run = this.store.run(`schedule:${schedule.id}:${dueAt}`);
      if (run?.outcome === "failed") event.level = "error";
      else if (run && event.level !== "error") event.set({ outcome: literal(run.outcome === "started" ? "started" : "success"), run: literal(run.outcome) });
      return this.#afterRun(schedule.id, dueAt);
    });
  }

  /** After a run: Activity changed, and the row's next job, if it still has one. */
  #afterRun(id: string, dueAt: number): LifecycleJobOutcome | void {
    this.#options.changed();
    const after = this.store.get(id);
    if (!after || after.status !== "active" || after.nextRun === null) return;
    // A run that failed before the row moved on would wake again at once, and again: end the job instead (onStart re-arms it).
    if (after.nextRun <= dueAt) return;
    return { rescheduleAt: this.#options.jobTime(after.nextRun) };
  }

  async #run(schedule: Schedule): Promise<void> {
    const dueAt = schedule.nextRun!;
    const operationId = `schedule:${schedule.id}:${dueAt}`;
    // An alarm that ran this before, up to a crash: finish moving it on, nothing more.
    if (this.store.run(operationId)) {
      this.store.advance(schedule.id, dueAt, this.store.run(operationId)!.outcome);
      return;
    }
    if (schedule.kind === "reminder") {
      this.store.recordRun(schedule, dueAt, "reminded", operationId);
      this.store.advance(schedule.id, dueAt, "reminded");
      await this.#options.showCard({ id: `reminder-${schedule.id}-${dueAt}`, kind: "notice", company: "", open: true, text: `Reminder: ${schedule.text}` });
      await this.#push({ title: "Reminder", body: short(schedule.text), tag: `reminder-${schedule.id}` });
      return;
    }
    let start: TaskStart;
    try {
      start = await this.#options.startTask(taskPrompt(schedule), operationId);
    } catch (error) {
      start = { ok: false, reason: `The task couldn't be started: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!start.ok) {
      this.store.recordRun(schedule, dueAt, "failed", operationId, start.reason);
      this.store.advance(schedule.id, dueAt, "failed");
      await this.#failed(schedule, dueAt, start.reason);
      return;
    }
    this.store.recordRun(schedule, dueAt, "started", operationId);
    this.store.advance(schedule.id, dueAt, "started");
    this.#settle(schedule.id, operationId);
  }

  /** Wait for a task's turn to end, then record how it went. */
  #settle(scheduleId: string, operationId: string): void {
    if (this.#waiting.has(operationId)) return;
    const units = this.#options.units ?? plainUnits;
    const waiting = units.job({ job: literal("schedule-settle"), schedule_id: loggedId(scheduleId), operation_id: loggedId(operationId) }, async (event) => {
      let end: TaskEnd;
      try {
        end = await this.#options.taskEnded(operationId);
      } catch (error) {
        end = { status: "unanswered", reason: error instanceof Error ? error.message : String(error) };
      }
      const schedule = this.store.get(scheduleId);
      const run = this.store.run(operationId);
      if (!run || run.outcome !== "started") return;
      if (end.status === "done") {
        this.store.finishRun(operationId, "done", null);
        if (schedule) this.store.succeeded(scheduleId, "done");
        await this.#options.showCard({ id: `task-${scheduleId}-${run.dueAt}`, kind: "notice", company: "", open: false, text: `Your scheduled task ran: “${short(run.text)}”` });
        await this.#push({ title: "A scheduled task ran", body: short(run.text), tag: `task-${scheduleId}` });
      } else {
        const reason = end.reason ? `The turn ended without an answer: ${end.reason}` : "The turn ended without an answer";
        this.store.finishRun(operationId, "failed", reason);
        if (schedule) await this.#failed(schedule, run.dueAt, reason);
        event.fail(new Error("The turn ended without an answer"), { code: literal("unanswered") });
      }
      this.#options.changed();
    })
      // Recorded on the job's event already.
      .catch(() => undefined)
      .finally(() => this.#waiting.delete(operationId));
    this.#waiting.set(operationId, waiting);
  }

  /** Whether the person may sign in now; a check that can't be made (a config error) counts as no. */
  #maySignIn(): boolean {
    try {
      return this.#options.maySignIn();
    } catch (error) {
      reportError(error, { source: literal("schedules.sign_in_check") });
      return false;
    }
  }

  /**
   * After a signed-in request: start again, with their jobs, the rows paused
   * because the person couldn't sign in, if they can now. Returns how many.
   */
  async resumeSignedIn(): Promise<number> {
    if (!this.#maySignIn()) return 0;
    const resumed = this.store.resume(SIGNED_OUT);
    for (const schedule of resumed) if (schedule.nextRun !== null) await this.#arm(schedule);
    return resumed.length;
  }

  /** Count a failed run; at the third in a row, pause the task, cancel its job and say so. */
  async #failed(schedule: Schedule, dueAt: number, reason: string): Promise<void> {
    const paused = this.store.failed(schedule.id, "failed");
    await this.#options.showCard({
      id: `error-schedule-${schedule.id}-${dueAt}`,
      kind: "notice",
      company: "",
      open: false,
      text: `Your scheduled task “${short(schedule.text)}” didn't run: ${reason}`
    });
    if (!paused) return;
    await this.lifecycle.jobs.cancel(jobId(schedule.id));
    await this.#options.showCard({
      id: `paused-${schedule.id}`,
      kind: "notice",
      company: "",
      open: true,
      text: `Paused your scheduled task “${short(schedule.text)}” after ${PAUSE_AFTER_FAILURES} failed runs in a row. Cancel it in Settings, and ask your agent to set it up again once it can run.`
    });
    await this.#push({ title: "A scheduled task was paused", body: short(schedule.text), tag: `task-${schedule.id}` });
  }

  async #push(message: PushMessage): Promise<void> {
    // Never to the devices of someone who can no longer sign in.
    if (!this.#maySignIn()) return;
    try {
      await this.#options.push(message);
    } catch (error) {
      // A notification that didn't go is never a failed run.
      reportError(error, { source: literal("web_push"), severe: false });
    }
  }

  /** Tests: wait for every turn being waited on to be recorded. */
  async settledForTests(): Promise<void> {
    while (this.#waiting.size) await Promise.all([...this.#waiting.values()]);
  }
}

export { ScheduleError };
