import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { Company, HttpError, json, randomId, type Inbound } from "./core";

/** Discovery documents, the website, and the browser-session endpoint (sections 3 and 5). */
export class Web {
  /** Browser cookie value → Session id. */
  readonly #cookies = new Map<string, string>();

  constructor(readonly company: Company) {}

  /** `poppy.json` for the domain the agent asked about. */
  poppyJson(requestedDomain: string): Record<string, unknown> {
    const co = this.company;
    const config = co.config;
    const hosts = co.hosts;
    const auth: Record<string, unknown> = { issuer: hosts.issuer };
    if (config.signIn.direct) auth.direct = { scopes: config.signIn.direct };
    if (config.signIn.device) auth.device = { scopes: config.signIn.device };
    if (config.signIn.mediated) {
      auth.mediated = {
        endpoint: hosts.mediatedEndpoint,
        fields: [
          { name: "email", label: "Email", secret: false },
          { name: "password", label: "Password", secret: true }
        ],
        scopes: config.signIn.mediated
      };
    }
    if (Object.keys(config.customScopes).length > 0) auth.custom_scopes = config.customScopes;
    const document: Record<string, unknown> = {
      protocol_version: config.protocolVersion,
      organization: {
        name: `Mock Shop ${co.id}`,
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
      apis.push({ type: "openapi", url: `${hosts.api}/openapi.json`, description: "Orders and exchanges" });
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
    return document;
  }

  /** `GET https://{domain}/.well-known/poppy.json`, maybe by redirect (3). */
  wellKnown(inbound: Inbound): Response {
    const co = this.company;
    const host = inbound.url.hostname.replace(/^www\./, "");
    if (host.startsWith("cdn.")) {
      const domain = inbound.url.searchParams.get("for") ?? co.hosts.domain;
      return json(this.poppyJson(domain), 200, { "Cache-Control": "max-age=300" });
    }
    if (co.config.wellKnownRedirect === "https") {
      return Response.redirect(`https://cdn.${co.hosts.domain}/poppy.json?for=${host}`, 302);
    }
    if (co.config.wellKnownRedirect === "http") {
      return Response.redirect(`http://cdn.${co.hosts.domain}/poppy.json?for=${host}`, 302);
    }
    return json(this.poppyJson(host), 200, { "Cache-Control": "max-age=300" });
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
    return json(metadata, 200, { "Cache-Control": "max-age=300" });
  }

  /** `POST {browser_session_endpoint}` (section 5). */
  async browserSession(inbound: Inbound): Promise<Response> {
    const co = this.company;
    const page = (message: string) => {
      co.violation(`browser session: ${message}`);
      return new Response(`<!doctype html><p>${message}</p>`, {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    };
    if (!co.config.browserSession) return new Response("Not found", { status: 404 });
    if (inbound.url.searchParams.has("assertion")) return page("assertion sent in the URL");
    if (inbound.request.method !== "POST") return page("must be a form POST");
    const type = inbound.request.headers.get("Content-Type") ?? "";
    if (!type.startsWith("application/x-www-form-urlencoded")) return page(`content type ${type}`);
    const assertion = new URLSearchParams(inbound.bodyText).get("assertion");
    if (!assertion) return page("no assertion");
    let header;
    let claims;
    try {
      header = decodeProtectedHeader(assertion);
      claims = decodeJwt(assertion);
    } catch {
      return page("assertion is not a JWT");
    }
    if (header.typ !== "poppy-browser+jwt") return page(`typ ${String(header.typ)}`);
    if (typeof claims.iss !== "string") return page("no iss");
    let client;
    try {
      client = await co.client(claims.iss);
    } catch (error) {
      if (error instanceof HttpError) return page("unknown Personal Agent");
      throw error;
    }
    try {
      await jwtVerify(assertion, createLocalJWKSet(client.jwks), {
        algorithms: ["ES256", "RS256"],
        typ: "poppy-browser+jwt",
        clockTolerance: 30
      });
    } catch (cause) {
      return page(`signature or expiry: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (Array.isArray(claims.aud) || claims.aud !== co.hosts.browserSessionEndpoint) {
      return page(`aud ${JSON.stringify(claims.aud)}`);
    }
    if (typeof claims.iat !== "number" || typeof claims.exp !== "number" || claims.exp - claims.iat > 60) {
      return page("exp must be no more than 60 seconds after iat");
    }
    if (!co.freshJti("browser assertion", claims.jti)) return page("jti reused");
    const sessionId = claims.session_id;
    const session = typeof sessionId === "string" ? co.sessions.get(sessionId) : undefined;
    if (!session || session.ended || session.clientId !== client.clientId || session.userId !== claims.sub) {
      return page("Session isn't active or isn't this agent's and User's");
    }
    let returnTo: URL;
    try {
      returnTo = new URL(String(claims.return_to));
    } catch {
      return page("return_to is not a URL");
    }
    const domains = [co.hosts.domain, co.hosts.altDomain];
    const onDomain = domains.some(
      (domain) => returnTo.hostname === domain || returnTo.hostname.endsWith(`.${domain}`)
    );
    if (returnTo.protocol !== "https:" || !onDomain) return page("return_to is not on the Company's domain");
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

  /** Website pages: `/` and `/orders`, signed in or out by the Session cookie. */
  page(inbound: Inbound): Response {
    const co = this.company;
    const html = (body: string, status = 200) =>
      new Response(`<!doctype html><title>Mock Shop</title>${body}`, {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    if (inbound.url.pathname === "/") {
      return html(`<h1>Mock Shop ${co.id}</h1><a href="/orders">Your orders</a>`);
    }
    if (inbound.url.pathname === "/orders" || inbound.url.pathname.startsWith("/orders/")) {
      const cookie = /(?:^|;\s*)mock_sid=([^;]+)/.exec(inbound.request.headers.get("Cookie") ?? "")?.[1];
      const session = cookie ? co.sessions.get(this.#cookies.get(cookie) ?? "") : undefined;
      // The cookie follows the Session's current state (5).
      if (session && !session.ended && session.account && session.scope.includes("poppy:read")) {
        return html(`<p>Signed in as ${session.account}</p><ul><li>Order ord_7Hk2: Stormline Jacket (M)</li></ul>`);
      }
      return html("<p>Signed out</p><p>Sign in to see your orders.</p>");
    }
    return html("<p>Not found</p>", 404);
  }
}
