import { calculateJwkThumbprint, exportJWK, SignJWT, type JWK } from "jose";
import { base64url } from "../base64url";
import type { SigningKey } from "./keys";

export { base64url };

const encoder = new TextEncoder();

/** A random id: `prefix` + base64url of `bytes` random bytes (128 bits by default). */
export function randomId(prefix = "", bytes = 16): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return base64url(new Uint8Array(digest));
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Client assertions are short-lived (spec 4.1: "MUST make them short-lived",
 * with no number). One minute.
 */
const ASSERTION_SECONDS = 60;

/** RFC 7523 client assertion for `private_key_jwt` at the token or revocation endpoint. */
export function clientAssertion(key: SigningKey, clientId: string, audience: string) {
  const issuedAt = now();
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ASSERTION_SECONDS)
    .setJti(randomId())
    .sign(key.privateKey);
}

/**
 * A DPoP key pair: generated per User per Company, non-extractable, held only
 * in memory (Guides, "DPoP keys and proofs"). The public half is exported
 * once for proof headers.
 */
export type DpopKey = {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
  readonly thumbprint: string;
};

export async function newDpopKey(): Promise<DpopKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const exported = await exportJWK(pair.publicKey);
  const publicJwk: JWK = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  return {
    privateKey: pair.privateKey,
    publicJwk,
    thumbprint: await calculateJwkThumbprint(publicJwk)
  };
}

/** `htu`: the request URL without query or fragment (spec 4.3). */
export function htu(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/** A DPoP proof (RFC 9449) for one request; a fresh one for every request and retry. */
export async function dpopProof(
  key: DpopKey,
  request: { method: string; url: string; accessToken?: string; nonce?: string }
): Promise<string> {
  const payload: Record<string, string | number> = {
    jti: randomId(),
    htm: request.method.toUpperCase(),
    htu: htu(request.url),
    iat: now()
  };
  if (request.accessToken !== undefined) payload.ath = await sha256(request.accessToken);
  if (request.nonce !== undefined) payload.nonce = request.nonce;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: key.publicJwk })
    .sign(key.privateKey);
}

/**
 * 0.3: a delegated key and the delegation that vouches for it (5.2). The key
 * is a non-extractable P-256 pair, like a DPoP key, used for one User ID
 * only; the delegation is signed by our `jwks_uri` key and names nothing
 * about the User or the Company.
 */
export type Delegated = {
  readonly key: DpopKey;
  readonly delegation: string;
  /** The delegation's `exp`, epoch seconds: no Session JWT is signed after it (5.2). */
  readonly expiresAt: number;
};

/** A delegation's lifetime: a few hours, from an `iat` rounded down to the hour (Guides, "Signing in and Sessions"). */
const DELEGATION_HOURS = 4;
/** Get a new delegation this long before the current one expires, so a slow request never carries an expired one. */
const DELEGATION_RENEW_SECONDS = 10 * 60;

export async function delegate(signing: SigningKey, clientId: string, key: DpopKey): Promise<Delegated> {
  // Rounded, so delegations issued in the same hour can't be matched by their times.
  const issuedAt = Math.floor(now() / 3600) * 3600;
  const expiresAt = issuedAt + DELEGATION_HOURS * 3600;
  const delegation = await new SignJWT({ cnf: { jwk: key.publicJwk } })
    .setProtectedHeader({ alg: "ES256", typ: "pap-delegation+jwt", kid: signing.kid })
    .setIssuer(clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti(randomId())
    .sign(signing.privateKey);
  return { key, delegation, expiresAt };
}

/** Whether a delegation can still sign, with time to spare. */
export function delegationUsable(delegated: Delegated): boolean {
  return delegated.expiresAt - DELEGATION_RENEW_SECONDS > now();
}

/**
 * 0.3: the Session JWT for one request (5.2): `typ` poppy-session+jwt,
 * signed with the delegated key, its delegation in `pap_dlg`, and claims
 * naming the Session, the User and the request. `ath` only with an access
 * token. A fresh one for every request and retry.
 */
export async function sessionJwt(
  delegated: Delegated,
  claims: {
    readonly clientId: string;
    readonly issuer: string;
    readonly sid: string;
    readonly userId: string;
    readonly agentId?: string;
    readonly method: string;
    readonly url: string;
    readonly accessToken?: string;
  }
): Promise<string> {
  // 5.2: "MUST NOT sign a Session JWT after its delegation's exp."
  if (delegated.expiresAt <= now()) throw new Error("The delegation has expired");
  const payload: Record<string, string | number> = {
    iss: claims.clientId,
    aud: claims.issuer,
    sid: claims.sid,
    sub: claims.userId,
    htm: claims.method.toUpperCase(),
    htu: htu(claims.url),
    iat: now(),
    jti: randomId()
  };
  if (claims.agentId !== undefined) payload.agent_id = claims.agentId;
  if (claims.accessToken !== undefined) payload.ath = await sha256(claims.accessToken);
  return new SignJWT(payload)
    .setProtectedHeader({ typ: "poppy-session+jwt", alg: "ES256", kid: delegated.key.thumbprint, pap_dlg: delegated.delegation })
    .sign(delegated.key.privateKey);
}
