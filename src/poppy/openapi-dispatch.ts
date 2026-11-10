/** Durable OpenAPI task dispatch, file consent, replay and approval execution. */
import { type Json, parseStrictJson, isObject, canonicalJson, toJson } from "./json";
import { type OperationV2, approvalForModel, parseOperationV2, approvable, operationsVersion, toSend } from "./operations-v2";
import { type Company } from "./discovery";
import { UNUSABLE, unusableApproval, proposeApproval, expired } from "./api-approvals";
import { extensionRequiredBody, PoppyClient, withUnreadableAnswer, withAnswer, PoppyError } from "./client";
import { CheckedApiRequest, readOnlyScope } from "./openapi-request";
import { type AuthorityGuard, hasTaskCall, requestGuard, bindingSnapshot, executionGuard } from "./api-authority";
import { openApi } from "./openapi-document";
import { randomId } from "./jwt";
import { jsonText, object, string, array, nullable } from "../decode";
import { intent, intentsTable, taskCallsTable } from "./store";
import { one } from "../rows";
import { domainFromInput } from "../domain";
import { taskProjection, resumeRecordedTask, proposeLocal, dispatchTaskRequest, registerExecutor, TermsRequested, OperationOutcomeUnknown } from "./operations";
import { TaskFiles } from "./task-files";
import { isTaskRequest } from "./approval-outcome";
import { companyErrorCode } from "./error-codes";

/** What a sent API call got back. */
type ApiAnswer =
  | { readonly kind: "answered"; readonly status: number; readonly body: Json }
  /** Refused until the User approves the operation; a card waits for them (Ops 4). */
  | { readonly kind: "approval"; readonly operation: OperationV2; readonly approvalId: string }
  /** An operation we can't show the User: nothing was done, and the User has been told. */
  | { readonly kind: "unusable"; readonly body: Json };

function answerForModel(answer: ApiAnswer, company: Company): Json {
  if (answer.kind === "answered") return { status: answer.status, body: answer.body };
  if (answer.kind === "approval") return approvalForModel(company, answer.operation, 403, answer.approvalId);
  return { status: 403, unusable: true, note: UNUSABLE, body: answer.body };
}

/** Send a checked call, and read what came back. */
async function sendApi(client: PoppyClient, label: string, checked: CheckedApiRequest, guard: AuthorityGuard, executingApproval?: string): Promise<ApiAnswer> {
  const { company, op, api } = checked;
  // Read-only lookups ask for a read-only token when the account allows (Guides).
  const readOnly = op.method === "GET" ? readOnlyScope(client.session(company.issuer, label)?.scope, op) : null;
  const response = await client.resource(company, checked, {
    label,
    // The server's own protected resource metadata says whether it takes only its own tokens (4.5).
    service: (await openApi(client, api)).base,
    ...(readOnly ? { scope: readOnly } : {}), ...guard,
    // Without an approval, the call means the same in any version (3.4).
    ...(checked.call.approval ? {} : { versionNeutral: true })
  });
  const text = await client.readBody(response).catch(error => { throw withUnreadableAnswer(error, response.status); });
  let body: Json = null;
  try {
    body = text ? parseStrictJson(text) : null;
  } catch {
    body = text.slice(0, 4_000);
  }
  // The Company wants the User's approval of exact terms first (Ops 4); nothing was done.
  if (response.status === 403 && isObject(body) && body.error === "approval_required" && company.extensions.operations) {
    const operation = parseOperationV2(body.operation, operationsVersion(company) ?? "2");
    if ("problem" in operation) {
      await unusableApproval(client, company, operation.problem);
      return { kind: "unusable", body };
    }
    const approvalId = await proposeApproval(client, company, label, operation, { params: checked.call.params, body: checked.call.body ?? null }, {
      kind: "openapi",
      call: { ...checked.call, approval: { operation_id: operation.operation_id, revision: operation.revision, expires_at: operation.expires_at }, ...(checked.op.acceptsIdempotencyKey ? { idempotencyKey: randomId() } : {}) },
      method: checked.method,
      url: checked.url,
      binding: guard.binding()
    }, executingApproval);
    return { kind: "approval", operation, approvalId };
  }
  const required = extensionRequiredBody(company, body, response.status);
  if (required) throw required;
  return { kind: "answered", status: response.status, body };
}

/**
 * Call an OpenAPI operation in the Session. Every rule is checked first
 * (`CheckedApiRequest.check`), before a token request or a card. Task requests
 * run normally; a Company operation waits on its exact-terms card (Ops 4–6).
 * Photos selected by the User for this task need no second disclosure click.
 * Other files retain their disclosure card. Writes are recorded before dispatch
 * so replay returns their outcome rather than creating another operation.
 */
export type OpenApiTaskRequest = {
  apiUrl?: string;
  operation: string;
  params?: Record<string, string | number | boolean>;
  body?: Json;
  files?: Record<string, string>;
  callKey: string;
};

const apiAliases = jsonText(object({ operation: string, identifiers: array(string), apiUrl: string, originalApiUrl: nullable(string) }));

function rememberApiAliases(client: PoppyClient, request: OpenApiTaskRequest, checked: CheckedApiRequest): void {
  intent(client.sql, `api-aliases|${request.callKey}`, () => JSON.stringify({ operation: request.operation, identifiers: checked.identifiers, apiUrl: checked.api.url, originalApiUrl: request.apiUrl ?? null }));
}

function apiInput(client: PoppyClient, domain: string, label: string, request: OpenApiTaskRequest): { value: string; key: string; requestId?: string; canReplay: boolean } {
  const { callKey, operation, apiUrl, params, files, ...fields } = request;
  const aliases = one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `api-aliases|${callKey}`);
  const saved = aliases ? apiAliases(aliases.value, "API input aliases") : undefined;
  const named = saved?.identifiers.includes(operation) ? saved.operation : operation;
  const api = saved && (apiUrl === undefined || apiUrl === saved.apiUrl) ? saved.originalApiUrl ?? undefined : apiUrl;
  const value = canonicalJson(toJson({ domain: domainFromInput(domain), label, ...fields, operation: named, params: params ?? {}, ...(files && Object.keys(files).length ? { files } : {}), ...(api !== undefined ? { apiUrl: api } : {}) }));
  const key = `api-input|${callKey}`;
  const previous = one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", key);
  if (previous && previous.value !== value) throw new PoppyError("approval_changed", "This tool call already asked for a different API request. Nothing will be sent again.", 0);
  const requestId = one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `request|${callKey}`)?.value;
  const bound = requestId !== undefined && hasTaskCall(client, requestId);
  // A pre-existing mapping without this input proof still takes the ordinary
  // checked/hash-verified path; never stamp new arguments onto an old outcome.
  if (!previous && !bound) intent(client.sql, key, () => value);
  return { value, key, ...(requestId ? { requestId } : {}), canReplay: previous !== undefined && bound };
}

function taskReference(client: PoppyClient, callId: string, result: Json): Json {
  const bound = one(client.sql, taskCallsTable.pick("request_id"), "SELECT request_id FROM poppy_task_calls WHERE call_id = ?", callId);
  if (!bound || !isObject(result)) throw new PoppyError("invalid_response", "The task's recorded outcome is unavailable. Nothing will be resent.", 0);
  return { ...result, poppyTask: taskProjection(client, bound.request_id) };
}

/** Recover only a recorded call with the exact original input, before discovery or file reads. */
export async function replayOpenApiCall(client: PoppyClient, domain: string, label: string, request: OpenApiTaskRequest, beforeDispatch?: () => void): Promise<Json | undefined> {
  const input = apiInput(client, domain, label, request);
  if (!input.canReplay || !input.requestId) return undefined;
  const result = await resumeRecordedTask(client, input.requestId, beforeDispatch);
  return result === undefined ? undefined : taskReference(client, input.requestId, result);
}

export async function callOpenApi(
  client: PoppyClient,
  company: Company,
  label: string,
  request: OpenApiTaskRequest,
  taskFiles: TaskFiles = TaskFiles.none(),
  domain = company.domain,
  beforeDispatch?: () => void
): Promise<Json> {
  const guard = requestGuard(client, company, label, bindingSnapshot(client, company, label), true, beforeDispatch);
  const replay = await replayOpenApiCall(client, domain, label, request, beforeDispatch);
  if (replay !== undefined) return replay;
  const checked = await CheckedApiRequest.check(client, company, {
    ...request,
    idempotencyKey: () => intent(client.sql, `idem|${request.callKey}`, () => crypto.randomUUID())
  });
  const ask = async () =>
    proposeLocal(
      client,
      company,
      label,
      checked.describe(),
      { kind: "openapi", call: checked.call, method: checked.method, url: checked.url, binding: guard.binding(), ...(checked.attachments.length ? { attachments: [...checked.attachments] } : {}) },
      intent(client.sql, `approval|${request.callKey}`, () => randomId("apr_"))
    );
  const requestId = intent(client.sql, `request|${request.callKey}`, () => randomId("req_"));
  if (!hasTaskCall(client, requestId)) rememberApiAliases(client, request, checked);
  if (checked.attachments.length && !hasTaskCall(client, requestId)) {
    const ids = checked.attachments.map(file => file.id).sort();
    const context = { issuer: company.issuer, label, ids, binding: guard.binding() };
    const task = JSON.stringify({ ...context, route: "task" });
    const consent = JSON.stringify({ ...context, route: "consent" });
    // Freeze the route and its files/authority synchronously, before either
    // path can yield while creating its durable record. A later selection
    // cannot turn a pending, declined or completed disclosure into a new send.
    const priorConsent = one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `approval|${request.callKey}`);
    const route = intent(client.sql, `file-policy|${request.callKey}`, () => !priorConsent && taskFiles.includes(ids) ? task : consent);
    if (route !== task && route !== consent) throw new PoppyError("approval_changed", "This upload call already selected different files or authority. Nothing will be sent again.", 0);
    if (route === consent) {
      return { proposed: await ask(), note: "Waiting for the User to approve sending the file on a card; nothing has been sent yet." };
    }
  }
  // File disclosure always has a durable lifecycle, regardless of method hints.
  if (!checked.attachments.length && checked.method === "GET" && !hasTaskCall(client, requestId)) return answerForModel(await sendApi(client, label, checked, guard), company);
  const result = await dispatchTaskRequest(client, company, label, checked.describe(), {
    kind: "openapi", call: checked.call, method: checked.method, url: checked.url,
    binding: guard.binding(), ...(checked.attachments.length ? { attachments: [...checked.attachments] } : {})
  }, requestId, beforeDispatch);
  const input = apiInput(client, domain, label, request);
  intent(client.sql, input.key, () => input.value);
  rememberApiAliases(client, request, checked);
  return taskReference(client, requestId, result);
}

/**
 * An approved write: the stored call checked again, now, under today's rules
 * and description, and sent only if it still makes exactly the request the
 * card showed. An answer other than 2xx is an error the receipt names with
 * its status and code (operations.ts), never "done": the request was sent as
 * approved, and the Company didn't do it as far as it says. Nor is a
 * proposal we can't use.
 */
registerExecutor("openapi", async (client, company, approval, label, execution) => {
  if (!isTaskRequest(execution.approvalId) && !approval.call.approval && !Object.keys(approval.call.files ?? {}).length) {
    throw new PoppyError("approval_changed", "Preliminary API-write approvals are no longer supported. Ask for current Company terms.", 0);
  }
  const guard = executionGuard(client, company, label, approval.binding, execution);
  if (approval.call.approval && !approvable(approval.call.approval, Date.now())) throw expired(company);
  // Under version 3 the approval says who approved it, when and how (0.4 Ops 6).
  const sending = approval.call.approval ? { ...approval.call, approval: toSend(company, approval.call.approval, execution) } : approval.call;
  const checked = await CheckedApiRequest.check(client, company, sending);
  if (checked.method !== approval.method || checked.url !== approval.url) {
    throw new PoppyError(
      "approval_changed",
      `Not sent: ${company.name}'s description now makes this ${checked.method} ${checked.url}, not the ${approval.method} ${approval.url} you approved. Ask again to see the request it would make now.`,
      0
    );
  }
  const answer = await sendApi(client, label, checked, guard, execution.approvalId);
  if (answer.kind === "unusable") {
    throw withAnswer(new PoppyError("unusable_proposal", `${company.name} asked for approval of an operation the agent can't use, so nothing was done`, 403), 403);
  }
  // The Company wants the User's approval of its terms (Ops 4): nothing was done, and its card waits.
  if (answer.kind === "approval" && (!approval.call.approval ||
      answer.operation.operation_id !== approval.call.approval.operation_id || answer.operation.revision !== approval.call.approval.revision)) {
    throw new TermsRequested(`${company.name} asks you to approve its exact terms first, on the next card. Nothing has happened yet.`, answer.approvalId);
  }
  // An already-approved revision returned unchanged is a refusal, not a new card or a self-link.
  if (answer.kind === "approval") {
    throw withAnswer(new PoppyError("approval_required", `${company.name} asks for approval of new terms first, on a new card; nothing was done`, 403), 403);
  }
  if (answer.kind === "answered" && (answer.status < 200 || answer.status >= 300)) {
    const { status, body } = answer;
    const code = companyErrorCode(isObject(body) ? body.error : undefined, status);
    throw withAnswer(
      new PoppyError(code, `${company.name} answered ${status}: ${JSON.stringify(body).slice(0, 1_000)}`, status, body !== null ? { body } : {}),
      status
    );
  }
  if (answer.kind === "answered" && answer.status === 202) {
    throw new OperationOutcomeUnknown(`${company.name} accepted the approved request, but its action has not been confirmed. Check with the Company before approving further writes there.`);
  }
  return JSON.stringify(answerForModel(answer, company));
});
