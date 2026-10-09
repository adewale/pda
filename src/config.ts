import type { ThinkingLevel } from "@earendil-works/pi-ai";

/** Pi's thinking levels; anything else in `THINKING_LEVEL` is a config error. */
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

export type ModelConfig = {
  /** A `<slug>/<id>` from pi-ai's Cloudflare AI Gateway catalog. */
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly aiGatewayId: string;
};

export type Provider = "google" | "github";

export type ProviderConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
};

/** A missing or invalid deploy setting; the message names the variable. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * The settings this app reads. Model choices are Wrangler vars; sign-in
 * settings are per deployment, set with `wrangler secret put`.
 */
type ConfigEnv = Pick<Env, "MODEL_ID" | "THINKING_LEVEL" | "AI_GATEWAY_ID"> & {
  readonly SESSION_SECRET?: string;
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
};

function required(env: ConfigEnv, name: keyof ConfigEnv): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Missing required setting ${name}`);
  }
  return value.trim();
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** The model settings; the Durable Object needs only these. No defaults. */
export function readModelConfig(env: ConfigEnv): ModelConfig {
  const thinkingLevel = required(env, "THINKING_LEVEL");
  if (!isThinkingLevel(thinkingLevel)) {
    throw new ConfigError(
      `THINKING_LEVEL must be one of ${THINKING_LEVELS.join(", ")}; got ${JSON.stringify(thinkingLevel)}`
    );
  }
  return {
    modelId: required(env, "MODEL_ID"),
    thinkingLevel,
    aiGatewayId: required(env, "AI_GATEWAY_ID")
  };
}

/** The key that signs session cookies. Rotating it signs everyone out. */
export function readSessionSecret(env: ConfigEnv): string {
  const secret = required(env, "SESSION_SECRET");
  if (secret.length < 32) {
    throw new ConfigError("SESSION_SECRET must be at least 32 characters");
  }
  return secret;
}

/** One OAuth client's settings, read only when that provider is used. */
export function readProviderConfig(
  env: ConfigEnv,
  provider: Provider
): ProviderConfig {
  return provider === "google"
    ? {
        clientId: required(env, "GOOGLE_CLIENT_ID"),
        clientSecret: required(env, "GOOGLE_CLIENT_SECRET")
      }
    : {
        clientId: required(env, "GITHUB_CLIENT_ID"),
        clientSecret: required(env, "GITHUB_CLIENT_SECRET")
      };
}
