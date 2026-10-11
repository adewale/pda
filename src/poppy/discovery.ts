import { summarize, validateCompany } from "../validator/index.ts";
import type { Fetcher } from "./fetch";

/** Extensions this client supports, with the major version it implements. */
export const SUPPORTED_EXTENSIONS = { operations: "1" } as const;

export type SignInType = "direct" | "device" | "mediated";

export type MediatedField = {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
};

/** Everything a Personal Agent needs about one Company, verified (spec 3). */
export type Company = {
  /** `auth.issuer`: what identifies the Company (3.2). */
  readonly issuer: string;
  readonly name: string;
  /** `organization.domain` of the document this came from. */
  readonly domain: string;
  /** The issuer metadata's `poppy_domains`, lowercased (3.2). Absent from documents cached before it was kept. */
  readonly poppyDomains?: readonly string[];
  readonly protocolVersion: string;
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
      readonly endpoint: string;
      readonly fields: readonly MediatedField[];
      readonly scopes: readonly string[];
    };
  };
  readonly customScopes: Readonly<Record<string, string>>;
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
    readonly operations?: { readonly endpoint: string; readonly resource?: string };
  };
};

/** A domain the Company can be browsed at but has no `auth`: website only (3.1). */
export type WebsiteOnly = {
  readonly websiteOnly: true;
  readonly name: string;
  readonly domain: string;
};

export class DiscoveryError extends Error {
  override name = "DiscoveryError";
}

const CACHE_MIN_SECONDS = 60;
const CACHE_MAX_SECONDS = 24 * 60 * 60;

/** Cache lifetime bounded to between a minute and a day (Guides). */
export function boundedCacheSeconds(seconds: number | null): number {
  if (seconds === null) return CACHE_MIN_SECONDS;
  return Math.min(CACHE_MAX_SECONDS, Math.max(CACHE_MIN_SECONDS, seconds));
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
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
};

/**
 * Discovery for one domain (spec 3). The validator in `src/validator` fetches
 * poppy.json and the issuer's OAuth metadata and checks both, including
 * `issuer` and `poppy_domains` (3.2). We ingest only documents it calls
 * valid: any MUST broken, or a document that couldn't be fetched, and we
 * refuse the Company. What follows reads fields the validator has checked.
 */
export async function discover(fetcher: Fetcher, domain: string): Promise<Discovered> {
  const checked = await validateCompany(fetcher, domain);
  if (checked.outcome !== "valid" || !isObj(checked.poppy)) {
    throw new DiscoveryError(summarize(checked) || "poppy.json couldn't be used");
  }
  const doc = checked.poppy;
  const organization = doc.organization as Obj;
  const orgDomain = bareHost(organization.domain as string);
  const name = str(organization.name) ?? orgDomain;
  const cacheSeconds = boundedCacheSeconds(checked.maxAgeSeconds);

  const auth = doc.auth;
  if (!isObj(auth) || !isObj(checked.metadata)) {
    return { result: { websiteOnly: true, name, domain: orgDomain }, cacheSeconds };
  }
  const metadata = checked.metadata;
  const issuer = auth.issuer as string;

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

  // Conversation protocols: use the first we know; skip unfamiliar types (7.1).
  let conversations: Company["conversations"];
  if (isObj(doc.agent) && Array.isArray(doc.agent.protocols)) {
    const entry = doc.agent.protocols.filter(isObj).find((item) => item.type === "poppy");
    if (entry) conversations = { endpoint: entry.endpoint as string, ...optionalResource(entry) };
  }

  // APIs: skip types we don't recognise (6).
  const apis: Company["apis"][number][] = [];
  if (Array.isArray(doc.apis)) {
    for (const entry of doc.apis.filter(isObj)) {
      if (entry.type !== "openapi" && entry.type !== "mcp") continue;
      apis.push({
        type: entry.type,
        url: entry.url as string,
        description: str(entry.description) ?? "",
        ...optionalResource(entry)
      });
    }
  }

  let web: Company["web"];
  if (isObj(doc.web)) {
    const endpoint = str(doc.web.browser_session_endpoint);
    web = endpoint ? { browserSessionEndpoint: endpoint } : {};
  }

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
      endpoints,
      signIn,
      customScopes,
      ...(conversations ? { conversations } : {}),
      apis,
      ...(web ? { web } : {}),
      extensions
    },
    cacheSeconds
  };
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
    company.web?.browserSessionEndpoint
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
