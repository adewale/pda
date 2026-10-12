/**
 * Web Push, built here with WebCrypto and `jose`, no Node-only library:
 *
 * - the message to a browser's push service (RFC 8030), only to a host of a
 *   known push service (`pushEndpointProblem`), never an arbitrary URL;
 * - VAPID (RFC 8292): an ES256 JWT for the push service's origin, signed
 *   with the deployment's `WEB_PUSH_VAPID_JWK`, whose public half the page
 *   subscribes with;
 * - the payload encrypted for that one browser (RFC 8291, `aes128gcm` from
 *   RFC 8188), so the push service carries it without reading it.
 *
 * A notification carries a short title and body and nothing else. Without
 * the secret, Web Push is unavailable and the page hides the option.
 */
import { importJWK, SignJWT, type JWK } from "jose";
import { base64url, fromBase64url } from "./base64url";
import { reportError } from "./log";
import { readPrivacyContact, type PrivacyEnv } from "./privacy";

// ---------------------------------------------------------------- Push services

/**
 * Hosts of the push services browsers use, from each vendor's documentation:
 * Google's FCM (Chrome, Edge on Android, Opera), Mozilla's autopush
 * (Firefox), Apple's (Safari, and web apps on iOS and iPadOS), and
 * Microsoft's WNS (Edge on Windows).
 */
const PUSH_HOSTS: readonly string[] = ["fcm.googleapis.com", "web.push.apple.com"];
const PUSH_HOST_SUFFIXES: readonly string[] = [".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];

/** Longest endpoint taken: real ones are a few hundred characters. */
const MAX_ENDPOINT = 2048;

/** Why `endpoint` isn't a push service we send to, or null when it is one. */
export function pushEndpointProblem(endpoint: unknown): string | null {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT || !URL.canParse(endpoint)) {
    return "The subscription's endpoint isn't a URL";
  }
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return "A push endpoint is https on the standard port";
  const host = url.hostname.toLowerCase();
  if (PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) return null;
  return `${host} isn't a push service this agent sends to (Google, Mozilla, Apple or Microsoft)`;
}

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it, checked. */
export type Subscription = { readonly endpoint: string; readonly p256dh: string; readonly auth: string };

/** The subscription in `body`, or why it isn't one. */
export function parseSubscription(body: unknown): Subscription | string {
  if (typeof body !== "object" || body === null) return "Send the browser's push subscription as JSON";
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const problem = pushEndpointProblem(endpoint);
  if (problem) return problem;
  const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys?.auth === "string" ? keys.auth : "";
  let point: Uint8Array;
  let secret: Uint8Array;
  try {
    point = fromBase64url(p256dh);
    secret = fromBase64url(auth);
  } catch {
    return "The subscription's keys aren't base64url";
  }
  if (point.length !== 65 || point[0] !== 4) return "The subscription's p256dh isn't an uncompressed P-256 public key";
  if (secret.length !== 16) return "The subscription's auth secret isn't 16 bytes";
  return { endpoint: endpoint as string, p256dh: base64url(point), auth: base64url(secret) };
}

// ---------------------------------------------------------------- VAPID (RFC 8292)

export type VapidKey = {
  readonly privateKey: CryptoKey;
  /** The uncompressed public key, base64url: `applicationServerKey` and the `k` parameter. */
  readonly publicKey: string;
};

export type PushEnv = PrivacyEnv & { readonly WEB_PUSH_VAPID_JWK?: unknown };

const vapidKeys = new Map<string, Promise<VapidKey | null>>();

/**
 * The deployment's VAPID key from `WEB_PUSH_VAPID_JWK` (a P-256 private
 * JWK), or null when it isn't set or isn't one: Web Push is then off.
 */
export function readVapidKey(env: PushEnv): Promise<VapidKey | null> {
  const raw = typeof env.WEB_PUSH_VAPID_JWK === "string" ? env.WEB_PUSH_VAPID_JWK.trim() : "";
  if (!raw) return Promise.resolve(null);
  let found = vapidKeys.get(raw);
  if (!found) {
    found = (async () => {
      try {
        const jwk = JSON.parse(raw) as JWK;
        if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
          throw new Error("not a P-256 private JWK");
        }
        const x = fromBase64url(jwk.x);
        const y = fromBase64url(jwk.y);
        if (x.length !== 32 || y.length !== 32) throw new Error("not a P-256 point");
        const privateKey = (await importJWK({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, "ES256")) as CryptoKey;
        return { privateKey, publicKey: base64url(Uint8Array.of(4, ...x, ...y)) };
      } catch (error) {
        // Web Push is off; the event says why (its message names the problem, never the key).
        // A JSON parse error quotes its input, which is the private key: name the problem only.
        reportError(error instanceof SyntaxError ? new Error("not JSON") : error, { source: "web_push.vapid_key", code: "vapid_key_unusable" });
        return null;
      }
    })();
    vapidKeys.set(raw, found);
  }
  return found;
}

/** Who to contact about this sender (RFC 8292 §2.1): the deployment's privacy contact, as `mailto:` or an https URL. */
export function vapidSubject(env: PushEnv): string | undefined {
  try {
    return readPrivacyContact(env).href;
  } catch {
    return undefined;
  }
}

/** How long a VAPID JWT is good for: 12 hours, under RFC 8292's 24. */
export const VAPID_LIFETIME_SECONDS = 12 * 3600;

/** The `Authorization` header for one push service: `vapid t=<JWT>, k=<public key>`. */
export async function vapidAuthorization(endpoint: string, key: VapidKey, subject: string | undefined, now = Date.now()): Promise<string> {
  const jwt = await new SignJWT({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS, ...(subject ? { sub: subject } : {}) })
    .setProtectedHeader({ typ: "JWT", alg: "ES256" })
    .sign(key.privateKey);
  return `vapid t=${jwt}, k=${key.publicKey}`;
}

// ---------------------------------------------------------------- Message encryption (RFC 8291)

/** The record size we declare; one record holds the whole message. */
const RECORD_SIZE = 4096;
/** The most plaintext one record carries: the record size less the padding delimiter and the GCM tag, and room for the header in the push service's 4096-byte limit. */
export const MAX_PLAINTEXT = RECORD_SIZE - 86 - 1 - 16;

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", concat(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, concat(data)));
}

/** HKDF (RFC 5869) with one block of output, which is all RFC 8291 needs. */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, Uint8Array.of(1)))).slice(0, length);
}

/** Fixed inputs, for RFC 8291's test vector; production draws both at random. */
export type EncryptionFixtures = { readonly senderPrivate?: JsonWebKey; readonly salt?: Uint8Array };

/**
 * `plaintext` encrypted for one subscription (RFC 8291 §3–4): an ECDH secret
 * between a new sender key and the browser's `p256dh`, combined with its
 * `auth` secret, keys AES-128-GCM over one record; the header carries the
 * salt, the record size and the sender's public key.
 */
export async function encryptPayload(plaintext: Uint8Array, subscription: Pick<Subscription, "p256dh" | "auth">, fixtures: EncryptionFixtures = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`A push message is at most ${MAX_PLAINTEXT} bytes`);
  const uaPublic = fromBase64url(subscription.p256dh);
  const authSecret = fromBase64url(subscription.auth);
  const sender = fixtures.senderPrivate
    ? {
        privateKey: await crypto.subtle.importKey("jwk", fixtures.senderPrivate, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
        publicKey: await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: fixtures.senderPrivate.x!, y: fixtures.senderPrivate.y! }, { name: "ECDH", namedCurve: "P-256" }, true, [])
      }
    : ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer);
  const browserKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: browserKey }, sender.privateKey, 256));
  // §3.4: the auth secret and both public keys go into the input keying material.
  const ikm = await hkdf(authSecret, ecdhSecret, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixtures.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", concat(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  // One record, the last: the plaintext, then the delimiter 0x02, no padding.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: concat(nonce) }, key, concat(plaintext, Uint8Array.of(2))));
  const header = concat(salt, Uint8Array.of(0, 0, RECORD_SIZE >> 8, RECORD_SIZE & 0xff), Uint8Array.of(asPublic.length), asPublic);
  return concat(header, ciphertext);
}

// ---------------------------------------------------------------- Sending

/** What a notification says: a short title and body, and a tag so a newer one replaces an older one. */
export type PushMessage = { readonly title: string; readonly body: string; readonly tag: string };

export type PushFetcher = (request: Request) => Promise<Response>;

/** How long a push service keeps a message for a device that's offline: a day. */
export const PUSH_TTL_SECONDS = 86_400;

/**
 * Send one notification to one subscription; the push service's status.
 * 201 means accepted; 404 and 410 mean the subscription is gone.
 */
export async function sendPush(fetcher: PushFetcher, subscription: Subscription, message: PushMessage, key: VapidKey, subject: string | undefined, now = Date.now()): Promise<number> {
  const problem = pushEndpointProblem(subscription.endpoint);
  if (problem) throw new Error(problem);
  const payload = encoder.encode(JSON.stringify({ title: message.title.slice(0, 100), body: message.body.slice(0, 300), tag: message.tag.slice(0, 100) }));
  const body = await encryptPayload(payload, subscription);
  const response = await fetcher(
    new Request(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, key, subject, now),
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: "normal",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream"
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000)
    })
  );
  await response.body?.cancel();
  return response.status;
}

// ---------------------------------------------------------------- The person's devices

/** Most devices one agent notifies; a new one past this replaces the oldest. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

const SCHEMA = `CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_status INTEGER,
  last_sent_at INTEGER
)`;

/** The browsers that turned notifications on, in the person's own agent. */
export class PushSubscriptions {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    sql.exec(SCHEMA);
    this.#sql = sql;
  }

  all(): Subscription[] {
    return this.#sql.exec("SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at").toArray() as Subscription[];
  }

  count(): number {
    return Number(this.#sql.exec("SELECT COUNT(*) AS n FROM push_subscriptions").toArray()[0]?.n ?? 0);
  }

  /** Keep one; the same endpoint again replaces its keys. Past the cap, the oldest goes. */
  add(subscription: Subscription, now = Date.now()): void {
    this.#sql.exec(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
      now
    );
    this.#sql.exec(
      "DELETE FROM push_subscriptions WHERE endpoint NOT IN (SELECT endpoint FROM push_subscriptions ORDER BY created_at DESC, rowid DESC LIMIT ?)",
      MAX_PUSH_SUBSCRIPTIONS
    );
  }

  remove(endpoint: string): boolean {
    const found = this.#sql.exec("SELECT endpoint FROM push_subscriptions WHERE endpoint = ?", endpoint).toArray().length > 0;
    if (found) this.#sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
    return found;
  }

  sent(endpoint: string, status: number, now = Date.now()): void {
    this.#sql.exec("UPDATE push_subscriptions SET last_status = ?, last_sent_at = ? WHERE endpoint = ?", status, now, endpoint);
  }
}
