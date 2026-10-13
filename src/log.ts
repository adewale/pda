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
 * Privacy is by construction, in the types: an event's fields take only
 * numbers, booleans, null and `Safe` strings, and only the constructors
 * below make a `Safe` string: a value from a closed set written in our code
 * (`literal`), a short code, an id, an origin, a domain, a model or tool
 * name, the agent's pseudonymous id, a redacted message, or a join of those.
 * A raw `string` is a type error, so an email, a token, a URL with a query
 * or anyone's words can't reach an event by accident; `test/log-types.ts`
 * proves it under `npm run typecheck`. Free text goes only through
 * `message`, which `redact`s and bounds it. Portable (no Worker APIs), so
 * the Poppy client still runs in Node for the interop harness.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { originOf, type Issuer, type Origin } from "./poppy/issuer";

declare const __DPA_COMMIT__: string | undefined;
declare const __DPA_COMPATIBILITY_DATE__: string | undefined;

export const SERVICE = "personal-agent";

export type Level = "info" | "error";
export type EventKind = "http" | "turn" | "job" | "ws";

// ---------------------------------------------------------------- Safe values

declare const SAFE: unique symbol;

/** Which constructor made a `Safe` value; a function can ask for one kind (a tool call's name, a Poppy exchange's issuer). */
export type SafeKind = "literal" | "code" | "id" | "origin" | "domain" | "model" | "tool" | "agent" | "message" | "joined";

/** A string one of the constructors below made, and so fit for a wide event. Nothing else is. */
export type Safe<K extends SafeKind = SafeKind> = string & { readonly [SAFE]: K };

/** What an event field may hold: never a raw `string`. */
export type Field = Safe | number | boolean | null | readonly Field[] | { readonly [name: string]: Field | undefined };

/** Fields to add to an event. */
export type Fields = { readonly [name: string]: Field | undefined };

/** `unknown` for a string type whose every value is written in our code (a literal, or a union of them); `never` for `string` or a template with a hole. */
export type Closed<T extends string> = {} extends Record<T, 0> ? never : unknown;

function made<K extends SafeKind>(value: string): Safe<K> {
  return value as Safe<K>;
}

const LITERAL = /^[A-Za-z0-9_.:/{}-]{1,64}$/;

/**
 * A value from a closed set written in our code: a lane, trigger, outcome,
 * kind, step, frame or job name, a route template. Its type must be a string
 * literal or a union of them; a `string` is a type error. A value that got
 * past the types (a cast, `any`) and isn't a plain name is written as
 * `unlisted`.
 */
export function literal<const T extends string>(value: T & Closed<T>): Safe<"literal"> {
  return made(LITERAL.test(value) ? value : "unlisted");
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A run that reads as a key or a token rather than a word: what `redact` calls a secret. */
const SECRET_RUN = /[A-Za-z0-9]{24,}/;

/** A short machine code (an error code, a grant, a state or class name), or undefined: no `@`, `/`, space or token-like run. */
export function code(value: unknown): Safe<"code"> | undefined {
  return typeof value === "string" && TOKEN.test(value) && !SECRET_RUN.test(value) ? made(value) : undefined;
}

const ID = /^[A-Za-z0-9_.:/-]{1,160}$/;

/**
 * An id the agent or a Company made (an operation, conversation, approval,
 * schedule or request id; a version or commit), or undefined: letters,
 * digits and `_.:/-` only, so never an email, a query or text.
 */
export function id(value: unknown): Safe<"id"> | undefined {
  return typeof value === "string" && ID.test(value) ? made(value) : undefined;
}

/**
 * An issuer, origin or http(s) URL cut to its origin (`originOf`, the one
 * place an origin is made), or undefined: no path, query, fragment or
 * credentials.
 */
export function origin(value: Issuer | Origin | URL | string | null | undefined): Safe<"origin"> | undefined {
  const cut = typeof value === "string" || value instanceof URL ? originOf(value) : null;
  return cut === null ? undefined : made(cut);
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A DNS name in lower case (a Workspace domain, as a demo budget pool), or undefined. */
export function domain(value: unknown): Safe<"domain"> | undefined {
  return typeof value === "string" && DOMAIN.test(value) ? made(value) : undefined;
}

/** `@` only to start (`@cf/…`) or before a version (`…@20261001`), never as an email's. */
const MODEL = /^(?=.{1,100}$)@?[A-Za-z0-9_.:/-]+(?:@[0-9][A-Za-z0-9_.-]*)?$/;

/** A model provider's or a model's id (`anthropic`, `anthropic/claude-sonnet-5-5`), or undefined. */
export function modelId(value: unknown): Safe<"model"> | undefined {
  return typeof value === "string" && MODEL.test(value) && !SECRET_RUN.test(value) ? made(value) : undefined;
}

const TOOL = /^[a-z][a-z0-9_]{0,63}$/;

/** A tool's name as it is registered with pi (`read_url`, `poppy_call`), or undefined. */
export function toolName(value: unknown): Safe<"tool"> | undefined {
  return typeof value === "string" && TOOL.test(value) && !SECRET_RUN.test(value) ? made(value) : undefined;
}

/** The agent's pseudonymous id: its Durable Object id's first 32 hex digits, as AI Gateway's metadata `u` carries it. */
export function agentId(durableObjectId: { toString(): string }): Safe<"agent"> {
  const hex = durableObjectId.toString().slice(0, 32);
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new TypeError("Not a Durable Object id");
  return made(hex);
}

/** Free text made fit to log, the one way: `redact`ed and bounded. For error messages only. */
export function message(text: string): Safe<"message"> {
  return made(redact(text));
}

/** Safe values joined into one (`tools_used`, `tool_outcomes`, `started_by`): safe parts make a safe whole. */
export function join(parts: readonly Safe[], separator: " " | "," | ":" | "@" | "" = ""): Safe<"joined"> {
  return made(parts.join(separator));
}

// ---------------------------------------------------------------- Environment

const UNKNOWN = literal("unknown");

const environment: { [name: string]: Field } = {
  service: literal(SERVICE),
  version_id: UNKNOWN,
  version_tag: null,
  commit: id(typeof __DPA_COMMIT__ === "string" ? __DPA_COMMIT__ : undefined) ?? UNKNOWN,
  compatibility_date: id(typeof __DPA_COMPATIBILITY_DATE__ === "string" ? __DPA_COMPATIBILITY_DATE__ : undefined) ?? UNKNOWN
};

/** The deployment's version, from the `CF_VERSION_METADATA` binding. Called by the Worker and each agent at startup; idempotent. */
export function configureLog(env: { readonly CF_VERSION_METADATA?: { readonly id?: string; readonly tag?: string } }): void {
  const metadata = env.CF_VERSION_METADATA;
  const version = id(metadata?.id);
  const tag = id(metadata?.tag);
  if (version) environment.version_id = version;
  if (tag) environment.version_tag = tag;
}

/** The environment every event carries. */
export function environmentFields(): Fields {
  return { ...environment };
}

// ---------------------------------------------------------------- Redaction

/**
 * Free text made fit to log: URLs cut to their origin, emails, quoted text,
 * credentials after an auth scheme, and long token-like runs replaced, then
 * cut to 200 characters. Reached through `message`, for error messages,
 * which are our own words around values we can't vouch for; a defence in
 * depth behind the types.
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

/** An error as an event records it: its class, a short code, a redacted message, and the step it failed in. */
export type LoggedError = { readonly type: Safe; readonly code?: Safe; readonly message?: Safe<"message">; readonly step?: Safe };

/** What a failure's record adds to the error: a code of ours, and the step. */
export type FailureExtra = { readonly code?: Safe; readonly step?: Safe };

/** An error as fields: its class name, its code when it has a short one, and its message redacted. */
export function errorFields(error: unknown, extra: FailureExtra = {}): LoggedError {
  const type = error instanceof Error ? error.name || "Error" : typeof error === "string" ? "Message" : typeof error;
  const own = extra.code ?? code((error as { code?: unknown } | null)?.code);
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return {
    type: code(type) ?? literal("Error"),
    ...(own ? { code: own } : {}),
    ...(text ? { message: message(text) } : {}),
    ...(extra.step ? { step: extra.step } : {})
  };
}

// ---------------------------------------------------------------- The event

/** The most errors, issuers and tool calls one event keeps; the rest are counted, not listed. */
export const LIMITS = { errors: 10, issuers: 10, toolCalls: 30, statuses: 20 } as const;

/** One Poppy exchange, from the protocol log's allowlisted row; its issuer is logged as its origin. */
export type PoppyExchange = {
  readonly issuer: Issuer | null;
  readonly step: Safe;
  readonly status: number | null;
  readonly error: Safe<"code"> | null;
  readonly outcome: Safe;
};

type StepTally = { count: number; status: Record<string, number>; errors: Record<string, number> };

/** A tool call as a turn records it: never its arguments or result text. */
export type ToolCall = {
  name: Safe<"tool">;
  outcome: Safe<"literal">;
  duration_ms: number;
  error_code?: Safe;
  issuers?: Safe<"origin">[];
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
  readonly fields: { [name: string]: Field | undefined } = {};
  readonly errors: LoggedError[] = [];
  level: Level = "info";
  #errorCount = 0;
  #poppy: { requests: number; failed: number; issuers: Set<Safe<"origin">>; steps: Record<string, StepTally> } | null = null;
  #emitted: string | null = null;
  readonly #sink: EventOptions["sink"];

  constructor(kind: EventKind, fields: Fields = {}, options: EventOptions = {}) {
    this.kind = kind;
    this.#sink = options.sink;
    this.set(fields);
  }

  get emitted(): boolean {
    return this.#emitted !== null;
  }

  /** Add fields; one that is undefined (a constructor that refused its value) is left out. */
  set(fields: Fields): this {
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) delete this.fields[name];
      else this.fields[name] = value;
    }
    return this;
  }

  /** Add `by` to a numeric field, made at zero. A dotted name, written in our code, counts inside an object field. */
  count<const N extends string>(name: N & Closed<N>, by = 1): this {
    const [head, tail] = name.split(".", 2) as [string, string | undefined];
    if (tail === undefined) {
      this.fields[head] = (typeof this.fields[head] === "number" ? this.fields[head] : 0) + by;
      return this;
    }
    const inner = (typeof this.fields[head] === "object" && this.fields[head] !== null ? this.fields[head] : (this.fields[head] = {})) as { [name: string]: Field };
    inner[tail] = (typeof inner[tail] === "number" ? inner[tail] : 0) + by;
    return this;
  }

  /**
   * Record an error. `severe` (the default) makes the event level `error`;
   * a handled failure the unit survived (a push that didn't go) is kept at
   * the event's level.
   */
  fail(error: unknown, extra: FailureExtra & { readonly severe?: boolean } = {}): this {
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
    const issuer = origin(exchange.issuer);
    if (issuer && tally.issuers.size < LIMITS.issuers) tally.issuers.add(issuer);
    const step = (tally.steps[exchange.step] ??= { count: 0, status: {}, errors: {} });
    step.count++;
    const status = exchange.status === null ? "none" : String(exchange.status);
    if (Object.keys(step.status).length < LIMITS.statuses || status in step.status) step.status[status] = (step.status[status] ?? 0) + 1;
    const error = exchange.error;
    if (error && (Object.keys(step.errors).length < LIMITS.statuses || error in step.errors)) step.errors[error] = (step.errors[error] ?? 0) + 1;
    return this;
  }

  /** The Poppy issuers this unit dealt with so far. */
  get issuers(): Safe<"origin">[] {
    return [...(this.#poppy?.issuers ?? [])];
  }

  /** The record, as it would be written now. */
  record(level: Level = this.level): Record<string, unknown> {
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
          poppy_issuers: join([...this.#poppy.issuers], " ")
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
  frame<T>(type: Safe, fields: Fields, fn: (event: WideEvent) => Promise<T>): Promise<T>;
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
  const issuer = origin(exchange.issuer);
  if (scope.tool && issuer) {
    const issuers = (scope.tool.issuers ??= []);
    if (!issuers.includes(issuer) && issuers.length < 3) issuers.push(issuer);
  }
}

/** A card shown on the User's page: approvals are counted, and a tool that asked for one is held for the User. Nothing of the card is written. */
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
export function reportError(error: unknown, extra: { readonly source: Safe; readonly code?: Safe; readonly severe?: boolean }): void {
  const event = currentEvent();
  if (event && !event.emitted) {
    event.fail(error, { step: extra.source, ...(extra.code ? { code: extra.code } : {}), ...(extra.severe === false ? { severe: false } : {}) });
    return;
  }
  wideEvent("job", { job: extra.source, outcome: literal("error") }).fail(error, { step: extra.source, ...(extra.code ? { code: extra.code } : {}) }).emit();
}
