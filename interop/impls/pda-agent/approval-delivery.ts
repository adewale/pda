/** Interop observations of message delivery; an acknowledgement never proves an action completed. */
import { readApproval } from "../../../src/poppy/approvals.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const key = (url: string, operation: string, revision: string) => JSON.stringify([url, operation, revision]);

export class ApprovalAcknowledgements {
  readonly #accepted = new Set<string>();

  /** Call only with the response actually received from fetch; lost responses provide no evidence. */
  async observe(request: Request, response: Response): Promise<void> {
    const url = new URL(request.url);
    const match = /\/([^/]+)\/messages$/.exec(url.pathname);
    if (!match || request.method !== "POST" || !response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return;
    try {
      const sent = record(await request.clone().json()), answer = record(await response.clone().json());
      const message = record(sent?.message), approval = record(message?.approval);
      const conversation = decodeURIComponent(match[1]!);
      if (!ID.test(conversation) || !answer || answer.conversation_id !== conversation || typeof answer.status !== "string" || typeof answer.responder !== "string" || Object.hasOwn(answer, "error") || typeof message?.id !== "string" || !ID.test(message.id) || typeof approval?.operation_id !== "string" || typeof approval.revision !== "string") return;
      this.#accepted.add(key(`${url.origin}${url.pathname}`, approval.operation_id, approval.revision));
    } catch { /* Malformed/unreadable acknowledgements cannot establish delivery. */ }
  }

  /** Only an unknown message approval with its own valid acknowledgement can be reported as sent. */
  outcome(row: { status: string; request: string }, endpoint: string | undefined, conversation: { id: string; remote_id: string } | undefined): { status: "sent"; outcome: "unknown" } | null {
    if (row.status !== "unknown" || !endpoint || !conversation) return null;
    const stored = readApproval(row.request);
    if (!stored.ok || stored.value.kind !== "message-approval" || stored.value.conversationId !== conversation.id) return null;
    const url = new URL(`${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(conversation.remote_id)}/messages`);
    const approval = stored.value.approval;
    return this.#accepted.has(key(`${url.origin}${url.pathname}`, approval.operation_id, approval.revision)) ? { status: "sent", outcome: "unknown" } : null;
  }
}
