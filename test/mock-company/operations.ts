import {
  Company,
  HttpError,
  json,
  randomId,
  type Inbound,
  type ResourceContext,
  type Session
} from "./core";

export type Operation = {
  operation_id: string;
  revision: number;
  state: "proposed" | "in_progress" | "succeeded" | "failed" | "cancelled" | "expired";
  summary: string;
  terms: Record<string, unknown>;
  expires_at: string | null;
  user_approval_required: boolean;
  url: string;
  confirmation: { revision: number; approved_by: string; confirmed_at: string } | null;
  result: { summary: string; data?: Record<string, unknown> } | null;
};

type OperationRecord = {
  readonly operation: Operation;
  readonly sessionId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly account: string | null;
  expiresAt: number;
  confirms: number;
  performed: number;
  /** `slowConfirm`: confirmed, the next read finishes it. */
  pending: boolean;
};

const FINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
function exchangeTerms(price: { amount: string; currency: string }) {
  return {
    order_id: "ord_7Hk2",
    item_id: "itm_4Qa",
    replacement_sku: "stormline-insulated-m",
    price_difference: { amount: price.amount, currency: price.currency }
  };
}

function exchangeSummary(price: { amount: string; currency: string }): string {
  return `Exchange the Stormline Jacket (M) on order ord_7Hk2 for the Stormline Insulated Jacket (M), for ${price.currency === "USD" ? `$${price.amount}` : `${price.amount} ${price.currency}`} more, charged to the card used for the order.`;
}

/** The Operations extension, version 1, Company side. */
export class Operations {
  readonly #records = new Map<string, OperationRecord>();

  constructor(readonly company: Company) {}

  summary() {
    return [...this.#records.values()].map((record) => ({
      id: record.operation.operation_id,
      state: record.operation.state,
      revision: record.operation.revision,
      confirms: record.confirms,
      approvedBy: record.operation.confirmation?.approved_by ?? null
    }));
  }

  #expire(record: OperationRecord): void {
    if (record.operation.state === "proposed" && record.expiresAt <= Date.now()) {
      record.operation.state = "expired";
      record.operation.result = { summary: "The offer expired. Nothing was changed." };
    }
  }

  /**
   * Propose the jacket exchange, or return the open operation for the same
   * terms in this Session or account (Ops 4: one record across channels).
   */
  proposeExchange(context: ResourceContext): Operation {
    const price = this.company.config.exchangePrice;
    const terms = exchangeTerms(price);
    for (const record of this.#records.values()) {
      this.#expire(record);
      const same =
        record.operation.state === "proposed" || record.operation.state === "in_progress";
      const owner = record.account
        ? record.account === context.account
        : record.sessionId === context.session.id;
      if (same && owner && JSON.stringify(record.operation.terms) === JSON.stringify(terms)) {
        return record.operation;
      }
    }
    const id = randomId("exc_", 6);
    const expiresAt = Date.now() + 10 * 60_000;
    const operation: Operation = {
      operation_id: id,
      revision: 1,
      state: "proposed",
      summary: exchangeSummary(price),
      terms,
      expires_at: new Date(expiresAt).toISOString(),
      user_approval_required: this.company.config.userApprovalRequired,
      url: `${this.company.hosts.web}/orders/ord_7Hk2/exchanges/${id}`,
      confirmation: null,
      result: null
    };
    this.#records.set(id, {
      operation,
      sessionId: context.session.id,
      clientId: context.session.clientId,
      userId: context.session.userId,
      account: context.signedIn ? context.account : null,
      expiresAt,
      confirms: 0,
      performed: 0,
      pending: false
    });
    return operation;
  }

  /** Who may use an operation (Ops 3.2). */
  #owned(context: ResourceContext, id: string): OperationRecord {
    const record = this.#records.get(id);
    const ok =
      record &&
      record.clientId === context.session.clientId &&
      record.userId === context.session.userId &&
      (record.account
        ? context.signedIn && context.account === record.account
        : record.sessionId === context.session.id);
    if (!record || !ok) throw new HttpError(json({ error: "operation_not_found" }, 404));
    this.#expire(record);
    return record;
  }

  #perform(record: OperationRecord): void {
    record.performed += 1;
    this.company.performExchange(record.account, `operation ${record.operation.operation_id}`);
    record.pending = false;
    record.operation.state = "succeeded";
    record.operation.result = {
      summary:
        "Exchange placed. The insulated jacket ships today, and a return label for the original jacket was emailed. $70.00 was charged to the card ending in 4242.",
      data: { exchange_id: record.operation.operation_id, return_id: randomId("rtn_", 4) }
    };
  }

  #respond(record: OperationRecord, status = 200): Response {
    const headers: Record<string, string> = {};
    if (record.operation.state === "in_progress") headers["Retry-After"] = "1";
    return json(record.operation, status, headers);
  }

  /** `GET {endpoint}/{id}` (Ops 6). */
  read(context: ResourceContext, id: string): Response {
    const record = this.#owned(context, id);
    if (record.pending) this.#perform(record);
    return this.#respond(record);
  }

  /** `POST {endpoint}/{id}/confirm` (Ops 5.2). */
  confirm(inbound: Inbound, context: ResourceContext, id: string): Response {
    const co = this.company;
    const record = this.#owned(context, id);
    const body = JSON.parse(inbound.bodyText || "{}") as { revision?: unknown; approved_by?: unknown };
    record.confirms += 1;
    co.requireScopes(context, [co.orderScopes.write]);
    const operation = record.operation;
    if (operation.state !== "proposed") return this.#respond(record);
    if (body.revision !== operation.revision) {
      return json({ error: "terms_changed", operation }, 409);
    }
    if (body.approved_by !== "user" && body.approved_by !== "standing_permission") {
      co.violation("confirm.approved-by", `confirm with approved_by ${JSON.stringify(body.approved_by)}`);
      return json({ error: "invalid_request" }, 400);
    }
    if (body.approved_by === "standing_permission" && operation.user_approval_required) {
      co.violation(
        "confirm.standing-permission-overrides-user",
        "confirmed with a standing permission when user_approval_required is true"
      );
      return json({ error: "user_approval_required", operation }, 403);
    }
    operation.confirmation = {
      revision: operation.revision,
      approved_by: body.approved_by,
      confirmed_at: new Date().toISOString()
    };
    operation.state = "in_progress";
    if (co.config.slowConfirm) {
      record.pending = true;
      return this.#respond(record);
    }
    this.#perform(record);
    return this.#respond(record);
  }

  /** `POST {endpoint}/{id}/cancel` (Ops 7). */
  cancel(context: ResourceContext, id: string): Response {
    const record = this.#owned(context, id);
    const operation = record.operation;
    if (operation.state === "proposed") {
      operation.state = "cancelled";
      operation.result = { summary: "Declined. Nothing was changed." };
    } else if (operation.state === "in_progress" && record.pending) {
      record.pending = false;
      operation.state = "cancelled";
      operation.result = { summary: "Stopped before any changes were made." };
    }
    return this.#respond(record);
  }

  /** The operation its `url` shows on the website, to a Session that may see it (Ops 4.4). */
  forWebsite(session: Session, id: string): Operation | null {
    const record = this.#records.get(id);
    if (!record || record.clientId !== session.clientId || record.userId !== session.userId) return null;
    if (record.account ? session.account !== record.account : record.sessionId !== session.id) return null;
    this.#expire(record);
    return record.operation;
  }

  /**
   * Test control: the User confirms on the website, in the same Session (Ops
   * 4.4). It's the same operation, so it's performed once, whichever way it
   * is confirmed.
   */
  confirmOnWebsite(id: string): void {
    const record = this.#records.get(id);
    if (!record || record.operation.state !== "proposed") throw new Error(`can't confirm ${id} on the website`);
    record.operation.confirmation = {
      revision: record.operation.revision,
      approved_by: "user",
      confirmed_at: new Date().toISOString()
    };
    this.#perform(record);
  }

  /** Test control: the Company issues a new revision with new terms (Ops 3.1). */
  revise(id: string, summary: string, terms: Record<string, unknown>): number {
    const record = this.#records.get(id);
    if (!record || record.operation.state !== "proposed") throw new Error(`can't revise ${id}`);
    record.operation.revision += 1;
    record.operation.summary = summary;
    record.operation.terms = terms;
    record.expiresAt = Date.now() + 10 * 60_000;
    record.operation.expires_at = new Date(record.expiresAt).toISOString();
    return record.operation.revision;
  }

  isFinal(id: string): boolean {
    const record = this.#records.get(id);
    return record ? FINAL.has(record.operation.state) : false;
  }
}
