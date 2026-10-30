import type { Context } from "@earendil-works/chord/context";
import { GenerationTask, LiveDoc, ToolTask, type HookApi, type Storage } from "@earendil-works/pi-durable";
import { boolean, flag, literal, nullable, object, string } from "../decode";
import { integerOf, one, rows, table, text, textOf, type RowOf } from "../rows";

const sources = table("turn_sources", { request_id: text, source: textOf(literal("user", "background")), task_policy: integerOf(flag) });

export const TASK_SCOPE_MEMO = "pda.poppy-task-v1";
const taskScope = object({ key: nullable(string), foreign: boolean });

export type UserTaskContext = { readonly key: string; readonly text: string; readonly history: readonly string[]; readonly userStarted: boolean; readonly foreign: boolean; readonly active: () => boolean };
export type UserTaskReader = (api: TurnReader, context: Context) => Promise<UserTaskContext | undefined>;

/** Only the application ingress records this value; model text and tool arguments never do. */
export type TurnSource = RowOf<typeof sources.row>["source"];
export type TurnReader = Pick<HookApi, "conversationId" | "snapshot"> & Partial<Pick<HookApi, "taskId">>;
export type TrustedTurnCheck = (api: TurnReader, context: Context) => Promise<boolean>;
/**
 * Provenance of admitted inputs, alongside pi's durable submission records.
 * The active run's input IDs survive queueing, recovery and compaction; its
 * messages' prefixes and the order in which generation hooks ran do not
 * establish authority. Legacy or mixed-origin runs fail closed.
 */
export class TurnAuthority {
  constructor(
    readonly sql: SqlStorage,
    readonly storage: () => Promise<Storage>
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS turn_sources (
      request_id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('user', 'background')),
      task_policy INTEGER NOT NULL DEFAULT 0 CHECK (task_policy IN (0, 1))
    )`);
    if (!sql.exec("PRAGMA table_info(turn_sources)").toArray().some(row => row.name === "task_policy")) sql.exec("ALTER TABLE turn_sources ADD COLUMN task_policy INTEGER NOT NULL DEFAULT 0 CHECK (task_policy IN (0, 1))");
  }

  /** Persist before submitting. Retrying an input cannot change its authority. */
  record(requestId: string, source: TurnSource): void {
    this.sql.exec("INSERT OR IGNORE INTO turn_sources (request_id, source, task_policy) VALUES (?, ?, ?)", requestId, source, source === "user" ? 1 : 0);
    const row = one(this.sql, sources.pick("source"), "SELECT source FROM turn_sources WHERE request_id = ?", requestId);
    if (row?.source !== source) throw new Error("A submission's trusted origin cannot change");
  }

  /** Stop/reset revokes previous task grants; only a new admitted User input can replace them. */
  withdraw(): void { this.sql.exec("UPDATE turn_sources SET task_policy = 0 WHERE task_policy = 1"); }

  /**
   * Read original placed User inputs through pi's storage API, not the model's
   * compacted context. Summaries, Company notices and queued inputs cannot
   * become task authority. Bounded history supports earlier-photo references;
   * older/ambiguous selections fail closed to the disclosure card.
   */
  readonly userTask: UserTaskReader = async (api, context) => {
    const storage = await this.storage();
    const asking = api.taskId === undefined ? undefined : await storage.task(api.taskId, context);
    if (!asking || (asking.kind !== GenerationTask.definition.name && asking.kind !== ToolTask.definition.name)) return;
    const owner = asking.kind === ToolTask.definition.name && asking.owner !== undefined ? await storage.task(asking.owner, context) : asking;
    const memo = owner?.memos?.[TASK_SCOPE_MEMO];
    // A resumed tool may only use its own generating task's captured grant.
    // It must never borrow the latest User input or another generation's hook.
    if (asking.kind === ToolTask.definition.name && memo === undefined) return;
    const bound = memo === undefined ? undefined : taskScope(memo, "Poppy task scope");
    if (bound?.key === null) return;
    const inputs: { key: string; id: number; text: string; stopped: boolean; policy: number }[] = [];
    for (const row of rows(this.sql, sources.pick("request_id", "task_policy"), "SELECT request_id, task_policy FROM turn_sources WHERE source = 'user' ORDER BY rowid DESC LIMIT 100")) {
      const key = row.request_id;
      const submission = await storage.submissionByRequest(api.conversationId, key, context);
      if (submission?.type !== "input" || submission.entry === undefined) continue;
      const found = await storage.entry(api.conversationId, submission.entry, context);
      if (found?.entry.kind !== "pi.user") continue;
      const text = (found.entry.model ?? []).filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.type === "text" ? part.text : "").join("")).join("\n");
      inputs.push({ key, id: found.entry.id, text, stopped: submission.status === "unanswered", policy: row.task_policy });
    }
    inputs.sort((a, b) => a.id - b.id);
    const latest = bound ? inputs.find(input => input.key === bound.key) : inputs.at(-1);
    const userStarted = await this.isUser(api, context);
    return latest && !latest.stopped && latest.policy === 1 ? {
      key: latest.key, text: latest.text, history: inputs.filter(input => input.id <= latest.id).map(input => input.text), userStarted, foreign: bound?.foreign ?? !userStarted,
      active: () => one(this.sql, sources.pick("task_policy"), "SELECT task_policy FROM turn_sources WHERE request_id = ? AND source = 'user'", latest.key)?.task_policy === 1
    } : undefined;
  };

  /** Evaluate at the tool invocation, including when a tool resumes after a restart. */
  readonly isUser: TrustedTurnCheck = async (api, context) => {
    // Direct test/tool callers and old inputs carry no trusted run authority.
    if (typeof api.snapshot !== "function") return false;
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const inputs = live?.run?.inputs;
    if (!inputs?.length) return false;
    const storage = await this.storage();
    for (const id of inputs) {
      const submission = await storage.submission(id, context);
      if (submission?.type !== "input" || submission.conversationId !== api.conversationId || !submission.requestId) return false;
      const source = one(this.sql, sources.pick("source"), "SELECT source FROM turn_sources WHERE request_id = ?", submission.requestId)?.source;
      if (source !== "user") return false;
    }
    return true;
  };

}
