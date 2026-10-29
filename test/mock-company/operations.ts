import { Company, randomId, type ResourceContext } from "./core";

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

/** An operation, as the Company returns it (Ops 3). */
export type OperationV2 = {
  readonly operation_id: string;
  readonly revision: string;
  readonly summary: string;
  readonly terms?: Record<string, unknown>;
  readonly expires_at: string;
};

/** The terms of one revision: what the User approves (Ops 3). */
type Terms = { readonly summary: string; readonly terms?: Record<string, unknown> };
type Performed = { readonly status: number; readonly body: unknown };

/** One kind of action that needs approval: its terms for what a request asks, and what performing it does. */
type Action = {
  readonly kind: "exchange" | "prints";
  readonly terms: (asked: Record<string, unknown>) => Terms;
  readonly perform: (record: ApprovalRecord, context: ResourceContext) => Performed;
};

type ApprovalRecord = {
  readonly id: string;
  readonly kind: Action["kind"];
  readonly clientId: string;
  readonly userId: string;
  readonly sessionId: string;
  /** The account it was returned for, which may approve it from any of the User's Sessions (Ops 3, "Who can approve it"); null signed out. */
  readonly account: string | null;
  /** The request or tool call that returned it: an approval must repeat it exactly (Ops 6, check 3). */
  readonly request: string;
  /** Every revision returned for it, and when each stops being approvable. */
  readonly revisions: Map<string, { readonly operation: OperationV2; readonly expiresAt: number }>;
  latest: string;
  performed: Performed | null;
  /** How many times an approval for it was sent. */
  approvals: number;
};

/**
 * `Poppy-Approval` (Ops 6): an RFC 9651 Dictionary, its String members by
 * key; null if the field doesn't parse as a Dictionary (RFC 9651 4.2), so
 * the Company ignores it. Members of other types, and parameters, are kept
 * out: Companies "MUST ignore members … they don't recognize".
 */
export function parseApprovalHeader(value: string): Record<string, string> | null {
  const members: Record<string, string> = {};
  let rest = value.trim();
  while (rest !== "") {
    const key = /^[a-z*][a-z0-9_\-.*]*/.exec(rest)?.[0];
    if (!key) return null;
    rest = rest.slice(key.length);
    if (rest.startsWith("=")) {
      rest = rest.slice(1);
      if (rest.startsWith('"')) {
        let text = "";
        let i = 1;
        for (; i < rest.length; i++) {
          const char = rest[i]!;
          if (char === "\\") {
            const next = rest[i + 1];
            if (next !== '"' && next !== "\\") return null;
            text += next;
            i++;
          } else if (char === '"') break;
          else if (char < " " || char > "~") return null;
          else text += char;
        }
        if (i >= rest.length) return null;
        members[key] = text;
        rest = rest.slice(i + 1);
      } else {
        const item = /^[^,;\s]+/.exec(rest)?.[0];
        if (!item) return null;
        delete members[key];
        rest = rest.slice(item.length);
      }
    } else {
      delete members[key];
    }
    // Parameters on the member: skipped.
    while (rest.startsWith(";")) {
      const parameter = /^;\s*[a-z*][a-z0-9_\-.*]*(?:=(?:"(?:[^"\\]|\\.)*"|[^,;\s]+))?/.exec(rest)?.[0];
      if (!parameter) return null;
      rest = rest.slice(parameter.length);
    }
    rest = rest.replace(/^[ \t]*/, "");
    if (rest === "") break;
    if (!rest.startsWith(",")) return null;
    rest = rest.slice(1).replace(/^[ \t]*/, "");
    if (rest === "") return null;
  }
  return members;
}

/**
 * The Operations extension, version 2, Company side. A write that needs
 * approval is refused with the operation; the same request with an approval
 * of a revision it returned performs it, at most once. No endpoints; nothing
 * is stored about an operation but its revisions and, once performed, its
 * response (Ops 3, 6, 7).
 */
export class Operations {
  readonly #records = new Map<string, ApprovalRecord>();

  constructor(readonly company: Company) {}

  summary() {
    return [...this.#records.values()].map((record) => ({
      id: record.id,
      state: record.performed ? "succeeded" : "proposed",
      revision: record.revisions.size,
      confirms: record.approvals,
      approvedBy: record.performed ? "user" : null
    }));
  }

  /** The exchange a request asks for: its terms, and performing it once. */
  get #exchange(): Action {
    const co = this.company;
    return {
      kind: "exchange",
      terms: (asked) => {
        const price = co.config.exchangePrice;
        const custom = co.config.exchangeOperation;
        if (custom) return { summary: custom.summary, ...(custom.terms ? { terms: custom.terms } : {}) };
        const sku = typeof asked.replacement_sku === "string" ? asked.replacement_sku : "stormline-insulated-m";
        const summary = sku === "stormline-insulated-m" ? exchangeSummary(price) : `Exchange the Stormline Jacket (M) on order ord_7Hk2 for ${sku}, for $${price.amount} more.`;
        return { summary: `${summary}${co.config.injection ? ` ${co.config.injection}` : ""}`, terms: { ...exchangeTerms(price), replacement_sku: sku } };
      },
      perform: (record, context) => {
        co.performExchange(context.account, `operation ${record.id}`);
        return { status: 201, body: { exchange: { exchange_id: record.id, order_id: "ord_7Hk2", state: "placed" } } };
      }
    };
  }

  #owner(record: ApprovalRecord, context: ResourceContext): boolean {
    return record.clientId === context.session.clientId && record.userId === context.session.userId &&
      (record.account ? context.signedIn && context.account === record.account : record.sessionId === context.session.id);
  }

  #revise(record: ApprovalRecord, action: Action, asked: Record<string, unknown>): OperationV2 {
    const expiresAt = Date.now() + 10 * 60_000;
    const { summary, terms } = action.terms(asked);
    const operation: OperationV2 = { operation_id: record.id, revision: `${Math.floor(expiresAt / 1000)}-${randomId("", 9)}`, summary, ...(terms ? { terms } : {}), expires_at: new Date(expiresAt).toISOString() };
    record.revisions.set(operation.revision, { operation, expiresAt });
    record.latest = operation.revision;
    return operation;
  }

  /**
   * One write that needs approval, by API, MCP or the Company Agent.
   * `approval` is what the request carried (null: none). Returns the
   * operation to refuse with, or the performed action's response.
   */
  #approve(action: Action, context: ResourceContext, request: string, asked: Record<string, unknown>, approval: Record<string, string> | null): { readonly operation: OperationV2 } | { readonly performed: Performed } {
    const co = this.company;
    if (approval && typeof approval.operation_id === "string" && typeof approval.revision === "string") {
      const record = this.#records.get(approval.operation_id);
      // Check 1: a Session that can't approve it is handled as if it had sent no approval.
      if (record && record.kind === action.kind && this.#owner(record, context)) {
        record.approvals += 1;
        // Check 2: performed already: the first response again (Ops 7).
        if (record.performed) return { performed: record.performed };
        // Check 3: a revision it returned, unexpired, for exactly this request.
        const revision = record.revisions.get(approval.revision);
        if (revision && revision.expiresAt > Date.now() && record.request === request) {
          record.performed = action.perform(record, context);
          return { performed: record.performed };
        }
        // Never the revision it names, so an approval can't loop (Ops 6).
        return { operation: this.#revise(record, action, asked) };
      }
    }
    for (const record of this.#records.values()) {
      if (record.kind !== action.kind || record.performed || record.request !== request || !this.#owner(record, context)) continue;
      const latest = record.revisions.get(record.latest)!;
      if (latest.expiresAt > Date.now()) return { operation: latest.operation };
      return { operation: this.#revise(record, action, asked) };
    }
    const prefix = action.kind === "prints" ? "prt_" : (co.config.operationIdPrefix ?? "exc_");
    const record: ApprovalRecord = {
      id: randomId(prefix, 6).replace(/[^A-Za-z0-9_-]/g, "_"),
      kind: action.kind,
      clientId: context.session.clientId,
      userId: context.session.userId,
      sessionId: context.session.id,
      account: context.signedIn ? context.account : null,
      request,
      revisions: new Map(),
      latest: "",
      performed: null,
      approvals: 0
    };
    this.#records.set(record.id, record);
    return { operation: this.#revise(record, action, asked) };
  }

  /** The jacket exchange, by API, MCP or the Company Agent. */
  exchange(context: ResourceContext, request: string, asked: Record<string, unknown>, approval: Record<string, string> | null) {
    return this.#approve(this.#exchange, context, request, asked, approval);
  }

  /**
   * An order of prints (`POST /prints`), signed out: its terms are the
   * order's, and approved it is placed, to be paid at a checkout link on
   * the Company's website.
   */
  prints(context: ResourceContext, request: string, terms: Terms, approval: Record<string, string> | null) {
    const co = this.company;
    return this.#approve(
      {
        kind: "prints",
        terms: () => ({ summary: `${terms.summary}${co.config.injection ? ` ${co.config.injection}` : ""}`, ...(terms.terms ? { terms: terms.terms } : {}) }),
        perform: () => {
          const order = randomId("ord_", 6);
          co.performs += 1;
          return { status: 201, body: { order: { order_id: order, state: "awaiting_payment", checkout_url: `${co.hosts.web}/checkout/${order}` } } };
        }
      },
      context,
      request,
      {},
      approval
    );
  }

  /** A revision's operation, for a test playing the Company Agent. */
  latest(id: string): OperationV2 | null {
    const record = this.#records.get(id);
    return record ? record.revisions.get(record.latest)!.operation : null;
  }
}
