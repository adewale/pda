import { useCallback, useEffect, useState } from "react";
import { Action } from "./controls";

/**
 * Settings' Scheduled section: the reminders and tasks the User has asked
 * for (src/schedules.ts), from `GET /api/schedules`, each with what, when
 * next, how it repeats and its status, and a Cancel button. A one-off
 * that failed (a reminder that couldn't be shown, a task that didn't run)
 * stays listed, saying so, with Dismiss in place of Cancel. The page talks
 * to the person's own agent through the Worker, same origin only.
 */

export type ScheduledItem = {
  readonly id: string;
  readonly kind: "reminder" | "task";
  readonly text: string;
  readonly nextRun: number | null;
  readonly repeats: string;
  readonly timeZone: string;
  readonly status: "active" | "paused" | "done" | "failed" | "cancelled";
  readonly failures: number;
  readonly lastRun: number | null;
  readonly lastOutcome: string | null;
  /** Why it is paused, when failed runs didn't pause it. */
  readonly pausedReason?: string | null;
  /** Tries at showing a reminder that failed: those of a retry waiting, or all of a failed one's. */
  readonly attempts?: number;
  /** When the reminder being tried again was due; null when none is. */
  readonly retryDue?: number | null;
};

type Items = { state: "loading" } | { state: "ready"; items: ScheduledItem[]; limit: number } | { state: "unavailable" };

const KIND: Record<ScheduledItem["kind"], string> = { reminder: "Reminder", task: "Task" };

/** A time in the item's own zone, so "09:00" reads as the User asked for it. */
function moment(item: ScheduledItem, at: number): string {
  try {
    return new Date(at).toLocaleString(undefined, { timeZone: item.timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace("T", " ");
  }
}

function nextRun(item: ScheduledItem): string {
  return item.nextRun === null ? "Not scheduled" : moment(item, item.nextRun);
}

/** A failed one-off, or a reminder whose card is being tried again: shown as a problem. */
function troubled(item: ScheduledItem): boolean {
  return item.status === "paused" || item.status === "failed" || (item.retryDue ?? null) !== null;
}

function status(item: ScheduledItem): string {
  if (item.status === "failed" && item.kind === "reminder") return `Didn't reach you: it couldn't be shown after ${item.attempts ?? 0} tries`;
  if (item.status === "failed") return "Didn't run: Activity says why";
  if (item.retryDue != null) return `Couldn't be shown at ${moment(item, item.retryDue)}; trying again at ${nextRun(item)} (${item.timeZone})`;
  if (item.status === "paused" && item.pausedReason) return `Paused: ${item.pausedReason}`;
  if (item.status === "paused") return `Paused after ${item.failures} failed runs in a row`;
  const repeat = item.repeats === "once" ? "Once" : item.repeats.charAt(0).toUpperCase() + item.repeats.slice(1);
  const missed = item.kind === "reminder" && item.lastOutcome === "failed" ? " · the last one couldn't be shown" : "";
  return `${repeat} · next ${nextRun(item)} (${item.timeZone})${missed}`;
}

export function ScheduledSettings() {
  const [items, setItems] = useState<Items>({ state: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/schedules", { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { schedules: ScheduledItem[]; limit: number };
      setItems({ state: "ready", items: body.schedules, limit: body.limit });
    } catch {
      setItems({ state: "unavailable" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/schedules/${id}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok && response.status !== 404) throw new Error(String(response.status));
      await load();
    } catch {
      setError("Your agent couldn't cancel that just now. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (items.state === "loading") {
    return (
      <p role="status" className="rounded-xl p-4 text-base text-kumo-subtle ring ring-kumo-hairline">
        Loading your reminders and tasks
      </p>
    );
  }
  if (items.state === "unavailable") {
    return <p className="rounded-xl p-4 text-base text-pretty text-kumo-subtle ring ring-kumo-hairline">Your reminders and tasks couldn't be loaded. Reload the page to try again.</p>;
  }
  const active = items.items.filter((item) => item.status === "active").length;
  return (
    <div className="space-y-3">
      {items.items.length === 0 ? (
        <p className="rounded-xl p-4 text-base text-pretty text-kumo-subtle ring ring-kumo-hairline">
          Nothing scheduled. Ask your agent, for example “Remind me at 5pm to call the bank” or “Every weekday at 9, check whether my print order has shipped”.
        </p>
      ) : (
        <ul aria-label="Your reminders and tasks" className="divide-y divide-kumo-hairline rounded-xl ring ring-kumo-hairline">
          {items.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-base text-pretty break-words">
                  <span className="mr-2 text-[13px] font-medium text-kumo-subtle">{KIND[item.kind]}</span>
                  {item.text}
                </p>
                <p className={troubled(item) ? "mt-0.5 text-[13px] text-kumo-danger" : "mt-0.5 text-[13px] text-kumo-subtle"}>{status(item)}</p>
              </div>
              <Action
                variant="secondary"
                disabled={busy}
                aria-label={`${item.status === "failed" ? "Dismiss" : "Cancel"} ${KIND[item.kind].toLowerCase()}: ${item.text.slice(0, 80)}`}
                onClick={() => void cancel(item.id)}
              >
                {item.status === "failed" ? "Dismiss" : "Cancel"}
              </Action>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] text-pretty text-kumo-subtle">
        {active} of {items.limit} waiting. A reminder shows in the chat at its time, and on devices where notifications are on; one that can't be shown is tried again after 1, 5 and 30 minutes. A task runs your agent in the background, as a model call on your key or the demo, and needs your approval for anything it changes. A task that fails three runs in a row is paused.
      </p>
      {error ? (
        <p role="alert" className="text-[13px] text-kumo-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
