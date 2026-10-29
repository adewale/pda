import { literal } from "../decode";
import { one } from "../rows";
import { PoppyError, type PoppyClient } from "./client";
import { conversation, recentMessages, sendMessage } from "./conversations";
import type { Company } from "./discovery";
import type { Json } from "./json";
import { classifyMessage, latestCompanyMessage, MESSAGE_POLICIES, messageHasCredential, REQUEST_AUTHORIZATION } from "./model-policy";
import type { AgentMessageResult } from "./message-result";
import { intent, intentsTable } from "./store";

const policy = literal(...MESSAGE_POLICIES);

/** Model-origin messages: persist the decision and prompt, send one handoff per prompt, and report delivery. */
export async function sendAgentMessage(client: PoppyClient, company: Company, request: {
  readonly callKey: string; readonly conversationId?: string; readonly label?: string; readonly text?: string; readonly data?: Json;
}): Promise<AgentMessageResult> {
  const id = request.conversationId;
  const messages = id ? recentMessages(client, id) : [];
  const priorPolicy = one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `message-policy|${request.callKey}`);
  const saved = priorPolicy?.value ?? intent(client.sql, `message-policy|${request.callKey}`, () => classifyMessage(messages, request.text, request.data));
  // Decisions saved before the typed policy had these two names.
  const decision = policy(saved === "authorization" ? "request_authorization" : saved === "message" ? "send" : saved, "saved message policy");
  // The old tool saved "message" even for a credential it subsequently refused.
  if (decision === "reject" || (saved === "message" && messageHasCredential(request.text, request.data))) throw new PoppyError("invalid_request", "The message was not sent because it appears to contain a credential or verification code. Ask the Company for an authorization event instead.", 0);
  const authorizationKey = decision === "request_authorization" ? intent(client.sql, `message-authorization|${request.callKey}`, () => {
    // A replay of a pre-upgrade call still uses its original message and acknowledgement.
    const legacy = `verification-authorization|${id}`;
    if (priorPolicy && one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `message|${legacy}`)) return legacy;
    const prompt = latestCompanyMessage(messages);
    return `verification-authorization|${JSON.stringify([company.issuer, id, prompt?.eventId ?? request.callKey])}`;
  }) : request.callKey;
  if (decision === "request_authorization" && one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", authorizationKey)) {
    return { kind: "withheld", status: "not sent", note: "Your proposed reply was not sent. An authorization request was already attempted for this verification prompt. Wait for the Company's authorization event or continue without verification details." };
  }
  const result = await sendMessage(client, company, {
    label: request.label ?? (id ? conversation(client, id)?.label ?? "main" : "main"),
    callKey: authorizationKey,
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
