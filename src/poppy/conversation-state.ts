/**
 * A conversation's state as the model is given it (8.7): the four fields
 * the Company sends, as it sent them. The local `status` derived from them
 * stays out of the model's view.
 */
export type ModelState = { readonly closed: boolean; readonly working: boolean; readonly handoff: string; readonly responder: string };

export function stateForModel(row: {
  readonly status: string;
  readonly responder: string;
  readonly working: number;
  readonly handoff: string;
}): ModelState {
  return { closed: row.status === "closed", working: row.working === 1, handoff: row.handoff, responder: row.responder };
}
