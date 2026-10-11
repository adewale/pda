import { fetchJson, PoppyFetchError, type Fetcher } from "./fetch";
import { isObject, type Json } from "./json";

/** The only protocol major version this client supports (Draft 0.1). */
export const SUPPORTED_MAJOR = 0;

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

function str(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function httpsUrl(value: Json | undefined, what: string): string {
  const text = str(value);
  if (!text) throw new DiscoveryError(`${what} is missing`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new DiscoveryError(`${what} is not a URL`);
  }
  if (url.protocol !== "https:") throw new DiscoveryError(`${what} must be HTTPS`);
  return url.href;
}

function optionalResource(entry: { [key: string]: Json }): { resource?: string } {
  const resource = str(entry.resource);
  return resource ? { resource } : {};
}

export type Discovered = {
  readonly result: Company | WebsiteOnly;
  /** Seconds both documents may be cached for, bounded. */
  readonly cacheSeconds: number;
};

/**
 * Discovery for one domain (spec 3): fetch `poppy.json`, check its version
 * and `organization.domain`, then fetch the issuer's OAuth metadata and check
 * `issuer` and `poppy_domains` before trusting any of it (3.2).
 */
export async function discover(fetcher: Fetcher, domain: string): Promise<Discovered> {
  const requested = bareHost(domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(requested)) {
    throw new DiscoveryError(`${JSON.stringify(domain)} is not a domain name`);
  }
  let document;
  try {
    // Ask the host the caller named; a leading www. is ignored only when checking.
    const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    document = await fetchJson(fetcher, `https://${host}/.well-known/poppy.json`);
  } catch (error) {
    if (error instanceof PoppyFetchError) throw new DiscoveryError(error.message);
    throw error;
  }
  const doc = document.json;
  if (!isObject(doc)) throw new DiscoveryError("poppy.json is not a JSON object");

  const version = str(doc.protocol_version);
  const match = version ? /^(\d+)\.(\d+)$/.exec(version) : null;
  if (!match) throw new DiscoveryError("protocol_version must be major.minor");
  if (Number(match[1]) !== SUPPORTED_MAJOR) {
    throw new DiscoveryError(
      `poppy.json is protocol version ${version}; this agent supports only ${SUPPORTED_MAJOR}.x`
    );
  }

  const organization = doc.organization;
  if (!isObject(organization)) throw new DiscoveryError("organization is missing");
  const name = str(organization.name) ?? requested;
  const orgDomain = str(organization.domain);
  // The domain we requested must match, whatever host a redirect served it from.
  if (!orgDomain || bareHost(orgDomain) !== requested) {
    throw new DiscoveryError(
      `poppy.json at ${requested} names organization.domain ${JSON.stringify(orgDomain)}`
    );
  }

  const auth = doc.auth;
  if (!isObject(auth)) {
    return {
      result: { websiteOnly: true, name, domain: bareHost(orgDomain) },
      cacheSeconds: boundedCacheSeconds(document.maxAgeSeconds)
    };
  }
  // The issuer is compared as an exact string, never normalised (3.2).
  httpsUrl(auth.issuer, "auth.issuer");
  const issuerText = str(auth.issuer)!;

  // RFC 8414: the metadata lives under the issuer's well-known path.
  const issuerUrl = new URL(issuerText);
  const metadataUrl = `${issuerUrl.origin}/.well-known/oauth-authorization-server${
    issuerUrl.pathname === "/" ? "" : issuerUrl.pathname
  }`;
  let metadataDoc;
  try {
    metadataDoc = await fetchJson(fetcher, metadataUrl);
  } catch (error) {
    if (error instanceof PoppyFetchError) throw new DiscoveryError(error.message);
    throw error;
  }
  const metadata = metadataDoc.json;
  if (!isObject(metadata)) throw new DiscoveryError("OAuth metadata is not a JSON object");
  if (str(metadata.issuer) !== issuerText) {
    throw new DiscoveryError(
      `OAuth metadata issuer ${JSON.stringify(metadata.issuer)} doesn't match auth.issuer ${issuerText}`
    );
  }
  if (!strings(metadata.poppy_domains).map(bareHost).includes(bareHost(orgDomain))) {
    throw new DiscoveryError(`The issuer's poppy_domains doesn't include ${orgDomain}`);
  }

  const signIn: { -readonly [K in keyof Company["signIn"]]: Company["signIn"][K] } = {};
  if (isObject(auth.direct)) signIn.direct = { scopes: strings(auth.direct.scopes) };
  if (isObject(auth.device)) signIn.device = { scopes: strings(auth.device.scopes) };
  if (isObject(auth.mediated)) {
    const fields = Array.isArray(auth.mediated.fields) ? auth.mediated.fields : [];
    signIn.mediated = {
      endpoint: httpsUrl(auth.mediated.endpoint, "auth.mediated.endpoint"),
      fields: fields.filter(isObject).flatMap((field) => {
        const fieldName = str(field.name);
        return fieldName
          ? [{ name: fieldName, label: str(field.label) ?? fieldName, secret: field.secret === true }]
          : [];
      }),
      scopes: strings(auth.mediated.scopes)
    };
  }

  const endpoints = {
    token: httpsUrl(metadata.token_endpoint, "token_endpoint"),
    revocation: httpsUrl(metadata.revocation_endpoint, "revocation_endpoint"),
    ...(signIn.direct
      ? { authorization: httpsUrl(metadata.authorization_endpoint, "authorization_endpoint") }
      : {}),
    ...(signIn.device
      ? {
          deviceAuthorization: httpsUrl(
            metadata.device_authorization_endpoint,
            "device_authorization_endpoint"
          )
        }
      : {})
  };

  const customScopes: Record<string, string> = {};
  if (isObject(auth.custom_scopes)) {
    for (const [scope, description] of Object.entries(auth.custom_scopes)) {
      if (typeof description === "string") customScopes[scope] = description;
    }
  }

  // Conversation protocols: use the first we know; skip unfamiliar types (7.1).
  let conversations: Company["conversations"];
  const agent = doc.agent;
  if (isObject(agent) && Array.isArray(agent.protocols)) {
    const entry = agent.protocols.filter(isObject).find((item) => item.type === "poppy");
    if (entry) {
      conversations = {
        endpoint: httpsUrl(entry.endpoint, "agent.protocols endpoint"),
        ...optionalResource(entry)
      };
    }
  }

  // APIs: skip types we don't recognise (6).
  const apis: Company["apis"][number][] = [];
  if (Array.isArray(doc.apis)) {
    for (const entry of doc.apis.filter(isObject)) {
      if (entry.type !== "openapi" && entry.type !== "mcp") continue;
      apis.push({
        type: entry.type,
        url: httpsUrl(entry.url, `${entry.type} url`),
        description: str(entry.description) ?? "",
        ...optionalResource(entry)
      });
    }
  }

  let web: Company["web"];
  if (isObject(doc.web)) {
    const endpoint = str(doc.web.browser_session_endpoint);
    web = endpoint
      ? { browserSessionEndpoint: httpsUrl(endpoint, "web.browser_session_endpoint") }
      : {};
  }

  // Extensions: keep only those we support, at the version we implement (3.3).
  const extensions: { -readonly [K in keyof Company["extensions"]]: Company["extensions"][K] } = {};
  if (isObject(doc.extensions) && isObject(doc.extensions.operations)) {
    const operations = doc.extensions.operations;
    if (str(operations.version) === SUPPORTED_EXTENSIONS.operations) {
      extensions.operations = {
        endpoint: httpsUrl(operations.endpoint, "operations endpoint"),
        ...optionalResource(operations)
      };
    }
  }

  const ages = [document.maxAgeSeconds, metadataDoc.maxAgeSeconds].filter(
    (age): age is number => age !== null
  );
  return {
    result: {
      issuer: issuerText,
      name,
      domain: bareHost(orgDomain),
      protocolVersion: version!,
      endpoints,
      signIn,
      customScopes,
      ...(conversations ? { conversations } : {}),
      apis,
      ...(web ? { web } : {}),
      extensions
    },
    cacheSeconds: boundedCacheSeconds(ages.length ? Math.min(...ages) : null)
  };
}

export function isCompany(value: Company | WebsiteOnly): value is Company {
  return !("websiteOnly" in value);
}
