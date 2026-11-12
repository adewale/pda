import { Company, HttpError, json, MEDIATED_GRANT, randomId, resourceError, type Inbound, type ResourceContext, type Session } from "./core";
import { parseApprovalHeader, type Operations } from "./operations";
import type { ViolationId } from "./violations";

/** The tasks the mock chose not to offer (9.1); the web reference is filled in per Company. */
const EXCLUDED: readonly { readonly task: string; readonly alternative?: { readonly instructions: string } }[] = [
  { task: "Close an account", alternative: { instructions: "Accounts are closed by phone." } },
  { task: "Send a gift card" }
];

/** How long discovery documents may be cached unless a test says otherwise. */
const DEFAULT_CACHING: Readonly<Record<string, string>> = { "Cache-Control": "max-age=300" };

/** Discovery documents, the website, and the browser join (sections 3 and 6). */
/** The mock's one skill (9.4), in the Agent Skills format. */
const SKILL_MD = `---
name: exchange-an-item
description: Exchange an item on one of the User's orders for another size or model.
---

1. Find the order with \`GET /orders\` and the item to exchange.
2. Find the replacement with \`searchProducts\`.
3. Send \`POST /orders/{order_id}/exchanges\`. The Company returns the terms for the User to approve.
`;

export class Web {
  /** A report belongs to the verified Personal Agent and User, not every visitor to the Company. */
  readonly #reportedTasks = new Set<string>();
  /** Browser cookie value → Session id. */
  readonly #cookies = new Map<string, string>();
  /** What each Session cookie acts for, as authorized in step 2 (6: "MUST act for the account and scopes authorized"). */
  readonly #cookieGrants = new Map<string, { readonly account: string | null; readonly scope: readonly string[]; readonly grant: string | null }>();
  /** The browser join's codes (6, steps 1 to 3). */
  readonly #joins = new Map<string, { readonly cookie: string; readonly expiresAt: number; authorized: { readonly sessionId: string; readonly account: string | null; readonly scope: readonly string[]; readonly grant: string | null } | null; used: boolean }>();

  constructor(readonly company: Company, readonly operations: Operations) {}

  /** poppy.json's caching headers: the configured ones (`{}` for none), or the default. */
  #poppyJsonCaching(): Record<string, string> {
    return { ...(this.company.config.poppyJsonCacheHeaders ?? DEFAULT_CACHING) };
  }

  /** The scopes this Company describes (4.7). */
  #scopeDescriptions(): Record<string, string> {
    return this.company.scopeDescriptions();
  }

  /**
   * `poppy.json` for the domain the agent asked about (3, 3.1): no sign-in
   * types, which the issuer's `grant_types_supported` says (3.2); scopes
   * described in `auth.scopes` with `scope_hints`; Operations, Mediated
   * Sign-In and Browser Control as extensions, each a list of version entries.
   */
  poppyJson(requestedDomain: string, version = this.company.config.protocolVersion): Record<string, unknown> {
    const co = this.company;
    const config = co.config;
    // An entry per extension version (3.3).
    const entries = (entry: Record<string, unknown>) => [entry];
    const hosts = co.hosts;
    const { read, write } = co.orderScopes;
    const auth: Record<string, unknown> = {
      ...(config.listIssuer ? { issuer: hosts.issuer } : {}),
      ...(config.authDisabled ? { disabled: true } : {}),
      // 3.2: domains sharing an issuer may describe different scopes.
      scopes: Object.fromEntries(Object.entries(this.#scopeDescriptions()).filter(([scope]) => !config.hideScopesFromAuth.includes(scope) && (requestedDomain.toLowerCase() !== hosts.domain.toLowerCase() || !config.hideScopesOnMainDomain.includes(scope)))),
      scope_hints: {
        [read]: { changes: "none", personal_data: true },
        [write]: { changes: config.reversibleWrites ? "reversible" : "irreversible", personal_data: true },
        addresses: { changes: "reversible", personal_data: true }
      }
    };
    const document: Record<string, unknown> = {
      protocol_version: version,
      organization: {
        name: config.organizationName ?? `Mock Shop ${co.id}`,
        domain: config.organizationDomain ?? requestedDomain,
        ...(config.logo ? { logo_uri: `${hosts.web}/logo.${config.logo}` } : {})
      },
      // 3.2: without an issuer there is no sign-in, so nothing to describe.
      ...(config.issuerless ? {} : { auth })
    };
    if (config.agent) {
      const protocols: Record<string, unknown>[] = [];
      if (config.unknownProtocol) protocols.push({ type: "example.com/chat-v9", endpoint: `${hosts.api}/chat-v9` });
      protocols.push({ type: "poppy", endpoint: hosts.conversationsEndpoint });
      document.agent = { protocols };
    }
    // 6: a Company that sets web.disabled lists no browser_session_endpoint.
    if (config.web) {
      const web: Record<string, unknown> = config.webDisabled ? { disabled: true } : config.browserSession ? { browser_session_endpoint: hosts.browserSessionEndpoint } : {};
      if (config.webUnscoped && config.browserSession && !config.webDisabled) web.unscoped = true;
      document.web = web;
    }
    // Excluded tasks and feedback come from the tasks endpoint, per Session (9).
    if (config.excludedTasks || config.feedback || config.skills) document.tasks = { endpoint: `${hosts.api}/poppy/tasks` };
    const apis: Record<string, unknown>[] = [];
    if (config.unknownApi) apis.push({ type: "graphql", url: `${hosts.api}/graphql`, description: "Everything, as GraphQL" });
    const listsOpenapi = config.openapi && !(config.openapiOnAltDomainOnly && requestedDomain.toLowerCase() === hosts.domain.toLowerCase());
    if (listsOpenapi) apis.push({ type: "openapi", url: config.openapiUrlOverride ?? `${hosts.api}/openapi.json`, description: "Orders and exchanges" });
    if (config.mcp) apis.push({ type: "mcp", url: hosts.mcpUrl, description: "Product search and exchanges" });
    if (apis.length > 0) document.apis = apis;
    const extensions: Record<string, unknown> = {};
    // Ops 2: a website that returns operations lists `endpoint`, and only beside browser join.
    const operationsEndpoint = config.webOperations && config.browserSession && !config.webDisabled;
    if (config.operations) extensions.operations = entries({ version: "3", ...(operationsEndpoint ? { endpoint: `${hosts.web}/poppy/operations` } : {}) });
    // Browser Control 3: listed only beside browser join.
    if (config.browserControl && config.browserSession && !config.webDisabled) extensions["browser-control"] = entries({ version: "1" });
    const mediated = co.offeredScopes("mediated");
    if (mediated) {
      extensions["mediated-sign-in"] = entries({
        version: "1",
        fields: [
          { name: "email", label: "Email", secret: false },
          { name: "password", label: "Password", secret: true }
        ],
        scopes: mediated
      });
    }
    if (config.unknownExtension) extensions["mock.test/gift-wrap"] = entries({ version: "1", endpoint: `${hosts.api}/gift-wrap` });
    if (Object.keys(extensions).length > 0) document.extensions = extensions;
    if (config.unknownField) document.loyalty_program = { name: "Mock Points" };
    // Interop XB: pad the document past an agent's size cap. An unknown field,
    // so a correct agent ignores it (3); an agent with no cap would read it all.
    if (config.padBytes && config.padBytes > 0) document._padding = "x".repeat(config.padBytes);
    return document;
  }

  /** The domain's protected resource metadata (RFC 9728), which names the issuer (3.2). */
  domainResourceMetadata(inbound: Inbound): Response {
    const co = this.company;
    // 3.2: a 404 here means the Company has no issuer.
    if (co.config.issuerless) return json({ error: "not_found" }, 404);
    const host = inbound.url.hostname;
    return json(
      {
        resource: co.config.domainResourceOverride ?? `https://${host}`,
        authorization_servers: co.config.authorizationServersOverride ?? [co.hosts.issuer],
        ...(co.config.resourceScopes ? { scopes_supported: Object.keys(this.#scopeDescriptions()) } : {})
      },
      200,
      { ...(co.config.metadataCacheHeaders ?? DEFAULT_CACHING) }
    );
  }

  /** The tasks this Company chose not to offer (9.1), for every User alike. */
  excludedTasks(): Response {
    if (!this.company.config.excludedTasks) return json({ error: "not_found" }, 404);
    return json({ tasks: this.#excluded() }, 200, DEFAULT_CACHING);
  }

  #excluded() {
    return EXCLUDED.map((entry) => entry.task === "Close an account" ? { ...entry, alternative: { ...entry.alternative, references: [{ type: "web", url: `${this.company.hosts.web}/help/close` }] } } : entry);
  }

  /**
   * `GET {tasks.endpoint}` (9): excluded tasks and the feedback
   * endpoint, after the Session header is verified, and with no access
   * token. Marked `private`, as a response a Company may vary by Session.
   */
  async tasks(context: ResourceContext): Promise<Response> {
    const co = this.company;
    if (context.token) co.violation("tasks.token", "GET {tasks.endpoint} carried an access token");
    return json({
      ...(co.config.excludedTasks ? { excluded_tasks: this.#excluded() } : {}),
      ...(co.config.skills ? { skill_index: await this.#skillIndex() } : {}),
      ...(co.config.feedback ? { feedback: { endpoint: `${co.hosts.api}/poppy/feedback` } } : {})
    }, 200, { "Cache-Control": "private, max-age=300" });
  }

  /** The skill index (9.4): one `SKILL.md`, by a reference relative to `tasks.endpoint`, with its digest. */
  async #skillIndex(): Promise<Record<string, unknown>> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SKILL_MD)));
    return {
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [{
        name: "exchange-an-item",
        description: "Exchange an item on one of the User's orders for another size or model.",
        type: "skill-md",
        url: "skills/exchange-an-item/SKILL.md",
        digest: `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
      }]
    };
  }

  /**
   * A skill artifact (9.4). Listing it authorizes no credentials or Session
   * header, so one sent here is recorded.
   */
  skillArtifact(inbound: Inbound): Response {
    const co = this.company;
    if (!co.config.skills) return json({ error: "not_found" }, 404);
    const headers = inbound.request.headers;
    if (headers.has("Authorization") || headers.has("Poppy-Session") || headers.has("DPoP")) {
      co.violation("skills.credentials", `a skill artifact fetched with ${["Authorization", "Poppy-Session", "DPoP"].filter((name) => headers.has(name)).join(", ")}`);
    }
    return new Response(SKILL_MD, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  }

  /**
   * `POST {feedback.endpoint}` (9.3): a report with the Session header, signed
   * in or out, no scope needed. 202 and no body, or 200 and an alternative
   * when `feedbackAlternative`.
   */
  feedbackReport(inbound: Inbound, context: ResourceContext): Response {
    const co = this.company;
    if (!co.config.feedback) return json({ error: "not_found" }, 404);
    let body: unknown;
    try {
      body = JSON.parse(inbound.bodyText || "null");
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const report = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const { task, description } = report;
    if (typeof task !== "string" || typeof description !== "string" || task.length > 200 || description.length > 2_000) {
      co.violation("feedback.fields", "feedback report: task (at most 200 characters) and description (at most 2,000) are required strings");
      return json({ error: "invalid_request" }, 400);
    }
    if ("kind" in report) co.violation("feedback.kind", "feedback report: kind is 0.2's; 0.3 removed it (9.3)");
    const phrase = task.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
    if (co.config.excludedTasks && EXCLUDED.some((entry) => entry.task.toLowerCase() === phrase)) {
      co.violation("feedback.excluded-task", `feedback report about ${JSON.stringify(task)}, which the Company lists as excluded`);
    }
    const reportKey = JSON.stringify([context.session.clientId, context.session.userId, phrase]);
    if (this.#reportedTasks.has(reportKey)) {
      co.violation("feedback.repeated", `a second feedback report about ${JSON.stringify(task)}`);
    }
    this.#reportedTasks.add(reportKey);
    co.feedback.push({ task, signedIn: context.signedIn });
    if (co.config.feedbackAlternative) {
      return json({ instructions: "Gift cards are applied at checkout on the website.", references: [{ type: "web", url: `${co.hosts.web}/checkout` }] });
    }
    return new Response(null, { status: 202 });
  }

  /** `GET https://{domain}/.well-known/poppy.json`, maybe by redirect (3). */
  wellKnown(inbound: Inbound): Response {
    const co = this.company;
    const host = inbound.url.hostname.replace(/^www\./, "");
    if (host.startsWith("cdn.")) {
      const domain = inbound.url.searchParams.get("for") ?? co.hosts.domain;
      return json(this.#rootDocument(domain), 200, this.#poppyJsonCaching());
    }
    if (co.config.wellKnownRedirect === "https") {
      return Response.redirect(`https://cdn.${co.hosts.domain}/poppy.json?for=${host}`, 302);
    }
    if (co.config.wellKnownRedirect === "http") {
      return Response.redirect(`http://cdn.${co.hosts.domain}/poppy.json?for=${host}`, 302);
    }
    return json(this.#rootDocument(host), 200, this.#poppyJsonCaching());
  }

  /** poppy.json, with `supported_versions` linking the other version's document on the same host (3.4). */
  #rootDocument(host: string): Record<string, unknown> {
    const linked = this.company.config.linkedVersion;
    const document = this.poppyJson(host);
    return linked ? { ...document, supported_versions: { [linked]: `https://${host}${linkedPath(linked)}` } } : document;
  }

  /** The linked version's document (3.4): its own `protocol_version`, and no `supported_versions`. */
  linkedDocument(inbound: Inbound): Response {
    const linked = this.company.config.linkedVersion;
    if (!linked || inbound.url.pathname !== linkedPath(linked)) return json({ error: "not_found" }, 404);
    return json(this.poppyJson(inbound.url.hostname.replace(/^www\./, ""), linked), 200, this.#poppyJsonCaching());
  }

  /**
   * The issuer's metadata (RFC 8414, 3.2): `protected_resources` for both
   * domains and the MCP server, the sign-in types in
   * `grant_types_supported`, and the scopes every sign-in can request in
   * `scopes_supported`.
   */
  authorizationServerMetadata(): Response {
    const co = this.company;
    const hosts = co.hosts;
    const grants = ["refresh_token"];
    if (co.config.signIn.direct) grants.push("authorization_code");
    if (co.config.signIn.device) grants.push("urn:ietf:params:oauth:grant-type:device_code");
    if (co.config.signIn.mediated) grants.push(MEDIATED_GRANT);
    const metadata: Record<string, unknown> = {
      issuer: co.config.issuerOverride ?? hosts.issuer,
      token_endpoint: hosts.tokenEndpoint,
      revocation_endpoint: hosts.revocationEndpoint,
      grant_types_supported: grants,
      ...(co.config.omitScopesSupported ? {} : { scopes_supported: Object.keys(this.#scopeDescriptions()) }),
      protected_resources: co.config.protectedResourcesOverride ?? [`https://${hosts.domain}`, `https://${hosts.altDomain}`, hosts.mcpUrl],
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["ES256", "PS384"],
      ...(co.config.dpopTokens ? { dpop_signing_alg_values_supported: ["ES256"] } : {}),
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true
    };
    if (co.config.signIn.direct) metadata.authorization_endpoint = hosts.authorizationEndpoint;
    if (co.config.signIn.device) metadata.device_authorization_endpoint = hosts.deviceEndpoint;
    return json(metadata, 200, { ...(co.config.metadataCacheHeaders ?? DEFAULT_CACHING) });
  }

  /**
   * The browser join (6): GET gives a form with a one-time code and a
   * cookie that ties it to this browser; the agent authorizes the code at
   * `{endpoint}/authorize` with its Session header; the browser posts the
   * form, and gets the Session's cookie.
   */
  async browserSession(inbound: Inbound): Promise<Response> {
    const co = this.company;
    if (!co.config.browserSession) return new Response("Not found", { status: 404 });
    const method = inbound.request.method;
    const page = (id: ViolationId | null, message: string, status = 400) => {
      if (id) co.violation(id, `browser join: ${message}`);
      return new Response(`<!doctype html><title>Couldn't connect</title><p>${message}</p>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    };
    if (method === "GET") {
      const code = randomId("bc_", 18);
      const cookie = randomId("", 18);
      this.#joins.set(code, { cookie, expiresAt: co.now() + 60_000, authorized: null, used: false });
      return new Response(
        `<!doctype html><title>Connecting</title><form method="post" action="/poppy/browser-session"><input type="hidden" name="code" value="${code}"><button>Continue</button></form>`,
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "frame-ancestors 'none'",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Set-Cookie": `__Host-poppy_join=${cookie}; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Strict`
          }
        }
      );
    }
    if (method !== "POST") return page(null, "method not allowed", 405);
    const type = inbound.request.headers.get("Content-Type") ?? "";
    if (!type.startsWith("application/x-www-form-urlencoded")) return page("browser-join.form", `the form was sent as ${JSON.stringify(type)}`);
    const fields = new URLSearchParams(inbound.bodyText);
    const code = fields.get("code") ?? "";
    if ([...fields.keys()].some((name) => name !== "code")) co.violation("browser-join.form", "the form carried fields other than code");
    const join = this.#joins.get(code);
    const cookie = /(?:^|;\s*)__Host-poppy_join=([^;]+)/.exec(inbound.request.headers.get("Cookie") ?? "")?.[1];
    if (!join) return page(null, "unknown code");
    if (join.used) return page("browser-join.code-reused", "the code was submitted before");
    join.used = true;
    if (!cookie || cookie !== join.cookie) return page("browser-join.cookie", "the form came without the cookie set with its code");
    if (join.expiresAt <= co.now()) return page(null, "the code expired");
    if (!join.authorized) return page("browser-join.not-authorized", "the code was submitted before the agent authorized it");
    const session = co.sessions.get(join.authorized.sessionId);
    if (!session || session.ended) return page(null, "the Session has ended");
    const value = randomId("", 18);
    this.#cookies.set(value, session.id);
    this.#cookieGrants.set(value, { account: join.authorized.account, scope: join.authorized.scope, grant: join.authorized.grant });
    co.browserJoins += 1;
    const headers = new Headers({ Location: `${co.hosts.web}/`, "Cache-Control": "no-store" });
    headers.append("Set-Cookie", `mock_sid=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    headers.append("Set-Cookie", "__Host-poppy_join=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict");
    return new Response(null, { status: 303, headers });
  }

  /** `POST {browser_session_endpoint}/authorize`, the agent's own request with the code (6, step 2). */
  async authorizeBrowserJoin(inbound: Inbound): Promise<Response> {
    const co = this.company;
    if (!co.config.browserSession) return json({ error: "not_found" }, 404);
    const context = await co.authorizeResource(inbound);
    let body: unknown;
    try {
      body = JSON.parse(inbound.bodyText);
    } catch {
      body = null;
    }
    const code = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { code?: unknown }).code : undefined;
    if (!(inbound.request.headers.get("Content-Type") ?? "").startsWith("application/json") || typeof code !== "string") {
      co.violation("browser-join.authorize-body", "authorize wasn't a JSON body with the code");
      return json({ error: "invalid_request" }, 400);
    }
    const join = this.#joins.get(code);
    if (join?.authorized) co.violation("browser-join.code-reused", "browser join: the code was authorized before");
    if (!join || join.authorized || join.used || join.expiresAt <= co.now()) return json({ error: "invalid_request" }, 400);
    // A token without poppy:browser-sign-in is refused as at an API, and the code stays unauthorized (6).
    if (context.token && !context.scope.includes("poppy:browser-sign-in")) {
      throw resourceError(context.token.kind === "dpop" ? "DPoP" : "Bearer", 403, "insufficient_scope", { scope: "poppy:browser-sign-in" });
    }
    join.authorized = { sessionId: context.session.id, account: context.account, scope: context.scope, grant: context.token?.grant ?? null };
    return new Response(null, { status: 204 });
  }

  /**
   * The Session the browser's cookie names, if any. It acts for the
   * account and scopes its join authorized, until that sign-in's
   * refresh token is revoked (6, "The cookie").
   */
  #session(inbound: Inbound): Session | undefined {
    const cookie = /(?:^|;\s*)mock_sid=([^;]+)/.exec(inbound.request.headers.get("Cookie") ?? "")?.[1];
    const session = cookie ? this.company.sessions.get(this.#cookies.get(cookie) ?? "") : undefined;
    const grant = cookie ? this.#cookieGrants.get(cookie) : undefined;
    if (!session || !grant) return undefined;
    const live = grant.grant !== null && [...this.company.accountTokens.values()].some((token) => token.grant === grant.grant && !token.revoked && !token.rotated);
    return { ...session, account: live ? grant.account : null, scope: live ? [...grant.scope] : [] };
  }

  /** `POST /account/address`: the address form, sent with the Session's cookie and its hidden field. */
  saveAddress(inbound: Inbound): Response {
    if (this.company.config.webDisabled) {
      this.company.violation("web.disabled-form", "a form sent to a website whose poppy.json sets web.disabled");
    }
    const session = this.#session(inbound);
    const fields = [...new URLSearchParams(inbound.bodyText)];
    const signedIn = session && !session.ended && session.account;
    const csrf = fields.find(([name]) => name === "csrf")?.[1];
    if (!signedIn || csrf !== `csrf-${session.id}`) {
      return new Response("<!doctype html><title>Mock Shop</title><p>Refused</p>", { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    this.company.formPosts.push({ account: session.account, fields });
    return new Response(null, { status: 303, headers: { Location: "/account/address?saved=1" } });
  }

  /**
   * `POST /orders/ord_7Hk2/exchange`: the website's exchange form. A browser
   * joined to a Session that declares Operations 3, signed in to the order's
   * account, gets 403 and `Poppy-Operation` until the operation's approval
   * is recorded at `endpoint`; then the same request performs it, once
   * (0.4 Ops 4, 6). Anyone else gets the website's own approval step.
   */
  exchangeForm(inbound: Inbound): Response {
    const co = this.company;
    const page = (body: string, status: number, headers: Record<string, string> = {}) =>
      new Response(`<!doctype html><title>Mock Shop</title>${body}`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } });
    if (co.config.webDisabled) co.violation("web.disabled-form", "a form sent to a website whose poppy.json sets web.disabled");
    if (inbound.request.headers.has("Poppy-Approval")) co.violation("web-operation.approval-in-browser", "the exchange form came with Poppy-Approval");
    const session = this.#session(inbound);
    if (!session || session.ended || !session.account || !session.scope.includes(co.orderScopes.write)) return page("<p>Sign in to exchange an item.</p>", 403);
    const declared = session.declaration?.declared.get("operations") === "3";
    if (!co.config.webOperations || !declared) return page("<p>Confirm this exchange on our website: we'll email you a link.</p>", 403);
    const asked = Object.fromEntries(new URLSearchParams(inbound.bodyText));
    const request = JSON.stringify({ order_id: "ord_7Hk2", item_id: asked.item_id ?? "", replacement_sku: asked.replacement_sku ?? "" });
    const answer = this.operations.websiteExchange(session, request, asked);
    if ("performed" in answer) {
      if (co.config.webErrorAfterPerforming) return page("<p>Something went wrong. Please try again later.</p>", 503);
      return new Response(null, { status: 303, headers: { Location: "/orders/ord_7Hk2?exchanged=1", "Cache-Control": "no-store" } });
    }
    // The body doesn't carry the operation (Ops 4); this reference, in the page's words, is not one to take.
    return page(
      `<h1>Waiting for approval</h1><p>This exchange is waiting for your approval in your personal agent.</p><p>Reference: ${answer.ref.split(".")[0]}.page</p><form method="post" action="/orders/ord_7Hk2/exchange"><input type="hidden" name="item_id" value="${asked.item_id ?? ""}"><input type="hidden" name="replacement_sku" value="${asked.replacement_sku ?? ""}"><button id="continue">Continue</button></form>`,
      403,
      { "Poppy-Operation": `sid="${session.sid}", ref="${answer.ref}"` }
    );
  }

  /**
   * `POST /orders/ord_7Hk2/return`: the return form, which the page marks for
   * the User to submit (0.4 Browser Control 4). The page posts who controlled
   * the browser in its `controller` field (6). A browser joined to a Session
   * that declared the extension, posting without `"user"`, took a marked step
   * (5); the Company still decides by its own rules (8.1), so the return is
   * recorded either way.
   */
  returnForm(inbound: Inbound): Response {
    const co = this.company;
    const page = (body: string, status: number) =>
      new Response(`<!doctype html><title>Mock Shop</title>${body}`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (co.config.webDisabled) co.violation("web.disabled-form", "a form sent to a website whose poppy.json sets web.disabled");
    const session = this.#session(inbound);
    if (!session || session.ended || !session.account || !session.scope.includes(co.orderScopes.write)) return page("<p>Sign in to return an item.</p>", 403);
    const asked = Object.fromEntries(new URLSearchParams(inbound.bodyText));
    const controller = asked.controller ?? "";
    const declared = session.declaration?.declared.get("browser-control") === "1";
    if (co.config.browserControl && declared && controller !== "user") {
      co.violation("browser-control.marked-step", `the return form, marked submission, came with controller ${JSON.stringify(controller)} from Session ${session.sid}`);
    }
    co.returns.push({ account: session.account, controller, reason: asked.reason ?? "", cardLast4: asked.card_last4 ?? "" });
    return new Response(null, { status: 303, headers: { Location: "/orders/ord_7Hk2?returned=1", "Cache-Control": "no-store" } });
  }

  /** `POST {operations endpoint}` (0.4 Ops 4, 6): the agent's own request, with the Session header and token. */
  async operationsEndpoint(inbound: Inbound): Promise<Response> {
    const co = this.company;
    if (!co.config.webOperations || !co.config.browserSession) return json({ error: "not_found" }, 404);
    const context = await co.authorizeResource(inbound);
    let body: unknown;
    try {
      body = JSON.parse(inbound.bodyText);
    } catch {
      body = null;
    }
    const ref = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { ref?: unknown }).ref : undefined;
    if (typeof ref !== "string" || !/^[A-Za-z0-9_.-]{1,2048}$/.test(ref)) return json({ error: "invalid_request" }, 400);
    const header = inbound.request.headers.get("Poppy-Approval");
    const approval = header === null ? null : parseApprovalHeader(header);
    if (header !== null && (!approval || typeof approval.operation_id !== "string" || typeof approval.revision !== "string")) {
      co.violation("approval.header", `Poppy-Approval isn't an RFC 9651 Dictionary with operation_id and revision Strings: ${JSON.stringify(header)}`);
      return json({ error: "invalid_request" }, 400);
    }
    const answer = this.operations.atEndpoint(context, ref, approval);
    return answer.body ? json(answer.body, answer.status) : new Response(null, { status: answer.status });
  }

  /**
   * A website page's Session header (0.4 5.2): a page the agent fetches
   * without a browser may carry one, signed out, on `organization.domain`
   * only. Verified as at any endpoint, so a failed check is answered with
   * `invalid_session`; one sent to another host or beside a token is
   * recorded. Null: serve the page.
   */
  async pageSession(inbound: Inbound, offHost: boolean): Promise<Response | null> {
    const co = this.company;
    const headers = inbound.request.headers;
    if (!headers.has("Poppy-Session")) return null;
    const where = `${inbound.request.method} ${inbound.url.href}`;
    if (offHost) co.violation("page.session-off-host", `a Session header on a page that isn't on organization.domain (${where})`);
    if (headers.has("Authorization")) co.violation("page.token", `an access token with a website page (${where})`);
    if (co.config.pagesRefuseSession) return co.invalidSession("this page refuses the Session header").response;
    try {
      await co.verifySessionHeader(inbound, null);
    } catch (error) {
      if (error instanceof HttpError) return error.response;
      throw error;
    }
    return null;
  }

  /**
   * Website pages, signed in or out by the Session cookie: `/`, `/orders`,
   * `/account/address` (a form, with a script and a style the browser must
   * skip), `/go?to=` (redirects anywhere, to test where the browser follows),
   * and `/big?kb=` (a page of that size).
   */
  page(inbound: Inbound): Response {
    const co = this.company;
    const html = (body: string, status = 200, title = "Mock Shop") =>
      new Response(`<!doctype html><title>${title}</title>${body}`, {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    if (inbound.url.pathname === "/") {
      return html(`<h1>Mock Shop ${co.id}</h1><a id="orders" href="/orders">Your orders</a> <a href="/account/address">Your address</a>`);
    }
    if (inbound.url.pathname === "/go") {
      return new Response(null, { status: 302, headers: { Location: inbound.url.searchParams.get("to") ?? "/" } });
    }
    if (inbound.url.pathname === "/big") {
      const kb = Number(inbound.url.searchParams.get("kb") ?? "1");
      return html(`<p>${"x".repeat(kb * 1024)}</p>`);
    }
    const session = this.#session(inbound);
    if (inbound.url.pathname === "/account/address") {
      if (!session || session.ended || !session.account) return html("<p>Signed out</p><p>Sign in to change your address.</p>");
      if (inbound.url.searchParams.has("saved")) {
        const saved = co.formPosts.filter((post) => post.account === session.account).at(-1);
        const value = (name: string) => saved?.fields.find(([field]) => field === name)?.[1] ?? "";
        return html(`<p>Saved: ${value("line1")}, ${value("city")}</p>`, 200, "Address saved");
      }
      return html(
        `<style>.note { color: red }</style>
<script>window.tracking = { id: "script-only-text" }; document.write("<p>written by script</p>");</script>
<h1>Your address</h1><p>Signed in as ${session.account}</p>
<form id="address" method="post" action="/account/address">
<input type="hidden" name="csrf" value="csrf-${session.id}">
<label>Address line 1 <input id="line1" name="line1" value=""></label>
<label>City <input id="city" name="city" value="London"></label>
<label>Country <select name="country"><option value="GB" selected>United Kingdom<option value="FR">France</select></label>
<label>Confirm with your account code <input type="password" id="f7" name="confirm"></label>
<label><input type="checkbox" name="default" value="yes" checked> Use as my default</label>
<button id="save" type="submit" name="intent" value="save">Save</button>
</form>
<form method="get" action="/search"><input name="q"><button>Search</button></form>
<a id="help" href="/help?topic=address&amp;lang=en">Help &amp; advice</a>`,
        200,
        "Your address &amp; details"
      );
    }
    if (inbound.url.pathname === "/orders" || inbound.url.pathname.startsWith("/orders/")) {
      // The cookie follows the Session's current state (6).
      if (session && !session.ended && session.account && session.scope.includes(co.orderScopes.read)) {
        if (inbound.url.pathname === "/orders/ord_7Hk2/exchange") {
          return html(`<h1>Exchange an item</h1><form id="exchange" method="post" action="/orders/ord_7Hk2/exchange"><input type="hidden" name="item_id" value="itm_4Qa"><label>Replacement <select name="replacement_sku"><option value="stormline-insulated-m" selected>Stormline Insulated Jacket (M)</select></label><button>Exchange</button></form>`);
        }
        if (inbound.url.pathname === "/orders/ord_7Hk2/return") {
          // 0.4 Browser Control 4: the form is the User's to submit, the card digits theirs to type, the policy theirs to accept.
          const marks = co.config.browserControl;
          const mark = (value: string) => (marks ? ` data-poppy-user-step="${value}"` : "");
          return html(
            `<h1>Return an item</h1>
<form id="return" method="post" action="/orders/ord_7Hk2/return"${mark("submission")}>
<input type="hidden" name="item_id" value="itm_4Qa">
<input type="hidden" name="controller" value="">
<label>Reason <select name="reason"><option value="size" selected>Wrong size<option value="fault">Faulty</select></label>
<label>Last four digits of the card you paid with <input id="card" name="card_last4"${mark("interaction")}></label>
<button id="send-return" type="submit">Return</button>
</form>
<script>document.getElementById("return").addEventListener("submit", (event) => { event.target.elements.controller.value = navigator.poppy?.controller ?? ""; });</script>
<a id="policy" href="/orders/ord_7Hk2/return?policy=accepted"${mark("consent")}>Accept the returns policy</a>`
          );
        }
        const exchanged = inbound.url.searchParams.has("exchanged") ? "<p>Exchange placed.</p>" : "";
        const returned = inbound.url.searchParams.has("returned") ? "<p>Return started.</p>" : "";
        return html(`<p>Signed in as ${session.account}</p>${exchanged}${returned}<ul><li>Order ord_7Hk2: Stormline Jacket (M) <a id="exchange" href="/orders/ord_7Hk2/exchange">Exchange</a> <a id="return" href="/orders/ord_7Hk2/return">Return</a></li></ul>`);
      }
      return html("<p>Signed out</p><p>Sign in to see your orders.</p>");
    }
    return html("<p>Not found</p>", 404);
  }
}

/** Where the mock serves a linked version's document (3.4: "Its path can be anything"). */
export function linkedPath(version: string): string {
  return `/poppy/v${version}.json`;
}
