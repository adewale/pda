import type { Context } from "@earendil-works/chord/context";
import { LiveDoc, type HookApi, type Storage } from "@earendil-works/pi-durable";

/** Only the application ingress records this value; model text and tool arguments never do. */
export type TurnSource = "user" | "background";
export type TurnReader = Pick<HookApi, "conversationId" | "snapshot">;
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
      source TEXT NOT NULL CHECK (source IN ('user', 'background'))
    )`);
  }

  /** Persist before submitting. Retrying an input cannot change its authority. */
  record(requestId: string, source: TurnSource): void {
    this.sql.exec("INSERT OR IGNORE INTO turn_sources (request_id, source) VALUES (?, ?)", requestId, source);
    const row = this.sql.exec("SELECT source FROM turn_sources WHERE request_id = ?", requestId).toArray()[0];
    if (row?.source !== source) throw new Error("A submission's trusted origin cannot change");
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
      const source = this.sql.exec("SELECT source FROM turn_sources WHERE request_id = ?", submission.requestId).toArray()[0]?.source;
      if (source !== "user") return false;
    }
    return true;
  };

}
