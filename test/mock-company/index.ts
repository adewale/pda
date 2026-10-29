import { DurableObject } from "cloudflare:workers";
import { Apis } from "./apis";
import { AuthServer } from "./auth";
import { Conversations } from "./conversations";
import { Company, HttpError, json, type Inbound } from "./core";
import { Operations } from "./operations";
import {
  DEFAULT_CONFIG,
  companyIdFromHost,
  hostsFor,
  type MockConfig,
  type MockState
} from "./types";
import { Web } from "./web";

export { companyIdFromHost, hostsFor, DEFAULT_CONFIG };
export { CLOCK_HEADER } from "./core";
export { basisOf, isViolation, levelOfCheck, VIOLATION_IDS, VIOLATIONS, violationId, type Basis, type Level, type ViolationId } from "./violations";
export type { MockAccount, MockConfig, MockRequest, MockState, Hosts } from "./types";

type Parts = {
  readonly company: Company;
  readonly auth: AuthServer;
  readonly conversations: Conversations;
  readonly operations: Operations;
  readonly apis: Apis;
  readonly web: Web;
};

/** The error a response carries, from `WWW-Authenticate` or a JSON body, for the request log. */
async function errorOf(response: Response): Promise<string | null> {
  const challenge = /error="([^"]+)"/.exec(response.headers.get("WWW-Authenticate") ?? "");
  if (challenge) return challenge[1]!;
  if (response.status < 400 || !(response.headers.get("Content-Type") ?? "").includes("json")) return null;
  const body = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : null;
}

/** `response` with `description` as its error's words, when it is a JSON error (`errorDescription`); any other answer as it is. */
async function describedAs(response: Response, description: string): Promise<Response> {
  if (!(response.headers.get("Content-Type") ?? "").includes("application/json")) return response;
  const body = (await response.clone().json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return response;
  const error = body.error;
  let described: Record<string, unknown>;
  if (typeof error === "string" && response.status >= 400) described = { ...body, error_description: description };
  else if (typeof error === "object" && error !== null && !Array.isArray(error)) described = { ...body, error: { ...error, message: description } };
  else return response;
  return new Response(JSON.stringify(described), { status: response.status, headers: response.headers });
}

function bodyKeys(inbound: Inbound): string[] {
  if (!inbound.bodyText) return [];
  const type = inbound.request.headers.get("Content-Type") ?? "";
  if (type.startsWith("application/x-www-form-urlencoded")) {
    return [...new URLSearchParams(inbound.bodyText).keys()];
  }
  try {
    const body = JSON.parse(inbound.bodyText) as unknown;
    return typeof body === "object" && body !== null ? Object.keys(body) : [];
  } catch {
    return [];
  }
}

/**
 * A strict Personal Agent Protocol Company for conformance tests. One
 * instance per company id serves every host of that Company, and records
 * each protocol violation it sees from the Personal Agent.
 */
export class MockCompany extends DurableObject<Env> {
  #parts: Parts | undefined;
  readonly #instanceId = crypto.randomUUID();

  /** Evidence belongs to this instance; a replacement must never look like a clean run. */
  instanceId(): string {
    return this.#instanceId;
  }

  async evidence() {
    return { instanceId: this.#instanceId, state: await this.state() };
  }

  #ensure(id: string): Parts {
    if (this.#parts) {
      if (this.#parts.company.id !== id) {
        throw new Error(`MockCompany ${this.#parts.company.id} got a request for ${id}`);
      }
      return this.#parts;
    }
    const company = new Company(id, this.env);
    const auth = new AuthServer(company);
    const conversations = new Conversations(company);
    const operations = new Operations(company);
    conversations.operations = operations;
    const apis = new Apis(company, operations);
    const web = new Web(company);
    this.#parts = { company, auth, conversations, operations, apis, web };
    return this.#parts;
  }

  /** The instance's company id, from its name when a test calls RPC first. */
  #named(): Parts {
    if (this.#parts) return this.#parts;
    const name = this.ctx.id.name;
    if (!name) throw new Error("MockCompany must be addressed by name (getByName(companyId))");
    return this.#ensure(name);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = companyIdFromHost(url.host);
    if (!id) return new Response(`Not a mock Company host: ${url.host}`, { status: 404 });
    const parts = this.#ensure(id);
    const bodyBytes =
      request.method === "GET" || request.method === "HEAD" ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    const bodyText = new TextDecoder().decode(bodyBytes);
    const inbound: Inbound = { request, url, bodyText, bodyBytes };
    const logged = parts.company.log(inbound, bodyKeys(inbound));
    let response: Response;
    try {
      response = await this.#route(parts, inbound);
    } catch (error) {
      if (error instanceof HttpError) {
        response = error.response;
      } else {
        console.error("mock company error", error);
        response = json({ error: "server_error", error_description: String(error) }, 500);
      }
    }
    const description = parts.company.config.errorDescription;
    if (description !== null) response = await describedAs(response, description);
    logged.status = response.status;
    logged.error = await errorOf(response);
    return response;
  }

  async #route(parts: Parts, inbound: Inbound): Promise<Response> {
    const { company, auth, conversations, apis, web } = parts;
    const { url } = inbound;
    const host = url.hostname;
    const path = url.pathname;
    const method = inbound.request.method;
    const sub = host.split(".")[0];
    const site = sub !== "auth" && sub !== "api" && sub !== "mcp" && sub !== "cdn";

    // Where secrets may legitimately appear.
    let allowed: "account-token" | "token-endpoint" | null = null;
    if (sub === "auth" && path === "/oauth/revoke") allowed = "account-token";
    // Mediated Sign-In is a grant at the token endpoint, so its credentials and codes go there too (Mediated Sign-In 3, 4).
    if (sub === "auth" && path === "/oauth/token") allowed = "token-endpoint";
    company.scanSecrets(inbound, allowed);

    if (site || sub === "cdn") {
      if (path === "/.well-known/poppy.json" || (sub === "cdn" && path === "/poppy.json")) {
        return web.wellKnown(inbound);
      }
      if (path === "/poppy/browser-session") return web.browserSession(inbound);
      if (path === "/poppy/browser-session/authorize" && method === "POST") return web.authorizeBrowserJoin(inbound);
      if (path === "/.well-known/oauth-protected-resource" && method === "GET") return web.domainResourceMetadata(inbound);
      if (path === "/poppy/excluded-tasks.json" && method === "GET") return web.excludedTasks();
      if (path === "/account/address" && method === "POST") {
        company.rateLimit("page", inbound);
        return web.saveAddress(inbound);
      }
      if (method === "GET") {
      company.rateLimit("page", inbound);
      return web.page(inbound);
    }
      return json({ error: "not_found" }, 404);
    }

    if (sub === "auth") {
      // Only where RFC 8414 puts it: the appended form of an issuer with a path is 404 (S3).
      if (path === company.hosts.metadataPath) return web.authorizationServerMetadata();
      if (path === "/oauth/token" && method === "POST") return auth.token(inbound);
      if (path === "/oauth/revoke" && method === "POST") return auth.revoke(inbound);
      if (path === "/oauth/authorize" && method === "GET") return auth.authorize(inbound);
      if (path === "/oauth/device" && method === "POST") return auth.device(inbound);
      if (path === "/device" && method === "GET") return auth.devicePage(inbound);
      return json({ error: "not_found" }, 404);
    }

    if (sub === "mcp") {
      if (path === "/.well-known/oauth-protected-resource/mcp" || path === "/.well-known/oauth-protected-resource") {
        return json(apis.protectedResourceMetadata());
      }
      if (path === "/mcp") {
        company.rateLimit("other", inbound);
        return apis.mcp(inbound);
      }
      return json({ error: "not_found" }, 404);
    }

    // The API host: OpenAPI and conversations.
    if (path === "/openapi.json" && method === "GET") {
      return json(apis.openapiDocument(), 200, { "Cache-Control": "max-age=300" });
    }
    // The API takes only its own tokens when its protected resource metadata names it (4.5).
    if (path.startsWith("/.well-known/oauth-protected-resource") && method === "GET") {
      return company.config.apiResource && path === "/.well-known/oauth-protected-resource"
        ? json({ resource: company.hosts.api, authorization_servers: [company.hosts.issuer] })
        : json({ error: "not_found" }, 404);
    }
    company.rateLimit("other", inbound);
    const context = await company.authorizeResource(inbound);
    if (path === "/poppy/feedback" && method === "POST") return web.feedbackReport(inbound, context);
    const conversation = /^\/poppy\/conversations(?:\/([A-Za-z0-9_-]+)(?:\/(messages|events|handoff|close))?)?$/.exec(path);
    if (conversation) {
      const [, id, action] = conversation;
      if (!id && method === "POST") return conversations.start(inbound, context);
      if (id && action === "messages" && method === "POST") return conversations.message(inbound, context, id);
      if (id && action === "events" && method === "GET") return conversations.events(inbound, context, id);
      if (id && action === "handoff" && method === "POST") return conversations.handoff(inbound, context, id);
      if (id && action === "close" && method === "POST") return conversations.close(inbound, context, id);
      return json({ error: "not_found" }, 404);
    }
    return apis.rest(inbound, context);
  }

  // ---- RPC for tests ----

  /** Merge settings into the Company's configuration. */
  async configure(config: Partial<MockConfig>): Promise<void> {
    const company = this.#named().company;
    company.config = {
      ...company.config,
      ...config,
      signIn: { ...company.config.signIn, ...(config.signIn ?? {}) },
      rateLimit: { ...company.config.rateLimit, ...(config.rateLimit ?? {}) }
    };
  }

  async state(): Promise<MockState> {
    const { company, conversations, operations } = this.#named();
    return {
      recorded: [...company.recorded],
      violations: company.violations,
      warnings: company.warnings,
      requests: company.requests.map((request) => ({ ...request, headers: { ...request.headers } })),
      revocationHints: [...company.revocationHints],
      userIds: [...company.userIds],
      clientIds: [...company.clients.keys()],
      sessions: [...company.sessions.values()].map((session) => ({
        id: session.id,
        sid: session.sid,
        userId: session.userId,
        account: session.account,
        signedIn: session.account !== null,
        ended: session.ended
      })),
      accountTokens: [...company.accountTokens.values()].filter(
        (token) =>
          !token.revoked && !token.rotated && (token.expiresAt === null || token.expiresAt > Date.now())
      ).length,
      performs: company.performs,
      conversations: conversations.summary(),
      operations: operations.summary(),
      browserJoins: company.browserJoins,
      feedback: company.feedback.map((entry) => ({ ...entry })),
      formPosts: company.formPosts.map((post) => ({ account: post.account, fields: post.fields.map(([name, value]) => [name, value]) }))
    };
  }

  /**
   * Serve a document at `url` in place of a client's own (client metadata or
   * JWKS), so a test can hand the mock a broken one, or a second client.
   */
  async serveClientDocument(url: string, body: unknown, status = 200): Promise<void> {
    this.#named().company.served.set(url, {
      status,
      body: typeof body === "string" ? body : JSON.stringify(body)
    });
  }

  /** The refresh tokens the Company has issued, valid or not (to check they're stored sealed). */
  async accountTokenValues(): Promise<string[]> {
    return [...this.#named().company.accountTokens.keys()];
  }

  /** The User approves or declines on the Direct Sign-In consent page; returns the redirect. */
  async approveAuthorization(
    authorizeUrl: string,
    decision: { account?: string; scopes?: string[]; approve: boolean }
  ): Promise<string> {
    const host = new URL(authorizeUrl).host;
    const id = companyIdFromHost(host);
    const parts = id ? this.#ensure(id) : this.#named();
    return parts.auth.decide(authorizeUrl, decision);
  }

  async approveDevice(userCode: string, decision: { account?: string; scopes?: string[] } = {}): Promise<void> {
    this.#named().auth.approveDevice(userCode, decision);
  }

  async denyDevice(userCode: string): Promise<void> {
    this.#named().auth.denyDevice(userCode);
  }

  async lastOneTimeCode(): Promise<string | null> {
    return this.#named().company.lastOneTimeCode;
  }

  /** Add an event to a conversation, such as `user_requested`. Returns its id. */
  async pushEvent(conversationId: string, event: Record<string, unknown>): Promise<string> {
    return this.#named().conversations.pushEvent(conversationId, event);
  }

  /** A person at the Company joins and says something. */
  async humanJoin(conversationId: string, text: string): Promise<void> {
    this.#named().conversations.humanJoin(conversationId, text);
  }

  /** No person is available for a queued handoff; the Company Agent says why (8.9). */
  async staffUnavailable(conversationId: string, text: string): Promise<void> {
    this.#named().conversations.staffUnavailable(conversationId, text);
  }

  /** The Company Agent says something, optionally with `data` or `operation`. */
  async say(conversationId: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    this.#named().conversations.say(conversationId, text, extra);
  }

  /** Forget all but the last event, so older cursors get `cursor_expired`. */
  async expireEvents(conversationId: string): Promise<void> {
    this.#named().conversations.expireEvents(conversationId);
  }

  /** The Company closes a conversation on its side. */
  async closeConversation(conversationId: string): Promise<void> {
    this.#named().conversations.closeByCompany(conversationId);
  }

  /** The Company forgets a conversation, so every request for it is `conversation_not_found`. */
  async forgetConversation(conversationId: string): Promise<void> {
    this.#named().conversations.forget(conversationId);
  }

  /** The Company ends every Session, as when they expire (5.5). */
  async endAllSessions(): Promise<number> {
    const { company } = this.#named();
    for (const session of company.sessions.values()) session.ended = true;
    return company.sessions.size;
  }

  /** The next `count` token or other requests get 429 with `Retry-After` (the interop `rate_limit` hook). */
  async limitNext(kind: "token" | "other", count: number, retryAfterSeconds: number): Promise<void> {
    const { company } = this.#named();
    const used = kind === "token" ? company.tokenRequestCount : company.otherRequestCount;
    company.config = {
      ...company.config,
      rateLimit: {
        ...company.config.rateLimit,
        retryAfterSeconds,
        ...(kind === "token" ? { tokenRequests429: used + count } : { requests429: used + count })
      }
    };
  }

  /** Every access token issued so far expires now, so the next use gets `invalid_token` (the interop `expire_tokens` hook). */
  async expireAccessTokens(): Promise<number> {
    const { company } = this.#named();
    for (const [value, token] of company.accessTokens) {
      company.accessTokens.set(value, { ...token, expiresAt: Date.now() - 1 });
    }
    return company.accessTokens.size;
  }

  /** The User disconnects the Personal Agent in their account settings (4.6, 5.5). */
  async revokeAllForAccount(account: string): Promise<number> {
    const { company, auth } = this.#named();
    let count = 0;
    for (const token of company.accountTokens.values()) {
      if (token.account === account && !token.revoked) {
        auth.revokeToken(token.value);
        count += 1;
      }
    }
    return count;
  }
}
