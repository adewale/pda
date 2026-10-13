import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { code, id, literal, origin, plainUnits, recordCard, reportError, type Fields, type Units } from "../log";
import { buildActivity } from "./activity";
import { apiOperationFor } from "./apis";
import type { PoppyBrowser } from "./browser";
import { PoppyClient, type JobName, type PoppyHost } from "./client";
import {
  closeConversation,
  conversation,
  declineDirect,
  readConversation,
  sayInDirect,
  startDirectConversation,
  updateAvailability
} from "./conversations";
import type { Fetcher, PoppyTimeouts } from "./fetch";
import type { Json } from "./json";
import {
  addPermission,
  approveAndConfirm,
  cancelOperation,
  decideLocal,
  permissions,
  recoverInterruptedApprovals,
  removePermission,
  retryApproved,
  trackOperation
} from "./operations";
import {
  cancelSignIn,
  completeDirectSignIn,
  pollDeviceSignIn,
  recoverSignIns,
  signOut,
  submitCredentials,
  submitSignInCode
} from "./signin";
import { protocolIndex, protocolLog, registerApiNamer } from "./protocol-log";
import { rows } from "../rows";
import { cardsTable, migrate } from "./store";
import type { Card, PoppyClientFrame, PoppyServerFrame } from "./wire";
import { issuerDecoder, type Issuer } from "./issuer";
import { clientFrame } from "./frames";
import { object, optional, string, tryDecode } from "../decode";

export type PoppyOptions = {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly fetcher: Fetcher;
  readonly browser: () => PoppyBrowser;
  /** Hand a notice to the model, at most once per `operationId`. */
  readonly notifyModel: (text: string, operationId: string) => Promise<void>;
  /** Seconds a conversation read waits for events (spec 7.5). */
  readonly readWaitSeconds: number;
  /** Shortest gap between reads of an idle conversation. */
  readonly idleReadMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Now, in epoch ms, for waits and schedules; tests use a fake clock. */
  readonly now?: () => number;
  /** How long to wait on a Company; `POPPY_TIMEOUTS` by default. */
  readonly timeouts?: PoppyTimeouts;
  /** Where jobs, frames and the callback write their wide events (src/log.ts); `plainUnits` by default. */
  readonly units?: Units;
};

/** Frames that only read or keep the User present: no event of their own. */
const QUIET_FRAMES = new Set(["poppy.context", "poppy.activity", "poppy.protocol"]);

/** The last locale and time zone the User's page sent: one row. */
const USER_CONTEXT_SCHEMA = `CREATE TABLE IF NOT EXISTS user_context (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  locale TEXT,
  time_zone TEXT,
  updated_at INTEGER NOT NULL
)`;

/** The User counts as available while a page is open and was used recently (spec 7.4). */
const AVAILABLE_FOR_MS = 10 * 60_000;

// The protocol log names an OpenAPI call by its operation and path template.
registerApiNamer(apiOperationFor);

function html(status: number, message: string): Response {
  const escaped = message.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal agent</title><body style="font:16px system-ui;margin:3rem auto;max-width:32rem;padding:0 1rem"><p>${escaped}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

/**
 * Poppy as a Lifecycle capability on the person's Durable Object: it owns
 * the client, runs its durable jobs (conversation reads, device polling,
 * operation tracking), takes `poppy.*` frames from the page before the chat
 * sees them, answers the Direct Sign-In callback, and pushes cards.
 */
export class PoppyCapability extends LifecycleCapability {
  readonly #options: PoppyOptions;
  #client: PoppyClient | undefined;
  #context: { locale?: string; time_zone?: string } = {};
  #lastActivity = 0;
  /** The last `poppy.activity` broadcast, so an unchanged one isn't sent again. */
  #lastActivityFrame = "";
  /** The last `poppy.protocol.index` broadcast, likewise. */
  #lastProtocolIndex = "";

  constructor(options: PoppyOptions) {
    super("poppy");
    this.#options = options;
  }

  /** Created on first use, so a missing Poppy secret doesn't break the chat. */
  get client(): PoppyClient {
    if (!this.#client) {
      migrate(this.#options.storage.sql);
      this.#client = new PoppyClient(this.#host());
    }
    return this.#client;
  }

  /** Tests: drop the client and its in-memory tokens and keys, as an eviction would. */
  forgetForTests(): void {
    this.#client = undefined;
  }

  /**
   * The User's IANA time zone, as their page last reported it
   * (`poppy.context`). Kept in `user_context` too, so reminders, scheduled
   * tasks and `now` still know it after an eviction, before a page
   * reconnects. Undefined until a page has ever sent one.
   */
  get timeZone(): string | undefined {
    return this.#context.time_zone ?? this.#storedContext().time_zone;
  }

  /** The last locale and time zone a page sent, from storage. */
  #storedContext(): { locale?: string; time_zone?: string } {
    const sql = this.#options.storage.sql;
    sql.exec(USER_CONTEXT_SCHEMA);
    const row = sql.exec("SELECT locale, time_zone FROM user_context WHERE slot = 1").toArray()[0];
    return {
      ...(typeof row?.locale === "string" ? { locale: row.locale } : {}),
      ...(typeof row?.time_zone === "string" ? { time_zone: row.time_zone } : {})
    };
  }

  /** Keep what the page sent; a field it left out keeps its last value. */
  #storeContext(context: { locale?: string; time_zone?: string }): void {
    if (context.locale === undefined && context.time_zone === undefined) return;
    const sql = this.#options.storage.sql;
    sql.exec(USER_CONTEXT_SCHEMA);
    sql.exec(
      `INSERT INTO user_context (slot, locale, time_zone, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT (slot) DO UPDATE SET locale = COALESCE(excluded.locale, locale), time_zone = COALESCE(excluded.time_zone, time_zone), updated_at = excluded.updated_at`,
      context.locale ?? null,
      context.time_zone ?? null,
      Date.now()
    );
  }

  /** Send the Activity frame again, after something outside Poppy (a reminder, a scheduled task) added to it. */
  refreshActivity(): void {
    try {
      void this.client;
    } catch {
      return;
    }
    this.#sendActivity();
  }

  get browser(): PoppyBrowser {
    return this.#options.browser();
  }

  #host(): PoppyHost {
    const options = this.#options;
    return {
      env: options.env,
      sql: options.storage.sql,
      fetcher: options.fetcher,
      showCard: (card) => this.#showCard(card),
      notifyModel: (text, operationId) => options.notifyModel(text, operationId),
      schedule: async (fn, at, payload, id) => {
        await this.lifecycle.jobs.push({ fn, time: at, payload, id, singleflight: true });
        // Scheduled after a message, a new conversation or an operation update.
        this.#sendActivity();
      },
      pushDirect: (update) => {
        this.#broadcast({ type: "poppy.direct", update });
        this.#sendActivity();
      },
      userContext: () => ({
        ...this.#context,
        user_available:
          this.lifecycle.sockets.get().length > 0 && Date.now() - this.#lastActivity < AVAILABLE_FOR_MS
      }),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options.now ?? Date.now,
      ...(options.timeouts ? { timeouts: options.timeouts } : {})
    };
  }

  get #units(): Units {
    return this.#options.units ?? plainUnits;
  }

  override async onStart(): Promise<void> {
    if (!this.#hasPoppyState()) return;
    await this.#units.job({ job: literal("poppy.recover") }, async () => {
      await recoverInterruptedApprovals(this.client);
      // A Direct Sign-In the restart interrupted: finish it, or start a new Session (4.5).
      await recoverSignIns(this.client).catch((error: unknown) => reportError(error, { source: literal("poppy.signin_recovery") }));
    });
  }

  #hasPoppyState(): boolean {
    const found = this.#options.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'poppy_approvals'")
      .toArray();
    return found.length > 0;
  }

  // ---------------------------------------------------------------- Page

  #broadcast(frame: PoppyServerFrame): void {
    const text = JSON.stringify(frame);
    for (const socket of this.lifecycle.sockets.get()) {
      try {
        socket.send(text);
      } catch {
        // Closed between listing and sending.
      }
    }
  }

  async #showCard(card: Card): Promise<void> {
    this.#options.storage.sql.exec(
      "INSERT OR REPLACE INTO poppy_cards (id, card, open, updated_at) VALUES (?, ?, ?, ?)",
      card.id,
      JSON.stringify(card),
      card.open ? 1 : 0,
      Date.now()
    );
    recordCard(card as { kind: string; open?: boolean });
    this.#sendCards();
    if (card.kind === "notice" || card.kind === "signin_link" || card.kind === "operation") this.#sendSettings();
    this.#sendActivity();
  }

  /**
   * What the agent is doing and has done at Companies, from its own tables:
   * to one socket on connect, otherwise to every page when it changed.
   */
  #sendActivity(socket?: WebSocket): void {
    if (!socket && !this.#hasPoppyState()) return;
    this.#sendProtocolIndex(socket);
    let text: string;
    try {
      text = JSON.stringify(buildActivity(this.client));
    } catch (error) {
      // The log is a view; failing to build it must never stop the work it describes.
      reportError(error, { source: literal("poppy.activity"), severe: false });
      return;
    }
    if (socket) {
      socket.send(text);
      return;
    }
    if (text === this.#lastActivityFrame) return;
    this.#lastActivityFrame = text;
    for (const open of this.lifecycle.sockets.get()) {
      try {
        open.send(text);
      } catch {
        // Closed between listing and sending.
      }
    }
  }

  /** A Company's name and verified domain, by issuer, for the protocol view. */
  #companyNames = (issuer: Issuer): { name: string; domain: string | null } => {
    try {
      const company = this.client.companyByIssuer(issuer);
      return { name: company.name, domain: company.domain };
    } catch {
      return { name: URL.canParse(issuer) ? new URL(issuer).host : issuer, domain: null };
    }
  };

  /**
   * Which Companies have a protocol log, without the entries, so it stays
   * small: to one socket on connect, otherwise to every page when it changed.
   * A page with a Company's log open asks for it again when its `lastSeq` moves.
   */
  #sendProtocolIndex(socket?: WebSocket): void {
    let text: string;
    try {
      text = JSON.stringify(protocolIndex(this.client.sql, this.#companyNames));
    } catch (error) {
      reportError(error, { source: literal("poppy.protocol_index"), severe: false });
      return;
    }
    if (socket) {
      socket.send(text);
      return;
    }
    if (text === this.#lastProtocolIndex) return;
    this.#lastProtocolIndex = text;
    for (const open of this.lifecycle.sockets.get()) {
      try {
        open.send(text);
      } catch {
        // Closed between listing and sending.
      }
    }
  }

  /** Open cards, plus closed ones from the last hour so outcomes stay visible. */
  #sendCards(socket?: WebSocket): void {
    const cards = rows(
      this.#options.storage.sql,
      cardsTable.pick("card"),
      "SELECT card FROM poppy_cards WHERE open = 1 OR updated_at > ? ORDER BY updated_at",
      Date.now() - 60 * 60_000
    ).map((row) => JSON.parse(row.card) as Card);
    const frame: PoppyServerFrame = { type: "poppy.cards", cards };
    if (socket) socket.send(JSON.stringify(frame));
    else this.#broadcast(frame);
  }

  #sendSettings(socket?: WebSocket): void {
    const client = this.client;
    const name = (issuer: Issuer) => {
      try {
        return client.companyByIssuer(issuer).name;
      } catch {
        return issuer;
      }
    };
    const frame: PoppyServerFrame = {
      type: "poppy.settings",
      accounts: client.accounts().map((row) => ({
        issuer: row.issuer,
        company: name(row.issuer),
        account: row.account,
        scope: row.scope,
        expiresAt: row.expires_at
      })),
      permissions: permissions(client).map((row) => ({
        id: row.id,
        issuer: row.issuer,
        company: name(row.issuer),
        account: row.account,
        action: row.action,
        maxAmount: row.max_amount,
        currency: row.currency,
        maxUses: row.max_uses,
        uses: row.uses,
        expiresAt: row.expires_at
      }))
    };
    if (socket) socket.send(JSON.stringify(frame));
    else this.#broadcast(frame);
  }

  /** `poppy.*` frames from the page; everything else goes on to the chat. */
  async onWebSocketMessage(socket: WebSocket, message: string | ArrayBuffer | ArrayBufferView): Promise<boolean> {
    if (typeof message !== "string" || !message.includes('"poppy.')) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return false;
    }
    const type = typeof parsed === "object" && parsed !== null ? (parsed as { type?: unknown }).type : undefined;
    if (typeof type !== "string" || !type.startsWith("poppy.")) return false;
    // Every member checked (an issuer is an issuer, a decision one of the page's): a frame that isn't one is ignored.
    const decoded = tryDecode(clientFrame, parsed, "page frame");
    if (!decoded.ok) return true;
    const frame = decoded.value;
    this.#lastActivity = Date.now();
    try {
      if (QUIET_FRAMES.has(frame.type)) await this.#handleFrame(socket, frame);
      else await this.#units.frame(code(frame.type) ?? literal("poppy.unknown"), frameFields(frame), () => this.#handleFrame(socket, frame));
      if (!QUIET_FRAMES.has(frame.type)) this.#sendActivity();
    } catch (error) {
      if (QUIET_FRAMES.has(frame.type)) reportError(error, { source: code(frame.type) ?? literal("poppy.unknown"), severe: false });
      this.#broadcast({
        type: "poppy.cards",
        cards: [
          {
            id: `error-${Date.now()}`,
            kind: "notice",
            company: "",
            open: false,
            text: `That didn't work: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      });
    }
    return true;
  }

  async onWebSocketClose(): Promise<boolean> {
    if (this.#hasPoppyState()) await updateAvailability(this.client).catch(() => undefined);
    return false;
  }

  async #handleFrame(socket: WebSocket, frame: PoppyClientFrame): Promise<void> {
    const client = this.client;
    switch (frame.type) {
      case "poppy.context": {
        const wasAvailable = client.host.userContext().user_available;
        this.#context = {
          ...(typeof frame.locale === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(frame.locale) ? { locale: frame.locale } : {}),
          ...(typeof frame.time_zone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(frame.time_zone) ? { time_zone: frame.time_zone } : {})
        };
        this.#storeContext(this.#context);
        this.#sendCards(socket);
        this.#sendSettings(socket);
        this.#sendActivity(socket);
        if (!wasAvailable) await updateAvailability(client).catch(() => undefined);
        return;
      }
      case "poppy.activity":
        return;
      case "poppy.protocol":
        // Read-only, from our own table, to the page that asked.
        if (typeof frame.key === "string") socket.send(JSON.stringify(protocolLog(client.sql, frame.key, this.#companyNames)));
        return;
      case "poppy.credentials":
        // Straight to the sign-in code; never the model, the transcript or a log.
        await submitCredentials(client, frame.signInId, frame.values);
        await this.#afterSignIn();
        return;
      case "poppy.code":
        await submitSignInCode(client, frame.signInId, frame.code);
        await this.#afterSignIn();
        return;
      case "poppy.signin.cancel":
        await cancelSignIn(client, frame.signInId);
        return;
      case "poppy.operation":
        if (frame.decision === "approve") {
          await approveAndConfirm(client, frame.issuer, frame.operationId, frame.revision, "user");
        } else {
          await cancelOperation(client, frame.issuer, frame.operationId);
        }
        return;
      case "poppy.approval":
        await decideLocal(client, frame.approvalId, frame.decision);
        return;
      case "poppy.direct.start":
        await startDirectConversation(client, frame.conversationId, frame.text);
        return;
      case "poppy.direct.decline":
        await declineDirect(client, frame.conversationId);
        return;
      case "poppy.direct.say":
        await sayInDirect(client, frame.conversationId, frame.text);
        return;
      case "poppy.direct.close": {
        const row = conversation(client, frame.conversationId);
        if (row) await closeConversation(client, client.companyByIssuer(row.issuer), row.id);
        return;
      }
      case "poppy.signout":
        await signOut(client, frame.issuer, frame.account);
        this.#sendSettings();
        return;
      case "poppy.permission.add":
        addPermission(client, {
          issuer: frame.issuer,
          account: frame.account,
          action: frame.action,
          ...(frame.maxAmount ? { maxAmount: frame.maxAmount } : {}),
          ...(frame.currency ? { currency: frame.currency } : {}),
          ...(frame.maxUses ? { maxUses: frame.maxUses } : {}),
          ...(frame.expiresAt ? { expiresAt: frame.expiresAt } : {})
        });
        this.#sendSettings();
        return;
      case "poppy.permission.remove":
        removePermission(client, frame.id);
        this.#sendSettings();
        return;
      case "poppy.card.dismiss":
        this.#options.storage.sql.exec("UPDATE poppy_cards SET open = 0, updated_at = 0 WHERE id = ?", frame.id);
        this.#sendCards();
        return;
    }
  }

  /** After any sign-in: confirm operations that were waiting on it, refresh settings. */
  async #afterSignIn(): Promise<void> {
    const client = this.client;
    for (const issuer of new Set(client.accounts().map((row) => row.issuer))) {
      await retryApproved(client, issuer);
    }
    this.#sendSettings();
  }

  // ---------------------------------------------------------------- HTTP

  /** `GET /poppy/callback`, forwarded by the Worker for the signed-in person. */
  async onRequest({ request }: { request: Request }): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== "/poppy/callback") return undefined;
    const requestId = id(request.headers.get("x-request-id"));
    return this.#units.request({ hop: literal("agent"), method: literal("GET"), route: literal("/poppy/callback"), ...(requestId ? { request_id: requestId } : {}) }, async (event) => {
      const result = await completeDirectSignIn(this.client, url);
      if (result.ok) await this.#afterSignIn();
      event.set({ status: result.ok ? 200 : 400, outcome: literal(result.ok ? "success" : "refused") });
      return html(result.ok ? 200 : 400, result.message);
    });
  }

  // ---------------------------------------------------------------- Jobs

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    // A job's payload is ours, stored before a restart or a deploy: read, not trusted.
    const decoded = tryDecode(object({ id: optional(string), issuer: optional(issuerDecoder) }), job.payload, "job payload");
    const payload: { id?: string; issuer?: Issuer } = decoded.ok ? decoded.value : {};
    const fn = job.fn as JobName;
    const client = this.client;
    // Which job, and the Company's ids it works on; never a device sign-in's id.
    const fields: Fields = {
      job: literal(fn),
      ...(fn === "poppy-read" ? { conversation_id: id(payload.id) } : {}),
      ...(fn === "poppy-operation" ? { operation_id: id(payload.id), issuer: origin(payload.issuer) } : {})
    };
    return this.#units.job(fields, async (event) => {
      let next: number | null = null;
      try {
        if (fn === "poppy-read" && payload.id) {
          next = await readConversation(client, payload.id, this.#options.readWaitSeconds, this.#options.idleReadMs);
        } else if (fn === "poppy-device" && payload.id) {
          next = await pollDeviceSignIn(client, payload.id);
          if (next === null) await this.#afterSignIn();
        } else if (fn === "poppy-operation" && payload.id && payload.issuer) {
          next = await trackOperation(client, payload.issuer, payload.id);
        }
      } catch (error) {
        event.fail(error);
        next = Date.now() + 60_000;
      }
      this.#sendActivity();
      event.set({ rescheduled: next !== null });
      return next === null ? undefined : { rescheduleAt: next };
    });
  }
}

/** What a frame's event records: which decision, and which Company. Never values, codes, text or ids the User typed. */
function frameFields(frame: PoppyClientFrame): Fields {
  return {
    ...("decision" in frame ? { decision: code(frame.decision) } : {}),
    ...("issuer" in frame ? { issuer: origin(frame.issuer) } : {}),
    ...(frame.type === "poppy.operation" ? { operation_id: id(frame.operationId) } : {}),
    ...(frame.type === "poppy.approval" ? { approval_id: id(frame.approvalId) } : {}),
    ...(frame.type === "poppy.permission.add" ? { action: code(frame.action) } : {})
  };
}

export type { Json };
