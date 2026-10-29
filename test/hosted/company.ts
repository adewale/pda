/** Isolated hosted smoke Company. Strict protocol handlers, dummy data, real User consent. Never a production Company. */
import { DurableObject } from "cloudflare:workers";
import { Apis } from "../mock-company/apis";
import { AuthServer } from "../mock-company/auth";
import { Company, HttpError, json, randomId, type Inbound } from "../mock-company/core";
import { Operations } from "../mock-company/operations";
import { DEFAULT_CONFIG, type Hosts } from "../mock-company/types";
import { Web } from "../mock-company/web";

export type HostedEnv = {
  COMPANY_ORIGIN: string;
  PDA_ORIGIN: string;
  COMPANY_PASSWORD: string;
  COMPANY_CONTROL_SECRET: string;
  HOSTED_COMPANY: DurableObjectNamespace<HostedCompany>;
};

function origin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing origin");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new Error("Expected HTTPS origin");
  return value;
}

function configured(env: HostedEnv): void {
  if (origin(env.COMPANY_ORIGIN) === origin(env.PDA_ORIGIN)) throw new Error("Origins must differ");
  for (const value of [env.COMPANY_PASSWORD, env.COMPANY_CONTROL_SECRET]) if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new Error("Missing Company secret");
  if (env.COMPANY_PASSWORD === env.COMPANY_CONTROL_SECRET) throw new Error("Company secrets must differ");
}

export function hostedHosts(base: string): Hosts {
  const host = new URL(origin(base)).hostname;
  return {
    id: "hosted", domain: host, altDomain: host,
    issuer: `${base}/issuer`, metadataPath: "/.well-known/oauth-authorization-server/issuer",
    api: base, mcpUrl: `${base}/mcp`, web: base,
    tokenEndpoint: `${base}/oauth/token`, revocationEndpoint: `${base}/oauth/revoke`,
    authorizationEndpoint: `${base}/oauth/authorize`, deviceEndpoint: `${base}/oauth/device`,
    conversationsEndpoint: `${base}/poppy/conversations`, browserSessionEndpoint: `${base}/poppy/browser-session`
  };
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const hash = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([hash(left), hash(right)]);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
  return different === 0;
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function page(body: string, status = 200, callbackOrigin?: string): Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dummy Company · isolated test</title><main><h1>Dummy Company</h1><p>Isolated test. Orders, accounts and charges are dummy data. Use only the generated test password.</p>${body}</main></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": `default-src 'none'; form-action 'self'${callbackOrigin ? ` ${origin(callbackOrigin)}` : ""}; frame-ancestors 'none'; base-uri 'none'`, "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" }
  });
}

async function body(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > 65_536) { await reader.cancel(); throw new HttpError(json({ error: "request_too_large" }, 413)); }
    chunks.push(next.value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export class HostedCompany extends DurableObject<HostedEnv> {
  readonly #instanceId = crypto.randomUUID();
  readonly #startedAt = Date.now();
  readonly #company: Company;
  readonly #auth: AuthServer;
  readonly #apis: Apis;
  readonly #web: Web;
  readonly #consents = new Map<string, { url: string; expires: number }>();

  constructor(ctx: DurableObjectState, env: HostedEnv) {
    super(ctx, env);
    configured(env);
    // This sentinel prevents the test helper's in-process PDA shortcut; real client metadata uses HTTPS.
    const company = this.#company = new Company("hosted", { PUBLIC_ORIGIN: "https://no-direct-worker.invalid" } as unknown as Env);
    company.config = {
      ...DEFAULT_CONFIG, protocolVersion: "0.3", strictAssertions: true, organizationName: "Dummy Company (isolated test)",
      unknownApi: false, unknownProtocol: false, unknownExtension: false, unknownField: false,
      requireNonce: true, rotateRefreshTokens: true, excludedTasks: false,
      requireRegistration: [`${env.PDA_ORIGIN}/poppy/client.json`],
      protectedResourcesOverride: [env.COMPANY_ORIGIN, `${env.COMPANY_ORIGIN}/mcp`],
      agent: false, web: false, browserSession: false,
      signIn: { direct: ["orders:read", "orders:write", "addresses"], device: null, mediated: null },
      accounts: [{ account: "acct_ada", email: "ada@example.com", password: env.COMPANY_PASSWORD, otp: false }]
    };
    // A test-only placement, on one public HTTPS origin. No URL/header rewriting weakens strict checks.
    company.hosts = hostedHosts(env.COMPANY_ORIGIN);
    this.#auth = new AuthServer(company);
    this.#web = new Web(company);
    this.#apis = new Apis(company, new Operations(company));
  }

  override async fetch(request: Request): Promise<Response> {
    try { return await this.#fetch(request); }
    catch (error) { return error instanceof HttpError ? error.response : json({ error: "server_error" }, 500); }
  }

  async #fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== this.env.COMPANY_ORIGIN || url.href.length > 16_384 || request.headers.has("x-test-clock")) return json({ error: "invalid_request" }, 400);
    const path = url.pathname;
    if (path === "/__evidence") {
      if (request.method !== "GET" || !(await equalSecret(request.headers.get("Authorization") ?? "", `Bearer ${this.env.COMPANY_CONTROL_SECRET}`))) return json({ error: "not_found" }, 404);
      return json({ instanceId: this.#instanceId, startedAt: this.#startedAt, performs: this.#company.performs, requests: this.#company.requests.length, violations: this.#company.violations.length, warnings: this.#company.warnings.length }, 200, { "Cache-Control": "no-store" });
    }
    // No administrative or adversarial HTTP routes exist. Only protocol calls and the User's consent form.
    if (path === "/oauth/decision") return this.#decide(request);
    if (path === "/" && request.method === "GET") return page("<p>This Company offers Direct Sign-In, OpenAPI and MCP with Operations 2. Start from the isolated PDA.</p>");
    const bodyBytes = await body(request);
    const inbound: Inbound = { request, url, bodyBytes, bodyText: new TextDecoder().decode(bodyBytes) };
    let keys: string[] = [];
    if (inbound.bodyText) {
      if ((request.headers.get("Content-Type") ?? "").startsWith("application/x-www-form-urlencoded")) keys = [...new URLSearchParams(inbound.bodyText).keys()];
      else { try { keys = Object.keys(JSON.parse(inbound.bodyText)); } catch { /* Strict handler diagnoses malformed JSON. */ } }
    }
    const log = this.#company.log(inbound, keys);
    const response = await this.#route(inbound);
    log.status = response.status;
    return response;
  }

  async #route(inbound: Inbound): Promise<Response> {
    const { url, request } = inbound;
    const path = url.pathname;
    const method = request.method;
    const company = this.#company;
    if (path === "/.well-known/poppy.json" && method === "GET") return this.#web.wellKnown(inbound);
    if (path === "/.well-known/oauth-protected-resource" && method === "GET") return this.#web.domainResourceMetadata(inbound);
    if (path === "/.well-known/oauth-protected-resource/mcp" && method === "GET") return json(this.#apis.protectedResourceMetadata());
    if (path === company.hosts.metadataPath && method === "GET") return this.#web.authorizationServerMetadata();
    if (path === "/poppy/excluded-tasks.json" && method === "GET") return this.#web.excludedTasks();
    if (path === "/openapi.json" && method === "GET") return json(this.#apis.openapiDocument());
    if (path === "/oauth/authorize" && method === "GET") {
      if (url.searchParams.get("client_id") !== `${this.env.PDA_ORIGIN}/poppy/client.json`) return page("<p>This Personal Agent is not accepted.</p>", 403);
      const checked = await this.#auth.authorize(inbound);
      if (checked.status !== 200) return checked;
      await checked.body?.cancel();
      for (const [key, consent] of this.#consents) if (consent.expires < Date.now()) this.#consents.delete(key);
      if (this.#consents.size >= 32) return page("<p>Too many pending sign-ins. Try again later.</p>", 429);
      const nonce = randomId("consent_", 24);
      this.#consents.set(nonce, { url: url.href, expires: Date.now() + 5 * 60_000 });
      const scopes = (url.searchParams.get("scope") ?? "").split(" ").map(scope => `<li>${escape(scope)}</li>`).join("");
      return page(`<p>${escape(new URL(this.env.PDA_ORIGIN).host)} asks for this dummy account's access:</p><ul>${scopes}</ul><form method="post" action="/oauth/decision"><input type="hidden" name="csrf" value="${nonce}"><label>Dummy Company test password <input name="password" type="password" autocomplete="off" required></label><button name="decision" value="approve">Approve dummy account access</button><button name="decision" value="deny">Decline</button></form>`, 200, this.env.PDA_ORIGIN);
    }
    company.scanSecrets(inbound, path === "/oauth/token" ? "token-endpoint" : path === "/oauth/revoke" ? "account-token" : null);
    if (path === "/oauth/token" && method === "POST") return this.#auth.token(inbound);
    if (path === "/oauth/revoke" && method === "POST") return this.#auth.revoke(inbound);
    if (path === "/mcp") return this.#apis.mcp(inbound);
    if (/^\/(products|orders|addresses)(\/|$)/.test(path)) {
      company.rateLimit("other", inbound);
      return this.#apis.rest(inbound, await company.authorizeResource(inbound));
    }
    return json({ error: "not_found" }, 404);
  }

  async #decide(request: Request): Promise<Response> {
    if (request.method !== "POST" || request.headers.get("Origin") !== this.env.COMPANY_ORIGIN || !(request.headers.get("Content-Type") ?? "").startsWith("application/x-www-form-urlencoded")) return page("<p>Invalid consent request.</p>", 403);
    const form = new URLSearchParams(new TextDecoder().decode(await body(request)));
    const nonce = form.get("csrf") ?? "";
    const consent = this.#consents.get(nonce);
    const password = form.get("password") ?? "";
    if (!consent || consent.expires < Date.now() || password.length > 128 || !["approve", "deny"].includes(form.get("decision") ?? "") || !(await equalSecret(password, this.env.COMPANY_PASSWORD))) return page("<p>Consent could not be verified. Start a new sign-in from the PDA.</p>", 403);
    // Consume before the first asynchronous call; simultaneous submissions cannot issue two codes.
    if (!this.#consents.delete(nonce)) return page("<p>This decision was already used.</p>", 409);
    const target = await this.#auth.decide(consent.url, { approve: form.get("decision") === "approve", account: "acct_ada" });
    return new Response(null, { status: 303, headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
}

export default {
  async fetch(request: Request, env: HostedEnv): Promise<Response> {
    try { configured(env); } catch { return json({ error: "not_configured" }, 503); }
    if (new URL(request.url).origin !== env.COMPANY_ORIGIN) return json({ error: "not_found" }, 404);
    return env.HOSTED_COMPANY.getByName("isolated-dummy-company").fetch(request);
  }
} satisfies ExportedHandler<HostedEnv>;
