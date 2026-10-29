import { literal } from "../decode";
import { one } from "../rows";
import { PoppyError, type PoppyClient } from "./client";
import { conversation, recentMessages, sendMessage } from "./conversations";
import type { Company } from "./discovery";
import type { Json } from "./json";
import { classifyMessage, MESSAGE_POLICIES, messageHasCredential, REQUEST_AUTHORIZATION } from "./model-policy";
import type { AgentMessageResult } from "./message-result";
import { intent, intentsTable } from "./store";

const policy = literal(...MESSAGE_POLICIES);

/** Model-origin messages: persist the decision, send one stable handoff, and report actual delivery. */
export async function sendAgentMessage(client: PoppyClient, company: Company, request: {
  readonly callKey: string; readonly conversationId?: string; readonly label?: string; readonly text?: string; readonly data?: Json;
}): Promise<AgentMessageResult> {
  const id = request.conversationId;
  const saved = intent(client.sql, `message-policy|${request.callKey}`, () => classifyMessage(id ? recentMessages(client, id) : [], request.text, request.data));
  // Decisions saved before the typed policy had these two names.
  const decision = policy(saved === "authorization" ? "request_authorization" : saved === "message" ? "send" : saved, "saved message policy");
  // The old tool saved "message" even for a credential it subsequently refused.
  if (decision === "reject" || (saved === "message" && messageHasCredential(request.text, request.data))) throw new PoppyError("invalid_request", "The message was not sent because it appears to contain a credential or verification code. Ask the Company for an authorization event instead.", 0);
  const authorizationKey = `verification-authorization|${id}`;
  if (decision === "request_authorization" && one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", authorizationKey)) {
    return { kind: "withheld", status: "not sent", note: "Your proposed reply was not sent. An authorization request was already attempted in this conversation. Wait for the Company's authorization event or continue without verification details." };
  }
  const result = await sendMessage(client, company, {
    label: request.label ?? (id ? conversation(client, id)?.label ?? "main" : "main"),
    callKey: decision === "request_authorization" ? authorizationKey : request.callKey,
    ...(id ? { conversationId: id } : {}), sender: "agent", wait: 10,
    ...(decision === "request_authorization" ? { text: REQUEST_AUTHORIZATION } : {
      ...(request.text !== undefined ? { text: request.text } : {}), ...(request.data !== undefined ? { data: request.data } : {})
    })
  });
  if (decision === "send") return { kind: "sent", ...result };
  // A saved body is not delivery evidence: until acknowledged, retry its same message ID.
  intent(client.sql, authorizationKey, () => "acknowledged");
  return { kind: "authorization_requested", status: "not sent", note: "Your proposed reply was not sent. A separate request for an authorization event was sent to the Company so the User can verify by signing in.", authorizationRequest: result };
}
