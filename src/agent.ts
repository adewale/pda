import { DurableObject } from "cloudflare:workers";
import type { Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { Ledger } from "./budget";
import { isKeyProvider, readModelConfig, type KeyProvider } from "./config";
import { checkKey, keyFormatProblem, ModelKeys, NO_AMBIENT_AUTH, PROVIDER_LABEL } from "./model-keys";
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
import { exchangeOpenRouterCode } from "./openrouter";
import { Sealer } from "./poppy/store";
import type { Card } from "./poppy/wire";
import type { PoppyBrowser } from "./poppy/browser";
import { PoppyCapability } from "./poppy/capability";
import type { Fetcher, PoppyTimeouts } from "./poppy/fetch";
import { FetchBrowser } from "./poppy/fetch-browser";
import { poppyExtension } from "./poppy/tools";
import { PiSessionSockets } from "./sockets";

const PREAMBLE =
  "You are the user's personal agent: a helpful, concise assistant in one long-running conversation with the person who owns you. Earlier turns are your memory of them, so use what they have told you. Be direct, and say plainly when you do not know something.";

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

/** The outcome of saving a key, for `POST /api/model-key`. Never carries the key. */
export type KeyResult = { ok: true; entitlement: Entitlement } | { ok: false; status: 400 | 502; error: string };

/** One person's agent: a Pi harness whose root session is their one chat. */
export class PersonalAgent extends DurableObject<Env> {
  readonly registry = createRegistry();
  readonly harness: PiHarness;
  readonly sockets: PiSessionSockets;
  readonly webSockets: WebSockets;
  readonly poppy: PoppyCapability;
  readonly lifecycle: Lifecycle;
  readonly keys: ModelKeys;
  readonly access: ModelAccess;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
    const config = readModelConfig(env);
    let sealer: Sealer | undefined;
    this.keys = new ModelKeys(ctx.storage.sql, () => (sealer ??= new Sealer(env)), ctx.id.toString());
    this.access = new ModelAccess({
      env,
      keys: this.keys,
      ledger: new Ledger(ctx.storage.sql),
      profile: () => this.#profile(),
      agent: ctx.id.toString().slice(0, 32),
      domainBudget: (domain) => env.DomainBudget.getByName(domain),
      demoLane: (route) => this.demoLane(route),
      ownKeyProviders: () => this.ownKeyProviders(),
      onRefused: (entitlement) => this.#modelNotice(entitlement),
      onKeyRefused: (provider) => this.#keyRefusedNotice(provider)
    });
    const router = routerProvider(this.access, demoCatalogModel(env));
    let browser: PoppyBrowser | undefined;
    this.poppy = new PoppyCapability({
      env,
      storage: ctx.storage,
      fetcher: this.poppyFetcher(),
      browser: () => (browser ??= this.poppyBrowser()),
      notifyModel: (text, operationId) => this.poppyNotify(text, operationId),
      ...this.poppySettings()
    });
    this.harness = new PiHarness({
      harness: async ({ storage, context }) => {
        this.registry.install({
          name: "persona",
          sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
          tools: []
        });
        this.registry.install(
          poppyExtension(
            () => this.poppy.client,
            () => this.poppy.browser
          )
        );
        // One provider, the router: it picks the lane at every call (model-router.ts).
        const models = createModels({ authContext: NO_AMBIENT_AUTH });
        models.setProvider(router);
        return Harness.open(
          storage,
          {
            models,
            registry: this.registry,
            settings: {
              // pi doubles the delay before each retry: 1, 2, 4, 8 and 16
              // seconds, so a rate-limited model gets about 30 seconds.
              retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
            },
            onReport: (error) => console.warn("pi report", error)
          },
          context
        );
      },
      defaults: { model: ROUTER_MODEL, thinkingLevel: config.thinkingLevel }
    });
    this.sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
      this.ctx.getWebSockets(tag)
    );
    this.webSockets = new WebSockets(this.sockets.options());
    // Poppy first, so it sees `poppy.*` frames before the chat socket does.
    this.lifecycle = Lifecycle.install(this)
      .use(this.poppy)
      .use(this.webSockets)
      .use(this.harness);
  }

  /** The demo lane: AI Gateway on the AI binding. Tests override this with pi-ai's faux provider. */
  protected demoLane(route: DemoRoute): LaneModel {
    return gatewayDemoLane(this.env, route);
  }

  /** People's own keys: pi-ai's providers, straight to each vendor. Tests keep these, against fakes. */
  protected ownKeyProviders(): readonly Provider[] {
    return nativeProviders();
  }

  /** Where key checks and the OpenRouter code exchange go. */
  protected modelFetcher(): (request: Request) => Promise<Response> {
    return (request) => fetch(request);
  }

  /** Where Poppy requests go; tests route them to the mock Company. */
  protected poppyFetcher(): Fetcher {
    return (request) => fetch(request);
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
    const { entitlement } = await this.access.decide();
    if (entitlement.lane === "none") {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO model_paused (operation_id, text, created_at) VALUES (?, ?, ?)",
        operationId,
        text,
        Date.now()
      );
      await this.#modelNotice(entitlement);
      return;
    }
    await this.#resumePaused();
    await this.harness.submit(text, { operationId, whenBusy: "followUp" });
  }

  /** Background notices held while model calls were refused, oldest first, once calls are allowed again. */
  async #resumePaused(): Promise<void> {
    const held = this.ctx.storage.sql
      .exec("SELECT operation_id, text FROM model_paused ORDER BY created_at")
      .toArray() as Array<{ operation_id: string; text: string }>;
    if (held.length === 0) return;
    if ((await this.access.entitlement()).lane === "none") return;
    for (const row of held) {
      await this.harness.submit(row.text, { operationId: row.operation_id, whenBusy: "followUp" });
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
   * background turns included. Then anything held for a refused model goes
   * through if calls are allowed again.
   */
  async recordIdentity(identity: Profile): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO agent_profile (slot, provider, sub, email, domain, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
      identity.provider,
      identity.sub,
      identity.email,
      identity.domain,
      Date.now()
    );
    await this.#resumePaused();
  }

  /** Which lane, today's demo spend, the key's provider and state. Never the key. */
  async entitlement(identity: Profile): Promise<Entitlement> {
    await this.recordIdentity(identity);
    return this.access.entitlement();
  }

  /** Check a pasted key with the provider, then seal and store it. The key is never returned or logged. */
  async setModelKey(identity: Profile, provider: unknown, key: unknown): Promise<KeyResult> {
    await this.recordIdentity(identity);
    if (!isKeyProvider(provider) || provider === "openrouter") {
      return { ok: false, status: 400, error: "Choose Anthropic or OpenAI, or connect OpenRouter." };
    }
    if (typeof key !== "string") return { ok: false, status: 400, error: "Paste a key." };
    const trimmed = key.trim();
    const problem = keyFormatProblem(provider, trimmed);
    if (problem) return { ok: false, status: 400, error: problem };
    const checked = await checkKey(provider, trimmed, this.modelFetcher());
    if (!checked.ok) return checked;
    await this.keys.put(provider, trimmed, "pasted");
    return this.#keyChanged();
  }

  /** Finish OpenRouter's PKCE sign-in: swap the code for a key, then store it like a pasted one. */
  async connectOpenRouter(identity: Profile, code: string, verifier: string): Promise<KeyResult> {
    await this.recordIdentity(identity);
    const exchanged = await exchangeOpenRouterCode(code, verifier, this.modelFetcher());
    if (!exchanged.ok) return exchanged;
    await this.keys.put("openrouter", exchanged.key, "openrouter");
    return this.#keyChanged();
  }

  async removeModelKey(identity: Profile): Promise<Entitlement> {
    await this.recordIdentity(identity);
    this.keys.remove();
    return this.access.entitlement();
  }

  async #keyChanged(): Promise<KeyResult> {
    await this.#closeModelNotice();
    await this.#resumePaused();
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
    await this.#showModelCard("Model calls are back on.", false);
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

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    // Sessions created before the model router named their own model; point them at it.
    await this.harness.session().setModel(ROUTER_MODEL);
    // Give sockets that outlived the last isolate a new watch.
    await this.sockets.reattach();
  }
}
