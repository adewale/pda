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

/** Where a person's own model key comes from. */
export type KeyProvider = "anthropic" | "openai";

export const KEY_PROVIDERS: readonly KeyProvider[] = ["anthropic", "openai"];

export function isKeyProvider(value: unknown): value is KeyProvider {
  return typeof value === "string" && (KEY_PROVIDERS as readonly string[]).includes(value);
}

export type ModelConfig = {
  readonly thinkingLevel: ThinkingLevel;
  /** The demo lane: the deployment's AI Gateway, paid by its operator. */
  readonly demo: {
    readonly gatewayId: string;
    /** A `<slug>/<id>` from pi-ai's Cloudflare AI Gateway catalog. */
    readonly modelId: string;
  };
  /** The own-key lane: the model id in each provider's pi-ai catalog. */
  readonly ownKey: Readonly<Record<KeyProvider, string>>;
};

/** Daily spend caps for the demo lane, in US dollars, per UTC day. */
export type DemoCaps = {
  readonly perUserUsd: number;
  readonly perDomainUsd: number;
};

/** `allowlist`: only people on `SIGNIN_ALLOWLIST` (and `OWNERS`) sign in. `open`: anyone with a Google or GitHub account. */
export type Signup = "allowlist" | "open";

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
 * The settings this app reads. Product choices are Wrangler vars; who the
 * deployment is for (`OWNERS`, the allowlists, `PUBLIC_ORIGIN`) comes from
 * the deployer's own untracked file (`deployment.local.json`); sign-in
 * settings are secrets, set with `wrangler secret put`.
 */
export type ConfigEnv = {
  readonly THINKING_LEVEL?: unknown;
  readonly DEMO_GATEWAY_ID?: unknown;
  readonly DEMO_MODEL_ID?: unknown;
  readonly ANTHROPIC_MODEL_ID?: unknown;
  readonly OPENAI_MODEL_ID?: unknown;
  readonly DEMO_DAILY_USD_PER_USER?: unknown;
  readonly DEMO_DAILY_USD_PER_DOMAIN?: unknown;
  readonly SIGNUP?: unknown;
  readonly SIGNIN_PROVIDERS?: unknown;
  readonly BROWSER_RUN?: unknown;
  readonly SESSION_SECRET?: unknown;
  readonly GOOGLE_CLIENT_ID?: unknown;
  readonly GOOGLE_CLIENT_SECRET?: unknown;
  readonly GITHUB_CLIENT_ID?: unknown;
  readonly GITHUB_CLIENT_SECRET?: unknown;
};

function required(env: ConfigEnv, name: keyof ConfigEnv): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Missing required setting ${name}`);
  }
  return value.trim();
}

function dollars(env: ConfigEnv, name: keyof ConfigEnv): number {
  const raw = env[name];
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${name} must be a number of US dollars, 0 or more`);
  }
  return value;
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
    thinkingLevel,
    demo: {
      gatewayId: required(env, "DEMO_GATEWAY_ID"),
      modelId: required(env, "DEMO_MODEL_ID")
    },
    ownKey: {
      anthropic: required(env, "ANTHROPIC_MODEL_ID"),
      openai: required(env, "OPENAI_MODEL_ID")
    }
  };
}

/** The demo lane's daily caps. 0 turns the demo off. */
export function readDemoCaps(env: ConfigEnv): DemoCaps {
  return {
    perUserUsd: dollars(env, "DEMO_DAILY_USD_PER_USER"),
    perDomainUsd: dollars(env, "DEMO_DAILY_USD_PER_DOMAIN")
  };
}

export function readSignup(env: ConfigEnv): Signup {
  const value = required(env, "SIGNUP");
  if (value !== "allowlist" && value !== "open") {
    throw new ConfigError(`SIGNUP must be allowlist or open; got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The sign-in providers this deployment offers, from `SIGNIN_PROVIDERS`: a
 * non-empty list of `google` and `github`, as an array or its JSON. A
 * provider left out has no button and its `/auth/<provider>` routes answer
 * 404, so a deployment can run before that provider's OAuth client exists.
 */
export function readSignInProviders(env: ConfigEnv): readonly Provider[] {
  let value = env.SIGNIN_PROVIDERS;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new ConfigError(`SIGNIN_PROVIDERS must be a list such as ["github"]; got ${JSON.stringify(value)}`);
    }
  }
  const known: readonly string[] = ["google", "github"];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !known.includes(item))) {
    throw new ConfigError(`SIGNIN_PROVIDERS must be a non-empty list of google and github; got ${JSON.stringify(value)}`);
  }
  if (new Set(value).size !== value.length) throw new ConfigError("SIGNIN_PROVIDERS lists a provider twice");
  return value as Provider[];
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

/**
 * Whether read_url may render pages in Cloudflare Browser Run: `on` or
 * `off`, from `BROWSER_RUN`. Off, a page that needs JavaScript is read
 * without it and the model is told it couldn't be rendered.
 */
export function readBrowserRun(env: ConfigEnv): "on" | "off" {
  const value = required(env, "BROWSER_RUN");
  if (value !== "on" && value !== "off") {
    throw new ConfigError(`BROWSER_RUN must be on or off; got ${JSON.stringify(value)}`);
  }
  return value;
}
