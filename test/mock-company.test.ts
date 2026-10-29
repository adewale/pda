import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { companyEvidence } from "./agent-helpers";
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
import { COMPANY_FLAWS, type CompanyFlaw } from "./mock-company/types";
import apisSource from "./mock-company/apis.ts?raw";
import authSource from "./mock-company/auth.ts?raw";
import conversationsSource from "./mock-company/conversations.ts?raw";
import coreSource from "./mock-company/core.ts?raw";
import indexSource from "./mock-company/index.ts?raw";
import operationsSource from "./mock-company/operations.ts?raw";
import webSource from "./mock-company/web.ts?raw";

/**
 * The mock Company itself, driven by hand-made 0.3 requests (not the
 * Personal Agent client), so a broken mock shows up here first. `TAMPERS`
 * proves every check the mock makes still fires: each row breaks one thing
 * in an otherwise correct request and expects exactly that violation.
 */

const mocks = (env as unknown as { MOCK_COMPANY: DurableObjectNamespace<MockCompany> }).MOCK_COMPANY;
const CLIENT_ID = "https://agent.test/poppy/client.json";
const REDIRECT_URI = "https://agent.test/poppy/callback";
const USER_ID = "usr_Q7c1vKx9TzLw3NdR5mHa2B";
const OTHER_USER = "usr_Hd8pW2zQ5nVb7LtK3xRc9F";
const DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
const MEDIATED = "https://personalagentprotocol.org/grant/mediated-sign-in";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const MCP_ACCEPT = { Accept: "application/json, text/event-stream" };

function company() {
  const id = `c${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const stub = mocks.getByName(id);
  const hosts = hostsFor(id);
  const call = (url: string, init?: RequestInit) => stub.fetch(new Request(url, { redirect: "manual", ...init }));
  return { id, stub, hosts, call };
}

type C = ReturnType<typeof company>;

it("pins mock evidence and refuses a fresh instance's apparently clean history", async () => {
  const c = company();
  const instanceId = await c.stub.instanceId();
  await c.call(`${c.hosts.api}/products?access_token=lost-evidence`);
  expect((await companyEvidence(c.stub, instanceId)).recorded).not.toEqual([]);
  await expect(evictDurableObject(c.stub)).rejects.toThrow("preventEviction");
  expect((await companyEvidence(c.stub, instanceId)).recorded).not.toEqual([]);
  const replacement = company().stub;
  expect((await replacement.state()).recorded).toEqual([]);
  await expect(companyEvidence(replacement, instanceId)).rejects.toThrow("protocol evidence was lost");
});

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

/** A JWT signed with our published key, as our client signs its client assertions. */
async function agentJwt(claims: Record<string, unknown>, tamper: JwtTamper = {}) {
  const { kid, key } = await agentKey();
  return signJwt({ alg: "ES256", typ: "JWT", kid, ...tamper.header }, { ...claims, ...tamper.claims }, tamper.key ?? key);
}

/** A client assertion (4.1, RFC 7523): addressed to the Company's issuer. */
function clientAssertion(c: C, tamper: JwtTamper = {}) {
  const now = seconds();
  return agentJwt({ iss: CLIENT_ID, sub: CLIENT_ID, aud: c.hosts.issuer, iat: now, exp: now + 60, jti: jti() }, tamper);
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
  /** The DPoP header: a proof from the key by default, none with null, or this exact value. */
  readonly dpop?: string | null;
  /** The client assertion: correct by default, none with null, or this exact value. */
  readonly client?: string | null;
  /** The client_id field: ours by default, none with null (optional beside an assertion, RFC 7521 4.2), or this value. */
  readonly clientId?: string | null;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
};

/** A form POST to the token, device or revocation endpoint, authenticated as our client; a DPoP proof when given a key. */
async function form(c: C, url: string, fields: Record<string, string>, key: Key | null, options: FormOptions = {}) {
  const client = options.client === undefined ? await clientAssertion(c) : options.client;
  const body = new URLSearchParams({
    ...fields,
    ...(options.clientId === null ? {} : { client_id: options.clientId ?? CLIENT_ID }),
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

/** A token request, with a DPoP proof from `key` (a fresh key by default; none with null), as the issuer's metadata asks (4.5). */
async function tokenRequest(c: C, fields: Record<string, string>, options: FormOptions & { key?: Key | null } = {}) {
  return form(c, c.hosts.tokenEndpoint, fields, options.key === undefined ? await dpopKey() : options.key, options);
}

/** A refresh with a refresh token the Company never issued: authenticated, then `invalid_grant`, with nothing recorded. */
const UNKNOWN_REFRESH = { grant_type: "refresh_token", refresh_token: "pat_unknown" };

/** A revocation (4.6); by default of a refresh token the Company never issued, which still gets 200 (RFC 7009). */
function revoke(c: C, options: FormOptions & { token?: string; hint?: string | null } = {}) {
  const hint = options.hint === undefined ? "refresh_token" : options.hint;
  return form(c, c.hosts.revocationEndpoint, { token: options.token ?? "pat_unknown", ...(hint ? { token_type_hint: hint } : {}) }, null, options);
}

// ---- Sessions (5.2): delegated keys, delegations and Session JWTs ----

/** A delegated key (5.2): an ES256 pair, its public JWK and thumbprint. */
async function delegatedKey() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, kid: await calculateJwkThumbprint(jwk), privateJwk: await exportJWK(privateKey) };
}

type Delegated = Awaited<ReturnType<typeof delegatedKey>>;

/** A delegation for `key`, signed with our published key, optionally tampered with. */
async function delegation(key: Delegated, tamper: JwtTamper = {}) {
  const { kid, key: signing } = await agentKey();
  const iat = seconds();
  return signJwt(
    { alg: "ES256", typ: "pap-delegation+jwt", kid, ...tamper.header },
    { iss: CLIENT_ID, cnf: { jwk: key.jwk }, iat, exp: iat + 3600, jti: jti(), ...tamper.claims },
    tamper.key ?? signing
  );
}

type SessionJwtTamper = JwtTamper & { readonly delegation?: JwtTamper | string };

/** A Session JWT (5.2) for one request, signed with `key`, carrying its delegation. */
async function sessionJwt(c: C, key: Delegated, request: { method: string; url: string; token?: string; sid: string; sub?: string }, tamper: SessionJwtTamper = {}) {
  const dlg = typeof tamper.delegation === "string" ? tamper.delegation : await delegation(key, tamper.delegation);
  return signJwt(
    { typ: "poppy-session+jwt", alg: "ES256", kid: key.kid, pap_dlg: dlg, ...tamper.header },
    {
      iss: CLIENT_ID,
      aud: c.hosts.issuer,
      sid: request.sid,
      sub: request.sub ?? USER_ID,
      htm: request.method,
      htu: request.url.split("?")[0],
      iat: seconds(),
      jti: jti(),
      ...(request.token ? { ath: await hash(request.token) } : {}),
      ...tamper.claims
    },
    tamper.key ?? key.privateKey
  );
}

/** Tokens from a sign-in or refresh: the access token, its type, the refresh token, and the DPoP key it is bound to. */
type Tokens = { readonly token: string; readonly tokenType: string; readonly refreshToken: string; readonly dpop: Key; readonly scope?: string };

/** A Session as the test drives it: its delegated key, sid and User ID, and tokens once signed in. */
type Session = { readonly key: Delegated; readonly sid: string; readonly sub?: string } & Partial<Tokens>;

async function session(sub?: string): Promise<Session> {
  return { key: await delegatedKey(), sid: jti(), ...(sub ? { sub } : {}) };
}

type CallOptions = {
  readonly body?: unknown;
  /** A body sent as is, with `contentType`. */
  readonly raw?: Uint8Array<ArrayBuffer> | string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
  /** The Session header: a correct JWT by default, none with null, a tampered one, or this exact value. */
  readonly jwt?: string | null | SessionJwtTamper;
  /** The access token: the Session's by default, none with null, or this one. */
  readonly token?: string | null;
  /** `Authorization`: the token with its scheme by default, none with null, or this exact value. */
  readonly auth?: string | null;
  /** The DPoP header with a DPoP-bound token: a correct proof by default, none with null, a tampered proof, or this exact value. */
  readonly proof?: string | null | (JwtTamper & { nonce?: string });
};

/** A request to a resource (5.2, 7): the Session header, and the access token when signed in, with a DPoP proof when it is DPoP-bound. */
async function call(c: C, s: Session, method: string, url: string, options: CallOptions = {}) {
  const token = options.token === undefined ? s.token : options.token ?? undefined;
  const jwt =
    options.jwt === null
      ? null
      : typeof options.jwt === "string"
        ? options.jwt
        : await sessionJwt(c, s.key, { method, url, sid: s.sid, ...(s.sub ? { sub: s.sub } : {}), ...(token ? { token } : {}) }, options.jwt ?? {});
  const bound = token !== undefined && s.tokenType === "DPoP";
  const auth = options.auth !== undefined ? options.auth : token ? `${bound ? "DPoP" : "Bearer"} ${token}` : null;
  const dpop =
    options.proof === null || !bound
      ? null
      : typeof options.proof === "string"
        ? options.proof
        : await proof(s.dpop!, method, url, token, options.proof ?? {});
  const body = options.raw ?? (options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body));
  const contentType = options.contentType ?? (options.body !== undefined ? "application/json" : undefined);
  return c.call(url, {
    method,
    headers: {
      ...(jwt !== null ? { "Poppy-Session": jwt } : {}),
      ...(auth !== null ? { Authorization: auth } : {}),
      ...(dpop !== null ? { DPoP: dpop } : {}),
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...options.headers
    },
    ...(body !== undefined ? { body } : {})
  });
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

/** A correct authorization request's parameters (4.2), with `changes` merged over them. */
async function authorizeParams(changes: Record<string, string | undefined> = {}) {
  const { challenge } = await pkce();
  return { response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: "orders:read", state: jti(), code_challenge: challenge, code_challenge_method: "S256", ...changes };
}

/** Direct Sign-In up to the code: the test plays the User approving. */
async function authorizationCode(c: C, options: { account?: string; scope?: string; other?: Other } = {}) {
  const { verifier, challenge } = await pkce();
  const redirect = options.other ? OTHER_REDIRECT : REDIRECT_URI;
  const back = new URL(
    await c.stub.approveAuthorization(
      authorizeUrl(c, {
        response_type: "code",
        client_id: options.other ? OTHER : CLIENT_ID,
        redirect_uri: redirect,
        scope: options.scope ?? "orders:read orders:write",
        state: jti(),
        code_challenge: challenge,
        code_challenge_method: "S256"
      }),
      { approve: true, ...(options.account ? { account: options.account } : {}) }
    )
  );
  return { verifier, redirect, code: back.searchParams.get("code")! };
}

/** The code's token request (4.2), as our client or `other`. */
async function exchangeCode(c: C, flow: Awaited<ReturnType<typeof authorizationCode>>, key: Key | null, fields: Record<string, string | undefined> = {}, other?: Other) {
  return tokenRequest(
    c,
    defined({ grant_type: "authorization_code", code: flow.code, redirect_uri: flow.redirect, code_verifier: flow.verifier, ...fields }) as Record<string, string>,
    { key, ...(other ? { clientId: OTHER, client: await other.clientAssertion() } : {}) }
  );
}

async function tokensFrom(response: Response, dpop: Key): Promise<Tokens> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token: string; token_type: string; refresh_token: string; scope?: string };
  return { token: body.access_token, tokenType: body.token_type, refreshToken: body.refresh_token, dpop, ...(body.scope !== undefined ? { scope: body.scope } : {}) };
}

type SignInOptions = { account?: string; scope?: string; resource?: string; other?: Other; /** Send no DPoP proof, for a Bearer token where the issuer doesn't ask for one (`dpopTokens: false`). */ bearer?: boolean };

/** Direct Sign-In (4.2): the tokens, DPoP-bound unless for the MCP server (`resource`) or `bearer`. */
async function signIn(c: C, options: SignInOptions = {}): Promise<Tokens> {
  const flow = await authorizationCode(c, options);
  const key = await dpopKey();
  return tokensFrom(await exchangeCode(c, flow, options.bearer ? null : key, options.resource ? { resource: options.resource } : {}, options.other), key);
}

/** A Session signed in with Direct Sign-In. */
async function signedIn(c: C, options: SignInOptions & { sub?: string } = {}): Promise<Session> {
  return { ...(await session(options.sub)), ...(await signIn(c, options)) };
}

/** A refresh (4.4) with this Session's refresh token and DPoP key. */
function refresh(c: C, s: Session, fields: Record<string, string> = {}) {
  return tokenRequest(c, { grant_type: "refresh_token", refresh_token: s.refreshToken!, ...fields }, { key: s.dpop! });
}

/** Mediated Sign-In's grant at the token endpoint (Mediated Sign-In 3, 4). */
function mediated(c: C, fields: Record<string, string>, options: FormOptions & { key?: Key | null } = {}) {
  return tokenRequest(c, { grant_type: MEDIATED, ...fields }, options);
}

const ADA = { email: "ada@example.com", password: "correct horse" };
const GRACE = { email: "grace@example.com", password: "battery staple" };

/** Mediated Sign-In as Grace, who gets a one-time code; returns the sign-in id and the code. */
async function oneTimeCode(c: C) {
  const first = (await (await mediated(c, { scope: "orders:read", ...GRACE })).json()) as { error: string; sign_in_id: string };
  expect(first.error).toBe("code_required");
  return { signInId: first.sign_in_id, code: (await c.stub.lastOneTimeCode())! };
}

/** Device Sign-In started (4.3); `poll` polls the token endpoint once, with one DPoP key throughout. */
async function deviceFlow(c: C, config: Partial<MockConfig> = {}) {
  await c.stub.configure({ deviceInterval: 1, ...config });
  const device = (await (await form(c, c.hosts.deviceEndpoint, { scope: "orders:read" }, null)).json()) as { device_code: string; user_code: string };
  const key = await dpopKey();
  const poll = (headers: Record<string, string> = {}) => tokenRequest(c, { grant_type: DEVICE_CODE, device_code: device.device_code }, { key, headers });
  return { device, key, poll };
}

/** The browser join (6), step 1: the page's code and the cookie set with it. */
async function joinPage(c: C) {
  const page = await c.call(c.hosts.browserSessionEndpoint);
  const code = /name="code" value="([^"]+)"/.exec(await page.text())![1]!;
  const cookie = page.headers.get("Set-Cookie")!.split(";")[0]!;
  return { page, code, cookie };
}

/** Step 2: the agent authorizes the code with its Session header. */
function authorizeJoin(c: C, s: Session, code: string, init: { body?: string; contentType?: string } = {}) {
  return call(c, s, "POST", `${c.hosts.browserSessionEndpoint}/authorize`, init.body !== undefined ? { raw: init.body, contentType: init.contentType ?? "application/json" } : { body: { code } });
}

/** Step 3: the browser submits the form, with the cookie from step 1. */
function submitJoin(c: C, code: string, cookie: string | null, init: { contentType?: string; body?: string } = {}) {
  return c.call(c.hosts.browserSessionEndpoint, {
    method: "POST",
    headers: { "Content-Type": init.contentType ?? "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
    body: init.body ?? new URLSearchParams({ code }).toString()
  });
}

/** A browser joined to `s`: the Session's cookie. */
async function joinBrowser(c: C, s: Session): Promise<string> {
  const { code, cookie } = await joinPage(c);
  expect((await authorizeJoin(c, s, code)).status).toBe(204);
  const submitted = await submitJoin(c, code, cookie);
  expect(submitted.status).toBe(303);
  return /mock_sid=[^;]+/.exec(submitted.headers.get("Set-Cookie")!)![0];
}

/** A message from the Personal Agent (8.4), with `fields` merged over a correct one. */
function message(fields: Record<string, unknown> = {}) {
  return defined({ id: `msg_${jti()}`, author: { type: "agent" }, text: "Hello", ...fields });
}

/** Start a conversation with `message` (8.3). */
function converse(c: C, s: Session, body: unknown, extra: Record<string, unknown> = {}) {
  return call(c, s, "POST", c.hosts.conversationsEndpoint, { body: { message: body, ...extra } });
}

async function conversation(c: C, s: Session) {
  return ((await (await converse(c, s, message())).json()) as { conversation_id: string }).conversation_id;
}

const EXCHANGE = { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" };

function exchange(c: C, s: Session, headers: Record<string, string> = {}, body: unknown = EXCHANGE) {
  return call(c, s, "POST", `${c.hosts.api}/orders/ord_7Hk2/exchanges`, { body, headers });
}

type Operation = { operation_id: string; revision: string; summary: string; terms?: Record<string, unknown>; expires_at: string };

/** A signed-in Session whose exchange came back `approval_required` with this operation (Ops 4). */
async function refused(c: C, s?: Session) {
  const signed = s ?? (await signedIn(c));
  const response = await exchange(c, signed);
  expect(response.status).toBe(403);
  const body = (await response.json()) as { error: string; operation: Operation };
  expect(body.error).toBe("approval_required");
  return { s: signed, operation: body.operation };
}

function approval(operation: Pick<Operation, "operation_id" | "revision">) {
  return { "Poppy-Approval": `operation_id="${operation.operation_id}", revision="${operation.revision}"` };
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
function uploadPhoto(c: C, s: Session, body: Uint8Array<ArrayBuffer>, contentType: string) {
  return call(c, s, "POST", `${c.hosts.api}/photos`, { raw: body, contentType });
}

const PHOTO = () => multipart("b0undary", 'form-data; name="photo"; filename="lake.jpg"');
const PHOTO_TYPE = "multipart/form-data; boundary=b0undary";

/** An order of prints of `photoId`, as the print shop's description asks for it. */
function printOrder(photoId: string, copies = 1) {
  return {
    email: "ada@example.com",
    ship_to: { name: "Ada Lovelace", line1: "12 St James's Square", city: "London", postal_code: "SW1Y 4JH", country: "GB" },
    items: [{ photo_id: photoId, copies }]
  };
}

async function uploaded(c: C, s: Session): Promise<string> {
  const response = await uploadPhoto(c, s, PHOTO(), PHOTO_TYPE);
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

function orderPrints(c: C, s: Session, body: unknown, headers: Record<string, string> = {}) {
  return call(c, s, "POST", `${c.hosts.api}/prints`, { body, headers });
}

function feedback(c: C, s: Session, body: unknown) {
  return call(c, s, "POST", `${c.hosts.api}/poppy/feedback`, { body });
}

const REPORT = { task: "Pay with a gift card", description: "The User wanted to pay with a gift card, and neither the API nor the Company Agent can apply one." };

/** A second Personal Agent, its metadata and JWKS served by the test, optionally broken. */
const OTHER = "https://other.agent.test/poppy/client.json";
const OTHER_JWKS = "https://other.agent.test/poppy/jwks.json";
const OTHER_REDIRECT = "https://other.agent.test/poppy/callback";

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
      redirect_uris: [OTHER_REDIRECT],
      token_endpoint_auth_method: "private_key_jwt",
      ...broken.metadata
    },
    broken.status ?? 200
  );
  await c.stub.serveClientDocument(OTHER_JWKS, broken.jwks ?? { keys: [jwk] }, broken.jwksStatus ?? 200);
  return {
    clientAssertion: () => {
      const now = seconds();
      return signJwt({ alg: "ES256", typ: "JWT", kid: kid ?? undefined }, { iss: OTHER, sub: OTHER, aud: c.hosts.issuer, iat: now, exp: now + 60, jti: jti() }, privateKey);
    }
  };
}

type Other = Awaited<ReturnType<typeof otherClient>>;

/** A revocation as the other client, which fetches its metadata. */
async function revokeAsOther(c: C, other: Other) {
  return revoke(c, { clientId: OTHER, client: await other.clientAssertion() });
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
const products = (c: C) => `${c.hosts.api}/products`;
const orders = (c: C) => `${c.hosts.api}/orders`;
/** A signed-out GET /products with the Session header as given. */
const getProducts = async (c: C, jwt: CallOptions["jwt"], s?: Session) => call(c, s ?? (await session()), "GET", products(c), { jwt });
/** A signed-in GET /orders, as given. */
const getOrders = async (c: C, options: CallOptions = {}, s?: Session) => call(c, s ?? (await signedIn(c)), "GET", orders(c), options);
const BEARER: Partial<MockConfig> = { dpopTokens: false };

/**
 * One row per check in the mock. Each makes a correct 0.3 request with one
 * thing broken; the test asserts the mock recorded exactly that violation.
 */
const TAMPERS: readonly Tamper[] = [
  // ---- jti ----
  {
    id: "client-assertion.jti-missing",
    what: "a client assertion without jti",
    detail: "[client-assertion.jti-missing] client-assertion: missing jti",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { claims: { jti: undefined } }) })
  },
  {
    id: "client-assertion.jti-weak",
    what: "a client assertion jti of 64 bits",
    detail: '[client-assertion.jti-weak] client-assertion: jti "abcdefgh" is not 128 random bits of base64url',
    run: async (c) => expect((await revoke(c, { client: await clientAssertion(c, { claims: { jti: "abcdefgh" } }) })).status).toBe(200)
  },
  {
    id: "client-assertion.jti-reused",
    what: "the same client assertion twice",
    detail: /^\[client-assertion\.jti-reused\] client-assertion: reused jti [\w-]{22}$/,
    run: async (c) => {
      const client = await clientAssertion(c);
      expect((await revoke(c, { client })).status).toBe(200);
      return revoke(c, { client });
    }
  },
  {
    id: "dpop.jti-missing",
    what: "a DPoP proof without jti",
    detail: "[dpop.jti-missing] dpop: missing jti",
    run: async (c) => {
      const key = await dpopKey();
      return tokenRequest(c, UNKNOWN_REFRESH, { key, dpop: await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { claims: { jti: undefined } }) });
    }
  },
  {
    id: "dpop.jti-weak",
    what: "a DPoP proof jti of 64 bits",
    detail: '[dpop.jti-weak] dpop: jti "abcdefgh" is not 128 random bits of base64url',
    run: async (c) => {
      const key = await dpopKey();
      const response = await tokenRequest(c, UNKNOWN_REFRESH, { key, dpop: await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { claims: { jti: "abcdefgh" } }) });
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
  },
  {
    id: "dpop.jti-reused",
    what: "the same DPoP proof twice",
    detail: /^\[dpop\.jti-reused\] dpop: reused jti [\w-]{22}$/,
    run: async (c) => {
      const s = await signedIn(c);
      const dpop = await proof(s.dpop!, "GET", orders(c), s.token);
      expect((await getOrders(c, { proof: dpop }, s)).status).toBe(200);
      return getOrders(c, { proof: dpop }, s);
    }
  },
  { id: "session-jwt.jti-missing", what: "a Session JWT without jti", detail: "[session-jwt.jti-missing] session-jwt: missing jti", run: (c) => getProducts(c, { claims: { jti: undefined } }) },
  {
    id: "session-jwt.jti-weak",
    what: "a Session JWT jti of 64 bits",
    detail: '[session-jwt.jti-weak] session-jwt: jti "abcdefgh" is not 128 random bits of base64url',
    run: async (c) => expect((await getProducts(c, { claims: { jti: "abcdefgh" } })).status).toBe(200)
  },
  {
    id: "session-jwt.jti-reused",
    what: "the same Session JWT twice",
    detail: /^\[session-jwt\.jti-reused\] session-jwt: reused jti [\w-]{22}$/,
    run: async (c) => {
      const s = await session();
      const jwt = await sessionJwt(c, s.key, { method: "GET", url: products(c), sid: s.sid });
      expect((await getProducts(c, jwt, s)).status).toBe(200);
      return getProducts(c, jwt, s);
    }
  },

  // ---- Client assertions (4.1) ----
  {
    id: "client-assertion.alg",
    what: "a client assertion signed with HS256",
    detail: "[client-assertion.alg] client assertion: alg HS256 is not allowed",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { header: { alg: "HS256" }, key: await hmacKey() }) })
  },
  {
    id: "client-assertion.embedded-key",
    what: "a client assertion carrying its own jwk",
    detail: "[client-assertion.embedded-key] client assertion: embeds or points to a key (jku/x5u/jwk)",
    run: async (c) => expect((await revoke(c, { client: await clientAssertion(c, { header: { jwk: (await dpopKey()).jwk } }) })).status).toBe(200)
  },
  {
    id: "client-assertion.typ",
    what: 'a client assertion with typ "at+jwt"',
    detail: '[client-assertion.typ] client assertion: strict Company: header typ must be "JWT", got "at+jwt"',
    run: async (c) => revoke(c, { client: await clientAssertion(c, { header: { typ: "at+jwt" } }) })
  },
  {
    id: "client-assertion.kid",
    what: "a client assertion whose kid names no key",
    detail: '[client-assertion.kid] client assertion: strict Company: kid "not-a-key" names no published key',
    run: async (c) => revoke(c, { client: await clientAssertion(c, { header: { kid: "not-a-key" } }) })
  },
  {
    id: "client-assertion.signature",
    what: "a client assertion signed with an unpublished key",
    detail: "[client-assertion.signature] client assertion: signature verification failed",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { key: await strangerKey() }) })
  },
  {
    id: "client-assertion.iat-exp-missing",
    what: "a client assertion without iat",
    detail: "[client-assertion.iat-exp-missing] client assertion: iat and exp are required",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { claims: { iat: undefined } }) })
  },
  {
    id: "client-assertion.lifetime",
    what: "a client assertion valid for 120 s",
    detail: "[client-assertion.lifetime] client assertion: lifetime 120s is too long (at most 60s)",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { claims: lifetime(120) }) })
  },
  {
    id: "client-assertion.lifetime",
    what: "a client assertion valid for 301 s at a lenient Company",
    config: { strictAssertions: false },
    detail: "[client-assertion.lifetime] client assertion: lifetime 301s is too long (at most 300s)",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { claims: lifetime(301) }) })
  },
  {
    id: "client-assertion.missing",
    what: "a revocation without a client assertion",
    detail: (c) => `[client-assertion.missing] no client assertion at ${c.hosts.revocationEndpoint}`,
    run: async (c) => revoke(c, { client: null })
  },
  {
    id: "client-assertion.missing",
    what: "a token request without a client assertion",
    detail: (c) => `[client-assertion.missing] no client assertion at ${c.hosts.tokenEndpoint}`,
    run: async (c) => tokenRequest(c, UNKNOWN_REFRESH, { client: null })
  },
  {
    id: "client-assertion.not-jwt",
    what: "a client assertion that isn't a JWT",
    detail: "[client-assertion.not-jwt] client assertion: not a JWT",
    run: async (c) => revoke(c, { client: "not.a.jwt" })
  },
  {
    id: "client-assertion.wrong-typ",
    what: "a delegation as the client assertion",
    detail: "[client-assertion.wrong-typ] client assertion has typ pap-delegation+jwt",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { header: { typ: "pap-delegation+jwt" } }) })
  },
  {
    id: "client-assertion.wrong-typ",
    what: "a DPoP proof as the client assertion",
    detail: "[client-assertion.wrong-typ] client assertion has typ dpop+jwt",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { header: { typ: "dpop+jwt" } }) })
  },
  {
    id: "client-assertion.aud-array",
    what: "a client assertion whose aud is an array",
    detail: "[client-assertion.aud-array] client assertion: aud is an array",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { claims: { aud: [c.hosts.issuer] } }) })
  },
  {
    id: "client-assertion.aud",
    what: "a client assertion for the token endpoint, not the issuer",
    detail: (c) => `[client-assertion.aud] client assertion: aud "${c.hosts.tokenEndpoint}" is not the issuer ${c.hosts.issuer}`,
    run: async (c) => revoke(c, { client: await clientAssertion(c, { claims: { aud: c.hosts.tokenEndpoint } }) })
  },
  {
    id: "client-assertion.aud",
    what: "a client assertion for another Company",
    detail: (c) => `[client-assertion.aud] client assertion: aud "https://auth.other.shop.test" is not the issuer ${c.hosts.issuer}`,
    run: async (c) => revoke(c, { client: await clientAssertion(c, { claims: { aud: "https://auth.other.shop.test" } }) })
  },
  {
    id: "client-assertion.iss-sub",
    what: "a client assertion whose sub isn't the client_id",
    detail: "[client-assertion.iss-sub] client assertion: iss and sub must both be the client_id",
    run: async (c) => revoke(c, { client: await clientAssertion(c, { claims: { sub: USER_ID } }) })
  },

  // ---- User IDs (5.1) ----
  {
    id: "user-id.personal",
    what: "an email address as the User ID",
    detail: '[user-id.personal] User ID "ada@example.com" contains personal information',
    run: async (c) => expect((await getProducts(c, undefined, await session("ada@example.com"))).status).toBe(200)
  },
  {
    id: "user-id.personal",
    what: "the User's name as a word in the User ID",
    detail: '[user-id.personal] User ID "usr_ada_7" contains personal information',
    run: async (c) => {
      // Random ids that merely contain the letters are fine: this one has "ADA" inside,
      // and the next has "adA" as a word between `_` and the end, as 128 random bits may.
      for (const sub of ["usr_rTcRuOEIIRADAIQTZPEmrA", "usr_hB1U-xQz3FnJ1q7J8u_adA"]) {
        expect((await getProducts(c, undefined, await session(sub))).status).toBe(200);
        expect((await c.stub.state()).recorded, sub).toEqual([]);
      }
      return getProducts(c, undefined, await session("usr_ada_7"));
    }
  },

  // ---- Client metadata (4.1), as a second client the test serves ----
  {
    id: "client-metadata.not-url",
    what: "a client_id that isn't a URL",
    detail: '[client-metadata.not-url] client metadata: client_id "not a url" is not a URL',
    run: async (c) => revoke(c, { clientId: "not a url" })
  },
  {
    id: "client-metadata.not-https",
    what: "an http client_id",
    detail: "[client-metadata.not-https] client metadata: client_id must be an https URL",
    run: async (c) => revoke(c, { clientId: "http://agent.test/poppy/client.json" })
  },
  {
    id: "client-metadata.fetch-status",
    what: "a client_id that redirects",
    detail: "[client-metadata.fetch-status] client metadata: fetching client_id returned 302; it must not redirect",
    run: async (c) => revokeAsOther(c, await otherClient(c, { raw: "", status: 302 }))
  },
  {
    id: "client-metadata.not-json",
    what: "client metadata that isn't JSON",
    detail: "[client-metadata.not-json] client metadata: client metadata is not JSON",
    run: async (c) => revokeAsOther(c, await otherClient(c, { raw: "<html>" }))
  },
  {
    id: "client-metadata.client-id-mismatch",
    what: "client metadata naming another client_id",
    detail: "[client-metadata.client-id-mismatch] client metadata: client_id in the document doesn't equal the URL it was fetched from",
    run: async (c) => revokeAsOther(c, await otherClient(c, { metadata: { client_id: CLIENT_ID } }))
  },
  {
    id: "client-metadata.jwks-uri",
    what: "a jwks_uri on another domain",
    detail: "[client-metadata.jwks-uri] client metadata: jwks_uri must be https on the client_id domain",
    run: async (c) => revokeAsOther(c, await otherClient(c, { metadata: { jwks_uri: "https://elsewhere.test/jwks.json" } }))
  },
  {
    id: "client-metadata.redirect-uris",
    what: "an http redirect_uri that isn't loopback",
    detail: "[client-metadata.redirect-uris] client metadata: redirect_uris must be https on the client_id domain",
    run: async (c) => revokeAsOther(c, await otherClient(c, { metadata: { redirect_uris: ["http://other.agent.test/poppy/callback"] } }))
  },
  {
    id: "client-metadata.auth-method",
    what: "token_endpoint_auth_method client_secret_basic",
    detail: "[client-metadata.auth-method] client metadata: token_endpoint_auth_method should be private_key_jwt",
    run: async (c) => expect((await revokeAsOther(c, await otherClient(c, { metadata: { token_endpoint_auth_method: "client_secret_basic" } }))).status).toBe(200)
  },
  {
    id: "client-metadata.jwks-status",
    what: "a jwks_uri that answers 404",
    detail: "[client-metadata.jwks-status] client metadata: jwks_uri returned 404",
    run: async (c) => revokeAsOther(c, await otherClient(c, { jwksStatus: 404 }))
  },
  {
    id: "client-metadata.jwks-empty",
    what: "a JWKS with no keys",
    detail: "[client-metadata.jwks-empty] client metadata: JWKS has no keys",
    run: async (c) => revokeAsOther(c, await otherClient(c, { jwks: { keys: [] } }))
  },
  {
    id: "client-metadata.jwks-private",
    what: "a JWKS publishing a private key",
    detail: "[client-metadata.jwks-private] client metadata: JWKS publishes a private key",
    run: async (c) => {
      const { privateKey } = await generateKeyPair("ES256", { extractable: true });
      return revokeAsOther(c, await otherClient(c, { jwks: { keys: [{ ...(await exportJWK(privateKey)), kid: "other-1" }] } }));
    }
  },
  {
    id: "client-metadata.key-without-kid",
    what: "a JWKS key without kid, at a lenient Company",
    config: { strictAssertions: false },
    detail: "[client-metadata.key-without-kid] client metadata: JWKS key without kid (Guides: give every key a kid)",
    run: async (c) => expect((await revokeAsOther(c, await otherClient(c, { kid: null }))).status).toBe(200)
  },

  // ---- DPoP proofs for DPoP-bound access tokens (4.5, RFC 9449) ----
  { id: "dpop.missing", what: "a DPoP-bound token without a proof", detail: "[dpop.missing] DPoP: missing DPoP header (GET /orders)", run: (c) => getOrders(c, { proof: null }) },
  {
    id: "dpop.multiple",
    what: "two DPoP proofs in one header",
    detail: "[dpop.multiple] DPoP: more than one DPoP proof (GET /orders)",
    run: async (c) => {
      const s = await signedIn(c);
      return getOrders(c, { proof: `${await proof(s.dpop!, "GET", orders(c), s.token)}, ${await proof(s.dpop!, "GET", orders(c), s.token)}` }, s);
    }
  },
  { id: "dpop.not-jwt", what: "a DPoP proof that isn't a JWT", detail: "[dpop.not-jwt] DPoP: proof is not a JWT (GET /orders)", run: (c) => getOrders(c, { proof: "not-a-jwt" }) },
  { id: "dpop.typ", what: 'a DPoP proof with typ "JWT"', detail: "[dpop.typ] DPoP: typ is JWT (GET /orders)", run: (c) => getOrders(c, { proof: { header: { typ: "JWT" } } }) },
  {
    id: "dpop.alg",
    what: "a DPoP proof signed with ES384",
    detail: "[dpop.alg] DPoP: alg ES384 not allowed (GET /orders)",
    run: async (c) => {
      const { privateKey, publicKey } = await generateKeyPair("ES384");
      return getOrders(c, { proof: { header: { alg: "ES384", jwk: await exportJWK(publicKey) }, key: privateKey } });
    }
  },
  { id: "dpop.no-jwk", what: "a DPoP proof without its jwk", detail: "[dpop.no-jwk] DPoP: no jwk in header (GET /orders)", run: (c) => getOrders(c, { proof: { header: { jwk: undefined } } }) },
  {
    id: "dpop.private-jwk",
    what: "a DPoP proof whose jwk is the private key",
    detail: "[dpop.private-jwk] DPoP: jwk contains a private key (GET /orders)",
    run: async (c) => {
      const { privateKey } = await generateKeyPair("ES256", { extractable: true });
      return getOrders(c, { proof: { header: { jwk: await exportJWK(privateKey) }, key: privateKey } });
    }
  },
  {
    id: "dpop.signature",
    what: "a DPoP proof signed by a key other than its jwk",
    detail: "[dpop.signature] DPoP: signature: signature verification failed (GET /orders)",
    run: async (c) => getOrders(c, { proof: { key: await strangerKey() } })
  },
  { id: "dpop.htm", what: "a DPoP proof for POST on a GET", detail: "[dpop.htm] DPoP: htm POST != GET (GET /orders)", run: (c) => getOrders(c, { proof: { claims: { htm: "POST" } } }) },
  {
    id: "dpop.htu",
    what: "a DPoP proof whose htu keeps the query",
    detail: (c) => `[dpop.htu] DPoP: htu ${c.hosts.api}/orders?q=jacket != ${c.hosts.api}/orders (GET /orders)`,
    run: async (c) => call(c, await signedIn(c), "GET", `${orders(c)}?q=jacket`, { proof: { claims: { htu: `${orders(c)}?q=jacket` } } })
  },
  { id: "dpop.iat", what: "a DPoP proof made ten minutes ago", detail: "[dpop.iat] DPoP: iat outside the acceptance window (GET /orders)", run: (c) => getOrders(c, { proof: { claims: { iat: seconds() - 600 } } }) },
  {
    id: "dpop.ath",
    what: "a DPoP proof whose ath is for another token",
    detail: "[dpop.ath] DPoP: ath doesn't match the token (GET /orders)",
    run: async (c) => getOrders(c, { proof: { claims: { ath: await hash("at_other") } } })
  },
  {
    id: "dpop.nonce-ignored",
    what: "a proof, a second after using the nonce, without it",
    config: { requireNonce: true },
    detail: (c) => `[dpop.nonce-ignored] DPoP: proof without the nonce this key already used at ${new URL(c.hosts.tokenEndpoint).origin} (must keep using nonces)`,
    run: async (c) => {
      const key = await dpopKey();
      const send = (dpop: string) => tokenRequest(c, UNKNOWN_REFRESH, { key, dpop });
      const first = await tokenRequest(c, UNKNOWN_REFRESH, { key });
      expect(await first.json()).toMatchObject({ error: "use_dpop_nonce" });
      const nonce = first.headers.get("DPoP-Nonce")!;
      const now = seconds();
      // With the nonce, the proof passes, and the unknown refresh token is refused.
      expect(await (await send(await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { nonce, claims: { iat: now } }))).json()).toMatchObject({ error: "invalid_grant" });
      // Made in the same second, it may have been in flight before the nonce arrived: excused.
      expect(await (await send(await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { claims: { iat: now } }))).json()).toMatchObject({ error: "use_dpop_nonce" });
      expect((await c.stub.state()).recorded).toEqual([]);
      return send(await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { claims: { iat: now + 1 } }));
    }
  },
  {
    id: "dpop.key-mismatch",
    what: "a correct proof from a key the token isn't bound to",
    detail: "[dpop.key-mismatch] DPoP proof key isn't the key the token is bound to",
    run: async (c) => {
      const s = await signedIn(c);
      return getOrders(c, {}, { ...s, dpop: await dpopKey() });
    }
  },

  // ---- Access tokens at resources (4.5, 7) ----
  {
    id: "resource.bearer-scheme",
    what: "a DPoP-bound token with the Bearer scheme",
    detail: "[resource.bearer-scheme] Bearer scheme for a DPoP-bound token on /orders",
    run: async (c) => {
      const s = await signedIn(c);
      return getOrders(c, { auth: `Bearer ${s.token}`, proof: null }, s);
    }
  },
  {
    id: "resource.bearer-scheme",
    what: "a Bearer token with the DPoP scheme",
    config: BEARER,
    detail: "[resource.bearer-scheme] DPoP scheme for a Bearer token on /orders",
    run: async (c) => {
      const s = await signedIn(c, { bearer: true });
      expect(s.tokenType).toBe("Bearer");
      return getOrders(c, { auth: `DPoP ${s.token}` }, s);
    }
  },
  {
    id: "mcp.wrong-token",
    what: "the default access token at the MCP server",
    config: BEARER,
    detail: "[mcp.wrong-token] MCP request with a token not issued for this MCP server",
    run: async (c) => call(c, await signedIn(c, { bearer: true }), "POST", c.hosts.mcpUrl, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: MCP_ACCEPT })
  },
  {
    id: "mcp.accept",
    what: "an MCP request that only Accepts JSON",
    detail: '[mcp.accept] MCP request must Accept application/json and text/event-stream, got "application/json"',
    run: async (c) => {
      const response = await call(c, await session(), "POST", c.hosts.mcpUrl, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers: { Accept: "application/json" } });
      expect(response.status).toBe(200);
    }
  },

  // ---- Rate limits and secrets (5.6, 10.2; Mediated Sign-In 6) ----
  {
    id: "rate-limit.retry-after-ignored",
    what: "a retry before Retry-After elapsed",
    config: { rateLimit: { tokenRequests429: 0, requests429: 1, retryAfterSeconds: 1 } },
    detail: /^\[rate-limit\.retry-after-ignored\] sent GET \/products \d+ ms before Retry-After elapsed$/,
    run: async (c) => {
      const s = await session();
      const first = await call(c, s, "GET", products(c));
      expect(first.status).toBe(429);
      expect(first.headers.get("Retry-After")).toBe("1");
      return call(c, s, "GET", products(c));
    }
  },
  {
    id: "rate-limit.retry-after-ignored",
    what: "a retry before Retry-After elapsed on the fake clock",
    config: { rateLimit: { tokenRequests429: 1, requests429: 0, retryAfterSeconds: 2 } },
    detail: /^\[rate-limit\.retry-after-ignored\] sent POST \/oauth\/token \d+ ms before Retry-After elapsed$/,
    run: async (c) => {
      expect((await tokenRequest(c, UNKNOWN_REFRESH)).status).toBe(429);
      // One second on is still too soon; three seconds on is fine.
      expect((await tokenRequest(c, UNKNOWN_REFRESH, { headers: { [CLOCK_HEADER]: String(Date.now() + 1000) } })).status).toBe(429);
      expect(await (await tokenRequest(c, UNKNOWN_REFRESH, { headers: { [CLOCK_HEADER]: String(Date.now() + 3100) } })).json()).toMatchObject({ error: "invalid_grant" });
    }
  },
  {
    id: "rate-limit.shared-limit-ignored",
    what: "a different request inside another request's Retry-After",
    config: { rateLimit: { tokenRequests429: 1, requests429: 0, retryAfterSeconds: 2 } },
    detail: /^\[rate-limit\.shared-limit-ignored\] sent GET \/products \d+ ms before another request's Retry-After elapsed$/,
    run: async (c) => {
      expect((await tokenRequest(c, UNKNOWN_REFRESH)).status).toBe(429);
      const read = await call(c, await session(), "GET", products(c));
      expect(read.status).toBe(429);
      expect(Number(read.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    }
  },
  {
    id: "secret.password",
    what: "a password in a header to the website",
    detail: (c) => `[secret.password] password sent in headers of GET ${SITE(c)}/`,
    run: async (c) => c.call(`${SITE(c)}/`, { headers: { "X-Note": "correct horse" } })
  },
  {
    id: "secret.password",
    what: "a password in a conversation message",
    detail: (c) => `[secret.password] password sent in body of POST ${c.hosts.conversationsEndpoint}`,
    run: async (c) => expect((await converse(c, await session(), message({ text: "My password is correct horse" }))).status).toBe(201)
  },
  {
    id: "secret.one-time-code",
    what: "a one-time code in the body of a conversation",
    detail: (c) => `[secret.one-time-code] one-time code sent in body of POST ${c.hosts.conversationsEndpoint}`,
    run: async (c) => {
      const { code } = await oneTimeCode(c);
      return converse(c, await session(), message({ text: `My code is ${code}` }));
    }
  },
  {
    id: "secret.account-token",
    what: "a refresh token in a header to an API",
    detail: (c) => `[secret.account-token] refresh token sent in headers of GET ${c.hosts.api}/orders`,
    run: async (c) => {
      const s = await signedIn(c);
      expect((await getOrders(c, { headers: { "X-Refresh": s.refreshToken! } }, s)).status).toBe(200);
    }
  },
  {
    id: "secret.token-in-url",
    what: "an access token in the query string",
    detail: /^\[secret\.token-in-url\] token sent in URL https:\/\/api\.\w+\.shop\.test\/products\?access_token=at_[\w-]+$/,
    run: async (c) => {
      const s = await signedIn(c);
      return call(c, s, "GET", `${products(c)}?access_token=${s.token}`, { token: null });
    }
  },

  // ---- Token endpoint and refresh tokens (4.4, 4.6) ----
  {
    id: "form.not-form",
    what: "a revocation as JSON",
    detail: '[form.not-form] /oauth/revoke sent as "application/json", not a form',
    run: async (c) => revoke(c, { contentType: "application/json" })
  },
  {
    id: "account-token.other-client",
    what: "a refresh token used by another client_id",
    detail: "[account-token.other-client] refresh token used by a different client_id",
    run: async (c) => {
      const s = await signedIn(c);
      const other = await otherClient(c);
      return tokenRequest(c, { grant_type: "refresh_token", refresh_token: s.refreshToken! }, { key: s.dpop!, clientId: OTHER, client: await other.clientAssertion() });
    }
  },
  {
    id: "account-token.rotated-reused",
    what: "a refresh token used after it rotated",
    config: { rotateRefreshTokens: true },
    detail: "[account-token.rotated-reused] used a refresh token after the Company rotated it (4.4)",
    run: async (c) => {
      const s = await signedIn(c);
      expect((await refresh(c, s)).status).toBe(200);
      return refresh(c, s);
    }
  },
  {
    id: "token.dpop-not-sent",
    what: "a refresh without a DPoP proof where the issuer asks for one",
    detail: /^\[token\.dpop-not-sent\] token request \(refresh_token\) without a DPoP proof/,
    run: (c) => tokenRequest(c, UNKNOWN_REFRESH, { key: null })
  },

  // ---- Sign-in (4.2, 4.3, 4.7; Mediated Sign-In) ----
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
    run: async (c) => c.call(authorizeUrl(c, await authorizeParams({ scope: undefined })))
  },
  {
    id: "signin.no-scope",
    what: "a mediated sign-in without scope",
    detail: "[signin.no-scope] mediated sign-in without scope",
    run: async (c) => mediated(c, ADA)
  },
  {
    id: "authorize.redirect-uri",
    what: "an unregistered redirect_uri",
    detail: "[authorize.redirect-uri] redirect_uri https://agent.test/elsewhere isn't an exact registered redirect_uri",
    run: async (c) => c.call(authorizeUrl(c, await authorizeParams({ redirect_uri: "https://agent.test/elsewhere" })))
  },
  {
    id: "authorize.no-state",
    what: "an authorization request without state",
    detail: "[authorize.no-state] authorization request without state",
    run: async (c) => c.call(authorizeUrl(c, await authorizeParams({ state: undefined })))
  },
  {
    id: "authorize.no-pkce",
    what: "PKCE plain instead of S256",
    detail: "[authorize.no-pkce] authorization request without PKCE S256",
    run: async (c) => c.call(authorizeUrl(c, await authorizeParams({ code_challenge: "plain-verifier", code_challenge_method: "plain" })))
  },
  {
    id: "authorize.secret-in-url",
    what: "a client assertion in the authorization URL",
    detail: "[authorize.secret-in-url] client_assertion in the authorization URL",
    run: async (c) => expect((await c.call(authorizeUrl(c, await authorizeParams({ client_assertion: await clientAssertion(c) })))).status).toBe(200)
  },
  {
    id: "code.reused",
    what: "an authorization code exchanged twice",
    detail: "[code.reused] authorization code used twice",
    run: async (c) => {
      const flow = await authorizationCode(c);
      const key = await dpopKey();
      expect((await exchangeCode(c, flow, key)).status).toBe(200);
      return exchangeCode(c, flow, key);
    }
  },
  {
    id: "code.redirect-uri",
    what: "a different redirect_uri at the token endpoint",
    detail: "[code.redirect-uri] redirect_uri at the token endpoint differs from the authorization request",
    run: async (c) => exchangeCode(c, await authorizationCode(c), await dpopKey(), { redirect_uri: "https://agent.test/poppy/callback2" })
  },
  {
    id: "code.pkce",
    what: "the wrong PKCE verifier",
    detail: "[code.pkce] PKCE code_verifier doesn't match the challenge",
    run: async (c) => exchangeCode(c, await authorizationCode(c), await dpopKey(), { code_verifier: jti() + jti() })
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
    id: "mediated.missing-field",
    what: "Mediated Sign-In without the password field",
    detail: "[mediated.missing-field] mediated sign-in missing field password",
    run: async (c) => mediated(c, { scope: "orders:read", email: ADA.email })
  },
  {
    id: "mediated.credentials-with-code",
    what: "the email resent with the one-time code",
    detail: "[mediated.credentials-with-code] credentials resent with the one-time code (Mediated Sign-In 4: not the credentials or scope)",
    run: async (c) => {
      const { signInId, code } = await oneTimeCode(c);
      return mediated(c, { sign_in_id: signInId, one_time_code: code, email: GRACE.email });
    }
  },
  {
    id: "mediated.scope-with-code",
    what: "scope resent with the one-time code",
    detail: "[mediated.scope-with-code] scope resent with the one-time code (Mediated Sign-In 4: the sign-in keeps its first scopes)",
    run: async (c) => {
      const { signInId, code } = await oneTimeCode(c);
      return mediated(c, { sign_in_id: signInId, one_time_code: code, scope: "orders:read" });
    }
  },
  {
    id: "mediated.code-other-client",
    what: "a one-time code sent by another client",
    detail: /^\[mediated\.code-other-client\] one-time code for sgn_[\w-]+ sent by another client$/,
    run: async (c) => {
      const { signInId, code } = await oneTimeCode(c);
      const other = await otherClient(c);
      const response = await mediated(c, { sign_in_id: signInId, one_time_code: code }, { clientId: OTHER, client: await other.clientAssertion() });
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
  },

  // ---- Writes and retries (Guides; Ops 7) ----
  {
    id: "idempotency.key-reused",
    what: "an Idempotency-Key reused with another body",
    config: { printShop: true },
    detail: "[idempotency.key-reused] Idempotency-Key key_approved_order_1 reused with a different body",
    run: async (c) => {
      const s = await session();
      const photo = await uploaded(c, s);
      const first = await orderPrints(c, s, printOrder(photo), { "Idempotency-Key": "key_first_request_1" });
      const { operation } = (await first.json()) as { operation: Operation };
      expect((await orderPrints(c, s, printOrder(photo), { "Idempotency-Key": "key_approved_order_1", ...approval(operation) })).status).toBe(201);
      return orderPrints(c, s, printOrder(photo, 2), { "Idempotency-Key": "key_approved_order_1" });
    }
  },
  {
    id: "idempotency.key-missing",
    what: "an order of prints without the Idempotency-Key its description requires",
    config: { printShop: true },
    detail: "[idempotency.key-missing] POST /prints without the Idempotency-Key its description requires",
    run: async (c) => {
      const s = await session();
      return orderPrints(c, s, printOrder(await uploaded(c, s)));
    }
  },
  {
    id: "upload.boundary",
    what: "a photo upload whose multipart/form-data has no boundary",
    config: { printShop: true },
    detail: '[upload.boundary] multipart/form-data without a boundary: "multipart/form-data"',
    run: async (c) => uploadPhoto(c, await session(), PHOTO(), "multipart/form-data")
  },
  {
    id: "upload.part-name",
    what: "a photo upload whose part has no form-data name",
    config: { printShop: true },
    detail: '[upload.part-name] multipart part without a form-data name (Content-Disposition: "attachment; filename=\\"lake\\"")',
    run: async (c) => uploadPhoto(c, await session(), multipart("b0undary", 'attachment; filename="lake"'), PHOTO_TYPE)
  },
  {
    id: "exchange.performed-twice",
    what: "a write retried without its Idempotency-Key, at a Company without Operations",
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
    what: "the same exchange approved again as a new operation",
    detail: /^\[exchange\.performed-twice\] itm_4Qa on ord_7Hk2 exchanged again for acct_ada \(operation exc_[\w-]+\)$/,
    run: async (c) => {
      const { s, operation } = await refused(c);
      expect((await exchange(c, s, approval(operation))).status).toBe(201);
      // Asked again without the approval, the Company returns a new operation, which the agent approves.
      const again = await refused(c, s);
      expect(again.operation.operation_id).not.toBe(operation.operation_id);
      expect((await exchange(c, s, approval(again.operation))).status).toBe(201);
    }
  },

  // ---- Conversations (8) ----
  {
    id: "message.missing",
    what: "a conversation started without a message",
    detail: "[message.missing] conversation message: missing message",
    run: async (c) => call(c, await session(), "POST", c.hosts.conversationsEndpoint, { body: {} })
  },
  { id: "message.id", what: "a message id with a space", detail: "[message.id] conversation message: id must be 1-256 base64url characters", run: async (c) => converse(c, await session(), message({ id: "msg 1" })) },
  {
    id: "message.empty",
    what: "a message with no text, data or context",
    detail: "[message.empty] conversation message: needs at least one of text, data or context",
    run: async (c) => converse(c, await session(), message({ text: undefined }))
  },
  { id: "message.text-type", what: "a number as text", detail: "[message.text-type] conversation message: text must be a string", run: async (c) => converse(c, await session(), message({ text: 1042 })) },
  {
    id: "message.json-in-text",
    what: "JSON in text",
    detail: "[message.json-in-text] conversation message: JSON in text; use data (8.4)",
    run: async (c) => expect((await converse(c, await session(), message({ text: '{"order": 1042}' }))).status).toBe(201)
  },
  { id: "message.data-type", what: "an array as data", detail: "[message.data-type] conversation message: data must be a JSON object", run: async (c) => converse(c, await session(), message({ data: [1042] })) },
  { id: "message.context-type", what: "a string as context", detail: "[message.context-type] conversation message: context must be an object", run: async (c) => converse(c, await session(), message({ context: "London" })) },
  {
    id: "message.id-reused",
    what: "a message id reused for other words",
    detail: /^\[message\.id-reused\] message id msg_[\w-]+ reused with different content$/,
    run: async (c) => {
      const s = await session();
      const first = message();
      expect((await converse(c, s, first)).status).toBe(201);
      return converse(c, s, { ...first, text: "Something else" });
    }
  },
  {
    id: "context.locale",
    what: "a locale that isn't a language tag",
    detail: '[context.locale] context.locale "English please" is not an RFC 5646 tag',
    run: async (c) => converse(c, await session(), message({ context: { locale: "English please" } }))
  },
  {
    id: "context.time-zone",
    what: "a time zone that isn't an IANA name",
    detail: '[context.time-zone] context.time_zone "GMT+1 please" is not an IANA name',
    run: async (c) => converse(c, await session(), message({ context: { time_zone: "GMT+1 please" } }))
  },
  {
    id: "context.user-available",
    what: 'user_available "yes"',
    detail: "[context.user-available] context.user_available must be a boolean",
    run: async (c) => converse(c, await session(), message({ context: { user_available: "yes" } }))
  },
  {
    id: "direct.agent-words",
    what: "a Direct Conversation opened with the agent's words",
    detail: "[direct.agent-words] Direct Conversation opened with words not marked as the User's (sender agent)",
    run: async (c) => {
      const s = await session();
      const parent = await conversation(c, s);
      expect((await converse(c, s, message({ text: "Hi, it's me." }), { parent_conversation_id: parent })).status).toBe(201);
    }
  },
  {
    id: "direct.agent-words-later",
    what: "the agent's own words in an open Direct Conversation",
    detail: /^\[direct\.agent-words-later\] agent's own words sent into Direct Conversation cnv_[\w-]+$/,
    run: async (c) => {
      const s = await session();
      const parent = await conversation(c, s);
      const opened = await converse(c, s, message({ author: { type: "human" }, text: "Hi, it's me." }), { parent_conversation_id: parent });
      const { conversation_id: direct } = (await opened.json()) as { conversation_id: string };
      const send = (fields: Record<string, unknown>) => call(c, s, "POST", `${c.hosts.conversationsEndpoint}/${direct}/messages`, { body: { message: message(fields) } });
      // The User's words, and a context update from the agent, belong there.
      expect((await send({ author: { type: "human" }, text: "Medium, please." })).status).toBe(202);
      expect((await send({ text: undefined, context: { user_available: false } })).status).toBe(202);
      expect((await send({ text: "The user means the medium." })).status).toBe(202);
    }
  },
  {
    id: "handoff.body",
    what: "a handoff with a reason in the body",
    detail: '[handoff.body] handoff body should be {}, got {"reason":"needs a person"}',
    run: async (c) => {
      const s = await session();
      const id = await conversation(c, s);
      return call(c, s, "POST", `${c.hosts.conversationsEndpoint}/${id}/handoff`, { body: { reason: "needs a person" } });
    }
  },
  {
    id: "close.body",
    what: "a close with a body",
    detail: '[close.body] close body should be {}, got {"done":true}',
    run: async (c) => {
      const s = await session();
      const id = await conversation(c, s);
      return call(c, s, "POST", `${c.hosts.conversationsEndpoint}/${id}/close`, { body: { done: true } });
    }
  },
  {
    id: "conversation.cross-user",
    what: "another User of the same agent reading a conversation",
    detail: new RegExp(`^\\[conversation\\.cross-user\\] User ${OTHER_USER} reached conversation cnv_[\\w-]+ of User ${USER_ID}$`),
    run: async (c) => {
      const id = await conversation(c, await session());
      return call(c, await session(OTHER_USER), "GET", `${c.hosts.conversationsEndpoint}/${id}/events`);
    }
  },
  {
    id: "message.author",
    what: "a message without author",
    detail: /^\[message\.author\] conversation message: author\.type must be agent or human$/,
    run: async (c) => converse(c, await session(), message({ author: undefined }))
  },
  {
    id: "message.author",
    what: "an agent's message that names its author",
    detail: "[message.author] conversation message: only Company messages name an author's id, name or image (8.4)",
    run: async (c) => expect((await converse(c, await session(), message({ author: { type: "agent", name: "Helper" } }))).status).toBe(201)
  },
  {
    id: "message.sender-field",
    what: "a message that still says sender",
    detail: /^\[message\.sender-field\]/,
    run: async (c) => expect((await converse(c, await session(), message({ sender: "agent" }))).status).toBe(201)
  },

  // ---- The Session header (5.2, 5.3) ----
  { id: "session-jwt.missing", what: "a request without the Session header", detail: /^\[session-jwt\.missing\] Session JWT: no Poppy-Session header \(GET \/products\)$/, run: (c) => getProducts(c, null) },
  {
    id: "session-jwt.missing-with-token",
    what: "an access token without the Session header",
    detail: /^\[session-jwt\.missing-with-token\] Session JWT: an access token without the Session header/,
    run: (c) => getOrders(c, { jwt: null })
  },
  { id: "session-jwt.not-jwt", what: "a Session header that isn't a JWT", detail: /^\[session-jwt\.not-jwt\]/, run: (c) => getProducts(c, "not.a.jwt") },
  { id: "session-jwt.typ", what: "a Session JWT with typ JWT", detail: /^\[session-jwt\.typ\] Session JWT: typ is "JWT"/, run: (c) => getProducts(c, { header: { typ: "JWT" } }) },
  { id: "session-jwt.alg", what: "a Session JWT signed with HS256", detail: /^\[session-jwt\.alg\]/, run: async (c) => getProducts(c, { header: { alg: "HS256" }, key: await hmacKey() }) },
  { id: "session-jwt.no-delegation", what: "a Session JWT without pap_dlg", detail: /^\[session-jwt\.no-delegation\]/, run: (c) => getProducts(c, { header: { pap_dlg: undefined } }) },
  { id: "session-jwt.iss", what: "a Session JWT without iss", detail: /^\[session-jwt\.iss\]/, run: (c) => getProducts(c, { claims: { iss: undefined } }) },
  { id: "session-jwt.kid", what: "a Session JWT whose kid isn't its key's thumbprint", detail: /^\[session-jwt\.kid\]/, run: (c) => getProducts(c, { header: { kid: "someone-else" } }) },
  { id: "session-jwt.signature", what: "a Session JWT signed with a key its delegation doesn't name", detail: /^\[session-jwt\.signature\]/, run: async (c) => getProducts(c, { key: await strangerKey() }) },
  { id: "session-jwt.iat", what: "a Session JWT ten minutes old", detail: /^\[session-jwt\.iat\] Session JWT: iat is outside the acceptance window/, run: (c) => getProducts(c, { claims: { iat: seconds() - 600 } }) },
  {
    id: "session-jwt.after-delegation",
    what: "a Session JWT signed after its delegation expired",
    detail: /^\[session-jwt\.after-delegation\]/,
    run: (c) => getProducts(c, { delegation: { claims: { iat: seconds() - 3600, exp: seconds() - 10 } } })
  },
  { id: "session-jwt.aud", what: "a Session JWT for the token endpoint", detail: /^\[session-jwt\.aud\]/, run: (c) => getProducts(c, { claims: { aud: c.hosts.tokenEndpoint } }) },
  { id: "session-jwt.htm", what: "a Session JWT for POST on a GET", detail: /^\[session-jwt\.htm\]/, run: (c) => getProducts(c, { claims: { htm: "POST" } }) },
  { id: "session-jwt.htu", what: "a Session JWT for another URL", detail: /^\[session-jwt\.htu\]/, run: (c) => getProducts(c, { claims: { htu: orders(c) } }) },
  { id: "session-jwt.sid", what: "a Session JWT whose sid has a slash", detail: /^\[session-jwt\.sid\]/, run: (c) => getProducts(c, { claims: { sid: "a/b" } }) },
  { id: "session-jwt.sub", what: "a Session JWT without sub", detail: /^\[session-jwt\.sub\] Session JWT: sub/, run: (c) => getProducts(c, { claims: { sub: undefined } }) },
  { id: "session-jwt.sub", what: "a Session JWT with an empty agent_id", detail: /^\[session-jwt\.sub\] Session JWT: agent_id/, run: (c) => getProducts(c, { claims: { agent_id: "" } }) },
  { id: "session-jwt.ath", what: "a Session JWT whose ath is another token's", detail: /^\[session-jwt\.ath\]/, run: async (c) => getOrders(c, { jwt: { claims: { ath: await hash("another token") } } }) },
  { id: "session-jwt.oauth-endpoint", what: "a Session header at the revocation endpoint", detail: /^\[session-jwt\.oauth-endpoint\] \/oauth\/revoke got a Poppy-Session header$/, run: async (c) => revoke(c, { headers: { "Poppy-Session": "eyJ.a.session-header" } }) },
  { id: "session-jwt.ath-without-token", what: "ath with no access token", detail: /^\[session-jwt\.ath-without-token\]/, run: async (c) => getProducts(c, { claims: { ath: await hash("a token") } }) },
  {
    id: "session-jwt.sub-changed",
    what: "a Session's sid with another User ID",
    detail: /^\[session-jwt\.sub-changed\]/,
    run: async (c) => {
      const s = await session();
      expect((await getProducts(c, undefined, s)).status).toBe(200);
      // A new delegated key for the other User ID, so only the sid is shared.
      return getProducts(c, { claims: { sub: "usr_Another1User2Id3Here4" } }, { ...s, key: await delegatedKey() });
    }
  },
  {
    id: "session-jwt.token-other-client",
    what: "an access token issued to another client_id",
    detail: /^\[session-jwt\.token-other-client\]/,
    run: async (c) => getOrders(c, {}, { ...(await session()), ...(await signIn(c, { other: await otherClient(c) })) })
  },

  // ---- Delegations (5.2 Delegated keys) ----
  { id: "delegation.not-jwt", what: "a pap_dlg that isn't a JWT", detail: /^\[delegation\.not-jwt\]/, run: (c) => getProducts(c, { delegation: "not-a-delegation" }) },
  { id: "delegation.typ", what: "a delegation with typ JWT", detail: /^\[delegation\.typ\]/, run: (c) => getProducts(c, { delegation: { header: { typ: "JWT" } } }) },
  { id: "delegation.alg", what: "a delegation signed with HS256", detail: /^\[delegation\.alg\]/, run: async (c) => getProducts(c, { delegation: { header: { alg: "HS256" }, key: await hmacKey() } }) },
  { id: "delegation.kid", what: "a delegation whose kid names no published key", detail: /^\[delegation\.kid\]/, run: (c) => getProducts(c, { delegation: { header: { kid: "unpublished" } } }) },
  { id: "delegation.signature", what: "a delegation signed with an unpublished key", detail: /^\[delegation\.signature\]/, run: async (c) => getProducts(c, { delegation: { key: await strangerKey() } }) },
  { id: "delegation.iss", what: "a delegation from another client", detail: /^\[delegation\.iss\]/, run: (c) => getProducts(c, { delegation: { claims: { iss: OTHER } } }) },
  {
    id: "delegation.lifetime",
    what: "a delegation for 25 hours",
    detail: /^\[delegation\.lifetime\] delegation: exp is 90000 s after iat/,
    run: (c) => getProducts(c, { delegation: { claims: { iat: seconds(), exp: seconds() + 25 * 3600 } } })
  },
  { id: "delegation.lifetime", what: "a delegation without exp", detail: /^\[delegation\.lifetime\] delegation: iat and exp are required/, run: (c) => getProducts(c, { delegation: { claims: { exp: undefined } } }) },
  { id: "delegation.expired", what: "an expired delegation", detail: /^\[delegation\.expired\]/, run: (c) => getProducts(c, { delegation: { claims: { iat: seconds() - 7200, exp: seconds() - 3600 } } }) },
  { id: "delegation.jti", what: "a delegation with a short jti", detail: /^\[delegation\.jti\]/, run: (c) => getProducts(c, { delegation: { claims: { jti: "short" } } }) },
  { id: "delegation.cnf", what: "a delegation without cnf", detail: /^\[delegation\.cnf\]/, run: (c) => getProducts(c, { delegation: { claims: { cnf: undefined } } }) },
  {
    id: "delegation.private-key",
    what: "a delegation that carries the private key",
    detail: /^\[delegation\.private-key\]/,
    run: async (c) => {
      const s = await session();
      return getProducts(c, { delegation: { claims: { cnf: { jwk: s.key.privateJwk } } } }, s);
    }
  },
  { id: "delegation.names-user", what: "a delegation naming the User", detail: /^\[delegation\.names-user\] delegation: carries sub/, run: (c) => getProducts(c, { delegation: { claims: { sub: USER_ID } } }) },
  {
    id: "delegation.key-shared",
    what: "one delegated key signing for two User IDs",
    detail: /^\[delegation\.key-shared\]/,
    run: async (c) => {
      const s = await session();
      expect((await getProducts(c, undefined, s)).status).toBe(200);
      expect((await getProducts(c, { claims: { sub: "usr_Another1User2Id3Here4" } }, { ...s, sid: jti() })).status).toBe(200);
    }
  },

  // ---- Accounts in Sessions (5.4) ----
  {
    id: "session.second-account",
    what: "a second account in one Session",
    detail: /^\[session\.second-account\]/,
    run: async (c) => {
      const s = await signedIn(c);
      expect((await getOrders(c, {}, s)).status).toBe(200);
      return getOrders(c, {}, { ...s, ...(await signIn(c, { account: "acct_grace" })) });
    }
  },

  // ---- Browser join (6) ----
  {
    id: "browser-join.form",
    what: "the join form sent as JSON",
    detail: /^\[browser-join\.form\] browser join: the form was sent as "application\/json"$/,
    run: async (c) => {
      const { code, cookie } = await joinPage(c);
      expect((await authorizeJoin(c, await session(), code)).status).toBe(204);
      return submitJoin(c, code, cookie, { contentType: "application/json", body: JSON.stringify({ code }) });
    }
  },
  {
    id: "browser-join.form",
    what: "the join form with another field",
    detail: "[browser-join.form] the form carried fields other than code",
    run: async (c) => {
      const { code, cookie } = await joinPage(c);
      expect((await authorizeJoin(c, await session(), code)).status).toBe(204);
      expect((await submitJoin(c, code, cookie, { body: new URLSearchParams({ code, return_to: "/orders" }).toString() })).status).toBe(303);
    }
  },
  {
    id: "browser-join.code-reused",
    what: "a join code authorized twice",
    detail: /^\[browser-join\.code-reused\] browser join: the code was authorized before$/,
    run: async (c) => {
      const { code } = await joinPage(c);
      const s = await session();
      expect((await authorizeJoin(c, s, code)).status).toBe(204);
      return authorizeJoin(c, s, code);
    }
  },
  {
    id: "browser-join.code-reused",
    what: "a join form submitted twice",
    detail: /^\[browser-join\.code-reused\] browser join: the code was submitted before$/,
    run: async (c) => {
      const { code, cookie } = await joinPage(c);
      expect((await authorizeJoin(c, await session(), code)).status).toBe(204);
      expect((await submitJoin(c, code, cookie)).status).toBe(303);
      return submitJoin(c, code, cookie);
    }
  },
  {
    id: "browser-join.cookie",
    what: "the join form without its cookie",
    detail: /^\[browser-join\.cookie\]/,
    run: async (c) => {
      const { code } = await joinPage(c);
      expect((await authorizeJoin(c, await session(), code)).status).toBe(204);
      return submitJoin(c, code, null);
    }
  },
  {
    id: "browser-join.not-authorized",
    what: "the join form before its code was authorized",
    detail: /^\[browser-join\.not-authorized\]/,
    run: async (c) => {
      const { code, cookie } = await joinPage(c);
      return submitJoin(c, code, cookie);
    }
  },
  {
    id: "browser-join.authorize-body",
    what: "authorize with a form body",
    detail: /^\[browser-join\.authorize-body\]/,
    run: async (c) => {
      const { code } = await joinPage(c);
      return authorizeJoin(c, await session(), code, { body: `code=${code}`, contentType: "application/x-www-form-urlencoded" });
    }
  },

  // ---- Operations 2 (Ops 6) ----
  {
    id: "approval.header",
    what: "a Poppy-Approval that isn't a Dictionary",
    detail: /^\[approval\.header\]/,
    run: async (c) => exchange(c, await signedIn(c), { "Poppy-Approval": "operation_id=exc_1 revision" })
  },
  {
    id: "approval.idempotency-key-reused",
    what: "the approved request with the first request's Idempotency-Key",
    detail: /^\[approval\.idempotency-key-reused\]/,
    run: async (c) => {
      const s = await signedIn(c);
      const key = jti();
      const first = (await (await exchange(c, s, { "Idempotency-Key": key })).json()) as { operation: Operation };
      return exchange(c, s, { "Idempotency-Key": key, ...approval(first.operation) });
    }
  },
  {
    id: "approval.mcp-meta",
    what: "an MCP approval that isn't an object",
    detail: /^\[approval\.mcp-meta\]/,
    run: async (c) =>
      call(c, await signedIn(c, { resource: c.hosts.mcpUrl }), "POST", c.hosts.mcpUrl, {
        headers: MCP_ACCEPT,
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "exchange_item", arguments: { order_id: "ord_7Hk2", ...EXCHANGE }, _meta: { "personalagentprotocol.org/approval": "yes" } } }
      })
  },
  {
    id: "approval.message",
    what: "a message whose approval isn't an object",
    detail: /^\[approval\.message\]/,
    run: async (c) => converse(c, await signedIn(c), message({ text: undefined, approval: "yes" }))
  },

  // ---- Feedback (9.3) ----
  {
    id: "feedback.fields",
    what: "a feedback report whose task is over 200 characters",
    config: { feedback: true },
    detail: "[feedback.fields] feedback report: task (at most 200 characters) and description (at most 2,000) are required strings",
    run: async (c) => feedback(c, await session(), { ...REPORT, task: "x".repeat(201) })
  },
  {
    id: "feedback.kind",
    what: "a feedback report with kind",
    config: { feedback: true },
    detail: "[feedback.kind] feedback report: kind is 0.2's; 0.3 removed it (9.3)",
    run: async (c) => expect((await feedback(c, await session(), { kind: "missing", ...REPORT })).status).toBe(202)
  },
  {
    id: "feedback.excluded-task",
    what: "a feedback report about an excluded task",
    config: { feedback: true },
    detail: '[feedback.excluded-task] feedback report about "Close an account", which the Company lists as excluded',
    run: async (c) => expect((await feedback(c, await session(), { ...REPORT, task: "Close an account" })).status).toBe(202)
  },
  {
    id: "feedback.repeated",
    what: "a second feedback report about the same task",
    config: { feedback: true },
    detail: '[feedback.repeated] a second feedback report about "Pay with a gift card"',
    run: async (c) => {
      const s = await session();
      expect((await feedback(c, s, REPORT)).status).toBe(202);
      expect((await feedback(c, s, REPORT)).status).toBe(202);
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
      return source.includes(`"${id}"`) || (source.includes(`\`\${kind}.${check}\``) && ["client-assertion", "dpop", "session-jwt"].includes(kind));
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

  it("says what each check rests on, and where in 0.3, and files it as a violation or a warning by that basis", () => {
    // "MUST (5.2: …): …", "RFC (RFC 9449 4.3; 4.5): …", "Guides (Retries: …): …": the basis, where, then what.
    const malformed = VIOLATION_IDS.filter(
      (id) => !/^(?:MUST(?: NOT)?|RFC|Rule|SHOULD(?: NOT)?|Guides|Reading) \([^)]+\)(?:, strict Company only)?: \S/.test(VIOLATIONS[id])
    );
    expect(malformed).toEqual([]);
    // Every section is 0.3's, so none says so, and none names a version's section.
    expect(VIOLATION_IDS.filter((id) => /\b0\.3 /.test(VIOLATIONS[id]))).toEqual([]);
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
  it("publishes poppy.json, the domain's protected resource metadata and the issuer's metadata that check out (3, 3.2)", async () => {
    const c = company();
    const document = (await (await c.call(`https://${c.hosts.domain}/.well-known/poppy.json`)).json()) as {
      protocol_version: string;
      organization: { domain: string };
      auth: { issuer?: string; scopes: Record<string, string>; scope_hints: Record<string, unknown> };
      apis: { type: string }[];
      extensions: Record<string, { version: string }>;
    };
    expect(document.protocol_version).toBe("0.3");
    expect(document.organization.domain).toBe(c.hosts.domain);
    // One authorization server, so auth.issuer is left out (3.1).
    expect(document.auth.issuer).toBeUndefined();
    expect(Object.keys(document.auth.scopes).sort()).toEqual(["addresses", "orders:read", "orders:write"]);
    expect(Object.keys(document.auth.scope_hints).sort()).toEqual(["addresses", "orders:read", "orders:write"]);
    expect(document.apis.map((api) => api.type)).toEqual(["graphql", "openapi", "mcp"]);
    expect(document.extensions.operations).toEqual({ version: "2" });
    expect(document.extensions["mediated-sign-in"]).toMatchObject({ version: "1", scopes: ["orders:read", "orders:write"] });
    for (const domain of [c.hosts.domain, c.hosts.altDomain]) {
      const resource = (await (await c.call(`https://${domain}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
      expect(resource).toEqual({ resource: `https://${domain}`, authorization_servers: [c.hosts.issuer] });
    }
    const alt = (await (await c.call(`https://www.${c.hosts.altDomain}/.well-known/poppy.json`)).json()) as { organization: { domain: string } };
    expect(alt.organization.domain).toBe(c.hosts.altDomain);
    const metadata = (await (await c.call(`${c.hosts.issuer}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: c.hosts.issuer,
      token_endpoint: c.hosts.tokenEndpoint,
      revocation_endpoint: c.hosts.revocationEndpoint,
      authorization_endpoint: c.hosts.authorizationEndpoint,
      device_authorization_endpoint: c.hosts.deviceEndpoint,
      grant_types_supported: ["refresh_token", "authorization_code", DEVICE_CODE, MEDIATED],
      scopes_supported: ["orders:read", "orders:write", "addresses"],
      protected_resources: [`https://${c.hosts.domain}`, `https://${c.hosts.altDomain}`, c.hosts.mcpUrl],
      dpop_signing_alg_values_supported: ["ES256"]
    });
    expect("poppy_domains" in metadata).toBe(false);
  });

  it("serves an issuer with a trailing slash exactly, endpoints unchanged (S7)", async () => {
    const c = company();
    await c.stub.configure({ issuerTrailingSlash: true });
    const slashed = hostsFor(c.id, { issuerTrailingSlash: true });
    expect(slashed.issuer).toBe(`https://auth.${c.hosts.domain}/`);
    const resource = (await (await c.call(`https://${c.hosts.domain}/.well-known/oauth-protected-resource`)).json()) as { authorization_servers: string[] };
    expect(resource.authorization_servers).toEqual([slashed.issuer]);
    const metadata = (await (await c.call(`https://auth.${c.hosts.domain}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({ issuer: slashed.issuer, token_endpoint: c.hosts.tokenEndpoint });
  });

  it("serves an issuer with a path, its metadata only where RFC 8414 inserts it (S3)", async () => {
    const c = company();
    await c.stub.configure({ issuerPath: "/tenant" });
    const pathed = hostsFor(c.id, { issuerPath: "/tenant" });
    expect(pathed.issuer).toBe(`https://auth.${c.hosts.domain}/tenant`);
    const resource = (await (await c.call(`https://${c.hosts.domain}/.well-known/oauth-protected-resource`)).json()) as { authorization_servers: string[] };
    expect(resource.authorization_servers).toEqual([pathed.issuer]);
    const inserted = await c.call(`https://auth.${c.hosts.domain}/.well-known/oauth-authorization-server/tenant`);
    expect(inserted.status).toBe(200);
    expect(await inserted.json()).toMatchObject({ issuer: pathed.issuer, token_endpoint: c.hosts.tokenEndpoint });
    expect((await c.call(`${pathed.issuer}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await c.call(`https://auth.${c.hosts.domain}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect(() => hostsFor(c.id, { issuerPath: "tenant/" })).toThrow(/issuerPath/);
  });

  it("rejects client assertions a strict Company would, and records why (S2)", async () => {
    const cases = [
      { tamper: { header: { typ: undefined } }, expected: 'header typ must be "JWT", got undefined' },
      { tamper: { header: { typ: "at+jwt" } }, expected: 'header typ must be "JWT", got "at+jwt"' },
      { tamper: { header: { kid: undefined } }, expected: "kid undefined names no published key" },
      { tamper: { header: { kid: "not-a-key" } }, expected: 'kid "not-a-key" names no published key' },
      { tamper: { claims: lifetime(120) }, expected: "lifetime 120s is too long" }
    ];
    for (const { tamper, expected } of cases) {
      const c = company();
      const response = await revoke(c, { client: await clientAssertion(c, tamper) });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
      const violations = (await c.stub.state()).recorded;
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(expected);
    }
  });

  it("accepts the same client assertion with strict checks turned off", async () => {
    const c = company();
    await c.stub.configure({ strictAssertions: false });
    expect((await revoke(c, { client: await clientAssertion(c, { header: { typ: undefined }, claims: lifetime(120) }) })).status).toBe(200);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("accepts a client assertion for the issuer at the token, device and revocation endpoints, and nothing else (4.1)", async () => {
    const c = company();
    expect((await form(c, c.hosts.deviceEndpoint, { scope: "orders:read" }, null)).status).toBe(200);
    expect(await (await tokenRequest(c, UNKNOWN_REFRESH)).json()).toMatchObject({ error: "invalid_grant" });
    expect((await revoke(c)).status).toBe(200);
    expect((await c.stub.state()).recorded).toEqual([]);
    for (const aud of [c.hosts.tokenEndpoint, c.hosts.revocationEndpoint, c.hosts.deviceEndpoint]) {
      expect(await (await revoke(c, { client: await clientAssertion(c, { claims: { aud } }) })).json()).toMatchObject({ error: "invalid_client" });
    }
    expect((await c.stub.state()).recorded.map(violationId)).toEqual(["client-assertion.aud", "client-assertion.aud", "client-assertion.aud"]);
  });

  it("takes the client from the client assertion when client_id is left out (RFC 7521 4.2, RFC 7523 3)", async () => {
    const c = company();
    expect((await revoke(c, { clientId: null })).status).toBe(200);
    expect((await c.stub.state()).recorded).toEqual([]);
    // Without client_id, an assertion whose iss and sub differ names no client.
    const unnamed = await revoke(c, { clientId: null, client: await clientAssertion(c, { claims: { sub: USER_ID } }) });
    expect(unnamed.status).toBe(401);
    expect(((await unnamed.json()) as Record<string, unknown>).error).toBe("invalid_client");
    // A client_id that is sent must still be the assertion's: the client-assertion.iss-sub row.
  });

  it("accepts a loopback redirect URI in client metadata, and any port on it (4.1, 4.2, RFC 8252 7.3)", async () => {
    const c = company();
    await otherClient(c, { metadata: { redirect_uris: ["http://127.0.0.1/callback"] } });
    const params = await authorizeParams({ client_id: OTHER, redirect_uri: "http://127.0.0.1:53110/callback" });
    expect((await c.call(authorizeUrl(c, params))).status).toBe(200);
    // Another path on the loopback host is still refused.
    expect((await c.call(authorizeUrl(c, { ...params, state: jti(), redirect_uri: "http://127.0.0.1:53110/elsewhere" }))).status).toBe(400);
    expect((await c.stub.state()).recorded.map(violationId)).toEqual(["authorize.redirect-uri"]);
  });

  it("starts a signed-out Session from the Session header alone, with no token request (5, 5.3)", async () => {
    const c = company();
    const s = await session();
    expect((await call(c, s, "GET", products(c))).status).toBe(200);
    expect((await call(c, s, "GET", products(c))).status).toBe(200);
    const state = await c.stub.state();
    expect(state.recorded).toEqual([]);
    expect(state.userIds).toEqual([USER_ID]);
    expect(state.sessions).toEqual([expect.objectContaining({ userId: USER_ID, signedIn: false, ended: false })]);
    expect(state.requests.map((request) => request.url)).toEqual([products(c), products(c)]);
    expect(state.requests.every((request) => request.headers["poppy-session"] && !request.headers.authorization)).toBe(true);
    // An account action without a token gets a challenge with the scopes it needs, and no error code (7).
    const challenge = await call(c, s, "GET", orders(c));
    expect(challenge.status).toBe(401);
    const header = challenge.headers.get("WWW-Authenticate")!;
    expect(header).toContain('scope="orders:read"');
    expect(header).not.toContain("error=");
  });

  it("answers an ended Session with invalid_session, and a new sid starts a new one (5.5)", async () => {
    const c = company();
    const s = await session();
    expect((await call(c, s, "GET", products(c))).status).toBe(200);
    expect(await c.stub.endAllSessions()).toBe(1);
    const ended = await call(c, s, "GET", products(c));
    expect(ended.status).toBe(400);
    expect(await ended.json()).toMatchObject({ error: "invalid_session" });
    expect((await call(c, { ...s, sid: jti() }, "GET", products(c))).status).toBe(200);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("signs a Session in on each request with an access token, and leaves it signed out after revocation, with or without token_type_hint (5.4, 5.5)", async () => {
    for (const hint of ["refresh_token", null] as const) {
      const c = company();
      const s = await signedIn(c, { scope: "orders:read" });
      expect(s.tokenType).toBe("DPoP");
      expect((await getOrders(c, {}, s)).status).toBe(200);
      expect((await c.stub.state()).sessions).toEqual([expect.objectContaining({ signedIn: true, account: "acct_ada" })]);
      expect((await revoke(c, { token: s.refreshToken!, hint })).status).toBe(200);
      const state = await c.stub.state();
      expect(state.accountTokens).toBe(0);
      expect(state.revocationHints).toEqual([hint]);
      expect(state.sessions[0]).toMatchObject({ signedIn: false, ended: false });
      // Its access tokens go with it (RFC 7009 2.1), and the Session continues signed out.
      const revoked = await getOrders(c, {}, s);
      expect(revoked.status).toBe(401);
      expect(revoked.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
      const signedOut = await getOrders(c, { token: null }, s);
      expect(signedOut.status).toBe(401);
      expect(signedOut.headers.get("WWW-Authenticate")).not.toContain("error=");
      expect((await call(c, s, "GET", products(c), { token: null })).status).toBe(200);
      expect((await c.stub.state()).recorded).toEqual([]);
    }
  });

  it("asks for a DPoP nonce per origin or per Company, as configured (S23)", async () => {
    for (const nonceScope of ["company", "origin"] as const) {
      const c = company();
      await c.stub.configure({ requireNonce: true, nonceScope });
      const key = await dpopKey();
      const flow = await authorizationCode(c);
      const first = await exchangeCode(c, flow, key);
      expect(first.status).toBe(400);
      expect(await first.json()).toMatchObject({ error: "use_dpop_nonce" });
      const authNonce = first.headers.get("DPoP-Nonce")!;
      const tokens = await tokensFrom(
        await tokenRequest(c, { grant_type: "authorization_code", code: flow.code, redirect_uri: flow.redirect, code_verifier: flow.verifier }, { key, dpop: await proof(key, "POST", c.hosts.tokenEndpoint, undefined, { nonce: authNonce }) }),
        key
      );
      const s = { ...(await session()), ...tokens };
      const api = await getOrders(c, { proof: { nonce: authNonce } }, s);
      if (nonceScope === "company") {
        expect(api.status).toBe(200);
      } else {
        expect(api.status).toBe(401);
        const apiNonce = api.headers.get("DPoP-Nonce")!;
        expect(apiNonce).not.toBe(authNonce);
        expect((await getOrders(c, { proof: { nonce: apiNonce } }, s)).status).toBe(200);
      }
      expect((await c.stub.state()).recorded).toEqual([]);
    }
  });

  it("joins a browser to a signed-in Session, whose cookie acts for that account until sign-out (6)", async () => {
    const c = company();
    const s = await signedIn(c);
    const { page, code, cookie } = await joinPage(c);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(page.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(page.headers.get("Set-Cookie")).toMatch(/^__Host-poppy_join=[^;]+; Path=\/; Max-Age=60; Secure; HttpOnly; SameSite=Strict$/);
    expect((await authorizeJoin(c, s, code)).status).toBe(204);
    const submitted = await submitJoin(c, code, cookie);
    expect(submitted.status).toBe(303);
    const cookies = submitted.headers.get("Set-Cookie")!;
    expect(cookies).toMatch(/mock_sid=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax/);
    expect(cookies).toContain("__Host-poppy_join=; Path=/; Max-Age=0");
    const sid = /mock_sid=[^;]+/.exec(cookies)![0];
    expect(await (await c.call(`${SITE(c)}/orders`, { headers: { Cookie: sid } })).text()).toContain("Signed in as acct_ada");
    expect((await revoke(c, { token: s.refreshToken! })).status).toBe(200);
    expect(await (await c.call(`${SITE(c)}/orders`, { headers: { Cookie: sid } })).text()).toContain("Signed out");
    const state = await c.stub.state();
    expect(state.browserJoins).toBe(1);
    expect(state.recorded).toEqual([]);
  });

  it("signs in with Mediated Sign-In's grant, with and without a one-time code (Mediated Sign-In 3 to 5)", async () => {
    const c = company();
    const ada = await mediated(c, { scope: "orders:read", ...ADA });
    expect(ada.status).toBe(200);
    expect(await ada.json()).toMatchObject({ token_type: "DPoP", scope: "orders:read", refresh_token: expect.stringMatching(/^pat_/) });
    const grace = await mediated(c, { scope: "orders:read", ...GRACE });
    expect(grace.status).toBe(400);
    const required = (await grace.json()) as Record<string, unknown>;
    expect(required).toMatchObject({ error: "code_required", sign_in_id: expect.stringMatching(/^sgn_/), sent_to: expect.any(String), expires_in: expect.any(Number) });
    const signInId = required.sign_in_id as string;
    expect(await (await mediated(c, { sign_in_id: signInId, one_time_code: "WRONG1" })).json()).toMatchObject({ error: "code_required", sign_in_id: signInId });
    const done = await mediated(c, { sign_in_id: signInId, one_time_code: (await c.stub.lastOneTimeCode())! });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ scope: "orders:read" });
    expect(await (await mediated(c, { scope: "orders:read", email: ADA.email, password: "wrong" })).json()).toMatchObject({ error: "invalid_grant" });
    expect(await (await mediated(c, { scope: "addresses", ...ADA })).json()).toMatchObject({ error: "invalid_scope" });
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("signs in with Device Sign-In, then gets an MCP token by refresh and calls the MCP server with the Session header (4.3, 4.4, 7)", async () => {
    const c = company();
    const flow = await deviceFlow(c);
    expect(await (await flow.poll()).json()).toMatchObject({ error: "authorization_pending" });
    await c.stub.approveDevice(flow.device.user_code, { scopes: ["orders:read"] });
    // A second later, by the mock's clock (which follows the agent's fake clock).
    const tokens = await tokensFrom(await flow.poll({ [CLOCK_HEADER]: String(Date.now() + 1100) }), flow.key);
    expect(tokens.scope).toBe("orders:read");
    const s: Session = { ...(await session()), ...tokens };
    const mcp = await tokensFrom(await refresh(c, s, { resource: c.hosts.mcpUrl }), flow.key);
    expect(mcp.tokenType).toBe("Bearer");
    const listed = await call(c, { ...s, ...mcp }, "POST", c.hosts.mcpUrl, { headers: MCP_ACCEPT, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const tools = (await listed.json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((tool) => tool.name)).toEqual(["search_products", "exchange_item"]);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("streams events with text-delta (8.6)", async () => {
    const c = company();
    const s = await session();
    const id = await conversation(c, s);
    const stream = await call(c, s, "GET", `${c.hosts.conversationsEndpoint}/${id}/events`, { headers: { Accept: "text/event-stream" } });
    const text = await stream.text();
    expect(stream.headers.get("Content-Type")).toBe("text/event-stream");
    expect(text).toContain("event: text-delta");
    expect(text).toMatch(/id: evt_/);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("runs a conversation, Direct Sign-In and an approved operation end to end (8, Ops 4, 6)", async () => {
    const c = company();
    const s = await session();
    const conversations = c.hosts.conversationsEndpoint;
    const started = await call(c, s, "POST", `${conversations}?wait=1`, { body: { message: message({ text: "The user wants to exchange order 1042." }) } });
    expect(started.status).toBe(201);
    const read = (await started.json()) as { conversation_id: string; events: { type: string; error?: string; scope?: string }[] };
    expect(read.events.map((event) => event.type)).toEqual(["message", "authorization", "message"]);
    expect(read.events[1]).toMatchObject({ error: "insufficient_scope", scope: "orders:read orders:write" });

    const now = { ...s, ...(await signIn(c)) };
    const send = (fields: Record<string, unknown>) => call(c, now, "POST", `${conversations}/${read.conversation_id}/messages?wait=1`, { body: { message: message(fields) } });
    type Events = { events: { type: string; message?: { role: string; text?: string; operation?: Operation } }[] };
    const asked = (await (await send({ text: "Signed in. Please exchange the jacket." })).json()) as Events;
    const operation = asked.events.find((event) => event.message?.operation)?.message?.operation;
    expect(operation?.operation_id).toMatch(/^exc_/);
    expect((await c.stub.state()).performs).toBe(0);

    // Only the approval field approves, and the Company Agent says how it went in a later message.
    const approved = (await (await send({ text: "The user approved the exchange.", approval: { operation_id: operation!.operation_id, revision: operation!.revision } })).json()) as Events;
    expect(approved.events.at(-1)?.message).toMatchObject({ role: "company", text: expect.stringContaining("Done") });
    // A new message with the same approval performs nothing more (Ops 7).
    expect((await send({ text: undefined, approval: { operation_id: operation!.operation_id, revision: operation!.revision } })).status).toBe(202);
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.recorded).toEqual([]);
  });

  it("takes a feedback report signed in or out, and answers with an alternative when configured (9.3)", async () => {
    const c = company();
    await c.stub.configure({ feedback: true });
    const document = (await (await c.call(`https://${c.hosts.domain}/.well-known/poppy.json`)).json()) as { feedback: { endpoint: string } };
    expect(document.feedback.endpoint).toBe(`${c.hosts.api}/poppy/feedback`);
    const out = await feedback(c, await session(), REPORT);
    expect(out.status).toBe(202);
    expect(await out.text()).toBe("");
    expect((await feedback(c, await signedIn(c), { ...REPORT, task: "Return a jacket" })).status).toBe(202);
    await c.stub.configure({ feedbackAlternative: true });
    const answered = await feedback(c, await session(), { ...REPORT, task: "Move a flight" });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ instructions: expect.any(String) });
    const state = await c.stub.state();
    expect(state.feedback).toEqual([
      { task: REPORT.task, signedIn: false },
      { task: "Return a jacket", signedIn: true },
      { task: "Move a flight", signedIn: false }
    ]);
    expect(state.recorded).toEqual([]);
  });
});

describe("the mock Company's Operations 2 (Ops 3, 4, 6, 7)", () => {
  it("refuses a write that needs approval with the operation, then performs it once, answering the same approval again with the first response (Ops 4, check 2, Ops 7)", async () => {
    const c = company();
    const { s, operation } = await refused(c);
    expect(operation).toMatchObject({ operation_id: expect.stringMatching(/^exc_/), revision: expect.stringMatching(/^[A-Za-z0-9_-]+$/), summary: expect.stringContaining("$70.00"), terms: { order_id: "ord_7Hk2", item_id: "itm_4Qa" } });
    expect(Date.parse(operation.expires_at)).toBeGreaterThan(Date.now());
    // Asked again before approval, it returns the same revision; nothing is performed.
    const again = await refused(c, s);
    expect(again.operation).toEqual(operation);
    const performed = await exchange(c, s, approval(operation));
    expect(performed.status).toBe(201);
    const first = await performed.json();
    const retried = await exchange(c, s, approval(operation));
    expect(retried.status).toBe(201);
    expect(await retried.json()).toEqual(first);
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.recorded).toEqual([]);
  });

  it("handles an approval from a Session that can't approve the operation as no approval: another User's, or a signed-out one's (check 1, Ops 3)", async () => {
    const c = company();
    const { operation } = await refused(c);
    // Another User of the same agent, signed in to the same account, gets an operation of their own.
    const theirs = await signedIn(c, { sub: "usr_Hn4wQ2cVx8TbLm1KpZr7Ys" });
    const answered = await exchange(c, theirs, approval(operation));
    expect(answered.status).toBe(403);
    const own = ((await answered.json()) as { operation: Operation }).operation;
    expect(own.operation_id).not.toBe(operation.operation_id);
    // A signed-out Session of the same User gets a challenge for the account.
    const signedOut = await exchange(c, await session(), approval(operation));
    expect(signedOut.status).toBe(401);
    expect((await c.stub.state()).performs).toBe(0);
    // Any Session of the same User signed in to the same account can approve it.
    expect((await exchange(c, await signedIn(c), approval(operation))).status).toBe(201);
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.recorded).toEqual([]);
  });

  it("never performs an approval of a revision it didn't return, or of other terms, and never answers it with the revision it names (check 3, Ops 6)", async () => {
    const c = company();
    const { s, operation } = await refused(c);
    const unknown = await exchange(c, s, approval({ operation_id: operation.operation_id, revision: "1791487200-notOneOfOurs" }));
    expect(unknown.status).toBe(403);
    const renewed = ((await unknown.json()) as { operation: Operation }).operation;
    expect(renewed.operation_id).toBe(operation.operation_id);
    expect(renewed.revision).not.toBe("1791487200-notOneOfOurs");
    // The approved revision with a request for something else: new terms, for what it asks.
    const other = await exchange(c, s, approval(operation), { item_id: "itm_4Qa", replacement_sku: "stormline-m" });
    expect(other.status).toBe(403);
    const changed = ((await other.json()) as { operation: Operation }).operation;
    expect(changed.operation_id).toBe(operation.operation_id);
    expect(changed.revision).not.toBe(operation.revision);
    expect(changed.summary).toContain("stormline-m");
    const state = await c.stub.state();
    expect(state.performs).toBe(0);
    expect(state.recorded).toEqual([]);
  });

  it("asks for approval in an MCP tool result and performs the tool call sent again with the approval in _meta (Ops 4, 6)", async () => {
    const c = company();
    const s = await signedIn(c, { resource: c.hosts.mcpUrl });
    const callTool = (meta?: Record<string, unknown>) =>
      call(c, s, "POST", c.hosts.mcpUrl, {
        headers: MCP_ACCEPT,
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "exchange_item", arguments: { order_id: "ord_7Hk2", ...EXCHANGE }, ...(meta ? { _meta: meta } : {}) } }
      });
    const first = (await (await callTool()).json()) as { result: { isError: boolean; structuredContent: { operation: Operation } } };
    expect(first.result.isError).toBe(true);
    const { operation } = first.result.structuredContent;
    const done = (await (await callTool({ "personalagentprotocol.org/approval": { operation_id: operation.operation_id, revision: operation.revision } })).json()) as { result: { isError?: boolean } };
    expect(done.result.isError).toBeUndefined();
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.recorded).toEqual([]);
  });

  it("orders prints signed out, only once the User approves their terms (Ops 4, 6)", async () => {
    const c = company();
    await c.stub.configure({ printShop: true });
    const s = await session();
    const photo = await uploaded(c, s);
    const asked = await orderPrints(c, s, printOrder(photo), { "Idempotency-Key": `idk_${jti()}` });
    expect(asked.status).toBe(403);
    const { operation } = (await asked.json()) as { operation: Operation };
    expect(operation.operation_id).toMatch(/^prt_/);
    expect((await c.stub.state()).performs).toBe(0);
    const placed = await orderPrints(c, s, printOrder(photo), { "Idempotency-Key": `idk_${jti()}`, ...approval(operation) });
    expect(placed.status).toBe(201);
    expect(await placed.json()).toMatchObject({ order: { state: "awaiting_payment" } });
    // Another Session can't approve a signed-out Session's operation (Ops 3).
    const elsewhere = await session();
    const theirPhoto = await uploaded(c, elsewhere);
    expect((await orderPrints(c, elsewhere, printOrder(theirPhoto), { "Idempotency-Key": `idk_${jti()}`, ...approval(operation) })).status).toBe(403);
    const state = await c.stub.state();
    expect(state.performs).toBe(1);
    expect(state.recorded).toEqual([]);
  });
});

// Found by the Hypothesis stateful test (test/hypothesis), each a reading the mock got wrong.
describe("the mock Company, as the Hypothesis model found it", () => {
  // 4.7: `scopes_supported` holds every scope a Personal Agent can request. Device Sign-In here
  // grants only the orders scopes; a listed scope it can't grant is left out (RFC 6749 3.3). When
  // it, or the User, grants less than was asked, the token response names what was granted, even
  // where the Company usually omits `scope` (RFC 6749 5.1). Only an unlisted scope, or nothing
  // left to grant, is `invalid_scope`.
  it.each([
    { omitTokenScope: false, asked: "orders:read addresses", granted: "orders:read" },
    { omitTokenScope: true, asked: "orders:read addresses", granted: "orders:read" },
    { omitTokenScope: true, asked: "orders:read", granted: undefined },
    { omitTokenScope: true, asked: "orders:read orders:write", approved: ["orders:read"], granted: "orders:read" }
  ] as { omitTokenScope: boolean; asked: string; approved?: string[]; granted: string | undefined }[])("Device Sign-In asked for $asked grants $granted with omitTokenScope $omitTokenScope (4.7, RFC 6749 3.3, 5.1)", async ({ omitTokenScope, asked, approved, granted }) => {
    const c = company();
    await c.stub.configure({ deviceInterval: 1, omitTokenScope });
    const started = await form(c, c.hosts.deviceEndpoint, { scope: asked }, null);
    expect(started.status).toBe(200);
    const device = (await started.json()) as { device_code: string; user_code: string };
    await c.stub.approveDevice(device.user_code, approved ? { scopes: approved } : {});
    const polled = await tokenRequest(c, { grant_type: DEVICE_CODE, device_code: device.device_code });
    expect(polled.status).toBe(200);
    expect(((await polled.json()) as { scope?: string }).scope).toBe(granted);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it.each(["addresses", "orders:read billing"])("refuses Device Sign-In for %s: nothing it can grant, or a scope not listed (4.7)", async (asked) => {
    const c = company();
    const started = await form(c, c.hosts.deviceEndpoint, { scope: asked }, null);
    expect(started.status).toBe(400);
    expect(((await started.json()) as { error: string }).error).toBe("invalid_scope");
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  // A signed-in User opens a conversation, which an order-related message makes the account's
  // (8.2). Then the retry of its first message id comes from a Session that has left that account:
  // another, signed-out Session of the same User, or the same Session continuing signed out once
  // its refresh token is revoked (5.5, 8.11). The idempotency cache would hand back the original
  // conversation and its reply; the ownership gate must come first, so the retry gets a challenge.
  it.each(([
    {
      name: "checks conversation ownership before message-id idempotency on a signed-out retry (S8)",
      retryFrom: async (_c: C, _s: Session): Promise<Session> => session()
    },
    {
      name: "checks conversation ownership before message-id idempotency on a retry after the refresh token is revoked (5.5, 8.11, S8)",
      retryFrom: async (c: C, s: Session): Promise<Session> => {
        expect((await revoke(c, { token: s.refreshToken! })).status).toBe(200);
        return { key: s.key, sid: s.sid };
      }
    }
  ] as const).map((row) => [row.name, row] as const))("%s", async (_name, { retryFrom }) => {
    const c = company();
    const s = await signedIn(c);
    const first = message({ text: "I'd like to exchange the jacket on my order" });
    const opened = await converse(c, s, first);
    expect(opened.status).toBe(201);
    const { conversation_id } = (await opened.json()) as { conversation_id: string };
    expect(conversation_id).toMatch(/^cnv_/);
    const retry = await call(c, await retryFrom(c, s), "POST", `${c.hosts.conversationsEndpoint}?wait=1`, { body: { message: first } });
    expect(retry.status).toBe(401);
    expect(retry.headers.get("WWW-Authenticate")).toContain('scope="orders:read"');
    const body = await retry.text();
    expect(body).not.toContain(conversation_id);
    expect(body).not.toContain("ord_7Hk2");
    // The same User retried their own message: no cross-user violation.
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("takes a retry with the message's members in another order as the same message (8.3)", async () => {
    const c = company();
    const s = await session();
    const first = message({ data: { size: "M", colour: "blue" } });
    const created = await converse(c, s, first);
    expect(created.status).toBe(201);
    const { conversation_id } = (await created.json()) as { conversation_id: string };
    const retry = await converse(c, s, { data: { colour: "blue", size: "M" }, text: first.text, author: first.author, id: first.id });
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { conversation_id: string }).conversation_id).toBe(conversation_id);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("accepts every well-formed RFC 5646 locale and IANA time zone name in context (8.4)", async () => {
    const c = company();
    const s = await session();
    const locales = ["en-US", "i-ami", "en-US-u-ca-gregory", "x-private", "de-CH-1901", "zh-Hant-TW", "sgn-BE-FR", "abcde"];
    const zones = ["CET", "EST5EDT", "Etc/GMT+5", "America/Argentina/Buenos_Aires", "UTC", "Factory", "W-SU"];
    for (const context of [...locales.map((locale) => ({ locale })), ...zones.map((time_zone) => ({ time_zone }))]) {
      expect((await converse(c, s, message({ context }))).status).toBe(201);
    }
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("signs out only the Sessions signed in with the revoked refresh token or one it rotated from (4.6, 5.5)", async () => {
    const c = company();
    await c.stub.configure({ rotateRefreshTokens: true });
    const first = await signedIn(c, { scope: "orders:read" });
    const second = await signedIn(c, { scope: "orders:read", sub: OTHER_USER });
    expect((await getOrders(c, {}, first)).status).toBe(200);
    expect((await getOrders(c, {}, second)).status).toBe(200);
    // `first` refreshes, so its refresh token rotates; revoking the new one signs it out.
    const renewed = await tokensFrom(await refresh(c, first), first.dpop!);
    expect((await revoke(c, { token: renewed.refreshToken })).status).toBe(200);
    expect((await getOrders(c, {}, { ...first, ...renewed })).headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    // `second` signed in on its own, with its own refresh token, so it stays signed in.
    expect((await getOrders(c, {}, second)).status).toBe(200);
    const state = await c.stub.state();
    expect(state.sessions.map((entry) => entry.signedIn)).toEqual([false, true]);
    expect(state.recorded).toEqual([]);
  });

  it("revokes only the reused token's own sign-in when it detects reuse (RFC 9700 4.14.2)", async () => {
    const c = company();
    await c.stub.configure({ rotateRefreshTokens: true, reuseDetection: true });
    const first = await signedIn(c, { scope: "orders:read" });
    const second = await signedIn(c, { scope: "orders:read", sub: OTHER_USER });
    expect((await refresh(c, first)).status).toBe(200);
    expect((await refresh(c, first)).status).toBe(400);
    expect((await getOrders(c, {}, second)).status).toBe(200);
    const state = await c.stub.state();
    expect(state.accountTokens).toBe(1);
    expect(state.recorded.map(violationId)).toEqual(["account-token.rotated-reused"]);
  });

  it("changes nothing on a handoff while a person already handles the conversation: while queued, responder stays agent (8.7, 8.9)", async () => {
    const c = company();
    const s = await session();
    const id = await conversation(c, s);
    await c.stub.humanJoin(id, "Hi, this is Sam.");
    const handoff = await call(c, s, "POST", `${c.hosts.conversationsEndpoint}/${id}/handoff`, { body: {} });
    expect(handoff.status).toBe(202);
    expect(await handoff.json()).toEqual({ status: "idle", responder: "human" });
    const { events } = (await (await call(c, s, "GET", `${c.hosts.conversationsEndpoint}/${id}/events`)).json()) as {
      events: { type: string; status?: string; responder?: string }[];
    };
    expect(events.filter((event) => event.type === "state").map((event) => [event.status, event.responder])).toEqual([["idle", "human"]]);
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("adds direct_closed to the parent when closing the parent closes its Direct Conversation, before the parent's closed state (8.10, 8.12)", async () => {
    const c = company();
    const s = await session();
    const parent = await conversation(c, s);
    const opened = await converse(c, s, message({ author: { type: "human" }, text: "Hi, I have a question." }), { parent_conversation_id: parent });
    const direct = ((await opened.json()) as { conversation_id: string }).conversation_id;
    expect((await call(c, s, "POST", `${c.hosts.conversationsEndpoint}/${parent}/close`, { body: {} })).status).toBe(200);
    const { events } = (await (await call(c, s, "GET", `${c.hosts.conversationsEndpoint}/${parent}/events`)).json()) as {
      events: { type: string; status?: string; conversation_id?: string }[];
    };
    const tail = events.slice(-2).map((event) => [event.type, event.conversation_id ?? event.status]);
    expect(tail).toEqual([
      ["direct_closed", direct],
      ["state", "closed"]
    ]);
    const read = (await (await call(c, s, "GET", `${c.hosts.conversationsEndpoint}/${direct}/events`)).json()) as { status: string };
    expect(read.status).toBe("closed");
    expect((await c.stub.state()).recorded).toEqual([]);
  });

  it("records the MUST only for the same request sent again inside its Retry-After, not another request (5.6)", async () => {
    const c = company();
    await c.stub.configure({ rateLimit: { tokenRequests429: 0, requests429: 1, retryAfterSeconds: 2 } });
    const s = await session();
    expect((await call(c, s, "GET", products(c))).status).toBe(429);
    // A different request inside the window: still 429, but only the Guides' advice is broken.
    expect((await call(c, s, "GET", orders(c))).status).toBe(429);
    // Each request that got 429 sent again inside its Retry-After: the MUST.
    expect((await call(c, s, "GET", products(c))).status).toBe(429);
    expect((await call(c, s, "GET", orders(c))).status).toBe(429);
    expect((await c.stub.state()).recorded.map(violationId)).toEqual([
      "rate-limit.shared-limit-ignored",
      "rate-limit.retry-after-ignored",
      "rate-limit.retry-after-ignored"
    ]);
  });
});

/**
 * Company flaws (test/mock-company/types.ts `COMPANY_FLAWS`), for the
 * flawed-Company lane (interop/vectors/official/flaws.mjs): each row asks
 * whether the Company protected itself. The honest mock must; with the flaw,
 * it must not. Otherwise a checker's "caught it" or "missed it" in that lane
 * says nothing.
 */
const FLAW_CASES: Record<CompanyFlaw, { readonly config?: Partial<MockConfig>; readonly protects: (c: C) => Promise<boolean> }> = {
  "accept-replayed-assertion": {
    protects: async (c) => {
      const client = await clientAssertion(c);
      expect((await revoke(c, { client })).status).toBe(200);
      return (await revoke(c, { client })).status !== 200;
    }
  },
  "accept-replayed-proof": {
    protects: async (c) => {
      const s = await signedIn(c);
      const dpop = await proof(s.dpop!, "GET", orders(c), s.token);
      expect((await getOrders(c, { proof: dpop }, s)).status).toBe(200);
      return (await getOrders(c, { proof: dpop }, s)).status !== 200;
    }
  },
  "accept-wrong-htu": {
    protects: async (c) => (await getOrders(c, { proof: { claims: { htu: products(c) } } })).status !== 200
  },
  "accept-other-key": {
    protects: async (c) => {
      const s = await signedIn(c);
      return (await getOrders(c, {}, { ...s, dpop: await dpopKey() })).status !== 200;
    }
  },
  "accept-bearer-scheme": {
    protects: async (c) => {
      const s = await signedIn(c);
      return (await getOrders(c, { auth: `Bearer ${s.token}`, proof: null }, s)).status !== 200;
    }
  },
  "accept-query-token": {
    protects: async (c) => {
      const s = await signedIn(c);
      return (await call(c, s, "GET", `${orders(c)}?access_token=${encodeURIComponent(s.token!)}`, { token: null })).status !== 200;
    }
  },
  "accept-token-endpoint-aud": {
    protects: async (c) => {
      expect((await revoke(c)).status).toBe(200);
      return (await revoke(c, { client: await clientAssertion(c, { claims: { aud: c.hosts.tokenEndpoint } }) })).status !== 200;
    }
  },
  "token-cacheable": {
    protects: async (c) => {
      const response = await exchangeCode(c, await authorizationCode(c), await dpopKey());
      expect(response.status).toBe(200);
      return response.headers.get("Cache-Control") === "no-store";
    }
  },
  "retry-new-conversation": {
    protects: async (c) => {
      const s = await session();
      const first = message();
      const ids = [];
      for (let attempt = 0; attempt < 2; attempt++) ids.push(((await (await converse(c, s, first)).json()) as { conversation_id: string }).conversation_id);
      return ids[0] === ids[1];
    }
  },
  "accept-rotated-account-token": {
    config: { rotateRefreshTokens: true },
    protects: async (c) => {
      const s = await signedIn(c);
      expect((await refresh(c, s)).status).toBe(200);
      return (await refresh(c, s)).status !== 200;
    }
  }
};

describe("Company flaws", () => {
  it.each(COMPANY_FLAWS.map((flaw) => [flaw] as const))("%s: the honest mock protects itself, the flawed one doesn't", async (flaw) => {
    const { config, protects } = FLAW_CASES[flaw];
    const honest = company();
    if (config) await honest.stub.configure(config);
    expect(await protects(honest)).toBe(true);
    const flawed = company();
    await flawed.stub.configure({ ...config, flaws: [flaw] });
    expect(await protects(flawed)).toBe(false);
  });

  it("still records what the agent did wrong when a flaw lets it through", async () => {
    const c = company();
    await c.stub.configure({ flaws: ["accept-replayed-assertion"] });
    const client = await clientAssertion(c);
    await revoke(c, { client });
    await revoke(c, { client });
    expect((await c.stub.state()).recorded.map(violationId)).toEqual(["client-assertion.jti-reused"]);
  });
});
