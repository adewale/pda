/**
 * A conversation's state as the model is given it (8.7): under 0.4 the four
 * fields the Company sends, as it sent them; under 0.3 `status` and
 * `responder`. The local `status` 0.4 derives stays out of the model's view.
 */
export type ModelState =
  | { readonly status: string; readonly responder: string }
  | { readonly closed: boolean; readonly working: boolean; readonly handoff: string; readonly responder: string };

export function stateForModel(row: {
  readonly protocol_version: string;
  readonly status: string;
  readonly responder: string;
  readonly working: number;
  readonly handoff: string;
}): ModelState {
  if (row.protocol_version === "0.3") return { status: row.status, responder: row.responder };
  return { closed: row.status === "closed", working: row.working === 1, handoff: row.handoff, responder: row.responder };
}
