/**
 * Encodings the fake providers share: base64url, PKCE's S256, and codes that
 * carry their grant. Web APIs only, since the fakes run in Node (the Vitest
 * config's outbound service) as well as in workerd.
 */
import { base64url, fromBase64url } from "../src/base64url.ts";

export { base64url, fromBase64url };

/** PKCE S256 (RFC 7636 §4.2): base64url(SHA-256(verifier)). */
export async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** A code that carries its grant: `prefix` + base64url(JSON). */
export function encodeGrant(prefix: string, grant: unknown): string {
  return prefix + base64url(new TextEncoder().encode(JSON.stringify(grant)));
}

/** The grant `encodeGrant` put in a code, or null for anything else. */
export function decodeGrant<T>(prefix: string, code: unknown): T | null {
  if (typeof code !== "string" || !code.startsWith(prefix)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(code.slice(prefix.length)))) as T;
  } catch {
    return null;
  }
}
