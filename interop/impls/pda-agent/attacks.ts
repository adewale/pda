/**
 * The adversarial Personal Agent's attacks (docs/adversarial-interop.md, Part B).
 * Interop-only: this file is bundled into the pda-agent image but runs only
 * when the adapter is armed (the `evil-personal-agent` registry entry sets
 * `INTEROP_ADVERSARY=agent`). None of it is in `src/poppy`; it crafts raw
 * OAuth and resource requests with jose, over the recording proxy, to turn
 * the mock Company's `TAMPERS` checks (test/mock-company.test.ts) into wire
 * attacks against any honest Company.
 *
 * Each attack returns what the Company answered; the scenario's `expect`
 * asserts the Company refused (an OAuth error or 4xx), and harm oracles
 * (spec §8) confirm nothing harmful happened. Attribution rule 0 passes the
 * cell when the honest Company refuses, and blames it otherwise.
 */
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import type { Company } from "../../../src/poppy/discovery.ts";
import type { Fetcher } from "../../../src/poppy/fetch.ts";
import { isDraft2 } from "../../../src/poppy/protocol-version.ts";

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

const now = () => Math.floor(Date.now() / 1000);
const jti = () => base64url.encode(crypto.getRandomValues(new Uint8Array(16)));
const sha256 = async (text: string) => base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

export type AttackContext = {
  readonly clientId: string;
  readonly signingJwks: string;
  readonly fetcher: Fetcher;
};

/** Failure to establish the honest preconditions is a harness error, never a refusal. */
export class AttackSetupError extends Error {}

export type AttackResult = { readonly status: number; readonly body: unknown; readonly poppy_error?: string; readonly detail?: string };

/** The armed attack ids this adapter supports (manifest `attacks`, spec §4). */
export const ATTACKS = ["YR", "YD", "YA", "YT", "YS", "YK", "YU", "YM"] as const;
export type AttackId = (typeof ATTACKS)[number];

type Signer = { kid: string; key: CryptoKey };

async function signer(signingJwks: string): Promise<Signer> {
  const [first] = JSON.parse(signingJwks) as JWK[];
  if (!first?.kid) throw new Error("no published signing key");
  return { kid: first.kid, key: (await importJWK(first, "ES256")) as CryptoKey };
}

async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, jkt: await calculateJwkThumbprint(jwk), nonce: undefined as string | undefined };
}
type DpopKey = Awaited<ReturnType<typeof dpopKey>>;

/** Both assertions' `aud`: the issuer from 0.2 on, the token endpoint before it (as `src/poppy/client.ts`). */
const audienceOf = (company: Company): string => (isDraft2(company) ? company.issuer : company.endpoints.token);

async function clientAssertion(ctx: AttackContext, s: Signer, aud: string, id = jti()): Promise<string> {
  const issuedAt = now();
  return new SignJWT({ iss: ctx.clientId, sub: ctx.clientId, aud, iat: issuedAt, exp: issuedAt + 60, jti: id })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: s.kid })
    .sign(s.key);
}

async function sessionAssertion(ctx: AttackContext, s: Signer, aud: string, sub = "usr_Q7c1vKx9TzLw3NdR5mHa2B", id = jti()): Promise<string> {
  const issuedAt = now();
  return new SignJWT({ iss: ctx.clientId, sub, aud, iat: issuedAt, exp: issuedAt + 60, jti: id })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: s.kid })
    .sign(s.key);
}

async function proof(key: DpopKey, method: string, url: string, token?: string, id = jti()): Promise<string> {
  const claims: Record<string, unknown> = { htm: method, htu: url.split("?")[0], iat: now(), jti: id };
  if (key.nonce) claims.nonce = key.nonce;
  if (token) claims.ath = await sha256(token);
  return new SignJWT(claims).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: key.jwk }).sign(key.privateKey);
}

async function post(ctx: AttackContext, url: string, fields: Record<string, string>, headers: Record<string, string>): Promise<Response> {
  return ctx.fetcher(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() }));
}

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorOf(status: number, body: unknown): Pick<AttackResult, "poppy_error" | "detail"> {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof record.error === "string") return { poppy_error: record.error, detail: typeof record.error_description === "string" ? record.error_description : undefined };
  if (status >= 400) return { poppy_error: "http_error", detail: `HTTP ${status}` };
  return {};
}

/** Establish an honest Session, regenerating one-shot credentials on bounded nonce retries.
 * Keep the accepted request's bytes: the attack must replay those, not a challenged request.
 */
async function startSession(ctx: AttackContext, company: Company, key: DpopKey, sub = "usr_Q7c1vKx9TzLw3NdR5mHa2B") {
  const endpoint = company.endpoints.token;
  const aud = audienceOf(company);
  const s = await signer(ctx.signingJwks);
  for (let attempt = 0; attempt < 3; attempt++) {
    const assertion = await sessionAssertion(ctx, s, aud, sub);
    const dpop = await proof(key, "POST", endpoint);
    const response = await post(ctx, endpoint,
      { grant_type: JWT_BEARER, assertion, client_id: ctx.clientId, client_assertion_type: ASSERTION_TYPE, client_assertion: await clientAssertion(ctx, s, aud) },
      { DPoP: dpop });
    const parsed = await bodyOf(response);
    const body = (parsed !== null && typeof parsed === "object" ? parsed : {}) as { error?: string; access_token?: string; session_id?: string };
    const nonce = response.headers.get("dpop-nonce");
    if (nonce) key.nonce = nonce;
    if (response.status === 400 && body.error === "use_dpop_nonce" && nonce) continue;
    if (response.status !== 200 || typeof body.access_token !== "string" || !body.access_token || typeof body.session_id !== "string" || !body.session_id) {
      throw new AttackSetupError(`Session setup failed: HTTP ${response.status} (${body.error ?? "invalid token response"})`);
    }
    return { token: body.access_token, sessionId: body.session_id, key, assertion, dpop };
  }
  throw new AttackSetupError("Session setup exhausted its nonce retries; no attack was sent");
}

async function finish(response: Response): Promise<AttackResult> {
  const body = await bodyOf(response);
  return { status: response.status, body, ...errorOf(response.status, body) };
}

/**
 * Run an armed attack against `company`. Each performs its own flow and
 * returns the Company's answer; the honest Company is expected to refuse.
 */
export async function runAttack(ctx: AttackContext, company: Company, attack: string, params: Record<string, unknown>): Promise<AttackResult> {
  const endpoint = company.endpoints.token;
  const aud = audienceOf(company);
  const s = await signer(ctx.signingJwks);
  switch (attack) {
    case "YR": {
      // Replay only the accepted Session assertion; the client assertion and proof are fresh.
      const session = await startSession(ctx, company, await dpopKey());
      return finish(await post(ctx, endpoint, { grant_type: JWT_BEARER, assertion: session.assertion, client_id: ctx.clientId, client_assertion_type: ASSERTION_TYPE, client_assertion: await clientAssertion(ctx, s, aud) }, { DPoP: await proof(session.key, "POST", endpoint) }));
    }
    case "YD": {
      // Replay the exact accepted proof; both other assertions are fresh. Never retry the attack.
      const session = await startSession(ctx, company, await dpopKey());
      return finish(await post(ctx, endpoint, { grant_type: JWT_BEARER, assertion: await sessionAssertion(ctx, s, aud), client_id: ctx.clientId, client_assertion_type: ASSERTION_TYPE, client_assertion: await clientAssertion(ctx, s, aud) }, { DPoP: session.dpop }));
    }
    case "YA": {
      // aud confusion: a client assertion minted for another Company presented here (4.1; client-assertion.aud).
      const foreign = typeof params.aud === "string" ? params.aud : "https://auth.other.company.interop.test/oauth/token";
      if (foreign === aud) throw new AttackSetupError("Audience attack needs an audience other than this Company's own");
      const session = await startSession(ctx, company, await dpopKey());
      // The accepted baseline supplies the current nonce and proves the other
      // claims/key work. Fresh one-shot credentials isolate the wrong audience.
      return finish(await post(ctx, endpoint, { grant_type: JWT_BEARER, assertion: await sessionAssertion(ctx, s, aud), client_id: ctx.clientId, client_assertion_type: ASSERTION_TYPE, client_assertion: await clientAssertion(ctx, s, foreign) }, { DPoP: await proof(session.key, "POST", endpoint) }));
    }
    case "YT": {
      // Stolen token, another key: a Session Token with a proof from a different key (4.3; dpop.key-mismatch).
      const session = await startSession(ctx, company, await dpopKey());
      const target = resourceUrl(company, params);
      const otherKey = await dpopKey();
      return finish(await ctx.fetcher(new Request(target, { headers: { Authorization: `DPoP ${session.token}`, DPoP: await proof(otherKey, "GET", target, session.token) } })));
    }
    case "YS": {
      // Scope/scheme: a Session Token presented with the Bearer scheme outside MCP (6; resource.bearer-scheme).
      const session = await startSession(ctx, company, await dpopKey());
      const target = resourceUrl(company, params);
      return finish(await ctx.fetcher(new Request(target, { headers: { Authorization: `Bearer ${session.token}`, DPoP: await proof(session.key, "GET", target, session.token) } })));
    }
    case "YK": {
      // Rotation abuse: an Account Token reused after the Company rotated it (4.8; account-token.rotated-reused).
      const mediated = company.signIn.mediated?.endpoint;
      if (!mediated) return { status: 0, body: null, poppy_error: "unsupported", detail: "no Mediated Sign-In" };
      const session = await startSession(ctx, company, await dpopKey());
      const credentials = (params.credentials as Record<string, string>) ?? { email: "ada@example.com", password: "correct horse" };
      const signedIn = (await bodyOf(
        await ctx.fetcher(new Request(mediated, { method: "POST", headers: { "content-type": "application/json", Authorization: `DPoP ${session.token}`, DPoP: await proof(session.key, "POST", mediated, session.token) }, body: JSON.stringify({ scope: "poppy:read poppy:write", credentials }) }))
      )) as { refresh_token?: string };
      if (!signedIn.refresh_token) throw new AttackSetupError("Sign-in setup issued no Account Token");
      const refresh = async () =>
        post(ctx, endpoint, { grant_type: "refresh_token", refresh_token: signedIn.refresh_token!, session_id: session.sessionId, client_id: ctx.clientId, client_assertion_type: ASSERTION_TYPE, client_assertion: await clientAssertion(ctx, s, aud) }, { DPoP: await proof(session.key, "POST", endpoint) });
      const first = await refresh();
      if (first.status !== 200) throw new AttackSetupError(`Refresh setup failed: HTTP ${first.status}`);
      return finish(await refresh());
    }
    case "YU": {
      // Cross-User conversation: User B of the same agent reads User A's conversation id (7.13; conversation.cross-user).
      const conversations = company.conversations?.endpoint;
      if (!conversations) return { status: 0, body: null, poppy_error: "unsupported", detail: "no conversations" };
      // User A signs in and opens a conversation.
      const a = await startSession(ctx, company, await dpopKey());
      const opened = (await bodyOf(
        await ctx.fetcher(new Request(conversations, { method: "POST", headers: { "content-type": "application/json", Authorization: `DPoP ${a.token}`, DPoP: await proof(a.key, "POST", conversations, a.token) }, body: JSON.stringify({ message: { id: `msg_${jti()}`, sender: "agent", text: "Where is my order?" } }) }))
      )) as { conversation_id?: string };
      if (!opened.conversation_id) throw new AttackSetupError("User A could not open the setup conversation");
      // User B of the same agent (a different User ID) reads User A's conversation.
      const b = await startSession(ctx, company, await dpopKey(), "usr_Hd8pW2zQ5nVb7LtK3xRc9F");
      const target = `${conversations.replace(/\/+$/, "")}/${encodeURIComponent(opened.conversation_id)}`;
      return finish(await ctx.fetcher(new Request(target, { headers: { Authorization: `DPoP ${b.token}`, DPoP: await proof(b.key, "GET", target, b.token) } })));
    }
    case "YM": {
      // Confirm an operation without the User's approval (Ops 5.1; confirm.approved-by).
      // Sign in with write, propose the exchange, then POST /confirm with no approved_by.
      const mediated = company.signIn.mediated?.endpoint;
      const operations = company.extensions.operations?.endpoint;
      const openapi = company.apis.find((entry) => entry.type === "openapi");
      if (!mediated || !operations || !openapi) {
        return { status: 0, body: null, poppy_error: "unsupported", detail: "YM needs Mediated Sign-In, the Operations extension and an OpenAPI" };
      }
      const session = await startSession(ctx, company, await dpopKey());
      const credentials = (params.credentials as Record<string, string>) ?? { email: "ada@example.com", password: "correct horse" };
      const signedIn = (await bodyOf(
        await ctx.fetcher(new Request(mediated, { method: "POST", headers: { "content-type": "application/json", Authorization: `DPoP ${session.token}`, DPoP: await proof(session.key, "POST", mediated, session.token) }, body: JSON.stringify({ scope: "poppy:read poppy:write", credentials }) }))
      )) as { refresh_token?: string };
      if (!signedIn.refresh_token) throw new AttackSetupError("Sign-in setup issued no Account Token");
      // A write Session Token from the Account Token.
      const refreshed = (await bodyOf(
        await post(ctx, endpoint, { grant_type: "refresh_token", refresh_token: signedIn.refresh_token, session_id: session.sessionId, client_id: ctx.clientId, client_assertion_type: ASSERTION_TYPE, client_assertion: await clientAssertion(ctx, s, aud) }, { DPoP: await proof(session.key, "POST", endpoint) })
      )) as { access_token?: string };
      if (!refreshed.access_token) throw new AttackSetupError("Refresh setup issued no write Session Token");
      const writeToken = refreshed.access_token;
      // Propose the jacket exchange (202 with an operation).
      const exchangeUrl = `${new URL(openapi.url).origin}/orders/ord_7Hk2/exchanges`;
      const proposed = (await bodyOf(
        await ctx.fetcher(new Request(exchangeUrl, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": `${jti()}${jti()}`, Authorization: `DPoP ${writeToken}`, DPoP: await proof(session.key, "POST", exchangeUrl, writeToken) }, body: JSON.stringify({ item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" }) }))
      )) as { operation?: { operation_id?: string; revision?: number } };
      const op = proposed.operation;
      if (!op?.operation_id) throw new AttackSetupError("The setup exchange did not propose an operation");
      // Confirm it without saying the User approved: approved_by omitted.
      const confirmUrl = `${operations.replace(/\/+$/, "")}/${encodeURIComponent(op.operation_id)}/confirm`;
      return finish(await ctx.fetcher(new Request(confirmUrl, { method: "POST", headers: { "content-type": "application/json", Authorization: `DPoP ${writeToken}`, DPoP: await proof(session.key, "POST", confirmUrl, writeToken) }, body: JSON.stringify({ revision: op.revision ?? 1 }) })));
    }
    default:
      return { status: 501, body: null, poppy_error: "unsupported", detail: `unknown attack ${attack}` };
  }
}

/** The resource a token attack hits: an OpenAPI read, by default the Company's own API `/products`. */
function resourceUrl(company: Company, params: Record<string, unknown>): string {
  if (typeof params.url === "string") return params.url;
  const api = company.apis.find((entry) => entry.type === "openapi");
  const base = api ? new URL(api.url) : new URL(company.endpoints.token);
  return `${base.origin}/products`;
}
