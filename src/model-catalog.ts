import type { Api, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAI } from "agents/models/pi-ai";
import { ConfigError, readModelConfig, type ConfigEnv, type KeyProvider } from "./config.ts";
import { departure, ours, show, shown } from "./diagnostic.ts";

/**
 * The models the configuration names, as the catalogs pi-ai and `agents`
 * ship resolve them: the demo lane's through `agents`' AI Gateway registry,
 * each own key's through pi-ai's vendor providers. Plain functions with
 * explicit `.ts` imports, so `scripts/check-deployment.ts` can run them under
 * Node before a deploy: a catalog that renamed a model fails the deploy, not
 * every call after it.
 */

/** The setting that names each own key's model. */
export const OWN_KEY_SETTING: Readonly<Record<KeyProvider, string>> = {
  anthropic: "ANTHROPIC_MODEL_ID",
  openai: "OPENAI_MODEL_ID",
  google: "GEMINI_MODEL_ID"
};

/**
 * Google's documented value for a function call Gemini didn't make, which
 * has no thought signature of its own: the conversation started on the demo's
 * Claude, or on another vendor's key. pi-ai 1.6.1 sends such a call unsigned,
 * and Gemini 3 and later can refuse the whole request for it
 * (earendil-works/pi#12420, #10467).
 */
export const FOREIGN_CALL_SIGNATURE = "skip_thought_signature_validator";

/** A Generative Language request body with every unsigned function call in a model turn given `FOREIGN_CALL_SIGNATURE`. */
export function signForeignCalls(payload: unknown): unknown {
  const contents = (payload as { contents?: unknown } | null)?.contents;
  if (!Array.isArray(contents)) return payload;
  let changed = false;
  const signed = contents.map((content: unknown) => {
    const turn = content as { role?: unknown; parts?: unknown };
    if (turn?.role !== "model" || !Array.isArray(turn.parts)) return content;
    const parts = turn.parts.map((part: unknown) => {
      const each = part as { functionCall?: unknown; thoughtSignature?: unknown };
      if (!each?.functionCall || typeof each.thoughtSignature === "string") return part;
      changed = true;
      return { ...each, thoughtSignature: FOREIGN_CALL_SIGNATURE };
    });
    return { ...turn, parts };
  });
  return changed ? { ...(payload as object), contents: signed } : payload;
}

/** pi-ai's Google provider, with `signForeignCalls` after any `onPayload` the caller passed. */
function withForeignCallSignatures(provider: Provider): Provider {
  const signing = <T extends StreamOptions | undefined>(options: T): T => ({
    ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => signForeignCalls((await options?.onPayload?.(payload, model)) ?? payload)
  }) as T;
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, signing(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, signing(options))
  };
}

/** pi-ai's Anthropic, OpenAI and Google providers: straight to each vendor, with the person's key. */
export function nativeProviders(): readonly Provider[] {
  return [anthropicProvider(), openaiProvider(), withForeignCallSignatures(googleProvider())];
}

/** `createAI`'s settings, for metadata only: no binding is ever called. */
type Settings = Parameters<typeof createAI>[0];

/** The demo model's catalog entry: its name, limits and prices. Builds metadata only; nothing is called. */
export function demoCatalogModel(env: ConfigEnv): Model<Api> {
  const config = readModelConfig(env);
  const model = createAI({ binding: {}, id: config.demo.gatewayId } as unknown as Settings)(config.demo.modelId) as Model<Api>;
  if (!model.cost || model.cost.input <= 0 || model.cost.output <= 0) {
    throw new ConfigError(departure(ours("DEMO_MODEL_ID"), ours("a model with a known price in pi-ai's catalog"), show.value(config.demo.modelId), ours("Without one, the demo's caps couldn't be enforced")));
  }
  return model;
}

/** The entry of pi-ai's own Anthropic catalog for a gateway specifier such as `anthropic/claude-sonnet-5.5`, if any. */
export function vendorEntry(model: Model<Api>, specifier: string): Model<Api> | undefined {
  const slash = specifier.indexOf("/");
  if (slash === -1 || specifier.slice(0, slash) !== "anthropic" || model.api !== "anthropic-messages") return undefined;
  // AI Gateway's catalog puts a dot between version numbers (`claude-sonnet-5.5`) where Anthropic, and so pi-ai's
  // Anthropic catalog, puts a dash (`claude-sonnet-5-5`).
  const vendorId = specifier.slice(slash + 1).replace(/(\d)\.(\d)(?!\d)/g, "$1-$2");
  return anthropicProvider().getModels().find((candidate) => candidate.id === vendorId);
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
  const vendor = vendorEntry(model, specifier);
  if (!vendor?.compat) return model;
  return { ...model, compat: { ...model.compat, ...vendor.compat } } as Model<Api>;
}

/**
 * The demo model's compaction fix: an Anthropic model must find its entry in
 * pi-ai's Anthropic catalog and come out of `withVendorCompat` able to drop
 * stale thinking blocks (`supportsMidConvoEffort`). Null when it does, or
 * when the demo model isn't Anthropic's.
 */
export function demoCompatProblem(model: Model<Api>, specifier: string): ConfigError | null {
  if (model.api !== "anthropic-messages" || !specifier.startsWith("anthropic/")) return null;
  const vendor = vendorEntry(model, specifier);
  if (!vendor) {
    return new ConfigError(departure(ours("DEMO_MODEL_ID"), ours("an Anthropic model pi-ai's own Anthropic catalog lists too, whose compat flags carry the compaction fix"), show.value(specifier), ours("Without them the demo lane stops asking Anthropic to drop stale thinking blocks after a summary")));
  }
  const compat = withVendorCompat(model, specifier).compat as { supportsMidConvoEffort?: unknown } | undefined;
  if (compat?.supportsMidConvoEffort !== true) {
    return new ConfigError(departure(ours("DEMO_MODEL_ID"), ours("a model whose compat flags include supportsMidConvoEffort"), show.value(specifier), ours("Without it the demo lane stops asking Anthropic to drop stale thinking blocks after a summary")));
  }
  return null;
}

/**
 * Every problem with the models the configuration names, each a sentence
 * naming its setting; empty when every one resolves. Settings that don't
 * parse are `deploymentProblems`'s to report.
 */
export function modelCatalogProblems(env: ConfigEnv): string[] {
  const config = readModelConfig(env);
  const problems: string[] = [];
  let demo: Model<Api> | undefined;
  try {
    demo = demoCatalogModel(env);
  } catch (error) {
    if (error instanceof ConfigError) problems.push(error.message);
    // `agents` throws a TypeError naming the catalog's spelling when it doesn't list the id.
    else problems.push(new ConfigError(departure(ours("DEMO_MODEL_ID"), ours("a model in AI Gateway's catalog, spelled as that catalog spells it"), show.value(config.demo.modelId), show.text(error instanceof Error ? error.message : String(error), 300))).message);
  }
  if (demo) {
    const compat = demoCompatProblem(demo, config.demo.modelId);
    if (compat) problems.push(compat.message);
  }
  const providers = nativeProviders();
  for (const [provider, id] of Object.entries(config.ownKey) as Array<[KeyProvider, string]>) {
    const listed = providers.find((each) => each.id === provider)?.getModels().some((model) => model.id === id) ?? false;
    if (!listed) problems.push(new ConfigError(departure(show.name(OWN_KEY_SETTING[provider]), shown`a model in pi-ai's ${show.name(provider)} catalog`, show.value(id))).message);
  }
  return problems;
}
