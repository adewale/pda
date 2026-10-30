import { APPROVAL_READ_LIMIT, approvalResult, storedResolution, type ApprovalDecision } from "./approval-outcome";
import type { Sql } from "./store";
import { rows } from "../rows";
import type { Issuer } from "./issuer";

import { decisionColumns, decisionRow, linkedDecision } from "./approval-projection";

/** Read only the approvals requested by this User's transcript, never request/result bodies. */
export function approvalDecisions(sql: Sql, ids: readonly string[], companyName: (issuer: Issuer) => string): ApprovalDecision[] {
  if (ids.length > APPROVAL_READ_LIMIT) throw new Error("Too many approval identifiers");
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  return rows(sql, decisionRow, `SELECT ${decisionColumns} FROM poppy_approvals WHERE id IN (${unique.map(() => "?").join(",")})`, ...unique).map(row => {
    const actual = linkedDecision(sql, row.id) ?? row;
    const resolution = storedResolution(actual);
    return { approvalId: row.id, company: companyName(row.issuer), result: approvalResult(actual.status, resolution), ...(resolution ? { outcomeResolution: resolution } : {}) };
  });
}
