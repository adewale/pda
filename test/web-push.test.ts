/**
 * Web Push (src/web-push.ts): RFC 8291's message encryption against its own
 * example, the VAPID JWT (RFC 8292), the push-service allowlist, the
 * subscription routes, and notifications for reminders and tasks through
 * the test agent's fake push service (`pushServe`, `pushRequests` in
 * worker.ts). Nothing reaches the network.
 */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { base64url, fromBase64url } from "../src/base64url";
import { encryptPayload, MAX_PUSH_SUBSCRIPTIONS, pushEndpointProblem, readVapidKey, vapidAuthorization, VAPID_LIFETIME_SECONDS } from "../src/web-push";
import { agent, fetchWorker, ORIGIN, sessionCookie, person } from "./agent-helpers";

type Stub = Awaited<ReturnType<typeof agent>>["stub"];

/** RFC 8291 §5 and Appendix A, with the whitespace the RFC adds for layout removed. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
};

/** A P-256 point's JWK coordinates, from its uncompressed form. */
function coordinates(uncompressed: string): { x: string; y: string } {
  const point = fromBase64url(uncompressed);
  return { x: base64url(point.slice(1, 33)), y: base64url(point.slice(33, 65)) };
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new Uint8Array(data)));
}

/** The browser's side, written from RFC 8291 §3 and RFC 8188 apart from the code under test: decrypt one message. */
async function decrypt(message: Uint8Array, receiver: { privateKey: CryptoKey; publicKey: Uint8Array }, authSecret: Uint8Array): Promise<string> {
  const salt = message.slice(0, 16);
  const recordSize = new DataView(message.buffer, message.byteOffset + 16, 4).getUint32(0);
  const idLength = message[20]!;
  const senderPublic = message.slice(21, 21 + idLength);
  const ciphertext = message.slice(21 + idLength);
  expect(recordSize).toBe(4096);
  const sender = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, receiver.privateKey, 256));
  const text = (value: string) => new TextEncoder().encode(value);
  const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));
  const ikm = await hmac(await hmac(authSecret, shared), join(text("WebPush: info\0"), receiver.publicKey, senderPublic, Uint8Array.of(1)));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, join(text("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, join(text("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  // The last record ends with 0x02, then any zero padding.
  let end = record.length - 1;
  while (record[end] === 0) end--;
  expect(record[end]).toBe(2);
  return new TextDecoder().decode(record.slice(0, end));
}

/** A browser's push subscription, with its private key so the test can read what was sent. */
async function browser(endpoint: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: { endpoint, expirationTime: null, keys: { p256dh: base64url(publicKey), auth: base64url(auth) } },
    read: (body: string) => decrypt(fromBase64url(body), { privateKey: pair.privateKey, publicKey }, auth)
  };
}

function api(cookie: string, path: string, init: RequestInit = {}, overrides: Partial<Env> = {}) {
  return fetchWorker(new Request(`${ORIGIN}${path}`, { ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) } }), overrides);
}

function subscribe(cookie: string, subscription: unknown, origin = ORIGIN) {
  return api(cookie, "/api/push/subscription", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(subscription) });
}

async function endpoints(stub: Stub): Promise<string[]> {
  return (JSON.parse(await stub.poppySql("SELECT endpoint FROM push_subscriptions ORDER BY created_at, rowid")) as { endpoint: string }[]).map((row) => row.endpoint);
}

describe("message encryption (RFC 8291)", () => {
  it("encrypts RFC 8291's example to the exact message in its section 5, from the keys and salt in Appendix A", async () => {
    const message = await encryptPayload(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.authSecret },
      { senderPrivate: { kty: "EC", crv: "P-256", d: RFC.asPrivate, ...coordinates(RFC.asPublic) }, salt: fromBase64url(RFC.salt) }
    );
    expect(base64url(message.slice(0, 86))).toBe(RFC.header);
    expect(base64url(message.slice(86))).toBe(RFC.ciphertext);
    expect(base64url(message)).toBe(RFC.message);
    // And the receiver in the example reads it back.
    const receiver = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: RFC.uaPrivate, ...coordinates(RFC.uaPublic) }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    expect(await decrypt(fromBase64url(RFC.message), { privateKey: receiver, publicKey: fromBase64url(RFC.uaPublic) }, fromBase64url(RFC.authSecret))).toBe(RFC.plaintext);
  });

  it("uses a new sender key and salt for every message", async () => {
    const device = await browser("https://fcm.googleapis.com/fcm/send/abc");
    const plaintext = new TextEncoder().encode("Reminder");
    const a = await encryptPayload(plaintext, device.subscription.keys);
    const b = await encryptPayload(plaintext, device.subscription.keys);
    expect(base64url(a.slice(0, 16))).not.toBe(base64url(b.slice(0, 16)));
    expect(base64url(a.slice(21, 86))).not.toBe(base64url(b.slice(21, 86)));
    expect(await device.read(base64url(a))).toBe("Reminder");
    expect(await device.read(base64url(b))).toBe("Reminder");
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs an ES256 JWT for the push service's origin, at most 24 hours long, naming the deployment's contact, with the key the page subscribes with", async () => {
    const key = (await readVapidKey(env))!;
    expect(key).not.toBeNull();
    const now = Date.UTC(2026, 9, 12, 12);
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc:def", key, "mailto:privacy@example.com", now);
    const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, jwt, k] = match!;
    expect(k).toBe(key.publicKey);
    expect(fromBase64url(k!)).toHaveLength(65);
    expect(decodeProtectedHeader(jwt!)).toEqual({ typ: "JWT", alg: "ES256" });
    const verifier = await importJWK({ kty: "EC", crv: "P-256", ...coordinates(k!) }, "ES256");
    const { payload } = await jwtVerify(jwt!, verifier, { currentDate: new Date(now) });
    expect(payload).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + VAPID_LIFETIME_SECONDS, sub: "mailto:privacy@example.com" });
    expect(VAPID_LIFETIME_SECONDS).toBeLessThanOrEqual(24 * 3600);
  });

  it("serves the public key to a signed-in page, and null when the deployment has no VAPID key", async () => {
    const cookie = await sessionCookie(person());
    expect((await fetchWorker(new Request(`${ORIGIN}/api/push/key`))).status).toBe(401);
    expect(await (await api(cookie, "/api/push/key")).json()).toEqual({ publicKey: (await readVapidKey(env))!.publicKey });
    expect(await (await api(cookie, "/api/push/key", {}, { WEB_PUSH_VAPID_JWK: undefined })).json()).toEqual({ publicKey: null });
    expect(await (await api(cookie, "/api/push/key", {}, { WEB_PUSH_VAPID_JWK: "not a key" })).json()).toEqual({ publicKey: null });
    const device = await browser("https://fcm.googleapis.com/fcm/send/nokey");
    const refused = await fetchWorker(
      new Request(`${ORIGIN}/api/push/subscription`, { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN }, body: JSON.stringify(device.subscription) }),
      { WEB_PUSH_VAPID_JWK: undefined }
    );
    expect(refused.status).toBe(404);
  });
});

describe("push services", () => {
  it("sends only to Google's, Mozilla's, Apple's and Microsoft's push services, over https on the standard port", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/dXk2:APA91b",
      "https://fcm.googleapis.com/wp/dXk2",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://api.push.apple.com/3/device/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA"
    ]) {
      expect(pushEndpointProblem(endpoint), endpoint).toBeNull();
    }
    for (const endpoint of [
      "https://evil.example/collect",
      "https://fcm.googleapis.com.evil.example/fcm/send/x",
      "https://evilfcm.googleapis.com/x",
      "https://push.services.mozilla.com.evil.example/",
      "https://notify.windows.com/",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      // Credentials in the URL (split, so the template check doesn't read it as an email address).
      "https://user:pass" + "@fcm.googleapis.com/fcm/send/x",
      "https://localhost/push",
      "https://127.0.0.1/push",
      "javascript:alert(1)",
      "",
      `https://fcm.googleapis.com/${"x".repeat(2100)}`
    ]) {
      expect(pushEndpointProblem(endpoint), endpoint).not.toBeNull();
    }
  });
});

describe("subscriptions", () => {
  it("keeps and forgets a browser's subscription, signed in and from this origin only, for a known push service only", async () => {
    const identity = person();
    const { stub, cookie } = await agent(identity);
    const device = await browser("https://fcm.googleapis.com/fcm/send/device-1");
    expect((await fetchWorker(new Request(`${ORIGIN}/api/push/subscription`, { method: "POST", headers: { Origin: ORIGIN }, body: JSON.stringify(device.subscription) }))).status).toBe(401);
    expect((await subscribe(cookie, device.subscription, "https://evil.example")).status).toBe(403);
    expect((await api(cookie, "/api/push/subscription", { method: "POST", body: JSON.stringify(device.subscription) })).status).toBe(403);
    const elsewhere = await subscribe(cookie, { ...device.subscription, endpoint: "https://evil.example/push" });
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.json()).toEqual({ error: "evil.example isn't a push service this agent sends to (Google, Mozilla, Apple or Microsoft)" });
    expect((await subscribe(cookie, { ...device.subscription, keys: { p256dh: "AAAA", auth: device.subscription.keys.auth } })).status).toBe(400);
    expect((await subscribe(cookie, { ...device.subscription, keys: { p256dh: device.subscription.keys.p256dh, auth: "AAAA" } })).status).toBe(400);
    expect(await endpoints(stub)).toEqual([]);

    expect((await subscribe(cookie, device.subscription)).status).toBe(201);
    // The same browser again: one subscription.
    expect((await subscribe(cookie, device.subscription)).status).toBe(201);
    expect(await endpoints(stub)).toEqual([device.subscription.endpoint]);
    // Someone else's agent doesn't have it.
    const other = await agent(person());
    expect(await endpoints(other.stub)).toEqual([]);
    const forget = (who: string, origin = ORIGIN) =>
      api(who, "/api/push/subscription", { method: "DELETE", headers: { Origin: origin }, body: JSON.stringify({ endpoint: device.subscription.endpoint }) });
    expect((await forget(other.cookie)).status).toBe(404);
    expect((await forget(cookie, "https://evil.example")).status).toBe(403);
    expect((await forget(cookie)).status).toBe(204);
    expect((await forget(cookie)).status).toBe(404);
    expect(await endpoints(stub)).toEqual([]);
  });

  it(`keeps at most ${MAX_PUSH_SUBSCRIPTIONS} devices, dropping the oldest`, async () => {
    const { stub, cookie } = await agent();
    const devices = [];
    for (let i = 0; i <= MAX_PUSH_SUBSCRIPTIONS; i++) devices.push(await browser(`https://updates.push.services.mozilla.com/wpush/v2/device-${i}`));
    for (const device of devices) expect((await subscribe(cookie, device.subscription)).status).toBe(201);
    expect(await endpoints(stub)).toEqual(devices.slice(1).map((device) => device.subscription.endpoint));
  });
});

describe("notifications", () => {
  it("sends a due reminder to each subscribed device once, encrypted for it, with only a title and the reminder's words; a 410 deletes that subscription", async () => {
    const identity = person();
    const { stub, cookie } = await agent(identity);
    const phone = await browser("https://web.push.apple.com/phone");
    const laptop = await browser("https://fcm.googleapis.com/fcm/send/laptop");
    for (const device of [phone, laptop]) expect((await subscribe(cookie, device.subscription)).status).toBe(201);
    const noon = Date.UTC(2026, 9, 12, 12);
    await stub.setClock(noon);
    await stub.scheduleCreate({ kind: "reminder", text: "Call the bank", when: { in: "PT1H" }, timeZone: "Europe/London" });
    await stub.scheduleAdvance(noon + 3_600_000);
    await runDurableObjectAlarm(stub);

    const sent = await stub.pushRequests();
    expect(sent.map((request) => request.url).sort()).toEqual([laptop.subscription.endpoint, phone.subscription.endpoint].sort());
    for (const request of sent) {
      expect(request.headers).toMatchObject({ ttl: "86400", urgency: "normal", "content-encoding": "aes128gcm", "content-type": "application/octet-stream" });
      expect(request.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
      expect(request.headers).not.toHaveProperty("cookie");
      const device = request.url === phone.subscription.endpoint ? phone : laptop;
      expect(JSON.parse(await device.read(request.body))).toEqual({ title: "Reminder", body: "Call the bank", tag: expect.stringMatching(/^reminder-sch_/) });
    }

    // The phone's subscription has gone: the next reminder deletes it, and still reaches the laptop.
    await stub.pushServe(phone.subscription.endpoint, 410);
    await stub.scheduleCreate({ kind: "reminder", text: "Bins out", when: { in: "PT2H" }, timeZone: "Europe/London" });
    await stub.scheduleAdvance(noon + 3 * 3_600_000);
    await runDurableObjectAlarm(stub);
    expect((await stub.pushRequests()).slice(2).map((request) => request.url).sort()).toEqual([laptop.subscription.endpoint, phone.subscription.endpoint].sort());
    expect(await endpoints(stub)).toEqual([laptop.subscription.endpoint]);
  });

  it("says a scheduled task ran, in the User's words, and nothing else", async () => {
    const { stub, cookie } = await agent();
    const device = await browser("https://fcm.googleapis.com/fcm/send/task");
    expect((await subscribe(cookie, device.subscription)).status).toBe(201);
    const noon = Date.UTC(2026, 9, 12, 12);
    await stub.setClock(noon);
    await stub.scheduleCreate({ kind: "task", text: "Check whether my print order has shipped", when: { in: "PT1H" }, timeZone: "UTC" });
    await stub.scheduleAdvance(noon + 3_600_000);
    await runDurableObjectAlarm(stub);
    await stub.scheduleSettled();
    const [request] = await stub.pushRequests();
    expect(JSON.parse(await device.read(request!.body))).toEqual({ title: "A scheduled task ran", body: "Check whether my print order has shipped", tag: expect.stringMatching(/^task-sch_/) });
  });
});
