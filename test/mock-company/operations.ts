import { Company, randomId, type ResourceContext, type Session } from "./core";

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

/** An operation, as the Company returns it (Ops 3). Version 3 may leave out `summary`, never `terms`. */
export type OperationV2 = {
  readonly operation_id: string;
  readonly revision: string;
  readonly summary?: string;
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
  readonly perform: (record: ApprovalRecord, context: Owner) => Performed;
};

/** Who is asking: enough of a request's context to say whether its Session can approve an operation (Ops 3). */
type Owner = Pick<ResourceContext, "session" | "signedIn" | "account">;

/** What the operations endpoint answers (0.4 Ops 4, 6): a status, and a JSON body unless 204. */
export type EndpointAnswer = { readonly status: number; readonly body?: Record<string, unknown> };

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
  /** Who approved the revision it was performed for: `approver` under version 3, or the User under version 2. */
  approvedBy: string | null;
  /** The approvals it declined (0.4 Ops 6, "Declining an approval"), by `declinedKey`. */
  readonly declined: Set<string>;
  /** Revisions it returned in answer to an agent approval, which only the User may approve (Ops 5). */
  readonly afterAgent: Set<string>;
  /** Returned on the website (0.4 Ops 4): approved only at `endpoint`, and performed by the browser's request. */
  readonly web: boolean;
  /** What the request asked, for the terms of a later revision. */
  readonly asked: Record<string, unknown>;
  /** Website only: the references it returned in `Poppy-Operation`. */
  readonly refs: Set<string>;
  /** Website only: revisions whose approval `endpoint` recorded and no request has used up, oldest first (Ops 6). */
  readonly recorded: string[];
};

/** A decline's members (Ops 6): no reason codes, and nothing the Session couldn't already see. */
export type Declined = {
  readonly operation_id: string;
  readonly revision: string;
  readonly reason: string;
  readonly alternative: { readonly instructions: string; readonly references: readonly { readonly type: "web"; readonly url: string }[] };
};

/** An approval as sent: a header's String and Integer members, or a JSON object (Ops 6). */
export type Approval = Readonly<Record<string, unknown>>;

/** IDs as in 0.4 8.2: 1 to 256 characters of the URL-safe base64 alphabet. */
const ID = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * `Poppy-Approval` (Ops 6): an RFC 9651 Dictionary, its String and Integer
 * members by key; null if the field doesn't parse as a Dictionary (RFC 9651
 * 4.2), so the Company ignores it. Members of other types, and parameters,
 * are kept out: Companies "MUST ignore members … they don't recognize".
 */
export function parseApprovalHeader(value: string): Record<string, string | number> | null {
  const members: Record<string, string | number> = {};
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
        if (/^-?\d{1,15}$/.test(item)) members[key] = Number(item);
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
  /** Each `reference` an approval carried, by User, and the revision it approved (Ops 6). */
  readonly #references = new Map<string, string>();

  constructor(readonly company: Company) {}

  summary() {
    return [...this.#records.values()].map((record) => ({
      id: record.id,
      state: record.performed ? "succeeded" : "proposed",
      revision: record.revisions.size,
      confirms: record.approvals,
      approvedBy: record.approvedBy
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

  #owner(record: ApprovalRecord, context: Owner): boolean {
    return record.clientId === context.session.clientId && record.userId === context.session.userId &&
      (record.account ? context.signedIn && context.account === record.account : record.sessionId === context.session.id);
  }

  #revise(record: ApprovalRecord, action: Action, asked: Record<string, unknown>): OperationV2 {
    const expiresAt = Date.now() + 10 * 60_000;
    const { summary, terms } = action.terms(asked);
    const omitSummary = this.company.config.omitOperationSummary && terms !== undefined;
    const operation: OperationV2 = { operation_id: record.id, revision: `${Math.floor(expiresAt / 1000)}-${randomId("", 9)}`, ...(omitSummary ? {} : { summary }), ...(terms ? { terms } : {}), expires_at: new Date(expiresAt).toISOString() };
    record.revisions.set(operation.revision, { operation, expiresAt });
    record.latest = operation.revision;
    return operation;
  }

  /**
   * One write that needs approval, by API, MCP or the Company Agent.
   * `approval` is what the request carried (null: none). Returns the
   * operation to refuse with, or the performed action's response.
   */
  #approve(action: Action, context: ResourceContext, request: string, asked: Record<string, unknown>, approval: Approval | null): { readonly operation: OperationV2 } | { readonly performed: Performed } | { readonly declined: Declined } {
    const co = this.company;
    if (approval && typeof approval.operation_id === "string" && typeof approval.revision === "string") {
      const version3 = co.operationsVersion(context) === "3";
      if (version3) this.#checkVersion3(context, approval as Approval & { operation_id: string; revision: string });
      const record = this.#records.get(approval.operation_id);
      // A website's operation is approved only at `endpoint` (0.4 Ops 6): here, as if no approval came.
      if (record?.web) co.violation("web-operation.approved-elsewhere", `the website's operation ${record.id} was approved at ${action.kind === "prints" ? "the print API" : "an API, MCP server or conversation"}`);
      // Check 1: a Session that can't approve it is handled as if it had sent no approval.
      if (record && !record.web && record.kind === action.kind && this.#owner(record, context)) {
        record.approvals += 1;
        // Check 2: performed already: the first response again (Ops 7).
        if (record.performed) return { performed: record.performed };
        const agent = version3 && approval.approver === "agent";
        if (version3) this.#checkAfterDecline(record, approval as Approval & { operation_id: string; revision: string }, agent);
        // Check 3: a revision it returned, unexpired, for exactly this request.
        const revision = record.revisions.get(approval.revision);
        if (revision && revision.expiresAt > Date.now() && record.request === request) {
          // A Company whose terms moved since the first revision answers its approval with a new one (Ops 6).
          if (co.config.reviseOnFirstApproval && record.revisions.size === 1) {
            const next = this.#revise(record, action, asked);
            if (agent) record.afterAgent.add(next.revision);
            return { operation: next };
          }
          // 0.4 Ops 6: once the checks pass, a Company may decline, for its own reasons, such as `approver`.
          const declines = co.config.declineApprovals;
          if (version3 && (declines === "all" || (declines === "agent" && agent))) {
            record.declined.add(declinedKey(approval as Approval & { revision: string }));
            return { declined: this.#decline(record, approval.revision) };
          }
          record.approvedBy = version3 && typeof approval.approver === "string" ? approval.approver : "user";
          record.performed = action.perform(record, context);
          return { performed: record.performed };
        }
        // Never the revision it names, so an approval can't loop (Ops 6).
        const next = this.#revise(record, action, asked);
        if (agent) record.afterAgent.add(next.revision);
        return { operation: next };
      }
    }
    for (const record of this.#records.values()) {
      if (record.web || record.kind !== action.kind || record.performed || record.request !== request || !this.#owner(record, context)) continue;
      const latest = record.revisions.get(record.latest)!;
      if (latest.expiresAt > Date.now()) return { operation: latest.operation };
      return { operation: this.#revise(record, action, asked) };
    }
    const record = this.#create(action, context, request, asked, false);
    return { operation: this.#revise(record, action, asked) };
  }

  #create(action: Action, context: Owner, request: string, asked: Record<string, unknown>, web: boolean): ApprovalRecord {
    const co = this.company;
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
      approvals: 0,
      approvedBy: null,
      declined: new Set(),
      afterAgent: new Set(),
      asked,
      web,
      refs: new Set(),
      recorded: []
    };
    this.#records.set(record.id, record);
    return record;
  }

  /**
   * What version 3 asks of an approval's own members (Ops 6). A Company
   * MUST NOT reject an approval for an optional member, so these are
   * recorded and the approval is checked as usual.
   */
  #checkVersion3(context: ResourceContext, approval: Approval & { readonly operation_id: string; readonly revision: string }): void {
    const co = this.company;
    const { approver, approved_at: approvedAt, input_type: inputType, reference } = approval;
    if (approver !== "user" && approver !== "agent") {
      co.violation("approval.approver", `the approval of ${approval.operation_id} has approver ${JSON.stringify(approver)}, not "user" or "agent"`);
    }
    if (approvedAt !== undefined && !Number.isSafeInteger(approvedAt)) {
      co.violation("approval.approved-at", `approved_at ${JSON.stringify(approvedAt)} isn't an Integer of Unix seconds`);
    }
    if (inputType !== undefined && approver === "agent") {
      co.violation("approval.input-type-with-agent", `an agent approval of ${approval.operation_id} has input_type ${JSON.stringify(inputType)}`);
    }
    if (inputType !== undefined && typeof inputType !== "string") {
      co.violation("approval.input-type", `input_type ${JSON.stringify(inputType)} isn't a String`);
    }
    if (reference === undefined) return;
    if (typeof reference !== "string" || !ID.test(reference)) {
      co.violation("approval.reference", `reference ${JSON.stringify(reference)} isn't 1 to 256 URL-safe base64 characters`);
      return;
    }
    // The same approval sent again keeps its reference; another approval needs its own.
    const key = `${context.session.clientId}|${context.session.userId}|${reference}`;
    const approved = `${approval.operation_id} ${approval.revision}`;
    const earlier = this.#references.get(key);
    if (earlier !== undefined && earlier !== approved) {
      co.violation("approval.reference-reused", `reference ${reference} approved ${earlier}, then ${approved}`);
    }
    this.#references.set(key, approved);
  }

  #decline(record: ApprovalRecord, revision: string): Declined {
    const co = this.company;
    return {
      operation_id: record.id,
      revision,
      reason: "Only the account holder can approve this.",
      alternative: { instructions: "The account holder can do this on our website.", references: [{ type: "web", url: `${co.hosts.web}/orders/ord_7Hk2` }] }
    };
  }

  /**
   * What a Personal Agent may not do after a decline, or after its own
   * approval was answered with a new revision (0.4 Ops 5, 6): send a
   * declined approval again, or approve the action again without the User.
   */
  #checkAfterDecline(record: ApprovalRecord, approval: Approval & { readonly operation_id: string; readonly revision: string }, agent: boolean): void {
    const co = this.company;
    if (record.declined.has(declinedKey(approval))) {
      co.violation("approval.declined-resent", `the declined approval of ${approval.operation_id} revision ${approval.revision} was sent again`);
    } else if (agent && record.declined.size > 0) {
      co.violation("approval.agent-after-decline", `after a decline, the agent approved a new revision of ${approval.operation_id} itself, without the User`);
    }
    if (agent && record.afterAgent.has(approval.revision)) {
      co.violation("approval.agent-after-revision", `the agent approved revision ${approval.revision} of ${approval.operation_id}, which answered its own approval, instead of asking the User`);
    }
  }

  /** The jacket exchange, by API, MCP or the Company Agent. */
  exchange(context: ResourceContext, request: string, asked: Record<string, unknown>, approval: Approval | null) {
    return this.#approve(this.#exchange, context, request, asked, approval);
  }

  /**
   * An order of prints (`POST /prints`), signed out: its terms are the
   * order's, and approved it is placed, to be paid at a checkout link on
   * the Company's website.
   */
  prints(context: ResourceContext, request: string, terms: Terms, approval: Approval | null) {
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

  /**
   * The website's exchange form, from a browser joined to `session`
   * (0.4 Ops 4, 6): performed with the oldest recorded approval that matches
   * the request, which it uses up; otherwise a reference to the operation,
   * for `Poppy-Operation`. A performed operation is never reused, so the next
   * request for it is a new one.
   */
  websiteExchange(session: Session, request: string, asked: Record<string, unknown>): { readonly performed: Performed } | { readonly ref: string } {
    const owner: Owner = { session, signedIn: session.account !== null, account: session.account };
    const action = this.#exchange;
    const now = Date.now();
    for (const record of this.#records.values()) {
      if (!record.web || record.kind !== action.kind || record.performed || record.request !== request || !this.#owner(record, owner)) continue;
      const index = record.recorded.findIndex((revision) => record.revisions.get(revision)!.expiresAt > now);
      if (index >= 0) {
        const [revision] = record.recorded.splice(index, 1);
        record.approvedBy = this.#approvers.get(`${record.id} ${revision}`) ?? "user";
        record.performed = action.perform(record, owner);
        return { performed: record.performed };
      }
      const latest = record.revisions.get(record.latest)!;
      const revision = latest.expiresAt > now ? record.latest : this.#revise(record, action, asked).revision;
      return { ref: this.#ref(record, revision) };
    }
    const record = this.#create(action, owner, request, asked, true);
    return { ref: this.#ref(record, this.#revise(record, action, asked).revision) };
  }

  /** Who approved each recorded website revision, until a request uses it up. */
  readonly #approvers = new Map<string, string>();

  #ref(record: ApprovalRecord, revision: string): string {
    const ref = `${record.id}.${revision}`;
    record.refs.add(ref);
    return ref;
  }

  /**
   * `POST {endpoint}` (0.4 Ops 4, 6): a reference the website returned gets
   * its operation; with `Poppy-Approval`, the approval is recorded (204) or
   * declined, and performs nothing; once recorded, the reference alone gets
   * the operation's state. Anything else is `invalid_request`.
   */
  atEndpoint(context: ResourceContext, ref: string, approval: Approval | null): EndpointAnswer {
    const co = this.company;
    const record = this.#records.get(ref.split(".")[0] ?? "");
    if (!record?.web || !record.refs.has(ref)) {
      co.violation("web-operation.unknown-ref", `the reference ${JSON.stringify(ref.slice(0, 80))} came to endpoint, but the website never returned it`);
      return { status: 400, body: { error: "invalid_request" } };
    }
    if (!this.#owner(record, context)) return { status: 400, body: { error: "invalid_request" } };
    const now = Date.now();
    const action = this.#exchange;
    const named = record.revisions.get(ref.slice(record.id.length + 1));
    if (approval && typeof approval.operation_id === "string" && typeof approval.revision === "string") {
      const sent = approval as Approval & { operation_id: string; revision: string };
      this.#checkVersion3(context, sent);
      record.approvals += 1;
      if (record.performed) return { status: 204 };
      const agent = sent.approver === "agent";
      this.#checkAfterDecline(record, sent, agent);
      const revision = record.revisions.get(sent.revision);
      // Check 3: a revision it returned for this operation, unexpired.
      if (sent.operation_id === record.id && revision && revision.expiresAt > now) {
        const declines = co.config.declineApprovals;
        if (declines === "all" || (declines === "agent" && agent)) {
          // Never recorded, so the website never finds it (Ops 6).
          record.declined.add(declinedKey(sent));
          return { status: 403, body: { error: "approval_declined", ...this.#decline(record, sent.revision) } };
        }
        if (!record.recorded.includes(sent.revision)) record.recorded.push(sent.revision);
        this.#approvers.set(`${record.id} ${sent.revision}`, typeof sent.approver === "string" ? sent.approver : "user");
        return { status: 204 };
      }
      // Failing check 3: what section 4 gives the reference, never the revision the approval names.
      if (!named || named.expiresAt <= now) return { status: 400, body: { error: "invalid_request" } };
      const latest = record.revisions.get(record.latest)!;
      const operation = latest.expiresAt > now && record.latest !== sent.revision ? latest.operation : this.#revise(record, action, record.asked);
      if (agent) record.afterAgent.add(operation.revision);
      return { status: 403, body: { error: "approval_required", operation } };
    }
    // Looking up an approved operation (Ops 6).
    if (record.performed || record.recorded.length > 0) {
      return { status: 200, body: { operation_id: record.id, status: record.performed ? "performed" : "approved" } };
    }
    if (!named || named.expiresAt <= now) return { status: 400, body: { error: "invalid_request" } };
    const latest = record.revisions.get(record.latest)!;
    return { status: 403, body: { error: "approval_required", operation: latest.expiresAt > now ? latest.operation : this.#revise(record, action, record.asked) } };
  }

  /** A revision's operation, for a test playing the Company Agent. */
  latest(id: string): OperationV2 | null {
    const record = this.#records.get(id);
    return record ? record.revisions.get(record.latest)!.operation : null;
  }
}

/**
 * A declined approval, as it would be sent again: its revision and who
 * approved. The User's own approval of a revision whose agent approval was
 * declined is a new approval, which is what Ops 6 leaves the agent to ask
 * for (readings v04-agent-approval-again).
 */
function declinedKey(approval: Approval & { readonly revision: string }): string {
  return `${approval.revision} ${approval.approver === "agent" ? "agent" : "user"}`;
}
