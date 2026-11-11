/** Company terms and exact-revision approval publication shared by API transports. */
import { type Company } from "./discovery";
import { PoppyError, PoppyClient } from "./client";
import { type OperationV2, approvalCardId, approvalSummary } from "./operations-v2";
import { type Json } from "./json";
import { type NewApproval, readApproval } from "./approvals";
import { one } from "../rows";
import { approvalsTable, intent } from "./store";
import { randomId } from "./jwt";
import { proposeLocal, approvalTerms } from "./operations";
import { considerAgentApproval } from "./instructions";

export const UNUSABLE = "The Company asked for approval of an operation the agent can't show, so nothing was done and nothing can be approved; the User has been told.";

/** An approval whose revision expired before the User decided is never sent (Ops 3, "Expiry"). */
export function expired(company: Company): PoppyError {
  return new PoppyError("approval_changed", `Not sent: ${company.name}'s terms expired before they were approved. Ask ${company.name} again for current terms.`, 0);
}

/**
 * The User's card for an operation (Ops 5): the Company's name and its
 * summary. One card per revision; the approved request is stored with it.
 */
export async function proposeApproval(client: PoppyClient, company: Company, label: string, operation: OperationV2, asked: Json, approval: NewApproval, executingApproval?: string): Promise<string> {
  const revisionKey = await approvalCardId(company, operation);
  const source = executingApproval ? one(client.sql, approvalsTable.pick("request"), "SELECT request FROM poppy_approvals WHERE id = ?", executingApproval) : undefined;
  const saved = source ? readApproval(source.request) : undefined;
  const previous = !saved?.ok ? undefined : saved.value.kind === "openapi" || saved.value.kind === "mcp" ? saved.value.call.approval
    : saved.value.kind === "web-operation" ? saved.value.approval : undefined;
  // An unchanged approved revision is a refusal, not a fresh decision. Every
  // new request/revision otherwise owns an immutable local decision ID, so a
  // delayed click cannot approve a later attempt that reused the same terms.
  const sameRevision = previous?.operation_id === operation.operation_id && previous.revision === operation.revision;
  const id = executingApproval ? sameRevision ? executingApproval
    : intent(client.sql, `terms|${executingApproval}|${revisionKey}`, () => randomId("apr2_")) : revisionKey;
  const proposed = await proposeLocal(client, company, label, approvalSummary(company, operation), approval, id, approvalTerms(company, operation, asked), executingApproval);
  // 0.4 Ops 5: a standing instruction of the User's may approve it instead of the card.
  await considerAgentApproval(client, company, proposed, operation, label);
  return proposed;
}

/** An operation we can't show the User: nothing is approved, and they are told (Ops 5: never treat it as done). */
export async function unusableApproval(client: PoppyClient, company: Company, problem: string): Promise<void> {
  await client.host.showCard({
    id: `approval-unusable-${company.issuer}-${randomId()}`,
    kind: "notice",
    company: company.name,
    domain: company.domain,
    open: true,
    text: `${company.name} asked for your approval, but its terms couldn't be used (${problem}), so nothing was done.`
  });
}
