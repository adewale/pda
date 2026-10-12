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
 * Assertions are short-lived (spec 4.2, whose example uses one minute; spec 5
 * caps a browser assertion at 60 seconds; the Guides ask Companies to reject
 * long lifetimes without giving a number, spec-issues S2). One minute for all.
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

/** The JWT bearer grant's assertion that starts or renews a Session (spec 4.2). */
export function sessionAssertion(
  key: SigningKey,
  clientId: string,
  userId: string,
  tokenEndpoint: string
) {
  const issuedAt = now();
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
    .setIssuer(clientId)
    .setSubject(userId)
    // A single string, so the assertion can't be used at another Company.
    .setAudience(tokenEndpoint)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ASSERTION_SECONDS)
    .setJti(randomId())
    .sign(key.privateKey);
}

/** The browser assertion that joins our browser to a Session (spec 5). */
export function browserAssertion(
  key: SigningKey,
  claims: {
    clientId: string;
    userId: string;
    endpoint: string;
    sessionId: string;
    returnTo: string;
  }
) {
  const issuedAt = now();
  return new SignJWT({ session_id: claims.sessionId, return_to: claims.returnTo })
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "poppy-browser+jwt" })
    .setIssuer(claims.clientId)
    .setSubject(claims.userId)
    .setAudience(claims.endpoint)
    .setIssuedAt(issuedAt)
    // No more than 60 seconds after `iat`.
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
