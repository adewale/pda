import { Company, json, MEDIATED_GRANT, randomId, type Inbound, type ResourceContext, type Session } from "./core";
import type { ViolationId } from "./violations";

/** The tasks the mock chose not to offer (9.1); the web reference is filled in per Company. */
const EXCLUDED: readonly { readonly task: string; readonly alternative?: { readonly instructions: string } }[] = [
  { task: "Close an account", alternative: { instructions: "Accounts are closed by phone." } },
  { task: "Send a gift card" }
];

/** How long discovery documents may be cached unless a test says otherwise. */
const DEFAULT_CACHING: Readonly<Record<string, string>> = { "Cache-Control": "max-age=300" };

/** Discovery documents, the website, and the browser join (sections 3 and 6). */
export class Web {
  /** A report belongs to the verified Personal Agent and User, not every visitor to the Company. */
  readonly #reportedTasks = new Set<string>();
  /** Browser cookie value → Session id. */
  readonly #cookies = new Map<string, string>();
  /** What each Session cookie acts for, as authorized in step 2 (6: "MUST act for the account and scopes authorized"). */
  readonly #cookieGrants = new Map<string, { readonly account: string | null; readonly scope: readonly string[]; readonly grant: string | null }>();
  /** The browser join's codes (6, steps 1 to 3). */
  readonly #joins = new Map<string, { readonly cookie: string; readonly expiresAt: number; authorized: { readonly sessionId: string; readonly account: string | null; readonly scope: readonly string[]; readonly grant: string | null } | null; used: boolean }>();

  constructor(readonly company: Company) {}

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
   * described in `auth.scopes` with `scope_hints`; Operations 2 and
   * Mediated Sign-In as extensions.
   */
  poppyJson(requestedDomain: string): Record<string, unknown> {
    const co = this.company;
    const config = co.config;
    const hosts = co.hosts;
    const { read, write } = co.orderScopes;
    const auth: Record<string, unknown> = {
      ...(config.listIssuer ? { issuer: hosts.issuer } : {}),
      scopes: this.#scopeDescriptions(),
      scope_hints: {
        [read]: { changes: "none", personal_data: true },
        [write]: { changes: "irreversible", personal_data: true },
        addresses: { changes: "reversible", personal_data: true }
      }
    };
    const document: Record<string, unknown> = {
      protocol_version: config.protocolVersion,
      organization: { name: config.organizationName ?? `Mock Shop ${co.id}`, domain: config.organizationDomain ?? requestedDomain },
      auth
    };
    if (config.agent) {
      const protocols: Record<string, unknown>[] = [];
      if (config.unknownProtocol) protocols.push({ type: "example.com/chat-v9", endpoint: `${hosts.api}/chat-v9` });
      protocols.push({ type: "poppy", endpoint: hosts.conversationsEndpoint });
      document.agent = { protocols };
    }
    if (config.web) document.web = config.browserSession ? { browser_session_endpoint: hosts.browserSessionEndpoint } : {};
    if (config.excludedTasks) document.excluded_tasks = { url: `${hosts.web}/poppy/excluded-tasks.json` };
    if (config.feedback) document.feedback = { endpoint: `${hosts.api}/poppy/feedback` };
    const apis: Record<string, unknown>[] = [];
    if (config.unknownApi) apis.push({ type: "graphql", url: `${hosts.api}/graphql`, description: "Everything, as GraphQL" });
    if (config.openapi) apis.push({ type: "openapi", url: config.openapiUrlOverride ?? `${hosts.api}/openapi.json`, description: "Orders and exchanges" });
    if (config.mcp) apis.push({ type: "mcp", url: hosts.mcpUrl, description: "Product search and exchanges" });
    if (apis.length > 0) document.apis = apis;
    const extensions: Record<string, unknown> = {};
    if (config.operations) extensions.operations = { version: "2" };
    const mediated = co.offeredScopes("mediated");
    if (mediated) {
      extensions["mediated-sign-in"] = {
        version: "1",
        fields: [
          { name: "email", label: "Email", secret: false },
          { name: "password", label: "Password", secret: true }
        ],
        scopes: mediated
      };
    }
    if (config.unknownExtension) extensions["mock.test/gift-wrap"] = { version: "1", endpoint: `${hosts.api}/gift-wrap` };
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
    const host = inbound.url.hostname;
    return json(
      { resource: co.config.domainResourceOverride ?? `https://${host}`, authorization_servers: co.config.authorizationServersOverride ?? [co.hosts.issuer] },
      200,
      { ...(co.config.metadataCacheHeaders ?? DEFAULT_CACHING) }
    );
  }

  /** The tasks this Company chose not to offer (9.1), for every User alike. */
  excludedTasks(): Response {
    if (!this.company.config.excludedTasks) return json({ error: "not_found" }, 404);
    return json({ tasks: EXCLUDED.map((entry) => entry.task === "Close an account" ? { ...entry, alternative: { ...entry.alternative, references: [{ type: "web", url: `${this.company.hosts.web}/help/close` }] } } : entry) }, 200, DEFAULT_CACHING);
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
      return json(this.poppyJson(domain), 200, this.#poppyJsonCaching());
    }
    if (co.config.wellKnownRedirect === "https") {
      return Response.redirect(`https://cdn.${co.hosts.domain}/poppy.json?for=${host}`, 302);
    }
    if (co.config.wellKnownRedirect === "http") {
      return Response.redirect(`http://cdn.${co.hosts.domain}/poppy.json?for=${host}`, 302);
    }
    return json(this.poppyJson(host), 200, this.#poppyJsonCaching());
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
      scopes_supported: Object.keys(this.#scopeDescriptions()),
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
        return html(`<p>Signed in as ${session.account}</p><ul><li>Order ord_7Hk2: Stormline Jacket (M)</li></ul>`);
      }
      return html("<p>Signed out</p><p>Sign in to see your orders.</p>");
    }
    return html("<p>Not found</p>", 404);
  }
}
