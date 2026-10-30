import { one, type RowOf } from "../rows";
import { approvalsTable, intentsTable, type Sql } from "./store";
import { isTaskRequest } from "./approval-outcome";

export const decisionRow = approvalsTable.pick("id", "issuer", "label", "status", "terms_approval_id", "outcome_resolution", "outcome_resolved_at");
export const decisionColumns = "id, issuer, label, status, terms_approval_id, outcome_resolution, outcome_resolved_at";

/** Follow a handoff's actual state without reading any request or result body. */
export function linkedDecision(sql: Sql, id: string): RowOf<typeof decisionRow> | undefined {
  const initial = one(sql, decisionRow, `SELECT ${decisionColumns} FROM poppy_approvals WHERE id = ?`, id);
  if (!initial) return;
  let row: RowOf<typeof decisionRow> = initial;
  const seen = new Set([row.id]);
  while (row.status === "terms" && row.terms_approval_id) {
    const child: RowOf<typeof decisionRow> | undefined = one(sql, decisionRow, `SELECT ${decisionColumns} FROM poppy_approvals WHERE id = ? AND issuer = ? AND label = ?`, row.terms_approval_id, row.issuer, row.label);
    if (!child) break;
    if (seen.has(child.id)) throw new Error("Cyclic approval handoff");
    seen.add(child.id);
    row = child;
  }
  return row;
}

/** Attribution only, never authorization. The dispatch claim records this. */
export function taskRequested(sql: Sql, id: string): boolean {
  return isTaskRequest(id) || one(sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `task-selected|${id}`)?.value === "task";
}
