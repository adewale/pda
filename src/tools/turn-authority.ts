import type { Context } from "@earendil-works/chord/context";
import { GenerationTask, LiveDoc, ToolTask, type HookApi, type Storage } from "@earendil-works/pi-durable";
import { flag, literal, nullable, object, string } from "../decode";
import { integer, integerOf, one, rows, table, text, textOf, type RowOf } from "../rows";
import { NO_TASK_ACCESS, readTaskAccess, type TaskAccess } from "../task-access";

const selection = table("task_company_selection", { slot: integer, companies: text });
const sources = table("turn_sources", { request_id: text, source: textOf(literal("user", "background")), task_policy: integerOf(flag), task_access: text, task_bound: integerOf(flag) });

export const TASK_SCOPE_MEMO = "pda.poppy-task-v1";
const taskScope = object({ key: nullable(string) });

type GrantingInput = { readonly key: string; readonly source: TurnSource; readonly policy: number; readonly access: TaskAccess };

function shared(a: TaskAccess, b: TaskAccess): TaskAccess {
  const companies = a.companies.filter(company => b.companies.includes(company));
  const uploads = a.uploads.flatMap(({ company, files }) => {
    const other = b.uploads.find(upload => upload.company === company)?.files ?? [];
    const both = files.filter(file => other.includes(file));
    return both.length ? [{ company, files: both }] : [];
  });
  return { companies, uploads };
}

/**
 * What a run may use, given the input whose grant it found and the inputs it is
 * actually running. A photo permission is for its own message, so a run the
 * Company started gets the Companies alone. One run can hold a User's message
 * and a scheduled task, and nothing says which a model call serves, so they
 * get only what both hold: neither can use the other's authority.
 */
export function runAccess(granting: GrantingInput, run: readonly GrantingInput[]): TaskAccess {
  if (!run.some(input => input.key === granting.key)) return { companies: granting.access.companies, uploads: [] };
  if (!run.some(input => input.source === "user") || !run.some(input => input.source === "background")) return granting.access;
  return run.map(input => input.policy === 1 ? input.access : NO_TASK_ACCESS).reduce(shared);
}

export type UserTaskContext = { readonly key: string; readonly access: TaskAccess; readonly active: () => boolean };
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
      task_policy INTEGER NOT NULL DEFAULT 0 CHECK (task_policy IN (0, 1)),
      task_access TEXT NOT NULL DEFAULT '{"companies":[],"uploads":[]}',
      task_bound INTEGER NOT NULL DEFAULT 0 CHECK (task_bound IN (0, 1))
    )`);
    if (!sql.exec("PRAGMA table_info(turn_sources)").toArray().some(row => row.name === "task_policy")) sql.exec("ALTER TABLE turn_sources ADD COLUMN task_policy INTEGER NOT NULL DEFAULT 0 CHECK (task_policy IN (0, 1))");
    if (!sql.exec("PRAGMA table_info(turn_sources)").toArray().some(row => row.name === "task_access")) {
      sql.exec(`ALTER TABLE turn_sources ADD COLUMN task_access TEXT NOT NULL DEFAULT '{"companies":[],"uploads":[]}'`);
      sql.exec("UPDATE turn_sources SET task_policy = 0");
    }
    if (!sql.exec("PRAGMA table_info(turn_sources)").toArray().some(row => row.name === "task_bound")) {
      sql.exec("ALTER TABLE turn_sources ADD COLUMN task_bound INTEGER NOT NULL DEFAULT 0 CHECK (task_bound IN (0, 1))");
      sql.exec("UPDATE turn_sources SET task_bound = 1 WHERE source = 'user'");
    }
    sql.exec(`CREATE TABLE IF NOT EXISTS task_company_selection (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      companies TEXT NOT NULL
    )`);
  }

  /** Persist before submitting. Retrying an input cannot change its authority. */
  record(requestId: string, source: TurnSource, selection?: TaskAccess): void {
    const access = JSON.stringify(readTaskAccess(selection));
    const bound = source === "user" || selection !== undefined ? 1 : 0;
    const known = one(this.sql, sources.pick("source"), "SELECT source FROM turn_sources WHERE request_id = ?", requestId);
    this.sql.exec("INSERT OR IGNORE INTO turn_sources (request_id, source, task_policy, task_access, task_bound) VALUES (?, ?, ?, ?, ?)", requestId, source, bound, access, bound);
    const row = one(this.sql, sources.pick("source", "task_access", "task_bound"), "SELECT source, task_access, task_bound FROM turn_sources WHERE request_id = ?", requestId);
    if (row?.source !== source || row.task_access !== access || row.task_bound !== bound) throw new Error("A submission's trusted origin cannot change");
    // A new User message that carries a selection says what its composer showed. A resent one
    // cannot undo a later change, and one that carries none says nothing about it.
    if (!known && source === "user" && selection) {
      this.sql.exec("INSERT OR REPLACE INTO task_company_selection (slot, companies) VALUES (1, ?)", JSON.stringify(selection.companies));
    }
  }

  /** What the composer shows next. Each message still carries its own list, so this grants nothing by itself. */
  selectedCompanies(): readonly string[] {
    const row = one(this.sql, selection.pick("companies"), "SELECT companies FROM task_company_selection WHERE slot = 1");
    return row ? readTaskAccess({ companies: JSON.parse(row.companies), uploads: [] }).companies : [];
  }

  /** A new chat starts with nothing selected. */
  forgetCompanies(): void { this.sql.exec("DELETE FROM task_company_selection"); }

  /** Stop/reset revokes admitted task grants. A future scheduled run admits its own saved scope; cancelling the schedule prevents that run. */
  withdraw(): void { this.sql.exec("UPDATE turn_sources SET task_policy = 0 WHERE task_policy = 1"); }

  /**
   * Read original placed inputs through pi's storage API, not the model's
   * compacted context. Summaries, Company notices and queued inputs cannot
   * become task authority. Structured selections are stored at admission; legacy inputs have no
   * Company or photo grant and must be restated using the composer. Scheduled
   * inputs carry the creating message's saved scope without becoming User-origin turns.
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
    const inputs: { key: string; id: number; source: TurnSource; stopped: boolean; policy: number; access: TaskAccess }[] = [];
    for (const row of rows(this.sql, sources.pick("request_id", "source", "task_policy", "task_access"), "SELECT request_id, source, task_policy, task_access FROM turn_sources WHERE source = 'user' OR task_bound = 1 ORDER BY rowid DESC LIMIT 100")) {
      const key = row.request_id;
      const submission = await storage.submissionByRequest(api.conversationId, key, context);
      if (submission?.type !== "input" || submission.entry === undefined) continue;
      const found = await storage.entry(api.conversationId, submission.entry, context);
      if (found?.entry.kind !== "pi.user") continue;
      inputs.push({ key, id: found.entry.id, source: row.source, stopped: submission.status === "unanswered", policy: row.task_policy, access: readTaskAccess(JSON.parse(row.task_access)) });
    }
    inputs.sort((a, b) => a.id - b.id);
    const running = await this.#runRequests(api, context);
    let latest = bound ? inputs.find(input => input.key === bound.key) : undefined;
    if (!bound) {
      if (!running) return;
      // Scheduled inputs carry their own frozen selection, including an empty
      // or withdrawn one. Neither may fall back to a later unrelated User grant.
      const explicitlyBound = [...running].some(key => one(this.sql, sources.pick("task_bound"), "SELECT task_bound FROM turn_sources WHERE request_id = ?", key)?.task_bound === 1);
      latest = explicitlyBound ? inputs.filter(input => running.has(input.key)).at(-1)
        : inputs.filter(input => input.source === "user").at(-1);
    }
    return latest && !latest.stopped && latest.policy === 1 ? {
      key: latest.key, access: runAccess(latest, inputs.filter(input => running?.has(input.key))),
      active: () => one(this.sql, sources.pick("task_policy"), "SELECT task_policy FROM turn_sources WHERE request_id = ?", latest.key)?.task_policy === 1
    } : undefined;
  };

  /** The request ids of the live run's inputs, or undefined when they can't all be established. */
  async #runRequests(api: TurnReader, context: Context): Promise<ReadonlySet<string> | undefined> {
    if (typeof api.snapshot !== "function") return undefined;
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    if (!live?.run?.inputs.length) return undefined;
    const storage = await this.storage();
    const running = new Set<string>();
    for (const id of live.run.inputs) {
      const submission = await storage.submission(id, context);
      if (submission?.type !== "input" || submission.conversationId !== api.conversationId || !submission.requestId) return undefined;
      if (!one(this.sql, sources.pick("task_bound"), "SELECT task_bound FROM turn_sources WHERE request_id = ?", submission.requestId)) return undefined;
      running.add(submission.requestId);
    }
    return running;
  }

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
