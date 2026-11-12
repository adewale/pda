/** API selection and authority checks shared by both transports. */
import { type Company } from "./discovery";
import { type ApprovalAuthority, sameAuthority, sessionAuthority } from "./authority";
import { PoppyClient, PoppyError, type TokenOptions } from "./client";
import { type ApprovalExecution } from "./operations";
import { approvesAcrossSessions } from "./operations-v2";
import { isTaskRequest } from "./approval-outcome";
import { one } from "../rows";
import { taskCallsTable } from "./store";

export type Api = Company["apis"][number];

type ApprovalBinding = ApprovalAuthority;

export function bindingSnapshot(client: PoppyClient, company: Company, label: string): ApprovalBinding {
  const session = client.sessionFor(company, label);
  return { account: session.account, sessionId: session.session_id, authorityGeneration: session.authority_generation };
}

function checkApprovalBinding(client: PoppyClient, company: Company, label: string, binding: ApprovalBinding): void {
  const session = client.session(company.issuer, label);
  if (!sameAuthority(binding, sessionAuthority(session), approvesAcrossSessions(company))) {
    throw new PoppyError("approval_changed", "The account or Session changed. Review a fresh request before sending it.", 0);
  }
}

export type DispatchGuard = Pick<TokenOptions, "beforeDispatch" | "onSessionRestart">;

export type AuthorityGuard = DispatchGuard & { readonly binding: () => ApprovalBinding };

/** Capture authority before asynchronous preparation, and retain the last
 * transport's binding for returned terms. Only an unapproved request may follow
 * a known session_ended refusal, or under Operations 3 an approved one too, which
 * holds in the new Session (0.4 Ops 3, 7); account and withdrawal generation stay fixed. */
export function requestGuard(client: PoppyClient, company: Company, label: string, binding: ApprovalBinding, allowRestart: boolean, beforeDispatch?: () => void): AuthorityGuard {
  let expected = binding;
  const check = () => { beforeDispatch?.(); checkApprovalBinding(client, company, label, expected); };
  check();
  return {
    binding: () => expected,
    beforeDispatch: check,
    ...(allowRestart || approvesAcrossSessions(company) ? { onSessionRestart: (previousSessionId: string, nextSessionId: string) => {
      if (expected.sessionId !== previousSessionId) throw new PoppyError("approval_changed", "The task's Session changed before its known refusal could be recovered. Nothing was resent.", 0);
      expected = { ...expected, sessionId: nextSessionId };
      check();
    } } : {})
  };
}

export function executionGuard(client: PoppyClient, company: Company, label: string, binding: ApprovalBinding, execution: ApprovalExecution): AuthorityGuard {
  return requestGuard(client, company, label, binding, isTaskRequest(execution.approvalId), execution.beforeDispatch);
}

export function hasTaskCall(client: PoppyClient, callId: string): boolean {
  return one(client.sql, taskCallsTable.pick("call_id"), "SELECT call_id FROM poppy_task_calls WHERE call_id = ?", callId) !== undefined;
}

export function findApi(company: Company, type: Api["type"], url?: string): Api {
  const matches = company.apis.filter((api) => api.type === type && (!url || api.url === url));
  if (matches.length === 0) throw new PoppyError("no_api", `${company.name} lists no ${type} API${url ? ` at ${url}` : ""}`, 0);
  return matches[0]!;
}
