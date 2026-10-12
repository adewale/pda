import { env } from "cloudflare:workers";
import {
  base64url,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK
} from "jose";
import { describe, expect, it } from "vitest";
import {
  basisOf,
  CLOCK_HEADER,
  hostsFor,
  isViolation,
  levelOfCheck,
  VIOLATION_IDS,
  VIOLATIONS,
  violationId,
  type MockCompany,
  type MockConfig,
  type ViolationId
} from "./mock-company";
import apisSource from "./mock-company/apis.ts?raw";
import authSource from "./mock-company/auth.ts?raw";
import conversationsSource from "./mock-company/conversations.ts?raw";
import coreSource from "./mock-company/core.ts?raw";
import indexSource from "./mock-company/index.ts?raw";
import operationsSource from "./mock-company/operations.ts?raw";
import webSource from "./mock-company/web.ts?raw";

/**
 * The mock Company itself, driven by hand-made requests (not the Personal
 * Agent client), so a broken mock shows up here first. `TAMPERS` proves
 * every check the mock makes still fires: each row breaks one thing in an
 * otherwise correct request and expects exactly that violation.
 */

const mocks = (env as unknown as { MOCK_COMPANY: DurableObjectNamespace<MockCompany> }).MOCK_COMPANY;
const CLIENT_ID = "https://agent.test/poppy/client.json";
const REDIRECT_URI = "https://agent.test/poppy/callback";
const USER_ID = "usr_Q7c1vKx9TzLw3NdR5mHa2B";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

function company() {
  const id = `c${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const stub = mocks.getByName(id);
  const hosts = hostsFor(id);
  const call = (url: string, init?: RequestInit) => stub.fetch(new Request(url, { redirect: "manual", ...init }));
  return { id, stub, hosts, call };
}

type C = ReturnType<typeof company>;

function jti(): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(16)));
}

function seconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** `iat` now and `exp` that many seconds later. */
function lifetime(span: number) {
  const iat = seconds();
  return { iat, exp: iat + span };
}

async function agentKey() {
  const [first] = JSON.parse(env.POPPY_SIGNING_JWKS) as JWK[];
  return { kid: first!.kid!, key: (await importJWK(first!, "ES256")) as CryptoKey };
}

/** Changes to a JWT: header and claims merged over the correct ones (undefined removes), or another key. */
type JwtTamper = {
  readonly header?: Record<string, unknown>;
  readonly claims?: Record<string, unknown>;
  readonly key?: CryptoKey | Uint8Array;
};

function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey | Uint8Array) {
  return new SignJWT(defined(claims)).setProtectedHeader(defined(header) as { alg: string }).sign(key);
}

/** A JWT signed with our published key, as our client signs its assertions. */
async function agentJwt(claims: Record<string, unknown>, tamper: JwtTamper = {}) {
  const { kid, key } = await agentKey();
  return signJwt({ alg: "ES256", typ: "JWT", kid, ...tamper.header }, { ...claims, ...tamper.claims }, tamper.key ?? key);
}

/** A client assertion (RFC 7523) for `aud`. */
function clientAssertion(aud: string, tamper: JwtTamper = {}) {
  const now = seconds();
  return agentJwt({ iss: CLIENT_ID, sub: CLIENT_ID, aud, iat: now, exp: now + 60, jti: jti() }, tamper);
}

/** A Session assertion (4.2) for the token endpoint. */
function sessionAssertion(c: C, tamper: JwtTamper = {}) {
  const now = seconds();
  return agentJwt({ iss: CLIENT_ID, sub: USER_ID, aud: c.hosts.tokenEndpoint, iat: now, exp: now + 60, jti: jti() }, tamper);
}

/** The old helper's shape, for the strict-assertion cases below. */
function assertion(aud: string, sub = CLIENT_ID, extra: Record<string, unknown> = {}, shape: { typ?: string | null; kid?: string | null; lifetime?: number } = {}) {
  const now = seconds();
  return agentJwt(
    { iss: CLIENT_ID, sub, aud, iat: now, exp: now + (shape.lifetime ?? 60), jti: jti(), ...extra },
    {
      header: {
        ...(shape.typ !== undefined ? { typ: shape.typ ?? undefined } : {}),
        ...(shape.kid !== undefined ? { kid: shape.kid ?? undefined } : {})
      }
    }
  );
}

async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, jkt: await calculateJwkThumbprint(jwk) };
}

type Key = Awaited<ReturnType<typeof dpopKey>>;

async function hash(text: string): Promise<string> {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** A DPoP proof (RFC 9449) for one request, optionally tampered with. */
async function proof(key: Key, method: string, url: string, accessToken?: string, tamper: JwtTamper & { nonce?: string } = {}) {
  const claims: Record<string, unknown> = { htm: method, htu: url.split("?")[0], iat: seconds(), jti: jti() };
  if (accessToken) claims.ath = await hash(accessToken);
  if (tamper.nonce) claims.nonce = tamper.nonce;
  return signJwt(
    { alg: "ES256", typ: "dpop+jwt", jwk: key.jwk, ...tamper.header },
    { ...claims, ...tamper.claims },
    tamper.key ?? key.privateKey
  );
}

type FormOptions = {
  /** The DPoP header: a proof by default, none with null, or this exact value. */
  readonly dpop?: string | null;
  /** The client assertion: correct by default, none with null, or this exact value. */
  readonly client?: string | null;
  readonly clientId?: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
};

/** A form POST to the token, device or revocation endpoint, authenticated as our client. */
async function form(c: C, url: string, fields: Record<string, string>, key: Key | null, options: FormOptions = {}) {
  const client = options.client === undefined ? await clientAssertion(url) : options.client;
  const body = new URLSearchParams({
    ...fields,
    client_id: options.clientId ?? CLIENT_ID,
    ...(client !== null ? { client_assertion_type: ASSERTION_TYPE, client_assertion: client } : {})
  });
  const dpop = options.dpop !== undefined ? options.dpop : key ? await proof(key, "POST", url) : null;
  return c.call(url, {
    method: "POST",
    headers: {
      "Content-Type": options.contentType ?? "application/x-www-form-urlencoded",
      ...(dpop !== null ? { DPoP: dpop } : {}),
      ...options.headers
    },
    body: options.contentType?.includes("json") ? JSON.stringify(Object.fromEntries(body)) : body
  });
}

/** Start a signed-out Session with the JWT bearer grant. */
async function startSession(c: C, key: Key, options: FormOptions & { assertion?: string | null; fields?: Record<string, string> } = {}) {
  const assertion = options.assertion === undefined ? await sessionAssertion(c) : options.assertion;
  return form(
    c,
    c.hosts.tokenEndpoint,
    { grant_type: JWT_BEARER, ...(assertion !== null ? { assertion } : {}), ...options.fields },
    key,
    options
  );
}

type Session = { key: Key; token: string; sessionId: string };

async function signedOut(c: C): Promise<Session> {
  const key = await dpopKey();
  const response = await startSession(c, key);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token: string; session_id: string };
  return { key, token: body.access_token, sessionId: body.session_id };
}

type CallOptions = {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** `Authorization`: `DPoP <token>` by default, none with null, or this exact value. */
  readonly auth?: string | null;
  /** The DPoP header: a correct proof by default, none with null, a tampered proof, or this exact value. */
  readonly proof?: string | null | (JwtTamper & { nonce?: string });
};

/** A request to an API, conversation, operations or mediated endpoint with the Session Token. */
async function call(c: C, s: Session, method: string, url: string, options: CallOptions = {}) {
  const auth = options.auth === undefined ? `DPoP ${s.token}` : options.auth;
  const dpop =
    options.proof === null
      ? null
      : typeof options.proof === "string"
        ? options.proof
        : await proof(s.key, method, url, s.token, options.proof ?? {});
  return c.call(url, {
    method,
    headers: {
      ...(auth !== null ? { Authorization: auth } : {}),
      ...(dpop !== null ? { DPoP: dpop } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    },
    ...(options.body !== undefined ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) } : {})
  });
}

/** Mediated Sign-In as Ada: the Session is signed in; returns its new tokens. */
async function signedIn(c: C, scope = "poppy:read poppy:write") {
  const s = await signedOut(c);
  const response = await call(c, s, "POST", c.hosts.mediatedEndpoint, {
    body: { scope, credentials: { email: "ada@example.com", password: "correct horse" } }
  });
  const done = (await response.json()) as { access_token: string; refresh_token: string; session_id: string };
  expect(done.refresh_token).toMatch(/^pat_/);
  return { ...s, token: done.access_token, refreshToken: done.refresh_token };
}

/** Mediated Sign-In as Grace, who gets a one-time code; returns the sign-in id and code. */
async function oneTimeCode(c: C) {
  const s = await signedOut(c);
  const first = (await (
    await call(c, s, "POST", c.hosts.mediatedEndpoint, {
      body: { scope: "poppy:read", credentials: { email: "grace@example.com", password: "battery staple" } }
    })
  ).json()) as { sign_in_id: string };
  return { s, signInId: first.sign_in_id, code: (await c.stub.lastOneTimeCode())! };
}

async function pkce() {
  const verifier = jti() + jti();
  return { verifier, challenge: await hash(verifier) };
}

function authorizeUrl(c: C, params: Record<string, string | undefined>) {
  const url = new URL(c.hosts.authorizationEndpoint);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  return url.href;
}

/** Direct Sign-In up to the code: the test plays the User approving, as `account` if given. */
async function authorizationCode(c: C, account?: string) {
  const s = await signedOut(c);
  const { verifier, challenge } = await pkce();
  const back = new URL(
    await c.stub.approveAuthorization(
      authorizeUrl(c, {
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: "poppy:read",
        state: jti(),
        code_challenge: challenge,
        code_challenge_method: "S256"
      }),
      { approve: true, ...(account ? { account } : {}) }
    )
  );
  return { s, verifier, code: back.searchParams.get("code")! };
}

function exchangeCode(c: C, flow: Awaited<ReturnType<typeof authorizationCode>>, fields: Record<string, string | undefined> = {}) {
  return form(
    c,
    c.hosts.tokenEndpoint,
    defined({
      grant_type: "authorization_code",
      code: flow.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: flow.verifier,
      session_id: flow.s.sessionId,
      ...fields
    }) as Record<string, string>,
    flow.s.key
  );
}

/** Device Sign-In started; `poll` polls the token endpoint once. */
async function deviceFlow(c: C, config: Partial<MockConfig> = {}) {
  await c.stub.configure({ deviceInterval: 1, ...config });
  const s = await signedOut(c);
  const device = (await (await form(c, c.hosts.deviceEndpoint, { scope: "poppy:read" }, null)).json()) as {
    device_code: string;
    user_code: string;
  };
  const poll = (fields: Record<string, string> = { session_id: s.sessionId }) =>
    form(c, c.hosts.tokenEndpoint, { grant_type: DEVICE_CODE, device_code: device.device_code, ...fields }, s.key);
  return { s, device, poll };
}

/** A browser assertion (spec 5) for the Session. */
function browserAssertion(c: C, s: Session, tamper: JwtTamper = {}) {
  const now = seconds();
  return agentJwt(
    {
      iss: CLIENT_ID,
      sub: USER_ID,
      aud: c.hosts.browserSessionEndpoint,
      iat: now,
      exp: now + 60,
      jti: jti(),
      session_id: s.sessionId,
      return_to: `https://${c.hosts.domain}/orders`
    },
    { ...tamper, header: { typ: "poppy-browser+jwt", ...tamper.header } }
  );
}

function joinBrowser(c: C, assertion: string, init: RequestInit = {}, url = c.hosts.browserSessionEndpoint) {
  return c.call(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ assertion }),
    ...init
  });
}

/** Start a conversation with `message` (a correct one by default). */
function converse(c: C, s: Session, message: unknown, extra: Record<string, unknown> = {}) {
  return call(c, s, "POST", c.hosts.conversationsEndpoint, { body: { message, ...extra } });
}

function message(fields: Record<string, unknown> = {}) {
  return defined({ id: `msg_${jti()}`, sender: "agent", text: "Hello", ...fields });
}

async function conversation(c: C, s: Session) {
  return ((await (await converse(c, s, message())).json()) as { conversation_id: string }).conversation_id;
}

/** Signed in with poppy:write and an exchange proposed (Operations extension). */
async function proposed(c: C) {
  const s = await signedIn(c);
  const response = await call(c, s, "POST", `${c.hosts.api}/orders/ord_7Hk2/exchanges`, {
    body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }
  });
  const { operation } = (await response.json()) as { operation: { operation_id: string; revision: number } };
  return { s, operation };
}

function exchange(c: C, s: Session, headers: Record<string, string> = {}, body: unknown = { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }) {
  return call(c, s, "POST", `${c.hosts.api}/orders/ord_7Hk2/exchanges`, { body, headers });
}

/** The first bytes of a JPEG: enough for the print shop, which reads only those. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

/** A `multipart/form-data` body with one part, its Content-Disposition as given. */
function multipart(boundary: string, disposition: string, bytes: Uint8Array = JPEG): Uint8Array<ArrayBuffer> {
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: image/jpeg\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

/** A photo upload to the print shop, with the body and Content-Type as given. */
async function uploadPhoto(c: C, s: Session, body: Uint8Array<ArrayBuffer>, contentType: string) {
  const url = `${c.hosts.api}/photos`;
  return c.call(url, {
    method: "POST",
    headers: { Authorization: `DPoP ${s.token}`, DPoP: await proof(s.key, "POST", url, s.token), "Content-Type": contentType },
    body
  });
}

/** An order of prints of `photoId`, as the print shop's description asks for it. */
function printOrder(photoId: string) {
  return {
    email: "ada@example.com",
    ship_to: { name: "Ada Lovelace", line1: "12 St James's Square", city: "London", postal_code: "SW1Y 4JH", country: "GB" },
    items: [{ photo_id: photoId, copies: 1 }]
  };
}

/** A second Personal Agent, its metadata and JWKS served by the test, optionally broken. */
const OTHER = "https://other.agent.test/poppy/client.json";
const OTHER_JWKS = "https://other.agent.test/poppy/jwks.json";

async function otherClient(
  c: C,
  broken: { metadata?: Record<string, unknown>; raw?: string; status?: number; jwks?: unknown; jwksStatus?: number; kid?: string | null } = {}
) {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const kid = broken.kid === undefined ? "other-1" : broken.kid;
  const jwk = defined({ ...(await exportJWK(publicKey)), kid: kid ?? undefined, alg: "ES256", use: "sig" });
  await c.stub.serveClientDocument(
    OTHER,
    broken.raw ?? {
      client_id: OTHER,
      client_name: "Another agent",
      jwks_uri: OTHER_JWKS,
      redirect_uris: ["https://other.agent.test/poppy/callback"],
      token_endpoint_auth_method: "private_key_jwt",
      ...broken.metadata
    },
    broken.status ?? 200
  );
  await c.stub.serveClientDocument(OTHER_JWKS, broken.jwks ?? { keys: [jwk] }, broken.jwksStatus ?? 200);
  const sign = (claims: Record<string, unknown>) =>
    signJwt({ alg: "ES256", typ: "JWT", kid: kid ?? undefined }, claims, privateKey);
  const now = seconds();
  return {
    clientAssertion: (aud: string) => sign({ iss: OTHER, sub: OTHER, aud, iat: now, exp: now + 60, jti: jti() }),
    sessionAssertion: () => sign({ iss: OTHER, sub: USER_ID, aud: c.hosts.tokenEndpoint, iat: now, exp: now + 60, jti: jti() })
  };
}

/** Start a Session as the other client. */
async function startAsOther(c: C, other: Awaited<ReturnType<typeof otherClient>>, fields: Record<string, string> = {}) {
  return form(c, c.hosts.tokenEndpoint, { grant_type: JWT_BEARER, assertion: await other.sessionAssertion(), ...fields }, await dpopKey(), {
    clientId: OTHER,
    client: await other.clientAssertion(c.hosts.tokenEndpoint)
  });
}

async function hmacKey(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** A key the client never published, to sign something that mustn't verify. */
async function strangerKey(): Promise<CryptoKey> {
  return (await generateKeyPair("ES256")).privateKey;
}

type Tamper = {
  /** The violation this row must record. */
  readonly id: ViolationId;
  /** What was broken, for the test name. */
  readonly what: string;
  readonly config?: Partial<MockConfig>;
  /** The violations recorded, in order, when more than the row's own id is expected. */
  readonly ids?: readonly ViolationId[];
  /** The row's violation exactly, or a pattern for one with random parts. */
  readonly detail?: string | RegExp | ((c: C) => string | RegExp);
  readonly run: (c: C) => Promise<unknown>;
};

const SITE = (c: C) => `https://${c.hosts.domain}`;

/**
 * One row per check in the mock. Each makes a correct request with one thing
 * broken; the test asserts the mock recorded exactly that violation.
 */
const TAMPERS: readonly Tamper[] = [
  // ---- jti ----
  {
    id: "client-assertion.jti-missing",
    what: "a client assertion without jti",
    detail: "[client-assertion.jti-missing] client-assertion: missing jti",
    run: async (c) => startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { claims: { jti: undefined } }) })
  },
  {
    id: "client-assertion.jti-weak",
    what: "a client assertion jti of 64 bits",
    detail: '[client-assertion.jti-weak] client-assertion: jti "abcdefgh" is not 128 random bits of base64url',
    run: async (c) => startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { claims: { jti: "abcdefgh" } }) })
  },
  {
    id: "client-assertion.jti-reused",
    what: "the same client assertion twice",
    detail: /^\[client-assertion\.jti-reused\] client-assertion: reused jti [\w-]{22}$/,
    run: async (c) => {
      const client = await clientAssertion(c.hosts.tokenEndpoint);
      expect((await startSession(c, await dpopKey(), { client })).status).toBe(200);
      return startSession(c, await dpopKey(), { client });
    }
  },
  {
    id: "session-assertion.jti-missing",
    what: "a Session assertion without jti",
    detail: "[session-assertion.jti-missing] session-assertion: missing jti",
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { jti: undefined } }) })
  },
  {
    id: "session-assertion.jti-weak",
    what: "a Session assertion jti of 64 bits",
    detail: '[session-assertion.jti-weak] session-assertion: jti "abcdefgh" is not 128 random bits of base64url',
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { jti: "abcdefgh" } }) })
  },
  {
    id: "session-assertion.jti-reused",
    what: "the same Session assertion twice",
    detail: /^\[session-assertion\.jti-reused\] session-assertion: reused jti [\w-]{22}$/,
    run: async (c) => {
      const assertion = await sessionAssertion(c);
      expect((await startSession(c, await dpopKey(), { assertion })).status).toBe(200);
      return startSession(c, await dpopKey(), { assertion });
    }
  },
  {
    id: "dpop.jti-missing",
    what: "a DPoP proof without jti",
    detail: "[dpop.jti-missing] dpop: missing jti",
    run: async (c) => {
      const key = await dpopKey();
      return startSession(c, key, { dpop: await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { claims: { jti: undefined } }) });
    }
  },
  {
    id: "dpop.jti-weak",
    what: "a DPoP proof jti of 64 bits",
    detail: '[dpop.jti-weak] dpop: jti "abcdefgh" is not 128 random bits of base64url',
    run: async (c) => {
      const key = await dpopKey();
      return startSession(c, key, { dpop: await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { claims: { jti: "abcdefgh" } }) });
    }
  },
  {
    id: "dpop.jti-reused",
    what: "the same DPoP proof twice",
    detail: /^\[dpop\.jti-reused\] dpop: reused jti [\w-]{22}$/,
    run: async (c) => {
      const key = await dpopKey();
      const dpop = await proof(key, "POST", c.hosts.tokenEndpoint);
      expect((await startSession(c, key, { dpop })).status).toBe(200);
      return startSession(c, key, { dpop });
    }
  },
  {
    id: "browser-assertion.jti-missing",
    what: "a browser assertion without jti",
    detail: "[browser-assertion.jti-missing] browser-assertion: missing jti",
    run: async (c) => {
      const s = await signedOut(c);
      return joinBrowser(c, await browserAssertion(c, s, { claims: { jti: undefined } }));
    }
  },
  {
    id: "browser-assertion.jti-weak",
    what: "a browser assertion jti of 64 bits",
    detail: '[browser-assertion.jti-weak] browser-assertion: jti "abcdefgh" is not 128 random bits of base64url',
    run: async (c) => {
      const s = await signedOut(c);
      expect((await joinBrowser(c, await browserAssertion(c, s, { claims: { jti: "abcdefgh" } }))).status).toBe(303);
    }
  },
  {
    id: "browser-assertion.jti-reused",
    what: "the same browser assertion twice",
    detail: /^\[browser-assertion\.jti-reused\] browser-assertion: reused jti [\w-]{22}$/,
    run: async (c) => {
      const s = await signedOut(c);
      const assertion = await browserAssertion(c, s);
      expect((await joinBrowser(c, assertion)).status).toBe(303);
      return joinBrowser(c, assertion);
    }
  },

  // ---- Client assertions ----
  {
    id: "client-assertion.alg",
    what: "a client assertion signed with HS256",
    detail: "[client-assertion.alg] client assertion: alg HS256 is not allowed",
    run: async (c) =>
      startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { header: { alg: "HS256" }, key: await hmacKey() }) })
  },
  {
    id: "client-assertion.embedded-key",
    what: "a client assertion carrying its own jwk",
    detail: "[client-assertion.embedded-key] client assertion: embeds or points to a key (jku/x5u/jwk)",
    run: async (c) => {
      const key = await dpopKey();
      const response = await startSession(c, key, { client: await clientAssertion(c.hosts.tokenEndpoint, { header: { jwk: key.jwk } }) });
      expect(response.status).toBe(200);
    }
  },
  {
    id: "client-assertion.typ",
    what: 'a client assertion with typ "at+jwt"',
    detail: '[client-assertion.typ] client assertion: strict Company: header typ must be "JWT", got "at+jwt"',
    run: async (c) => startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { header: { typ: "at+jwt" } }) })
  },
  {
    id: "client-assertion.kid",
    what: "a client assertion whose kid names no key",
    detail: '[client-assertion.kid] client assertion: strict Company: kid "not-a-key" names no published key',
    run: async (c) => startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { header: { kid: "not-a-key" } }) })
  },
  {
    id: "client-assertion.signature",
    what: "a client assertion signed with an unpublished key",
    detail: "[client-assertion.signature] client assertion: signature verification failed",
    run: async (c) => startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { key: await strangerKey() }) })
  },
  {
    id: "client-assertion.iat-exp-missing",
    what: "a client assertion without exp",
    detail: "[client-assertion.iat-exp-missing] client assertion: iat and exp are required",
    run: async (c) => startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { claims: { exp: undefined } }) })
  },
  {
    id: "client-assertion.lifetime",
    what: "a client assertion valid for 120 s",
    detail: "[client-assertion.lifetime] client assertion: lifetime 120s is too long (at most 60s)",
    run: async (c) =>
      startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { claims: lifetime(120) }) })
  },
  {
    id: "client-assertion.lifetime",
    what: "a client assertion valid for 301 s at a lenient Company",
    config: { strictAssertions: false },
    detail: "[client-assertion.lifetime] client assertion: lifetime 301s is too long (at most 300s)",
    run: async (c) =>
      startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { claims: lifetime(301) }) })
  },
  {
    id: "client-assertion.missing",
    what: "a token request without a client assertion",
    detail: (c) => `[client-assertion.missing] no client assertion at ${c.hosts.tokenEndpoint}`,
    run: async (c) => startSession(c, await dpopKey(), { client: null })
  },
  {
    id: "client-assertion.not-jwt",
    what: "a client assertion that isn't a JWT",
    detail: "[client-assertion.not-jwt] client assertion: not a JWT",
    run: async (c) => startSession(c, await dpopKey(), { client: "not.a.jwt" })
  },
  {
    id: "client-assertion.wrong-typ",
    what: "a DPoP proof as the client assertion",
    detail: "[client-assertion.wrong-typ] client assertion has typ dpop+jwt",
    run: async (c) => startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { header: { typ: "dpop+jwt" } }) })
  },
  {
    id: "client-assertion.aud-array",
    what: "a client assertion whose aud is an array",
    detail: "[client-assertion.aud-array] client assertion: aud is an array",
    run: async (c) =>
      startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { claims: { aud: [c.hosts.tokenEndpoint] } }) })
  },
  {
    id: "client-assertion.aud",
    what: "a client assertion for another Company",
    detail: '[client-assertion.aud] client assertion: aud "https://auth.other.shop.test/oauth/token" is not this Company',
    run: async (c) =>
      startSession(c, await dpopKey(), { client: await clientAssertion("https://auth.other.shop.test/oauth/token") })
  },
  {
    id: "client-assertion.aud",
    what: "a client assertion for the issuer, at an exact-aud Company (S1)",
    config: { clientAssertionAud: "exact" },
    detail: (c) => `[client-assertion.aud] client assertion: aud "${c.hosts.issuer}" is not exactly ${c.hosts.tokenEndpoint}`,
    run: async (c) => startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.issuer) })
  },
  {
    id: "client-assertion.aud",
    what: "a revocation client assertion for the token endpoint, at an exact-aud Company (S1)",
    config: { clientAssertionAud: "exact" },
    detail: (c) => `[client-assertion.aud] client assertion: aud "${c.hosts.tokenEndpoint}" is not exactly ${c.hosts.revocationEndpoint}`,
    run: async (c) =>
      form(c, c.hosts.revocationEndpoint, { token: "pat_unknown" }, null, { client: await clientAssertion(c.hosts.tokenEndpoint) })
  },
  {
    id: "client-assertion.iss-sub",
    what: "a client assertion whose sub isn't the client_id",
    detail: "[client-assertion.iss-sub] client assertion: iss and sub must both be the client_id",
    run: async (c) => startSession(c, await dpopKey(), { client: await clientAssertion(c.hosts.tokenEndpoint, { claims: { sub: USER_ID } }) })
  },

  // ---- Session assertions ----
  {
    id: "session-assertion.alg",
    what: "a Session assertion signed with HS256",
    detail: "[session-assertion.alg] Session assertion: alg HS256 is not allowed",
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { header: { alg: "HS256" }, key: await hmacKey() }) })
  },
  {
    id: "session-assertion.embedded-key",
    what: "a Session assertion carrying its own jwk",
    detail: "[session-assertion.embedded-key] Session assertion: embeds or points to a key (jku/x5u/jwk)",
    run: async (c) => {
      const key = await dpopKey();
      expect((await startSession(c, key, { assertion: await sessionAssertion(c, { header: { jwk: key.jwk } }) })).status).toBe(200);
    }
  },
  {
    id: "session-assertion.typ",
    what: "a Session assertion without typ",
    detail: '[session-assertion.typ] Session assertion: strict Company: header typ must be "JWT", got undefined',
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { header: { typ: undefined } }) })
  },
  {
    id: "session-assertion.kid",
    what: "a Session assertion without kid",
    detail: "[session-assertion.kid] Session assertion: strict Company: kid undefined names no published key",
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { header: { kid: undefined } }) })
  },
  {
    id: "session-assertion.signature",
    what: "an expired Session assertion",
    detail: '[session-assertion.signature] Session assertion: "exp" claim timestamp check failed',
    run: async (c) =>
      startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { iat: seconds() - 600, exp: seconds() - 560 } }) })
  },
  {
    id: "session-assertion.iat-exp-missing",
    what: "a Session assertion without iat",
    detail: "[session-assertion.iat-exp-missing] Session assertion: iat and exp are required",
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { iat: undefined } }) })
  },
  {
    id: "session-assertion.lifetime",
    what: "a Session assertion valid for an hour",
    detail: "[session-assertion.lifetime] Session assertion: lifetime 3600s is too long (at most 60s)",
    run: async (c) =>
      startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: lifetime(3600) }) })
  },
  {
    id: "session-assertion.missing",
    what: "a JWT bearer grant without an assertion",
    detail: "[session-assertion.missing] JWT bearer grant without an assertion",
    run: async (c) => startSession(c, await dpopKey(), { assertion: null })
  },
  {
    id: "session-assertion.not-jwt",
    what: "a Session assertion that isn't a JWT",
    detail: "[session-assertion.not-jwt] Session assertion: not a JWT",
    run: async (c) => startSession(c, await dpopKey(), { assertion: "garbage" })
  },
  {
    id: "session-assertion.browser-typ",
    what: "a browser assertion at the token endpoint",
    detail: "[session-assertion.browser-typ] browser assertion sent to the token endpoint",
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { header: { typ: "poppy-browser+jwt" } }) })
  },
  {
    id: "session-assertion.aud",
    what: "a Session assertion for the issuer",
    detail: (c) => `[session-assertion.aud] Session assertion: aud must be the token_endpoint as a single string, got "${c.hosts.issuer}"`,
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { aud: c.hosts.issuer } }) })
  },
  {
    id: "session-assertion.iss",
    what: "a Session assertion from another client",
    detail: "[session-assertion.iss] Session assertion: iss must be the client_id",
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { iss: OTHER } }) })
  },
  {
    id: "session-assertion.sub",
    what: "a Session assertion without a User ID",
    detail: "[session-assertion.sub] Session assertion: sub (User ID) is missing",
    run: async (c) => startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { sub: undefined } }) })
  },
  {
    id: "user-id.personal",
    what: "an email address as the User ID",
    detail: '[user-id.personal] User ID "ada@example.com" contains personal information',
    run: async (c) => {
      const response = await startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { sub: "ada@example.com" } }) });
      expect(response.status).toBe(200);
    }
  },
  {
    id: "user-id.personal",
    what: "the User's name as a word in the User ID",
    detail: '[user-id.personal] User ID "usr_ada_7" contains personal information',
    run: async (c) => {
      // Random ids that merely contain the letters are fine: this one has "ADA" inside,
      // and the next has "adA" as a word between `_` and the end, as 128 random bits may.
      for (const sub of ["usr_rTcRuOEIIRADAIQTZPEmrA", "usr_hB1U-xQz3FnJ1q7J8u_adA"]) {
        const random = await startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { sub } }) });
        expect(random.status).toBe(200);
        expect((await c.stub.state()).recorded, sub).toEqual([]);
      }
      return startSession(c, await dpopKey(), { assertion: await sessionAssertion(c, { claims: { sub: "usr_ada_7" } }) });
    }
  },

  // ---- Client metadata (as a second client the test serves) ----
  {
    id: "client-metadata.not-url",
    what: "a client_id that isn't a URL",
    detail: '[client-metadata.not-url] client metadata: client_id "not a url" is not a URL',
    run: async (c) => startSession(c, await dpopKey(), { clientId: "not a url" })
  },
  {
    id: "client-metadata.not-https",
    what: "an http client_id",
    detail: "[client-metadata.not-https] client metadata: client_id must be an https URL",
    run: async (c) => startSession(c, await dpopKey(), { clientId: "http://agent.test/poppy/client.json" })
  },
  {
    id: "client-metadata.fetch-status",
    what: "a client_id that redirects",
    detail: "[client-metadata.fetch-status] client metadata: fetching client_id returned 302; it must not redirect",
    run: async (c) => startAsOther(c, await otherClient(c, { raw: "", status: 302 }))
  },
  {
    id: "client-metadata.not-json",
    what: "client metadata that isn't JSON",
    detail: "[client-metadata.not-json] client metadata: client metadata is not JSON",
    run: async (c) => startAsOther(c, await otherClient(c, { raw: "<html>" }))
  },
  {
    id: "client-metadata.client-id-mismatch",
    what: "client metadata naming another client_id",
    detail: "[client-metadata.client-id-mismatch] client metadata: client_id in the document doesn't equal the URL it was fetched from",
    run: async (c) => startAsOther(c, await otherClient(c, { metadata: { client_id: CLIENT_ID } }))
  },
  {
    id: "client-metadata.jwks-uri",
    what: "a jwks_uri on another domain",
    detail: "[client-metadata.jwks-uri] client metadata: jwks_uri must be https on the client_id domain",
    run: async (c) => startAsOther(c, await otherClient(c, { metadata: { jwks_uri: "https://elsewhere.test/jwks.json" } }))
  },
  {
    id: "client-metadata.redirect-uris",
    what: "an http redirect_uri",
    detail: "[client-metadata.redirect-uris] client metadata: redirect_uris must be https on the client_id domain",
    run: async (c) => startAsOther(c, await otherClient(c, { metadata: { redirect_uris: ["http://other.agent.test/poppy/callback"] } }))
  },
  {
    id: "client-metadata.auth-method",
    what: "token_endpoint_auth_method client_secret_basic",
    detail: "[client-metadata.auth-method] client metadata: token_endpoint_auth_method should be private_key_jwt",
    run: async (c) => {
      const response = await startAsOther(c, await otherClient(c, { metadata: { token_endpoint_auth_method: "client_secret_basic" } }));
      expect(response.status).toBe(200);
    }
  },
  {
    id: "client-metadata.jwks-status",
    what: "a jwks_uri that answers 404",
    detail: "[client-metadata.jwks-status] client metadata: jwks_uri returned 404",
    run: async (c) => startAsOther(c, await otherClient(c, { jwksStatus: 404 }))
  },
  {
    id: "client-metadata.jwks-empty",
    what: "a JWKS with no keys",
    detail: "[client-metadata.jwks-empty] client metadata: JWKS has no keys",
    run: async (c) => startAsOther(c, await otherClient(c, { jwks: { keys: [] } }))
  },
  {
    id: "client-metadata.jwks-private",
    what: "a JWKS publishing a private key",
    detail: "[client-metadata.jwks-private] client metadata: JWKS publishes a private key",
    run: async (c) => {
      const { privateKey } = await generateKeyPair("ES256", { extractable: true });
      return startAsOther(c, await otherClient(c, { jwks: { keys: [{ ...(await exportJWK(privateKey)), kid: "other-1" }] } }));
    }
  },
  {
    id: "client-metadata.key-without-kid",
    what: "a JWKS key without kid, at a lenient Company",
    config: { strictAssertions: false },
    detail: "[client-metadata.key-without-kid] client metadata: JWKS key without kid (Guides: give every key a kid)",
    run: async (c) => {
      expect((await startAsOther(c, await otherClient(c, { kid: null }))).status).toBe(200);
    }
  },

  // ---- DPoP proofs ----
  {
    id: "dpop.missing",
    what: "an API request without a DPoP proof",
    detail: "[dpop.missing] DPoP: missing DPoP header (GET /products)",
    run: async (c) => call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, { proof: null })
  },
  {
    id: "dpop.multiple",
    what: "two DPoP proofs in one header",
    detail: "[dpop.multiple] DPoP: more than one DPoP proof (GET /products)",
    run: async (c) => {
      const s = await signedOut(c);
      const url = `${c.hosts.api}/products`;
      return call(c, s, "GET", url, { proof: `${await proof(s.key, "GET", url, s.token)}, ${await proof(s.key, "GET", url, s.token)}` });
    }
  },
  {
    id: "dpop.not-jwt",
    what: "a DPoP proof that isn't a JWT",
    detail: "[dpop.not-jwt] DPoP: proof is not a JWT (GET /products)",
    run: async (c) => call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, { proof: "not-a-jwt" })
  },
  {
    id: "dpop.typ",
    what: 'a DPoP proof with typ "JWT"',
    detail: "[dpop.typ] DPoP: typ is JWT (GET /products)",
    run: async (c) => call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, { proof: { header: { typ: "JWT" } } })
  },
  {
    id: "dpop.alg",
    what: "a DPoP proof signed with ES384",
    detail: "[dpop.alg] DPoP: alg ES384 not allowed (GET /products)",
    run: async (c) => {
      const { privateKey, publicKey } = await generateKeyPair("ES384");
      return call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, {
        proof: { header: { alg: "ES384", jwk: await exportJWK(publicKey) }, key: privateKey }
      });
    }
  },
  {
    id: "dpop.no-jwk",
    what: "a DPoP proof without its jwk",
    detail: "[dpop.no-jwk] DPoP: no jwk in header (GET /products)",
    run: async (c) => call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, { proof: { header: { jwk: undefined } } })
  },
  {
    id: "dpop.private-jwk",
    what: "a DPoP proof whose jwk is the private key",
    detail: "[dpop.private-jwk] DPoP: jwk contains a private key (GET /products)",
    run: async (c) => {
      const { privateKey } = await generateKeyPair("ES256", { extractable: true });
      return call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, {
        proof: { header: { jwk: await exportJWK(privateKey) }, key: privateKey }
      });
    }
  },
  {
    id: "dpop.signature",
    what: "a DPoP proof signed by a key other than its jwk",
    detail: "[dpop.signature] DPoP: signature: signature verification failed (GET /products)",
    run: async (c) => call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, { proof: { key: await strangerKey() } })
  },
  {
    id: "dpop.htm",
    what: "a DPoP proof for POST on a GET",
    detail: "[dpop.htm] DPoP: htm POST != GET (GET /products)",
    run: async (c) => call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, { proof: { claims: { htm: "POST" } } })
  },
  {
    id: "dpop.htu",
    what: "a DPoP proof whose htu keeps the query",
    detail: (c) => `[dpop.htu] DPoP: htu ${c.hosts.api}/products?q=jacket != ${c.hosts.api}/products (GET /products)`,
    run: async (c) =>
      call(c, await signedOut(c), "GET", `${c.hosts.api}/products?q=jacket`, { proof: { claims: { htu: `${c.hosts.api}/products?q=jacket` } } })
  },
  {
    id: "dpop.iat",
    what: "a DPoP proof made ten minutes ago",
    detail: "[dpop.iat] DPoP: iat outside the acceptance window (GET /products)",
    run: async (c) => call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, { proof: { claims: { iat: seconds() - 600 } } })
  },
  {
    id: "dpop.ath-at-token-endpoint",
    what: "ath on a token request's proof",
    detail: "[dpop.ath-at-token-endpoint] DPoP: ath on a token request (POST /oauth/token)",
    run: async (c) => {
      const key = await dpopKey();
      return startSession(c, key, { dpop: await proof(key, "POST", c.hosts.tokenEndpoint, "at_something") });
    }
  },
  {
    id: "dpop.ath",
    what: "a DPoP proof whose ath is for another token",
    detail: "[dpop.ath] DPoP: ath doesn't match the token (GET /products)",
    run: async (c) => call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, { proof: { claims: { ath: await hash("at_other") } } })
  },
  {
    id: "dpop.nonce-ignored",
    what: "a proof, a second after using the nonce, without it",
    config: { requireNonce: true },
    detail: (c) =>
      `[dpop.nonce-ignored] DPoP: proof without the nonce this key already used at ${new URL(c.hosts.tokenEndpoint).origin} (must keep using nonces)`,
    run: async (c) => {
      const key = await dpopKey();
      const first = await startSession(c, key);
      expect(await first.json()).toMatchObject({ error: "use_dpop_nonce" });
      const nonce = first.headers.get("DPoP-Nonce")!;
      const now = seconds();
      const withNonce = await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { nonce, claims: { iat: now } });
      expect((await startSession(c, key, { dpop: withNonce })).status).toBe(200);
      // Made in the same second, it may have been in flight before the nonce arrived: excused.
      const racing = await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { claims: { iat: now } });
      expect((await startSession(c, key, { dpop: racing })).status).toBe(400);
      expect((await c.stub.state()).recorded).toEqual([]);
      return startSession(c, key, { dpop: await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { claims: { iat: now + 1 } }) });
    }
  },
  {
    id: "dpop.key-mismatch",
    what: "a correct proof from a key the token isn't bound to",
    detail: "[dpop.key-mismatch] DPoP proof key isn't the key the token is bound to",
    run: async (c) => {
      const s = await signedOut(c);
      return call(c, { ...s, key: await dpopKey() }, "GET", `${c.hosts.api}/products`);
    }
  },
  {
    id: "dpop.key-shared",
    what: "one DPoP key for two User IDs",
    detail: /^\[dpop\.key-shared\] DPoP key [\w-]{43} used for User usr_Hd8pW2zQ5nVb7LtK3xRc9F after User usr_Q7c1vKx9TzLw3NdR5mHa2B$/,
    run: async (c) => {
      const key = await dpopKey();
      expect((await startSession(c, key)).status).toBe(200);
      const other = await startSession(c, key, { assertion: await sessionAssertion(c, { claims: { sub: "usr_Hd8pW2zQ5nVb7LtK3xRc9F" } }) });
      expect(other.status).toBe(200);
    }
  },

  // ---- Session Tokens on resources ----
  {
    id: "resource.no-token",
    what: "an API request without a Session Token",
    detail: (c) => `[resource.no-token] request without a Session Token: GET ${c.hosts.api}/products`,
    run: async (c) => call(c, await signedOut(c), "GET", `${c.hosts.api}/products`, { auth: null })
  },
  {
    id: "resource.bearer-scheme",
    what: "a Session Token with the Bearer scheme at an API",
    detail: "[resource.bearer-scheme] Bearer token on /products; Bearer is only for MCP",
    run: async (c) => {
      const s = await signedOut(c);
      return call(c, s, "GET", `${c.hosts.api}/products`, { auth: `Bearer ${s.token}` });
    }
  },
  {
    id: "resource.bearer-token-as-dpop",
    what: "an MCP Bearer token with the DPoP scheme at an API",
    detail: "[resource.bearer-token-as-dpop] Bearer Session Token sent with the DPoP scheme",
    run: async (c) => {
      const s = await signedOut(c);
      const bearer = (await (
        await form(c, c.hosts.tokenEndpoint, { grant_type: JWT_BEARER, assertion: await sessionAssertion(c), resource: c.hosts.mcpUrl }, null)
      ).json()) as { access_token: string; token_type: string };
      expect(bearer.token_type).toBe("Bearer");
      return call(c, { ...s, token: bearer.access_token }, "GET", `${c.hosts.api}/products`);
    }
  },
  {
    id: "resource.stale-token",
    what: "an older Session Token, seconds after a newer one",
    detail: "[resource.stale-token] used an older Session Token after a newer one was issued for the Session",
    run: async (c) => {
      const s = await signedOut(c);
      const renewed = await startSession(c, s.key, { fields: { session_id: s.sessionId } });
      expect(renewed.status).toBe(200);
      // Three seconds later, by the mock's clock.
      return call(c, s, "GET", `${c.hosts.api}/products`, { headers: { [CLOCK_HEADER]: String(Date.now() + 3000) } });
    }
  },
  {
    id: "mcp.not-bearer",
    what: "an MCP request with the DPoP scheme",
    detail: "[mcp.not-bearer] MCP request with DPoP scheme; MCP uses Bearer",
    run: async (c) =>
      call(c, await signedOut(c), "POST", c.hosts.mcpUrl, {
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: { Accept: "application/json, text/event-stream" }
      })
  },
  {
    id: "mcp.wrong-token",
    what: "a DPoP Session Token as an MCP Bearer token",
    detail: "[mcp.wrong-token] MCP request with a token not issued for this MCP server",
    run: async (c) => {
      const s = await signedOut(c);
      return call(c, s, "POST", c.hosts.mcpUrl, {
        auth: `Bearer ${s.token}`,
        proof: null,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: { Accept: "application/json, text/event-stream" }
      });
    }
  },
  {
    id: "mcp.accept",
    what: "an MCP request that only Accepts JSON",
    detail: '[mcp.accept] MCP request must Accept application/json and text/event-stream, got "application/json"',
    run: async (c) => {
      const bearer = (await (
        await form(c, c.hosts.tokenEndpoint, { grant_type: JWT_BEARER, assertion: await sessionAssertion(c), resource: c.hosts.mcpUrl }, null)
      ).json()) as { access_token: string };
      const response = await c.call(c.hosts.mcpUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer.access_token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(response.status).toBe(200);
    }
  },

  // ---- Rate limits and secrets ----
  {
    id: "rate-limit.retry-after-ignored",
    what: "a retry before Retry-After elapsed",
    config: { rateLimit: { tokenRequests429: 0, requests429: 1, retryAfterSeconds: 1 } },
    detail: /^\[rate-limit\.retry-after-ignored\] sent GET \/products \d+ ms before Retry-After elapsed$/,
    run: async (c) => {
      const s = await signedOut(c);
      const first = await call(c, s, "GET", `${c.hosts.api}/products`);
      expect(first.status).toBe(429);
      expect(first.headers.get("Retry-After")).toBe("1");
      return call(c, s, "GET", `${c.hosts.api}/products`);
    }
  },
  {
    id: "rate-limit.retry-after-ignored",
    what: "a retry before Retry-After elapsed on the fake clock",
    config: { rateLimit: { tokenRequests429: 1, requests429: 0, retryAfterSeconds: 2 } },
    detail: /^\[rate-limit\.retry-after-ignored\] sent POST \/oauth\/token \d+ ms before Retry-After elapsed$/,
    run: async (c) => {
      const key = await dpopKey();
      expect((await startSession(c, key)).status).toBe(429);
      // One second on is still too soon; two seconds on is fine.
      expect((await startSession(c, key, { headers: { [CLOCK_HEADER]: String(Date.now() + 1000) } })).status).toBe(429);
      expect((await startSession(c, key, { headers: { [CLOCK_HEADER]: String(Date.now() + 3100) } })).status).toBe(200);
    }
  },
  {
    id: "secret.password",
    what: "a password in a header to the website",
    detail: (c) => `[secret.password] password sent in headers of GET ${SITE(c)}/`,
    run: async (c) => c.call(`${SITE(c)}/`, { headers: { "X-Note": "correct horse" } })
  },
  {
    id: "secret.one-time-code",
    what: "a one-time code in the body of a conversation",
    detail: (c) => `[secret.one-time-code] one-time code sent in body of POST ${c.hosts.conversationsEndpoint}`,
    run: async (c) => {
      const { s, code } = await oneTimeCode(c);
      return converse(c, s, message({ text: `My code is ${code}` }));
    }
  },
  {
    id: "secret.account-token",
    what: "an Account Token in a header to an API",
    detail: (c) => `[secret.account-token] Account Token sent in headers of GET ${c.hosts.api}/orders`,
    run: async (c) => {
      const s = await signedIn(c);
      return call(c, s, "GET", `${c.hosts.api}/orders`, { headers: { "X-Refresh": s.refreshToken } });
    }
  },
  {
    id: "secret.token-in-url",
    what: "a Session Token in the query string",
    detail: /^\[secret\.token-in-url\] token sent in URL https:\/\/api\.\w+\.shop\.test\/products\?access_token=at_[\w-]+$/,
    run: async (c) => {
      const s = await signedOut(c);
      return c.call(`${c.hosts.api}/products?access_token=${s.token}`);
    }
  },

  // ---- Token endpoint ----
  {
    id: "form.not-form",
    what: "a token request as JSON",
    detail: '[form.not-form] /oauth/token sent as "application/json", not a form',
    run: async (c) => startSession(c, await dpopKey(), { contentType: "application/json" })
  },
  {
    id: "token.no-dpop",
    what: "a token request without a DPoP proof",
    detail: `[token.no-dpop] token request (${JWT_BEARER}) without a DPoP proof`,
    run: async (c) => startSession(c, await dpopKey(), { dpop: null })
  },
  {
    id: "token.mcp-dpop",
    what: "a DPoP proof on a token request for the MCP server",
    detail: "[token.mcp-dpop] asked for a DPoP-bound token for the MCP server; MCP uses Bearer",
    run: async (c) => {
      expect((await startSession(c, await dpopKey(), { fields: { resource: c.hosts.mcpUrl } })).status).toBe(200);
    }
  },
  {
    id: "token.signed-in-renewed-with-assertion",
    what: "a signed-in Session renewed with the assertion",
    detail: "[token.signed-in-renewed-with-assertion] renewed a signed-in Session with the assertion instead of the Account Token",
    run: async (c) => {
      const s = await signedIn(c);
      return startSession(c, s.key, { fields: { session_id: s.sessionId } });
    }
  },
  {
    id: "account-token.other-client",
    what: "an Account Token used by another client_id",
    detail: "[account-token.other-client] Account Token used by a different client_id",
    run: async (c) => {
      const s = await signedIn(c);
      const other = await otherClient(c);
      return form(c, c.hosts.tokenEndpoint, { grant_type: "refresh_token", refresh_token: s.refreshToken }, s.key, {
        clientId: OTHER,
        client: await other.clientAssertion(c.hosts.tokenEndpoint)
      });
    }
  },
  {
    id: "account-token.rotated-reused",
    what: "an Account Token used after it rotated",
    config: { rotateRefreshTokens: true },
    detail: "[account-token.rotated-reused] used an Account Token after the Company rotated it (4.8)",
    run: async (c) => {
      const s = await signedIn(c);
      const refresh = () =>
        form(c, c.hosts.tokenEndpoint, { grant_type: "refresh_token", refresh_token: s.refreshToken, session_id: s.sessionId }, s.key);
      expect((await refresh()).status).toBe(200);
      return refresh();
    }
  },

  {
    id: "session.account-mismatch-reused",
    what: "a Session refused with account_mismatch asked again to sign in to another account",
    detail: /^\[session\.account-mismatch-reused\] Session ses_[\w-]+ asked again to sign in to another account after account_mismatch \(4\.4 says the agent starts a new Session; no RFC 2119 keyword\)$/,
    run: async (c) => {
      // Ada's Session; Grace's codes exchanged into it.
      const ada = await signedIn(c);
      const grace = async () => exchangeCode(c, { ...(await authorizationCode(c, "acct_grace")), s: ada });
      expect(await (await grace()).json()).toMatchObject({ error: "account_mismatch" });
      return grace();
    }
  },

  // ---- Sign-in ----
  {
    id: "signin.no-scope",
    what: "a device sign-in without scope",
    detail: "[signin.no-scope] device sign-in without scope",
    run: async (c) => form(c, c.hosts.deviceEndpoint, {}, null)
  },
  {
    id: "signin.no-scope",
    what: "a direct sign-in without scope",
    detail: "[signin.no-scope] direct sign-in without scope",
    run: async (c) => {
      const { challenge } = await pkce();
      return c.call(authorizeUrl(c, { response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: jti(), code_challenge: challenge, code_challenge_method: "S256" }));
    }
  },
  {
    id: "signin.no-scope",
    what: "a mediated sign-in without scope",
    detail: "[signin.no-scope] mediated sign-in without scope",
    run: async (c) =>
      call(c, await signedOut(c), "POST", c.hosts.mediatedEndpoint, { body: { credentials: { email: "ada@example.com", password: "correct horse" } } })
  },
  {
    id: "authorize.redirect-uri",
    what: "an unregistered redirect_uri",
    detail: "[authorize.redirect-uri] redirect_uri https://agent.test/elsewhere isn't an exact registered redirect_uri",
    run: async (c) => {
      const { challenge } = await pkce();
      return c.call(
        authorizeUrl(c, { response_type: "code", client_id: CLIENT_ID, redirect_uri: "https://agent.test/elsewhere", scope: "poppy:read", state: jti(), code_challenge: challenge, code_challenge_method: "S256" })
      );
    }
  },
  {
    id: "authorize.no-state",
    what: "an authorization request without state",
    detail: "[authorize.no-state] authorization request without state",
    run: async (c) => {
      const { challenge } = await pkce();
      return c.call(authorizeUrl(c, { response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: "poppy:read", code_challenge: challenge, code_challenge_method: "S256" }));
    }
  },
  {
    id: "authorize.no-pkce",
    what: "PKCE plain instead of S256",
    detail: "[authorize.no-pkce] authorization request without PKCE S256",
    run: async (c) =>
      c.call(authorizeUrl(c, { response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: "poppy:read", state: jti(), code_challenge: "plain-verifier", code_challenge_method: "plain" }))
  },
  {
    id: "authorize.secret-in-url",
    what: "a client assertion in the authorization URL",
    detail: "[authorize.secret-in-url] client_assertion in the authorization URL",
    run: async (c) => {
      const { challenge } = await pkce();
      const page = await c.call(
        authorizeUrl(c, {
          response_type: "code",
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          scope: "poppy:read",
          state: jti(),
          code_challenge: challenge,
          code_challenge_method: "S256",
          client_assertion: await clientAssertion(c.hosts.authorizationEndpoint)
        })
      );
      expect(page.status).toBe(200);
    }
  },
  {
    id: "code.reused",
    what: "an authorization code exchanged twice",
    detail: "[code.reused] authorization code used twice",
    run: async (c) => {
      const flow = await authorizationCode(c);
      expect((await exchangeCode(c, flow)).status).toBe(200);
      return exchangeCode(c, flow);
    }
  },
  {
    id: "code.redirect-uri",
    what: "a different redirect_uri at the token endpoint",
    detail: "[code.redirect-uri] redirect_uri at the token endpoint differs from the authorization request",
    run: async (c) => exchangeCode(c, await authorizationCode(c), { redirect_uri: "https://agent.test/poppy/callback2" })
  },
  {
    id: "code.pkce",
    what: "the wrong PKCE verifier",
    detail: "[code.pkce] PKCE code_verifier doesn't match the challenge",
    run: async (c) => exchangeCode(c, await authorizationCode(c), { code_verifier: jti() + jti() })
  },
  {
    id: "code.no-session-id",
    what: "a code exchanged without session_id",
    detail: "[code.no-session-id] authorization code exchanged without session_id (4.5)",
    run: async (c) => exchangeCode(c, await authorizationCode(c), { session_id: undefined })
  },
  {
    id: "device.polled-after-final",
    what: "polling twice after access_denied",
    detail: "[device.polled-after-final] kept polling after access_denied",
    run: async (c) => {
      const flow = await deviceFlow(c);
      await c.stub.denyDevice(flow.device.user_code);
      expect(await (await flow.poll()).json()).toMatchObject({ error: "access_denied" });
      return flow.poll();
    }
  },
  {
    id: "device.polled-after-final",
    what: "polling after signing in",
    detail: "[device.polled-after-final] kept polling after completion",
    run: async (c) => {
      const flow = await deviceFlow(c);
      await c.stub.approveDevice(flow.device.user_code);
      expect((await flow.poll()).status).toBe(200);
      return flow.poll();
    }
  },
  {
    id: "device.polled-after-expiry",
    what: "polling twice after expired_token",
    detail: "[device.polled-after-expiry] kept polling after expired_token",
    run: async (c) => {
      const flow = await deviceFlow(c, { deviceExpiresIn: 0 });
      expect(await (await flow.poll()).json()).toMatchObject({ error: "expired_token" });
      return flow.poll();
    }
  },
  {
    id: "device.too-fast",
    what: "polling faster than the interval after slow_down",
    detail: /^\[device\.too-fast\] polled \d+ ms after the last poll, under the 6 s interval after slow_down$/,
    run: async (c) => {
      const flow = await deviceFlow(c);
      expect(await (await flow.poll()).json()).toMatchObject({ error: "authorization_pending" });
      expect(await (await flow.poll()).json()).toMatchObject({ error: "slow_down" });
      return flow.poll();
    }
  },
  {
    id: "device.no-session-id",
    what: "a device code exchanged without session_id",
    detail: "[device.no-session-id] device code exchanged without session_id",
    run: async (c) => {
      const flow = await deviceFlow(c);
      await c.stub.approveDevice(flow.device.user_code);
      return flow.poll({});
    }
  },
  {
    id: "mediated.missing-field",
    what: "credentials without the password field",
    detail: "[mediated.missing-field] mediated sign-in missing field password",
    run: async (c) =>
      call(c, await signedOut(c), "POST", c.hosts.mediatedEndpoint, { body: { scope: "poppy:read", credentials: { email: "ada@example.com" } } })
  },
  {
    id: "mediated.credentials-with-code",
    what: "the password resent with the one-time code",
    detail: "[mediated.credentials-with-code] credentials resent with the one-time code (4.7: submit only the code)",
    run: async (c) => {
      const { s, signInId, code } = await oneTimeCode(c);
      return call(c, s, "POST", `${c.hosts.mediatedEndpoint}/${signInId}`, { body: { code, email: "grace@example.com" } });
    }
  },
  {
    id: "mediated.code-other-session",
    what: "the one-time code submitted from another Session",
    detail: /^\[mediated\.code-other-session\] one-time code for sgn_[\w-]+ submitted from another Session$/,
    run: async (c) => {
      const { signInId, code } = await oneTimeCode(c);
      const response = await call(c, await signedOut(c), "POST", `${c.hosts.mediatedEndpoint}/${signInId}`, { body: { code } });
      expect(response.status).toBe(404);
    }
  },

  // ---- Browser join ----
  {
    id: "browser-assertion.in-url",
    what: "the browser assertion in the URL",
    detail: "[browser-assertion.in-url] browser session: assertion sent in the URL",
    run: async (c) => {
      const s = await signedOut(c);
      const assertion = await browserAssertion(c, s);
      return joinBrowser(c, assertion, {}, `${c.hosts.browserSessionEndpoint}?assertion=${assertion}`);
    }
  },
  {
    id: "browser-assertion.not-post",
    what: "a GET to the browser-session endpoint",
    detail: "[browser-assertion.not-post] browser session: must be a form POST",
    run: async (c) => c.call(c.hosts.browserSessionEndpoint)
  },
  {
    id: "browser-assertion.content-type",
    what: "the browser assertion posted as JSON",
    detail: '[browser-assertion.content-type] browser session: content type "application/json"',
    run: async (c) => {
      const s = await signedOut(c);
      return c.call(c.hosts.browserSessionEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: await browserAssertion(c, s) })
      });
    }
  },
  {
    id: "browser-assertion.missing",
    what: "a browser join without an assertion",
    detail: "[browser-assertion.missing] browser session: no assertion",
    run: async (c) =>
      c.call(c.hosts.browserSessionEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ return_to: SITE(c) })
      })
  },
  {
    id: "browser-assertion.not-jwt",
    what: "a browser assertion that isn't a JWT",
    detail: "[browser-assertion.not-jwt] browser session: assertion is not a JWT",
    run: async (c) => joinBrowser(c, "garbage")
  },
  {
    id: "browser-assertion.typ",
    what: 'a browser assertion with typ "JWT"',
    detail: "[browser-assertion.typ] browser session: typ JWT",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { header: { typ: "JWT" } }))
  },
  {
    id: "browser-assertion.alg",
    what: "a browser assertion signed with HS256",
    detail: "[browser-assertion.alg] browser session: alg HS256 is not allowed",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { header: { alg: "HS256" }, key: await hmacKey() }))
  },
  {
    id: "browser-assertion.embedded-key",
    what: "a browser assertion carrying its own jwk",
    detail: "[browser-assertion.embedded-key] browser session: assertion embeds or points to a key (jku/x5u/x5c/jwk)",
    run: async (c) => {
      const s = await signedOut(c);
      expect((await joinBrowser(c, await browserAssertion(c, s, { header: { jwk: s.key.jwk } }))).status).toBe(303);
    }
  },
  {
    id: "browser-assertion.embedded-key",
    what: "a browser assertion carrying a certificate chain",
    detail: "[browser-assertion.embedded-key] browser session: assertion embeds or points to a key (jku/x5u/x5c/jwk)",
    run: async (c) => {
      const s = await signedOut(c);
      expect((await joinBrowser(c, await browserAssertion(c, s, { header: { x5c: ["MIIBIjANBgkq"] } }))).status).toBe(303);
    }
  },
  {
    id: "browser-assertion.kid",
    what: "a browser assertion whose kid names no key",
    detail: '[browser-assertion.kid] browser session: strict Company: kid "not-a-key" names no published key',
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { header: { kid: "not-a-key" } }))
  },
  {
    id: "browser-assertion.no-iss",
    what: "a browser assertion without iss",
    detail: "[browser-assertion.no-iss] browser session: no iss",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { claims: { iss: undefined } }))
  },
  {
    id: "browser-assertion.unknown-agent",
    what: "a browser assertion from a client_id that isn't a URL",
    ids: ["client-metadata.not-url", "browser-assertion.unknown-agent"],
    detail: "[browser-assertion.unknown-agent] browser session: unknown Personal Agent",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { claims: { iss: "not a url" } }))
  },
  {
    id: "browser-assertion.signature",
    what: "a browser assertion signed with an unpublished key",
    detail: "[browser-assertion.signature] browser session: signature or expiry: signature verification failed",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { key: await strangerKey() }))
  },
  {
    id: "browser-assertion.aud",
    what: "a browser assertion for the token endpoint",
    detail: (c) => `[browser-assertion.aud] browser session: aud "${c.hosts.tokenEndpoint}"`,
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { claims: { aud: c.hosts.tokenEndpoint } }))
  },
  {
    id: "browser-assertion.lifetime",
    what: "a browser assertion valid for two minutes",
    detail: "[browser-assertion.lifetime] browser session: exp must be no more than 60 seconds after iat",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { claims: lifetime(120) }))
  },
  {
    id: "browser-assertion.iat-exp-missing",
    what: "a browser assertion without exp",
    detail: "[browser-assertion.iat-exp-missing] browser session: iat and exp are required",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { claims: { exp: undefined } }))
  },
  {
    id: "browser-assertion.iat-future",
    what: "a browser assertion issued an hour from now",
    detail: /^\[browser-assertion\.iat-future\] browser session: iat \d+ is in the future$/,
    run: async (c) =>
      joinBrowser(c, await browserAssertion(c, await signedOut(c), { claims: { iat: seconds() + 3600, exp: seconds() + 3660 } }))
  },
  {
    id: "browser-assertion.session",
    what: "a browser assertion for a Session that doesn't exist",
    detail: "[browser-assertion.session] browser session: Session isn't active or isn't this agent's and User's",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { claims: { session_id: "ses_nope" } }))
  },
  {
    id: "browser-assertion.return-to-not-url",
    what: "a return_to that isn't a URL",
    detail: "[browser-assertion.return-to-not-url] browser session: return_to is not a URL",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { claims: { return_to: "/orders" } }))
  },
  {
    id: "browser-assertion.return-to-off-domain",
    what: "a return_to on another domain",
    detail: "[browser-assertion.return-to-off-domain] browser session: return_to is not on the Company's domain",
    run: async (c) => joinBrowser(c, await browserAssertion(c, await signedOut(c), { claims: { return_to: "https://elsewhere.test/" } }))
  },

  // ---- APIs ----
  {
    id: "idempotency.key-reused",
    what: "an Idempotency-Key reused with another body",
    config: { operations: false },
    detail: "[idempotency.key-reused] Idempotency-Key key_1 reused with a different body",
    run: async (c) => {
      const s = await signedIn(c);
      expect((await exchange(c, s, { "Idempotency-Key": "key_1" })).status).toBe(201);
      return exchange(c, s, { "Idempotency-Key": "key_1" }, { item_id: "itm_4Qa", replacement_sku: "stormline-m" });
    }
  },
  {
    id: "idempotency.key-missing",
    what: "an order of prints without the Idempotency-Key its description requires",
    config: { printShop: true },
    detail: "[idempotency.key-missing] POST /prints without the Idempotency-Key its description requires",
    run: async (c) => {
      const s = await signedOut(c);
      const uploaded = await uploadPhoto(c, s, multipart("b0undary", 'form-data; name="photo"; filename="lake"'), "multipart/form-data; boundary=b0undary");
      expect(uploaded.status).toBe(201);
      const { id } = (await uploaded.json()) as { id: string };
      return call(c, s, "POST", `${c.hosts.api}/prints`, { body: printOrder(id) });
    }
  },
  {
    id: "upload.boundary",
    what: "a photo upload whose multipart/form-data has no boundary",
    config: { printShop: true },
    detail: '[upload.boundary] multipart/form-data without a boundary: "multipart/form-data"',
    run: async (c) => uploadPhoto(c, await signedOut(c), multipart("b0undary", 'form-data; name="photo"; filename="lake"'), "multipart/form-data")
  },
  {
    id: "upload.part-name",
    what: "a photo upload whose part has no form-data name",
    config: { printShop: true },
    detail: '[upload.part-name] multipart part without a form-data name (Content-Disposition: "attachment; filename=\\"lake\\"")',
    run: async (c) => uploadPhoto(c, await signedOut(c), multipart("b0undary", 'attachment; filename="lake"'), "multipart/form-data; boundary=b0undary")
  },
  {
    id: "exchange.performed-twice",
    what: "a write retried without its Idempotency-Key",
    config: { operations: false },
    detail: "[exchange.performed-twice] itm_4Qa on ord_7Hk2 exchanged again for acct_ada (direct API call)",
    run: async (c) => {
      const s = await signedIn(c);
      expect((await exchange(c, s)).status).toBe(201);
      expect((await exchange(c, s)).status).toBe(201);
    }
  },
  {
    id: "exchange.performed-twice",
    what: "a second proposal for the same exchange confirmed",
    detail: /^\[exchange\.performed-twice\] itm_4Qa on ord_7Hk2 exchanged again for acct_ada \(operation exc_[\w-]+\)$/,
    run: async (c) => {
      for (let i = 0; i < 2; i++) {
        const { s, operation } = await proposed(c);
        const confirmed = await call(c, s, "POST", `${c.hosts.operationsEndpoint}/${operation.operation_id}/confirm`, {
          body: { revision: operation.revision, approved_by: "user" }
        });
        expect(await confirmed.json()).toMatchObject({ state: "succeeded" });
      }
    }
  },

  // ---- Conversations ----
  {
    id: "message.missing",
    what: "a conversation started without a message",
    detail: "[message.missing] conversation message: missing message",
    run: async (c) => call(c, await signedOut(c), "POST", c.hosts.conversationsEndpoint, { body: {} })
  },
  {
    id: "message.id",
    what: "a message id with a space",
    detail: "[message.id] conversation message: id must be 1-256 base64url characters",
    run: async (c) => converse(c, await signedOut(c), message({ id: "msg 1" }))
  },
  {
    id: "message.sender",
    what: 'a message from sender "company"',
    detail: "[message.sender] conversation message: sender must be agent or human",
    run: async (c) => converse(c, await signedOut(c), message({ sender: "company" }))
  },
  {
    id: "message.empty",
    what: "a message with no text, data or context",
    detail: "[message.empty] conversation message: needs at least one of text, data or context",
    run: async (c) => converse(c, await signedOut(c), message({ text: undefined }))
  },
  {
    id: "message.text-type",
    what: "a number as text",
    detail: "[message.text-type] conversation message: text must be a string",
    run: async (c) => converse(c, await signedOut(c), message({ text: 1042 }))
  },
  {
    id: "message.json-in-text",
    what: "JSON in text",
    detail: "[message.json-in-text] conversation message: JSON in text; use data (7.4)",
    run: async (c) => {
      expect((await converse(c, await signedOut(c), message({ text: '{"order": 1042}' }))).status).toBe(201);
    }
  },
  {
    id: "message.data-type",
    what: "an array as data",
    detail: "[message.data-type] conversation message: data must be a JSON object",
    run: async (c) => converse(c, await signedOut(c), message({ data: [1042] }))
  },
  {
    id: "message.context-type",
    what: "a string as context",
    detail: "[message.context-type] conversation message: context must be an object",
    run: async (c) => converse(c, await signedOut(c), message({ context: "London" }))
  },
  {
    id: "message.id-reused",
    what: "a message id reused for other words",
    detail: /^\[message\.id-reused\] message id msg_[\w-]+ reused with different content$/,
    run: async (c) => {
      const s = await signedOut(c);
      const first = message();
      expect((await converse(c, s, first)).status).toBe(201);
      return converse(c, s, { ...first, text: "Something else" });
    }
  },
  {
    id: "context.locale",
    what: "a locale that isn't a language tag",
    detail: '[context.locale] context.locale "English please" is not an RFC 5646 tag',
    run: async (c) => converse(c, await signedOut(c), message({ context: { locale: "English please" } }))
  },
  {
    id: "context.time-zone",
    what: "a time zone that isn't an IANA name",
    detail: '[context.time-zone] context.time_zone "GMT+1 please" is not an IANA name',
    run: async (c) => converse(c, await signedOut(c), message({ context: { time_zone: "GMT+1 please" } }))
  },
  {
    id: "context.user-available",
    what: 'user_available "yes"',
    detail: "[context.user-available] context.user_available must be a boolean",
    run: async (c) => converse(c, await signedOut(c), message({ context: { user_available: "yes" } }))
  },
  {
    id: "direct.agent-words",
    what: "a Direct Conversation opened with the agent's words",
    detail: "[direct.agent-words] Direct Conversation opened with words not marked as the User's (sender agent)",
    run: async (c) => {
      const s = await signedOut(c);
      const parent = await conversation(c, s);
      expect((await converse(c, s, message({ text: "Hi, it's me." }), { parent_conversation_id: parent })).status).toBe(201);
    }
  },
  {
    id: "direct.agent-words-later",
    what: "the agent's own words in an open Direct Conversation",
    detail: /^\[direct\.agent-words-later\] agent's own words sent into Direct Conversation cnv_[\w-]+$/,
    run: async (c) => {
      const s = await signedOut(c);
      const parent = await conversation(c, s);
      const opened = await converse(c, s, message({ sender: "human", text: "Hi, it's me." }), { parent_conversation_id: parent });
      const { conversation_id: direct } = (await opened.json()) as { conversation_id: string };
      const send = (fields: Record<string, unknown>) =>
        call(c, s, "POST", `${c.hosts.conversationsEndpoint}/${direct}/messages`, { body: { message: message(fields) } });
      // The User's words, and a context update from the agent, belong there.
      expect((await send({ sender: "human", text: "Medium, please." })).status).toBe(202);
      expect((await send({ text: undefined, context: { user_available: false } })).status).toBe(202);
      expect((await send({ text: "The user means the medium." })).status).toBe(202);
    }
  },
  {
    id: "handoff.body",
    what: "a handoff with a reason in the body",
    detail: '[handoff.body] handoff body should be {}, got {"reason":"needs a person"}',
    run: async (c) => {
      const s = await signedOut(c);
      const id = await conversation(c, s);
      return call(c, s, "POST", `${c.hosts.conversationsEndpoint}/${id}/handoff`, { body: { reason: "needs a person" } });
    }
  },
  {
    id: "close.body",
    what: "a close with a body",
    detail: '[close.body] close body should be {}, got {"done":true}',
    run: async (c) => {
      const s = await signedOut(c);
      const id = await conversation(c, s);
      return call(c, s, "POST", `${c.hosts.conversationsEndpoint}/${id}/close`, { body: { done: true } });
    }
  },
  {
    id: "conversation.cross-user",
    what: "another User of the same agent reading a conversation",
    detail: /^\[conversation\.cross-user\] User usr_Hd8pW2zQ5nVb7LtK3xRc9F reached conversation cnv_[\w-]+ of User usr_Q7c1vKx9TzLw3NdR5mHa2B$/,
    run: async (c) => {
      const a = await signedOut(c);
      const id = await conversation(c, a);
      // A second signed-out Session of the same agent, for a different User.
      const bKey = await dpopKey();
      const bResponse = await startSession(c, bKey, { assertion: await sessionAssertion(c, { claims: { sub: "usr_Hd8pW2zQ5nVb7LtK3xRc9F" } }) });
      const b = { key: bKey, token: ((await bResponse.json()) as { access_token: string }).access_token, sessionId: "" };
      return call(c, b, "GET", `${c.hosts.conversationsEndpoint}/${id}/events`);
    }
  },

  // ---- Operations extension ----
  {
    id: "confirm.approved-by",
    what: 'a confirm approved_by "model"',
    detail: '[confirm.approved-by] confirm with approved_by "model"',
    run: async (c) => {
      const { s, operation } = await proposed(c);
      return call(c, s, "POST", `${c.hosts.operationsEndpoint}/${operation.operation_id}/confirm`, { body: { revision: operation.revision, approved_by: "model" } });
    }
  },
  {
    id: "confirm.revision",
    what: "a confirm without revision",
    detail: "[confirm.revision] confirm with revision undefined",
    run: async (c) => {
      const { s, operation } = await proposed(c);
      const response = await call(c, s, "POST", `${c.hosts.operationsEndpoint}/${operation.operation_id}/confirm`, { body: { approved_by: "user" } });
      expect(response.status).toBe(400);
    }
  },
  {
    id: "proposal.while-open",
    what: "the same exchange asked for again while the confirmed one is in progress",
    config: { slowConfirm: true },
    detail: /^\[proposal\.while-open\] new proposal asked for while exc_[\w-]+ is in_progress after a confirm$/,
    run: async (c) => {
      const { s, operation } = await proposed(c);
      const confirmed = await call(c, s, "POST", `${c.hosts.operationsEndpoint}/${operation.operation_id}/confirm`, {
        body: { revision: operation.revision, approved_by: "user" }
      });
      expect(await confirmed.json()).toMatchObject({ state: "in_progress" });
      // The Company returns the open operation rather than proposing another (Ops 4).
      expect(await (await exchange(c, s)).json()).toMatchObject({ operation: { operation_id: operation.operation_id } });
    }
  },
  {
    id: "confirm.standing-permission-overrides-user",
    what: "a standing permission where the User must approve",
    config: { userApprovalRequired: true },
    detail: "[confirm.standing-permission-overrides-user] confirmed with a standing permission when user_approval_required is true",
    run: async (c) => {
      const { s, operation } = await proposed(c);
      return call(c, s, "POST", `${c.hosts.operationsEndpoint}/${operation.operation_id}/confirm`, {
        body: { revision: operation.revision, approved_by: "standing_permission" }
      });
    }
  }
];

describe("each check the mock Company makes", () => {
  it.each(TAMPERS.map((row) => [`${row.id}: ${row.what}`, row] as const))("records %s", async (_name, row) => {
    const c = company();
    if (row.config) await c.stub.configure(row.config);
    const response = await row.run(c);
    if (response instanceof Response) await response.body?.cancel();
    const state = await c.stub.state();
    const violations = state.recorded;
    expect(violations.map(violationId)).toEqual(row.ids ?? [row.id]);
    // Its basis files it: a failure under violations, a SHOULD, Guides or reading under warnings.
    expect(state.violations.map(violationId)).toEqual(violations.filter(isViolation).map(violationId));
    expect(state.warnings.map(violationId)).toEqual(violations.filter((entry) => !isViolation(entry)).map(violationId));
    expect(levelOfCheck(row.id) === "failure" ? state.violations : state.warnings).toContain(violations.find((entry) => violationId(entry) === row.id));
    const detail = typeof row.detail === "function" ? row.detail(c) : row.detail;
    const recorded = violations.find((violation) => violationId(violation) === row.id)!;
    if (typeof detail === "string") expect(recorded).toBe(detail);
    else if (detail) expect(recorded).toMatch(detail);
  });

  it("has a row for every violation in the catalog", () => {
    const covered = new Set(TAMPERS.map((row) => row.id));
    expect(VIOLATION_IDS.filter((id) => !covered.has(id))).toEqual([]);
    expect(TAMPERS.every((row) => row.detail !== undefined)).toBe(true);
  });

  it("catalogs every check in the mock's source, and only those", () => {
    const source = [apisSource, authSource, conversationsSource, coreSource, indexSource, operationsSource, webSource].join("\n");
    // Ids are written out where a check records them, or built from the JWT kind.
    const produced = (id: string) => {
      const [kind, check] = id.split(/\.(.*)/s) as [string, string];
      return source.includes(`"${id}"`) || source.includes(`\`\${kind}.${check}\``) && ["client-assertion", "session-assertion", "dpop", "browser-assertion"].includes(kind);
    };
    expect(VIOLATION_IDS.filter((id) => !produced(id))).toEqual([]);
    // Every literal id the source passes to a check is in the catalog (TypeScript also enforces this).
    const literals = [...source.matchAll(/"((?:[a-z]+-)*[a-z]+\.[a-z-]+)"/g)].map((match) => match[1]!);
    const known = new Set<string>(VIOLATION_IDS);
    const unknown = literals.filter((literal) => !known.has(literal) && !/\.(?:test|json|com|ts)$/.test(literal));
    expect(unknown).toEqual([]);
    // Nothing records a violation without an id.
    expect(source.match(/\bviolation\(\s*`[^`$]*`/g) ?? []).toEqual([]);
  });

  it("says what each check rests on, and files it as a violation or a warning by that basis", () => {
    // "MUST (4.3): …", "RFC (RFC 9449 4.2): …", "Guides (Retries): …": the basis, where, then what.
    const malformed = VIOLATION_IDS.filter(
      (id) => !/^(?:MUST(?: NOT)?|RFC|Rule|SHOULD(?: NOT)?|Guides|Reading) \([^)]+\)(?:, strict Company only)?: \S/.test(VIOLATIONS[id])
    );
    expect(malformed).toEqual([]);
    // docs/conformance-levels.md: MUST, RFC and Rule are failures; SHOULD and Guides warnings;
    // readings tentative. Nothing rests on a MAY.
    const expected = { MUST: "failure", RFC: "failure", Rule: "failure", SHOULD: "warning", Guides: "warning", Reading: "tentative" } as const;
    expect(VIOLATION_IDS.filter((id) => levelOfCheck(id) !== expected[basisOf(id) as keyof typeof expected])).toEqual([]);
    expect(VIOLATION_IDS.filter((id) => isViolation(`[${id}] x`) !== (levelOfCheck(id) === "failure"))).toEqual([]);
    // The S2 checks are already off in the lenient profile (strictAssertions: false), and say so.
    for (const id of VIOLATION_IDS.filter((id) => /\.(?:typ|kid)$/.test(id) && basisOf(id) === "Reading")) {
      expect(VIOLATIONS[id], id).toMatch(/strict Company only/);
    }
  });
});

describe("the mock Company", () => {
  // A signed-in User opens a conversation, which an order-related message makes the account's
  // (7.2). Then the retry of its first message id comes from a Session that has left that account:
  // another, signed-out Session of the same User, or the same Session once its Account Token is
  // revoked (7.11). The idempotency cache would hand back the original conversation and its
  // reply; the ownership gate must come first, so the retry gets sign_in_required.
  it.each(([
    {
      name: "checks conversation ownership before message-id idempotency on a signed-out retry (S8)",
      retryFrom: async (c: C) => signedOut(c)
    },
    {
      name: "checks conversation ownership before message-id idempotency on a retry after the Account Token is revoked (7.11, S8)",
      retryFrom: async (c: C, s: Awaited<ReturnType<typeof signedIn>>) => {
        const revoke = await form(c, c.hosts.revocationEndpoint, { token: s.refreshToken, token_type_hint: "refresh_token" }, null);
        expect(revoke.status).toBe(200);
        return s;
      }
    }
  ] as const).map((row) => [row.name, row] as const))("%s", async (_name, { retryFrom }) => {
    const c = company();
    const s = await signedIn(c);
    const first = message({ id: `msg_${jti()}`, text: "I'd like to exchange the jacket on my order" });
    const opened = await converse(c, s, first);
    expect(opened.status).toBe(201);
    const { conversation_id } = (await opened.json()) as { conversation_id: string };
    expect(conversation_id).toMatch(/^cnv_/);
    const retry = await call(c, await retryFrom(c, s), "POST", `${c.hosts.conversationsEndpoint}?wait=1`, { body: { message: first } });
    expect(retry.status).toBe(403);
    expect(retry.headers.get("WWW-Authenticate")).toContain("sign_in_required");
    const body = JSON.stringify(await retry.json());
    expect(JSON.parse(body)).toMatchObject({ error: "sign_in_required" });
    expect(body).not.toContain(conversation_id);
    expect(body).not.toContain("ord_7Hk2");
    // The same User retried their own message: no cross-user violation.
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("publishes poppy.json and OAuth server metadata that check out", async () => {
    const c = company();
    const document = (await (await c.call(`https://${c.hosts.domain}/.well-known/poppy.json`)).json()) as {
      protocol_version: string;
      organization: { domain: string };
      auth: { issuer: string; mediated: { endpoint: string } };
      apis: { type: string }[];
    };
    expect(document.protocol_version).toBe("0.1");
    expect(document.organization.domain).toBe(c.hosts.domain);
    expect(document.auth.issuer).toBe(c.hosts.issuer);
    expect(document.apis.map((api) => api.type)).toEqual(["graphql", "openapi", "mcp"]);
    const alt = (await (await c.call(`https://www.${c.hosts.altDomain}/.well-known/poppy.json`)).json()) as {
      organization: { domain: string };
      auth: { issuer: string };
    };
    expect(alt.organization.domain).toBe(c.hosts.altDomain);
    expect(alt.auth.issuer).toBe(c.hosts.issuer);
    const metadata = (await (
      await c.call(`${c.hosts.issuer}/.well-known/oauth-authorization-server`)
    ).json()) as { issuer: string; poppy_domains: string[]; token_endpoint: string };
    expect(metadata.issuer).toBe(c.hosts.issuer);
    expect(metadata.poppy_domains).toEqual([c.hosts.domain, c.hosts.altDomain]);
    expect(metadata.token_endpoint).toBe(c.hosts.tokenEndpoint);
  });

  it("serves an issuer with a trailing slash exactly, endpoints unchanged (S7)", async () => {
    const c = company();
    await c.stub.configure({ issuerTrailingSlash: true });
    const slashed = hostsFor(c.id, { issuerTrailingSlash: true });
    expect(slashed.issuer).toBe(`https://auth.${c.hosts.domain}/`);
    const document = (await (await c.call(`https://${c.hosts.domain}/.well-known/poppy.json`)).json()) as { auth: { issuer: string } };
    expect(document.auth.issuer).toBe(slashed.issuer);
    const metadata = (await (await c.call(`https://auth.${c.hosts.domain}/.well-known/oauth-authorization-server`)).json()) as {
      issuer: string;
      token_endpoint: string;
    };
    expect(metadata).toMatchObject({ issuer: slashed.issuer, token_endpoint: c.hosts.tokenEndpoint });
  });

  it("serves an issuer with a path, its metadata only where RFC 8414 inserts it (S3)", async () => {
    const c = company();
    await c.stub.configure({ issuerPath: "/tenant" });
    const pathed = hostsFor(c.id, { issuerPath: "/tenant" });
    expect(pathed.issuer).toBe(`https://auth.${c.hosts.domain}/tenant`);
    const document = (await (await c.call(`https://${c.hosts.domain}/.well-known/poppy.json`)).json()) as { auth: { issuer: string } };
    expect(document.auth.issuer).toBe(pathed.issuer);
    const inserted = await c.call(`https://auth.${c.hosts.domain}/.well-known/oauth-authorization-server/tenant`);
    expect(inserted.status).toBe(200);
    expect(await inserted.json()).toMatchObject({ issuer: pathed.issuer, token_endpoint: c.hosts.tokenEndpoint });
    expect((await c.call(`${pathed.issuer}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await c.call(`https://auth.${c.hosts.domain}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect(() => hostsFor(c.id, { issuerPath: "tenant/" })).toThrow(/issuerPath/);
  });

  it("rejects assertions a strict Company would, and records why", async () => {
    const cases = [
      { shape: { typ: null }, expected: 'header typ must be "JWT", got undefined' },
      { shape: { typ: "at+jwt" }, expected: 'header typ must be "JWT", got "at+jwt"' },
      { shape: { kid: null }, expected: "kid undefined names no published key" },
      { shape: { kid: "not-a-key" }, expected: 'kid "not-a-key" names no published key' },
      { shape: { lifetime: 120 }, expected: "lifetime 120s is too long" }
    ] as const;
    for (const { shape, expected } of cases) {
      const c = company();
      const response = await startSession(c, await dpopKey(), { client: await assertion(c.hosts.tokenEndpoint, CLIENT_ID, {}, shape) });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
      const violations = (await c.stub.state()).recorded;
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(expected);
    }
  });

  it("accepts the same assertions with strict checks turned off", async () => {
    const c = company();
    await c.stub.configure({ strictAssertions: false });
    const response = await startSession(c, await dpopKey(), {
      // With two published keys, an assertion without a kid can't be verified at all.
      assertion: await assertion(c.hosts.tokenEndpoint, USER_ID, {}, { typ: null }),
      client: await assertion(c.hosts.tokenEndpoint, CLIENT_ID, {}, { typ: null, lifetime: 120 })
    });
    expect(response.status).toBe(200);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("accepts a client assertion for the token endpoint or issuer unless aud must be exact (S1)", async () => {
    for (const aud of ["issuer", "tokenEndpoint"] as const) {
      const c = company();
      const response = await form(c, c.hosts.revocationEndpoint, { token: "pat_unknown" }, null, { client: await clientAssertion(c.hosts[aud]) });
      expect(response.status).toBe(200);
      expect((await c.stub.state()).recorded).toEqual([]);
    }
    const exact = company();
    await exact.stub.configure({ clientAssertionAud: "exact" });
    expect((await form(exact, exact.hosts.revocationEndpoint, { token: "pat_unknown" }, null)).status).toBe(200);
    expect((await exact.stub.state()).recorded).toEqual([]);
  });

  it("starts a signed-out Session for a correct request, with no violations", async () => {
    const c = company();
    const response = await startSession(c, await dpopKey());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const token = (await response.json()) as Record<string, unknown>;
    expect(token).toMatchObject({ token_type: "DPoP", signed_in: false, scope: "" });
    expect(token.session_id).toMatch(/^ses_/);
    const state = await c.stub.state();
    expect(state.recorded).toEqual([]);
    expect(state.userIds).toEqual([USER_ID]);
    expect(state.requests).toEqual([
      expect.objectContaining({ method: "POST", url: c.hosts.tokenEndpoint, grant: JWT_BEARER, status: 200, error: null, proofNonce: null })
    ]);
  });

  it("asks for a DPoP nonce per origin or per Company, as configured (S23)", async () => {
    for (const nonceScope of ["company", "origin"] as const) {
      const c = company();
      await c.stub.configure({ requireNonce: true, nonceScope });
      const key = await dpopKey();
      const first = await startSession(c, key);
      expect(first.status).toBe(400);
      expect(await first.json()).toMatchObject({ error: "use_dpop_nonce" });
      const authNonce = first.headers.get("DPoP-Nonce")!;
      const token = (await (await startSession(c, key, { dpop: await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { nonce: authNonce }) })).json()) as {
        access_token: string;
      };
      const s = { key, token: token.access_token, sessionId: "" };
      const api = await call(c, s, "GET", `${c.hosts.api}/products`, { proof: { nonce: authNonce } });
      if (nonceScope === "company") {
        expect(api.status).toBe(200);
      } else {
        expect(api.status).toBe(401);
        const apiNonce = api.headers.get("DPoP-Nonce")!;
        expect(apiNonce).not.toBe(authNonce);
        expect((await call(c, s, "GET", `${c.hosts.api}/products`, { proof: { nonce: apiNonce } })).status).toBe(200);
      }
      expect((await c.stub.state()).recorded).toEqual([]);
    }
  });

  it("runs a conversation, Direct Sign-In and a confirmed operation end to end", async () => {
    const c = company();
    const s = await signedOut(c);
    const conversations = c.hosts.conversationsEndpoint;
    const started = await call(c, s, "POST", `${conversations}?wait=1`, {
      body: { message: { id: `msg_${jti()}`, sender: "agent", text: "The user wants to exchange order 1042." } }
    });
    expect(started.status).toBe(201);
    const read = (await started.json()) as { conversation_id: string; events: { type: string }[] };
    expect(read.events.map((event) => event.type)).toEqual(["message", "authorization", "message"]);

    // Direct Sign-In, with the test as the User.
    const { verifier, challenge } = await pkce();
    const back = new URL(
      await c.stub.approveAuthorization(
        authorizeUrl(c, {
          response_type: "code",
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          scope: "poppy:read poppy:write",
          state: "st_1",
          code_challenge: challenge,
          code_challenge_method: "S256"
        }),
        { approve: true }
      )
    );
    expect(back.searchParams.get("iss")).toBe(c.hosts.issuer);
    expect(back.searchParams.get("state")).toBe("st_1");
    const signedIn = (await (
      await exchangeCode(c, { s, verifier, code: back.searchParams.get("code")! })
    ).json()) as { access_token: string; refresh_token: string; signed_in: boolean };
    expect(signedIn.signed_in).toBe(true);
    expect(signedIn.refresh_token).toMatch(/^pat_/);
    const now = { ...s, token: signedIn.access_token };

    const again = await call(c, now, "POST", `${conversations}/${read.conversation_id}/messages?wait=1`, {
      body: { message: { id: `msg_${jti()}`, sender: "agent", text: "Signed in. Please exchange the jacket." } }
    });
    expect(again.status).toBe(202);
    const events = (await again.json()) as { events: { type: string; message?: { operation?: { operation_id: string } } }[] };
    const operation = events.events.find((event) => event.message?.operation)?.message?.operation;
    expect(operation?.operation_id).toMatch(/^exc_/);

    const confirm = () =>
      call(c, now, "POST", `${c.hosts.operationsEndpoint}/${operation!.operation_id}/confirm`, { body: { revision: 1, approved_by: "user" } });
    expect(await (await confirm()).json()).toMatchObject({ state: "succeeded", confirmation: { approved_by: "user" } });
    expect(await (await confirm()).json()).toMatchObject({ state: "succeeded" });

    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.recorded).toEqual([]);
  });
});

// Found by the Hypothesis stateful test (test/hypothesis), each a reading the mock got wrong.
describe("the mock Company, as the Hypothesis model found it", () => {
  it("takes a retry with the message's members in another order as the same message (7.3)", async () => {
    const c = company();
    const s = await signedOut(c);
    const first = message({ data: { size: "M", colour: "blue" } });
    const created = await converse(c, s, first);
    expect(created.status).toBe(201);
    const { conversation_id } = (await created.json()) as { conversation_id: string };
    const retry = await converse(c, s, { data: { colour: "blue", size: "M" }, text: first.text, sender: first.sender, id: first.id });
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { conversation_id: string }).conversation_id).toBe(conversation_id);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("accepts every well-formed RFC 5646 locale and IANA time zone name in context (7.4)", async () => {
    const c = company();
    const s = await signedOut(c);
    const locales = ["en-US", "i-ami", "en-US-u-ca-gregory", "x-private", "de-CH-1901", "zh-Hant-TW", "sgn-BE-FR", "abcde"];
    const zones = ["CET", "EST5EDT", "Etc/GMT+5", "America/Argentina/Buenos_Aires", "UTC", "Factory", "W-SU"];
    for (const context of [...locales.map((locale) => ({ locale })), ...zones.map((time_zone) => ({ time_zone }))]) {
      expect((await converse(c, s, message({ context }))).status).toBe(201);
    }
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("signs out only the Sessions signed in with the revoked Account Token or one it rotated from (4.9)", async () => {
    const c = company();
    await c.stub.configure({ rotateRefreshTokens: true });
    const first = await signedIn(c, "poppy:read");
    const second = await signedIn(c, "poppy:read");
    // `first` renews, so its Account Token rotates; revoking the new one signs it out.
    const renewed = await form(
      c,
      c.hosts.tokenEndpoint,
      { grant_type: "refresh_token", refresh_token: first.refreshToken, session_id: first.sessionId },
      first.key
    );
    const { access_token, refresh_token } = (await renewed.json()) as { access_token: string; refresh_token: string };
    const revoke = await form(c, c.hosts.revocationEndpoint, { token: refresh_token, token_type_hint: "refresh_token" }, null);
    expect(revoke.status).toBe(200);
    const orders = (s: { key: Key; token: string; sessionId: string }) => call(c, s, "GET", `${c.hosts.api}/orders`);
    expect((await orders({ ...first, token: access_token })).headers.get("WWW-Authenticate")).toContain("sign_in_required");
    // `second` signed in on its own, with its own Account Token, so it stays signed in.
    expect((await orders(second)).status).toBe(200);
    const state = await c.stub.state();
    expect(state.sessions.map((session) => session.signedIn)).toEqual([false, true]);
    expect(state.recorded).toEqual([]);
  });

  it("revokes only the reused token's own sign-in when it detects reuse (RFC 9700 4.14.2)", async () => {
    const c = company();
    await c.stub.configure({ rotateRefreshTokens: true, reuseDetection: true });
    const first = await signedIn(c, "poppy:read");
    const second = await signedIn(c, "poppy:read");
    const refresh = () =>
      form(c, c.hosts.tokenEndpoint, { grant_type: "refresh_token", refresh_token: first.refreshToken, session_id: first.sessionId }, first.key);
    expect((await refresh()).status).toBe(200);
    expect((await refresh()).status).toBe(400);
    expect((await call(c, second, "GET", `${c.hosts.api}/orders`)).status).toBe(200);
    const state = await c.stub.state();
    expect(state.accountTokens).toBe(1);
    expect(state.recorded.map(violationId)).toEqual(["account-token.rotated-reused"]);
  });
});

describe("the mock Company's other surfaces", () => {
  it("signs in with Device Sign-In, then gets an MCP Bearer token", async () => {
    const c = company();
    const flow = await deviceFlow(c);
    expect(await (await flow.poll()).json()).toMatchObject({ error: "authorization_pending" });
    await c.stub.approveDevice(flow.device.user_code, { scopes: ["poppy:read"] });
    // A second later, by the mock's clock (which follows the agent's fake clock).
    const signedIn = (await (
      await form(c, c.hosts.tokenEndpoint, { grant_type: DEVICE_CODE, device_code: flow.device.device_code, session_id: flow.s.sessionId }, flow.s.key, {
        headers: { [CLOCK_HEADER]: String(Date.now() + 1100) }
      })
    ).json()) as { refresh_token: string; scope: string };
    expect(signedIn.scope).toBe("poppy:read");

    const bearer = (await (
      await form(c, c.hosts.tokenEndpoint, { grant_type: "refresh_token", refresh_token: signedIn.refresh_token, session_id: flow.s.sessionId, resource: c.hosts.mcpUrl }, null)
    ).json()) as { token_type: string; access_token: string };
    expect(bearer.token_type).toBe("Bearer");
    const mcp = await c.call(c.hosts.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer.access_token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    const tools = (await mcp.json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((tool) => tool.name)).toEqual(["search_products", "exchange_item"]);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("signs in with Mediated Sign-In and a one-time code", async () => {
    const c = company();
    const { s, signInId, code } = await oneTimeCode(c);
    const done = (await (await call(c, s, "POST", `${c.hosts.mediatedEndpoint}/${signInId}`, { body: { code } })).json()) as Record<string, unknown>;
    expect(done).toMatchObject({ status: "complete", signed_in: true, scope: "poppy:read" });
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("streams events with text-delta and joins a browser", async () => {
    const c = company();
    const s = await signedOut(c);
    const id = await conversation(c, s);
    const stream = await call(c, s, "GET", `${c.hosts.conversationsEndpoint}/${id}/events`, { headers: { Accept: "text/event-stream" } });
    const text = await stream.text();
    expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
    expect(text).toContain("event: text-delta");
    expect(text).toMatch(/id: evt_/);

    const join = await joinBrowser(c, await browserAssertion(c, s));
    expect(join.status).toBe(303);
    expect(join.headers.get("Set-Cookie")).toMatch(/Secure; HttpOnly; SameSite=Lax/);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("revokes an Account Token, with or without token_type_hint, and leaves the Session signed out", async () => {
    for (const hint of ["refresh_token", null] as const) {
      const c = company();
      const s = await signedIn(c, "poppy:read");
      expect((await c.stub.state()).accountTokens).toBe(1);
      const revoke = await form(c, c.hosts.revocationEndpoint, { token: s.refreshToken, ...(hint ? { token_type_hint: hint } : {}) }, null);
      expect(revoke.status).toBe(200);
      const state = await c.stub.state();
      expect(state.accountTokens).toBe(0);
      expect(state.revocationHints).toEqual([hint]);
      expect(state.sessions[0]).toMatchObject({ signedIn: false, ended: false });
      const after = await call(c, s, "GET", `${c.hosts.api}/orders`);
      expect(after.status).toBe(403);
      expect(after.headers.get("WWW-Authenticate")).toContain("sign_in_required");
      expect(state.recorded).toEqual([]);
    }
  });
});
