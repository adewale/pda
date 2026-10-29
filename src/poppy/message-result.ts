import type { SendResult } from "./conversations";
import { isObject } from "./json";

/** Delivery of the proposed reply, separate from the conversation's remote status. */
export type AgentMessageResult =
  | ({ readonly kind: "sent" } & SendResult)
  | { readonly kind: "authorization_requested"; readonly status: "not sent"; readonly note: string; readonly authorizationRequest: SendResult }
  | { readonly kind: "withheld"; readonly status: "not sent"; readonly note: string };

/** Old saved tool results also describe withheld replies; never quote their original arguments as sent. */
export function messageDelivery(value: unknown): AgentMessageResult["kind"] | undefined {
  if (!isObject(value)) return undefined;
  if (value.kind === "sent" || value.kind === "authorization_requested" || value.kind === "withheld") return value.kind;
  if (value.status === "not sent") return isObject(value.authorizationRequest) ? "authorization_requested" : "withheld";
  return undefined;
}
