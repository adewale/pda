/**
 * The `now` and `date_math` tools' arithmetic: dates and times in an IANA
 * time zone, with the time zone database the runtime's `Intl` carries. Pure:
 * no Worker APIs, so the property tests run it in Node.
 *
 * - A **date** (`2026-10-12`) is a calendar day, with no time zone: adding
 *   days counts calendar days.
 * - A **moment** (`2026-10-12T09:30`, `…Z`, `…+01:00`, or `now`) is an
 *   instant, shown as wall-clock time in a zone. Years, months, weeks and
 *   days move the wall-clock date (so 09:00 stays 09:00 across a clock
 *   change); hours, minutes and seconds are elapsed time.
 * - Months are added the way calendars do: 31 January plus one month is the
 *   last day of February. Years and months go first, then weeks and days,
 *   then the time, in the order RFC 5545 and Temporal use.
 * - A wall-clock time a clock change skips (02:30 on the night clocks go
 *   forward) moves forward by the gap; one that happens twice takes the
 *   earlier, as Temporal's "compatible" choice does.
 */

export class TimeError extends Error {
  override name = "TimeError";
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const DAY_MS = 86_400_000;
export const MIN_YEAR = 1;
export const MAX_YEAR = 9999;

// ---------------------------------------------------------------- Calendar days

/** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil). */
export function dayNumber(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The date of a day number (civil_from_days). */
export function civil(days: number): CalendarDate {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

export function daysInMonth(year: number, month: number): number {
  return dayNumber(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - dayNumber(year, month, 1);
}

export type CalendarDate = { readonly year: number; readonly month: number; readonly day: number };

export function weekday(date: CalendarDate): (typeof WEEKDAYS)[number] {
  // 1970-01-01 was a Thursday.
  return WEEKDAYS[(((dayNumber(date.year, date.month, date.day) + 3) % 7) + 7) % 7]!;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatDate(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

function checkYear(date: CalendarDate): CalendarDate {
  if (date.year < MIN_YEAR || date.year > MAX_YEAR) throw new TimeError(`Dates go from year ${MIN_YEAR} to ${MAX_YEAR}`);
  return date;
}

/** `date` plus `months` calendar months, the day kept or, past the month's end, its last day. */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  return checkYear({ year, month, day: Math.min(date.day, daysInMonth(year, month)) });
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return checkYear(civil(dayNumber(date.year, date.month, date.day) + days));
}

// ---------------------------------------------------------------- Time zones

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      era: "short"
    });
    formatters.set(zone, found);
  }
  return found;
}

/** An IANA time zone name, as the runtime spells it, or a TimeError. */
export function checkZone(zone: string): string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) {
    throw new TimeError(`${JSON.stringify(zone)} isn't an IANA time zone name, such as Europe/London`);
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw new TimeError(`${JSON.stringify(zone)} isn't an IANA time zone name, such as Europe/London`);
  }
}

export type WallTime = CalendarDate & { readonly hour: number; readonly minute: number; readonly second: number; readonly millisecond: number };

/** The wall-clock time in `zone` at `instant` (epoch ms). */
export function wallAt(instant: number, zone: string): WallTime {
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(instant))) parts[part.type] = part.value;
  const year = Number(parts.year);
  return {
    year: parts.era === "BC" || parts.era === "B" ? 1 - year : year,
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    millisecond: ((instant % 1000) + 1000) % 1000
  };
}

function wallMs(wall: WallTime): number {
  return dayNumber(wall.year, wall.month, wall.day) * DAY_MS + ((wall.hour * 60 + wall.minute) * 60 + wall.second) * 1000 + wall.millisecond;
}

/**
 * Seconds `zone` is ahead of UTC at `instant`. Whole seconds, not minutes:
 * before standard time, many zones' offsets had seconds (St John's was
 * 3:30:52 behind until 1935).
 */
export function offsetSeconds(instant: number, zone: string): number {
  return Math.round((wallMs(wallAt(instant, zone)) - instant) / 1000);
}

/** The instant a wall-clock time in `zone` names: the earlier of two, or past a skipped hour by its length. */
export function instantOf(wall: WallTime, zone: string): number {
  const local = wallMs(wall);
  const candidates = new Set<number>();
  for (const probe of [local - DAY_MS, local, local + DAY_MS]) candidates.add(local - offsetSeconds(probe, zone) * 1000);
  const matching = [...candidates].filter((instant) => wallMs(wallAt(instant, zone)) === local).sort((a, b) => a - b);
  if (matching.length > 0) return matching[0]!;
  // Skipped by a clock change: read it with the offset from before the change, which lands after the gap.
  return local - offsetSeconds(local - DAY_MS, zone) * 1000;
}

/** `+01:00`, or `-03:30:52` for an offset with seconds. */
function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const size = Math.abs(seconds);
  const rest = size % 60;
  return `${sign}${pad(Math.floor(size / 3600))}:${pad(Math.floor(size / 60) % 60)}${rest ? `:${pad(rest)}` : ""}`;
}

export type MomentView = {
  readonly date: string;
  readonly time: string;
  readonly weekday: string;
  readonly time_zone: string;
  readonly utc_offset: string;
  /** ISO 8601 with the zone's offset. */
  readonly iso: string;
  readonly utc: string;
};

export function viewMoment(instant: number, zone: string): MomentView {
  if (!Number.isFinite(instant)) throw new TimeError("That's outside the dates this can work with");
  const wall = wallAt(instant, zone);
  checkYear(wall);
  const offset = formatOffset(offsetSeconds(instant, zone));
  const time = `${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
  return {
    date: formatDate(wall),
    time,
    weekday: weekday(wall),
    time_zone: zone,
    utc_offset: offset,
    iso: `${formatDate(wall)}T${time}${offset}`,
    utc: new Date(instant - (instant % 1000)).toISOString().replace(".000Z", "Z")
  };
}

// ---------------------------------------------------------------- Inputs

export type Duration = {
  readonly years: number;
  readonly months: number;
  readonly weeks: number;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
};

const UNITS = ["years", "months", "weeks", "days", "hours", "minutes", "seconds"] as const;
/** Largest amount of each unit: about ten thousand years of it. */
const UNIT_LIMIT: Record<(typeof UNITS)[number], number> = {
  years: 10_000,
  months: 120_000,
  weeks: 530_000,
  days: 3_700_000,
  hours: 88_000_000,
  minutes: 5_300_000_000,
  seconds: 320_000_000_000
};

export const ZERO: Duration = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };

/** An ISO 8601 duration (`P1Y2M3W4DT5H6M7S`, `-P2D`) or an object of whole numbers per unit. */
export function parseDuration(input: unknown): Duration {
  let fields: Record<string, unknown>;
  if (typeof input === "string") {
    const match = /^([+-])?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(input.trim());
    if (!match || input.trim().toUpperCase().endsWith("T") || match.slice(2).every((part) => part === undefined)) {
      throw new TimeError(`${JSON.stringify(input)} isn't an ISO 8601 duration such as P1D, P2W, P1M or PT3H30M`);
    }
    const sign = match[1] === "-" ? -1 : 1;
    fields = Object.fromEntries(UNITS.map((unit, index) => [unit, sign * Number(match[index + 2] ?? 0)]));
  } else if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    fields = input as Record<string, unknown>;
    const unknown = Object.keys(fields).filter((key) => !(UNITS as readonly string[]).includes(key));
    if (unknown.length) throw new TimeError(`Unknown unit ${unknown.map((key) => JSON.stringify(key)).join(", ")}; the units are ${UNITS.join(", ")}`);
  } else {
    throw new TimeError("A duration is an ISO 8601 string (P1D) or an object such as { \"days\": 3 }");
  }
  const out: Record<string, number> = {};
  for (const unit of UNITS) {
    const value = fields[unit] ?? 0;
    if (typeof value !== "number" || !Number.isInteger(value)) throw new TimeError(`${unit} must be a whole number`);
    if (Math.abs(value) > UNIT_LIMIT[unit]) throw new TimeError(`${unit} goes up to ${UNIT_LIMIT[unit]}`);
    out[unit] = value === 0 ? 0 : value;
  }
  return out as Duration;
}

export function negate(duration: Duration): Duration {
  return Object.fromEntries(UNITS.map((unit) => [unit, duration[unit] === 0 ? 0 : -duration[unit]])) as Duration;
}

export type Moment = { readonly kind: "date"; readonly date: CalendarDate } | { readonly kind: "instant"; readonly instant: number };

/** `now`, `today`, a date, or a date and time with or without an offset (read in `zone` without one). */
export function parseMoment(text: string, zone: string, now: number): Moment {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (/^now$/i.test(trimmed)) return { kind: "instant", instant: now };
  if (/^today$/i.test(trimmed)) return { kind: "date", date: wallAt(now, zone) };
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (date) return { kind: "date", date: checkDate(Number(date[1]), Number(date[2]), Number(date[3]), trimmed) };
  const moment = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(trimmed);
  if (!moment) {
    throw new TimeError(`${JSON.stringify(text)} isn't a date (2026-10-12), a date and time (2026-10-12T09:30, optionally with Z or +01:00), "today" or "now"`);
  }
  const day = checkDate(Number(moment[1]), Number(moment[2]), Number(moment[3]), trimmed);
  const hour = Number(moment[4]);
  const minute = Number(moment[5]);
  const second = Number(moment[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) throw new TimeError(`${JSON.stringify(text)} has a time that doesn't exist`);
  const wall: WallTime = { ...day, hour, minute, second, millisecond: Number((moment[7] ?? "0").padEnd(3, "0")) };
  const offset = moment[8];
  if (offset === undefined) return { kind: "instant", instant: instantOf(wall, zone) };
  if (/^z$/i.test(offset)) return { kind: "instant", instant: wallMs(wall) };
  const sign = offset[0] === "-" ? -1 : 1;
  const digits = offset.slice(1).replace(":", "");
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
  if (minutes > 18 * 60) throw new TimeError(`${offset} isn't a UTC offset`);
  return { kind: "instant", instant: wallMs(wall) - sign * minutes * 60_000 };
}

function checkDate(year: number, month: number, day: number, text: string): CalendarDate {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new TimeError(`${JSON.stringify(text)} is a date that doesn't exist`);
  return checkYear({ year, month, day });
}

// ---------------------------------------------------------------- Arithmetic

/** `date` plus a duration's calendar part. Time units on a date are refused: a date has no time. */
export function addToDate(date: CalendarDate, duration: Duration): CalendarDate {
  if (duration.hours || duration.minutes || duration.seconds) {
    throw new TimeError("A date has no time of day, so hours, minutes and seconds can't be added to it; give a date and time instead");
  }
  return addDays(addMonths(date, duration.years * 12 + duration.months), duration.weeks * 7 + duration.days);
}

/** `instant` plus a duration: the calendar part on the wall clock in `zone`, then the time part as elapsed time. */
export function addToInstant(instant: number, duration: Duration, zone: string): number {
  let at = instant;
  if (duration.years || duration.months || duration.weeks || duration.days) {
    const wall = wallAt(instant, zone);
    const date = addToDate(wall, { ...duration, hours: 0, minutes: 0, seconds: 0 });
    at = instantOf({ ...wall, ...date }, zone);
  }
  const result = at + ((duration.hours * 60 + duration.minutes) * 60 + duration.seconds) * 1000;
  checkYear(wallAt(result, zone));
  return result;
}

/** Years, months and days from `from` to `to`, largest units first, so that `from` plus them is `to`. All the same sign. */
export function dateDifference(from: CalendarDate, to: CalendarDate): { years: number; months: number; days: number; total_days: number; weeks: number; weekdays_left: number } {
  const start = dayNumber(from.year, from.month, from.day);
  const end = dayNumber(to.year, to.month, to.day);
  const total = end - start;
  const sign = total < 0 ? -1 : 1;
  let months = (to.year * 12 + to.month) - (from.year * 12 + from.month);
  const past = (date: CalendarDate) => sign * (dayNumber(date.year, date.month, date.day) - end) > 0;
  while (months !== 0 && past(addMonths(from, months))) months -= sign;
  const after = addMonths(from, months);
  const days = end - dayNumber(after.year, after.month, after.day);
  const zero = (value: number) => (value === 0 ? 0 : value);
  return {
    years: zero(Math.trunc(months / 12)),
    months: zero(months % 12),
    days: zero(days),
    total_days: zero(total),
    weeks: zero(Math.trunc(total / 7)),
    weekdays_left: zero(total % 7)
  };
}

/** Elapsed time between two instants. */
export function instantDifference(from: number, to: number): { total_seconds: number; days: number; hours: number; minutes: number; seconds: number } {
  const totalSeconds = Math.trunc((to - from) / 1000);
  const sign = totalSeconds < 0 ? -1 : 1;
  let rest = Math.abs(totalSeconds);
  const days = Math.floor(rest / 86_400);
  rest -= days * 86_400;
  const hours = Math.floor(rest / 3600);
  rest -= hours * 3600;
  const minutes = Math.floor(rest / 60);
  const zero = (value: number) => (value === 0 ? 0 : value);
  return { total_seconds: zero(totalSeconds), days: zero(sign * days), hours: zero(sign * hours), minutes: zero(sign * minutes), seconds: zero(sign * (rest - minutes * 60)) };
}

function sumDurations(a: Duration, b: Duration): Duration {
  return parseDuration(Object.fromEntries(UNITS.map((unit) => [unit, a[unit] + b[unit]])));
}

export type DateMathInput = {
  readonly start?: string;
  readonly add?: unknown;
  readonly subtract?: unknown;
  readonly until?: string;
};

export type DateView = { readonly date: string; readonly weekday: string };

export type DateMathResult = {
  readonly time_zone: string;
  readonly start: DateView | MomentView;
  readonly result?: DateView | MomentView;
  readonly until?: DateView | MomentView;
  readonly difference?: ReturnType<typeof dateDifference> | ReturnType<typeof instantDifference>;
};

function viewDate(date: CalendarDate): DateView {
  return { date: formatDate(date), weekday: weekday(date) };
}

/**
 * `start` (default now) plus `add` and minus `subtract`, and/or the difference
 * from `start` to `until`. A date with a date stays a date; with a moment,
 * the date means its midnight in `zone`.
 */
export function dateMath(input: DateMathInput, zone: string, now: number): DateMathResult {
  const start = parseMoment(input.start ?? "now", zone, now);
  const plus = input.add === undefined ? ZERO : parseDuration(input.add);
  const minus = input.subtract === undefined ? ZERO : parseDuration(input.subtract);
  const change = sumDurations(plus, negate(minus));
  const asInstant = (moment: Moment) =>
    moment.kind === "instant" ? moment.instant : instantOf({ ...moment.date, hour: 0, minute: 0, second: 0, millisecond: 0 }, zone);
  const view = (moment: Moment) => (moment.kind === "date" ? viewDate(moment.date) : viewMoment(moment.instant, zone));
  let result: Moment | undefined;
  if (input.add !== undefined || input.subtract !== undefined) {
    result =
      start.kind === "date" && !change.hours && !change.minutes && !change.seconds
        ? { kind: "date", date: addToDate(start.date, change) }
        : { kind: "instant", instant: addToInstant(asInstant(start), change, zone) };
  }
  let until: Moment | undefined;
  let difference: DateMathResult["difference"];
  if (input.until !== undefined) {
    until = parseMoment(input.until, zone, now);
    const from = result ?? start;
    difference =
      from.kind === "date" && until.kind === "date"
        ? dateDifference(from.date, until.date)
        : instantDifference(asInstant(from), asInstant(until));
  }
  if (!result && !until) throw new TimeError("Give add or subtract, or until, or both");
  return {
    time_zone: zone,
    start: view(start),
    ...(result ? { result: view(result) } : {}),
    ...(until ? { until: view(until), difference } : {})
  };
}
