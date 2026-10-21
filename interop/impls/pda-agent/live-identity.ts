/**
 * Live lane only (docs/interop-spec.md §10): the interop test client our
 * deployed Worker publishes at `<origin>/poppy/interop/client.json`
 * (src/poppy/interop-client.ts), and the private key for it, which only the
 * runner's machine holds (interop/runner/live-identity.ts). With it the
 * agent names itself by that public client_id and signs with that key
 * instead of keys it makes for the run. It is never the real client's key:
 * the Worker refuses to publish a key its own client signs with.
 */
import { PoppyClient, type PoppyHost } from "../../../src/poppy/client.ts";
import { readIdentity, type AgentIdentity } from "../../../src/poppy/keys.ts";

export type LiveIdentity = {
  readonly origin: string;
  readonly clientId: string;
  /** `POPPY_SIGNING_JWKS` for the agent: the one private key, as a JSON array. */
  readonly signingJwks: string;
};

/**
 * The identity from `INTEROP_LIVE_CLIENT_ID` and `INTEROP_LIVE_KEY`, or
 * null when neither is set (every lane but live, or a live run without an
 * identity file). One without the other, or either malformed, is an error.
 * Errors never quote the key.
 */
export function liveIdentityFrom(env: { readonly INTEROP_LIVE_CLIENT_ID?: string; readonly INTEROP_LIVE_KEY?: string }): LiveIdentity | null {
  const clientId = env.INTEROP_LIVE_CLIENT_ID;
  const key = env.INTEROP_LIVE_KEY;
  if (!clientId && !key) return null;
  if (!clientId || !key) throw new Error("INTEROP_LIVE_CLIENT_ID and INTEROP_LIVE_KEY go together");
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new Error("INTEROP_LIVE_CLIENT_ID isn't a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.pathname.endsWith("/poppy/interop/client.json") || url.search || url.hash) {
    throw new Error("INTEROP_LIVE_CLIENT_ID must be an HTTPS URL ending in /poppy/interop/client.json, without credentials, query or fragment");
  }
  let jwk: unknown;
  try {
    jwk = JSON.parse(key);
  } catch {
    throw new Error("INTEROP_LIVE_KEY isn't JSON");
  }
  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk)) throw new Error("INTEROP_LIVE_KEY must be a JWK object");
  const { kty, crv, x, y, d, kid } = jwk as Record<string, unknown>;
  if (kty !== "EC" || crv !== "P-256" || typeof x !== "string" || typeof y !== "string" || typeof d !== "string" || typeof kid !== "string" || kid === "") {
    throw new Error("INTEROP_LIVE_KEY must be a private P-256 EC JWK with a kid");
  }
  return { origin: url.origin, clientId, signingJwks: JSON.stringify([{ kty, crv, x, y, d, kid, alg: "ES256", use: "sig" }]) };
}

/**
 * Our client under the live identity: src/poppy's PoppyClient unchanged,
 * with its `identity` (which src/poppy derives from PUBLIC_ORIGIN as the
 * real client's paths) moved to the interop client's. The host's env must
 * carry `PUBLIC_ORIGIN` = the identity's origin and `POPPY_SIGNING_JWKS` =
 * its `signingJwks`. The redirect URI is one the interop client doesn't
 * list, so no Company completes a Direct Sign-In to it; the live lane runs
 * signed-out scenarios only.
 */
export class LiveIdentityClient extends PoppyClient {
  override readonly identity: AgentIdentity;
  constructor(host: PoppyHost, live: LiveIdentity) {
    super(host);
    this.identity = {
      ...readIdentity(host.env),
      clientId: live.clientId,
      jwksUri: new URL("jwks.json", live.clientId).href,
      redirectUri: new URL("callback", live.clientId).href
    };
  }
}
