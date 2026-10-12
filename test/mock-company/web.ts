import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { Company, HttpError, json, randomId, type Inbound } from "./core";
import type { Operations } from "./operations";
import type { ViolationId } from "./violations";

/** How long discovery documents may be cached unless a test says otherwise. */
const DEFAULT_CACHING: Readonly<Record<string, string>> = { "Cache-Control": "max-age=300" };

/** Discovery documents, the website, and the browser-session endpoint (sections 3 and 5). */
export class Web {
  /** Browser cookie value → Session id. */
  readonly #cookies = new Map<string, string>();

  operations: Operations | undefined;

  constructor(readonly company: Company) {}

  /** poppy.json's caching headers: the configured ones (`{}` for none), or the default. */
  #poppyJsonCaching(): Record<string, string> {
    return { ...(this.company.config.poppyJsonCacheHeaders ?? DEFAULT_CACHING) };
  }

  /** `poppy.json` for the domain the agent asked about. */
  poppyJson(requestedDomain: string): Record<string, unknown> {
    const co = this.company;
    const config = co.config;
    const hosts = co.hosts;
    const auth: Record<string, unknown> = { issuer: hosts.issuer };
    const direct = co.offeredScopes("direct");
    const device = co.offeredScopes("device");
    const mediated = co.offeredScopes("mediated");
    if (direct) auth.direct = { scopes: direct };
    if (device) auth.device = { scopes: device };
    if (mediated) {
      auth.mediated = {
        endpoint: hosts.mediatedEndpoint,
        fields: [
          { name: "email", label: "Email", secret: false },
          { name: "password", label: "Password", secret: true }
        ],
        scopes: mediated
      };
    }
    const customScopes: Record<string, string> = config.customScopesOnly
      ? { "orders:read": "View your orders", "orders:write": "Change your orders", ...config.customScopes }
      : config.customScopes;
    if (Object.keys(customScopes).length > 0) auth.custom_scopes = customScopes;
    const document: Record<string, unknown> = {
      protocol_version: config.protocolVersion,
      organization: {
        name: config.organizationName ?? `Mock Shop ${co.id}`,
        domain: config.organizationDomain ?? requestedDomain
      },
      auth
    };
    if (config.agent) {
      const protocols: Record<string, unknown>[] = [];
      if (config.unknownProtocol) {
        protocols.push({ type: "example.com/chat-v9", endpoint: `${hosts.api}/chat-v9` });
      }
      protocols.push({ type: "poppy", endpoint: hosts.conversationsEndpoint });
      document.agent = { protocols };
    }
    if (config.web) {
      document.web = config.browserSession
        ? { browser_session_endpoint: hosts.browserSessionEndpoint }
        : {};
    }
    const apis: Record<string, unknown>[] = [];
    if (config.unknownApi) {
      apis.push({ type: "graphql", url: `${hosts.api}/graphql`, description: "Everything, as GraphQL" });
    }
    if (config.openapi) {
      apis.push({
        type: "openapi",
        url: config.openapiUrlOverride ?? `${hosts.api}/openapi.json`,
        description: "Orders and exchanges",
        ...(config.apiResource ? { resource: hosts.api } : {})
      });
    }
    if (config.mcp) {
      apis.push({ type: "mcp", url: hosts.mcpUrl, description: "Product search and exchanges" });
    }
    if (apis.length > 0) document.apis = apis;
    const extensions: Record<string, unknown> = {};
    if (config.operations) {
      extensions.operations = { version: "1", endpoint: hosts.operationsEndpoint };
    }
    if (config.unknownExtension) {
      extensions["mock.test/gift-wrap"] = { version: "1", endpoint: `${hosts.api}/gift-wrap` };
    }
    if (Object.keys(extensions).length > 0) document.extensions = extensions;
    if (config.unknownField) document.loyalty_program = { name: "Mock Points" };
    // Interop XB: pad the document past an agent's size cap. An unknown field,
    // so a correct agent ignores it (3); an agent with no cap would read it all.
    if (config.padBytes && config.padBytes > 0) document._padding = "x".repeat(config.padBytes);
    return document;
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

  /** OAuth Authorization Server Metadata (RFC 8414) with `poppy_domains` (3.2). */
  authorizationServerMetadata(): Response {
    const co = this.company;
    const hosts = co.hosts;
    const metadata: Record<string, unknown> = {
      issuer: co.config.issuerOverride ?? hosts.issuer,
      token_endpoint: hosts.tokenEndpoint,
      revocation_endpoint: hosts.revocationEndpoint,
      poppy_domains: co.config.poppyDomainsOverride ?? [hosts.domain, hosts.altDomain],
      grant_types_supported: [
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "refresh_token",
        "authorization_code",
        "urn:ietf:params:oauth:grant-type:device_code"
      ],
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
      dpop_signing_alg_values_supported: ["ES256", "RS256"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true
    };
    if (co.config.signIn.direct) metadata.authorization_endpoint = hosts.authorizationEndpoint;
    if (co.config.signIn.device) metadata.device_authorization_endpoint = hosts.deviceEndpoint;
    return json(metadata, 200, { ...(co.config.metadataCacheHeaders ?? DEFAULT_CACHING) });
  }

  /** `POST {browser_session_endpoint}` (section 5). */
  async browserSession(inbound: Inbound): Promise<Response> {
    const co = this.company;
    const page = (id: ViolationId | null, message: string) => {
      if (id) co.violation(id, `browser session: ${message}`);
      return new Response(`<!doctype html><p>${message}</p>`, {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    };
    if (!co.config.browserSession) return new Response("Not found", { status: 404 });
    if (inbound.url.searchParams.has("assertion")) return page("browser-assertion.in-url", "assertion sent in the URL");
    if (inbound.request.method !== "POST") return page("browser-assertion.not-post", "must be a form POST");
    const type = inbound.request.headers.get("Content-Type") ?? "";
    if (!type.startsWith("application/x-www-form-urlencoded")) return page("browser-assertion.content-type", `content type ${JSON.stringify(type)}`);
    const assertion = new URLSearchParams(inbound.bodyText).get("assertion");
    if (!assertion) return page("browser-assertion.missing", "no assertion");
    let header;
    let claims;
    try {
      header = decodeProtectedHeader(assertion);
      claims = decodeJwt(assertion);
    } catch {
      return page("browser-assertion.not-jwt", "assertion is not a JWT");
    }
    if (header.typ !== "poppy-browser+jwt") return page("browser-assertion.typ", `typ ${String(header.typ)}`);
    if (typeof claims.iss !== "string") return page("browser-assertion.no-iss", "no iss");
    let client;
    try {
      client = await co.client(claims.iss);
    } catch (error) {
      if (error instanceof HttpError) return page("browser-assertion.unknown-agent", "unknown Personal Agent");
      throw error;
    }
    // Signed like the assertion that starts a Session (5, 4.2), so checked like one (Guides).
    if (!header.alg || !["ES256", "RS256"].includes(header.alg)) {
      return page("browser-assertion.alg", `alg ${String(header.alg)} is not allowed`);
    }
    // Guides: ignore jku, x5u and any embedded key; verify only with the jwks_uri keys.
    if (header.jku || header.x5u || header.x5c || header.jwk) {
      co.violation("browser-assertion.embedded-key", "browser session: assertion embeds or points to a key (jku/x5u/x5c/jwk)");
    }
    if (co.config.strictAssertions && (!header.kid || !client.jwks.keys.some((key) => key.kid === header.kid))) {
      return page("browser-assertion.kid", `strict Company: kid ${JSON.stringify(header.kid)} names no published key`);
    }
    try {
      await jwtVerify(assertion, createLocalJWKSet(client.jwks), {
        algorithms: ["ES256", "RS256"],
        typ: "poppy-browser+jwt",
        clockTolerance: 30
      });
    } catch (cause) {
      return page("browser-assertion.signature", `signature or expiry: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (Array.isArray(claims.aud) || claims.aud !== co.hosts.browserSessionEndpoint) {
      return page("browser-assertion.aud", `aud ${JSON.stringify(claims.aud)}`);
    }
    if (typeof claims.iat !== "number" || typeof claims.exp !== "number") {
      return page("browser-assertion.iat-exp-missing", "iat and exp are required");
    }
    // Guides: check iat, allowing a small clock skew. Assertions carry the agent's real time.
    if (claims.iat > Math.floor(Date.now() / 1000) + 30) {
      return page("browser-assertion.iat-future", `iat ${claims.iat} is in the future`);
    }
    if (claims.exp - claims.iat > 60) {
      return page("browser-assertion.lifetime", "exp must be no more than 60 seconds after iat");
    }
    // freshJti records the violation.
    if (!co.freshJti("browser-assertion", claims.jti)) return page(null, "jti missing or reused");
    const sessionId = claims.session_id;
    const session = typeof sessionId === "string" ? co.sessions.get(sessionId) : undefined;
    if (!session || session.ended || session.clientId !== client.clientId || session.userId !== claims.sub) {
      return page("browser-assertion.session", "Session isn't active or isn't this agent's and User's");
    }
    let returnTo: URL;
    try {
      returnTo = new URL(String(claims.return_to));
    } catch {
      return page("browser-assertion.return-to-not-url", "return_to is not a URL");
    }
    const domains = [co.hosts.domain, co.hosts.altDomain];
    const onDomain = domains.some(
      (domain) => returnTo.hostname === domain || returnTo.hostname.endsWith(`.${domain}`)
    );
    if (returnTo.protocol !== "https:" || !onDomain) return page("browser-assertion.return-to-off-domain", "return_to is not on the Company's domain");
    const cookie = randomId("", 18);
    this.#cookies.set(cookie, session.id);
    co.browserJoins += 1;
    return new Response(null, {
      status: 303,
      headers: {
        Location: returnTo.toString(),
        "Set-Cookie": `mock_sid=${cookie}; Path=/; Secure; HttpOnly; SameSite=Lax`
      }
    });
  }

  /** The Session the browser's cookie names, if any. */
  #session(inbound: Inbound) {
    const cookie = /(?:^|;\s*)mock_sid=([^;]+)/.exec(inbound.request.headers.get("Cookie") ?? "")?.[1];
    return cookie ? this.company.sessions.get(this.#cookies.get(cookie) ?? "") : undefined;
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
    // An operation's `url`, an exchange's or an order of prints': the same
    // operation, shown in the same Session (Ops 3, 4.4).
    const shown = /^\/(?:orders\/[^/]+\/(exchanges)|(prints))\/([^/]+)$/.exec(inbound.url.pathname);
    if (shown) {
      let id: string | null = null;
      try {
        id = decodeURIComponent(shown[3]!);
      } catch {
        // Not an id this Company issued.
      }
      const operation = id && session && !session.ended ? this.operations?.forWebsite(session, id) : null;
      if (!operation) return html("<p>Not found</p>", 404);
      return html(`<h1>Your ${shown[1] ? "exchange" : "prints"}</h1><p>${operation.summary}</p><p>Status: ${operation.state}</p>`);
    }
    if (inbound.url.pathname === "/orders" || inbound.url.pathname.startsWith("/orders/")) {
      // The cookie follows the Session's current state (5).
      if (session && !session.ended && session.account && session.scope.includes(co.orderScopes.read)) {
        return html(`<p>Signed in as ${session.account}</p><ul><li>Order ord_7Hk2: Stormline Jacket (M)</li></ul>`);
      }
      return html("<p>Signed out</p><p>Sign in to see your orders.</p>");
    }
    return html("<p>Not found</p>", 404);
  }
}
