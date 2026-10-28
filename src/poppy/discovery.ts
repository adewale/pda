import { summarize, validateCompany, type CompanyReport } from "../validator/index.ts";
import { bareHost } from "../validator/primitives.ts";
import type { Fetcher } from "./fetch";
import { parseIssuer, type Issuer } from "./issuer";
import { FOREIGN_TEXT, type ForeignText } from "../log";
import { protocolRevision, versionAtLeast } from "./protocol-version";

/** Extensions this client supports, with the major version it implements, before 0.3. */
export const SUPPORTED_EXTENSIONS = { operations: "1" } as const;
/** From 0.3: Operations is version 2 (0.3 Ops 2), and Mediated Sign-In an extension (0.3 Mediated Sign-In 2). */
export const SUPPORTED_EXTENSIONS_0_3 = { operations: "2", "mediated-sign-in": "1" } as const;
/** Mediated Sign-In's grant at the token endpoint (0.3 Mediated Sign-In 1). */
export const MEDIATED_GRANT = "https://personalagentprotocol.org/grant/mediated-sign-in";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** What a scope allows, by the Company's own account (0.3 4.7): hints, never the User's approval. */
export type ScopeHint = { readonly changes: "none" | "reversible" | "irreversible"; readonly personalData: boolean };

export type SignInType = "direct" | "device" | "mediated";

export type MediatedField = {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
};

/** Everything a Personal Agent needs about one Company, verified (spec 3). */
export type Company = {
  /** `auth.issuer`: what identifies the Company (3.2). */
  readonly issuer: Issuer;
  readonly name: string;
  /** `organization.domain` of the document this came from. */
  readonly domain: string;
  /** The issuer metadata's `poppy_domains`, lowercased (3.2). Absent from documents cached before it was kept. */
  readonly poppyDomains?: readonly string[];
  readonly protocolVersion: string;
  readonly specificationRevision?: string;
  /** Canonical auth for comparing aliases of the same issuer in 0.2. */
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
    readonly mediated?: {
      /** Where the credentials go: the mediated endpoint before 0.3, the token endpoint from 0.3, as a grant. */
      readonly endpoint: string;
      readonly fields: readonly MediatedField[];
      readonly scopes: readonly string[];
      /** 0.3: an extension grant at the token endpoint (Mediated Sign-In 3), not an endpoint of its own. */
      readonly grant?: true;
    };
  };
  readonly customScopes: Readonly<Record<string, string>>;
  /** 0.3: `auth.scope_hints` (4.7); a `changes` value we don't know is read as irreversible. */
  readonly scopeHints?: Readonly<Record<string, ScopeHint>>;
  /** 0.3: the issuer lists `dpop_signing_alg_values_supported`, so token requests carry a DPoP proof (4.5). */
  readonly dpop?: boolean;
  /** 0.3: the issuer's `protected_resources` (3.2). */
  readonly protectedResources?: readonly string[];
  /** 0.3: where the tasks the Company doesn't offer are listed (9.1). */
  readonly excludedTasks?: { readonly url: string };
  /** The first `poppy` conversation protocol entry, if any. */
  readonly conversations?: { readonly endpoint: string; readonly resource?: string };
  readonly apis: readonly {
    readonly type: "openapi" | "mcp";
    readonly url: string;
    readonly description: string;
    readonly resource?: string;
  }[];
  readonly web?: { readonly browserSessionEndpoint?: string };
  /** Supported extensions only; unknown ones are ignored (3.3). */
  readonly extensions: {
    /** Operations version 1, before 0.3: an endpoint of its own. */
    readonly operations?: { readonly endpoint: string; readonly resource?: string };
    /** Operations version 2, from 0.3: approvals on the request that returned the operation, no endpoint. */
    readonly operationsV2?: true;
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

function optionalResource(entry: Obj): { resource?: string } {
  const resource = str(entry.resource);
  return resource ? { resource } : {};
}

export type Discovered = {
  readonly result: Company | WebsiteOnly;
  /** Seconds both documents may be cached for, bounded. */
  readonly cacheSeconds: number;
  /** The validator's report on both documents. */
  readonly report: CompanyReport;
};

/**
 * Discovery for one domain (spec 3). The validator in `src/validator` fetches
 * poppy.json and the issuer's OAuth metadata and checks both, including
 * `issuer` and `poppy_domains` (3.2). We refuse the Company when the report
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
  const v3 = versionAtLeast(version, "0.3");
  const organization = doc.organization as Obj;
  const orgDomain = versionAtLeast(version, "0.2") ? (organization.domain as string).toLowerCase() : bareHost(organization.domain as string);
  const name = str(organization.name) ?? orgDomain;
  const cacheSeconds = boundedCacheSeconds(checked.maxAgeSeconds);

  // 0.3: the issuer is the one the domain's protected resource metadata names (3.2); auth is optional.
  const auth = isObj(doc.auth) ? doc.auth : v3 ? {} : undefined;
  if (!auth || !isObj(checked.metadata) || (v3 && !checked.issuer)) {
    return { result: { websiteOnly: true, name, domain: orgDomain }, cacheSeconds, report: checked };
  }
  const metadata = checked.metadata;
  const issuer = parseIssuer(v3 ? checked.issuer : auth.issuer);
  // The validator has refused anything else already; this keeps the type honest.
  if (!issuer) throw new DiscoveryError("The issuer isn't an https URL without a query or fragment", checked);

  if (v3) return { result: discovered03(doc, auth, metadata, { issuer, name, domain: orgDomain, version }), cacheSeconds, report: checked };

  const signIn: { -readonly [K in keyof Company["signIn"]]: Company["signIn"][K] } = {};
  if (isObj(auth.direct)) signIn.direct = { scopes: strings(auth.direct.scopes) };
  if (isObj(auth.device)) signIn.device = { scopes: strings(auth.device.scopes) };
  if (isObj(auth.mediated)) {
    signIn.mediated = {
      endpoint: auth.mediated.endpoint as string,
      fields: (auth.mediated.fields as Obj[]).map((field) => ({
        name: field.name as string,
        label: field.label as string,
        secret: field.secret === true
      })),
      scopes: strings(auth.mediated.scopes)
    };
  }

  const endpoints = {
    token: metadata.token_endpoint as string,
    revocation: metadata.revocation_endpoint as string,
    ...(signIn.direct ? { authorization: metadata.authorization_endpoint as string } : {}),
    ...(signIn.device ? { deviceAuthorization: metadata.device_authorization_endpoint as string } : {})
  };

  const customScopes: Record<string, string> = {};
  if (isObj(auth.custom_scopes)) {
    for (const [scope, description] of Object.entries(auth.custom_scopes)) {
      if (typeof description === "string") customScopes[scope] = description;
    }
  }

  // Conversation protocols and APIs: the first we know, skipping unfamiliar types (6, 7.1).
  const { conversations, apis, web } = services(doc, true);

  // Extensions: keep only those we support, at the version we implement (3.3).
  const extensions: { -readonly [K in keyof Company["extensions"]]: Company["extensions"][K] } = {};
  if (isObj(doc.extensions) && isObj(doc.extensions.operations)) {
    const operations = doc.extensions.operations;
    if (operations.version === SUPPORTED_EXTENSIONS.operations) {
      extensions.operations = { endpoint: operations.endpoint as string, ...optionalResource(operations) };
    }
  }

  return {
    result: {
      issuer,
      name,
      domain: orgDomain,
      poppyDomains: strings(metadata.poppy_domains).map((entry) => entry.toLowerCase()),
      protocolVersion: doc.protocol_version as string,
      specificationRevision: protocolRevision(doc.protocol_version as string),
      authFingerprint: canonicalAuth(auth),
      ...(isObj(doc.feedback) && typeof doc.feedback.endpoint === "string" ? { feedback: { endpoint: doc.feedback.endpoint } } : {}),
      endpoints,
      signIn,
      customScopes,
      ...(conversations ? { conversations } : {}),
      apis,
      ...(web ? { web } : {}),
      extensions
    },
    cacheSeconds,
    report: checked
  };
}

/** The parts of poppy.json both versions read the same way: the Company Agent, its APIs and its website. */
function services(doc: Obj, withResources: boolean): Pick<Company, "conversations" | "apis" | "web"> {
  const resource = (entry: Obj) => (withResources ? optionalResource(entry) : {});
  let conversations: Company["conversations"];
  if (isObj(doc.agent) && Array.isArray(doc.agent.protocols)) {
    const entry = doc.agent.protocols.filter(isObj).find((item) => item.type === "poppy");
    if (entry) conversations = { endpoint: entry.endpoint as string, ...resource(entry) };
  }
  const apis: Company["apis"][number][] = [];
  if (Array.isArray(doc.apis)) {
    for (const entry of doc.apis.filter(isObj)) {
      if (entry.type !== "openapi" && entry.type !== "mcp") continue;
      apis.push({ type: entry.type, url: entry.url as string, description: str(entry.description) ?? "", ...resource(entry) });
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
 * A 0.3 Company (3, 3.2): sign-in types from the issuer's
 * `grant_types_supported`, every one able to request any of
 * `scopes_supported` (4.7); scopes described in `auth.scopes`, with
 * `auth.scope_hints`; Mediated Sign-In and Operations 2 from `extensions`.
 * Services name no `resource`: a service's own protected resource metadata
 * says whether it takes only its own tokens (4.5), which apis.ts reads.
 */
function discovered03(doc: Obj, auth: Obj, metadata: Obj, known: { issuer: Issuer; name: string; domain: string; version: string }): Company {
  const grants = strings(metadata.grant_types_supported);
  const supported = strings(metadata.scopes_supported);
  const signIn: { -readonly [K in keyof Company["signIn"]]: Company["signIn"][K] } = {};
  if (grants.includes("authorization_code")) signIn.direct = { scopes: supported };
  if (grants.includes(DEVICE_GRANT)) signIn.device = { scopes: supported };
  const extensions = isObj(doc.extensions) ? doc.extensions : {};
  const mediated = extensions["mediated-sign-in"];
  if (isObj(mediated) && mediated.version === SUPPORTED_EXTENSIONS_0_3["mediated-sign-in"] && grants.includes(MEDIATED_GRANT)) {
    signIn.mediated = {
      endpoint: metadata.token_endpoint as string,
      fields: (Array.isArray(mediated.fields) ? mediated.fields.filter(isObj) : []).map((field) => ({ name: field.name as string, label: field.label as string, secret: field.secret === true })),
      scopes: strings(mediated.scopes).filter((scope) => supported.includes(scope)),
      grant: true
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
    ...services(doc, false),
    extensions: isObj(operations) && operations.version === SUPPORTED_EXTENSIONS_0_3.operations ? { operationsV2: true } : {}
  };
}

function canonicalAuth(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : isObj(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])])) : item;
  return JSON.stringify(sorted(value));
}

/**
 * Whether a host may receive this Company's Session Tokens and DPoP proofs.
 * The draft doesn't say (docs/spec-issues.md, N10), and an OpenAPI
 * description can name any server, so only these do: a host `poppy.json`
 * lists for a service that takes a Session Token, or a host equal to or
 * under `organization.domain` or a `poppy_domains` entry.
 */
export function tokenHostAllowed(company: Company, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const listed = [
    company.conversations?.endpoint,
    company.extensions.operations?.endpoint,
    company.signIn.mediated?.endpoint,
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
 * endpoints, the conversation and operations endpoints, the browser-session
 * endpoint. Only the client's own code calls them: confirming an operation
 * is the User's decision (Ops 5.1), and a message needs our message id and
 * an honest `sender` (7.3, 7.8). A Company's OpenAPI description may list
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
    company.extensions.operations?.endpoint,
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
