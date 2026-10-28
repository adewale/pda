import { summarize, validateCompany, type CompanyReport } from "../validator/index.ts";
import type { Fetcher } from "./fetch";
import { parseIssuer, type Issuer } from "./issuer";
import { FOREIGN_TEXT, type ForeignText } from "../log";
import { protocolRevision } from "./protocol-version";

/** Extensions this client supports, with the major version it implements (3.3): Operations 2 and Mediated Sign-In 1. */
export const SUPPORTED_EXTENSIONS = { operations: "2", "mediated-sign-in": "1" } as const;
/** Mediated Sign-In's grant at the token endpoint (Mediated Sign-In 1). */
export const MEDIATED_GRANT = "https://personalagentprotocol.org/grant/mediated-sign-in";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** What a scope allows, by the Company's own account (4.7): hints, never the User's approval. */
export type ScopeHint = { readonly changes: "none" | "reversible" | "irreversible"; readonly personalData: boolean };

export type SignInType = "direct" | "device" | "mediated";

export type MediatedField = {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
};

/** Everything a Personal Agent needs about one Company, verified (3). */
export type Company = {
  /** The issuer the domain's protected resource metadata names: what identifies the Company (3.2). */
  readonly issuer: Issuer;
  readonly name: string;
  /** `organization.domain` of the document this came from. */
  readonly domain: string;
  /**
   * The hosts of the issuer's `protected_resources`, lowercased (3.2): where
   * tokens and Session JWTs may go beside `organization.domain`, and where a
   * device sign-in link may point (4.3).
   */
  readonly poppyDomains?: readonly string[];
  readonly protocolVersion: string;
  readonly specificationRevision?: string;
  /** Canonical `auth`, for comparing domains that share an issuer: they MUST have the same (3.2). */
  readonly authFingerprint?: string;
  readonly feedback?: { readonly endpoint: string };
  readonly endpoints: {
    readonly token: string;
    readonly revocation: string;
    readonly authorization?: string;
    readonly deviceAuthorization?: string;
  };
  readonly signIn: {
    readonly direct?: { readonly scopes: readonly string[] };
    readonly device?: { readonly scopes: readonly string[] };
    /** Mediated Sign-In, an extension grant at the token endpoint (Mediated Sign-In 3). */
    readonly mediated?: {
      /** Where the credentials go: the issuer's token endpoint, and nowhere else (Mediated Sign-In 6). */
      readonly endpoint: string;
      readonly fields: readonly MediatedField[];
      readonly scopes: readonly string[];
    };
  };
  readonly customScopes: Readonly<Record<string, string>>;
  /** `auth.scope_hints` (4.7); a `changes` value we don't know is read as irreversible. */
  readonly scopeHints?: Readonly<Record<string, ScopeHint>>;
  /** The issuer lists `dpop_signing_alg_values_supported`, so token requests carry a DPoP proof (4.5). */
  readonly dpop?: boolean;
  /** The issuer's `protected_resources` (3.2). */
  readonly protectedResources?: readonly string[];
  /** Where the tasks the Company doesn't offer are listed (9.1). */
  readonly excludedTasks?: { readonly url: string };
  /** The first `poppy` conversation protocol entry, if any. */
  readonly conversations?: { readonly endpoint: string };
  readonly apis: readonly {
    readonly type: "openapi" | "mcp";
    readonly url: string;
    readonly description: string;
  }[];
  readonly web?: { readonly browserSessionEndpoint?: string };
  /** Supported extensions only; unknown ones are ignored (3.3). */
  readonly extensions: {
    /** Operations version 2: approvals on the request that returned the operation, no endpoint (Ops 2). */
    readonly operations?: true;
  };
};

/** A domain the Company can be browsed at but has no `auth`: website only (3.1). */
export type WebsiteOnly = {
  readonly websiteOnly: true;
  readonly name: string;
  readonly domain: string;
};

/** Discovery refused a Company. Its message quotes what the Company published (the validator's findings, its name), so a wide event records only its class (`ForeignText`, src/log.ts). */
export class DiscoveryError extends Error implements ForeignText {
  override name = "DiscoveryError";
  readonly [FOREIGN_TEXT] = true as const;
  /** The validator's report, when discovery refused what it read (for the protocol log). */
  constructor(message: string, readonly report?: CompanyReport) {
    super(message);
  }
}

const CACHE_MIN_SECONDS = 60;
const CACHE_MAX_SECONDS = 24 * 60 * 60;

/**
 * How long the client keeps a document a Company serves (poppy.json and its
 * issuer metadata, an OpenAPI description): its `Cache-Control` or `Expires`
 * lifetime, bounded to between a minute and a day (Guides). A document that
 * sends neither has said nothing about caching, so it gets the shortest
 * lifetime, a minute.
 */
export function boundedCacheSeconds(seconds: number | null): number {
  if (seconds === null) return CACHE_MIN_SECONDS;
  return Math.min(CACHE_MAX_SECONDS, Math.max(CACHE_MIN_SECONDS, seconds));
}

type Obj = { readonly [key: string]: unknown };

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export type Discovered = {
  readonly result: Company | WebsiteOnly;
  /** Seconds both documents may be cached for, bounded. */
  readonly cacheSeconds: number;
  /** The validator's report on both documents. */
  readonly report: CompanyReport;
};

/**
 * Discovery for one domain (3). The validator in `src/validator` fetches
 * poppy.json, the domain's protected resource metadata and the issuer's
 * OAuth metadata, and checks them, including `issuer` and
 * `protected_resources` (3.2). We refuse the Company when the report
 * says our client refuses (`refused`): an error, except the few the draft or
 * an RFC tells a reader to tolerate (a byte order mark, an API type we don't
 * know, which we skip); a warning that guards against a hostile document (a
 * limit or reading of ours the message names); or a document that couldn't
 * be fetched. What follows reads fields the validator has checked.
 */
export async function discover(fetcher: Fetcher, domain: string): Promise<Discovered> {
  const checked = await validateCompany(fetcher, domain);
  if (checked.refused || checked.outcome === "indeterminate" || !isObj(checked.poppy)) {
    throw new DiscoveryError(summarize(checked) || "poppy.json couldn't be used", checked);
  }
  const doc = checked.poppy;
  const version = doc.protocol_version as string;
  const organization = doc.organization as Obj;
  const orgDomain = (organization.domain as string).toLowerCase();
  const name = str(organization.name) ?? orgDomain;
  const cacheSeconds = boundedCacheSeconds(checked.maxAgeSeconds);
  // The issuer is the one the domain's protected resource metadata names (3.2); `auth` is optional.
  if (!isObj(checked.metadata) || !checked.issuer) {
    return { result: { websiteOnly: true, name, domain: orgDomain }, cacheSeconds, report: checked };
  }
  const issuer = parseIssuer(checked.issuer);
  // The validator has refused anything else already; this keeps the type honest.
  if (!issuer) throw new DiscoveryError("The issuer isn't an https URL without a query or fragment", checked);
  return { result: company(doc, isObj(doc.auth) ? doc.auth : {}, checked.metadata, { issuer, name, domain: orgDomain, version }), cacheSeconds, report: checked };
}

/** The Company Agent, its APIs and its website, skipping types we don't know (7, 8.1). */
function services(doc: Obj): Pick<Company, "conversations" | "apis" | "web"> {
  let conversations: Company["conversations"];
  if (isObj(doc.agent) && Array.isArray(doc.agent.protocols)) {
    const entry = doc.agent.protocols.filter(isObj).find((item) => item.type === "poppy");
    if (entry) conversations = { endpoint: entry.endpoint as string };
  }
  const apis: Company["apis"][number][] = [];
  if (Array.isArray(doc.apis)) {
    for (const entry of doc.apis.filter(isObj)) {
      if (entry.type !== "openapi" && entry.type !== "mcp") continue;
      apis.push({ type: entry.type, url: entry.url as string, description: str(entry.description) ?? "" });
    }
  }
  let web: Company["web"];
  if (isObj(doc.web)) {
    const endpoint = str(doc.web.browser_session_endpoint);
    web = endpoint ? { browserSessionEndpoint: endpoint } : {};
  }
  return { ...(conversations ? { conversations } : {}), apis, ...(web ? { web } : {}) };
}

/**
 * A Company (3, 3.2): sign-in types from the issuer's
 * `grant_types_supported`, every one able to request any of
 * `scopes_supported` (4.7); scopes described in `auth.scopes`, with
 * `auth.scope_hints`; Mediated Sign-In and Operations 2 from `extensions`.
 * Services name no `resource`: a service's own protected resource metadata
 * says whether it takes only its own tokens (4.5), which the client reads.
 */
function company(doc: Obj, auth: Obj, metadata: Obj, known: { issuer: Issuer; name: string; domain: string; version: string }): Company {
  const grants = strings(metadata.grant_types_supported);
  const supported = strings(metadata.scopes_supported);
  const signIn: { -readonly [K in keyof Company["signIn"]]: Company["signIn"][K] } = {};
  if (grants.includes("authorization_code")) signIn.direct = { scopes: supported };
  if (grants.includes(DEVICE_GRANT)) signIn.device = { scopes: supported };
  const extensions = isObj(doc.extensions) ? doc.extensions : {};
  const mediated = extensions["mediated-sign-in"];
  if (isObj(mediated) && mediated.version === SUPPORTED_EXTENSIONS["mediated-sign-in"] && grants.includes(MEDIATED_GRANT)) {
    signIn.mediated = {
      endpoint: metadata.token_endpoint as string,
      fields: (Array.isArray(mediated.fields) ? mediated.fields.filter(isObj) : []).map((field) => ({ name: field.name as string, label: field.label as string, secret: field.secret === true })),
      scopes: strings(mediated.scopes).filter((scope) => supported.includes(scope))
    };
  }
  const customScopes: Record<string, string> = {};
  if (isObj(auth.scopes)) for (const [scope, description] of Object.entries(auth.scopes)) if (typeof description === "string") customScopes[scope] = description;
  const scopeHints: Record<string, ScopeHint> = {};
  if (isObj(auth.scope_hints)) {
    for (const [scope, hint] of Object.entries(auth.scope_hints)) {
      if (!isObj(hint) || typeof hint.personal_data !== "boolean") continue;
      // 4.7: a changes value it doesn't recognize is irreversible.
      const changes = hint.changes === "none" || hint.changes === "reversible" ? hint.changes : "irreversible";
      scopeHints[scope] = { changes, personalData: hint.personal_data };
    }
  }
  const protectedResources = strings(metadata.protected_resources);
  const operations = extensions.operations;
  return {
    issuer: known.issuer,
    name: known.name,
    domain: known.domain,
    // Hosts that may receive Session JWTs and show a device link (4.3): the issuer's protected resources.
    poppyDomains: protectedResources.flatMap((entry) => (URL.canParse(entry) ? [new URL(entry).hostname.toLowerCase()] : [])),
    protocolVersion: known.version,
    specificationRevision: protocolRevision(known.version),
    authFingerprint: canonicalAuth(doc.auth ?? null),
    ...(isObj(doc.feedback) && typeof doc.feedback.endpoint === "string" ? { feedback: { endpoint: doc.feedback.endpoint } } : {}),
    endpoints: {
      token: metadata.token_endpoint as string,
      revocation: metadata.revocation_endpoint as string,
      ...(signIn.direct ? { authorization: metadata.authorization_endpoint as string } : {}),
      ...(signIn.device ? { deviceAuthorization: metadata.device_authorization_endpoint as string } : {})
    },
    signIn,
    customScopes,
    scopeHints,
    dpop: Array.isArray(metadata.dpop_signing_alg_values_supported) && metadata.dpop_signing_alg_values_supported.includes("ES256"),
    protectedResources,
    ...(isObj(doc.excluded_tasks) && typeof doc.excluded_tasks.url === "string" ? { excludedTasks: { url: doc.excluded_tasks.url } } : {}),
    ...services(doc),
    extensions: isObj(operations) && operations.version === SUPPORTED_EXTENSIONS.operations ? { operations: true } : {}
  };
}

function canonicalAuth(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : isObj(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])])) : item;
  return JSON.stringify(sorted(value));
}

/**
 * Whether a host may receive this Company's access tokens, Session JWTs
 * and DPoP proofs. The draft doesn't say (docs/spec-issues.md, N10), and an
 * OpenAPI description can name any server, so only these do: a host
 * `poppy.json` lists for a service, or a host equal to or under
 * `organization.domain` or a URL in the issuer's `protected_resources`.
 */
export function tokenHostAllowed(company: Company, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const listed = [
    company.conversations?.endpoint,
    company.web?.browserSessionEndpoint,
    company.feedback?.endpoint,
    ...company.apis.map((api) => api.url)
  ].flatMap((value) => (value && URL.canParse(value) ? [new URL(value).hostname.toLowerCase()] : []));
  if (listed.includes(host)) return true;
  return [company.domain, ...(company.poppyDomains ?? [])].some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

/**
 * The Poppy endpoint `url` is, or is under, if any: sign-in and token
 * endpoints, the conversation endpoint, the browser-session endpoint and
 * its `/authorize`, feedback. Only the client's own code calls them: a
 * message needs our message id and an honest `author` (8.3, 8.8), and an
 * approval only the User gives (Ops 5). A Company's OpenAPI description may list
 * them too, so a model calling an API operation must never reach one.
 */
export function protocolEndpoint(company: Company, url: URL): string | null {
  const path = (value: URL) => {
    let pathname = value.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Malformed escapes: compare as sent.
    }
    return `${value.origin}${pathname.replace(/\/+$/, "")}`.toLowerCase();
  };
  const target = path(url);
  const endpoints = [
    company.endpoints.token,
    company.endpoints.revocation,
    company.endpoints.authorization,
    company.endpoints.deviceAuthorization,
    company.signIn.mediated?.endpoint,
    company.conversations?.endpoint,
    company.web?.browserSessionEndpoint,
    company.feedback?.endpoint
  ];
  for (const endpoint of endpoints) {
    if (!endpoint || !URL.canParse(endpoint)) continue;
    const base = path(new URL(endpoint));
    if (target === base || target.startsWith(`${base}/`)) return endpoint;
  }
  return null;
}

export function isCompany(value: Company | WebsiteOnly): value is Company {
  return !("websiteOnly" in value);
}
