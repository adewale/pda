import type { Provider } from "./config";

/** A request without a valid session. */
export class AuthError extends Error {
  override name = "AuthError";
}

export type Identity = {
  readonly provider: Provider;
  /** The provider's stable user id: Google's `sub`, GitHub's numeric id. */
  readonly sub: string;
  readonly email: string | null;
};

type SessionPayload = Identity & {
  /** Expiry, in seconds since the epoch. */
  readonly exp: number;
};

/** `__Host-` pins the cookie to this origin: Secure, Path=/, no Domain. */
export const SESSION_COOKIE = "__Host-session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** `<payload>.<signature>`, both base64url; HMAC-SHA256 over the payload. */
export async function sign(value: unknown, secret: string): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(body)
  );
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

/** The signed value, or null if the signature does not match. */
export async function unsign<T>(token: string, secret: string): Promise<T | null> {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromBase64url(signature),
      encoder.encode(body)
    );
    if (!valid) return null;
    return JSON.parse(new TextDecoder().decode(fromBase64url(body))) as T;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

/** A `Set-Cookie` value: HttpOnly, Secure, SameSite=Lax. */
export function cookie(
  name: string,
  value: string,
  options: { maxAge: number; path?: string }
): string {
  return [
    `${name}=${value}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

/** The session cookie for a freshly signed-in person. */
export async function createSession(
  identity: Identity,
  secret: string,
  now = Date.now()
): Promise<string> {
  const payload: SessionPayload = {
    provider: identity.provider,
    sub: identity.sub,
    email: identity.email,
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS
  };
  return cookie(SESSION_COOKIE, await sign(payload, secret), {
    maxAge: SESSION_TTL_SECONDS
  });
}

export function clearSession(): string {
  return cookie(SESSION_COOKIE, "", { maxAge: 0 });
}

/** The signed-in person, from the session cookie; anything else is an `AuthError`. */
export async function verifySession(
  request: Request,
  secret: string
): Promise<Identity> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) throw new AuthError("No session cookie");
  const payload = await unsign<SessionPayload>(token, secret);
  if (!payload) throw new AuthError("Bad session signature");
  if (
    (payload.provider !== "google" && payload.provider !== "github") ||
    typeof payload.sub !== "string" ||
    payload.sub === "" ||
    typeof payload.exp !== "number"
  ) {
    throw new AuthError("Malformed session");
  }
  if (payload.exp * 1000 <= Date.now()) throw new AuthError("Session expired");
  return {
    provider: payload.provider,
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null
  };
}

/** The person's Durable Object name: hex SHA-256 of `<provider>:<sub>`. */
export async function agentNameFor(
  identity: Pick<Identity, "provider" | "sub">
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${identity.provider}:${identity.sub}`)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export { base64url };
