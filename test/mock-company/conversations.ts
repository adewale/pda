import {
  Company,
  HttpError,
  json,
  randomId,
  resourceError,
  type Inbound,
  type ResourceContext
} from "./core";
import type { Operations } from "./operations";
import type { ViolationId } from "./violations";

export type ConversationEvent = {
  readonly id: string;
  readonly type: string;
  readonly created_at: string;
  readonly [field: string]: unknown;
};

type Status = "working" | "idle" | "queued" | "closed";
type Responder = "agent" | "human";

type Conversation = {
  readonly id: string;
  readonly owner: { clientId: string; userId: string; account: string | null };
  readonly parentId: string | null;
  readonly direct: boolean;
  directChild: string | null;
  status: Status;
  responder: Responder;
  events: ConversationEvent[];
  /** Event ids the Company no longer keeps; their cursors are `cursor_expired`. */
  readonly expired: Set<string>;
  readonly sent: string[];
  context: Record<string, unknown>;
};

type IncomingMessage = {
  id?: unknown;
  sender?: unknown;
  /** 0.3: who wrote it (8.4). */
  author?: unknown;
  /** 0.3, Operations 2: the User's approval of an operation (Ops 6). */
  approval?: unknown;
  text?: unknown;
  data?: unknown;
  context?: unknown;
  [field: string]: unknown;
};

const ID = /^[A-Za-z0-9_-]{1,256}$/;
/**
 * A well-formed RFC 5646 language tag (2.1, case-insensitive): a `langtag`
 * with any extensions (`en-US-u-ca-gregory`) and private use, a private-use
 * tag (`x-...`), or a grandfathered one (`i-klingon`).
 */
const LOCALE = new RegExp(
  "^(?:" +
    "(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})" + // language, with extlang
    "(?:-[a-z]{4})?" + // script
    "(?:-(?:[a-z]{2}|[0-9]{3}))?" + // region
    "(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*" + // variants
    "(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*" + // extensions
    "(?:-x(?:-[a-z0-9]{1,8})+)?" + // private use
    "|x(?:-[a-z0-9]{1,8})+" +
    "|en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)|sgn-(?:be-fr|be-nl|ch-de)" +
    "|art-lojban|cel-gaulish|no-bok|no-nyn|zh-(?:guoyu|hakka|min|min-nan|xiang)" +
    ")$",
  "i"
);
/**
 * An IANA time zone name by the tz database's rules for names (its
 * theory.html): components of ASCII letters, digits, `.`, `-`, `_` and `+`,
 * separated by `/`, none starting with `-` or being `.` or `..`. So
 * "America/Argentina/Buenos_Aires", "Etc/GMT+5", "CET" and "EST5EDT" alike.
 */
const TIME_ZONE = /^(?!-|\.\.?(?:\/|$))[A-Za-z0-9._+-]+(?:\/(?!-|\.\.?(?:\/|$))[A-Za-z0-9._+-]+)*$/;

function now(): string {
  return new Date().toISOString();
}

/** A JSON value as text with every object's members sorted, so member order doesn't change it. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const members = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}


/** Personal Agent Protocol conversations, Company side (spec section 8). */
export class Conversations {
  readonly #conversations = new Map<string, Conversation>();
  /** Message idempotency per User: id → content hash and conversation (8.3). */
  readonly #messageIds = new Map<string, { hash: string; conversationId: string }>();
  /** Long polls waiting for the next event in any conversation. */
  #waiters: (() => void)[] = [];
  operations: Operations | undefined;

  constructor(readonly company: Company) {}

  /** Who wrote a message the agent sent: its `author.type` (8.4, 8.8). */
  #writer(message: IncomingMessage): unknown {
    const author = message.author;
    return typeof author === "object" && author !== null && !Array.isArray(author) ? (author as { type?: unknown }).type : undefined;
  }

  summary(): {
    id: string;
    userId: string;
    parent: string | null;
    direct: boolean;
    status: string;
    responder: string;
    sent: string[];
    context: string;
  }[] {
    return [...this.#conversations.values()].map((conversation) => ({
      id: conversation.id,
      userId: conversation.owner.userId,
      parent: conversation.parentId,
      direct: conversation.direct,
      status: conversation.status,
      responder: conversation.responder,
      sent: [...conversation.sent],
      context: JSON.stringify(conversation.context)
    }));
  }

  #add(conversation: Conversation, event: Omit<ConversationEvent, "id" | "created_at">): ConversationEvent {
    const full = { id: randomId("evt_", 8), created_at: now(), ...event } as ConversationEvent;
    conversation.events.push(full);
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
    return full;
  }

  #setState(conversation: Conversation, status: Status, responder: Responder = conversation.responder): void {
    if (conversation.status === status && conversation.responder === responder) return;
    conversation.status = status;
    conversation.responder = responder;
    this.#add(conversation, { type: "state", status, responder });
  }

  #say(conversation: Conversation, text: string, extra: Record<string, unknown> = {}): void {
    // `author`, naming the person when one writes (8.4, 8.7).
    const writer = { author: conversation.responder === "human" ? { type: "human", id: "aut_alex", name: "Alex" } : { type: "agent" } };
    this.#add(conversation, {
      type: "message",
      message: {
        id: randomId("msg_", 8),
        role: "company",
        ...writer,
        text,
        ...extra
      }
    });
  }

  /** The conversation, if this token's owner may use it (8.2, 8.11). */
  #owned(context: ResourceContext, id: string): Conversation {
    const conversation = this.#conversations.get(id);
    const notFound = () =>
      new HttpError(json({ error: "conversation_not_found" }, 404));
    // A different User of the same agent reaching for this conversation is a cross-User breach
    // (8.2; S17): record it, then answer conversation_not_found (8.13) so nothing of User A leaks.
    const crossUser = () => {
      this.company.violation("conversation.cross-user", `User ${context.session.userId} reached conversation ${id} of User ${conversation!.owner.userId}`);
      return notFound();
    };
    if (!conversation || conversation.owner.clientId !== context.session.clientId) throw notFound();
    if (conversation.owner.account) {
      if (context.signedIn && context.account === conversation.owner.account) return conversation;
      if (conversation.owner.userId === context.session.userId) {
        // A challenge for the account, as an account action gets (8.11, 7).
        this.company.requireScopes({ ...context, signedIn: false }, [this.company.orderScopes.read]);
      }
      throw crossUser();
    }
    if (conversation.owner.userId !== context.session.userId) throw crossUser();
    return conversation;
  }

  #validate(message: IncomingMessage | undefined): IncomingMessage {
    const co = this.company;
    const bad = (id: ViolationId, why: string) => {
      co.violation(id, `conversation message: ${why}`);
      return new HttpError(json({ error: "invalid_request", error_description: why }, 400));
    };
    if (!message || typeof message !== "object") throw bad("message.missing", "missing message");
    if (typeof message.id !== "string" || !ID.test(message.id)) {
      throw bad("message.id", "id must be 1-256 base64url characters");
    }
    if ("sender" in message) co.violation("message.sender-field", "conversation message: sender is 0.2's; 0.3 says author.type (8.4)");
    const type = this.#writer(message);
    if (type !== "agent" && type !== "human") throw bad("message.author", "author.type must be agent or human");
    const author = message.author as Record<string, unknown>;
    if (Object.keys(author).some((key) => key !== "type")) co.violation("message.author", "conversation message: only Company messages name an author's id, name or image (8.4)");
    if (message.text === undefined && message.data === undefined && message.context === undefined && message.approval === undefined) {
      throw bad("message.empty", "needs at least one of text, data or context");
    }
    if (message.text !== undefined) {
      if (typeof message.text !== "string") throw bad("message.text-type", "text must be a string");
      const trimmed = message.text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          JSON.parse(trimmed);
          co.violation("message.json-in-text", "conversation message: JSON in text; use data (8.4)");
        } catch {
          // Prose that starts with a bracket.
        }
      }
    }
    if (message.data !== undefined && (typeof message.data !== "object" || message.data === null || Array.isArray(message.data))) {
      throw bad("message.data-type", "data must be a JSON object");
    }
    if (message.context !== undefined) {
      const context = message.context as Record<string, unknown>;
      if (typeof context !== "object" || context === null) throw bad("message.context-type", "context must be an object");
      if ("locale" in context && (typeof context.locale !== "string" || !LOCALE.test(context.locale))) {
        co.violation("context.locale", `context.locale ${JSON.stringify(context.locale)} is not an RFC 5646 tag`);
      }
      if ("time_zone" in context && (typeof context.time_zone !== "string" || !TIME_ZONE.test(context.time_zone))) {
        co.violation("context.time-zone", `context.time_zone ${JSON.stringify(context.time_zone)} is not an IANA name`);
      }
      if ("user_available" in context && typeof context.user_available !== "boolean") {
        co.violation("context.user-available", "context.user_available must be a boolean");
      }
    }
    return message;
  }

  /**
   * Same id and content: the original response. Different content: conflict
   * (8.3). The same content is the same JSON value, whatever its members'
   * order (RFC 8259 4: an object is an unordered collection).
   */
  #idempotent(context: ResourceContext, message: IncomingMessage, parent: string | null): Conversation | null {
    const key = `${context.session.clientId}|${context.session.userId}|${message.id as string}`;
    const hash = canonicalJson({ message, parent });
    const seen = this.#messageIds.get(key);
    if (!seen) return null;
    if (seen.hash !== hash) {
      this.company.violation("message.id-reused", `message id ${String(message.id)} reused with different content`);
      throw new HttpError(json({ error: "message_id_conflict" }, 409));
    }
    return this.#conversations.get(seen.conversationId) ?? null;
  }

  #remember(context: ResourceContext, message: IncomingMessage, parent: string | null, conversation: Conversation): void {
    const key = `${context.session.clientId}|${context.session.userId}|${message.id as string}`;
    this.#messageIds.set(key, { hash: canonicalJson({ message, parent }), conversationId: conversation.id });
  }

  #accept(context: ResourceContext, conversation: Conversation, message: IncomingMessage): void {
    conversation.sent.push(`${String(this.#writer(message))}:${typeof message.text === "string" ? message.text : ""}`);
    if (message.context) {
      conversation.context = { ...conversation.context, ...(message.context as Record<string, unknown>) };
    }
    const { context: _context, ...withoutContext } = message;
    this.#add(conversation, { type: "message", message: { ...withoutContext, role: "user" } });
    if (message.approval !== undefined) this.#approved(context, conversation, message.approval);
    else if (message.text !== undefined || message.data !== undefined) this.#reply(context, conversation, message);
  }

  /**
   * A message's `approval` (Ops 6). Only the field
   * approves, whatever the text says; the operation must be this
   * conversation's. The Company Agent says how it went in a later message.
   */
  #approved(context: ResourceContext, conversation: Conversation, approval: unknown): void {
    const co = this.company;
    const given = typeof approval === "object" && approval !== null && !Array.isArray(approval) ? (approval as Record<string, unknown>) : null;
    if (!given || typeof given.operation_id !== "string" || typeof given.revision !== "string") {
      co.violation("approval.message", "a message's approval isn't an object with operation_id and revision strings");
      return;
    }
    if (!this.operations) return;
    const result = this.operations.exchange(context, `conversation ${conversation.id}`, {}, given as Record<string, string>);
    if ("operation" in result) {
      this.#say(conversation, "Those terms have changed. Here are the current ones.", { operation: result.operation });
      return;
    }
    this.#say(conversation, "Done. The insulated jacket ships today, and a return label for the original was emailed.");
  }

  /** The scripted Company Agent. Deterministic, so tests can predict it. */
  #reply(context: ResourceContext, conversation: Conversation, message: IncomingMessage): void {
    const co = this.company;
    // Interop XE: the Company forges a `role: "user"` message, passing off its
    // own words as the User's (8.5). A correct agent never treats a message
    // the Company sent as the User speaking, so it has no effect.
    if (co.config.spoofUserText) {
      this.#add(conversation, {
        type: "message",
        message: { id: randomId("msg_", 8), role: "user", author: { type: "human" }, text: co.config.spoofUserText }
      });
    }
    if (!co.config.agentReplies || conversation.responder === "human" || conversation.status === "queued") {
      return;
    }
    const text = typeof message.text === "string" ? message.text.toLowerCase() : "";
    if (text.includes("person")) {
      this.#say(conversation, "Let me find a person to help with this.");
      this.#setState(conversation, co.config.neverQueued ? "working" : "queued");
      return;
    }
    if (/order|exchange|return/.test(text)) {
      if (!context.signedIn) {
        // `insufficient_scope`, with the scopes, whether or not the request had a token (8.11).
        this.#add(conversation, { type: "authorization", error: "insufficient_scope", scope: `${co.orderScopes.read} ${co.orderScopes.write}` });
        this.#say(conversation, "Please sign in so I can look up your order.");
        return;
      }
      const { read, write } = co.orderScopes;
      if (![read, write].every((scope) => context.scope.includes(scope))) {
        this.#add(conversation, {
          type: "authorization",
          error: "insufficient_scope",
          scope: `${read} ${write}`
        });
        this.#say(conversation, "I need permission to view and change your orders to do that.");
        return;
      }
      // The conversation now uses the User's account, so it belongs to it (8.2).
      conversation.owner.account = context.account;
      if (co.config.operations && context.client.listsOperations && this.operations) {
        const result = this.operations.exchange(context, `conversation ${conversation.id}`, {}, null);
        if ("operation" in result) {
          this.#say(conversation, "I can exchange it for the insulated version in medium for $70 more. I'll do it once you approve.", { operation: result.operation });
          return;
        }
      }
      this.#say(conversation, "I can exchange it for the insulated version for $70 more.", {
        data: { replacement_sku: "stormline-insulated-m", price_difference: 70 }
      });
      return;
    }
    this.#say(conversation, "Hi! How can I help?");
  }

  #params(inbound: Inbound): { cursor: string | null; wait: number } {
    const cursor =
      inbound.request.headers.get("Last-Event-ID") ?? inbound.url.searchParams.get("cursor");
    const rawWait = inbound.url.searchParams.get("wait") ?? "0";
    const wait = Number(rawWait);
    // 8.5: "a whole number of seconds, 0 or more"; anything else is invalid_request (8.13).
    if (!/^\d+$/.test(rawWait) || !Number.isSafeInteger(wait)) {
      throw new HttpError(json({ error: "invalid_request" }, 400));
    }
    return { cursor, wait: Number.isFinite(wait) && wait > 0 ? wait : 0 };
  }

  #from(conversation: Conversation, cursor: string | null): number {
    if (cursor === null) return 0;
    const index = conversation.events.findIndex((event) => event.id === cursor);
    if (index >= 0) return index + 1;
    if (conversation.expired.has(cursor)) {
      throw new HttpError(json({ error: "cursor_expired" }, 410));
    }
    throw new HttpError(json({ error: "invalid_cursor" }, 400));
  }

  async #read(conversation: Conversation, cursor: string | null, wait: number) {
    let start = this.#from(conversation, cursor);
    const deadline = Date.now() + Math.min(wait, this.company.config.maxWaitSeconds) * 1000;
    // A long poll: wake on the next event, or give up at the deadline.
    while (conversation.events.length <= start && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        timer = setTimeout(resolve, deadline - Date.now());
      });
      clearTimeout(timer);
      start = this.#from(conversation, cursor);
    }
    const events = conversation.events.slice(start, start + this.company.config.eventPageSize);
    return {
      conversation_id: conversation.id,
      events,
      cursor: events.at(-1)?.id ?? cursor,
      has_more: conversation.events.length > start + events.length,
      status: conversation.status,
      responder: conversation.responder
    };
  }

  /** A POST's reply: plain, or a read when `wait` is given (8.3). */
  async #answer(inbound: Inbound, conversation: Conversation, status: number): Promise<Response> {
    const { cursor, wait } = this.#params(inbound);
    if (inbound.url.searchParams.has("wait") && !this.company.config.ignoreWait) {
      return json(await this.#read(conversation, cursor, wait), status);
    }
    return json(
      { conversation_id: conversation.id, status: conversation.status, responder: conversation.responder },
      status
    );
  }

  #body(inbound: Inbound): Record<string, unknown> {
    try {
      const body = JSON.parse(inbound.bodyText || "null") as unknown;
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        return body as Record<string, unknown>;
      }
    } catch {
      // Fall through.
    }
    throw new HttpError(json({ error: "invalid_request", error_description: "expected a JSON object" }, 400));
  }

  /** `POST {endpoint}`: a new conversation, or a Direct Conversation (8.3, 8.10). */
  async start(inbound: Inbound, context: ResourceContext): Promise<Response> {
    const body = this.#body(inbound);
    const message = this.#validate(body.message as IncomingMessage | undefined);
    const parentId = typeof body.parent_conversation_id === "string" ? body.parent_conversation_id : null;
    // A flawed Company (retry-new-conversation) forgets first messages, so a retry starts another conversation.
    const existing = this.company.flawed("retry-new-conversation") ? null : this.#idempotent(context, message, parentId);
    // A retry gets the original response only if it may still read the
    // conversation: once it used the account, 8.11 wins (S8), as in message().
    if (existing) return this.#answer(inbound, this.#owned(context, existing.id), 201);
    let parent: Conversation | null = null;
    if (parentId) {
      parent = this.#owned(context, parentId);
      if (parent.direct) throw new HttpError(json({ error: "conversation_not_found" }, 404));
      if (parent.status === "closed") throw new HttpError(json({ error: "conversation_closed" }, 409));
      if (parent.directChild) {
        throw new HttpError(
          json({ error: "direct_conversation_open", conversation_id: parent.directChild }, 409)
        );
      }
      // In a Direct Conversation the User talks; their words go as `human` (8.10).
      if (this.#writer(message) !== "human" && message.text !== undefined) {
        this.company.violation(
          "direct.agent-words",
          "Direct Conversation opened with words not marked as the User's (sender agent)"
        );
      }
    }
    const conversation: Conversation = {
      id: randomId("cnv_", 8),
      owner: {
        clientId: context.session.clientId,
        userId: context.session.userId,
        account: parent?.owner.account ?? null
      },
      parentId,
      direct: parent !== null,
      directChild: null,
      status: "idle",
      responder: "agent",
      events: [],
      expired: new Set(),
      sent: [],
      context: {}
    };
    this.#conversations.set(conversation.id, conversation);
    this.#remember(context, message, parentId, conversation);
    if (parent) {
      parent.directChild = conversation.id;
      this.#add(parent, { type: "direct_opened", conversation_id: conversation.id });
    }
    this.#accept(context, conversation, message);
    return this.#answer(inbound, conversation, 201);
  }

  /** `POST {endpoint}/{id}/messages`. */
  async message(inbound: Inbound, context: ResourceContext, id: string): Promise<Response> {
    const conversation = this.#owned(context, id);
    const body = this.#body(inbound);
    const message = this.#validate(body.message as IncomingMessage | undefined);
    const existing = this.#idempotent(context, message, null);
    if (existing) return this.#answer(inbound, existing, 202);
    if (conversation.status === "closed") {
      throw new HttpError(json({ error: "conversation_closed" }, 409));
    }
    if (conversation.directChild) {
      throw new HttpError(
        json({ error: "direct_conversation_open", conversation_id: conversation.directChild }, 409)
      );
    }
    // In a Direct Conversation the agent relays the User's words as written,
    // as `human` (8.10). It may still send context, such as user_available
    // (8.4); its own words have no place there (our reading of S12), so they
    // are recorded, though the draft gives the Company no error to return.
    if (conversation.direct && this.#writer(message) !== "human" && (message.text !== undefined || message.data !== undefined)) {
      this.company.violation("direct.agent-words-later", `agent's own words sent into Direct Conversation ${conversation.id}`);
    }
    this.#remember(context, message, null, conversation);
    this.#accept(context, conversation, message);
    return this.#answer(inbound, conversation, 202);
  }

  /** `GET {endpoint}/{id}/events`, as JSON or SSE (8.5, 8.6). */
  async events(inbound: Inbound, context: ResourceContext, id: string): Promise<Response> {
    const conversation = this.#owned(context, id);
    const { cursor, wait } = this.#params(inbound);
    // XR: once the agent has read everything, every read answers at once, as JSON: no events,
    // still working, and more to come, with a real cursor, so that is the only thing wrong.
    if (this.company.config.endlessEvents && conversation.events.length <= this.#from(conversation, cursor)) {
      return json({
        conversation_id: conversation.id,
        events: [],
        cursor: cursor ?? conversation.events.at(-1)?.id ?? null,
        has_more: true,
        status: "working",
        responder: conversation.responder
      });
    }
    const page = await this.#read(conversation, cursor, wait);
    const wantsStream = (inbound.request.headers.get("Accept") ?? "").includes("text/event-stream");
    if (!wantsStream || !this.company.config.streaming) return json(page);
    // SSE comments, which keep idle connections open, carry no event (8.6).
    const keepAlive = this.company.config.sseKeepAlive ? ": keep-alive\n\n" : "";
    let body = keepAlive;
    for (const event of page.events) {
      const message = event.message as { id?: string; role?: string; text?: string } | undefined;
      if (event.type === "message" && message?.role === "company" && message.text && this.company.config.textDeltas) {
        const half = Math.ceil(message.text.length / 2);
        for (const piece of [message.text.slice(0, half), message.text.slice(half)]) {
          body += `event: text-delta\ndata: ${JSON.stringify({ message_id: message.id, text: piece })}\n\n`;
        }
      }
      body += `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n${keepAlive}`;
    }
    // The Company may close a stream at any time (8.6); this one closes after one page.
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }
    });
  }

  #emptyBody(inbound: Inbound, id: "handoff.body" | "close.body"): void {
    const body = this.#body(inbound);
    if (Object.keys(body).length !== 0) {
      this.company.violation(id, `${id.split(".")[0]} body should be {}, got ${inbound.bodyText}`);
    }
  }

  /** `POST {endpoint}/{id}/handoff` (8.9). */
  async handoff(inbound: Inbound, context: ResourceContext, id: string): Promise<Response> {
    const conversation = this.#owned(context, id);
    this.#emptyBody(inbound, "handoff.body");
    if (conversation.status === "closed") throw new HttpError(json({ error: "conversation_closed" }, 409));
    if (conversation.directChild) {
      throw new HttpError(
        json({ error: "direct_conversation_open", conversation_id: conversation.directChild }, 409)
      );
    }
    // A person already handles it: there's no one to find, and while queued
    // `responder` stays `agent` (8.7), so nothing changes.
    if (conversation.responder !== "human") {
      this.#setState(conversation, this.company.config.neverQueued ? "working" : "queued");
    }
    return json({ status: conversation.status, responder: conversation.responder }, 202);
  }

  /** `POST {endpoint}/{id}/close` (8.12). */
  async close(inbound: Inbound, context: ResourceContext, id: string): Promise<Response> {
    const conversation = this.#owned(context, id);
    this.#emptyBody(inbound, "close.body");
    this.#closeConversation(conversation);
    return json({ status: conversation.status, responder: conversation.responder });
  }

  #closeConversation(conversation: Conversation): void {
    if (conversation.status === "closed") return;
    // Closing the parent closes its open Direct Conversation, whose closing
    // adds `direct_closed` to the parent (8.10). It goes first, so the parent
    // takes that event while it's still open and nothing after `closed`.
    if (conversation.directChild) {
      const child = this.#conversations.get(conversation.directChild);
      if (child) this.#closeConversation(child);
      conversation.directChild = null;
    }
    this.#setState(conversation, "closed");
    if (conversation.parentId) {
      const parent = this.#conversations.get(conversation.parentId);
      if (parent && parent.directChild === conversation.id) {
        parent.directChild = null;
        this.#add(parent, { type: "direct_closed", conversation_id: conversation.id });
      }
    }
  }

  // ---- Test controls ----

  pushEvent(id: string, event: Record<string, unknown>): string {
    const conversation = this.#conversations.get(id);
    if (!conversation) throw new Error(`no conversation ${id}`);
    return this.#add(conversation, event as Omit<ConversationEvent, "id" | "created_at">).id;
  }

  humanJoin(id: string, text: string): void {
    const conversation = this.#conversations.get(id);
    if (!conversation) throw new Error(`no conversation ${id}`);
    this.#setState(conversation, "idle", "human");
    this.#say(conversation, text);
  }

  /**
   * No person is available for a queued handoff (8.9): the status goes back
   * to `idle` with `responder` still `agent`, and the Company Agent says why.
   */
  staffUnavailable(id: string, text: string): void {
    const conversation = this.#conversations.get(id);
    if (!conversation) throw new Error(`no conversation ${id}`);
    if (conversation.status !== "queued") throw new Error(`conversation ${id} isn't queued for a person`);
    this.#setState(conversation, "idle", "agent");
    this.#say(conversation, text);
  }

  /** Drop every event but the last, so older cursors get `cursor_expired`. */
  expireEvents(id: string): void {
    const conversation = this.#conversations.get(id);
    if (!conversation) throw new Error(`no conversation ${id}`);
    const kept = conversation.events.slice(-1);
    for (const event of conversation.events.slice(0, -1)) conversation.expired.add(event.id);
    conversation.events = kept;
  }

  /** The Company closes a conversation itself, as when it is done or has timed out (8.12). */
  closeByCompany(id: string): void {
    const conversation = this.#conversations.get(id);
    if (!conversation) throw new Error(`no conversation ${id}`);
    this.#closeConversation(conversation);
  }

  /** The Company no longer has a conversation, so it is `conversation_not_found` (8.13). */
  forget(id: string): void {
    if (!this.#conversations.delete(id)) throw new Error(`no conversation ${id}`);
  }

  /** Say something as the Company Agent (for message-driven operations and tests). */
  say(id: string, text: string, extra: Record<string, unknown> = {}): void {
    const conversation = this.#conversations.get(id);
    if (!conversation) throw new Error(`no conversation ${id}`);
    this.#say(conversation, text, extra);
  }
}
