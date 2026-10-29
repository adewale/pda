/**
 * Raw, deliberately invalid Poppy 0.3 requests. Only the local adversarial
 * adapter imports this; no production client relaxation or live identity.
 * Every probe first establishes an accepted, otherwise equivalent request.
 */
import type { Company } from "../../../src/poppy/discovery.ts";
import { MEDIATED_GRANT } from "../../../src/poppy/discovery.ts";
import { clientAssertion, delegate, dpopProof, newDpopKey, randomId, sessionJwt, type Delegated, type DpopKey } from "../../../src/poppy/jwt.ts";
import { currentKey } from "../../../src/poppy/keys.ts";

export const ATTACKS = ["YR", "YD", "YA", "YT", "YS", "YK", "YU", "YM"] as const;
export type AttackId = typeof ATTACKS[number];
export class AttackSetupError extends Error {}
export class AttackUnsupported extends Error {}
export type AttackContext = {
  clientId: string;
  signingJwks: string;
  fetcher: (request: Request) => Promise<Response>;
};
export type AttackResult = { status: number; body: unknown };
export type AttackPlan = { run(phase?: string): Promise<AttackResult> };
type Params = Record<string, unknown>;
type Tokens = { access: string; refresh: string; type: string };
type User = { sid: string; id: string; delegated: Delegated; dpop: DpopKey; tokens?: Tokens };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
async function result(response: Response): Promise<AttackResult> {
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* Preserve a non-JSON refusal as evidence. */ }
  return { status: response.status, body };
}
function accepted(answer: AttackResult, description: string): void {
  if (answer.status < 200 || answer.status >= 300) throw new AttackSetupError(`${description}: HTTP ${answer.status}`);
}
function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || !value) throw new AttackSetupError(`Missing ${description}`);
  return value;
}

export async function prepareAttack(ctx: AttackContext, company: Company, attack: AttackId, params: Params): Promise<AttackPlan> {
  const signing = await currentKey({ POPPY_SIGNING_JWKS: ctx.signingJwks });
  const newUser = async (): Promise<User> => ({ sid: randomId("ses_"), id: randomId("usr_"), delegated: await delegate(signing, ctx.clientId, await newDpopKey()), dpop: await newDpopKey() });
  const user = await newUser();
  // This adapter only targets our mock's declared API. Find its server in
  // its actual document instead of guessing hosts from an issuer's spelling.
  const api = company.apis.find((item) => item.type === "openapi");
  if (!api) throw new AttackUnsupported("The attack needs the mock's OpenAPI API");
  const description = await result(await ctx.fetcher(new Request(api.url)));
  accepted(description, "OpenAPI description");
  const server = record((record(description.body).servers as unknown[] | undefined)?.[0]).url;
  const base = requiredString(server, "OpenAPI server").replace(/\/$/, "");
  const orders = `${base}/orders`, order = `${base}/orders/ord_7Hk2`, products = `${base}/products`;
  const write = `${order}/exchanges`;
  const writeBody = JSON.stringify({ item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" });

  async function session(who: User, method: string, url: string, audience: string = company.issuer): Promise<string> {
    return sessionJwt(who.delegated, { clientId: ctx.clientId, issuer: audience, sid: who.sid, userId: who.id, method, url, ...(who.tokens ? { accessToken: who.tokens.access } : {}) });
  }
  async function resource(who: User, url: string, options: { method?: string; body?: string; session?: string; proof?: string; proofKey?: DpopKey; audience?: string; marker?: string; approval?: string } = {}): Promise<AttackResult> {
    const method = options.method ?? "GET";
    const headers = new Headers({ "Poppy-Session": options.session ?? await session(who, method, url, options.audience) });
    if (who.tokens) {
      headers.set("Authorization", `${who.tokens.type} ${who.tokens.access}`);
      if (who.tokens.type.toLowerCase() === "dpop") headers.set("DPoP", options.proof ?? await dpopProof(options.proofKey ?? who.dpop, { method, url, accessToken: who.tokens.access }));
    }
    if (options.body) headers.set("Content-Type", "application/json");
    if (options.marker) headers.set("X-Interop-Attack", options.marker);
    if (options.approval) headers.set("Poppy-Approval", options.approval);
    return result(await ctx.fetcher(new Request(url, { method, headers, ...(options.body ? { body: options.body } : {}) })));
  }
  async function grant(who: User, fields: Record<string, string>, marker?: string): Promise<AttackResult> {
    const form = new URLSearchParams({ ...fields, client_id: ctx.clientId, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: await clientAssertion(signing, ctx.clientId, company.issuer) });
    const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
    if (company.dpop) headers.set("DPoP", await dpopProof(who.dpop, { method: "POST", url: company.endpoints.token }));
    if (marker) headers.set("X-Interop-Attack", marker);
    return result(await ctx.fetcher(new Request(company.endpoints.token, { method: "POST", headers, body: form.toString() })));
  }
  function tokens(answer: AttackResult): Tokens {
    const body = record(answer.body);
    return { access: requiredString(body.access_token, "access token"), refresh: requiredString(body.refresh_token, "refresh token"), type: requiredString(body.token_type, "token type") };
  }
  async function signin(scopes: string[]): Promise<void> {
    if (!company.signIn.mediated) throw new AttackUnsupported("The attack needs Mediated Sign-In 1");
    const fields = record(params.fields);
    const answer = await grant(user, { grant_type: MEDIATED_GRANT, scope: scopes.join(" "), email: requiredString(fields.email, "fixture email"), password: requiredString(fields.password, "fixture password") });
    accepted(answer, "Honest mediated sign-in");
    user.tokens = tokens(answer);
    accepted(await resource(user, orders), "Honest account read");
  }
  const readScopes = Array.isArray(params.read_scopes) ? params.read_scopes.filter((item): item is string => typeof item === "string") : [];
  const writeScopes = Array.isArray(params.write_scopes) ? params.write_scopes.filter((item): item is string => typeof item === "string") : [];

  if (attack === "YA") {
    accepted(await resource(user, products), "Honest signed-out request");
    return { run: () => resource(user, products, { audience: "https://foreign.company.interop.test", marker: attack }) };
  }
  if (attack === "YU") {
    if (!company.conversations) throw new AttackUnsupported("The attack needs conversations");
    const endpoint = company.conversations.endpoint;
    const message = (text: string) => JSON.stringify({ message: { id: randomId("msg_"), author: { type: "agent" }, text } });
    const started = await resource(user, endpoint, { method: "POST", body: message("Hello") });
    accepted(started, "User A's new conversation");
    const id = requiredString(record(started.body).conversation_id, "conversation id");
    const url = `${endpoint}/${encodeURIComponent(id)}/events`;
    accepted(await resource(user, url), "User A's own conversation read");
    const other = await newUser();
    accepted(await resource(other, endpoint, { method: "POST", body: message("Hello from User B") }), "User B's own conversation");
    return { run: () => resource(other, url, { marker: attack }) };
  }

  await signin(attack === "YM" ? writeScopes : readScopes);
  if (attack === "YR" || attack === "YD") {
    if (attack === "YD" && user.tokens!.type.toLowerCase() !== "dpop") throw new AttackUnsupported("The Company doesn't issue DPoP-bound tokens");
    // Both URLs must work honestly; a 404 or different scope cannot explain
    // rejection. Then replay just one credential across the URL boundary.
    accepted(await resource(user, order), "Honest target account read");
    const capturedSession = await session(user, "GET", orders);
    const capturedProof = await dpopProof(user.dpop, { method: "GET", url: orders, accessToken: user.tokens!.access });
    accepted(await resource(user, orders, { session: capturedSession, proof: capturedProof }), "Captured honest request");
    return { run: async (phase = "probe") => {
      if (phase !== "probe" && phase !== "fresh") throw new AttackSetupError(`Unknown URL-binding phase ${phase}`);
      const fresh = phase === "fresh";
      const wrongSession = fresh ? await session(user, "GET", orders) : capturedSession;
      const wrongProof = fresh ? await dpopProof(user.dpop, { method: "GET", url: orders, accessToken: user.tokens!.access }) : capturedProof;
      return resource(user, order, { ...(attack === "YR" ? { session: wrongSession } : { proof: wrongProof }), marker: fresh ? `${attack}-fresh` : attack });
    } };
  }
  if (attack === "YT") {
    if (user.tokens!.type.toLowerCase() !== "dpop") throw new AttackUnsupported("The Company doesn't issue DPoP-bound tokens");
    const thiefKey = await newDpopKey();
    return { run: () => resource(user, orders, { proofKey: thiefKey, marker: attack }) };
  }
  if (attack === "YS") {
    if (!readScopes.length || !writeScopes.some((scope) => !readScopes.includes(scope))) throw new AttackUnsupported("The fixture needs distinct read and write scopes");
    return { run: () => resource(user, write, { method: "POST", body: writeBody, marker: attack }) };
  }
  if (attack === "YK") {
    const original = user.tokens!.refresh;
    const rotated = await grant(user, { grant_type: "refresh_token", refresh_token: original });
    accepted(rotated, "First refresh-token use");
    if (tokens(rotated).refresh === original) throw new AttackUnsupported("This Company doesn't rotate refresh tokens");
    return { run: () => grant(user, { grant_type: "refresh_token", refresh_token: original }, attack) };
  }
  // Operations 2: obtain real terms; an invented revision must not approve
  // them. Separate phases let the runner inspect effects between requests.
  const proposed = await resource(user, write, { method: "POST", body: writeBody });
  const operation = record(record(proposed.body).operation);
  if (proposed.status !== 403 || record(proposed.body).error !== "approval_required") throw new AttackSetupError("An honest write didn't return 403 approval_required");
  const operationId = requiredString(operation.operation_id, "operation_id");
  const revision = requiredString(operation.revision, "revision");
  const header = (value: string) => `operation_id=${JSON.stringify(operationId)}, revision=${JSON.stringify(value)}`;
  return { run: (phase = "probe") => {
    if (!["probe", "approve", "replay"].includes(phase)) throw new AttackSetupError(`Unknown Operations 2 attack phase ${phase}`);
    return resource(user, write, { method: "POST", body: writeBody, approval: header(phase === "probe" ? `invented-${randomId()}` : revision), marker: phase === "probe" ? attack : `${attack}-${phase}` });
  } };
}

/** Reuse a consumed code with fresh independent credentials, isolating code single-use from optional JWT replay policy. */
export async function freshCodeReplay(ctx: AttackContext, company: Company, original: Request, key: DpopKey, nonce?: string): Promise<Request> {
  const fields = new URLSearchParams(await original.clone().text());
  if (original.url !== company.endpoints.token || fields.get("grant_type") !== "authorization_code" || !fields.get("code") || fields.get("client_id") !== ctx.clientId) throw new AttackSetupError("No successful code exchange for this Company and client");
  const signing = await currentKey({ POPPY_SIGNING_JWKS: ctx.signingJwks });
  fields.set("client_assertion", await clientAssertion(signing, ctx.clientId, company.issuer));
  const headers = new Headers(original.headers);
  headers.delete("content-length");
  headers.set("X-Interop-Attack", "NREP-fresh");
  if (company.dpop) headers.set("DPoP", await dpopProof(key, { method: "POST", url: company.endpoints.token, ...(nonce ? { nonce } : {}) }));
  return new Request(original.url, { method: "POST", headers, body: fields.toString() });
}
