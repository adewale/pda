import { Validator, type OutputUnit } from "@cfworker/json-schema";
import { attachmentInfo, humanSize, readAttachment, type AttachmentInfo } from "../attachments";
import { PoppyClient, PoppyError, scopeSet, withAnswer } from "./client";
import { boundedCacheSeconds, protocolEndpoint, tokenHostAllowed, type Company } from "./discovery";
import { fetchJson } from "./fetch";
import { isObject, parseStrictJson, toJson, type Json } from "./json";
import { handleProposal, proposeLocal, refuseWhileConfirming, registerExecutor, rememberProposal } from "./operations";
import type { Operation } from "./operation-value";
import { randomId } from "./jwt";
import { EndpointRequest, type RequestInit } from "./outgoing";
import { firstTime, intent, type Sql } from "./store";
import { companyErrorCode } from "./error-codes";

type Api = Company["apis"][number];

export function findApi(company: Company, type: Api["type"], url?: string): Api {
  const matches = company.apis.filter((api) => api.type === type && (!url || api.url === url));
  if (matches.length === 0) throw new PoppyError("no_api", `${company.name} lists no ${type} API${url ? ` at ${url}` : ""}`, 0);
  return matches[0]!;
}

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
  /**
   * The description says the operation answers with a proposal (Ops 4.1): a
   * `202` response whose JSON body has an `operation`. Only such a write goes
   * to a Company with the Operations extension without our own card first.
   */
  readonly proposes: boolean;
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
type JsonBody = { readonly required: boolean; readonly root: Json; readonly pointer: string; readonly draft: "4" | "2020-12" };

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

/**
 * Whether an OpenAPI operation says it answers with Operations' proposal, as
 * Ops 4.1 asks ("The Company SHOULD say in its OpenAPI description which
 * endpoints return operations", with no marker defined: S22): a `202` whose
 * `application/json` schema has an `operation` property, or poppyseed's
 * `x-poppy-operation: true`. A bare 202 isn't enough: "Accepted" also means
 * a job that will act without asking.
 */
export function proposesOperation(root: Json, op: Json): boolean {
  if (!isObject(op)) return false;
  if (op["x-poppy-operation"] === true) return true;
  if (!isObject(op.responses ?? null)) return false;
  const accepted = resolveRef(root, (op.responses as Record<string, Json>)["202"] ?? null);
  if (!isObject(accepted) || !isObject(accepted.content)) return false;
  const body = accepted.content["application/json"];
  const schema = isObject(body) ? resolveRef(root, body.schema ?? null) : null;
  return isObject(schema) && isObject(schema.properties) && schema.properties.operation !== undefined;
}

/** The scopes of the first security requirement: `[{ scheme: [scopes] }]`. */
function declaredScopes(security: Json | undefined): string[] {
  if (!Array.isArray(security) || !isObject(security[0])) return [];
  return Object.values(security[0]).flatMap((scopes) =>
    Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : []
  );
}

/**
 * The description's security schemes that take a Poppy Session Token: HTTP
 * schemes named `DPoP` (spec 6: "Every listed API MUST accept Session Tokens
 * as described in 4.3: DPoP for OpenAPI"; 4.3: "the `DPoP` scheme"). An
 * HTTP authentication scheme's name is case-insensitive (RFC 9110 11.1).
 */
export function dpopSchemes(root: Json): Set<string> {
  const schemes = isObject(root) && isObject(root.components) && isObject(root.components.securitySchemes) ? root.components.securitySchemes : {};
  const names = new Set<string>();
  for (const [name, value] of Object.entries(schemes)) {
    const scheme = resolveRef(root, value);
    if (isObject(scheme) && scheme.type === "http" && typeof scheme.scheme === "string" && scheme.scheme.toLowerCase() === "dpop") names.add(name);
  }
  return names;
}

/**
 * Whether a write is outside the Company's Poppy Session: the description
 * declares a DPoP scheme, and none of the operation's security requirements
 * (its own `security`, or else the document's) names it. No requirement, or
 * `security: []`, is a write that takes no Session Token; a requirement of
 * another scheme alone (a Bearer guest token from the Company's own session
 * endpoint) is another way in. Either is the Company's own authentication,
 * not Poppy, and the agent's only access is its Poppy Session (our reading,
 * docs/readings.md). A description that declares no DPoP scheme says nothing
 * either way, as older or minimal descriptions don't (Datalayer's,
 * pi-poppy's): there every operation is called with the Session Token, as
 * spec 6 says every listed API accepts it. Reads are never outside: a public
 * catalog is a GET with no security.
 */
export function outsidePoppySession(dpop: ReadonlySet<string>, method: string, security: Json | undefined): boolean {
  if (dpop.size === 0 || method === "GET" || method === "HEAD") return false;
  if (!Array.isArray(security)) return true;
  return !security.some((requirement) => isObject(requirement) && Object.keys(requirement).some((name) => dpop.has(name)));
}

type OpenApiDocument = { readonly base: string; readonly operations: readonly OpenApiOperation[] };

/**
 * Header parameters the client sets itself, never the model. OpenAPI 3.x
 * says an `Accept`, `Content-Type` or `Authorization` header parameter
 * "SHALL be ignored"; `DPoP` is the Session's proof (RFC 9449), made fresh
 * for each request. A description that lists one, even as required (as
 * print-with-poppy's did from c147418 to cecb32f), describes the transport,
 * not an argument: kept, a required one would refuse every call.
 */
const TRANSPORT_HEADERS = /^(accept|content-type|authorization|dpop)$/i;

/**
 * Header parameters the agent never sends for the model, whatever a
 * description says: the platform's or the transport's own (hop-by-hop,
 * framing, cookies, origin, proxies, MCP's session headers). A description
 * that lists one is ignored for it, as for `TRANSPORT_HEADERS`.
 */
const RESERVED_HEADERS =
  /^(host|cookie|set-cookie|content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer|origin|referer|forwarded|via|proxy-.*|sec-.*|x-forwarded-.*|mcp-.*)$/i;

const documents = new Map<string, { document: OpenApiDocument; expiresAt: number }>();

function resolveRef(root: Json, value: Json, depth = 0): Json {
  if (depth > 8 || !isObject(value) || typeof value.$ref !== "string") return value;
  const path = value.$ref.replace(/^#\//, "").split("/");
  let current: Json = root;
  for (const part of path) {
    if (!isObject(current)) return value;
    current = current[part.replace(/~1/g, "/").replace(/~0/g, "~")] ?? null;
  }
  return resolveRef(root, current, depth + 1);
}

/** One JSON Pointer reference token (RFC 6901). */
function pointerPart(name: string): string {
  return name.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Where an operation's JSON request body schema is. `raw` is the operation's
 * `requestBody` as written (perhaps a `$ref`), `resolved` the object it names,
 * and `at` the pointer to `raw`. OpenAPI 3.0's schemas are read as draft 4
 * with `nullable` folded into `type`; 3.1's are JSON Schema 2020-12.
 */
function jsonBodyOf(root: Json, raw: Json | undefined, resolved: Json | undefined, at: string): JsonBody | undefined {
  if (!isObject(resolved) || !isObject(resolved.content) || !isObject(root)) return undefined;
  const media = Object.keys(resolved.content).find((type) => /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i.test(type));
  if (!media || !isObject(resolved.content[media]) || (resolved.content[media] as Record<string, Json>).schema === undefined) return undefined;
  const base = isObject(raw) && typeof raw.$ref === "string" && raw.$ref.startsWith("#/") ? raw.$ref.slice(1) : at;
  const v30 = typeof root.openapi === "string" && root.openapi.startsWith("3.0.");
  return {
    required: resolved.required === true,
    root: v30 ? foldNullable(root) : root,
    pointer: `${base}/content/${pointerPart(media)}/schema`,
    draft: v30 ? "4" : "2020-12"
  };
}

/** OpenAPI 3.0's `nullable: true` as JSON Schema: `null` added to `type`. */
function foldNullable(value: Json): Json {
  if (Array.isArray(value)) return value.map(foldNullable);
  if (!isObject(value)) return value;
  const out: Record<string, Json> = {};
  for (const [key, member] of Object.entries(value)) if (key !== "nullable") out[key] = foldNullable(member);
  if (value.nullable === true && typeof value.type === "string") out.type = [value.type, "null"];
  return out;
}

/** A schema with its `$ref`s written out, to a depth and a size, so the model sees the fields it must send. */
function inlineRefs(root: Json, value: Json, depth = 0): Json {
  if (depth > 6) return value;
  const resolved = resolveRef(root, value);
  if (Array.isArray(resolved)) return resolved.map((member) => inlineRefs(root, member, depth + 1));
  if (!isObject(resolved)) return resolved;
  const out: Record<string, Json> = {};
  for (const [key, member] of Object.entries(resolved)) out[key] = inlineRefs(root, member, depth + 1);
  return out;
}

const BODY_BASE = "https://openapi.invalid/description";

/**
 * A JSON body is checked against the operation's request schema before a
 * card or a request, so a mistake comes back to the model as a correction,
 * not as the Company's 400 after the User approved it. A string where the
 * schema wants an object is the commonest: the model serialised the body
 * itself, and our client would serialise it again. Strings aren't parsed for
 * the model, as an API may take a JSON string. A schema we can't read
 * refuses nothing: the Company decides.
 */
function checkBody(company: Company, op: OpenApiOperation, body: Json | undefined): void {
  const spec = op.jsonBody;
  if (!spec) return;
  if (body === undefined) {
    if (!spec.required) return;
    throw new PoppyError("invalid_body", `${op.method} ${op.path} (${op.operationId}) at ${company.name} needs a JSON body: see its requestBody in poppy_api_describe. Nothing was sent.`, 0);
  }
  let errors: readonly OutputUnit[];
  try {
    const validator = new Validator({ $ref: `${BODY_BASE}#${spec.pointer}` }, spec.draft, false);
    validator.addSchema(spec.root as never, BODY_BASE); // The library types a schema narrower than JSON; a schema it can't read throws, below.
    errors = validator.validate(body).errors;
  } catch {
    return;
  }
  if (errors.length === 0) return;
  const serialised = serialisedJson(errors, body, "body", `for ${op.operationId} at ${company.name}`);
  if (serialised) throw new PoppyError("invalid_body", `${serialised} Nothing was sent.`, 0);
  const shown = leafErrors(errors, "body");
  throw new PoppyError(
    "invalid_body",
    `body for ${op.operationId} at ${company.name} doesn't match its request schema: ${shown.join("; ")}. See its requestBody in poppy_api_describe. Nothing was sent.`,
    0
  );
}

/**
 * Where a schema refused a string of serialised JSON (an object or array),
 * a correction naming each such place; null when there is none.
 * The model serialised the value itself, at the top or deeper in, and our
 * client would serialise it again. Strings are never parsed for it.
 */
function serialisedJson(errors: readonly OutputUnit[], value: Json, where: string, context: string): string | null {
  const found = new Map<string, "object" | "array">();
  for (const { instanceLocation } of errors) {
    const at = atPointer(value, instanceLocation.replace(/^#/, ""));
    if (typeof at !== "string" || !/^\s*[{[]/.test(at)) continue;
    try {
      const parsed: unknown = JSON.parse(at);
      if (parsed !== null && typeof parsed === "object") {
        found.set(`${where}${instanceLocation.replace(/^#/, "")}`, Array.isArray(parsed) ? "array" : "object");
      }
    } catch {
      // Not JSON: the schema's own errors say what's wrong.
    }
  }
  if (found.size === 0) return null;
  const names = [...found.keys()].join(", ");
  const as = found.size === 1 ? `a structured ${[...found.values()][0]}` : "structured values";
  return `${names} ${context} must be the JSON value itself, such as {"product": "prints"}, not a string containing serialised JSON: pass ${names} as ${as}.`;
}

/** The value at a JSON Pointer (RFC 6901) in `value`, or undefined. */
function atPointer(value: Json, pointer: string): Json | undefined {
  let current: Json | undefined = value;
  for (const part of pointer.split("/").slice(1)) {
    const name = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) current = current[Number(name)];
    else if (isObject(current)) current = current[name];
    else return undefined;
  }
  return current;
}

/** The JSON Schema dialects a description's schemas are read in. */
type SchemaDraft = "4" | "7" | "2019-09" | "2020-12";

/** A value's errors against a schema, the leaves first; null when the schema can't be read (which refuses nothing). */
function schemaErrors(schema: Json, value: Json, draft: SchemaDraft): readonly OutputUnit[] | null {
  try {
    return new Validator(schema as never, draft, false).validate(value).errors; // As in checkBody: the library's schema type is narrower than JSON.
  } catch {
    return null;
  }
}

/** The leaves of a validation: the wrappers ($ref, properties, allOf…) only say a child failed. */
function leafErrors(errors: readonly OutputUnit[], where: string, limit = 5): string[] {
  const leaves = errors.filter((unit) => !/subschema had errors|does not match schema|did not match/i.test(unit.error));
  return (leaves.length ? leaves : errors).slice(0, limit).map((unit) => `${unit.instanceLocation.replace(/^#/, where) || where}: ${unit.error}`);
}

/**
 * The other readings of a parameter value: a path or query value is text on
 * the wire, so a number the model gives where the schema wants a string, or
 * a string that reads as the number or boolean it wants, is that value.
 */
function readings(value: string | number | boolean): Json[] {
  if (typeof value !== "string") return [String(value)];
  if (value === "true" || value === "false") return [value === "true"];
  return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value) ? [Number(value)] : [];
}

/**
 * Each parameter the call gives is checked against its schema before a card
 * or a request, as a JSON body is, so a mistake comes back to the model as a
 * correction. A value passes in any of its readings as text (`readings`).
 * A schema we can't read refuses nothing: the Company decides.
 */
export function checkParams(company: Pick<Company, "name">, op: OpenApiOperation, params: OpenApiCall["params"]): void {
  const problems: string[] = [];
  for (const { name, schema } of op.parameters) {
    const value = given(params, name);
    if (value === undefined) continue;
    if (op.parameters.some((parameter) => parameter.name === name && parameter.in === "header") && /[^\t\x20-\x7e]/.test(String(value))) {
      problems.push(`params.${name}: a header value must be one line of printable ASCII`);
      continue;
    }
    if (schema === undefined) continue;
    const errors = schemaErrors(schema, value, op.schemaDraft);
    if (!errors || errors.length === 0) continue;
    if (readings(value).some((reading) => schemaErrors(schema, reading, op.schemaDraft)?.length === 0)) continue;
    problems.push(...leafErrors(errors, `params.${name}`, 3));
  }
  if (problems.length === 0) return;
  throw new PoppyError(
    "invalid_params",
    `params for ${op.operationId} at ${company.name} don't match their schemas: ${problems.slice(0, 5).join("; ")}. See its parameters in poppy_api_describe. Nothing was sent.`,
    0
  );
}

/** The API's OpenAPI 3.0/3.1 description, fetched safely and cached. */
export async function openApi(client: PoppyClient, api: Api): Promise<OpenApiDocument> {
  const cached = documents.get(api.url);
  if (cached && cached.expiresAt > Date.now()) return cached.document;
  const { json, finalUrl, maxAgeSeconds } = await fetchJson(client.host.fetcher, api.url, { maxBytes: 1_000_000 });
  if (!isObject(json) || typeof json.openapi !== "string" || !/^3\.[01]\./.test(json.openapi)) {
    throw new PoppyError("bad_api", "The API description isn't OpenAPI 3.0 or 3.1", 0);
  }
  const server = Array.isArray(json.servers) && isObject(json.servers[0]) && typeof json.servers[0].url === "string" ? json.servers[0].url : "/";
  const base = new URL(server, finalUrl).href.replace(/\/+$/, "");
  const operations: OpenApiOperation[] = [];
  const dpop = dpopSchemes(json);
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
          proposes: proposesOperation(json, op),
          scopes: declaredScopes(op.security ?? json.security),
          outsidePoppy: outsidePoppySession(dpop, method.toUpperCase(), op.security ?? json.security),
          ...(jsonBody ? { jsonBody } : {}),
          schemaDraft: v30 ? "4" : "2020-12"
        });
      }
    }
  }
  const document = { base, operations };
  documents.set(api.url, { document, expiresAt: Date.now() + boundedCacheSeconds(maxAgeSeconds) * 1000 });
  return document;
}

function findOperation(document: OpenApiDocument, name: string): OpenApiOperation {
  const found = document.operations.find((op) => op.operationId === name || `${op.method} ${op.path}` === name);
  if (!found) throw new PoppyError("no_operation", `The API has no operation ${name}`, 0);
  return found;
}

/** What `poppy_api_describe` says of a write outside the Poppy Session, so the model doesn't plan around it. */
const OUTSIDE_POPPY =
  "Not usable: the Company's description doesn't protect this write with its Poppy Session (DPoP), so it is the Company's own way in (a sign-in, session, token or compatibility endpoint), which the agent never uses. Its only access is its Poppy Session; signing in goes through poppy_sign_in.";

/**
 * A write outside the Company's Poppy Session is refused before a card, a
 * token or a request: the agent never uses a Company's own authentication.
 */
function refuseOutsidePoppy(company: Company, op: OpenApiOperation): void {
  if (!op.outsidePoppy) return;
  throw new PoppyError(
    "outside_poppy_session",
    `${op.method} ${op.path} (${op.operationId}) at ${company.name} isn't protected by its Poppy Session: its description lists no DPoP security for it, so it is a way in that isn't Poppy, such as a sign-in, session, token or compatibility endpoint. The agent can't use it: its only access to ${company.name} is the Poppy Session it already has, which every other call uses by itself (signed out, or signed in through poppy_sign_in). Nothing was sent.`,
    0
  );
}

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
  /** The operation's `operationId`, or `METHOD /path` when it has none. */
  readonly operation: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly body?: Json;
  /** File fields of a `multipart/form-data` upload, each an attachment id; never the bytes. */
  readonly files?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
};

/**
 * The narrower scope a read-only lookup asks for (Guides), or null to use
 * the Session's: the scopes the operation declares, or `poppy:read` when it
 * declares none, if the signed-in Session holds them all and more besides.
 * A lookup that needs a custom scope keeps it.
 */
export function readOnlyScope(sessionScope: string | undefined, op: OpenApiOperation): string | null {
  const held = scopeSet(sessionScope);
  const wanted = new Set(op.scopes.length ? op.scopes : ["poppy:read"]);
  if (![...wanted].every((scope) => held.has(scope)) || wanted.size >= held.size) return null;
  return [...wanted].join(" ");
}

/** A parameter the call gives: its own member, never one every object inherits (`constructor`, `toString`). */
function given(params: OpenApiCall["params"], name: string): OpenApiCall["params"][string] | undefined {
  return Object.hasOwn(params, name) ? params[name] : undefined;
}

/**
 * The operation's path with its templates filled from the call's arguments,
 * after checking the required parameters are there. A template the
 * description doesn't declare as a parameter (some declare none) is filled
 * by name too. One left unfilled is refused: `/orders/%7Border_id%7D` would
 * only reach the wrong resource. So is a value that fills a whole segment
 * with nothing, `.` or `..`.
 */
export function pathFor(op: OpenApiOperation, params: OpenApiCall["params"]): string {
  for (const parameter of op.parameters) {
    if (parameter.required && given(params, parameter.name) === undefined) {
      throw new PoppyError("invalid_request", `Missing parameter ${parameter.name}`, 0);
    }
  }
  const filled = op.path.replace(/\{([^{}/]+)\}/g, (template, name: string) => {
    const value = given(params, name);
    return value === undefined ? template : encodeURIComponent(String(value));
  });
  const unfilled = [...filled.matchAll(/\{([^{}/]*)\}/g)].map((match) => match[1]);
  if (unfilled.length) {
    throw new PoppyError(
      "invalid_request",
      `${op.method} ${op.path} needs the path parameter${unfilled.length > 1 ? "s" : ""} ${unfilled.join(", ")}, which the call doesn't give`,
      0
    );
  }
  // A value must stay the one segment its template names: an empty segment,
  // or `.` or `..`, which a URL resolves away, would reach another resource.
  const templated = op.path.split("/");
  filled.split("/").forEach((segment, index) => {
    if (/\{[^{}/]+\}/.test(templated[index] ?? "") && (segment === "" || segment === "." || segment === "..")) {
      throw new PoppyError(
        "invalid_request",
        `${op.method} ${op.path}: ${JSON.stringify(segment)} can't fill the path segment ${templated[index]}; it would reach another resource`,
        0
      );
    }
  });
  return filled;
}

/**
 * The description's server must be one the agent may send a Session Token:
 * one of the Company's hosts, since `servers` can name any host and Session
 * Tokens (and the User's files) go only to the Company's (N10), over HTTPS (4.3).
 */
function refuseServer(company: Company, api: Api, url: URL): void {
  if (!tokenHostAllowed(company, url)) {
    throw new PoppyError(
      "untrusted_server",
      `${api.url} names the server ${url.origin}, which isn't one of ${company.name}'s hosts (not listed in its poppy.json, nor under ${company.domain} or its poppy_domains), so the agent won't send it a Session Token`,
      0
    );
  }
  if (url.protocol !== "https:") throw new PoppyError("invalid_request", "Refusing a non-HTTPS URL", 0);
}

/**
 * An API call never reaches a Poppy endpoint, whatever the description lists:
 * the model could otherwise confirm an operation itself (Ops 5.1) or send a
 * message as the User (7.8).
 */
function refuseProtocolEndpoint(company: Company, url: URL): void {
  const endpoint = protocolEndpoint(company, url);
  if (endpoint) {
    throw new PoppyError(
      "protocol_endpoint",
      `${url.origin}${url.pathname} is ${company.name}'s Poppy endpoint ${endpoint}, which only the agent's own code calls: operations are confirmed or cancelled by the User on their card, messages go through poppy_message, and sign-in through poppy_sign_in`,
      0
    );
  }
}

/**
 * The attachments an upload names, checked before anything is asked or sent:
 * the operation takes `multipart/form-data`, each field is one of its file
 * fields, each id is an attachment this agent holds, and every required file
 * field is given.
 */
function uploadedFiles(client: PoppyClient, company: Company, op: OpenApiOperation, files: Readonly<Record<string, string>>): AttachmentInfo[] {
  const upload = op.upload;
  if (!upload) {
    throw new PoppyError("invalid_request", `${op.method} ${op.path} at ${company.name} takes no file: its request body isn't multipart/form-data`, 0);
  }
  const attached: AttachmentInfo[] = [];
  for (const [field, id] of Object.entries(files)) {
    if (upload.files.length && !upload.files.includes(field)) {
      throw new PoppyError("invalid_request", `${op.method} ${op.path} has no file field ${field}; its file fields are ${upload.files.join(", ")}`, 0);
    }
    if (typeof id !== "string") throw new PoppyError("invalid_request", `files.${field} must be an attachment id (att_…)`, 0);
    const info = attachmentInfo(client.sql, id, client.host.now());
    if (!info) {
      throw new PoppyError("no_attachment", `No attachment ${id}: name one the User attached (att_…, in their message)`, 0);
    }
    attached.push(info);
  }
  const missing = upload.required.filter((name) => upload.files.includes(name) && !(name in files));
  if (missing.length) throw new PoppyError("invalid_request", `${op.method} ${op.path} needs the file field${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`, 0);
  return attached;
}

/**
 * An OpenAPI call the agent may send, exactly as it will be sent. Only
 * `check` makes one, and it runs every rule once: the operation is in the
 * Company's description and inside its Poppy Session, the server is HTTPS on
 * one of the Company's hosts, the path and query are filled from the call,
 * the URL is no Poppy endpoint, and a JSON body matches its schema or an
 * upload names the User's attachments. The approval card shows it, an
 * approved call goes through `check` again before it is sent, and
 * `PoppyClient.resource` takes nothing else for an API, so what was checked
 * is what is sent.
 */
export class CheckedApiRequest {
  readonly #sql: Sql;
  readonly #now: () => number;

  private constructor(
    sql: Sql,
    now: () => number,
    readonly company: Company,
    readonly api: Api,
    readonly op: OpenApiOperation,
    readonly call: OpenApiCall,
    /** The full URL: server, filled path and query. */
    readonly url: string,
    /** The User's files an upload sends: names, types and sizes, never the bytes. */
    readonly attachments: readonly AttachmentInfo[]
  ) {
    this.#sql = sql;
    this.#now = now;
  }

  get method(): string {
    return this.op.method;
  }

  /** An upload, or an operation that takes only `multipart/form-data`, sends a form; anything else JSON. */
  get multipart(): boolean {
    return this.call.files !== undefined || (this.op.upload !== undefined && !this.op.upload.json && this.call.body !== undefined);
  }

  /**
   * What identifies a write for `refuseWhileConfirming`: method, URL, body and
   * files. Null for a read. Stored in `poppy_proposals`, so its form is fixed.
   */
  get write(): string | null {
    if (this.method === "GET") return null;
    const headers = Object.keys(this.headers).length ? ` ${JSON.stringify(this.headers)}` : "";
    return `${this.method} ${this.url} ${JSON.stringify(this.call.body ?? null)}${this.call.files ? ` ${JSON.stringify(this.call.files)}` : ""}${headers}`;
  }

  /** The header parameters the call gives, by their declared names: sent, and shown on the card. */
  get headers(): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const parameter of this.op.parameters) {
      const value = given(this.call.params, parameter.name);
      if (parameter.in === "header" && value !== undefined) out[parameter.name] = String(value);
    }
    return out;
  }

  /** The approval card's words: the Company, the method, the exact path and query, and the body. */
  describe(): string {
    const url = new URL(this.url);
    const what = `${this.method} ${url.pathname}${url.search} (${this.op.summary || this.op.operationId})`;
    const headers = Object.entries(this.headers).map(([name, value]) => ` · ${name}: ${value}`).join("");
    const body = `${headers}${this.call.body !== undefined ? ` with ${JSON.stringify(this.call.body)}` : ""}`;
    if (!this.attachments.length) return `${this.company.name}: ${what}${body}`;
    const names = this.attachments.map((info) => `“${info.name}” (${info.type.replace("image/", "").toUpperCase()}, ${humanSize(info.size)})`).join(" and ");
    return `Send your ${this.attachments.length === 1 ? "photo" : "photos"} ${names} to ${this.company.name}: ${what}${body}`;
  }

  /**
   * The request itself. A `multipart/form-data` body is built here, as the
   * request is made, never earlier: `body`'s members as text fields, and each
   * file field the stored attachment it names, with its name and type.
   */
  init(): RequestInit {
    const given = { ...this.headers, ...(this.call.idempotencyKey ? { "Idempotency-Key": this.call.idempotencyKey } : {}) };
    const headers = Object.keys(given).length ? { headers: given } : {};
    if (!this.multipart) return { method: this.method, url: this.url, ...(this.call.body !== undefined ? { body: this.call.body } : {}), ...headers };
    const form = new FormData();
    if (isObject(this.call.body ?? null)) {
      for (const [name, value] of Object.entries(this.call.body as Record<string, Json>)) {
        if (value !== null && value !== undefined) form.append(name, typeof value === "string" ? value : JSON.stringify(value));
      }
    }
    for (const [field, id] of Object.entries(this.call.files ?? {})) {
      const found = readAttachment(this.#sql, id, this.#now());
      if (!found) throw new PoppyError("no_attachment", `The User's attachment ${id} is gone (deleted, or past its 30 days), so nothing was sent`, 0);
      form.append(field, new Blob([found.bytes], { type: found.info.type }), found.info.name);
    }
    return { method: this.method, url: this.url, form, ...headers };
  }

  /**
   * Check a call against the Company's description, now. `idempotencyKey`
   * is asked for only for a write whose description declares the header.
   */
  static async check(
    client: PoppyClient,
    company: Company,
    request: {
      readonly apiUrl?: string;
      readonly operation: string;
      readonly params?: OpenApiCall["params"];
      readonly body?: Json;
      readonly files?: OpenApiCall["files"];
      readonly idempotencyKey?: string | (() => string);
    }
  ): Promise<CheckedApiRequest> {
    const api = findApi(company, "openapi", request.apiUrl);
    const document = await openApi(client, api);
    const op = findOperation(document, request.operation);
    const params = request.params ?? {};
    const url = new URL(document.base);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathFor(op, params)}`;
    checkParams(company, op, params);
    for (const parameter of op.parameters) {
      const value = given(params, parameter.name);
      if (parameter.in === "query" && value !== undefined) url.searchParams.set(parameter.name, String(value));
    }
    refuseProtocolEndpoint(company, url);
    refuseOutsidePoppy(company, op);
    refuseServer(company, api, url);
    const files = request.files && Object.keys(request.files).length ? request.files : undefined;
    const key = op.method !== "GET" && op.acceptsIdempotencyKey ? request.idempotencyKey : undefined;
    const call: OpenApiCall = {
      apiUrl: api.url,
      operation: op.operationId,
      params,
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(files ? { files } : {}),
      ...(key !== undefined ? { idempotencyKey: typeof key === "string" ? key : key() } : {})
    };
    const checked = new CheckedApiRequest(client.sql, () => client.host.now(), company, api, op, call, url.href, files ? uploadedFiles(client, company, op, files) : []);
    // A JSON body (not a form's fields) is checked against the operation's schema.
    if (!checked.multipart) checkBody(company, op, call.body);
    return checked;
  }
}

/** What a sent API call got back. */
type ApiAnswer =
  | { readonly kind: "answered"; readonly status: number; readonly body: Json }
  /** A 202 with an operation we stored: nothing has happened yet (Ops 4.1). */
  | { readonly kind: "proposed"; readonly operation: Operation }
  /** A 202 with an operation we can't use: nothing was done, and the User has been told. */
  | { readonly kind: "unusable"; readonly body: Json };

const UNUSABLE = "The Company proposed an operation the agent can't use, so nothing was done and nothing can be approved; the User has been told.";

function answerForModel(answer: ApiAnswer): Json {
  if (answer.kind === "answered") return { status: answer.status, body: answer.body };
  if (answer.kind === "unusable") return { status: 202, unusable: true, note: UNUSABLE, body: answer.body };
  const { operation_id, revision, summary } = answer.operation;
  return { status: 202, proposed: { operation_id, revision, summary }, note: "Nothing has happened yet; the User decides on the approval card." };
}

/** Send a checked call, and read what came back. */
async function sendApi(client: PoppyClient, label: string, checked: CheckedApiRequest): Promise<ApiAnswer> {
  const { company, op, api, write } = checked;
  if (write) refuseWhileConfirming(client, company.issuer, write);
  // Read-only lookups ask for a read-only token when the account allows (Guides).
  const readOnly = op.method === "GET" ? readOnlyScope(client.session(company.issuer, label)?.scope, op) : null;
  const response = await client.resource(company, checked, {
    label,
    ...(api.resource ? { resource: api.resource } : {}),
    ...(readOnly ? { scope: readOnly } : {})
  });
  const text = await client.readBody(response);
  let body: Json = null;
  try {
    body = text ? parseStrictJson(text) : null;
  } catch {
    body = text.slice(0, 4_000);
  }
  if (response.status === 403 && isObject(body) && body.error === "extension_required") {
    const extension = typeof body.extension === "string" ? body.extension : undefined;
    throw withAnswer(
      new PoppyError(
        "extension_required",
        `${company.name} requires the extension ${extension ?? "(unnamed)"}, which this agent doesn't support`,
        403,
        { body, ...(extension ? { extension } : {}) }
      ),
      403
    );
  }
  // An endpoint that would perform an action proposes an operation instead (Ops 4.1).
  if (response.status === 202 && isObject(body) && isObject(body.operation)) {
    const operation = await handleProposal(client, company, label, body.operation);
    if (!operation) return { kind: "unusable", body };
    if (write) rememberProposal(client, company.issuer, write, operation.operation_id);
    return { kind: "proposed", operation };
  }
  return { kind: "answered", status: response.status, body };
}

/**
 * Call an OpenAPI operation with a DPoP Session Token. Every rule is checked
 * first (`CheckedApiRequest.check`), before a token request or a card. Reads
 * go straight through. A write goes straight to the Company only when it has
 * the Operations extension and the description says this operation answers
 * with a proposal (`proposes`); any other write, and every upload, waits for
 * the User's approval on our own card first, fixed per tool call. A write
 * sent straight through carries a stored `Idempotency-Key` where the API
 * accepts one; where it doesn't, it is sent at most once per tool call, so a
 * replay after a crash says so instead of sending it again.
 */
export async function callOpenApi(
  client: PoppyClient,
  company: Company,
  label: string,
  request: {
    apiUrl?: string;
    operation: string;
    params?: Record<string, string | number | boolean>;
    body?: Json;
    /** For a `multipart/form-data` upload: each file field's attachment id. */
    files?: Record<string, string>;
    callKey: string;
  }
): Promise<Json> {
  const checked = await CheckedApiRequest.check(client, company, {
    ...request,
    idempotencyKey: () => intent(client.sql, `idem|${request.callKey}`, () => crypto.randomUUID())
  });
  const ask = () =>
    proposeLocal(
      client,
      company,
      label,
      checked.describe(),
      { kind: "openapi", call: checked.call, method: checked.method, url: checked.url, ...(checked.attachments.length ? { attachments: [...checked.attachments] } : {}) },
      intent(client.sql, `approval|${request.callKey}`, () => randomId("apr_"))
    );
  if (checked.attachments.length) {
    // The User's photo leaves their agent only when they say so, at any Company:
    // the Operations extension covers what a Company does, not what we send it.
    return { proposed: await ask(), note: "Waiting for the User to approve sending the file on a card; nothing has been sent yet." };
  }
  if (checked.method === "GET") return answerForModel(await sendApi(client, label, checked));
  if (company.extensions.operations && checked.op.proposes) {
    if (!checked.call.idempotencyKey && !firstTime(client.sql, `sent|${request.callKey}`)) {
      throw new PoppyError(
        "interrupted",
        `This call to ${company.name} was interrupted after it may have been sent, and the operation takes no Idempotency-Key, so it isn't sent again. Check poppy_status for a proposal from ${company.name} before asking again.`,
        0
      );
    }
    return answerForModel(await sendApi(client, label, checked));
  }
  return { proposed: await ask(), note: "Waiting for the User's approval on a card; nothing has happened yet." };
}

/**
 * An approved write: the stored call checked again, now, under today's rules
 * and description, and sent only if it still makes exactly the request the
 * card showed. An answer other than 2xx is an error the receipt names with
 * its status and code (operations.ts), never "done": the request was sent as
 * approved, and the Company didn't do it as far as it says. Nor is a
 * proposal we can't use.
 */
registerExecutor("openapi", async (client, company, approval, label) => {
  const checked = await CheckedApiRequest.check(client, company, approval.call);
  if (checked.method !== approval.method || checked.url !== approval.url) {
    throw new PoppyError(
      "approval_changed",
      `Not sent: ${company.name}'s description now makes this ${checked.method} ${checked.url}, not the ${approval.method} ${approval.url} you approved. Ask again to see the request it would make now.`,
      0
    );
  }
  const answer = await sendApi(client, label, checked);
  if (answer.kind === "unusable") {
    throw withAnswer(new PoppyError("unusable_proposal", `${company.name} proposed an operation the agent can't use, so nothing was done`, 202), 202);
  }
  if (answer.kind === "answered" && (answer.status < 200 || answer.status >= 300)) {
    const { status, body } = answer;
    const code = companyErrorCode(isObject(body) ? body.error : undefined, status);
    throw withAnswer(
      new PoppyError(code, `${company.name} answered ${status}: ${JSON.stringify(body).slice(0, 1_000)}`, status, body !== null ? { body } : {}),
      status
    );
  }
  return JSON.stringify(answerForModel(answer)).slice(0, 2_000);
});

// ---------------------------------------------------------------- MCP

const MCP_VERSION = "2025-06-18";
type McpSession = { sessionId: string | null; tools: Json[] | null };
const mcpSessions = new Map<string, McpSession>();

/**
 * Protected resource metadata (RFC 9728) must name the Company's issuer as an
 * authorization server, or the server isn't the Company's (spec 6).
 */
async function checkResourceMetadata(client: PoppyClient, company: Company, api: Api): Promise<void> {
  const url = new URL(api.url);
  const candidates = [
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`,
    `${url.origin}/.well-known/oauth-protected-resource`
  ];
  for (const candidate of candidates) {
    try {
      const { json } = await fetchJson(client.host.fetcher, candidate);
      if (isObject(json) && Array.isArray(json.authorization_servers)) {
        if (json.authorization_servers.includes(company.issuer)) return;
        throw new PoppyError("bad_api", `${api.url} doesn't name ${company.issuer} as its authorization server`, 0);
      }
    } catch (error) {
      if (error instanceof PoppyError) throw error;
    }
  }
  throw new PoppyError("bad_api", `${api.url} publishes no protected resource metadata`, 0);
}

/** A JSON-RPC response from a Streamable HTTP reply: JSON, or the matching SSE message. */
async function rpcResult(client: PoppyClient, response: Response, id: number): Promise<Json> {
  const type = response.headers.get("Content-Type") ?? "";
  const text = await client.readBody(response);
  const messages: Json[] = [];
  if (type.includes("text/event-stream")) {
    for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data) messages.push(parseStrictJson(data));
    }
  } else if (text) {
    const parsed = parseStrictJson(text);
    messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  const message = messages.find((item) => isObject(item) && item.id === id);
  if (!isObject(message)) throw new PoppyError("mcp_error", "The MCP server didn't answer the request", response.status);
  if (isObject(message.error)) throw new PoppyError("mcp_error", `MCP error: ${String(message.error.message ?? message.error.code)}`, response.status);
  return message.result ?? null;
}

async function mcpRequest(client: PoppyClient, company: Company, label: string, api: Api, method: string, params: Json, sessionKey: string): Promise<{ result: Json; sessionId: string | null }> {
  const session = mcpSessions.get(sessionKey);
  const id = Math.floor(Math.random() * 1e9);
  // MCP uses Bearer tokens, each issued for this server's url only (spec 4.3).
  const response = await client.resource(
    company,
    EndpointRequest.mcp(company, {
      method: "POST",
      url: api.url,
      body: { jsonrpc: "2.0", id, method, params },
      accept: "application/json, text/event-stream",
      headers: {
        "MCP-Protocol-Version": MCP_VERSION,
        ...(session?.sessionId ? { "Mcp-Session-Id": session.sessionId } : {})
      }
    }),
    { label, bearer: true, resource: api.url }
  );
  if (response.status === 404 && session?.sessionId) {
    mcpSessions.delete(sessionKey);
    await response.body?.cancel();
    throw withAnswer(new PoppyError("mcp_session_expired", "The MCP session expired", 404), 404);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw withAnswer(new PoppyError(`http_${response.status}`, `${api.url} returned HTTP ${response.status}`, response.status), response.status);
  }
  return { result: await rpcResult(client, response, id), sessionId: response.headers.get("Mcp-Session-Id") };
}

async function mcpSession(client: PoppyClient, company: Company, label: string, api: Api): Promise<string> {
  const key = `${company.issuer}|${label}|${api.url}`;
  if (mcpSessions.has(key)) return key;
  await checkResourceMetadata(client, company, api);
  const { sessionId } = await mcpRequest(client, company, label, api, "initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: client.identity.clientName, version: "0.1" }
  }, key);
  mcpSessions.set(key, { sessionId, tools: null });
  // `notifications/initialized` is a notification: no id, and no answer to wait for.
  const response = await client.resource(
    company,
    EndpointRequest.mcp(company, {
      method: "POST",
      url: api.url,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      accept: "application/json, text/event-stream",
      headers: { "MCP-Protocol-Version": MCP_VERSION, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) }
    }),
    { label, bearer: true, resource: api.url }
  );
  await response.body?.cancel();
  return key;
}

export async function listMcpTools(client: PoppyClient, company: Company, label: string, apiUrl?: string): Promise<Json[]> {
  const api = findApi(company, "mcp", apiUrl);
  const key = await mcpSession(client, company, label, api);
  const session = mcpSessions.get(key)!;
  if (!session.tools) {
    const { result } = await mcpRequest(client, company, label, api, "tools/list", {}, key);
    session.tools = isObject(result) && Array.isArray(result.tools) ? result.tools : [];
  }
  return session.tools;
}

async function performMcp(client: PoppyClient, company: Company, label: string, call: { apiUrl: string; tool: string; args: Json }): Promise<Json> {
  const api = findApi(company, "mcp", call.apiUrl);
  const write = `MCP ${api.url} ${call.tool} ${JSON.stringify(call.args)}`;
  refuseWhileConfirming(client, company.issuer, write);
  const key = await mcpSession(client, company, label, api);
  const { result } = await mcpRequest(client, company, label, api, "tools/call", { name: call.tool, arguments: call.args }, key);
  if (isObject(result) && isObject(result.structuredContent) && isObject(result.structuredContent.operation)) {
    const operation = await handleProposal(client, company, label, result.structuredContent.operation);
    if (operation) {
      rememberProposal(client, company.issuer, write, operation.operation_id);
      return { proposed: { operation_id: operation.operation_id, revision: operation.revision, summary: operation.summary }, note: "Nothing has happened yet; the User decides on the approval card." };
    }
    return { unusable: true, note: UNUSABLE, result };
  }
  return result;
}

/**
 * Whether an MCP tool says it answers with a proposal (Ops 4.2): its
 * `outputSchema` has an `operation` property, the MCP counterpart of an
 * OpenAPI 202 with one.
 */
export function mcpToolProposes(tool: Json): boolean {
  if (!isObject(tool) || !isObject(tool.outputSchema)) return false;
  const { properties } = tool.outputSchema;
  return isObject(properties) && properties.operation !== undefined;
}

/**
 * Call an MCP tool. A tool marked `readOnlyHint` goes straight through, as an
 * OpenAPI GET does: it is the Company's own server saying the call changes
 * nothing (our reading, docs/readings.md). So does a tool at a Company with
 * the Operations extension whose `outputSchema` says it proposes. Any other
 * tool waits for the User's approval on our own card, as an OpenAPI write does.
 */
export async function callMcpTool(
  client: PoppyClient,
  company: Company,
  label: string,
  request: { apiUrl?: string; tool: string; args: Json }
): Promise<Json> {
  const api = findApi(company, "mcp", request.apiUrl);
  const tools = await listMcpTools(client, company, label, api.url);
  const tool = tools.find((item) => isObject(item) && item.name === request.tool);
  if (!isObject(tool)) throw new PoppyError("no_tool", `${api.url} has no tool ${request.tool}`, 0);
  checkMcpArgs(company, request.tool, tool.inputSchema, request.args);
  const readOnly = isObject(tool.annotations) && tool.annotations.readOnlyHint === true;
  const call = { apiUrl: api.url, tool: request.tool, args: request.args };
  if (readOnly || (company.extensions.operations && mcpToolProposes(tool))) return performMcp(client, company, label, call);
  const id = await proposeLocal(client, company, label, `${company.name}: run ${request.tool} with ${JSON.stringify(request.args)}`, { kind: "mcp", call });
  return { proposed: id, note: "Waiting for the User's approval on a card; nothing has happened yet." };
}

/**
 * An MCP tool's arguments are checked against its `inputSchema` before a card
 * or a call, as an OpenAPI body is, so a mistake comes back to the model as a
 * correction rather than reaching the Company after the User approved it.
 * The schema is JSON Schema 2020-12 unless its `$schema` names another
 * (MCP 2025-11-25). A schema we can't read refuses nothing: the Company decides.
 */
function checkMcpArgs(company: Company, name: string, inputSchema: Json | undefined, args: Json): void {
  if (!isObject(inputSchema)) return;
  const dialect = typeof inputSchema.$schema === "string" ? inputSchema.$schema : "";
  const draft: SchemaDraft = /draft-0[34]/.test(dialect) ? "4" : /draft-0[67]/.test(dialect) ? "7" : /2019-09/.test(dialect) ? "2019-09" : "2020-12";
  const errors = schemaErrors(inputSchema, args, draft);
  if (!errors || errors.length === 0) return;
  const context = `for ${name} at ${company.name}`;
  const serialised = serialisedJson(errors, args, "args", context);
  if (serialised) throw new PoppyError("invalid_args", `${serialised} Nothing was sent.`, 0);
  throw new PoppyError(
    "invalid_args",
    `args ${context} don't match the tool's inputSchema: ${leafErrors(errors, "args").join("; ")}. See it in poppy_mcp_list. Nothing was sent.`,
    0
  );
}

/** An approved MCP call: sent only to an MCP server the Company still lists (`findApi`). */
registerExecutor("mcp", async (client, company, approval, label) => {
  const result = await performMcp(client, company, label, approval.call);
  return JSON.stringify(result).slice(0, 2_000);
});


// ---------------------------------------------------------------- The protocol log

/**
 * The OpenAPI operation a request is for, from the descriptions already
 * cached: its operationId, path template and server. The protocol log
 * (protocol-log.ts) names a call by these rather than its filled-in path.
 */
export function apiOperationFor(method: string, url: URL): { operation: string; path: string; base: string } | null {
  const target = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  for (const { document } of documents.values()) {
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
