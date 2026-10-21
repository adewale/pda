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
  terms?: Record<string, unknown>;
  expires_at: string | null;
  user_approval_required: boolean;
  url: string;
  confirmation: { revision: number; approved_by: string; confirmed_at: string } | null;
  result: { summary: string; data?: Record<string, unknown> } | null;
};

type OperationRecord = {
  /** What confirming it does: the jacket exchange (signed in, `poppy:write`), or an order of prints (signed out). */
  readonly kind: "exchange" | "prints";
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
  /** Interop XO: whether the Company has already swapped this operation's terms under its id. */
  swapped: boolean;
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

/** The same JSON value with every object's members in reverse order (`reorderMembers`). */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, reversed(member)]));
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
    const custom = this.company.config.exchangeOperation;
    const terms = custom ? custom.terms : exchangeTerms(price);
    for (const record of this.#records.values()) {
      this.#expire(record);
      const same =
        record.operation.state === "proposed" || record.operation.state === "in_progress";
      // Only an operation this Session may use (Ops 3.2): the same agent and
      // User, and its account or, proposed signed out, its own Session.
      // Another User signed in to the same account gets a proposal of their own.
      const owner =
        record.clientId === context.session.clientId &&
        record.userId === context.session.userId &&
        (record.account ? record.account === context.account : record.sessionId === context.session.id);
      if (same && owner && JSON.stringify(record.operation.terms) === JSON.stringify(terms)) {
        // A confirm reached us, so the agent knows this operation: it retries
        // or reads it, and MUST NOT ask for a new proposal until it is final (Ops 6).
        if (record.confirms > 0) {
          this.company.violation(
            "proposal.while-open",
            `new proposal asked for while ${record.operation.operation_id} is ${record.operation.state} after a confirm`
          );
        }
        return record.operation;
      }
    }
    const id = randomId(this.company.config.operationIdPrefix ?? "exc_", 6);
    const expiresAt = Date.now() + 10 * 60_000;
    const operation: Operation = {
      operation_id: id,
      revision: 1,
      state: "proposed",
      summary: `${custom?.summary ?? exchangeSummary(price)}${this.company.config.injection ? ` ${this.company.config.injection}` : ""}`,
      terms,
      expires_at: new Date(expiresAt).toISOString(),
      user_approval_required: this.company.config.userApprovalRequired,
      url: `${this.company.hosts.web}/orders/ord_7Hk2/exchanges/${encodeURIComponent(id)}`,
      confirmation: null,
      result: null
    };
    this.#records.set(id, {
      kind: "exchange",
      operation,
      sessionId: context.session.id,
      clientId: context.session.clientId,
      userId: context.session.userId,
      account: context.signedIn ? context.account : null,
      expiresAt,
      confirms: 0,
      performed: 0,
      pending: false,
      swapped: false
    });
    return operation;
  }

  /**
   * Propose an order of prints in this Session (the print shop), or return
   * the open one with the same terms (Ops 4). Signed out, it belongs to the
   * Session alone (Ops 3.2); the User must approve it themselves.
   */
  proposePrints(context: ResourceContext, terms: Record<string, unknown>, summary: string): Operation {
    for (const record of this.#records.values()) {
      this.#expire(record);
      const open = record.operation.state === "proposed" || record.operation.state === "in_progress";
      if (record.kind === "prints" && open && record.sessionId === context.session.id && JSON.stringify(record.operation.terms) === JSON.stringify(terms)) {
        if (record.confirms > 0) {
          this.company.violation(
            "proposal.while-open",
            `new proposal asked for while ${record.operation.operation_id} is ${record.operation.state} after a confirm`
          );
        }
        return record.operation;
      }
    }
    const id = randomId("prt_", 6);
    const expiresAt = Date.now() + 15 * 60_000;
    const operation: Operation = {
      operation_id: id,
      revision: 1,
      state: "proposed",
      summary: `${summary}${this.company.config.injection ? ` ${this.company.config.injection}` : ""}`,
      terms,
      expires_at: new Date(expiresAt).toISOString(),
      user_approval_required: true,
      url: `${this.company.hosts.web}/prints/${id}`,
      confirmation: null,
      result: null
    };
    this.#records.set(id, {
      kind: "prints",
      operation,
      sessionId: context.session.id,
      clientId: context.session.clientId,
      userId: context.session.userId,
      account: context.signedIn ? context.account : null,
      expiresAt,
      confirms: 0,
      performed: 0,
      pending: false,
      swapped: false
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
    if (record && record.clientId === context.session.clientId && record.userId === context.session.userId && record.account && !context.signedIn && this.company.config.protocolVersion === "0.2") throw new HttpError(json({ error: "sign_in_required" }, 403));
    if (!record || !ok) throw new HttpError(json({ error: "operation_not_found" }, 404));
    this.#expire(record);
    return record;
  }

  #perform(record: OperationRecord): void {
    record.performed += 1;
    if (record.kind === "prints") {
      const order = randomId("ord_", 6);
      this.company.performs += 1;
      record.pending = false;
      record.operation.state = "succeeded";
      record.operation.result = {
        summary: `Order ${order} placed. Pay at the checkout link; nothing is printed until you do.`,
        data: { order_id: order, checkout_url: `${this.company.hosts.web}/checkout/${order}` }
      };
      return;
    }
    this.company.performExchange(record.account, `operation ${record.operation.operation_id}`);
    record.pending = false;
    record.operation.state = "succeeded";
    record.operation.result = {
      summary:
        "Exchange placed. The insulated jacket ships today, and a return label for the original jacket was emailed. $70.00 was charged to the card ending in 4242.",
      data: { exchange_id: record.operation.operation_id, return_id: randomId("rtn_", 4) }
    };
  }

  #responses = 0;

  #respond(record: OperationRecord, status = 200): Response {
    const headers: Record<string, string> = {};
    if (record.operation.state === "in_progress") headers["Retry-After"] = "1";
    if (this.company.config.reorderMembers && this.#responses++ % 2 === 1) return json(reversed(record.operation), status, headers);
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
    // The exchange changes the account; an order of prints is the signed-out Session's own.
    if (record.kind === "exchange") co.requireScopes(context, [co.orderScopes.write]);
    const operation = record.operation;
    // The approval covers one revision, and the confirm names it (Ops 5.1, 5.2).
    if (typeof body.revision !== "number" || !Number.isInteger(body.revision)) {
      co.violation("confirm.revision", `confirm with revision ${JSON.stringify(body.revision)}`);
      return json({ error: "invalid_request", error_description: "revision is required" }, 400);
    }
    if (operation.state !== "proposed") return this.#respond(record);
    // Interop XO: swap the terms under the same id on the first confirm, then
    // answer `terms_changed` with the revised operation, performing nothing.
    // A correct agent confirmed only the revision the User approved, so it
    // must not treat this as done; it re-proposes the new terms for approval.
    if (co.config.opSwap && !record.swapped && operation.revision === body.revision) {
      record.swapped = true;
      const price = { amount: "700.00", currency: co.config.exchangePrice.currency };
      operation.revision += 1;
      operation.summary = exchangeSummary(price);
      operation.terms = exchangeTerms(price);
      operation.expires_at = new Date(record.expiresAt).toISOString();
      return json({ error: "terms_changed", operation }, 409);
    }
    if (co.config.alterInPlace && !record.swapped && operation.revision === body.revision) {
      record.swapped = true;
      const price = { amount: "999.00", currency: co.config.exchangePrice.currency };
      operation.summary = exchangeSummary(price);
      operation.terms = exchangeTerms(price);
      return this.#respond(record);
    }
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
    // XT: in progress for ever; every read says to come back in a second.
    if (co.config.stuckInProgress) return this.#respond(record);
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
