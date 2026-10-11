import type { ActivityAccess, ActivityChannel, ActivityEntry, ActivityResult } from "../poppy/wire";

/** The page's words for how the agent reached a Company. */
export const HOW: Record<ActivityChannel, string> = {
  api: "API",
  company_agent: "their agent",
  website: "website",
  sign_in: "sign-in",
  direct: "you, directly"
};

export const ACCESS: Record<ActivityAccess, string> = {
  view: "View",
  view_and_change: "View and change"
};

export const DECIDED: Record<NonNullable<ActivityEntry["decidedBy"]>, string> = {
  you: "You",
  standing_permission: "Standing permission"
};

export const RESULT: Record<ActivityResult, string> = {
  waiting: "Waiting for you",
  in_progress: "In progress",
  done: "Done",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Failed",
  unknown: "Outcome unknown"
};

/** What a scope string lets the agent do, in plain words; null when only Company-defined scopes say. */
export function accessOfScope(scope: string): ActivityAccess | null {
  const scopes = new Set(scope.split(" ").filter(Boolean));
  if (scopes.has("poppy:write")) return "view_and_change";
  if (scopes.has("poppy:read")) return "view";
  return null;
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "14:05" today, "Mon 14:05" this week, "3 Oct, 14:05" before. */
export function when(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, new Date(now))) return time;
  if (now - at < 6 * 24 * 60 * 60_000) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

/** A full date and time, for a tooltip or `title`. */
export function fullDate(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "4:05" left, or "1:02:05" for longer. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "just now", "3 min ago", "2 h ago", then a date. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return when(at, now);
}

export function untilDate(at: number | null): string {
  return at === null ? "No end date" : new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
