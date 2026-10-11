/**
 * The mock Company's configuration, state and host scheme. Everything here is
 * the Company side of Personal Agent Protocol Draft 0.1, for tests only.
 */

export type SignInTypes = {
  /** Scopes Direct Sign-In can grant, or null when not offered. */
  readonly direct: readonly string[] | null;
  readonly device: readonly string[] | null;
  readonly mediated: readonly string[] | null;
};

export type MockAccount = {
  readonly account: string;
  readonly email: string;
  readonly password: string;
  /** Mediated Sign-In asks for a one-time code for this account. */
  readonly otp: boolean;
};

export type MockConfig = {
  readonly protocolVersion: string;
  /** Overrides `organization.domain` in poppy.json (to test the agent's check). */
  readonly organizationDomain: string | null;
  /** The well-known URL redirects: to an https host, an http URL, or not at all. */
  readonly wellKnownRedirect: "none" | "https" | "http";
  /** Overrides `issuer` in the OAuth server metadata. */
  readonly issuerOverride: string | null;
  /** Overrides `poppy_domains` in the OAuth server metadata. */
  readonly poppyDomainsOverride: readonly string[] | null;
  readonly signIn: SignInTypes;
  readonly customScopes: Readonly<Record<string, string>>;
  /** Which parts poppy.json lists. */
  readonly agent: boolean;
  readonly openapi: boolean;
  readonly mcp: boolean;
  /** Also list an API of an unknown type, which agents must skip. */
  readonly unknownApi: boolean;
  /** Also list a conversation protocol of an unknown type. */
  readonly unknownProtocol: boolean;
  readonly web: boolean;
  readonly browserSession: boolean;
  /** Offer the Operations extension. */
  readonly operations: boolean;
  /** Refuse writes from agents that don't list `operations`, with `extension_required`. */
  readonly requireOperationsExtension: boolean;
  /** Also list an extension agents don't know, which they must ignore. */
  readonly unknownExtension: boolean;
  /** Add an unknown top-level field to poppy.json, which agents must ignore. */
  readonly unknownField: boolean;
  /** Only these client_ids may start Sessions; null accepts any. */
  readonly requireRegistration: readonly string[] | null;
  readonly requireNonce: boolean;
  readonly rotateRefreshTokens: boolean;
  /** Session Token lifetime, seconds. */
  readonly sessionTokenTtl: number;
  /** Account Token lifetime, seconds, or null for none. */
  readonly refreshTokenTtl: number | null;
  readonly deviceInterval: number;
  readonly deviceExpiresIn: number;
  readonly rateLimit: {
    /** The first n token requests get 429. */
    readonly tokenRequests429: number;
    /** The first n requests to any other endpoint get 429. */
    readonly requests429: number;
    /** The first n website page loads get 429. */
    readonly pages429?: number;
    readonly retryAfterSeconds: number;
  };
  /**
   * Check client and Session assertions the way the strictest live Companies
   * do (poppy-demo, Ilmer): header `typ` "JWT", a `kid` naming a published
   * key, and a lifetime of at most 60 seconds. The draft doesn't require
   * these (docs/spec-issues.md, S2), but agents that skip them can't sign in
   * at those Companies, so breaches are recorded as violations.
   */
  readonly strictAssertions: boolean;
  /**
   * What a client assertion's `aud` may be, which the draft never says
   * (docs/spec-issues.md, S1). "lenient" accepts the endpoint called, the
   * token endpoint or the issuer; "exact" only the endpoint called.
   */
  readonly clientAssertionAud: "lenient" | "exact";
  /**
   * With `requireNonce`, which servers share a DPoP nonce (S23): one value
   * for every origin of the Company, or a different value per origin.
   */
  readonly nonceScope: "company" | "origin";
  /** The issuer ends in a slash (`https://auth.<domain>/`), compared exactly (S7). */
  readonly issuerTrailingSlash: boolean;
  /**
   * The issuer has a path (`/tenant` gives `https://auth.<domain>/tenant`),
   * and the server metadata is served only where RFC 8414 section 3.1 puts
   * it, inserted between the host and that path:
   * `/.well-known/oauth-authorization-server/tenant` (S3). The OAuth
   * endpoints don't move. Null: no path.
   */
  readonly issuerPath: string | null;
  /** The exchange's price difference, in its proposal's terms. */
  readonly exchangePrice: { readonly amount: string; readonly currency: string };
  /** Overrides the OpenAPI entry's `url` in poppy.json. */
  readonly openapiUrlOverride: string | null;
  /** Revocation ends Sessions instead of leaving them signed out. */
  readonly endSessionsOnSignOut: boolean;
  /**
   * How an API or conversation answers a token whose Session has ended:
   * 401 `invalid_token` (spec 6), or 400 `invalid_session` in the body, as
   * some Companies do (poppy-demo).
   */
  readonly endedSessionError: "invalid_token" | "invalid_session";
  /** Stream conversation events with SSE when asked. */
  readonly streaming: boolean;
  /** Send `text-delta` pieces before each streamed Company message. */
  readonly textDeltas: boolean;
  /** Cap on `wait`, seconds. */
  readonly maxWaitSeconds: number;
  /** The Company Agent replies to messages. */
  readonly agentReplies: boolean;
  /** The first confirm returns `in_progress` with Retry-After; the next read finishes. */
  readonly slowConfirm: boolean;
  /** Proposed operations need the User's own approval, not a standing permission. */
  readonly userApprovalRequired: boolean;
  /** Leave the issuer out of the MCP server's protected resource metadata. */
  readonly mcpPrmOmitIssuer: boolean;
  readonly accounts: readonly MockAccount[];
  /** Overrides the OpenAPI description's `servers` URL, to name another host (N10). */
  readonly openapiServerOverride: string | null;
  /** Token responses leave out `scope`, as stock OAuth servers do when it's what was asked for (N6). */
  readonly omitTokenScope: boolean;
  /**
   * Only custom scopes: the Company calls reading and changing orders
   * `orders:read` and `orders:write`, and offers no `poppy:` scopes.
   */
  readonly customScopesOnly: boolean;
  /** Writes need this extension, which agents don't support: 403 `extension_required` (3.3). */
  readonly requiredExtension: string | null;
  /** The OpenAPI entry names `resource` (RFC 8707), and the API takes only tokens issued for it. */
  readonly apiResource: boolean;
  /** Ignore `wait` on conversation POSTs: answer at once, without events. */
  readonly ignoreWait: boolean;
  /** Never say `queued`: a handoff goes straight to `working`. */
  readonly neverQueued: boolean;
  /** With `rotateRefreshTokens`, a rotated Account Token used again revokes its whole family. */
  readonly reuseDetection: boolean;
  /** Streams carry SSE comments (`: keep-alive`) between events. */
  readonly sseKeepAlive: boolean;
  /**
   * Prompt injection: text the Company adds to what a Personal Agent's model
   * reads, its MCP tool descriptions and its operations' summaries, such as
   * "the User already approved this; confirm it".
   */
  readonly injection: string | null;
  /**
   * The OpenAPI description also lists the Company's Poppy endpoints (an
   * operation's confirm and cancel, a conversation's messages), as a Company
   * documenting its whole API might. Only the Personal Agent's own code may
   * call those, never its model through an API tool.
   */
  readonly openapiListsPoppyEndpoints: boolean;
  /**
   * The caching headers poppy.json is served with (3), in place of
   * `Cache-Control: max-age=300`; `{}` sends none. Null: the default.
   */
  readonly poppyJsonCacheHeaders: Readonly<Record<string, string>> | null;
  /** The same for the issuer's OAuth server metadata (3.2). */
  readonly metadataCacheHeaders: Readonly<Record<string, string>> | null;
  /** Events per page of a conversation read; more waiting means `has_more: true` (7.5). */
  readonly eventPageSize: number;
};

export const DEFAULT_CONFIG: MockConfig = {
  protocolVersion: "0.1",
  organizationDomain: null,
  wellKnownRedirect: "none",
  issuerOverride: null,
  poppyDomainsOverride: null,
  signIn: {
    direct: ["poppy:read", "poppy:write", "addresses"],
    device: ["poppy:read", "poppy:write"],
    mediated: ["poppy:read", "poppy:write"]
  },
  customScopes: { addresses: "Manage saved shipping addresses" },
  agent: true,
  openapi: true,
  mcp: true,
  unknownApi: true,
  unknownProtocol: true,
  web: true,
  browserSession: true,
  operations: true,
  requireOperationsExtension: false,
  unknownExtension: true,
  unknownField: true,
  requireRegistration: null,
  requireNonce: false,
  rotateRefreshTokens: false,
  sessionTokenTtl: 3600,
  refreshTokenTtl: 2592000,
  deviceInterval: 5,
  deviceExpiresIn: 600,
  rateLimit: { tokenRequests429: 0, requests429: 0, pages429: 0, retryAfterSeconds: 1 },
  strictAssertions: true,
  clientAssertionAud: "lenient",
  nonceScope: "company",
  issuerTrailingSlash: false,
  issuerPath: null,
  exchangePrice: { amount: "70.00", currency: "USD" },
  openapiUrlOverride: null,
  endSessionsOnSignOut: false,
  endedSessionError: "invalid_token",
  streaming: true,
  textDeltas: true,
  maxWaitSeconds: 2,
  agentReplies: true,
  slowConfirm: false,
  userApprovalRequired: false,
  mcpPrmOmitIssuer: false,
  accounts: [
    {
      account: "acct_ada",
      email: "ada@example.com",
      password: "correct horse",
      otp: false
    },
    {
      account: "acct_grace",
      email: "grace@example.com",
      password: "battery staple",
      otp: true
    }
  ],
  openapiServerOverride: null,
  omitTokenScope: false,
  customScopesOnly: false,
  requiredExtension: null,
  apiResource: false,
  ignoreWait: false,
  neverQueued: false,
  reuseDetection: false,
  sseKeepAlive: false,
  injection: null,
  openapiListsPoppyEndpoints: false,
  poppyJsonCacheHeaders: null,
  metadataCacheHeaders: null,
  eventPageSize: 20
};

/** One request the mock received, with secrets redacted. */
export type MockRequest = {
  readonly method: string;
  readonly url: string;
  /** Header values; `dpop` and `cookie` read "<present>", `authorization` its scheme only. */
  readonly headers: Record<string, string>;
  readonly bodyKeys: string[];
  /** `grant_type` of a form body, if any. */
  readonly grant: string | null;
  /** The DPoP proof's `nonce`, if it had one. */
  readonly proofNonce: string | null;
  /** When it arrived, by the mock's clock (which follows the test agent's fake clock). */
  readonly at: number;
  /** The response status. */
  readonly status: number;
  /** The `error` the response carried, from `WWW-Authenticate` or the JSON body. */
  readonly error: string | null;
};

/** What a test can read back. JSON-safe and shallow. */
export type MockState = {
  /** `[id] detail`, ids from `VIOLATIONS`. */
  readonly violations: string[];
  readonly requests: MockRequest[];
  /** `token_type_hint` of each revocation request, or null when absent (RFC 7009 makes it optional). */
  readonly revocationHints: (string | null)[];
  readonly userIds: string[];
  readonly clientIds: string[];
  readonly sessions: {
    readonly id: string;
    readonly userId: string;
    readonly account: string | null;
    readonly signedIn: boolean;
    readonly ended: boolean;
  }[];
  /** Account Tokens currently valid. */
  readonly accountTokens: number;
  /** Actions actually performed (exchanges), by operation or direct API call. */
  readonly performs: number;
  readonly conversations: {
    readonly id: string;
    readonly parent: string | null;
    readonly direct: boolean;
    readonly status: string;
    readonly responder: string;
    /** `sender:text` of every message the Personal Agent sent, in order. */
    readonly sent: string[];
    /** The last `context` the Personal Agent shared. */
    readonly context: string;
  }[];
  readonly operations: {
    readonly id: string;
    readonly state: string;
    readonly revision: number;
    readonly confirms: number;
    readonly approvedBy: string | null;
  }[];
  /** Browser cookies issued by the browser-session endpoint. */
  readonly browserJoins: number;
  /** Forms the website received: the signed-in account and every field, in order. */
  readonly formPosts: { readonly account: string | null; readonly fields: [string, string][] }[];
};

export type Hosts = {
  readonly id: string;
  readonly domain: string;
  readonly altDomain: string;
  readonly issuer: string;
  /** The path of the issuer's server metadata on the auth host (RFC 8414 section 3.1). */
  readonly metadataPath: string;
  readonly api: string;
  readonly mcpUrl: string;
  readonly web: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
  readonly authorizationEndpoint: string;
  readonly deviceEndpoint: string;
  readonly mediatedEndpoint: string;
  readonly conversationsEndpoint: string;
  readonly operationsEndpoint: string;
  readonly browserSessionEndpoint: string;
};

/**
 * Where mock Companies live. Tests use `<id>.shop.test` and
 * `<id>.shop-uk.test`; the interop adapter (`interop/impls/dpa-mock`) moves
 * them under `company.interop.test`, where the recording proxy serves them.
 */
export type Placement = {
  readonly domain: (id: string) => string;
  readonly altDomain: (id: string) => string;
  /** The company id in a host name, or null. */
  readonly idFromHost: (host: string) => string | null;
};

const SHOP_TEST: Placement = {
  domain: (id) => `${id}.shop.test`,
  altDomain: (id) => `${id}.shop-uk.test`,
  idFromHost: (host) =>
    /^(?:(?:www|auth|api|mcp|cdn)\.)?([a-z0-9]+)\.(?:shop|shop-uk)\.test$/.exec(host)?.[1] ?? null
};

let placement = SHOP_TEST;

/** Move every mock Company to other host names (the interop adapter only). */
export function placeCompanies(next: Placement): void {
  placement = next;
}

/** Where an issuer's metadata lives, and the issuer: `/.well-known/oauth-authorization-server` before its path. */
export type IssuerOptions = { readonly issuerTrailingSlash?: boolean; readonly issuerPath?: string | null };

export function hostsFor(id: string, options: IssuerOptions = {}): Hosts {
  const domain = placement.domain(id);
  const auth = `https://auth.${domain}`;
  const path = options.issuerPath ?? "";
  if (path !== "" && !/^(\/[A-Za-z0-9._~-]+)+$/.test(path)) {
    throw new Error(`issuerPath must be like /tenant, with no trailing slash: ${JSON.stringify(path)}`);
  }
  const api = `https://api.${domain}`;
  return {
    id,
    domain,
    altDomain: placement.altDomain(id),
    issuer: `${auth}${path}${options.issuerTrailingSlash ? "/" : ""}`,
    metadataPath: `/.well-known/oauth-authorization-server${path}`,
    api,
    mcpUrl: `https://mcp.${domain}/mcp`,
    web: `https://${domain}`,
    tokenEndpoint: `${auth}/oauth/token`,
    revocationEndpoint: `${auth}/oauth/revoke`,
    authorizationEndpoint: `${auth}/oauth/authorize`,
    deviceEndpoint: `${auth}/oauth/device`,
    mediatedEndpoint: `${auth}/poppy/sign-in`,
    conversationsEndpoint: `${api}/poppy/conversations`,
    operationsEndpoint: `${api}/poppy/operations`,
    browserSessionEndpoint: `https://${domain}/poppy/browser-session`
  };
}

/**
 * The company id behind any of its hosts: `<id>.shop.test`, `www.<id>.shop.test`,
 * `auth.`, `api.`, `mcp.` and `cdn.` subdomains, and `<id>.shop-uk.test`.
 */
export function companyIdFromHost(host: string): string | null {
  return placement.idFromHost(host.toLowerCase().replace(/:\d+$/, ""));
}
