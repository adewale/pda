import { DurableObject } from "cloudflare:workers";
import type { Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Extension, type Storage as PiStorage } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { AgentLog, type Trigger } from "./agent-log";
import { maySignIn, type ListEnv } from "./allowlist";
import { AttachmentExpiry, attachmentsExtension } from "./attachment-images";
import { AttachmentError, attachmentInfo, deleteAttachment, migrateAttachments, readAttachment, saveAttachment, type AttachmentInfo } from "./attachments";
import { Ledger } from "./budget";
import { BrowserSessions } from "./browser-sessions";
import { AuthError, type BrowserIdentity } from "./session";
import { TurnAuthority } from "./tools/turn-authority";
import { COMPACTION_POLICY, compactionExtension } from "./compaction";
import { TranscriptHistory } from "./history";
import { agentId as pseudonym, code, configureLog, currentEvent, id, literal, type Safe } from "./log";
import { isKeyProvider, readModelConfig, type KeyProvider } from "./config";
import { checkKey, keyFormatProblem, ModelKeys, NO_AMBIENT_AUTH, PROVIDER_LABEL, workspaceProblem } from "./model-keys";
import {
  gatewayDemoLane,
  ModelAccess,
  nativeProviders,
  refusalText,
  ROUTER_MODEL,
  routerProvider,
  demoCatalogModel,
  type Entitlement,
  type LaneModel,
  type Profile,
  type DemoRoute
} from "./model-router";
import { Sealer } from "./poppy/store";
import type { Card } from "./poppy/wire";
import type { PoppyBrowser } from "./poppy/browser";
import { PoppyCapability } from "./poppy/capability";
import type { Fetcher, PoppyTimeouts } from "./poppy/fetch";
import { FetchBrowser } from "./poppy/fetch-browser";
import { poppyExtension } from "./poppy/tools";
import { Scheduler, type PushMessage, type TaskStart } from "./schedules";
import { PushSubscriptions, readVapidKey, sendPush, vapidSubject, type PushFetcher, type Subscription } from "./web-push";
import { PiSessionSockets } from "./sockets";
import { memoryExtension, timeExtension, webExtension, type WebToolsOptions } from "./tools/extensions";
import { MAX_MEMORIES, MemoryStore, type Memory } from "./tools/memory-store";
import { puppeteerLauncher, renderAvailability, RenderLimiter, type BrowserLauncher } from "./tools/render";
import { describeRecurrence, MAX_ACTIVE_SCHEDULES, type Schedule } from "./tools/schedule-store";
import { scheduleExtension } from "./tools/schedules";
import { ReadLimiter, type Fetcher as WebFetcher } from "./tools/web";
import type { Issuer } from "./poppy/issuer";
import { integer, rows, table, text } from "./rows";

const PREAMBLE =
  "You are the user's personal agent, in one long-running conversation with the person who owns you. Earlier turns are your memory of them, so use what they have told you. Be direct and brief, and say plainly when you do not know something.";

/** The person's identity, and background notices held while model calls are refused. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agent_profile (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    provider TEXT NOT NULL,
    sub TEXT NOT NULL,
    email TEXT,
    domain TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS model_paused (
    operation_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`
];

const pausedTable = table("model_paused", { operation_id: text, text, created_at: integer });

/** A reminder or task as Settings shows it. */
export type ScheduleView = {
  readonly id: string;
  readonly kind: Schedule["kind"];
  readonly text: string;
  readonly nextRun: number | null;
  readonly repeats: string;
  readonly timeZone: string;
  readonly status: Schedule["status"];
  readonly failures: number;
  readonly lastRun: number | null;
  readonly lastOutcome: string | null;
  /** Why it is paused, when failed runs didn't pause it. */
  readonly pausedReason: string | null;
  /** Tries at showing a reminder that failed: those of a retry waiting, or all of a failed one-off's. */
  readonly attempts: number;
  /** When the reminder being retried was due; null when none is. */
  readonly retryDue: number | null;
};

function scheduleView(schedule: Schedule): ScheduleView {
  return {
    id: schedule.id,
    kind: schedule.kind,
    text: schedule.text,
    nextRun: schedule.nextRun,
    repeats: describeRecurrence(schedule.recurrence),
    timeZone: schedule.timeZone,
    status: schedule.status,
    failures: schedule.failures,
    lastRun: schedule.lastRun,
    lastOutcome: schedule.lastOutcome,
    pausedReason: schedule.pausedReason,
    attempts: schedule.attempts,
    retryDue: schedule.retryDue
  };
}

/** The outcome of attaching a photo, for `POST /api/attachments`. */
export type AttachResult = { ok: true; attachment: AttachmentInfo } | { ok: false; status: number; error: string };

/**
 * Who is calling, as the Worker verified them, and the request's id
 * (`cf-ray`), so a turn the call starts names the request in its event.
 */
export type Caller = Profile & { readonly requestId?: string };

/** The outcome of saving a key, for `POST /api/model-key`. Never carries the key. */
export type KeyResult = { ok: true; entitlement: Entitlement } | { ok: false; status: 400 | 502; error: string };

/** One person's agent: a Pi harness whose root session is their one chat. */
export class PersonalAgent extends DurableObject<Env> {
  readonly browserSessions: BrowserSessions;
  readonly turnAuthority: TurnAuthority;
  readonly registry = createRegistry();
  readonly harness: PiHarness;
  readonly sockets: PiSessionSockets;
  readonly webSockets: WebSockets;
  readonly poppy: PoppyCapability;
  readonly history: TranscriptHistory;
  readonly lifecycle: Lifecycle;
  readonly keys: ModelKeys;
  readonly access: ModelAccess;
  /** The agent's notes about the User (src/tools/memory-store.ts). */
  readonly memories: MemoryStore;
  /** Reminders and scheduled tasks, on the Durable Object's alarm (src/schedules.ts). */
  readonly schedules: Scheduler;
  /** Deletes each attached photo 30 days after it was attached (src/attachment-images.ts). */
  readonly attachmentExpiry: AttachmentExpiry;
  /** The browsers that turned notifications on (src/web-push.ts). */
  readonly pushSubscriptions: PushSubscriptions;
  /**
   * The general tools, outside Poppy: read_url, memory, time and maths
   * (src/tools/). Built once, so their state (read_url's rate limit, whose
   * turn is running) is the agent's.
   */
  readonly generalTools: readonly Extension[];
  /** read_url's fetcher, limits and renderer, shared by its tool and the tests' page reads. */
  readonly webTools: WebToolsOptions;
  /**
   * This agent's wide events (src/log.ts, src/agent-log.ts): one per turn,
   * job and page frame that does work, with a copy of the newest kept for
   * the User's "Copy diagnostics".
   */
  readonly log: AgentLog;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureLog(env);
    for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
    this.browserSessions = new BrowserSessions(ctx, () => this.maySignInNow());
    this.turnAuthority = new TurnAuthority(ctx.storage.sql, () => this.harness.storage());
    // The same pseudonymous id the demo gateway's metadata carries (`u`): never who the person is.
    const agentId = pseudonym(ctx.id);
    this.log = new AgentLog({ sql: ctx.storage.sql, agentId, companyName: (issuer) => this.#companyName(issuer) });
    migrateAttachments(ctx.storage.sql);
    this.memories = new MemoryStore(ctx.storage.sql);
    this.pushSubscriptions = new PushSubscriptions(ctx.storage.sql);
    const config = readModelConfig(env);
    let sealer: Sealer | undefined;
    this.keys = new ModelKeys(ctx.storage.sql, () => (sealer ??= new Sealer(env)), ctx.id.toString());
    this.access = new ModelAccess({
      env,
      keys: this.keys,
      ledger: new Ledger(ctx.storage.sql),
      profile: () => this.#profile(),
      lists: () => this.deployment(),
      agent: agentId,
      domainBudget: (domain) => env.DomainBudget.getByName(domain),
      demoLane: (route) => this.demoLane(route),
      ownKeyProviders: () => this.ownKeyProviders(),
      onRefused: (entitlement) => this.#modelNotice(entitlement),
      onKeyRefused: (provider) => this.#keyRefusedNotice(provider),
      now: () => this.modelNow(),
      onCall: (call) => this.log.modelCall(call),
      onSettlementPending: () => this.#armAccounting()
    });
    const router = routerProvider(this.access, demoCatalogModel(env));
    let browser: PoppyBrowser | undefined;
    this.poppy = new PoppyCapability({
      env,
      storage: ctx.storage,
      fetcher: this.poppyFetcher(),
      browser: () => (browser ??= this.poppyBrowser()),
      notifyModel: (text, operationId) => this.poppyNotify(text, operationId),
      units: this.log,
      ...this.poppySettings()
    });
    let renderLimiter: RenderLimiter | undefined;
    this.schedules = new Scheduler({
      storage: ctx.storage,
      now: () => this.clockNow(),
      jobTime: (at) => this.scheduleJobTime(at),
      showCard: (card) => this.scheduleCard(card),
      startTask: (text, operationId) => this.scheduledTurn(text, operationId),
      taskEnded: async (operationId) => {
        const result = await this.harness.wait(operationId);
        return { status: result.status, ...(result.reason ? { reason: result.reason } : {}) };
      },
      push: (message) => this.pushToDevices(message),
      maySignIn: () => this.maySignInNow(),
      changed: () => this.poppy.refreshActivity(),
      units: this.log
    });
    this.attachmentExpiry = new AttachmentExpiry({
      sql: () => ctx.storage.sql,
      now: () => this.clockNow(),
      jobTime: (at) => this.scheduleJobTime(at),
      units: this.log
    });
    this.webTools = {
      // Its own fetcher, never the Poppy client's: no Session, cookie or token can reach it.
      fetcher: () => this.webFetcher(),
      limiter: new ReadLimiter(),
      renderer: () => this.browserRenderer(),
      renderLimiter: () => (renderLimiter ??= new RenderLimiter(ctx.storage.sql, () => this.clockNow()))
    };
    this.generalTools = [
      webExtension(this.webTools),
      memoryExtension(() => this.memories, { fromUser: this.turnAuthority.isUser }),
      timeExtension({ userTimeZone: () => this.poppy.timeZone, now: () => this.clockNow() }),
      scheduleExtension({ scheduler: () => this.schedules, userTimeZone: () => this.poppy.timeZone, fromUser: this.turnAuthority.isUser })
    ];
    this.harness = new PiHarness({
      harness: async ({ storage, context }) => {
        this.registry.install({
          name: "persona",
          sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
          tools: []
        });
        // Every tool's call is counted on its turn's wide event (src/agent-log.ts).
        this.registry.install(
          this.log.instrument(
            poppyExtension(
              () => this.poppy.client,
              () => this.poppy.browser,
              this.turnAuthority.userTask
            )
          )
        );
        // read_url, memory, time and maths, reminders and tasks: useful outside Poppy, and kept apart from it.
        for (const extension of this.generalTools) this.registry.install(this.log.instrument(extension));
        // The User's attached photos, shown to the model as images in the messages that name them.
        this.registry.install(this.log.instrument(attachmentsExtension(() => this.ctx.storage.sql, () => this.clockNow())));
        // Our summariser for pi's compaction: Company text stays labelled as the Company's (compaction.ts).
        this.registry.install(compactionExtension(ROUTER_MODEL, (outcome) => this.log.compactionSummary(outcome)));
        // One provider, the router: it picks the lane at every call (model-router.ts).
        const models = createModels({ authContext: NO_AMBIENT_AUTH });
        models.setProvider(router);
        const pi = await Harness.open(
          this.piStorage(storage),
          {
            models,
            registry: this.registry,
            settings: {
              // pi doubles the delay before each retry: 1, 2, 4, 8 and 16
              // seconds, so a rate-limited model gets about 30 seconds.
              retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
              // A context budget: summarise from about 150k tokens, not near the model's 1M window.
              compaction: COMPACTION_POLICY,
              // No caches kept on a timer. pi keeps one only where a timer can be
              // unreferenced, and under nodejs_compat a timer has an unref() that
              // does nothing: a pending ten-minute timer would keep the object
              // from hibernating after every turn. Both rebuild from SQLite.
              documentRetentionMs: 0,
              contextRetentionMs: 0
            },
            // pi's own background reports: an event of their own, at level error.
            onReport: (error) => void this.log.event("job", { job: literal("pi.report"), outcome: literal("error") }).fail(error).emit()
          },
          context
        );
        // A storage error closes pi for good: every later call fails. Reset
        // the object, so the next request opens pi again from storage.
        void pi.closed.then((end) => {
          if (end.reason === "failed") this.#piFailed(end.error);
        });
        return pi;
      },
      defaults: { model: ROUTER_MODEL, thinkingLevel: config.thinkingLevel }
    });
    this.sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
      this.ctx.getWebSockets(tag).filter(socket => this.browserSessions.protect(socket))
    );
    const socketOptions = this.sockets.options();
    this.webSockets = new WebSockets({
      ...socketOptions,
      getConnectionTags: async (connection, context) => [
        ...(await socketOptions.getConnectionTags?.(connection, context) ?? []),
        ...this.browserSessions.tags(context.request)
      ],
      handlers: {
        ...socketOptions.handlers,
        onConnect: (connection, context) => {
          if (this.browserSessions.protect(connection)) return socketOptions.handlers?.onConnect?.(connection, context);
        },
        onMessage: async (connection, message) => {
          if (!this.browserSessions.protect(connection)) return;
          let forwarded = message;
          if (typeof message === "string") {
            let parsed: unknown;
            try { parsed = JSON.parse(message); } catch { /* Upstream reports malformed JSON. */ }
            if (typeof parsed === "object" && parsed !== null && "type" in parsed && (parsed.type === "abort" || parsed.type === "reset")) this.turnAuthority.withdraw();
            if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "submit") {
              const input = parsed as { type: "submit"; operationId?: unknown; id?: unknown };
              const supplied = typeof input.operationId === "string" ? input.operationId : typeof input.id === "string" ? input.id : crypto.randomUUID();
              if (supplied.length > 256) { connection.send(JSON.stringify({ type: "error", ...(typeof input.id === "string" ? { id: input.id } : {}), message: "Message identifier is too long" })); return; }
              const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
              const operationId = `user-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
              this.turnAuthority.record(operationId, "user");
              forwarded = JSON.stringify({ ...input, operationId });
            }
          }
          return socketOptions.handlers?.onMessage?.(connection, forwarded);
        }
      }
    });
    this.history = new TranscriptHistory(this.harness, this.log);
    // The log first, to see the chat's frames; then Poppy and the page's history, so they see theirs before the chat socket does.
    this.lifecycle = Lifecycle.install(this)
      .use(this.browserSessions)
      .use(this.log)
      .use(this.poppy)
      .use(this.schedules)
      .use(this.attachmentExpiry)
      .use(this.history)
      .use(this.webSockets)
      .use(this.harness);

  }

  /**
   * The deployment's vars as they are now, for the checks of who may sign in
   * and who is on the demo. Read at every check, never kept: a Durable
   * Object's `env` is the running version's, and a deploy that changes a
   * list restarts the object, so the next check sees the new lists. Tests
   * override it to take someone off a list.
   */
  protected deployment(): ListEnv {
    return this.env;
  }

  /**
   * Whether the person this agent belongs to may still sign in, by the
   * identity the Worker last recorded and the lists as they are now. An
   * agent that was never told who it belongs to fails closed.
   */
  protected maySignInNow(): boolean {
    const profile = this.#profile();
    return profile !== null && maySignIn(profile, this.deployment());
  }

  /** Now, for the demo lane's daily caps. Tests run it on a fixed day, so no test straddles midnight. */
  protected modelNow(): number {
    return Date.now();
  }

  /** The demo lane: AI Gateway on the AI binding. Tests override this with pi-ai's faux provider. */
  protected demoLane(route: DemoRoute): LaneModel {
    return gatewayDemoLane(this.env, route);
  }

  /** People's own keys: pi-ai's providers, straight to each vendor. Tests keep these, against fakes. */
  protected ownKeyProviders(): readonly Provider[] {
    return nativeProviders();
  }

  /** Where key checks go. */
  protected modelFetcher(): (request: Request) => Promise<Response> {
    return (request) => fetch(request);
  }

  /**
   * pi's Session failed on a storage error and closed itself. Logged by the
   * error's class only (a storage error can quote what was being written),
   * then the object is reset: its sockets close, and the next request or
   * alarm opens pi again. Commits are atomic, so nothing half-written is
   * kept, and a resubmission with the same id finds one already admitted.
   */
  #piFailed(error: unknown): void {
    const kind = error instanceof Error ? error.name : typeof error;
    this.log
      .event("job", { job: literal("pi.session_failed"), outcome: literal("error") })
      .fail(new Error("pi's storage failed; the object is reset"), { step: literal("pi.storage"), ...(code(kind) ? { code: code(kind)! } : {}) })
      .emit();
    try {
      this.ctx.abort("pi's storage failed");
    } catch {
      // abort() may throw in the caller as well as resetting the object.
    }
  }

  /** pi's storage, as the harness opens it. Tests wrap it to make a write fail. */
  protected piStorage(storage: PiStorage): PiStorage {
    return storage;
  }

  /** Where Poppy requests go; tests route them to the mock Company. */
  protected poppyFetcher(): Fetcher {
    return (request) => fetch(request);
  }

  /** Where read_url's requests go: the open web, never the Poppy fetcher. Tests serve fake pages. */
  protected webFetcher(): WebFetcher {
    return (request) => fetch(request);
  }

  /**
   * read_url's browser for pages that need JavaScript: a new Browser Run
   * browser for each render, or null when `BROWSER_RUN` is off or the
   * binding is missing. Tests hand in a fake browser; none reaches Browser Run.
   */
  protected browserRenderer(): BrowserLauncher | null {
    return renderAvailability(this.env) === "on" ? puppeteerLauncher(this.env.BROWSER) : null;
  }

  /** Now, for the now and date_math tools, read_url's render limit, and when an attached photo is 30 days old. */
  protected clockNow(): number {
    return Date.now();
  }

  /** A reminder's or task's card, shown as every card is. Tests make it fail. */
  protected async scheduleCard(card: Card): Promise<void> {
    await this.poppy.client.host.showCard(card);
  }

  /** When the job queue wakes for a reminder, a task or a photo's deletion due at `at`. Tests move it out of the way and run jobs themselves. */
  protected scheduleJobTime(at: number): number {
    return at;
  }

  /**
   * A scheduled task's turn: through the router like any model call, as a
   * Company message's turn is, but never held for later. When the model
   * can't be called the run fails, and the notice says why.
   */
  protected async scheduledTurn(text: string, operationId: string): Promise<TaskStart> {
    const { entitlement } = await this.access.decide({ forQueue: true });
    if (entitlement.lane === "none") {
      await this.#modelNotice(entitlement);
      currentEvent()?.set({ model_refused: entitlement.reason ? literal(entitlement.reason) : null });
      return { ok: false, reason: refusalText(entitlement) };
    }
    await this.#resumePaused();
    await this.#submit(text, operationId, "schedule");
    return { ok: true };
  }

  /** Where Web Push messages go: the push services' own hosts, checked in `sendPush`. Tests fake them. */
  protected pushFetcher(): PushFetcher {
    return (request) => fetch(request);
  }

  /**
   * Tell each device that turned notifications on (Web Push), at once. A
   * push service that says the subscription is gone (404, 410) has it
   * deleted. Nothing happens without the deployment's VAPID key.
   */
  protected async pushToDevices(message: PushMessage): Promise<void> {
    const key = await readVapidKey(this.env);
    if (!key) return;
    const subject = vapidSubject(this.env);
    await Promise.all(
      this.pushSubscriptions.all().map(async (subscription) => {
        // Counted on the job's event by outcome, never by endpoint, which is a capability URL for that browser.
        const event = currentEvent();
        try {
          const status = await sendPush(this.pushFetcher(), subscription, message, key, subject);
          if (status === 404 || status === 410) this.pushSubscriptions.remove(subscription.endpoint);
          else this.pushSubscriptions.sent(subscription.endpoint, status);
          event?.count(status === 404 || status === 410 ? "push.gone" : status >= 200 && status < 300 ? "push.sent" : "push.failed");
        } catch (error) {
          event?.count("push.failed").fail(error, { step: literal("web_push"), severe: false });
        }
      })
    );
  }

  // ---------------------------------------------------------------- Notifications (src/web-push.ts)

  /** Keep this browser's push subscription, from Settings' "Notifications on this device". */
  async addPushSubscription(identity: Profile, subscription: Subscription): Promise<void> {
    await this.recordIdentity(identity);
    this.pushSubscriptions.add(subscription);
  }

  /** Forget one browser's push subscription; false if it wasn't kept. */
  async removePushSubscription(identity: Profile, endpoint: string): Promise<boolean> {
    await this.recordIdentity(identity);
    return this.pushSubscriptions.remove(endpoint);
  }

  /** The browser for Poppy web browsing: plain HTTPS through the Poppy fetcher, no JavaScript. */
  protected poppyBrowser(): PoppyBrowser {
    return new FetchBrowser(this.poppyFetcher());
  }

  /**
   * Hand a Poppy notice to the model, once per operation id. While model calls
   * are refused (no key, a refused key, a cap) the notice waits in
   * `model_paused` and the person sees why; it goes to the model once calls
   * are allowed again.
   */
  protected async poppyNotify(text: string, operationId: string): Promise<void> {
    const { entitlement } = await this.access.decide({ forQueue: true });
    if (entitlement.lane === "none") {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO model_paused (operation_id, text, created_at) VALUES (?, ?, ?)",
        operationId,
        text,
        Date.now()
      );
      await this.#modelNotice(entitlement);
      currentEvent()?.set({ model_refused: entitlement.reason ? literal(entitlement.reason) : null }).count("notices_held");
      return;
    }
    await this.#resumePaused();
    await this.#submit(text, operationId, "company");
  }

  /** Hand pi a background input, saying first who started it, for its turn's event. */
  async #submit(text: string, operationId: string, trigger: Trigger, requestId?: Safe<"id">): Promise<void> {
    this.turnAuthority.record(operationId, "background");
    this.log.submitted(operationId, trigger, requestId);
    await this.harness.submit(text, { operationId, whenBusy: "followUp" });
  }

  /** A Company's name and verified domain, for the diagnostics' protocol log. */
  #companyName(issuer: Issuer): { name: string; domain: string | null } {
    try {
      const company = this.poppy.client.companyByIssuer(issuer);
      return { name: company.name, domain: company.domain };
    } catch {
      return { name: URL.canParse(issuer) ? new URL(issuer).host : issuer, domain: null };
    }
  }

  /** Background notices held while model calls were refused, oldest first, once calls are allowed again. */
  async #resumePaused(requestId?: Safe<"id">): Promise<void> {
    const held = rows(this.ctx.storage.sql, pausedTable.pick("operation_id", "text"), "SELECT operation_id, text FROM model_paused ORDER BY created_at");
    if (held.length === 0) return;
    if ((await this.access.decide({ forQueue: true })).entitlement.lane === "none") return;
    for (const row of held) {
      await this.#submit(row.text, row.operation_id, "held", requestId);
      this.ctx.storage.sql.exec("DELETE FROM model_paused WHERE operation_id = ?", row.operation_id);
    }
    await this.#closeModelNotice();
  }

  // ---------------------------------------------------------------- Model access

  #profile(): Profile | null {
    const row = this.ctx.storage.sql.exec("SELECT provider, sub, email, domain FROM agent_profile WHERE slot = 1").toArray()[0];
    if (!row) return null;
    return {
      provider: row.provider === "github" ? "github" : "google",
      sub: String(row.sub),
      email: typeof row.email === "string" ? row.email : null,
      domain: typeof row.domain === "string" ? row.domain : null
    };
  }

  /**
   * The Worker records who this agent belongs to on every signed-in request
   * that reaches it, so demo eligibility follows the current allowlists,
   * background turns included. Then reminders and tasks paused because the
   * person couldn't sign in start again, and anything held for a refused
   * model goes through if calls are allowed again.
   */
  async recordIdentity(identity: Caller): Promise<void> {
    if ("sessionId" in identity && (typeof identity.sessionId !== "string" || !this.browserSessions.active(identity.sessionId))) throw new AuthError("Session revoked");
    this.#storeIdentity(identity);
    // Native RPC bypasses fetch/alarm/WebSocket startup.
    await this.lifecycle.start();
    if (await this.schedules.resumeSignedIn()) this.poppy.refreshActivity();
    await this.#resumePaused(id(identity.requestId));
  }

  #storeIdentity(identity: Profile): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO agent_profile (slot, provider, sub, email, domain, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
      identity.provider,
      identity.sub,
      identity.email,
      identity.domain,
      Date.now()
    );
  }

  /** Authenticated Worker edge only: admit a signed browser cookie without starting work. */
  async admitBrowserSession(identity: BrowserIdentity): Promise<boolean> {
    if (!maySignIn(identity, this.deployment())) return false;
    this.#storeIdentity(identity);
    return this.browserSessions.admit(identity.sessionId, identity.sessionExpiresAt);
  }

  async revokeBrowserSession(identity: BrowserIdentity): Promise<void> {
    this.browserSessions.revoke(identity.sessionId, identity.sessionExpiresAt);
  }

  /** Which lane, today's demo spend, the key's provider and state. Never the key. */
  async entitlement(identity: Profile): Promise<Entitlement> {
    await this.recordIdentity(identity);
    return this.access.entitlement();
  }

  /** Check a pasted key with the provider, then seal and store it. The key is never returned or logged. */
  async setModelKey(identity: Caller, provider: unknown, key: unknown, workspace?: unknown): Promise<KeyResult> {
    await this.recordIdentity(identity);
    if (!isKeyProvider(provider)) {
      return { ok: false, status: 400, error: "Choose Anthropic or OpenAI." };
    }
    if (typeof key !== "string") return { ok: false, status: 400, error: "Paste a key." };
    const trimmed = key.trim();
    const problem = keyFormatProblem(provider, trimmed);
    if (problem) return { ok: false, status: 400, error: problem };
    if (workspace !== undefined && workspace !== null && typeof workspace !== "string") {
      return { ok: false, status: 400, error: "A workspace ID is text." };
    }
    const space = workspace?.trim() || null;
    const spaceProblem = workspaceProblem(provider, space);
    if (spaceProblem) return { ok: false, status: 400, error: spaceProblem };
    const checked = await checkKey(provider, trimmed, this.modelFetcher(), space);
    if (!checked.ok) return checked;
    await this.keys.put(provider, trimmed, space);
    return this.#keyChanged(id(identity.requestId));
  }

  // ---------------------------------------------------------------- Attachments (src/attachments.ts)

  /** Keep a photo the User attached, with the smaller copy the page made for the model. Never logged. */
  async attach(identity: Profile, name: string | null, bytes: ArrayBuffer, preview: ArrayBuffer | null): Promise<AttachResult> {
    await this.recordIdentity(identity);
    try {
      const attachment = saveAttachment(this.ctx.storage.sql, {
        name,
        bytes: new Uint8Array(bytes),
        preview: preview ? new Uint8Array(preview) : null,
        now: this.clockNow()
      });
      await this.attachmentExpiry.arm();
      return { ok: true, attachment };
    } catch (error) {
      if (error instanceof AttachmentError) return { ok: false, status: error.status, error: error.message };
      throw error;
    }
  }

  /** An attachment's bytes, for the User's own page. */
  async attachment(identity: Profile, id: string): Promise<{ info: AttachmentInfo; bytes: ArrayBuffer } | null> {
    await this.recordIdentity(identity);
    const found = readAttachment(this.ctx.storage.sql, id, this.clockNow());
    return found ? { info: found.info, bytes: found.bytes.slice().buffer } : null;
  }

  /** Delete one, as when the User removes it before sending. */
  async removeAttachment(identity: Profile, id: string): Promise<boolean> {
    await this.recordIdentity(identity);
    if (!attachmentInfo(this.ctx.storage.sql, id, this.clockNow())) return false;
    const deleted = deleteAttachment(this.ctx.storage.sql, id);
    await this.attachmentExpiry.arm();
    return deleted;
  }

  // ---------------------------------------------------------------- Memory (src/tools/memory-store.ts)

  /** Every note, newest first, for Settings. */
  async listMemories(identity: Profile): Promise<{ memories: Memory[]; limit: number }> {
    await this.recordIdentity(identity);
    return { memories: this.memories.all(), limit: MAX_MEMORIES };
  }

  /** Forget one note, as Settings' delete button does. */
  async forgetMemory(identity: Profile, id: number): Promise<boolean> {
    await this.recordIdentity(identity);
    return this.memories.forget(id);
  }

  /** Forget every note: Settings' "Forget everything". */
  async forgetAllMemories(identity: Profile): Promise<number> {
    await this.recordIdentity(identity);
    return this.memories.forgetAll();
  }

  // ---------------------------------------------------------------- Reminders and tasks (src/schedules.ts)

  /** Every reminder and task waiting, paused or failed, soonest first, for Settings. */
  async listSchedules(identity: Profile): Promise<{ schedules: ScheduleView[]; limit: number }> {
    await this.recordIdentity(identity);
    return { schedules: this.schedules.list().map(scheduleView), limit: MAX_ACTIVE_SCHEDULES };
  }

  /** Cancel one, or dismiss a failed one, as Settings' Cancel and Dismiss buttons do. */
  async cancelSchedule(identity: Profile, id: string): Promise<boolean> {
    await this.recordIdentity(identity);
    const cancelled = (await this.schedules.cancel(id)) !== null;
    if (cancelled) this.poppy.refreshActivity();
    return cancelled;
  }

  async removeModelKey(identity: Profile): Promise<Entitlement> {
    await this.recordIdentity(identity);
    this.keys.remove();
    return this.access.entitlement();
  }

  async #keyChanged(requestId?: Safe<"id">): Promise<KeyResult> {
    await this.#closeModelNotice();
    await this.#resumePaused(requestId);
    return { ok: true, entitlement: await this.access.entitlement() };
  }

  /** One card says why model calls are refused, replaced as the reason changes. */
  async #modelNotice(entitlement: Entitlement): Promise<void> {
    const held = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM model_paused").toArray()[0]?.n ?? 0);
    const waiting =
      held === 0 ? "" : ` ${held === 1 ? "1 update from a Company is" : `${held} updates from Companies are`} waiting for it.`;
    await this.#showModelCard(`${refusalText(entitlement)}${waiting}`, true);
  }

  async #keyRefusedNotice(provider: KeyProvider): Promise<void> {
    await this.#showModelCard(
      `${PROVIDER_LABEL[provider]} refused your key (401), so your agent has stopped calling the model. It won't use the demo instead. Add a working key in Settings.`,
      true
    );
  }

  /** Close the model notice once calls are allowed again. */
  async #closeModelNotice(): Promise<void> {
    const open = this.poppy.client.sql
      .exec("SELECT card FROM poppy_cards WHERE id = 'model-access' AND open = 1")
      .toArray()[0];
    if (!open) return;
    // Closed and kept out of the chat: the warning going away says it, and a lasting "back on" line was only noise.
    await this.#showModelCard("Model calls are back on.", false);
    this.poppy.retireCard("model-access");
  }

  async #showModelCard(text: string, open: boolean): Promise<void> {
    const card: Card = { id: "model-access", kind: "notice", company: "", open, text };
    await this.poppy.client.host.showCard(card);
  }

  /** Timings tests shorten. */
  protected poppySettings(): {
    readWaitSeconds: number;
    idleReadMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeouts?: PoppyTimeouts;
  } {
    return { readWaitSeconds: 20 };
  }

  async #armAccounting(): Promise<void> {
    if (this.access.hasPendingSettlements()) {
      await this.lifecycle.jobs.push({ fn: "model-accounting", id: "model-accounting", time: Date.now() + 60_000, singleflight: true });
    }
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (job.fn !== "model-accounting") return;
    try { await this.access.flushSettlements(); }
    catch (error) { await this.log.event("job", { job: literal("model.accounting"), outcome: literal("error") }).fail(error).emit(); }
    if (this.access.hasPendingSettlements()) return { rescheduleAt: Date.now() + 60_000 };
  }

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    try { await this.access.flushSettlements(); }
    catch (error) { await this.log.event("job", { job: literal("model.accounting"), outcome: literal("error") }).fail(error).emit(); }
    await this.#armAccounting();
    // Sessions created before the model router named their own model; point them at it.
    await this.harness.session().setModel(ROUTER_MODEL);
    // Each run's turn event, from pi's own events.
    await this.log.watch(this.harness);
    // Give sockets that outlived the last isolate a new watch.
    await this.sockets.reattach();
  }
}
