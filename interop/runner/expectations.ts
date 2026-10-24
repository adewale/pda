/**
 * Proof that a run tests what it says it tests. Two silent mistakes have each
 * passed a whole run: on 23 October the live lane didn't pass a registry
 * entry's `env`, so the "lenient" and "strict" fake agents ran as plain `pda`;
 * on 24 October the runner signed as a `client_id` whose host had answered 404
 * since a domain move. Each check here turns such a mistake into a stopped run
 * or a broken implementation, before any cell.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LiveIdentity } from "./live-identity.ts";
import type { Manifest, RegistryEntry } from "./types.ts";

/**
 * What an implementation's manifest must say, given its registry entry: the
 * profile `INTEROP_AGENT_PROFILE` or `INTEROP_MOCK_PROFILE` names, the one
 * version `INTEROP_POPPY_VERSION` names, that it is adversarial when the
 * registry says so, and, for an agent given the live identity, that it signs
 * as that `client_id`. Null when it does; otherwise what's wrong.
 */
export function manifestMismatch(entry: RegistryEntry, manifest: Manifest, liveClientId: string | null = null): string | null {
  const problems: string[] = [];
  const env = entry.env ?? {};
  const profile = env.INTEROP_AGENT_PROFILE ?? env.INTEROP_MOCK_PROFILE;
  if (profile !== undefined && manifest.profile !== profile) {
    problems.push(`runs profile ${JSON.stringify(manifest.profile ?? null)}, but the registry sets ${JSON.stringify(profile)}`);
  }
  const version = env.INTEROP_POPPY_VERSION;
  if (version !== undefined && (manifest.poppy.length !== 1 || manifest.poppy[0] !== version)) {
    problems.push(`speaks ${JSON.stringify(manifest.poppy)}, but the registry sets Poppy ${version}`);
  }
  if (entry.adversarial && manifest.adversarial !== true) problems.push("isn't adversarial, but the registry says it is");
  if (liveClientId !== null && manifest.client_id !== liveClientId) {
    problems.push(`signs as ${JSON.stringify(manifest.client_id ?? null)}, not the live identity ${liveClientId}`);
  }
  return problems.length ? `${entry.name} ${problems.join("; ")}` : null;
}

/** `PUBLIC_ORIGIN` from the untracked `deployment.local.json`, when there is one. */
export function deploymentOrigin(file = path.resolve(import.meta.dirname, "..", "..", "deployment.local.json")): string | null {
  if (!existsSync(file)) return null;
  try {
    const origin = (JSON.parse(readFileSync(file, "utf8")) as { PUBLIC_ORIGIN?: unknown }).PUBLIC_ORIGIN;
    return typeof origin === "string" && origin !== "" ? origin.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function json(fetcher: typeof fetch, url: string): Promise<{ problem: string } | { value: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return { problem: `${url} couldn't be fetched (${error instanceof Error ? error.message : String(error)})` };
  }
  if (response.status !== 200) return { problem: `${url} answered ${response.status}${response.status >= 300 && response.status < 400 ? " (a redirect, which Companies refuse)" : ""}` };
  const type = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:[a-z.+-]+\+)?json\b/i.test(type)) return { problem: `${url} is served as ${type || "no content type"}, not JSON; some Companies refuse it` };
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? { value } : { problem: `${url} isn't a JSON object` };
  } catch {
    return { problem: `${url} isn't JSON` };
  }
}

/**
 * The live identity as a public Company will see it: its `client_id` document
 * names itself and uses `private_key_jwt`, its key set is on the same origin,
 * and that key set holds the runner's key, the same `kid` with the same public
 * point. Problems stop the run; `warnings` don't (a static host other than
 * `PUBLIC_ORIGIN` is a supported setup, interop/README.md).
 */
export async function checkLiveIdentity(
  identity: LiveIdentity,
  fetcher: typeof fetch = fetch,
  publicOrigin: string | null = deploymentOrigin()
): Promise<{ problems: string[]; warnings: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const expected = publicOrigin ? `${publicOrigin}/poppy/interop/client.json` : null;
  if (expected && identity.clientId !== expected) {
    warnings.push(`the live identity names ${identity.clientId}, but deployment.local.json's PUBLIC_ORIGIN serves ${expected}; after a domain move, run scripts/interop-live-identity.mjs`);
  }
  const metadata = await json(fetcher, identity.clientId);
  if ("problem" in metadata) return { problems: [metadata.problem], warnings };
  const document = metadata.value;
  if (document.client_id !== identity.clientId) problems.push(`${identity.clientId} names client_id ${JSON.stringify(document.client_id)}`);
  if (document.token_endpoint_auth_method !== "private_key_jwt") problems.push(`${identity.clientId} doesn't use private_key_jwt`);
  if (typeof document.jwks_uri !== "string") return { problems: [...problems, `${identity.clientId} names no jwks_uri`], warnings };
  let keysUrl: URL;
  try {
    keysUrl = new URL(document.jwks_uri);
  } catch {
    return { problems: [...problems, `${identity.clientId}'s jwks_uri isn't a URL`], warnings };
  }
  if (keysUrl.origin !== new URL(identity.clientId).origin) problems.push(`${identity.clientId}'s jwks_uri is on another origin, ${keysUrl.origin}`);
  const jwks = await json(fetcher, keysUrl.href);
  if ("problem" in jwks) return { problems: [...problems, jwks.problem], warnings };
  const keys = Array.isArray(jwks.value.keys) ? jwks.value.keys.filter(isRecord) : [];
  const published = keys.find((key) => key.kid === identity.key.kid);
  if (!published) problems.push(`${keysUrl.href} has no key ${identity.key.kid}: the Worker doesn't publish the runner's key`);
  else if (published.x !== identity.key.x || published.y !== identity.key.y) problems.push(`${keysUrl.href}'s key ${identity.key.kid} isn't the runner's: same kid, another public key`);
  if (keys.some((key) => "d" in key)) problems.push(`${keysUrl.href} publishes a private key`);
  return { problems, warnings };
}
