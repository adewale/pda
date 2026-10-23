/**
 * The live lane's identity (spec §10): the interop test client our deployed
 * Worker publishes at `<PUBLIC_ORIGIN>/poppy/interop/client.json`, whose
 * private key only the runner's machine holds, in the gitignored
 * `interop/.live-identity.json` that `scripts/interop-live-identity.mjs`
 * writes. In the live lane the runner hands that key and client_id to our
 * own agent's container, and to nothing else; the local lane never uses it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RegistryEntry } from "./types.ts";

export const LIVE_IDENTITY_FILE = path.resolve(import.meta.dirname, "..", ".live-identity.json");

/** The private ES256 JWK and the public client_id it signs for. */
export type LiveIdentity = {
  readonly clientId: string;
  readonly key: Readonly<Record<string, string>>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The identity in `file`, or null when there is none. A file that is there
 * but malformed is an error, never a silent fall back to the private name.
 * Errors name the problem, never the key.
 */
export function readLiveIdentity(file = LIVE_IDENTITY_FILE): LiveIdentity | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${path.basename(file)} isn't JSON; make a new one with scripts/interop-live-identity.mjs --new`);
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.client_id !== "string" || !isRecord(value.key)) {
    throw new Error(`${path.basename(file)} isn't a version 1 live identity; make a new one with scripts/interop-live-identity.mjs --new`);
  }
  let url: URL;
  try {
    url = new URL(value.client_id);
  } catch {
    throw new Error(`${path.basename(file)}: client_id isn't a URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.pathname.endsWith("/poppy/interop/client.json") || url.search || url.hash) {
    throw new Error(`${path.basename(file)}: client_id must be an HTTPS URL ending in /poppy/interop/client.json, without credentials, query or fragment`);
  }
  const key = value.key;
  const strings = ["kty", "crv", "x", "y", "d", "kid"].every((name) => typeof key[name] === "string" && key[name] !== "");
  if (!strings || key.kty !== "EC" || key.crv !== "P-256") {
    throw new Error(`${path.basename(file)}: key must be a private P-256 EC JWK with a kid`);
  }
  const { kty, crv, x, y, d, kid } = key as Record<string, string>;
  return { clientId: value.client_id, key: { kty: kty!, crv: crv!, x: x!, y: y!, d: d!, kid: kid!, alg: "ES256", use: "sig" } };
}

/** Names of the environment variables that carry the identity into the agent's container. */
export const LIVE_CLIENT_ID_VAR = "INTEROP_LIVE_CLIENT_ID";
export const LIVE_KEY_VAR = "INTEROP_LIVE_KEY";

/**
 * What a container gets of the live identity: nothing in the local lane,
 * nothing for anyone else's implementation or an adversarial one, and for
 * our own honest agent in the live lane, the client_id (public) and the key
 * (secret). The runner passes the key through the docker CLI's environment,
 * never its arguments.
 */
export function liveIdentityEnv(
  lane: "local" | "live",
  entry: RegistryEntry,
  identity: LiveIdentity | null
): { readonly public: Readonly<Record<string, string>>; readonly secret: Readonly<Record<string, string>> } {
  if (lane !== "live" || !identity || entry.role !== "agent" || entry.owner !== "self" || entry.adversarial || entry.live === false) return { public: {}, secret: {} };
  return { public: { [LIVE_CLIENT_ID_VAR]: identity.clientId }, secret: { [LIVE_KEY_VAR]: JSON.stringify(identity.key) } };
}

/** The line the live lane prints about its identity before it starts. */
export function liveIdentityNotice(identity: LiveIdentity | null): string {
  if (identity) return `live identity: ${identity.clientId} (key from interop/.live-identity.json)`;
  return (
    "live identity: none (no interop/.live-identity.json), so the agent names itself at pda.agent.interop.test, " +
    "which no public Company can fetch: a Company that checks client metadata refuses S0, N and C with invalid_client. " +
    "To set one up: node scripts/interop-live-identity.mjs, then deploy (interop/README.md, The live lane's identity)."
  );
}
