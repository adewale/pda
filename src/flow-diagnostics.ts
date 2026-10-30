import { array, object, optional, string, tryDecode } from "./decode";
import { id, literal, type Fields, type WideEvent } from "./log";
import { integer, one, rows, table, text } from "./rows";
import { approvalsTable } from "./poppy/store";
import { isDiagnosticFlowId } from "./poppy/approval-outcome";

/** Independent of unrelated agent activity; bounded by both rows and bytes. */
export const FLOW_DIAGNOSTIC_LIMITS = { flows: 50, events: 200, bytes: 256 * 1024 } as const;
const flowLog = table("agent_flow_log", { flow_id: text, seq: integer, at: integer, line: text });
const refs = object({ task_request_id: optional(string), approval_id: optional(string) });

/** Only allowlisted event copies: never requests, responses or Company text. */
export class FlowDiagnostics {
  constructor(readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_flow_log (
      flow_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, line TEXT NOT NULL,
      PRIMARY KEY (flow_id, seq)
    )`);
  }

  #hasApprovals(): boolean {
    return !!one(this.sql, object({ name: string }), "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'poppy_approvals'");
  }

  #linked(approvalId: string) {
    if (!this.#hasApprovals()) return [];
    return rows(this.sql, approvalsTable.pick("id", "created_at", "status", "terms_approval_id", "operation_id", "outcome_resolution"), `
      WITH RECURSIVE linked(id) AS (
        SELECT id FROM poppy_approvals WHERE id = ?
        UNION SELECT a.id FROM poppy_approvals a JOIN linked l ON a.terms_approval_id = l.id
        UNION SELECT a.terms_approval_id FROM poppy_approvals a JOIN linked l ON a.id = l.id WHERE a.terms_approval_id IS NOT NULL
      ) SELECT id, created_at, status, terms_approval_id, operation_id, outcome_resolution
        FROM poppy_approvals WHERE id IN (SELECT id FROM linked) ORDER BY created_at, id`, approvalId);
  }

  #root(approvalId: string): string | undefined {
    const linked = this.#linked(approvalId);
    return linked.find(row => row.id.startsWith("req_"))?.id ?? linked[0]?.id;
  }

  keep(seq: number, line: string, event: WideEvent): void {
    const decoded = tryDecode(array(refs), event.fields.tool_calls ?? [], "logged tool calls");
    const ids = new Set<string>();
    const batch = tryDecode(array(string), event.fields.approval_ids ?? [], "logged approvals");
    const candidates = [event.fields.approval_id, ...(batch.ok ? batch.value : []), ...(decoded.ok ? decoded.value.flatMap(call => [call.task_request_id, call.approval_id]) : [])];
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !isDiagnosticFlowId(candidate)) continue;
      const root = this.#root(candidate);
      if (root) ids.add(root);
    }
    for (const root of ids) {
      this.sql.exec("INSERT OR IGNORE INTO agent_flow_log (flow_id, seq, at, line) VALUES (?, ?, ?, ?)", root, seq, Date.now(), line);
      this.sql.exec(`DELETE FROM agent_flow_log WHERE flow_id = ? AND seq NOT IN (
        SELECT seq FROM (
          SELECT seq, row_number() OVER (ORDER BY seq DESC) AS n,
            sum(length(CAST(line AS BLOB))) OVER (ORDER BY seq DESC) AS bytes
          FROM agent_flow_log WHERE flow_id = ?
        ) WHERE n <= ? AND bytes <= ?
      )`, root, root, FLOW_DIAGNOSTIC_LIMITS.events, FLOW_DIAGNOSTIC_LIMITS.bytes);
    }
    if (ids.size) this.sql.exec(`DELETE FROM agent_flow_log WHERE flow_id NOT IN (
      SELECT flow_id FROM agent_flow_log GROUP BY flow_id ORDER BY max(seq) DESC LIMIT ?
    )`, FLOW_DIAGNOSTIC_LIMITS.flows);
  }

  export(requested: string, agentId: string, now = Date.now()): string {
    if (!isDiagnosticFlowId(requested)) return "No retained records for that flow.\n";
    const linked = this.#linked(requested);
    const root = linked.find(row => row.id.startsWith("req_"))?.id ?? linked[0]?.id ?? requested;
    const events = rows(this.sql, flowLog.pick("line"), "SELECT line FROM agent_flow_log WHERE flow_id = ? ORDER BY seq", root);
    if (!linked.length && !events.length) return "Poppy Demo Agent flow diagnostics\nNo retained records for this flow.\n";
    const states: Fields[] = linked.map(row => ({
      approval_id: id(row.id), status: literal(row.status),
      ...(row.terms_approval_id ? { terms_approval_id: id(row.terms_approval_id) } : {}),
      ...(row.operation_id ? { operation_id: id(row.operation_id) } : {}),
      ...(row.outcome_resolution ? { outcome_resolution: literal(row.outcome_resolution) } : {})
    }));
    return [
      "Poppy Demo Agent flow diagnostics", `Agent: ${agentId}`, `Flow: ${root}`, `Requested: ${requested}`,
      `Copied: ${new Date(now).toISOString()}`,
      `Retention: up to ${FLOW_DIAGNOSTIC_LIMITS.events} events / ${FLOW_DIAGNOSTIC_LIMITS.bytes} bytes per flow, for the ${FLOW_DIAGNOSTIC_LIMITS.flows} most recently logged flows.`,
      "Scope: one linked action and its approval revisions; shared turn/frame context may include other work. No unrelated Company protocol logs.",
      "Never included: request/response bodies, Company text, tokens, signed URL queries or fragments. Events pruned before this feature cannot be recovered.",
      ...(states.length ? ["Lifecycle (current durable state, not a request or response):", ...states.map(state => JSON.stringify(state))] : []),
      ...(events.length ? ["Events, oldest first:", ...events.map(row => row.line)] : ["No retained records for this flow; it may predate capture or have aged out."]), ""
    ].join("\n");
  }
}
