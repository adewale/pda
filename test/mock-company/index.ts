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
export { VIOLATION_IDS, VIOLATIONS, violationId, type ViolationId } from "./violations";
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
    web.operations = operations;
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
    const bodyText =
      request.method === "GET" || request.method === "HEAD"
        ? ""
        : new TextDecoder().decode(await request.arrayBuffer());
    const inbound: Inbound = { request, url, bodyText };
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
    logged.status = response.status;
    logged.error = await errorOf(response);
    return response;
  }

  async #route(parts: Parts, inbound: Inbound): Promise<Response> {
    const { company, auth, conversations, operations, apis, web } = parts;
    const { url } = inbound;
    const host = url.hostname;
    const path = url.pathname;
    const method = inbound.request.method;
    const sub = host.split(".")[0];
    const site = sub !== "auth" && sub !== "api" && sub !== "mcp" && sub !== "cdn";

    // Where secrets may legitimately appear.
    let allowed: "credentials" | "code" | "account-token" | null = null;
    if (sub === "auth" && (path === "/oauth/token" || path === "/oauth/revoke")) allowed = "account-token";
    if (sub === "auth" && path === "/poppy/sign-in") allowed = "credentials";
    if (sub === "auth" && path.startsWith("/poppy/sign-in/")) allowed = "code";
    company.scanSecrets(inbound, allowed);

    if (site || sub === "cdn") {
      if (path === "/.well-known/poppy.json" || (sub === "cdn" && path === "/poppy.json")) {
        return web.wellKnown(inbound);
      }
      if (path === "/poppy/browser-session") return web.browserSession(inbound);
      if (method === "GET") {
      company.rateLimit("page", inbound);
      return web.page(inbound);
    }
      return json({ error: "not_found" }, 404);
    }

    if (sub === "auth") {
      if (path === "/.well-known/oauth-authorization-server") return web.authorizationServerMetadata();
      if (path === "/oauth/token" && method === "POST") return auth.token(inbound);
      if (path === "/oauth/revoke" && method === "POST") return auth.revoke(inbound);
      if (path === "/oauth/authorize" && method === "GET") return auth.authorize(inbound);
      if (path === "/oauth/device" && method === "POST") return auth.device(inbound);
      if (path === "/device" && method === "GET") return auth.devicePage(inbound);
      if (path === "/poppy/sign-in" && method === "POST") return auth.mediated(inbound);
      const code = /^\/poppy\/sign-in\/([A-Za-z0-9_-]+)$/.exec(path);
      if (code && method === "POST") return auth.mediatedCode(inbound, code[1]!);
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

    // The API host: OpenAPI, conversations, operations.
    if (path === "/openapi.json" && method === "GET") {
      return json(apis.openapiDocument(), 200, { "Cache-Control": "max-age=300" });
    }
    company.rateLimit("other", inbound);
    const context = await company.authorizeResource(inbound);
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
    const operation = /^\/poppy\/operations\/([A-Za-z0-9_-]+)(?:\/(confirm|cancel))?$/.exec(path);
    if (operation) {
      const [, id, action] = operation;
      if (!company.config.operations || !context.client.listsOperations) {
        return json({ error: "operation_not_found" }, 404);
      }
      if (!action && method === "GET") return operations.read(context, id!);
      if (action === "confirm" && method === "POST") return operations.confirm(inbound, context, id!);
      if (action === "cancel" && method === "POST") return operations.cancel(context, id!);
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
      violations: [...company.violations],
      requests: company.requests.map((request) => ({ ...request, headers: { ...request.headers } })),
      revocationHints: [...company.revocationHints],
      userIds: [...company.userIds],
      clientIds: [...company.clients.keys()],
      sessions: [...company.sessions.values()].map((session) => ({
        id: session.id,
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
      browserJoins: company.browserJoins
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

  /** The Account Tokens the Company has issued, valid or not (to check they're stored sealed). */
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

  /** The Company Agent says something, optionally with `data` or `operation`. */
  async say(conversationId: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    this.#named().conversations.say(conversationId, text, extra);
  }

  /** Forget all but the last event, so older cursors get `cursor_expired`. */
  async expireEvents(conversationId: string): Promise<void> {
    this.#named().conversations.expireEvents(conversationId);
  }

  /** The Company issues a new revision of an operation; returns the new revision. */
  async reviseOperation(
    operationId: string,
    newSummary: string,
    newTerms: Record<string, unknown>
  ): Promise<number> {
    return this.#named().operations.revise(operationId, newSummary, newTerms);
  }

  /** The User confirms an operation on the Company's website, in its Session (Ops 4.4). */
  async confirmOnWebsite(operationId: string): Promise<void> {
    this.#named().operations.confirmOnWebsite(operationId);
  }

  /** The Company ends every Session, as when they expire (4.2). */
  async endAllSessions(): Promise<number> {
    const { company } = this.#named();
    for (const session of company.sessions.values()) session.ended = true;
    return company.sessions.size;
  }

  /** The User disconnects the Personal Agent in their account settings (4.9). */
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
