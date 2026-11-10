/** MCP tool validation, durable task dispatch and exact-terms approval execution. */
import { PoppyClient, withoutAnswer, withAnswer, PoppyError } from "./client";
import { type Company } from "./discovery";
import { type Json, isObject } from "./json";
import { type ApprovalToSend, approvable, approvalJson, parseOperationV2, approvalForModel, operationsVersion, toSend } from "./operations-v2";
import { type AuthorityGuard, findApi, requestGuard, bindingSnapshot, hasTaskCall, executionGuard } from "./api-authority";
import { expired, unusableApproval, UNUSABLE, proposeApproval } from "./api-approvals";
import { prepareMcpCall, mcpRequest, listMcpTools } from "./mcp-transport";
import { intent } from "./store";
import { randomId } from "./jwt";
import { dispatchTaskRequest, registerExecutor, TermsRequested } from "./operations";
import { type SchemaDraft, schemaErrors, serialisedJson, leafErrors } from "./api-schema";
import { isTaskRequest } from "./approval-outcome";

/**
 * Call an MCP tool: its arguments, and the User's approval in `_meta` when
 * the call repeats one that returned an operation (Ops 6). Under 2026-07-28
 * the approval sits beside the protocol fields in `_meta`. The call is sent
 * once: when the server refuses it as the other era nothing was done, and
 * when its outcome is unknown it is never sent again under another lifecycle.
 */
async function performMcp(
  client: PoppyClient,
  company: Company,
  label: string,
  call: { apiUrl: string; tool: string; args: Json; approval?: ApprovalToSend },
  guard: AuthorityGuard,
  executingApproval?: string,
  listed?: Json
): Promise<Json> {
  const api = findApi(company, "mcp", call.apiUrl);
  if (call.approval && !approvable(call.approval, Date.now())) throw expired(company);
  const prepared = await prepareMcpCall(client, company, label, api, call, guard, listed).catch(error => { throw withoutAnswer(error); });
  // The same tool and arguments again, the approval in `_meta` (Ops 6).
  const params = { name: call.tool, arguments: call.args, ...(call.approval ? { _meta: { "personalagentprotocol.org/approval": approvalJson(call.approval) } } : {}) };
  const { result } = await mcpRequest(client, company, label, api, prepared.target, "tools/call", params, guard, prepared.parameters);
  // An error result carrying an operation is a request for the User's approval (Ops 4).
  if (company.extensions.operations && isObject(result) && result.isError === true && isObject(result.structuredContent) && result.structuredContent.operation !== undefined) {
    const operation = parseOperationV2(result.structuredContent.operation, operationsVersion(company) ?? "2");
    if ("problem" in operation) {
      await unusableApproval(client, company, operation.problem);
      return { unusable: true, note: UNUSABLE };
    }
    const approvalId = await proposeApproval(client, company, label, operation, call.args, {
      kind: "mcp",
      call: { apiUrl: api.url, tool: call.tool, args: call.args, approval: { operation_id: operation.operation_id, revision: operation.revision, expires_at: operation.expires_at } },
      binding: guard.binding()
    }, executingApproval);
    return approvalForModel(company, operation, 200, approvalId);
  }
  if (isObject(result) && result.isError === true) throw withAnswer(new PoppyError("mcp_error", `The MCP tool reported an error: ${JSON.stringify(result).slice(0, 1_000)}`, 200), 200);
  return result;
}

/**
 * Call an MCP tool. A tool marked `readOnlyHint` goes straight through, as an
 * OpenAPI GET does: it is the Company's own server saying the call changes
 * nothing (our reading, docs/readings.md). Other task calls are recorded
 * before dispatch; only terms the Company returns ask for confirmation.
 */
export async function callMcpTool(
  client: PoppyClient,
  company: Company,
  label: string,
  request: { apiUrl?: string; tool: string; args: Json; callKey?: string },
  beforeDispatch?: () => void
): Promise<Json> {
  const api = findApi(company, "mcp", request.apiUrl);
  const guard = requestGuard(client, company, label, bindingSnapshot(client, company, label), true, beforeDispatch);
  const tools = await listMcpTools(client, company, label, api.url, guard);
  const tool = tools.find((item) => isObject(item) && item.name === request.tool);
  if (!isObject(tool)) throw new PoppyError("no_tool", `${api.url} has no tool ${request.tool}`, 0);
  checkMcpArgs(company, request.tool, tool.inputSchema, request.args);
  const readOnly = isObject(tool.annotations) && tool.annotations.readOnlyHint === true;
  const call = { apiUrl: api.url, tool: request.tool, args: request.args };
  const requestId = request.callKey ? intent(client.sql, `request|${request.callKey}`, () => randomId("req_")) : randomId("req_");
  // Today's annotation cannot turn replay of a recorded write into a new call.
  if (readOnly && !hasTaskCall(client, requestId)) return performMcp(client, company, label, call, guard, undefined, tool);
  return dispatchTaskRequest(client, company, label, `${company.name}: run ${request.tool} with ${JSON.stringify(request.args)}`, {
    kind: "mcp", call, binding: guard.binding()
  }, requestId, beforeDispatch);
}

/**
 * An MCP tool's arguments are checked against its `inputSchema` before a card
 * or a call, as an OpenAPI body is, so a mistake comes back to the model as a
 * correction rather than reaching the Company after the User approved it.
 * The schema is JSON Schema 2020-12 unless its `$schema` names another
 * (MCP 2025-11-25). A schema we can't read refuses nothing: the Company decides.
 */
function checkMcpArgs(company: Company, name: string, inputSchema: Json | undefined, args: Json): void {
  if (!isObject(inputSchema)) return;
  const dialect = typeof inputSchema.$schema === "string" ? inputSchema.$schema : "";
  const draft: SchemaDraft = /draft-0[34]/.test(dialect) ? "4" : /draft-0[67]/.test(dialect) ? "7" : /2019-09/.test(dialect) ? "2019-09" : "2020-12";
  const errors = schemaErrors(inputSchema, args, draft);
  if (!errors || errors.length === 0) return;
  const context = `for ${name} at ${company.name}`;
  const serialised = serialisedJson(errors, args, "args", context);
  if (serialised) throw new PoppyError("invalid_args", `${serialised} Nothing was sent.`, 0);
  throw new PoppyError(
    "invalid_args",
    `args ${context} don't match the tool's inputSchema: ${leafErrors(errors, "args").join("; ")}. See it in poppy_mcp_list. Nothing was sent.`,
    0
  );
}

/** An approved MCP call: sent only to an MCP server the Company still lists (`findApi`). */
registerExecutor("mcp", async (client, company, approval, label, execution) => {
  if (!isTaskRequest(execution.approvalId) && !approval.call.approval) {
    throw new PoppyError("approval_changed", "Preliminary MCP approvals are no longer supported. Ask for current Company terms.", 0);
  }
  const guard = executionGuard(client, company, label, approval.binding, execution);
  // Under version 3 the approval says who approved it, when and how (0.4 Ops 6).
  const call = approval.call.approval ? { ...approval.call, approval: toSend(company, approval.call.approval, execution) } : approval.call;
  const result = await performMcp(client, company, label, call, guard, execution.approvalId);
  // The tool answered with an operation (Ops 4): its card waits, and nothing was done.
  if (isObject(result) && isObject(result.approval_required) && typeof result.proposed === "string") {
    if (approval.call.approval && result.approval_required.operation_id === approval.call.approval.operation_id &&
        result.approval_required.revision === approval.call.approval.revision) {
      throw withAnswer(new PoppyError("approval_required", `${company.name} returned terms that were already approved, so the request was not completed`, 200), 200);
    }
    throw new TermsRequested(`${company.name} asks you to approve its exact terms first, on the next card. Nothing has happened yet.`, result.proposed);
  }
  return JSON.stringify(result);
});
