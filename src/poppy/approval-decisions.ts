import { APPROVAL_READ_LIMIT, approvalResult, storedResolution, type ApprovalDecision } from "./approval-outcome";
import { approvalsTable, type Sql } from "./store";
import { rows } from "../rows";
import type { Issuer } from "./issuer";

const decisionRow = approvalsTable.pick("id", "issuer", "status", "outcome_resolution", "outcome_resolved_at");

/** Read only the approvals requested by this User's transcript, never request/result bodies. */
export function approvalDecisions(sql: Sql, ids: readonly string[], companyName: (issuer: Issuer) => string): ApprovalDecision[] {
  if (ids.length > APPROVAL_READ_LIMIT) throw new Error("Too many approval identifiers");
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  return rows(sql, decisionRow, `SELECT id, issuer, status, outcome_resolution, outcome_resolved_at FROM poppy_approvals WHERE id IN (${unique.map(() => "?").join(",")})`, ...unique).map(row => {
    const resolution = storedResolution(row);
    return { approvalId: row.id, company: companyName(row.issuer), result: approvalResult(row.status, resolution), ...(resolution ? { outcomeResolution: resolution } : {}) };
  });
}
