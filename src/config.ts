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

export type Config = {
  /** `https://<team>.cloudflareaccess.com`, the Access JWT issuer. */
  readonly teamDomain: string;
  /** The Access application's AUD tag. */
  readonly policyAud: string;
  /** A `<slug>/<id>` from pi-ai's Cloudflare AI Gateway catalog. */
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly aiGatewayId: string;
};

/** A missing or invalid deploy setting; the message names the variable. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

type ConfigEnv = Pick<
  Env,
  "MODEL_ID" | "THINKING_LEVEL" | "AI_GATEWAY_ID"
> & {
  readonly TEAM_DOMAIN?: string;
  readonly POLICY_AUD?: string;
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

/** Every deploy-specific value, read from the Worker's env. No defaults. */
export function readConfig(env: ConfigEnv): Config {
  return { ...readModelConfig(env), ...readAccessConfig(env) };
}

/** The Access settings alone, for routes that never call the model. */
export function readAccessConfig(
  env: ConfigEnv
): Pick<Config, "teamDomain" | "policyAud"> {
  const teamDomain = required(env, "TEAM_DOMAIN").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) {
    throw new ConfigError(
      "TEAM_DOMAIN must look like https://<team>.cloudflareaccess.com"
    );
  }
  return { teamDomain, policyAud: required(env, "POLICY_AUD") };
}

/** The model settings alone; the Durable Object needs only these. */
export function readModelConfig(
  env: ConfigEnv
): Pick<Config, "modelId" | "thinkingLevel" | "aiGatewayId"> {
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
