import { summarize, validateCompany, type CompanyReport } from "../validator/index.ts";
import type { Fetcher } from "./fetch";
import { parseIssuer, type Issuer } from "./issuer";
import { FOREIGN_TEXT, type ForeignText } from "../log";
import { PROTOCOL_VERSIONS, protocolRevision } from "./protocol-version";

/**
 * Extensions this client supports under each protocol version, with the
 * major version it implements (3.3): under 0.4, Operations 3, Mediated
 * Sign-In 1 and Browser Control 1.
 */
export const SUPPORTED_EXTENSIONS: Readonly<Record<string, { readonly operations: string; readonly "mediated-sign-in": string; readonly "browser-control"?: string }>> = {
  "0.4": { operations: "3", "mediated-sign-in": "1", "browser-control": "1" }
};
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
  /**
   * The Company's identifier (3.2), which keys everything we hold for it
   * (User IDs, Sessions, accounts) and is the `aud` of its Session JWTs:
   * the issuer the domain's protected resource metadata names, or, for a
   * Company without one (`issuerless`), `https://{organization.domain}`
   * with the host in lowercase.
   */
  readonly issuer: Issuer;
  /**
   * The domain's protected resource metadata says the Company has no OAuth
   * issuer (3.2): signed-out Sessions only, no sign-in and no endpoints.
   */
  readonly issuerless?: true;
  readonly name: string;
  /** `organization.domain` of the document this came from. */
  readonly domain: string;
  /** `organization.logo_uri` (3.1): an HTTPS URL the agent fetches itself (logo.ts), never the User's device. */
  readonly logoUri?: string;
  /**
   * The hosts of the issuer's `protected_resources`, lowercased (3.2): where
   * tokens and Session JWTs may go beside `organization.domain`, and where a
   * device sign-in link may point (4.3).
   */
  readonly poppyDomains?: readonly string[];
  readonly protocolVersion: string;
  readonly specificationRevision?: string;
  /** Canonical `auth`, so cached state keyed by Company notices when the document's `auth` changes. */
  readonly authFingerprint?: string;
  /** `tasks.endpoint` (9): excluded tasks, the skill index and feedback, for each Session. */
  readonly tasks?: { readonly endpoint: string };
  /** The issuer's endpoints; absent for a Company without an issuer (3.2). */
  readonly endpoints?: {
    readonly token: string;
    readonly revocation: string;
    readonly authorization?: string;
    readonly deviceAuthorization?: string;
  };
  readonly signIn: {
    /**
     * `scopes` is the issuer's `scopes_supported`, or, when it publishes
     * none (a SHOULD, 3.2), the scopes `auth.scopes` describes. Scopes the
     * Company documents may be requested beyond this list (4.7; signin.ts).
     */
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
  /** The first `poppy` conversation protocol entry, if any. */
  readonly conversations?: { readonly endpoint: string };
  readonly apis: readonly {
    readonly type: "openapi" | "mcp";
    readonly url: string;
    readonly description: string;
  }[];
  readonly web?: {
    readonly browserSessionEndpoint?: string;
    /** 0.4's `web.disabled` (6): the Company asks Personal Agents not to use a browser on its website. */
    readonly disabled?: true;
    /** 0.4's `web.unscoped` (6): `poppy:browser-sign-in` gives a joined browser the account's full access. */
    readonly unscoped?: true;
  };
  /** Supported extensions only; unknown ones are ignored (3.3). */
  readonly extensions: {
    /** Operations 3 (SUPPORTED_EXTENSIONS). */
    readonly operations?: true;
    /** Operations 3's `endpoint` (Ops 2): where operations a website returned are fetched and approved. */
    readonly operationsEndpoint?: string;
    /** Browser Control 1, listed with a browser-session endpoint, as it must be (3). */
    readonly browserControl?: true;
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

/** The one scope 0.4 defines: the agent's browser joins signed in (6). */
export const BROWSER_SIGN_IN = "poppy:browser-sign-in";

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
export async function discover(fetcher: Fetcher, domain: string, versions: readonly string[] = PROTOCOL_VERSIONS): Promise<Discovered> {
  // 3.4: the newest version both sides speak, from poppy.json or a document its supported_versions links.
  const checked = await validateCompany(fetcher, domain, { versions });
  if (checked.refused || checked.outcome === "indeterminate" || !isObj(checked.poppy)) {
    throw new DiscoveryError(summarize(checked) || "poppy.json couldn't be used", checked);
  }
  const doc = checked.poppy;
  const version = doc.protocol_version as string;
  const organization = doc.organization as Obj;
  const orgDomain = (organization.domain as string).toLowerCase();
  const name = str(organization.name) ?? orgDomain;
  const cacheSeconds = boundedCacheSeconds(checked.maxAgeSeconds);
  // 3.2: a Company without an issuer offers signed-out Sessions, identified by its domain.
  // The validator settles an identifier only for a document that lists something using Sessions, as for one with an issuer.
  if (checked.issuerless && checked.identifier) {
    const identifier = parseIssuer(checked.identifier);
    if (identifier) return { result: company(doc, isObj(doc.auth) ? doc.auth : {}, null, null, { issuer: identifier, name, domain: orgDomain, version }), cacheSeconds, report: checked };
  }
  // The issuer is the one the domain's protected resource metadata names (3.2); `auth` is optional.
  if (!isObj(checked.metadata) || !checked.issuer) {
    return { result: { websiteOnly: true, name, domain: orgDomain }, cacheSeconds, report: checked };
  }
  const issuer = parseIssuer(checked.issuer);
  // The validator has refused anything else already; this keeps the type honest.
  if (!issuer) throw new DiscoveryError("The issuer isn't an https URL without a query or fragment", checked);
  const resource = isObj(checked.protectedResource) ? checked.protectedResource : null;
  return { result: company(doc, isObj(doc.auth) ? doc.auth : {}, checked.metadata, resource, { issuer, name, domain: orgDomain, version }), cacheSeconds, report: checked };
}

/** The Company Agent, its APIs and its website, skipping types we don't know (7, 8.1); `web.disabled` and `web.unscoped` under 0.4 (6). */
function services(doc: Obj, version: string): Pick<Company, "conversations" | "apis" | "web"> {
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
    web = {
      ...(endpoint ? { browserSessionEndpoint: endpoint } : {}),
      ...(doc.web.disabled === true ? { disabled: true as const } : {}),
      ...(doc.web.unscoped === true ? { unscoped: true as const } : {})
    };
  }
  return { ...(conversations ? { conversations } : {}), apis, ...(web ? { web } : {}) };
}

/**
 * A Company (3, 3.2): sign-in types from the issuer's
 * `grant_types_supported`, none when `auth.disabled` is set or there is no
 * issuer (`metadata` null); scopes described in `auth.scopes`, with
 * `auth.scope_hints`; Mediated Sign-In and Operations from `extensions`,
 * in the versions SUPPORTED_EXTENSIONS gives for the protocol version,
 * and `tasks.endpoint` (9).
 * Services name no `resource`: a service's own protected resource metadata
 * says whether it takes only its own tokens (4.5), which the client reads.
 */
function company(doc: Obj, auth: Obj, metadata: Obj | null, resource: Obj | null, known: { issuer: Issuer; name: string; domain: string; version: string }): Company {
  const grants = metadata ? strings(metadata.grant_types_supported) : [];
  // 3.2, 4.7: the domain's protected resource metadata may list scopes too, and the agent uses either list.
  const resourceListed = !!resource && Array.isArray(resource.scopes_supported);
  const supported = [...new Set([...(metadata ? strings(metadata.scopes_supported) : []), ...(resourceListed ? strings(resource!.scopes_supported) : [])])];
  // 3.2: scopes_supported is a SHOULD; without it, the Company's documented scopes may be requested (4.7).
  const listed = (!!metadata && Array.isArray(metadata.scopes_supported)) || resourceListed;
  const documented = isObj(auth.scopes) ? Object.keys(auth.scopes) : [];
  const offer = { scopes: listed ? supported : documented };
  // 3.2: with auth.disabled, a Personal Agent MUST NOT start Direct, Device or Mediated Sign-In.
  const disabled = auth.disabled === true;
  const signIn: { -readonly [K in keyof Company["signIn"]]: Company["signIn"][K] } = {};
  if (!disabled && grants.includes("authorization_code")) signIn.direct = offer;
  if (!disabled && grants.includes(DEVICE_GRANT)) signIn.device = offer;
  const supportedExtensions = SUPPORTED_EXTENSIONS[known.version];
  const extensions = isObj(doc.extensions) ? doc.extensions : {};
  // 3.3: an entry for each major version of an extension.
  const entry = (name: "operations" | "mediated-sign-in" | "browser-control"): Obj | undefined => {
    const want = supportedExtensions?.[name];
    const listed = extensions[name];
    const entries = Array.isArray(listed) ? listed : [];
    return entries.filter(isObj).find((item) => item.version === want);
  };
  const mediated = entry("mediated-sign-in");
  if (metadata && !disabled && mediated && grants.includes(MEDIATED_GRANT)) {
    signIn.mediated = {
      endpoint: metadata.token_endpoint as string,
      fields: (Array.isArray(mediated.fields) ? mediated.fields.filter(isObj) : []).map((field) => ({ name: field.name as string, label: field.label as string, secret: field.secret === true })),
      scopes: strings(mediated.scopes).filter((scope) => !listed || supported.includes(scope))
    };
  }
  // Built from entries, so a scope named like an inherited member (`__proto__`) is a member like any other.
  const customScopes: Record<string, string> = Object.fromEntries(
    Object.entries(isObj(auth.scopes) ? auth.scopes : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const scopeHints: Record<string, ScopeHint> = Object.fromEntries(
    Object.entries(isObj(auth.scope_hints) ? auth.scope_hints : {}).flatMap(([scope, hint]): [string, ScopeHint][] => {
      if (!isObj(hint) || typeof hint.personal_data !== "boolean") return [];
      // 4.7: a changes value it doesn't recognize is irreversible.
      const changes = hint.changes === "none" || hint.changes === "reversible" ? hint.changes : "irreversible";
      return [[scope, { changes, personalData: hint.personal_data }]];
    })
  );
  const protectedResources = metadata ? strings(metadata.protected_resources) : [];
  const operations = entry("operations");
  const operationsEndpoint = str(operations?.endpoint);
  const tasks = isObj(doc.tasks) ? str(doc.tasks.endpoint) : undefined;
  const organization = isObj(doc.organization) ? doc.organization : {};
  const logo = str(organization.logo_uri);
  return {
    issuer: known.issuer,
    ...(metadata ? {} : { issuerless: true as const }),
    ...(logo && URL.canParse(logo) && new URL(logo).protocol === "https:" ? { logoUri: logo } : {}),
    name: known.name,
    domain: known.domain,
    // Hosts that may receive Session JWTs and show a device link (4.3): the issuer's protected resources.
    poppyDomains: protectedResources.flatMap((entry) => (URL.canParse(entry) ? [new URL(entry).hostname.toLowerCase()] : [])),
    protocolVersion: known.version,
    specificationRevision: protocolRevision(known.version),
    authFingerprint: canonicalAuth(doc.auth ?? null),
    ...(tasks ? { tasks: { endpoint: tasks } } : {}),
    ...(metadata ? {
      endpoints: {
        token: metadata.token_endpoint as string,
        revocation: metadata.revocation_endpoint as string,
        ...(signIn.direct ? { authorization: metadata.authorization_endpoint as string } : {}),
        ...(signIn.device ? { deviceAuthorization: metadata.device_authorization_endpoint as string } : {})
      }
    } : {}),
    signIn,
    customScopes,
    scopeHints,
    dpop: !!metadata && Array.isArray(metadata.dpop_signing_alg_values_supported) && metadata.dpop_signing_alg_values_supported.includes("ES256"),
    protectedResources,
    ...services(doc, known.version),
    extensions: {
      ...(operations ? { operations: true as const, ...(operationsEndpoint ? { operationsEndpoint } : {}) } : {}),
      ...(entry("browser-control") && isObj(doc.web) && typeof doc.web.browser_session_endpoint === "string" ? { browserControl: true as const } : {})
    }
  };
}

function canonicalAuth(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : isObj(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])])) : item;
  return JSON.stringify(sorted(value));
}

/**
 * Whether a host may receive this Company's access tokens, Session JWTs
 * and DPoP proofs. The draft doesn't say (docs/history/spec-issues.md, N10), and an
 * OpenAPI description can name any server, so only these do: a host
 * `poppy.json` lists for a service, or a host equal to or under
 * `organization.domain` or a URL in the issuer's `protected_resources`.
 */
export function tokenHostAllowed(company: Company, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const listed = [
    company.conversations?.endpoint,
    company.web?.browserSessionEndpoint,
    company.tasks?.endpoint,
    company.extensions.operationsEndpoint,
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
 * its `/authorize`, the tasks endpoint and the operations
 * endpoint. Only the client's own code calls them: a message needs our
 * message id and an honest `author` (8.3, 8.8), and an approval only the
 * User gives (Ops 5). A Company's OpenAPI description may list
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
    company.endpoints?.token,
    company.endpoints?.revocation,
    company.endpoints?.authorization,
    company.endpoints?.deviceAuthorization,
    company.signIn.mediated?.endpoint,
    company.conversations?.endpoint,
    company.web?.browserSessionEndpoint,
    company.tasks?.endpoint,
    company.extensions.operationsEndpoint
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
