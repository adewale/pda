/** OpenAPI discovery, document caches, operation descriptions and scope metadata. */
import { type Json, isObject, toJson } from "./json";
import { type SchemaDraft, resolveRef, foldNullable, inlineRefs, jsonBodyOf, pointerPart } from "./api-schema";
import { PoppyClient, PoppyError } from "./client";
import { type Company, boundedCacheSeconds } from "./discovery";
import { type Api, findApi } from "./api-authority";
import { fetchJson } from "./fetch";
import { type ApprovalV2 } from "./operations-v2";

// ---------------------------------------------------------------- OpenAPI

export type OpenApiOperation = {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly parameters: readonly { name: string; in: string; required: boolean; schema?: Json; description?: string }[];
  readonly requestBody?: Json;
  /** A `multipart/form-data` request body: its file fields, its other fields, and whether JSON is accepted too. */
  readonly upload?: Upload;
  readonly acceptsIdempotencyKey: boolean;
  /** Scopes its first security requirement names, the operation's own or the document's. */
  readonly scopes: readonly string[];
  /**
   * A write the description doesn't protect with the Company's Poppy Session:
   * the description declares a DPoP security scheme, and this operation's
   * security requirements don't name it (a sign-in, session, token or
   * compatibility endpoint, say). The agent never calls one.
   */
  readonly outsidePoppy: boolean;
  /** Where its JSON request body's schema is, to check a body against before a card or a request. */
  readonly jsonBody?: JsonBody;
  /** How its parameters' schemas read: OpenAPI 3.0's as draft 4 (`nullable` folded in), 3.1's as 2020-12. */
  readonly schemaDraft: SchemaDraft;
};

/** An operation's `application/json` request body: whether it's required, and its schema's place in the description. */
export type JsonBody = { readonly required: boolean; readonly root: Json; readonly pointer: string; readonly draft: "4" | "2020-12" };

/**
 * What an operation's `multipart/form-data` request body takes: `files`, the
 * fields that carry a file (`format: binary` in OpenAPI 3.0, or a
 * `contentMediaType` in 3.1, alone or as an array's items), and `fields`, the
 * others, sent as text. `json` says the operation takes JSON too.
 */
export type Upload = {
  readonly files: readonly string[];
  readonly fields: readonly string[];
  readonly required: readonly string[];
  readonly json: boolean;
};

function isBinary(schema: Json): boolean {
  if (!isObject(schema)) return false;
  if (schema.type === "array") return isBinary(schema.items ?? null);
  return (schema.type === "string" || schema.type === undefined) && (schema.format === "binary" || typeof schema.contentMediaType === "string");
}

/** The upload a request body describes, if it takes `multipart/form-data`. */
export function uploadOf(root: Json, requestBody: Json | undefined): Upload | undefined {
  if (!isObject(requestBody) || !isObject(requestBody.content)) return undefined;
  const multipart = requestBody.content["multipart/form-data"];
  if (!isObject(multipart)) return undefined;
  const schema = resolveRef(root, multipart.schema ?? null);
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
  const files: string[] = [];
  const fields: string[] = [];
  for (const [name, property] of Object.entries(properties)) (isBinary(resolveRef(root, property)) ? files : fields).push(name);
  const required = isObject(schema) && Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  return { files, fields, required, json: isObject(requestBody.content["application/json"]) };
}

/** The scopes of the first security requirement: `[{ scheme: [scopes] }]`. */
function declaredScopes(security: Json | undefined): string[] {
  if (!Array.isArray(security) || !isObject(security[0])) return [];
  return Object.values(security[0]).flatMap((scopes) =>
    Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : []
  );
}

/**
 * The description's security schemes that take the Company's access token:
 * OAuth 2.0 schemes and HTTP `Bearer` or `DPoP` schemes (spec 7: "Every
 * listed API MUST accept the Session header (5.2) and the Company's access
 * tokens (4.5)"). An HTTP authentication scheme's name is case-insensitive
 * (RFC 9110 11.1).
 */
export function tokenSchemes(root: Json): Set<string> {
  const schemes = isObject(root) && isObject(root.components) && isObject(root.components.securitySchemes) ? root.components.securitySchemes : {};
  const names = new Set<string>();
  for (const [name, value] of Object.entries(schemes)) {
    const scheme = resolveRef(root, value);
    if (!isObject(scheme)) continue;
    const http = scheme.type === "http" && typeof scheme.scheme === "string" && /^(bearer|dpop)$/i.test(scheme.scheme);
    if (scheme.type === "oauth2" || http) names.add(name);
  }
  return names;
}

/**
 * Whether a write is outside the Company's Poppy Session: the description
 * declares a token scheme, and none of the operation's security requirements
 * (its own `security`, or else the document's) names it. No requirement, or
 * `security: []`, is a write that takes no access token; a requirement of
 * another scheme alone (an API key, a cookie from the Company's own sign-in)
 * is another way in. Either is the Company's own authentication, not Poppy,
 * and the agent's only access is its Poppy Session (our reading,
 * docs/readings.md). A description that declares no token scheme says
 * nothing either way: there every operation is called with the Session
 * header and any token, as spec 7 says every listed API accepts them. Reads
 * are never outside: a public catalog is a GET with no security.
 */
export function outsidePoppySession(tokens: ReadonlySet<string>, method: string, security: Json | undefined): boolean {
  if (tokens.size === 0 || method === "GET" || method === "HEAD") return false;
  if (!Array.isArray(security)) return true;
  return !security.some((requirement) => isObject(requirement) && Object.keys(requirement).some((name) => tokens.has(name)));
}

type OpenApiDocument = {
  readonly base: string;
  readonly operations: readonly OpenApiOperation[];
  /** The description of each scope its OAuth 2.0 security schemes name (4.7: one place a Company describes its scopes). */
  readonly scopes: Readonly<Record<string, string>>;
};

/** The scopes an OpenAPI description's OAuth 2.0 schemes describe, from every flow. */
function oauthScopes(root: Json): Record<string, string> {
  const schemes = isObject(root) && isObject(root.components) && isObject(root.components.securitySchemes) ? root.components.securitySchemes : {};
  const found: Record<string, string> = {};
  for (const value of Object.values(schemes)) {
    const scheme = resolveRef(root, value);
    if (!isObject(scheme) || scheme.type !== "oauth2" || !isObject(scheme.flows)) continue;
    for (const flow of Object.values(scheme.flows)) {
      if (!isObject(flow) || !isObject(flow.scopes)) continue;
      for (const [scope, description] of Object.entries(flow.scopes)) {
        if (typeof description === "string" && !(scope in found)) found[scope] = description.slice(0, 500);
      }
    }
  }
  return found;
}

/**
 * Descriptions of the Company's scopes from the OpenAPI descriptions it
 * lists (4.7). A description that can't be read describes nothing; sign-in
 * goes on with `auth.scopes` and the scopes' own names.
 */
export async function openApiScopeDescriptions(client: PoppyClient, company: Company): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const api of company.apis) {
    if (api.type !== "openapi") continue;
    const document = await openApi(client, api).catch(() => null);
    for (const [scope, description] of Object.entries(document?.scopes ?? {})) if (!(scope in found)) found[scope] = description;
  }
  return found;
}

/**
 * Header parameters the client sets itself, never the model. OpenAPI 3.x
 * says an `Accept`, `Content-Type` or `Authorization` header parameter
 * "SHALL be ignored"; `Poppy-Session` and `DPoP` are made fresh for each
 * request (5.2, RFC 9449), and `Poppy-Approval` is the User's approval,
 * which only our approval card adds. A description that lists one, even as required (as
 * print-with-poppy's did from c147418 to cecb32f), describes the transport,
 * not an argument: kept, a required one would refuse every call.
 */
const TRANSPORT_HEADERS = /^(accept|content-type|authorization|dpop|poppy-session|poppy-approval)$/i;

/**
 * Header parameters the agent never sends for the model, whatever a
 * description says: the platform's or the transport's own (hop-by-hop,
 * framing, cookies, origin, proxies, MCP's session headers). A description
 * that lists one is ignored for it, as for `TRANSPORT_HEADERS`.
 */
const RESERVED_HEADERS =
  /^(host|cookie|set-cookie|content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer|origin|referer|forwarded|via|proxy-.*|sec-.*|x-forwarded-.*|mcp-.*)$/i;

/**
 * Descriptions by URL, per agent: an agent never reads another's cache, so
 * two agents in one isolate (or one process, as the interop adapter runs
 * one per cell) can't see a description the other fetched.
 */
const documentCaches = new WeakMap<PoppyClient, Map<string, { document: OpenApiDocument; expiresAt: number }>>();

/** Every description read, by URL, only so the protocol log can name a call (`apiOperationFor`); nothing acts on it. */
const namedDocuments = new Map<string, OpenApiDocument>();

function documentsOf(client: PoppyClient): Map<string, { document: OpenApiDocument; expiresAt: number }> {
  let documents = documentCaches.get(client);
  if (!documents) documentCaches.set(client, (documents = new Map()));
  return documents;
}

/** The API's OpenAPI 3.0/3.1 description, fetched safely and cached. */
export async function openApi(client: PoppyClient, api: Api): Promise<OpenApiDocument> {
  const documents = documentsOf(client);
  const cached = documents.get(api.url);
  if (cached && cached.expiresAt > Date.now()) return cached.document;
  const { json, finalUrl, maxAgeSeconds } = await fetchJson(client.host.fetcher, api.url, { maxBytes: 1_000_000 });
  if (!isObject(json) || typeof json.openapi !== "string" || !/^3\.[01]\./.test(json.openapi)) {
    throw new PoppyError("bad_api", "The API description isn't OpenAPI 3.0 or 3.1", 0);
  }
  const server = Array.isArray(json.servers) && isObject(json.servers[0]) && typeof json.servers[0].url === "string" ? json.servers[0].url : "/";
  const base = new URL(server, finalUrl).href.replace(/\/+$/, "");
  const operations: OpenApiOperation[] = [];
  const tokens = tokenSchemes(json);
  const v30 = json.openapi.startsWith("3.0.");
  // A parameter's schema, written out (so poppy_api_describe shows it) and read as its version's JSON Schema.
  const parameterSchema = (schema: Json) => (v30 ? foldNullable(inlineRefs(json, schema)) : inlineRefs(json, schema));
  if (isObject(json.paths)) {
    for (const [path, item] of Object.entries(json.paths)) {
      if (!isObject(item)) continue;
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const op = item[method];
        if (!isObject(op)) continue;
        const parameters = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]
          .map((parameter) => resolveRef(json, parameter))
          .filter(isObject)
          .flatMap((parameter) =>
            typeof parameter.name === "string" && typeof parameter.in === "string"
              ? [{
                  name: parameter.name,
                  in: parameter.in,
                  required: parameter.required === true,
                  ...(parameter.schema !== undefined ? { schema: parameterSchema(parameter.schema) } : {}),
                  ...(typeof parameter.description === "string" ? { description: parameter.description } : {})
                }]
              : []
          );
        const requestBody = op.requestBody !== undefined ? resolveRef(json, op.requestBody) : undefined;
        const upload = uploadOf(json, requestBody);
        const jsonBody = jsonBodyOf(json, op.requestBody, requestBody, `/paths/${pointerPart(path)}/${method}/requestBody`);
        operations.push({
          operationId: typeof op.operationId === "string" ? op.operationId : `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          summary: [op.summary, op.description].filter((text) => typeof text === "string").join(" — "),
          parameters: parameters.filter(
            (parameter) =>
              !(
                parameter.in === "header" &&
                (/^idempotency-key$/i.test(parameter.name) || TRANSPORT_HEADERS.test(parameter.name) || RESERVED_HEADERS.test(parameter.name))
              )
          ),
          // Written out, so poppy_api_describe shows the fields to send, not a bare $ref.
          ...(requestBody !== undefined ? { requestBody: inlineRefs(json, requestBody) } : {}),
          ...(upload ? { upload } : {}),
          acceptsIdempotencyKey: parameters.some((parameter) => parameter.in === "header" && /^idempotency-key$/i.test(parameter.name)),
          scopes: declaredScopes(op.security ?? json.security),
          outsidePoppy: outsidePoppySession(tokens, method.toUpperCase(), op.security ?? json.security),
          ...(jsonBody ? { jsonBody } : {}),
          schemaDraft: v30 ? "4" : "2020-12"
        });
      }
    }
  }
  const document = { base, operations, scopes: oauthScopes(json) };
  documents.set(api.url, { document, expiresAt: Date.now() + boundedCacheSeconds(maxAgeSeconds) * 1000 });
  namedDocuments.set(api.url, document);
  return document;
}

export function findOperation(document: OpenApiDocument, name: string): OpenApiOperation {
  const found = document.operations.find((op) => op.operationId === name || `${op.method} ${op.path}` === name);
  if (!found) throw new PoppyError("no_operation", `The API has no operation ${name}`, 0);
  return found;
}

/** What `poppy_api_describe` says of a write outside the Poppy Session, so the model doesn't plan around it. */
const OUTSIDE_POPPY =
  "Not usable: the Company's description doesn't protect this write with its Poppy Session (an OAuth, Bearer or DPoP scheme), so it is the Company's own way in (a sign-in, session, token or compatibility endpoint), which the agent never uses. Its only access is its Poppy Session; signing in goes through poppy_sign_in.";

/** A compact description of an API's operations, or one operation's inputs. */
export async function describeOpenApi(client: PoppyClient, company: Company, apiUrl: string | undefined, name?: string): Promise<Json> {
  const api = findApi(company, "openapi", apiUrl);
  const document = await openApi(client, api);
  if (!name) {
    return {
      api: api.url,
      description: api.description,
      operations: document.operations.map((op) => ({
        operation: op.operationId,
        method: op.method,
        path: op.path,
        summary: op.summary,
        ...(op.outsidePoppy ? { usable: false, note: OUTSIDE_POPPY } : {})
      }))
    };
  }
  const op = findOperation(document, name);
  return {
    operation: op.operationId,
    method: op.method,
    path: op.path,
    summary: op.summary,
    ...(op.outsidePoppy ? { usable: false, note: OUTSIDE_POPPY } : {}),
    parameters: toJson(op.parameters),
    ...(op.requestBody !== undefined ? { requestBody: op.requestBody } : {}),
    ...(op.upload
      ? {
          upload: {
            files: [...op.upload.files],
            fields: [...op.upload.fields],
            note: "A multipart/form-data upload. Give each file field the id of a photo the User attached (att_…) in files, and other fields in body. The User approves sending the file on a card first."
          }
        }
      : {})
  };
}

/** An OpenAPI call as the model asked for it, and as an approval stores it. */
export type OpenApiCall = {
  readonly apiUrl: string;
  /** The operation revision the User approved, sent as `Poppy-Approval` (Ops 6). */
  readonly approval?: ApprovalV2;
  /** The operation's `operationId`, or `METHOD /path` when it has none. */
  readonly operation: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly body?: Json;
  /** File fields of a `multipart/form-data` upload, each an attachment id; never the bytes. */
  readonly files?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
};

// ---------------------------------------------------------------- The protocol log

/**
 * The OpenAPI operation a request is for, from the descriptions already
 * cached: its operationId, path template and server. The protocol log
 * (protocol-log.ts) names a call by these rather than its filled-in path.
 */
export function apiOperationFor(method: string, url: URL): { operation: string; path: string; base: string } | null {
  const target = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  for (const document of namedDocuments.values()) {
    for (const op of document.operations) {
      if (op.method !== method.toUpperCase()) continue;
      const pattern = `${document.base}${op.path}`
        .replace(/\/+$/, "")
        .split(/\{[^}/]+\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+");
      if (new RegExp(`^${pattern}$`).test(target)) return { operation: op.operationId, path: op.path, base: document.base };
    }
  }
  return null;
}
