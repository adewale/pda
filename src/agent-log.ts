/**
 * The agent's side of the one logger (src/log.ts): every wide event a
 * person's agent writes carries its `agent_id`, and the newest
 * `DIAGNOSTIC_EVENTS` are kept in its own SQLite, so the User can copy them
 * (with the protocol log) from Activity and hand them to the operator.
 *
 * Turns: one `turn` event per pi run (from its first input to idle), built
 * from pi's conversation view (`session.watch()`: the run, retries,
 * compactions and failures in `pi.live`, and the answers appended to the
 * transcript) and from the sub-steps that report here: each model call (the router's
 * `onCall`), each tool call (every tool is wrapped by `instrument`), and
 * everything a tool does at a Company (through the tool's scope). Who
 * started a turn (the User, a Company message, a scheduled task, a held
 * notice) comes from `submitted`, which the agent calls before each
 * `harness.submit` of its own; a run whose input wasn't registered is the
 * User's, from the page.
 *
 * No text crosses here: tool arguments and results, messages and summaries
 * are never read into an event. Tool outcomes come from `isError` and the
 * result's `details` codes; read_url's from its status and how it read.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView, ConversationWatch, Extension, LiveState, SubmissionId, ToolRegistration } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import { LifecycleCapability } from "agents/lifecycle";
import { code, currentEvent, domain, id, inScope, join, LIMITS, literal, modelId, toolName, unit, wideEvent, type EventKind, type Fields, type Safe, type ToolCall, type Units, type WideEvent } from "./log";
import type { ModelCall } from "./model-router";
import { protocolIndex, protocolLog } from "./poppy/protocol-log";
import type { Issuer } from "./poppy/issuer";
import { integer, object, tryDecode } from "./decode";
import { one } from "./rows";
import { FlowDiagnostics } from "./flow-diagnostics";
import { clientFrame } from "./poppy/frames";

/** How many of its own events an agent keeps for "Copy diagnostics". */
export const DIAGNOSTIC_EVENTS = 200;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    level TEXT NOT NULL,
    line TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS agent_log_prune AFTER INSERT ON agent_log BEGIN
    DELETE FROM agent_log WHERE seq <= (SELECT seq FROM agent_log ORDER BY seq DESC LIMIT 1 OFFSET ${DIAGNOSTIC_EVENTS});
  END`
];

/** What started a turn. */
export type Trigger = "user" | "company" | "schedule" | "held" | "compaction" | "tool" | "unknown";

type Registered = { readonly trigger: Trigger; readonly requestId?: Safe<"id">; readonly startedBy?: Safe };

/** Codes a tool's failure carries when the answer was a refusal, ours or a Company's. */
const REFUSAL = /refus|denied|forbidden|not_allowed|blocked|insufficient_scope|unauthori[sz]ed|declined/i;

type ModelTally = {
  count: number;
  refused: number;
  retries: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  latency_ms: number;
  errors: Record<Safe, number>;
};

type TurnState = {
  readonly event: WideEvent;
  run: boolean;
  model: ModelTally;
  tools: ToolCall[];
  toolCount: number;
  activeTools: number;
  ended: boolean;
  readUrl: { count: number; rendered: number; statuses: number[]; errors: Record<Safe, number> } | null;
  compaction: { count: number; reasons: Safe[]; blocking: boolean; summary?: Safe } | null;
  stopReason: Safe | null;
  last: ModelCall | null;
};

export type AgentLogOptions = {
  readonly sql: SqlStorage;
  /** The agent's pseudonymous id (`agentId` in src/log.ts): its Durable Object id's first 32 hex digits, as AI Gateway's `u`. */
  readonly agentId: Safe<"agent">;
  /** Each Company's protocol log, by issuer, for the diagnostics; names the Companies. */
  readonly companyName?: (issuer: Issuer) => { name: string; domain: string | null };
};

export class AgentLog extends LifecycleCapability implements Units {
  readonly agentId: Safe<"agent">;
  readonly #options: AgentLogOptions;
  readonly #flows: FlowDiagnostics;
  #turn: TurnState | null = null;
  /** Our own submissions, by operation id: who started them. Bounded. */
  readonly #registered = new Map<string, Registered>();
  /** pi's submission ids to their operation ids, read from pi when a run starts. Bounded. */
  readonly #submissions = new Map<string, string>();
  /** What the last view showed, to tell what changed; null before the first. */
  #seen: SeenView | null = null;
  /** The request that opened the page's socket, for the User's turns: its last `submit`. */
  #userRequestId: Safe<"id"> | null = null;
  #watch: ConversationWatch | null = null;

  constructor(options: AgentLogOptions) {
    super("log");
    this.#options = options;
    this.agentId = options.agentId;
    for (const statement of SCHEMA) options.sql.exec(statement);
    this.#flows = new FlowDiagnostics(options.sql);
  }

  // ---------------------------------------------------------------- Units

  /** A new event for this agent: its id, and a copy kept for the diagnostics. */
  event(kind: EventKind, fields: Fields = {}): WideEvent {
    return wideEvent(kind, { agent_id: this.agentId, ...fields }, { sink: (line, event) => this.#keep(line, event) });
  }

  job<T>(fields: Fields, fn: (event: WideEvent) => Promise<T>): Promise<T> {
    return unit(this.event("job", fields), fn);
  }

  frame<T>(type: Safe, fields: Fields, fn: (event: WideEvent) => Promise<T>): Promise<T> {
    return unit(this.event("ws", { frame: type, ...fields }), fn);
  }

  request<T>(fields: Fields, fn: (event: WideEvent) => Promise<T>): Promise<T> {
    return unit(this.event("http", fields), fn);
  }

  #keep(line: string, event: WideEvent): void {
    const saved = one(this.#options.sql, object({ seq: integer }), "INSERT INTO agent_log (at, kind, level, line) VALUES (?, ?, ?, ?) RETURNING seq", Date.now(), event.kind, event.level, line);
    if (saved) this.#flows.keep(saved.seq, line, event);
  }

  // ---------------------------------------------------------------- Turns

  /**
   * The agent is about to submit `operationId` to pi: say who started it.
   * Called inside the unit doing it (a job, a frame, a request), whose
   * request id and name the turn keeps.
   */
  submitted(operationId: string, trigger: Trigger, requestId?: Safe<"id">): void {
    const parent = currentEvent();
    const fromParent = id(parent?.fields.request_id);
    const name = parent?.fields.job ?? parent?.fields.frame ?? parent?.fields.route;
    const startedBy = parent ? join(typeof name === "string" ? [literal(parent.kind), name] : [literal(parent.kind)], ":") : undefined;
    this.#registered.set(operationId, {
      trigger,
      ...((requestId ?? fromParent) ? { requestId: requestId ?? fromParent } : {}),
      ...(startedBy ? { startedBy } : {})
    });
    bound(this.#registered, 200);
  }

  /** Follow the root session's view: runs, retries, compactions, failures. Idempotent; called at startup. */
  async watch(harness: PiHarness): Promise<void> {
    if (this.#watch) return;
    const watch = await harness.session().watch();
    this.#watch = watch;
    const resolve = (inputs: readonly SubmissionId[]) => submissionOperations(harness, inputs);
    this.#seen = null;
    await this.onPiView(watch.value, resolve);
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      try {
        await this.onPiView(call.value, resolve);
      } catch {
        // The log follows the run; it never stops it.
      }
    });
    void watch.closed.then(() => {
      if (this.#watch === watch) this.#watch = null;
    });
  }

  /** Stop following pi's view (tests that reopen the harness). */
  async unwatch(): Promise<void> {
    const watch = this.#watch;
    this.#watch = null;
    await watch?.stop();
  }

  /**
   * One view of the root session, compared with the last: a run that
   * started or ended, answers appended, a retry, a compaction that started
   * or ended, a run that failed. The first view starts the turn of a run
   * already going (the object restarted mid-run). A watch folds the commits
   * made while this runs into one view, so a run can also start and end
   * between two views; its answers or its failure show it ran. `resolve`
   * reads the operation ids of a run's inputs; without it they are pi's own
   * ids.
   */
  async onPiView(view: ConversationView, resolve?: (inputs: readonly SubmissionId[]) => Promise<ReadonlyMap<string, string>>): Promise<void> {
    const live = (view.docs["pi.live"] ?? {}) as LiveState;
    const prev = this.#seen;
    const newest = view.entries.at(-1)?.id;
    const next: SeenView = {
      run: live.run !== undefined,
      entry: newest === undefined ? (prev?.entry ?? 0) : Math.max(Number(newest), prev?.entry ?? 0),
      retryAt: live.generation?.retry?.at ?? null,
      compactions: new Set((live.compactions ?? []).map((compaction) => Number(compaction.taskId))),
      failure: live.runFailure ? Number(live.runFailure.taskId) : null
    };
    this.#seen = next;
    if (prev === null) {
      // Restarted mid-run: the run goes on, so its turn starts again here.
      if (live.run && !this.#turn?.run) await this.#startRun(live.run.inputs, true, resolve);
      return;
    }
    const failed = next.failure !== null && next.failure !== prev.failure ? live.runFailure : undefined;
    // pi's detail is the task's error's, which may be a tool's and so a Company's words: the reason only.
    const failTurn = (turn: TurnState) => {
      if (failed && TASK_FAILURES.has(failed.reason)) turn.event.fail(named("TaskFailed", "A pi task faulted, was orphaned or was cut off"), { code: literal(failed.reason) });
    };
    const answers = view.entries.filter((entry) => Number(entry.id) > prev.entry && entry.model?.[0]?.role === "assistant");
    const count = (turn: TurnState) => {
      for (const entry of answers) {
        const message = entry.model?.[0];
        if (message?.role !== "assistant") continue;
        turn.event.count("model_rounds");
        turn.stopReason = literal(message.stopReason);
      }
    };
    // A run ended and another started in the same commit (a reset with queued input, or a continue after a failure):
    // the failure is the ended run's.
    const replaced = prev.run && next.run && failed !== undefined;
    if (replaced && this.#turn) {
      failTurn(this.#turn);
      this.#endTurn();
    }
    if (live.run && (!prev.run || replaced)) await this.#startRun(live.run.inputs, false, resolve);
    // A run that started and ended between two views has no run in either: its answers or its failure are its trace.
    const unseen = !prev.run && !next.run && (answers.length > 0 || failed !== undefined);
    if (unseen && !this.#turn?.run) await this.#startRun(failed?.inputs ?? [], false, resolve);
    if (this.#turn) count(this.#turn);
    if (next.retryAt !== null && next.retryAt !== prev.retryAt && this.#turn) this.#turn.model.retries++;
    for (const compaction of live.compactions ?? []) {
      if (prev.compactions.has(Number(compaction.taskId))) continue;
      const turn = this.#openTurn("compaction");
      const tally = (turn.compaction ??= { count: 0, reasons: [], blocking: false });
      tally.count++;
      if (tally.reasons.length < 5) tally.reasons.push(literal(compaction.trigger));
      tally.blocking ||= compaction.blocking;
    }
    // A compaction that started and ended between two views shows only by the summary it placed.
    const summaries = view.entries.filter((entry) => Number(entry.id) > prev.entry && entry.kind === "pi.compaction").length;
    const folded = prev.compactions.size === 0 && next.compactions.size === 0 && summaries > 0;
    if (folded) {
      const turn = this.#openTurn("compaction");
      const tally = (turn.compaction ??= { count: 0, reasons: [], blocking: false });
      tally.count += summaries;
    }
    // A compaction outside any run is a turn of its own, which ends with it.
    if (((prev.compactions.size > 0 && next.compactions.size === 0) || folded) && this.#turn && !this.#turn.run && this.#turn.event.fields.trigger === "compaction") this.#endTurn();
    if (!replaced && failed && TASK_FAILURES.has(failed.reason)) failTurn(this.#openTurn("unknown"));
    if ((prev.run || unseen) && !next.run) this.#endTurn();
  }

  /** The turn running now, opened if there is none (a call that came before its run's event). */
  #openTurn(trigger: Trigger): TurnState {
    if (this.#turn) return this.#turn;
    const event = this.event("turn", { trigger: literal(trigger) });
    this.#turn = {
      event,
      run: false,
      model: { count: 0, refused: 0, retries: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, latency_ms: 0, errors: {} },
      tools: [],
      toolCount: 0,
      activeTools: 0,
      ended: false,
      readUrl: null,
      compaction: null,
      stopReason: null,
      last: null
    };
    return this.#turn;
  }

  async #startRun(inputs: readonly SubmissionId[], resumed: boolean, resolve?: (inputs: readonly SubmissionId[]) => Promise<ReadonlyMap<string, string>>): Promise<void> {
    // A run that began without ending the last one: write that one first.
    if (this.#turn?.run) this.#endTurn();
    const unknown = inputs.filter((input) => !this.#submissions.has(String(input)));
    if (resolve && unknown.length > 0) {
      try {
        for (const [input, operation] of await resolve(unknown)) this.#submissions.set(input, operation);
        bound(this.#submissions, 200);
      } catch {
        // Without pi's records, the turn names pi's own ids.
      }
    }
    const operations = inputs.map((id) => this.#submissions.get(String(id)) ?? String(id));
    const first = operations[0];
    const registered = first !== undefined ? this.#registered.get(first) : undefined;
    const turn = this.#openTurn("unknown");
    turn.run = true;
    const trigger: Trigger = registered?.trigger ?? "user";
    const requestId = registered ? registered.requestId : this.#userRequestId ?? undefined;
    const turnId = id(first);
    turn.event.set({
      trigger: literal(trigger),
      ...(turnId ? { turn_id: turnId } : {}),
      operation_ids: operations.slice(0, 10).flatMap((operation) => id(operation) ?? []),
      ...(requestId ? { request_id: requestId } : {}),
      ...(registered?.startedBy ? { started_by: registered.startedBy } : {}),
      ...(resumed ? { resumed: true } : {})
    });
    for (const id of operations) this.#registered.delete(id);
  }

  /** Write the turn's event: its model calls, tool calls, Poppy requests, compaction and outcome. */
  #endTurn(): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    turn.ended = true;
    // A queued run_end can arrive while an instrumented call still settles.
    // Detach the turn so the next run can start, but never emit partial tools.
    if (turn.activeTools === 0) this.#writeTurn(turn);
  }

  #writeTurn(turn: TurnState): void {
    const { event, model, last } = turn;
    if (last) {
      event.set({
        lane: literal(last.lane),
        provider: modelId(last.provider) ?? null,
        model: modelId(last.model) ?? null,
        budget_pool: last.budgetPool === "personal" ? literal("personal") : (domain(last.budgetPool) ?? null),
        ...(last.demoSpentUsd !== null ? { demo_spent_today_usd: round(last.demoSpentUsd + last.costUsd) } : {}),
        ...(last.refused ? { refused_reason: literal(last.refused) } : {})
      });
    }
    event.set({
      model_calls: { ...model, cost_usd: round(model.cost_usd) },
      tool_count: turn.toolCount,
      tool_calls: turn.tools,
      // Strings, for `contains(...)` in the Query Builder.
      tools_used: join([...new Set(turn.tools.map((call) => call.name))], " "),
      tool_outcomes: join([...new Set(turn.tools.map(toolOutcome))], " "),
      ...(turn.readUrl ? { read_url: turn.readUrl } : {}),
      ...(turn.compaction ? { compaction: turn.compaction } : {}),
      ...(turn.stopReason ? { stop_reason: turn.stopReason } : {})
    });
    const errorCodes = Object.keys(model.errors);
    if (model.count > 0 && model.refused === model.count) event.set({ outcome: literal("refused") });
    else if (turn.stopReason === "aborted") event.set({ outcome: literal("aborted") });
    else if (turn.stopReason === "error" || (turn.stopReason === null && errorCodes.length > 0)) {
      event.fail(named("ModelError", "The model call failed"), { code: code(last?.errorCode) ?? code(errorCodes[0]) ?? literal("error") });
    }
    event.emit();
  }

  /** One model call, from the router. */
  modelCall(call: ModelCall): void {
    const turn = this.#openTurn("unknown");
    const tally = turn.model;
    tally.count++;
    if (call.lane === "none") tally.refused++;
    tally.input_tokens += call.inputTokens;
    tally.output_tokens += call.outputTokens;
    tally.cache_read_tokens += call.cacheReadTokens;
    tally.cache_write_tokens += call.cacheWriteTokens;
    tally.cost_usd += call.costUsd;
    tally.latency_ms += call.latencyMs;
    const failed = call.lane === "none" ? code(`refused_${call.refused ?? "none"}`) : code(call.errorCode);
    if (failed) tally.errors[failed] = (tally.errors[failed] ?? 0) + 1;
    turn.last = call;
  }

  /** How a compaction's summary call went (src/compaction.ts). */
  compactionSummary(outcome: { readonly summary: "ok" | "failed"; readonly stopReason?: string; readonly error?: unknown }): void {
    const turn = this.#openTurn("compaction");
    const compaction = (turn.compaction ??= { count: 0, reasons: [], blocking: false });
    compaction.summary = literal(outcome.summary);
    if (outcome.summary === "failed") {
      turn.event.fail(outcome.error ?? named("SummaryFailed", "No usable summary"), { code: code(outcome.stopReason) ?? literal("summary_failed"), step: literal("compaction"), severe: false });
    }
  }

  /** `extension` with each tool's call counted on the turn running it, by the name it is registered under. */
  instrument(extension: Extension): Extension {
    if (!extension.tools?.length) return extension;
    return {
      ...extension,
      tools: extension.tools.map((tool) => {
        const name = toolName(tool.name) ?? UNNAMED_TOOL;
        return { ...tool, execute: (args, api, context) => this.tool(name, () => tool.execute(args, api, context), api.callId) };
      }) as ToolRegistration[]
    };
  }

  /** Run one tool call as part of the turn running now; outside any (a test calling a tool), as a turn of its own. */
  async tool<R>(name: Safe<"tool">, run: () => Promise<R>, callId?: string): Promise<R> {
    const owned = this.#turn === null;
    const turn = this.#openTurn(owned ? "tool" : "unknown");
    const call: ToolCall = { name, outcome: literal("success"), duration_ms: 0, ...(callId ? { call_id: id(callId) } : {}) };
    const started = Date.now();
    turn.activeTools++;
    try {
      const result = await inScope(turn.event, run, call);
      this.#classify(turn, call, result);
      return result;
    } catch (error) {
      call.outcome = literal("error");
      call.error_code = code((error as Error)?.name) ?? literal("error");
      throw error;
    } finally {
      call.duration_ms = Date.now() - started;
      turn.toolCount++;
      if (turn.tools.length < LIMITS.toolCalls) turn.tools.push(call);
      turn.activeTools--;
      if (turn.ended && turn.activeTools === 0) this.#writeTurn(turn);
      else if (owned && this.#turn === turn && !turn.run) this.#endTurn();
    }
  }

  /** A tool's outcome from its result's flags and codes, never its text. */
  #classify(turn: TurnState, call: ToolCall, result: unknown): void {
    const { isError, details } = (result ?? {}) as { isError?: boolean; details?: unknown };
    const facts = (typeof details === "object" && details !== null && !Array.isArray(details) ? details : {}) as Record<string, unknown>;
    const error = code(facts.error) ?? literal("error");
    if (isError) {
      call.error_code = error;
      call.outcome = REFUSAL.test(error) ? literal("refused") : literal("error");
    } else if (call.held) {
      call.outcome = literal("held");
    }
    if (call.name === "read_url") {
      const read = (turn.readUrl ??= { count: 0, rendered: 0, statuses: [], errors: {} });
      read.count++;
      if (facts.via === "browser") read.rendered++;
      if (typeof facts.status === "number" && read.statuses.length < LIMITS.statuses) read.statuses.push(facts.status);
      if (isError) read.errors[error] = (read.errors[error] ?? 0) + 1;
    }
  }

  // ---------------------------------------------------------------- The page's frames

  async onWebSocketMessage(socket: WebSocket, message: string | ArrayBuffer | ArrayBufferView): Promise<boolean> {
    if (typeof message !== "string") return false;
    const type = /"type"\s*:\s*"([a-z.]+)"/.exec(message)?.[1];
    if (type === "poppy.diagnostics") {
      let parsed: unknown;
      try { parsed = JSON.parse(message); } catch { return true; }
      const decoded = tryDecode(clientFrame, parsed, "diagnostics request");
      if (!decoded.ok || decoded.value.type !== "poppy.diagnostics") return true;
      const flowId = decoded.value.flowId;
      socket.send(JSON.stringify({ type: "poppy.diagnostics", ...(flowId ? { flowId } : {}), text: flowId ? this.flowDiagnostics(flowId) : this.diagnostics(), at: Date.now() }));
      return true;
    }
    if (type === "submit") {
      // The User's turn: its request is the one that opened this socket.
      this.#userRequestId = requestIdOf(socket);
      return false;
    }
    if (type === "abort" || type === "reset") {
      // Done by pi's socket glue after us; the event says it was asked for.
      const requestId = requestIdOf(socket);
      this.event("ws", { frame: literal(type), ...(requestId ? { request_id: requestId } : {}) }).emit();
    }
    return false;
  }

  // ---------------------------------------------------------------- Diagnostics

  /** One linked task/approval lifecycle, independent of unrelated newest-200 eviction. */
  flowDiagnostics(flowId: string, now = Date.now()): string {
    return this.#flows.export(flowId, this.agentId, now);
  }

  /** The newest events, oldest first, as JSON lines. */
  events(): string[] {
    return this.#options.sql
      .exec("SELECT line FROM agent_log ORDER BY seq")
      .toArray()
      .map((row) => String(row.line));
  }

  /**
   * What the User copies from Activity for the operator: this agent's
   * newest events and every Company's protocol log, as text. The same
   * redacted fields as the logs; nothing the User or anyone else said.
   */
  diagnostics(now = Date.now()): string {
    const events = this.events();
    const lines = [
      "Poppy Demo Agent diagnostics",
      `Agent: ${this.agentId}`,
      `Copied: ${new Date(now).toISOString()}`,
      `Events: the newest ${events.length} (at most ${DIAGNOSTIC_EVENTS}), oldest first, one JSON object a line, as the operator's logs have them.`,
      "Never in them: what you, your agent or anyone else said, page text, tokens, keys, codes, emails or names.",
      "",
      ...events,
      "",
      ...this.#protocolText()
    ];
    return `${lines.join("\n")}\n`;
  }

  #protocolText(): string[] {
    const sql = this.#options.sql;
    const exists = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'poppy_protocol_log'").toArray().length > 0;
    if (!exists) return ["Poppy protocol log: no exchanges yet."];
    const names = this.#options.companyName ?? ((issuer: Issuer) => ({ name: issuer, domain: null }));
    const out: string[] = [];
    for (const company of protocolIndex(sql, names).companies) {
      const log = protocolLog(sql, company.key, names);
      out.push(`Poppy protocol log: ${company.company}${company.domain && company.domain !== company.company ? ` (${company.domain})` : ""}`, ...(log.issuer ? [`Company identifier: ${log.issuer}`] : []));
      for (const entry of log.entries) {
        out.push(
          [
            new Date(entry.at).toISOString(),
            `${entry.section} ${entry.title}`,
            [entry.method, entry.url].filter(Boolean).join(" ") || "-",
            entry.summary,
            `-> ${entry.result} [${entry.outcome}]`
          ].join(" | ")
        );
      }
      out.push("");
    }
    return out.length ? out : ["Poppy protocol log: no exchanges yet."];
  }
}

/** The request id the Worker put on the socket's upgrade URL (`/ws?request_id=`), kept across hibernation. */
function requestIdOf(socket: WebSocket): Safe<"id"> | null {
  let uri: unknown = (socket as { uri?: unknown }).uri;
  if (typeof uri !== "string") {
    try {
      uri = (WebSocket.prototype.deserializeAttachment.call(socket) as { __pk?: { uri?: unknown } } | null)?.__pk?.uri;
    } catch {
      uri = undefined;
    }
  }
  if (typeof uri !== "string" || !URL.canParse(uri)) return null;
  return id(new URL(uri).searchParams.get("request_id")) ?? null;
}

/** A tool call as `tool_outcomes` lists it: `name:outcome`, and `@` the Companies it reached. */
function toolOutcome(call: ToolCall): Safe {
  const outcome = join([call.name, call.outcome], ":");
  return call.issuers?.length ? join([outcome, join(call.issuers, ",")], "@") : outcome;
}

/** The name a tool whose registered name isn't a plain identifier is counted under. */
const UNNAMED_TOOL = toolName("tool")!;

function named(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function bound<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value as K);
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/** What `onPiView` remembers of a view. */
type SeenView = {
  /** Whether a run was going. */
  readonly run: boolean;
  /** The newest entry id seen. */
  readonly entry: number;
  readonly retryAt: number | null;
  readonly compactions: ReadonlySet<number>;
  /** The task of the newest run that failed. */
  readonly failure: number | null;
};

/** The run failures that are a task's, not the model's or the User's: the turn records them as errors. */
const TASK_FAILURES: ReadonlySet<string> = new Set(["faulted", "orphaned", "interrupted", "restart_limit"]);

/** The operation ids of pi's submissions `inputs`, each looked up by its id. */
async function submissionOperations(harness: PiHarness, inputs: readonly SubmissionId[]): Promise<ReadonlyMap<string, string>> {
  const pi = await harness.pi();
  const found = new Map<string, string>();
  for (const input of inputs) {
    const record = await (await pi.submission(input, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
    if (record?.requestId !== undefined) found.set(String(input), record.requestId);
  }
  return found;
}
