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
  /** The protocol version it started in (8.2), which sets the shape of its state (8.7). */
  readonly version: string;
  directChild: string | null;
  /** The local status: `working` is `working`, `handoff` is `pending` while `queued`, and `closed` is `closed` (8.7). */
  status: Status;
  responder: Responder;
  events: ConversationEvent[];
  /** Event ids the Company no longer keeps; their cursors are `cursor_expired`. */
  readonly expired: Set<string>;
  readonly sent: string[];
  context: Record<string, unknown>;
  /** The latest request the Company accepted, which its agent's messages take into account (`as_of_request`, 8.4). */
  lastRequest?: string;
};

type IncomingMessage = {
  id?: unknown;
  sender?: unknown;
  /** Who wrote it (8.4). */
  author?: unknown;
  /** Content defined by extensions, keyed by name (8.4); an approval is `extensions.operations.approval` (Ops 6). */
  extensions?: unknown;
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
  /** Request idempotency per User: id → content hash and conversation (8.3). */
  readonly #messageIds = new Map<string, { hash: string; conversationId: string }>();
  /** Accepted `user_requested` events, by parent and event: the Direct Conversation each opened (8.10). */
  readonly #acceptances = new Map<string, string>();
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
    // A state event for a change to handoff, responder or closed, never for working alone (8.7).
    const { handoff: before, closed: wasClosed } = this.#state(conversation) as { handoff: string; closed: boolean };
    const changed = conversation.responder !== responder;
    conversation.status = status;
    conversation.responder = responder;
    const { handoff, closed } = this.#state(conversation) as { handoff: string; closed: boolean };
    if (changed || handoff !== before || closed !== wasClosed) this.#add(conversation, { type: "state", handoff, responder, closed });
  }

  /** The state a read reports (8.7): its four fields. */
  #state(conversation: Conversation, working = conversation.status === "working"): Record<string, unknown> {
    const closed = conversation.status === "closed";
    return { working: working && !closed, handoff: conversation.status === "queued" ? "pending" : "none", responder: conversation.responder, closed };
  }

  #say(conversation: Conversation, text: string, extra: Record<string, unknown> = {}): void {
    // `author`, naming the person when one writes (8.4, 8.7).
    const human = conversation.responder === "human";
    const writer = { author: human ? { type: "human", id: "aut_alex", name: "Alex" } : { type: "agent" } };
    // 8.4: the Company Agent's message names the latest request it took into account; a person's never does.
    const asOf = !human && conversation.lastRequest ? { as_of_request: conversation.lastRequest } : {};
    this.#add(conversation, {
      type: "message",
      message: {
        id: randomId("msg_", 8),
        role: "company",
        ...writer,
        ...asOf,
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
    // 8.2: a conversation belongs to the client_id and the User ID that started it, and, once it
    // uses an account, to that account too. Agent IDs aren't part of ownership.
    if (!conversation || conversation.owner.clientId !== context.session.clientId) throw notFound();
    if (conversation.owner.userId !== context.session.userId) throw crossUser();
    if (conversation.owner.account) {
      if (context.signedIn && context.account === conversation.owner.account) return conversation;
      // Signed out: a challenge for the account, as an account action gets (8.11, 7).
      if (!context.signedIn) this.company.requireScopes({ ...context, signedIn: false }, [this.company.orderScopes.read]);
      // Signed in to another account: conversation_not_found (8.2's table).
      throw notFound();
    }
    return conversation;
  }

  /** A request's `id` (8.2, 8.3), which a message takes as its own. */
  #requestId(body: Record<string, unknown>): string {
    if (typeof body.id !== "string" || !ID.test(body.id)) {
      this.company.violation("request.id", `conversation request: id ${JSON.stringify(body.id)} isn't 1-256 base64url characters`);
      throw new HttpError(json({ error: "invalid_request", error_description: "id must be 1-256 base64url characters" }, 400));
    }
    return body.id;
  }

  /** The message a request carries, with its request's ID (8.3: "A message's ID is its request's ID"). */
  #incoming(body: Record<string, unknown>): IncomingMessage | undefined {
    const requestId = this.#requestId(body);
    const message = body.message as IncomingMessage | undefined;
    if (typeof message !== "object" || message === null) return message;
    return { ...message, id: requestId };
  }

  /** Where a request id is kept: per client and User (8.3). */
  #key(context: ResourceContext, requestId: string): string {
    return `${context.session.clientId}|${context.session.userId}|${requestId}`;
  }

  /**
   * A handoff, cancel or close (8.3): the same `id`, path and body as a
   * request it accepted is a retry, and true; a different path or body is
   * `request_id_conflict`. A refused request was never accepted, so its id
   * is taken only once it is (`#take`).
   */
  #retried(inbound: Inbound, context: ResourceContext, body: Record<string, unknown>): boolean {
    const requestId = this.#requestId(body);
    const seen = this.#messageIds.get(this.#key(context, requestId));
    if (seen && seen.hash !== canonicalJson({ path: inbound.url.pathname, body })) this.#conflict(requestId);
    return seen !== undefined;
  }

  /** A handoff, cancel or close accepted: its id is taken, and is the latest request the Company Agent takes into account (8.3, 8.4). */
  #take(inbound: Inbound, context: ResourceContext, conversation: Conversation, body: Record<string, unknown>): void {
    const requestId = body.id as string;
    this.#messageIds.set(this.#key(context, requestId), { hash: canonicalJson({ path: inbound.url.pathname, body }), conversationId: conversation.id });
    conversation.lastRequest = requestId;
  }

  #conflict(id: string): never {
    this.company.violation("request.id-reused", `request id ${id} reused with a different path or body`);
    throw new HttpError(json({ error: "request_id_conflict" }, 409));
  }

  #validate(message: IncomingMessage | undefined): IncomingMessage {
    const co = this.company;
    const bad = (id: ViolationId, why: string) => {
      co.violation(id, `conversation message: ${why}`);
      return new HttpError(json({ error: "invalid_request", error_description: why }, 400));
    };
    if (!message || typeof message !== "object") throw bad("message.missing", "missing message");
    if ("sender" in message) co.violation("message.sender-field", "conversation message: sender is 0.2's; 0.3 and later say author.type (8.4)");
    const type = this.#writer(message);
    if (type !== "agent" && type !== "human") throw bad("message.author", "author.type must be agent or human");
    const author = message.author as Record<string, unknown>;
    if (Object.keys(author).some((key) => key !== "type")) co.violation("message.author", "conversation message: only Company messages name an author's id, name or image (8.4)");
    if (message.text === undefined && message.data === undefined && message.context === undefined && message.extensions === undefined) {
      throw bad("message.empty", "needs at least one of text, data, context or extensions");
    }
    // 8.4: a side MUST NOT send an extension's content unless the other side lists that extension with the same version.
    if (message.extensions !== undefined && message.extensions !== null && typeof message.extensions === "object") {
      const listed = co.config.operations ? ["operations"] : [];
      for (const name of Object.keys(message.extensions)) {
        if (!listed.includes(name)) co.violation("message.extension-unlisted", `conversation message: extensions.${name}, which this Company doesn't list (8.4)`);
      }
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
      // 1.0 (8.4): a field set to null clears it.
      const cleared = (name: string) => context[name] === null && !co.config.protocolVersion.startsWith("0.");
      if ("locale" in context && !cleared("locale") && (typeof context.locale !== "string" || !LOCALE.test(context.locale))) {
        co.violation("context.locale", `context.locale ${JSON.stringify(context.locale)} is not an RFC 5646 tag`);
      }
      if ("time_zone" in context && !cleared("time_zone") && (typeof context.time_zone !== "string" || !TIME_ZONE.test(context.time_zone))) {
        co.violation("context.time-zone", `context.time_zone ${JSON.stringify(context.time_zone)} is not an IANA name`);
      }
      if ("user_available" in context && !cleared("user_available") && typeof context.user_available !== "boolean") {
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
  #idempotent(context: ResourceContext, requestId: string, hash: string): Conversation | null {
    const seen = this.#messageIds.get(this.#key(context, requestId));
    if (!seen) return null;
    if (seen.hash !== hash) this.#conflict(requestId);
    return this.#conversations.get(seen.conversationId) ?? null;
  }

  #remember(context: ResourceContext, requestId: string, hash: string, conversation: Conversation): void {
    this.#messageIds.set(this.#key(context, requestId), { hash, conversationId: conversation.id });
  }

  /** What a retry must repeat: the message, its parent, the invitation it accepts and the path (8.3, 8.10). */
  #hash(inbound: Inbound, message: IncomingMessage | null, parent: string | null, invitation: string | null = null): string {
    return canonicalJson({ message, parent, invitation, path: inbound.url.pathname });
  }

  #accept(context: ResourceContext, conversation: Conversation, message: IncomingMessage): void {
    conversation.sent.push(`${String(this.#writer(message))}:${typeof message.text === "string" ? message.text : ""}`);
    this.#asOfCursor(conversation, message);
    conversation.lastRequest = message.id as string;
    if (message.context) {
      conversation.context = { ...conversation.context, ...(message.context as Record<string, unknown>) };
    }
    this.#add(conversation, { type: "message", message: { ...message, role: "user" } });
    const approval = operationsContent(message.extensions)?.approval;
    if (approval !== undefined) this.#approved(context, conversation, approval);
    else if (message.text !== undefined || message.data !== undefined) this.#reply(context, conversation, message);
  }

  /**
   * 0.4's `as_of_cursor` (8.4): only on a message the agent wrote, and only a
   * cursor this conversation gave it. Optional, so its absence is fine.
   */
  #asOfCursor(conversation: Conversation, message: IncomingMessage): void {
    const value = (message as Record<string, unknown>).as_of_cursor;
    if (value === undefined) return;
    if (this.#writer(message) !== "agent") {
      this.company.violation("message.as-of-human", "conversation message: as_of_cursor on a message with author.type human (8.4)");
    } else if (typeof value !== "string" || (!conversation.events.some((event) => event.id === value) && !conversation.expired.has(value))) {
      this.company.violation("message.as-of-cursor", `conversation message: as_of_cursor ${JSON.stringify(value)} isn't a cursor of this conversation (8.4)`);
    }
  }

  /**
   * A message's `extensions.operations.approval` (8.4, Ops 6). Only the field
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
    const result = this.operations.exchange(context, `conversation ${conversation.id}`, {}, given);
    if ("operation" in result) {
      this.#say(conversation, "Those terms have changed. Here are the current ones.", { extensions: { operations: { operation: result.operation } } });
      return;
    }
    if ("declined" in result) {
      // 0.4 Ops 6: said in a later message, the members without `error`.
      this.#say(conversation, `I can't do that exchange. ${result.declined.reason}`, { extensions: { operations: { declined: result.declined } } });
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
      if (co.config.operations && co.operationsVersion(context) && this.operations) {
        const result = this.operations.exchange(context, `conversation ${conversation.id}`, {}, null);
        if ("operation" in result) {
          this.#say(conversation, "I can exchange it for the insulated version in medium for $70 more. I'll do it once you approve.", { extensions: { operations: { operation: result.operation } } });
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
      ...this.#state(conversation)
    };
  }

  /** A POST's reply: plain, or a read when `wait` is given (8.3). */
  /**
   * With `authorizationChallenge`, the challenge matching an `authorization`
   * event these events carry (8.11 MAY), in a response whose headers aren't
   * sent yet: a JSON one. A stream's events go after its headers, so it has none.
   */
  #challenge(events: readonly Record<string, unknown>[]): Record<string, string> {
    if (!this.company.config.authorizationChallenge) return {};
    const event = events.find((item) => item.type === "authorization");
    if (!event) return {};
    return { "WWW-Authenticate": `Bearer error="${String(event.error)}", scope="${String(event.scope)}"` };
  }

  async #answer(inbound: Inbound, conversation: Conversation, status: number): Promise<Response> {
    const { cursor, wait } = this.#params(inbound);
    if (inbound.url.searchParams.has("wait") && !this.company.config.ignoreWait) {
      const page = await this.#read(conversation, cursor, wait);
      return json(page, status, this.#challenge(page.events));
    }
    // A POST's response has only conversation_id (8.3).
    return json({ conversation_id: conversation.id }, status);
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

  /**
   * Accept a `user_requested` event (8.10): the parent and event ids name the
   * invitation, which MUST be a user_requested event in that parent
   * (`invalid_request` otherwise). Without `message`, the Company speaks
   * first. Repeating the same ids returns the same Direct Conversation without
   * another message, even after it closes, once ownership is checked. The
   * request's id is kept like a message's, with the invitation in its hash.
   */
  async #acceptInvitation(inbound: Inbound, context: ResourceContext, parentId: string | null, eventId: string, requestId: string, incoming: IncomingMessage | undefined): Promise<Response> {
    const invalid = (why: string) => new HttpError(json({ error: "invalid_request", error_description: why }, 400));
    if (parentId === null) throw invalid("user_requested_event_id needs parent_conversation_id");
    const hash = this.#hash(inbound, incoming ?? null, parentId, eventId);
    const retried = this.#idempotent(context, requestId, hash);
    if (retried) return this.#answer(inbound, this.#owned(context, retried.id), 201);
    const parent = this.#owned(context, parentId);
    const key = `${parent.id}|${eventId}`;
    const accepted = this.#acceptances.get(key);
    if (accepted) {
      const conversation = this.#owned(context, accepted);
      this.#remember(context, requestId, hash, conversation);
      return this.#answer(inbound, conversation, 201);
    }
    if (!parent.events.some((event) => event.id === eventId && event.type === "user_requested")) throw invalid("user_requested_event_id doesn't name a user_requested event in the parent");
    const message = incoming === undefined ? null : this.#validate(incoming);
    if (parent.direct) throw invalid("the parent is a Direct Conversation");
    if (parent.status === "closed") throw new HttpError(json({ error: "conversation_closed" }, 409));
    if (parent.directChild) throw new HttpError(json({ error: "direct_conversation_open", conversation_id: parent.directChild }, 409));
    if (message && this.#writer(message) !== "human" && message.text !== undefined) {
      this.company.violation("direct.agent-words", "Direct Conversation opened with words not marked as the User's (sender agent)");
    }
    const conversation: Conversation = {
      id: randomId("cnv_", 8),
      owner: { clientId: context.session.clientId, userId: context.session.userId, account: parent.owner.account },
      parentId: parent.id,
      direct: true,
      version: context.session.declaration!.version,
      directChild: null,
      status: "idle",
      responder: "agent",
      events: [],
      expired: new Set(),
      sent: [],
      context: {}
    };
    this.#conversations.set(conversation.id, conversation);
    this.#acceptances.set(key, conversation.id);
    parent.directChild = conversation.id;
    this.#add(parent, { type: "direct_opened", conversation_id: conversation.id });
    this.#remember(context, requestId, hash, conversation);
    if (message) {
      this.#accept(context, conversation, message);
    } else {
      // The Company's first message, recorded as a message event (8.10).
      this.#say(conversation, "Hello, this is a specialist. I can confirm the exchange with you here.");
    }
    return this.#answer(inbound, conversation, 201);
  }

  /** `POST {endpoint}`: a new conversation, or a Direct Conversation (8.3, 8.10). */
  async start(inbound: Inbound, context: ResourceContext): Promise<Response> {
    const body = this.#body(inbound);
    const parentId = typeof body.parent_conversation_id === "string" ? body.parent_conversation_id : null;
    const eventId = typeof body.user_requested_event_id === "string" ? body.user_requested_event_id : null;
    // 8.10: accepting a user_requested event, with or without the User's first message.
    if (eventId !== null) {
      const incoming = this.#incoming(body);
      return this.#acceptInvitation(inbound, context, parentId, eventId, body.id as string, incoming);
    }
    const message = this.#validate(this.#incoming(body));
    const hash = this.#hash(inbound, message, parentId);
    // A flawed Company (retry-new-conversation) forgets first messages, so a retry starts another conversation.
    const existing = this.company.flawed("retry-new-conversation") ? null : this.#idempotent(context, message.id as string, hash);
    // A retry gets the original response only if it may still read the
    // conversation: once it used the account, 8.11 wins (S8), as in message().
    if (existing) return this.#answer(inbound, this.#owned(context, existing.id), 201);
    let parent: Conversation | null = null;
    if (parentId) {
      parent = this.#owned(context, parentId);
      // 8.10: a parent that is itself a Direct Conversation is invalid_request.
      if (parent.direct) throw new HttpError(json({ error: "invalid_request", error_description: "the parent is a Direct Conversation" }, 400));
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
      version: context.session.declaration!.version,
      directChild: null,
      status: "idle",
      responder: "agent",
      events: [],
      expired: new Set(),
      sent: [],
      context: {}
    };
    this.#conversations.set(conversation.id, conversation);
    this.#remember(context, message.id as string, hash, conversation);
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
    const message = this.#validate(this.#incoming(body));
    const hash = this.#hash(inbound, message, null);
    const existing = this.#idempotent(context, message.id as string, hash);
    if (existing) return this.#answer(inbound, existing, 202);
    if (conversation.status === "closed") {
      throw new HttpError(json({ error: "conversation_closed" }, 409));
    }
    if (conversation.directChild) {
      throw new HttpError(
        json({ error: "direct_conversation_open", conversation_id: conversation.directChild }, 409)
      );
    }
    const refusal = this.company.config.refuseMessages;
    if (refusal) throw new HttpError(json(refusal.body, refusal.status));
    const declared = context.session.declaration;
    if (this.company.config.keepsConversationVersions && declared?.version !== conversation.version) {
      throw new HttpError(json({ error: "version_mismatch", protocol_version: conversation.version }, 409));
    }
    // In a Direct Conversation the agent relays the User's words as written,
    // as `human` (8.10). It may still send context, such as user_available
    // (8.4); its own words have no place there (our reading of S12), so they
    // are recorded, though the draft gives the Company no error to return.
    if (conversation.direct && this.#writer(message) !== "human" && (message.text !== undefined || message.data !== undefined)) {
      this.company.violation("direct.agent-words-later", `agent's own words sent into Direct Conversation ${conversation.id}`);
    }
    this.#remember(context, message.id as string, hash, conversation);
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
        ...this.#state(conversation, true)
      });
    }
    const page = await this.#read(conversation, cursor, wait);
    const wantsStream = (inbound.request.headers.get("Accept") ?? "").includes("text/event-stream");
    if (!wantsStream || !this.company.config.streaming) return json(page, 200, this.#challenge(page.events));
    // SSE comments, which keep idle connections open, carry no event (8.6).
    const keepAlive = this.company.config.sseKeepAlive ? ": keep-alive\n\n" : "";
    // `working` as a `working` event with no id, when the stream opens (8.6).
    let body = `${keepAlive}event: working\ndata: ${JSON.stringify({ working: this.#state(conversation).working })}\n\n`;
    if (this.company.config.laterStreamEvent) {
      const later = { id: "evt_later", type: "message", created_at: now(), message: { id: "msg_later", role: "company", author: { type: "agent" }, text: "From an event this agent doesn't know." } };
      body += `event: later-version\ndata: ${JSON.stringify(later)}\n\n`;
    }
    for (const event of page.events) {
      const message = event.message as { id?: string; role?: string; text?: string } | undefined;
      if (event.type === "message" && message?.role === "company" && message.text && this.company.config.textDeltas) {
        const half = Math.ceil(message.text.length / 2);
        for (const piece of [message.text.slice(0, half), message.text.slice(half)]) {
          body += `event: text-delta\ndata: ${JSON.stringify({ message_id: message.id, text: piece })}\n\n`;
        }
      }
      body += `${this.company.config.emptyEventNames ? "event:\n" : ""}id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n${keepAlive}`;
    }
    // The Company may close a stream at any time (8.6); this one closes after one page.
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" }
    });
  }

  /**
   * A handoff, cancel or close body: only the request `id` (8.3). `wait` is
   * checked first, so a bad one is refused before anything changes.
   */
  #emptyBody(inbound: Inbound, context: ResourceContext, id: "handoff.body" | "close.body"): { body: Record<string, unknown>; retried: boolean } {
    const body = this.#body(inbound);
    this.#params(inbound);
    const retried = this.#retried(inbound, context, body);
    if (Object.keys(body).some((key) => key !== "id")) {
      this.company.violation(id, `${id.split(".")[0]} body should be only the request id, got ${inbound.bodyText}`);
    }
    return { body, retried };
  }

  /** A conversation that takes no handoff or cancel: closed, or a parent with its Direct Conversation open (8.10). */
  #refuseWhileDirect(conversation: Conversation): void {
    if (conversation.status === "closed") throw new HttpError(json({ error: "conversation_closed" }, 409));
    if (conversation.directChild) {
      throw new HttpError(json({ error: "direct_conversation_open", conversation_id: conversation.directChild }, 409));
    }
  }

  /** `POST {endpoint}/{id}/handoff` (8.9). */
  async handoff(inbound: Inbound, context: ResourceContext, id: string): Promise<Response> {
    const conversation = this.#owned(context, id);
    const { body, retried } = this.#emptyBody(inbound, context, "handoff.body");
    if (retried) return this.#answer(inbound, conversation, 202);
    this.#refuseWhileDirect(conversation);
    this.#take(inbound, context, conversation, body);
    // A person already handles it: there's no one to find, and while queued
    // `responder` stays `agent` (8.7), so nothing changes.
    if (conversation.responder !== "human") {
      this.#setState(conversation, this.company.config.neverQueued ? "working" : "queued");
    }
    return this.#answer(inbound, conversation, 202);
  }

  /** `POST {endpoint}/{id}/handoff/cancel` (8.9): stop looking for a person; nothing while no handoff is pending. */
  async cancelHandoff(inbound: Inbound, context: ResourceContext, id: string): Promise<Response> {
    const conversation = this.#owned(context, id);
    const { body, retried } = this.#emptyBody(inbound, context, "handoff.body");
    if (retried) return this.#answer(inbound, conversation, 202);
    this.#refuseWhileDirect(conversation);
    this.#take(inbound, context, conversation, body);
    if (conversation.status === "queued") this.#setState(conversation, "idle");
    return this.#answer(inbound, conversation, 202);
  }

  /** `POST {endpoint}/{id}/close` (8.12): 202, also for a conversation already closed. */
  async close(inbound: Inbound, context: ResourceContext, id: string): Promise<Response> {
    const conversation = this.#owned(context, id);
    const { body, retried } = this.#emptyBody(inbound, context, "close.body");
    if (!retried) {
      this.#take(inbound, context, conversation, body);
      this.#closeConversation(conversation);
    }
    return this.#answer(inbound, conversation, 202);
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

/** Operations 2's content in a message's `extensions` (8.4, Ops 4, 6), if it is an object. */
function operationsContent(extensions: unknown): Record<string, unknown> | undefined {
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return undefined;
  const content = (extensions as Record<string, unknown>).operations;
  return content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : undefined;
}
