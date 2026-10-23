/**
 * The fake Personal Agents (docs/interop-spec.md §2): our agent with a
 * profile, as `strict-company` is the mock with one. A profile changes only
 * the adapter's network seam; src/poppy runs unchanged, and never sees it.
 *
 * - `lenient`: accepts every reading of what a Company does that gives no
 *   more access. Server metadata at the appended location when the RFC 8414
 *   inserted one is 404 (S3 `either`; the metadata's `issuer` must still
 *   equal `auth.issuer`), and a client assertion refused with
 *   `invalid_client` at an endpoint without DPoP is sent again naming the
 *   Company's other names, the token endpoint and the issuer (S1). The
 *   reference agent for attribution rule 2.
 * - `strict`: runs the runner's own Company-side checks and the validator
 *   over everything it receives, and refuses at the first finding of any
 *   level, a SHOULD or the Guides included. It serves what it found at
 *   `GET /violations`, as the mock does for the agent.
 * - `sloppy`: what real agents get wrong, declared honestly in its
 *   readings: assertions without `typ` that live 300 s (S2
 *   `lenient-300s`), a client and Session assertion `aud` of the token
 *   endpoint everywhere (S1 `token-endpoint`), and `scope=poppy:read` on a
 *   signed-out Session request (S4 `poppy-read`).
 *
 * Interop-only; never in src/.
 */
import { decodeJwt, decodeProtectedHeader } from "jose";
import { levelOf, type Basis, type Level } from "../../../src/validator/levels.ts";
import { traceChecks } from "../../runner/checks.ts";
import { documentChecks } from "../../runner/documents.ts";
import { direction, isServerMetadata, type Exchange } from "../../runner/har.ts";
import type { Check } from "../../runner/types.ts";

export const PROFILES = ["lenient", "strict", "sloppy"] as const;
export type AgentProfile = (typeof PROFILES)[number];

export function profileFrom(value: string | undefined): AgentProfile | null {
  if (!value) return null;
  if (!(PROFILES as readonly string[]).includes(value)) throw new Error(`Unknown INTEROP_AGENT_PROFILE ${value}`);
  return value as AgentProfile;
}

/** Each profile's declared readings (spec §7). `pda`'s are the strict profile's. */
export const PROFILE_READINGS: Readonly<Record<AgentProfile, Readonly<Record<string, string>>>> = {
  lenient: { S1: "endpoint", S2: "jwt-60s", S3: "either", S4: "omit", S23: "per-origin" },
  strict: { S1: "endpoint", S2: "jwt-60s", S3: "insertion", S4: "omit", S23: "per-origin" },
  sloppy: { S1: "token-endpoint", S2: "lenient-300s", S3: "insertion", S4: "poppy-read", S23: "per-origin" }
};

/** How long the sloppy agent's assertions live: the longest the lenient readings accept. */
export const SLOPPY_LIFETIME = 300;

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const METADATA_INSERTED = /^\/\.well-known\/oauth-authorization-server(\/.+)$/;
const ASSERTION_ENDPOINTS = ["token_endpoint", "device_authorization_endpoint", "revocation_endpoint", "pushed_authorization_request_endpoint"] as const;

/** Re-sign a JWT with its claims changed: `typ` dropped, `aud` replaced, a new lifetime, a fresh `jti`. */
export type Resign = (jwt: string, change: { readonly dropTyp?: boolean; readonly aud?: string; readonly lifetime?: number; readonly fresh?: boolean }) => Promise<string>;

/** The issuer and token endpoint behind each endpoint a client assertion goes to, from server metadata seen in passing. */
export class Endpoints {
  readonly #byEndpoint = new Map<string, { issuer: string; token: string }>();

  async observe(url: string, response: Response): Promise<void> {
    if (!response.ok || !isServerMetadata({ url: new URL(url) })) return;
    let metadata: unknown;
    try {
      metadata = await response.clone().json();
    } catch {
      return;
    }
    if (!isObject(metadata) || typeof metadata.issuer !== "string" || typeof metadata.token_endpoint !== "string") return;
    for (const name of ASSERTION_ENDPOINTS) {
      const value = metadata[name];
      if (typeof value === "string") this.#byEndpoint.set(value, { issuer: metadata.issuer, token: metadata.token_endpoint });
    }
  }

  of(url: string): { issuer: string; token: string } | undefined {
    const bare = new URL(url);
    bare.search = "";
    return this.#byEndpoint.get(bare.href);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isForm = (request: Request) => request.method === "POST" && (request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded");
const isJwt = (value: string | null): value is string => !!value && value.split(".").length === 3;

/** The sloppy agent's request: the same request with its assertions and grant made sloppy. */
export async function sloppyRequest(request: Request, endpoints: Endpoints, resign: Resign): Promise<Request> {
  if (!isForm(request)) return request;
  const target = endpoints.of(request.url);
  if (!target) return request;
  const fields = new URLSearchParams(await request.clone().text());
  let changed = false;
  for (const name of ["client_assertion", "assertion"]) {
    const value = fields.get(name);
    if (!isJwt(value)) continue;
    fields.set(name, await resign(value, { dropTyp: true, aud: target.token, lifetime: SLOPPY_LIFETIME }));
    changed = true;
  }
  if (fields.get("grant_type") === JWT_BEARER && !fields.has("scope")) {
    fields.set("scope", "poppy:read");
    changed = true;
  }
  return changed ? new Request(request, { body: fields.toString() }) : request;
}

/** An OAuth error code from a response, without consuming it. */
async function oauthError(response: Response): Promise<string | null> {
  if (response.status !== 400 && response.status !== 401) return null;
  try {
    const body: unknown = await response.clone().json();
    return isObject(body) && typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * The lenient agent's fetch. Metadata at the appended location when the inserted one is 404
 * (S3), and a client assertion refused with `invalid_client` sent again with each of this
 * Company's other names as `aud` (S1), each freshly signed. Only where the request carries no
 * DPoP proof, which this seam can't sign again: the device and revocation endpoints.
 */
export async function lenientFetch(request: Request, next: (request: Request) => Promise<Response>, endpoints: Endpoints, resign: Resign): Promise<Response> {
  const url = new URL(request.url);
  const body = isForm(request) ? await request.clone().text() : null;
  const response = await next(request);
  const inserted = METADATA_INSERTED.exec(url.pathname);
  if (request.method === "GET" && inserted && response.status === 404) {
    const appended = await next(new Request(new URL(`${inserted[1]}/.well-known/oauth-authorization-server`, url.origin), { headers: request.headers }));
    if (appended.ok) return appended;
    return response;
  }
  if (body === null || request.headers.has("dpop") || (await oauthError(response)) !== "invalid_client") return response;
  const fields = new URLSearchParams(body);
  const assertion = fields.get("client_assertion");
  const target = endpoints.of(request.url);
  if (!isJwt(assertion) || !target) return response;
  const tried = new Set([String(decodeJwt(assertion).aud)]);
  let last = response;
  for (const aud of [target.token, target.issuer]) {
    if (tried.has(aud)) continue;
    tried.add(aud);
    fields.set("client_assertion", await resign(assertion, { aud, fresh: true }));
    last = await next(new Request(request.url, { method: "POST", headers: request.headers, body: fields.toString() }));
    if ((await oauthError(last)) !== "invalid_client") return last;
  }
  return last;
}

/** One finding of the strict agent, as `GET /violations` serves it (the mock's shape). */
export type Recorded = { readonly id: string; readonly basis: Basis | null; readonly level: Level; readonly detail: string };

/** The strict agent refused what a Company did. `document` when the validator found it in a discovery document. */
export class StrictRefusal extends Error {
  readonly document: boolean;
  constructor(findings: readonly Check[]) {
    super(findings.map((check) => `${check.id}: ${check.detail}`).join("; "));
    this.name = "StrictRefusal";
    this.document = findings.every((check) => check.source === "validator");
  }
}

const headerMap = (headers: Headers) => new Map([...headers].map(([name, value]) => [name.toLowerCase(), value] as const));

/**
 * What the strict agent saw, as the exchanges the runner's checks read, and the Company-side
 * findings so far. The checks are the runner's own (checks.ts, documents.ts), so the agent and
 * the runner can't disagree on what a departure is; the agent differs only in refusing.
 */
export class StrictObserver {
  readonly #exchanges: Exchange[] = [];
  readonly #seen = new Set<string>();
  readonly recorded: Recorded[] = [];
  /** Set by a finding, read and cleared by the step that was running. */
  refusal: StrictRefusal | null = null;
  #version = "0.1";

  /** Record one exchange; returns the findings it newly shows. A response body that streams isn't read. */
  async observe(request: { method: string; url: string; headers: Headers; body: string }, response: Response, started: number): Promise<Check[]> {
    const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    if (streamed) return [];
    const url = new URL(request.url);
    const responseBody = await response.clone().text();
    if (request.method === "GET" && url.pathname === "/.well-known/poppy.json") {
      try {
        const declared: unknown = JSON.parse(responseBody);
        if (isObject(declared) && typeof declared.protocol_version === "string") this.#version = declared.protocol_version;
      } catch {
        // The validator says why.
      }
    }
    this.#exchanges.push({
      index: this.#exchanges.length,
      method: request.method,
      url,
      ...direction(url.hostname),
      probe: false,
      injected: false,
      fault: null,
      started,
      ended: Date.now(),
      requestHeaders: headerMap(request.headers),
      requestBody: request.body,
      status: response.status,
      responseHeaders: headerMap(response.headers),
      responseBody
    });
    const checks = traceChecks(this.#exchanges, [], this.#version).filter((check) => check.side === "company");
    if (request.method === "GET") checks.push(...(await documentChecks(this.#exchanges, this.#version)).filter((check) => check.side === "company"));
    const fresh = checks.filter((check) => {
      const key = `${check.id}|${check.detail}`;
      if (this.#seen.has(key)) return false;
      this.#seen.add(key);
      return true;
    });
    for (const check of fresh) {
      const level = check.basis ? levelOf(check.basis) : "failure";
      this.recorded.push({ id: check.id, basis: check.basis ?? null, level: level === "none" ? "warning" : level, detail: check.detail });
    }
    if (fresh.length) this.refusal ??= new StrictRefusal(fresh);
    return fresh;
  }
}

/** Re-sign with `jose`'s view of the header and claims; the adapter supplies the key. */
export function changedClaims(jwt: string, change: Parameters<Resign>[1], now = Math.floor(Date.now() / 1000)): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const header: Record<string, unknown> = { ...decodeProtectedHeader(jwt) };
  const payload: Record<string, unknown> = { ...decodeJwt(jwt) };
  if (change.dropTyp) delete header.typ;
  if (change.aud !== undefined) payload.aud = change.aud;
  if (change.fresh) {
    payload.iat = now;
    payload.exp = now + (Number(payload.exp) - Number(payload.iat) || 60);
    payload.jti = crypto.randomUUID();
  }
  if (change.lifetime !== undefined) payload.exp = Number(payload.iat) + change.lifetime;
  return { header, payload };
}
