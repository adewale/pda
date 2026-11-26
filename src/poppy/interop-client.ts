import { ConfigError } from "../config.ts";
import { departure, ours, show, shown } from "../diagnostic.ts";
import { readIdentity, readSigningKeys } from "./keys.ts";

/**
 * The interop test client: a second Poppy client identity this Worker
 * publishes only when the deployer sets `INTEROP_LIVE_JWKS`, so the interop
 * harness's live lane (docs/interop-spec.md §10) can name itself at a URL a
 * public Company can fetch. Its private key stays on the machine that runs
 * the harness (`scripts/interop-live-identity.mjs`); the Worker holds only
 * the public key set.
 *
 * It is separate from the real client in every way: its own `client_id`
 * and keys, never `POPPY_SIGNING_JWKS`, and no redirect URI, so it can't
 * receive a Direct Sign-In. It has two routes and touches no person's
 * agent or Durable Object.
 */
export const INTEROP_CLIENT_PATH = "/poppy/interop/client.json";
export const INTEROP_JWKS_PATH = "/poppy/interop/jwks.json";

/** One public ES256 key, with only the members a public JWK needs. */
export type InteropPublicKey = {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: "ES256";
  readonly use: "sig";
};

export type InteropClient = {
  readonly clientId: string;
  readonly jwksUri: string;
  readonly keys: readonly InteropPublicKey[];
};

type InteropClientEnv = {
  readonly PUBLIC_ORIGIN?: string;
  readonly POPPY_CLIENT_NAME?: string;
  readonly POPPY_LOGO_URI?: string;
  readonly POPPY_SIGNING_JWKS?: string;
  readonly INTEROP_LIVE_JWKS?: unknown;
};

/** Members that make a JWK private (RFC 7518 §6). */
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The public key set from `INTEROP_LIVE_JWKS`, or null when it is unset or
 * empty (the interop client is off). It takes a JWKS, `{"keys": [...]}`, as
 * an object or its JSON. A private member anywhere is refused, so a key
 * pasted by mistake is never served.
 */
export function readInteropKeys(env: InteropClientEnv): InteropPublicKey[] | null {
  let value = env.INTEROP_LIVE_JWKS;
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new ConfigError(departure(ours("INTEROP_LIVE_JWKS"), ours('a JWKS, {"keys": [...]}, or empty'), ours("text that isn't JSON")));
    }
  }
  if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length === 0) {
    throw new ConfigError(departure(ours("INTEROP_LIVE_JWKS"), ours('a JWKS with at least one key, {"keys": [...]}, or empty'), isRecord(value) && Array.isArray(value.keys) ? ours("no keys") : show.kind(value)));
  }
  const kids = new Set<string>();
  return value.keys.map((entry: unknown) => {
    if (!isRecord(entry)) throw new ConfigError(departure(ours("an INTEROP_LIVE_JWKS key"), ours("a JWK object"), show.kind(entry)));
    if (PRIVATE_MEMBERS.some((member) => member in entry)) {
      throw new ConfigError(departure(ours("an INTEROP_LIVE_JWKS key"), ours("a public key, as scripts/interop-live-identity.mjs prints"), ours("a private one")));
    }
    const { kty, crv, x, y, kid } = entry;
    if (
      kty !== "EC" ||
      crv !== "P-256" ||
      typeof x !== "string" ||
      !BASE64URL.test(x) ||
      typeof y !== "string" ||
      !BASE64URL.test(y) ||
      typeof kid !== "string" ||
      kid === ""
    ) {
      throw new ConfigError(departure(ours("an INTEROP_LIVE_JWKS key"), ours("a public P-256 EC JWK with a kid"), shown`kty ${show.value(kty)}, crv ${show.value(crv)}${typeof kid === "string" && kid !== "" ? ours("") : ours(", no kid")}`));
    }
    if (kids.has(kid)) throw new ConfigError(departure(ours("INTEROP_LIVE_JWKS's kids"), ours("each kid once"), shown`${show.value(kid)} twice`));
    kids.add(kid);
    return { kty, crv, x, y, kid, alg: "ES256", use: "sig" };
  });
}

/** The interop client, or null when the deployment doesn't configure one. */
export function readInteropClient(env: InteropClientEnv): InteropClient | null {
  const keys = readInteropKeys(env);
  if (!keys) return null;
  const { origin } = readIdentity(env);
  return { clientId: `${origin}${INTEROP_CLIENT_PATH}`, jwksUri: `${origin}${INTEROP_JWKS_PATH}`, keys };
}

/** Its client metadata document (spec 4.1). No `redirect_uris`: it never signs a person in. */
export function interopClientMetadata(client: InteropClient) {
  return {
    client_id: client.clientId,
    client_name: "Poppy Demo Agent (interop tests)",
    jwks_uri: client.jwksUri,
    token_endpoint_auth_method: "private_key_jwt"
  };
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/**
 * `GET /poppy/interop/client.json` and `GET /poppy/interop/jwks.json`, on
 * `PUBLIC_ORIGIN` only, never by redirect. Every other path under
 * `/poppy/interop/`, and both of these when the deployment has no interop
 * client, answer 404. A key the real client signs with is never served
 * here: the interop client must have keys of its own.
 */
export async function handleInteropClientRoute(request: Request, env: InteropClientEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== INTEROP_CLIENT_PATH && url.pathname !== INTEROP_JWKS_PATH) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  const client = readInteropClient(env);
  if (!client || url.origin !== readIdentity(env).origin) return notFound();
  const signing = new Set((await readSigningKeys(env)).map((key) => `${key.publicJwk.x}.${key.publicJwk.y}`));
  if (client.keys.some((key) => signing.has(`${key.x}.${key.y}`))) {
    throw new ConfigError(departure(ours("INTEROP_LIVE_JWKS"), ours("keys of its own"), ours("one POPPY_SIGNING_JWKS also holds")));
  }
  const body = url.pathname === INTEROP_CLIENT_PATH ? interopClientMetadata(client) : { keys: client.keys };
  return Response.json(body, { headers: { "Cache-Control": "public, max-age=3600" } });
}
