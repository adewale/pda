/**
 * The one logger. Every unit of work emits one wide event (a canonical log
 * line) when it ends, in a `finally`: an HTTP request (`http`), an agent
 * turn (`turn`), a job or background run (`job`), or a page frame that does
 * work (`ws`). Sub-steps (model calls, tool calls, Poppy requests, pushes,
 * cards) add to the event of the unit they run in, found through
 * `AsyncLocalStorage` or handed over explicitly; nothing else writes to the
 * console. See docs/decisions.md §30 and the spec's Observability section.
 *
 * Two levels, `info` and `error`. Each event is one structured object, with
 * snake_case fields and the deployment's environment (service, version,
 * commit, compatibility date), which Workers Logs indexes field by field.
 *
 * Privacy is by construction: fields are counts, enums, ids the agent made,
 * Company issuer origins, route templates and error codes. Never message or
 * page text, summaries, tool arguments' free text, tokens, keys, codes,
 * assertions, emails, names, photo bytes or URLs with queries. Error
 * messages go through `redact` first. Portable (no Worker APIs), so the
 * Poppy client still runs in Node for the interop harness.
 */
import { AsyncLocalStorage } from "node:async_hooks";

declare const __DPA_COMMIT__: string | undefined;
declare const __DPA_COMPATIBILITY_DATE__: string | undefined;

export const SERVICE = "personal-agent";

export type Level = "info" | "error";
export type EventKind = "http" | "turn" | "job" | "ws";

/** An error as an event records it: its class, a short code, and a redacted message. */
export type LoggedError = { readonly type: string; readonly code?: string; readonly message?: string; readonly step?: string };

type Fields = Record<string, unknown>;

/** The most errors, issuers and tool calls one event keeps; the rest are counted, not listed. */
export const LIMITS = { errors: 10, issuers: 10, toolCalls: 30, statuses: 20 } as const;

// ---------------------------------------------------------------- Environment

const environment: Fields = {
  service: SERVICE,
  version_id: "unknown",
  version_tag: null,
  commit: typeof __DPA_COMMIT__ === "string" && __DPA_COMMIT__ ? __DPA_COMMIT__ : "unknown",
  compatibility_date: typeof __DPA_COMPATIBILITY_DATE__ === "string" && __DPA_COMPATIBILITY_DATE__ ? __DPA_COMPATIBILITY_DATE__ : "unknown"
};

/** The deployment's version, from the `CF_VERSION_METADATA` binding. Called by the Worker and each agent at startup; idempotent. */
export function configureLog(env: { readonly CF_VERSION_METADATA?: { readonly id?: string; readonly tag?: string } }): void {
  const metadata = env.CF_VERSION_METADATA;
  if (typeof metadata?.id === "string" && metadata.id) environment.version_id = metadata.id;
  if (typeof metadata?.tag === "string" && metadata.tag) environment.version_tag = metadata.tag;
}

/** The environment every event carries. */
export function environmentFields(): Readonly<Fields> {
  return { ...environment };
}

// ---------------------------------------------------------------- Redaction

const SHORT_TOKEN = /^[A-Za-z0-9_.:\-]{1,64}$/;

/** A short machine token (an error code, a grant, a state name), or undefined. */
export function code(value: unknown): string | undefined {
  return typeof value === "string" && SHORT_TOKEN.test(value) ? value : undefined;
}

/**
 * Free text made safe to log: URLs cut to their origin, emails, quoted text,
 * credentials after an auth scheme, and long token-like runs replaced, then
 * cut to 200 characters. Used only for error messages, which are our own
 * words around values we can't vouch for.
 */
export function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`)\]]+/gi, (url) => (URL.canParse(url) && new URL(url).origin !== "null" ? new URL(url).origin : "[url]"))
    .replace(/[^\s@"'<>()[\]]+@[^\s@"'<>()[\]]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/“[^”]*”|‘[^’]*’|"[^"]*"|'[^'\s][^']*'|`[^`]*`/g, "[text]")
    .replace(/\b(Bearer|DPoP|Basic)\s+\S+/gi, "$1 [secret]")
    .replace(/[A-Za-z0-9_\-+/=~]{24,}/g, "[secret]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** An error as fields: its class name, its code when it has a short one, and its message redacted. */
export function errorFields(error: unknown, extra: { readonly code?: string; readonly step?: string } = {}): LoggedError {
  const type = error instanceof Error ? error.name || "Error" : typeof error === "string" ? "Message" : typeof error;
  const own = code(extra.code) ?? code((error as { code?: unknown } | null)?.code);
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return {
    type: code(type) ?? "Error",
    ...(own ? { code: own } : {}),
    ...(message ? { message: redact(message) } : {}),
    ...(extra.step && code(extra.step) ? { step: extra.step } : {})
  };
}

// ---------------------------------------------------------------- The event

/** One Poppy exchange, from the protocol log's allowlisted row. */
export type PoppyExchange = {
  readonly issuer: string | null;
  readonly step: string;
  readonly status: number | null;
  readonly error: string | null;
  readonly outcome: string;
};

type StepTally = { count: number; status: Record<string, number>; errors: Record<string, number> };

/** A tool call as a turn records it: never its arguments or result text. */
export type ToolCall = {
  name: string;
  outcome: string;
  duration_ms: number;
  error_code?: string;
  issuers?: string[];
  held?: boolean;
};

export type EventOptions = {
  /** Called with each emitted line: the agent keeps its own (its diagnostics). */
  readonly sink?: (line: string, event: WideEvent) => void;
};

/** A unit of work's event: fields are added while it runs, and it is written once, when it ends. */
export class WideEvent {
  readonly kind: EventKind;
  readonly started = Date.now();
  readonly fields: Fields = {};
  readonly errors: LoggedError[] = [];
  level: Level = "info";
  #errorCount = 0;
  #poppy: { requests: number; failed: number; issuers: Set<string>; steps: Record<string, StepTally> } | null = null;
  #emitted: string | null = null;
  readonly #sink: EventOptions["sink"];

  constructor(kind: EventKind, fields: Fields = {}, options: EventOptions = {}) {
    this.kind = kind;
    this.#sink = options.sink;
    Object.assign(this.fields, fields);
  }

  get emitted(): boolean {
    return this.#emitted !== null;
  }

  set(fields: Fields): this {
    Object.assign(this.fields, fields);
    return this;
  }

  /** Add `by` to a numeric field, made at zero. A dotted name counts inside an object field. */
  count(name: string, by = 1): this {
    const [head, tail] = name.split(".", 2) as [string, string | undefined];
    if (tail === undefined) {
      this.fields[head] = (typeof this.fields[head] === "number" ? (this.fields[head] as number) : 0) + by;
      return this;
    }
    const inner = (typeof this.fields[head] === "object" && this.fields[head] !== null ? this.fields[head] : (this.fields[head] = {})) as Fields;
    inner[tail] = (typeof inner[tail] === "number" ? (inner[tail] as number) : 0) + by;
    return this;
  }

  /**
   * Record an error. `severe` (the default) makes the event level `error`;
   * a handled failure the unit survived (a push that didn't go) is kept at
   * the event's level.
   */
  fail(error: unknown, extra: { readonly code?: string; readonly step?: string; readonly severe?: boolean } = {}): this {
    this.#errorCount++;
    if (this.errors.length < LIMITS.errors) this.errors.push(errorFields(error, extra));
    if (extra.severe !== false) this.level = "error";
    return this;
  }

  /** One Poppy exchange (from the protocol log's row): counted by step, status and error code, with its issuer. */
  poppy(exchange: PoppyExchange): this {
    const tally = (this.#poppy ??= { requests: 0, failed: 0, issuers: new Set(), steps: {} });
    tally.requests++;
    if (exchange.outcome === "error" || exchange.outcome === "failed" || exchange.outcome === "refused") tally.failed++;
    if (exchange.issuer && tally.issuers.size < LIMITS.issuers) tally.issuers.add(exchange.issuer);
    const step = (tally.steps[exchange.step] ??= { count: 0, status: {}, errors: {} });
    step.count++;
    const status = exchange.status === null ? "none" : String(exchange.status);
    if (Object.keys(step.status).length < LIMITS.statuses || status in step.status) step.status[status] = (step.status[status] ?? 0) + 1;
    const error = code(exchange.error);
    if (error && (Object.keys(step.errors).length < LIMITS.statuses || error in step.errors)) step.errors[error] = (step.errors[error] ?? 0) + 1;
    return this;
  }

  /** The Poppy issuers this unit dealt with so far. */
  get issuers(): string[] {
    return [...(this.#poppy?.issuers ?? [])];
  }

  /** The record, as it would be written now. */
  record(level: Level = this.level): Fields {
    const outcome = typeof this.fields.outcome === "string" ? this.fields.outcome : level === "error" ? "error" : "success";
    const poppy = this.#poppy
      ? {
          poppy: {
            requests: this.#poppy.requests,
            failed: this.#poppy.failed,
            issuers: [...this.#poppy.issuers],
            steps: this.#poppy.steps
          },
          // One string, for `contains(poppy_issuers, "…")` in the Query Builder.
          poppy_issuers: [...this.#poppy.issuers].join(" ")
        }
      : {};
    return {
      timestamp: new Date(this.started).toISOString(),
      level,
      kind: this.kind,
      ...environment,
      ...this.fields,
      ...poppy,
      ...(this.errors.length ? { error: this.errors[0], errors: this.errors, error_count: this.#errorCount } : {}),
      outcome,
      duration_ms: Math.max(0, Date.now() - this.started)
    };
  }

  /** Write the event, once: later calls return the line already written. */
  emit(level: Level = this.level): string {
    if (this.#emitted !== null) return this.#emitted;
    const record = this.record(level);
    const line = JSON.stringify(record);
    this.#emitted = line;
    // One structured object per call: Workers Logs indexes its fields.
    if (record.level === "error") console.error(record);
    else console.log(record);
    try {
      this.#sink?.(line, this);
    } catch {
      // Keeping a copy must never fail the work it describes.
    }
    return line;
  }
}

/** A new event for a unit of work. */
export function wideEvent(kind: EventKind, fields: Fields = {}, options: EventOptions = {}): WideEvent {
  return new WideEvent(kind, fields, options);
}

/** Write `event`, once. */
export function emit(event: WideEvent, level?: Level): string {
  return event.emit(level);
}

// ---------------------------------------------------------------- The current unit

type Scope = { readonly event: WideEvent; readonly tool?: ToolCall };

const scopes = new AsyncLocalStorage<Scope>();

/** Run `fn` as part of `event`: sub-steps it makes add to that event. */
export function inScope<T>(event: WideEvent, fn: () => T, tool?: ToolCall): T {
  return scopes.run(tool ? { event, tool } : { event }, fn);
}

/** The event of the unit of work running now, if any. */
export function currentEvent(): WideEvent | undefined {
  return scopes.getStore()?.event;
}

/** The tool call running now, if any. */
export function currentTool(): ToolCall | undefined {
  return scopes.getStore()?.tool;
}

/**
 * Run `fn` as one unit of work: its event is written when it ends, at
 * level error if it threw (and the error is thrown on).
 */
export async function unit<T>(event: WideEvent, fn: (event: WideEvent) => Promise<T>): Promise<T> {
  try {
    return await inScope(event, () => fn(event));
  } catch (error) {
    event.fail(error);
    throw error;
  } finally {
    event.emit();
  }
}

/**
 * How a part of the agent starts a unit of work: the agent's own log
 * (src/agent-log.ts) adds its id and keeps a copy of each event; `plainUnits`
 * only writes them.
 */
export interface Units {
  /** A Lifecycle job or another background run. */
  job<T>(fields: Fields, fn: (event: WideEvent) => Promise<T>): Promise<T>;
  /** A page frame that does work. */
  frame<T>(type: string, fields: Fields, fn: (event: WideEvent) => Promise<T>): Promise<T>;
  /** A request the Worker forwarded to the agent (the Direct Sign-In callback). */
  request<T>(fields: Fields, fn: (event: WideEvent) => Promise<T>): Promise<T>;
}

export const plainUnits: Units = {
  job: (fields, fn) => unit(wideEvent("job", fields), fn),
  frame: (type, fields, fn) => unit(wideEvent("ws", { frame: type, ...fields }), fn),
  request: (fields, fn) => unit(wideEvent("http", fields), fn)
};

// ---------------------------------------------------------------- Sub-steps, from anywhere

/** A Poppy exchange, for the unit running now (the protocol log calls this for each row it writes). */
export function recordPoppyExchange(exchange: PoppyExchange): void {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.event.poppy(exchange);
  if (scope.tool && exchange.issuer) {
    const issuers = (scope.tool.issuers ??= []);
    if (!issuers.includes(exchange.issuer) && issuers.length < 3) issuers.push(exchange.issuer);
  }
}

/** A card shown on the User's page: approvals are counted, and a tool that asked for one is held for the User. */
export function recordCard(card: { readonly kind: string; readonly open?: boolean; readonly status?: string }): void {
  const scope = scopes.getStore();
  if (!scope) return;
  const asks = card.open !== false && (card.kind === "approval" || card.kind === "operation" || card.kind.startsWith("signin"));
  if (!asks) return;
  scope.event.count("approvals_shown");
  if (scope.tool) scope.tool.held = true;
}

/**
 * A failure the code handled, for the unit running now; with none (pi's own
 * background reports, a view rebuilt outside any unit), a `job` event of its
 * own, named by `source`.
 */
export function reportError(error: unknown, extra: { readonly source: string; readonly code?: string; readonly severe?: boolean }): void {
  const event = currentEvent();
  if (event && !event.emitted) {
    event.fail(error, { step: extra.source, ...(extra.code ? { code: extra.code } : {}), ...(extra.severe === false ? { severe: false } : {}) });
    return;
  }
  wideEvent("job", { job: extra.source, outcome: "error" }).fail(error, { step: extra.source, ...(extra.code ? { code: extra.code } : {}) }).emit();
}
