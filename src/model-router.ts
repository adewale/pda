import {
  createAssistantMessageEventStream,
  lazyStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type Models,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAI } from "agents/models/pi-ai";
import { budgetDomain, onDemo } from "./allowlist";
import { budgetWindow } from "./compaction";
import { nextUtcMidnight, utcDay, type Ledger } from "./budget";
import { ConfigError, readModelConfig, readDemoCaps, type KeyProvider } from "./config";
import {
  isKeyRefused,
  NO_AMBIENT_AUTH,
  PROVIDER_LABEL,
  redactKeys,
  SealedCredentialStore,
  type KeyInfo,
  type ModelKeys
} from "./model-keys";
import type { Identity } from "./session";

/**
 * Which model lane a person's agent uses, decided before every model call:
 *
 * 1. Their own key, if they have one: it always wins. Calls go straight to
 *    the provider through pi-ai's own provider, never through the operator's
 *    gateway, so a request that lost its key can never be billed to the
 *    operator.
 * 2. A key the provider refused (401) stops model calls until it is replaced.
 *    It never falls back to the demo.
 * 3. The demo, for owners and people on `DEMO_ALLOWLIST`, while today's
 *    spend is under both the per-person and the per-domain cap: the AI
 *    binding, through the `DEMO_GATEWAY_ID` gateway, on Unified Billing.
 * 4. Otherwise "needs a key": no model calls at all.
 *
 * Pi sees one model, `personal-agent/model`, whose provider asks for the lane
 * at each request. So the check covers every model call: the person's own
 * turns, background turns (Company messages), and each tool round.
 */

export type Refusal = "no_key" | "key_invalid" | "user_cap" | "domain_cap";

/** What `/api/entitlement` returns and Settings shows. Never the key. */
export type Entitlement = {
  readonly lane: "own_key" | "demo" | "none";
  readonly reason: Refusal | null;
  readonly key: KeyInfo | null;
  /** Today's demo spend, for people on the demo; null for everyone else. */
  readonly demo: {
    readonly spentUsd: number;
    readonly capUsd: number;
    readonly domainCapped: boolean;
    readonly resetsAt: number;
  } | null;
  /** The model this lane would call. */
  readonly model: { readonly provider: string; readonly id: string; readonly name: string } | null;
};

/** The person this agent belongs to, as the Worker last verified them. */
export type Profile = Pick<Identity, "provider" | "sub" | "email" | "domain">;

/** The demo's gateway metadata: who spent, for the gateway's spend rules (at most 5 scalar entries). */
export type DemoRoute = { readonly u: string; readonly d: string };

/** A provider and one of its models. */
export type LaneModel = { readonly provider: Provider; readonly model: Model<Api> };

/** Where the router sends one call. */
type Lane =
  | { readonly kind: "own_key"; readonly provider: KeyProvider; readonly models: Models; readonly model: Model<Api> }
  | { readonly kind: "demo"; readonly models: Models; readonly model: Model<Api>; readonly domain: string };

export type AccessOptions = {
  readonly env: Env;
  readonly keys: ModelKeys;
  readonly ledger: Ledger;
  /** The person's recorded identity, or null before the Worker has sent it. */
  readonly profile: () => Profile | null;
  /** Gateway metadata `u`: a hash naming this agent, never the person. */
  readonly agent: string;
  readonly domainBudget: (domain: string) => { spent(day: string): Promise<number>; add(day: string, usd: number): Promise<number> };
  /** The demo lane's provider and model. Tests replace it with pi-ai's faux provider. */
  readonly demoLane: (route: DemoRoute) => LaneModel;
  /** pi-ai's own providers for people's keys. Never the AI binding. */
  readonly ownKeyProviders: () => readonly Provider[];
  /** A call was refused; show the person why. */
  readonly onRefused: (entitlement: Entitlement) => Promise<void>;
  /** The provider refused the person's key. */
  readonly onKeyRefused: (provider: KeyProvider) => Promise<void>;
  readonly now?: () => number;
};

/** The demo model's catalog entry: its name, limits and prices. Builds metadata only; nothing is called. */
export function demoCatalogModel(env: Env): Model<Api> {
  const config = readModelConfig(env);
  const model = createAI({ binding: {} as Ai, id: config.demo.gatewayId })(config.demo.modelId) as Model<Api>;
  if (!model.cost || model.cost.input <= 0 || model.cost.output <= 0) {
    throw new ConfigError("DEMO_MODEL_ID has no known price, so the demo's caps couldn't be enforced");
  }
  return model;
}

/** The production demo lane: the AI binding, through the demo gateway, tagged with who spent. */
export function gatewayDemoLane(env: Env, route: DemoRoute): LaneModel {
  const config = readModelConfig(env);
  const ai = createAI({ binding: env.AI, id: config.demo.gatewayId, metadata: { u: route.u, d: route.d } });
  return { provider: ai.provider, model: withVendorCompat(ai(config.demo.modelId) as Model<Api>, config.demo.modelId) };
}

/**
 * A gateway model with the compat flags of the vendor's own catalog entry for
 * the same model, so the demo lane sends Anthropic the request the own-key
 * lane sends. pi-ai's gateway entry for Claude Sonnet 5.5 lacks
 * `supportsMidConvoEffort`, and without it pi-ai doesn't ask Anthropic to
 * drop thinking blocks whose prefix changed (`block_binding:
 * { prefix_mismatch_behavior: "drop_block" }`), as a compacted history's do.
 * Models of other vendors, and ones pi-ai's Anthropic catalog doesn't list,
 * are left as they are.
 */
export function withVendorCompat(model: Model<Api>, specifier: string): Model<Api> {
  const slash = specifier.indexOf("/");
  if (slash === -1 || specifier.slice(0, slash) !== "anthropic" || model.api !== "anthropic-messages") return model;
  const vendorId = specifier.slice(slash + 1);
  const vendor = anthropicProvider().getModels().find((candidate) => candidate.id === vendorId);
  if (!vendor?.compat) return model;
  return { ...model, compat: { ...model.compat, ...vendor.compat } } as Model<Api>;
}

/** pi-ai's Anthropic and OpenAI providers: straight to each vendor, with the person's key. */
export function nativeProviders(): readonly Provider[] {
  return [anthropicProvider(), openaiProvider()];
}

/** A text explaining a refusal: the model error pi records, and the notice the person sees. */
export function refusalText(entitlement: Entitlement): string {
  const key = entitlement.key ? PROVIDER_LABEL[entitlement.key.provider] : "";
  switch (entitlement.reason) {
    case "key_invalid":
      return `Model calls are stopped: ${key} refused your key (401). Add a working key in Settings.`;
    case "user_cap":
      return "Model calls are paused: you've used today's demo allowance. It resets at midnight UTC, or add your own key in Settings.";
    case "domain_cap":
      return "Model calls are paused: your organisation has used today's demo allowance. It resets at midnight UTC, or add your own key in Settings.";
    default:
      return "Model calls are off: this agent has no model key. Add your own in Settings.";
  }
}

/** Thrown inside a lazy stream: pi records it as the response's error and doesn't retry it. */
class ModelRefused extends Error {
  override name = "ModelRefused";
}

export class ModelAccess {
  readonly #options: AccessOptions;
  #ownKeyModels: Models | undefined;

  constructor(options: AccessOptions) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #models(): Models {
    if (!this.#ownKeyModels) {
      const models = createModels({
        credentials: new SealedCredentialStore(this.#options.keys),
        authContext: NO_AMBIENT_AUTH
      });
      for (const provider of this.#options.ownKeyProviders()) models.setProvider(provider);
      this.#ownKeyModels = models;
    }
    return this.#ownKeyModels;
  }

  /**
   * The context window of the model the next call would most likely use:
   * the person's key's model, else the demo's. Read without deciding the
   * lane (that needs the domain's budget); undefined if it can't be told.
   */
  contextWindow(): number | undefined {
    try {
      const key = this.#options.keys.info();
      if (key?.status === "valid") return this.#ownKeyModel(key.provider).contextWindow;
      return demoCatalogModel(this.#options.env).contextWindow;
    } catch {
      return undefined;
    }
  }

  #ownKeyModel(provider: KeyProvider): Model<Api> {
    const id = readModelConfig(this.#options.env).ownKey[provider];
    const model = this.#models().getModel(provider, id);
    if (!model) {
      const name = { anthropic: "ANTHROPIC_MODEL_ID", openai: "OPENAI_MODEL_ID" }[provider];
      throw new ConfigError(`${name} ${JSON.stringify(id)} isn't in pi-ai's ${PROVIDER_LABEL[provider]} catalog`);
    }
    return model;
  }

  /** The lane now, and what Settings shows. */
  async decide(): Promise<{ entitlement: Entitlement; lane: Lane | null }> {
    const { env, keys, ledger } = this.#options;
    const now = this.#now();
    const key = keys.info();
    const profile = this.#options.profile();
    const eligible = profile !== null && onDemo(profile, env);
    let demo: Entitlement["demo"] = null;
    let domain = "";
    if (eligible) {
      const caps = readDemoCaps(env);
      const day = utcDay(now);
      domain = budgetDomain(profile);
      const spentUsd = ledger.spent(day);
      const domainSpent = await this.#options.domainBudget(domain).spent(day);
      demo = {
        spentUsd,
        capUsd: caps.perUserUsd,
        domainCapped: domainSpent >= caps.perDomainUsd,
        resetsAt: nextUtcMidnight(now)
      };
    }
    const result = (
      lane: Entitlement["lane"],
      reason: Refusal | null,
      model: Model<Api> | null,
      route: Lane | null
    ): { entitlement: Entitlement; lane: Lane | null } => ({
      entitlement: {
        lane,
        reason,
        key,
        demo,
        model: model ? { provider: model.provider, id: model.id, name: model.name ?? model.id } : null
      },
      lane: route
    });

    if (key?.status === "valid") {
      const model = this.#ownKeyModel(key.provider);
      return result("own_key", null, model, { kind: "own_key", provider: key.provider, models: this.#models(), model });
    }
    if (key?.status === "invalid") return result("none", "key_invalid", null, null);
    if (demo && profile) {
      if (demo.spentUsd >= demo.capUsd) return result("none", "user_cap", null, null);
      if (demo.domainCapped) return result("none", "domain_cap", null, null);
      demoCatalogModel(env);
      const { provider, model } = this.#options.demoLane({ u: this.#options.agent, d: domain });
      const models = createModels({ authContext: NO_AMBIENT_AUTH });
      models.setProvider(provider);
      return result("demo", null, model, { kind: "demo", models, model, domain });
    }
    return result("none", "no_key", null, null);
  }

  async entitlement(): Promise<Entitlement> {
    return (await this.decide()).entitlement;
  }

  /** One model call: decide, refuse before calling if need be, then meter what it cost. */
  route(
    outer: Model<Api>,
    call: (models: Models, model: Model<Api>) => AssistantMessageEventStream
  ): AssistantMessageEventStream {
    return lazyStream(outer, async () => {
      const { entitlement, lane } = await this.decide();
      if (!lane) {
        await this.#options.onRefused(entitlement);
        throw new ModelRefused(refusalText(entitlement));
      }
      return this.#meter(lane, call(lane.models, lane.model));
    });
  }

  /** Forward the call's events, then record a demo call's cost, or a refused key. */
  #meter(lane: Lane, inner: AssistantMessageEventStream): AssistantMessageEventStream {
    const out = createAssistantMessageEventStream();
    void (async () => {
      let final: AssistantMessage | undefined;
      for await (const event of inner) {
        let forwarded: AssistantMessageEvent = event;
        if (event.type === "done") final = event.message;
        if (event.type === "error") {
          final = event.error;
          if (lane.kind === "own_key") forwarded = { ...event, error: await this.#keyError(lane, event.error) };
        }
        out.push(forwarded);
      }
      const message = final ?? (await inner.result());
      if (lane.kind === "demo") {
        const cost = message.usage?.cost?.total ?? 0;
        if (cost > 0) {
          const day = utcDay(this.#now());
          this.#options.ledger.add(day, cost);
          await this.#options.domainBudget(lane.domain).add(day, cost);
        }
      }
      out.end(lane.kind === "own_key" && message.stopReason === "error" ? await this.#keyError(lane, message) : message);
    })().catch((error: unknown) => {
      // Never leave pi waiting on a stream that can't finish.
      console.warn("model call metering failed", error instanceof Error ? error.name : "error");
      out.end();
    });
    return out;
  }

  /** An own-key call's error: keys redacted from the message; a 401 marks the key invalid. */
  async #keyError(lane: Extract<Lane, { kind: "own_key" }>, message: AssistantMessage): Promise<AssistantMessage> {
    if (message.stopReason === "error" && isKeyRefused(message.errorMessage) && this.#options.keys.info()?.status === "valid") {
      this.#options.keys.markInvalid();
      await this.#options.onKeyRefused(lane.provider);
    }
    if (isKeyRefused(message.errorMessage)) {
      return { ...message, errorMessage: `${PROVIDER_LABEL[lane.provider]} refused your key (401). Model calls are stopped until you add a working key in Settings.` };
    }
    return message.errorMessage === undefined ? message : { ...message, errorMessage: redactKeys(message.errorMessage) };
  }
}

/** The one model pi sees; the router picks the real one per call. */
export const ROUTER_MODEL = { provider: "personal-agent", id: "model" } as const;

/**
 * A pi-ai provider whose only model asks `access` for a lane at every call.
 * `metadata` lends it limits. Its context window is the compaction budget,
 * or the lane model's own window when that is smaller (`compaction.ts`):
 * pi-durable reads it before every request to decide when to summarise.
 */
export function routerProvider(access: ModelAccess, metadata: Model<Api>): Provider {
  const base: Model<Api> = {
    ...metadata,
    id: ROUTER_MODEL.id,
    name: "Personal agent model",
    provider: ROUTER_MODEL.provider,
    api: "personal-agent-router" as Api,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  const model = (): Model<Api> => ({ ...base, contextWindow: budgetWindow(access.contextWindow() ?? metadata.contextWindow) });
  return {
    id: ROUTER_MODEL.provider,
    name: "Personal agent",
    auth: { apiKey: { name: "Personal agent (no key of its own)", resolve: async () => ({ auth: {} }) } },
    getModels: () => [model()],
    stream: (_model, context: TranscriptContext, options?: StreamOptions) =>
      access.route(model(), (models, target) => models.stream(target, context, strip(options))),
    streamSimple: (_model, context: TranscriptContext, options?: SimpleStreamOptions) =>
      access.route(model(), (models, target) => models.streamSimple(target, context, strip(options)))
  };
}

/** The router's own resolved auth is empty; the inner `Models` resolves the lane's. */
function strip<T extends { apiKey?: string; headers?: Record<string, string | null> } | undefined>(options: T): T {
  if (!options) return options;
  const { apiKey: _apiKey, ...rest } = options;
  return rest as T;
}
