import { Validator, type OutputUnit } from "@cfworker/json-schema";
import { attachmentInfo, humanSize, readAttachment, type AttachmentInfo } from "../attachments";
import { answerOf, PoppyClient, PoppyError, scopeSet, withAnswer, withoutAnswer, withUnreadableAnswer, type TokenOptions } from "./client";
import { boundedCacheSeconds, protocolEndpoint, tokenHostAllowed, type Company } from "./discovery";
import { fetchJson } from "./fetch";
import { canonicalJson, isObject, parseStrictJson, toJson, type Json } from "./json";
import { approvalTerms, dispatchTaskRequest, OperationOutcomeUnknown, proposeLocal, registerExecutor, resumeRecordedTask, taskProjection, TermsRequested, type ApprovalExecution } from "./operations";
import { TaskFiles } from "./task-files";
import type { Issuer } from "./issuer";
import { randomId } from "./jwt";
import { approvable, approvalCardId, approvalForModel, approvalHeader, approvalJson, approvalSummary, parseOperationV2, type ApprovalV2, type OperationV2 } from "./operations-v2";
import { EndpointRequest, type RequestInit } from "./outgoing";
import { approvalsTable, intent, intentsTable, taskCallsTable, type Sql } from "./store";
import { readApproval, type NewApproval } from "./approvals";
import { one } from "../rows";
import { sameAuthority, sessionAuthority, type ApprovalAuthority } from "./authority";
import { companyErrorCode } from "./error-codes";
import { isTaskRequest } from "./approval-outcome";
import { domainFromInput } from "../domain";
import { array, jsonText, nullable, object, string } from "../decode";

type Api = Company["apis"][number];

type ApprovalBinding = ApprovalAuthority;
function bindingSnapshot(client: PoppyClient, company: Company, label: string): ApprovalBinding {
  const session = client.sessionFor(company, label);
  return { account: session.account, sessionId: session.session_id, authorityGeneration: session.authority_generation };
}
function checkApprovalBinding(client: PoppyClient, company: Company, label: string, binding: ApprovalBinding): void {
  const session = client.session(company.issuer, label);
  if (!sameAuthority(binding, sessionAuthority(session))) {
    throw new PoppyError("approval_changed", "The account or Session changed. Review a fresh request before sending it.", 0);
  }
}

type DispatchGuard = Pick<TokenOptions, "beforeDispatch" | "onSessionRestart">;
type AuthorityGuard = DispatchGuard & { readonly binding: () => ApprovalBinding };

/** Capture authority before asynchronous preparation, and retain the last
 * transport's binding for returned terms. Only an unapproved request may follow
 * a known invalid_session refusal; account and withdrawal generation stay fixed. */
function requestGuard(client: PoppyClient, company: Company, label: string, binding: ApprovalBinding, allowRestart: boolean, beforeDispatch?: () => void): AuthorityGuard {
  let expected = binding;
  const check = () => { beforeDispatch?.(); checkApprovalBinding(client, company, label, expected); };
  check();
  return {
    binding: () => expected,
    beforeDispatch: check,
    ...(allowRestart ? { onSessionRestart: (previousSessionId: string, nextSessionId: string) => {
      if (expected.sessionId !== previousSessionId) throw new PoppyError("approval_changed", "The task's Session changed before its known refusal could be recovered. Nothing was resent.", 0);
      expected = { ...expected, sessionId: nextSessionId };
      check();
    } } : {})
  };
}

function executionGuard(client: PoppyClient, company: Company, label: string, binding: ApprovalBinding, execution: ApprovalExecution): AuthorityGuard {
  return requestGuard(client, company, label, binding, isTaskRequest(execution.approvalId), execution.beforeDispatch);
}

function hasTaskCall(client: PoppyClient, callId: string): boolean {
  return one(client.sql, taskCallsTable.pick("call_id"), "SELECT call_id FROM poppy_task_calls WHERE call_id = ?", callId) !== undefined;
}

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

function findOperation(document: OpenApiDocument, name: string): OpenApiOperation {
  const found = document.operations.find((op) => op.operationId === name || `${op.method} ${op.path}` === name);
  if (!found) throw new PoppyError("no_operation", `The API has no operation ${name}`, 0);
  return found;
}

/** What `poppy_api_describe` says of a write outside the Poppy Session, so the model doesn't plan around it. */
const OUTSIDE_POPPY =
  "Not usable: the Company's description doesn't protect this write with its Poppy Session (an OAuth, Bearer or DPoP scheme), so it is the Company's own way in (a sign-in, session, token or compatibility endpoint), which the agent never uses. Its only access is its Poppy Session; signing in goes through poppy_sign_in.";

/**
 * A write outside the Company's Poppy Session is refused before a card, a
 * token or a request: the agent never uses a Company's own authentication.
 */
function refuseOutsidePoppy(company: Company, op: OpenApiOperation): void {
  if (!op.outsidePoppy) return;
  throw new PoppyError(
    "outside_poppy_session",
    `${op.method} ${op.path} (${op.operationId}) at ${company.name} isn't protected by its Poppy Session: its description lists no OAuth, Bearer or DPoP security for it, so it is a way in that isn't Poppy, such as a sign-in, session, token or compatibility endpoint. The agent can't use it: its only access to ${company.name} is the Poppy Session it already has, which every other call uses by itself (signed out, or signed in through poppy_sign_in). Nothing was sent.`,
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

/**
 * The narrower scope a read-only lookup asks for (Guides), or null to use
 * the Session's: the scopes the operation declares, if the signed-in
 * Session holds them all and more besides. 0.3 defines no scopes (4.7), so
 * a lookup that declares none keeps the Session's.
 */
export function readOnlyScope(sessionScope: string | undefined, op: OpenApiOperation): string | null {
  if (op.scopes.length === 0) return null;
  const held = scopeSet(sessionScope);
  const wanted = new Set(op.scopes);
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
 * The description's server must be one the agent may send its Session
 * header and tokens: one of the Company's hosts, since `servers` can name any
 * host and they (and the User's files) go only to the Company's (N10), over
 * HTTPS (5.6).
 */
function refuseServer(company: Company, api: Api, url: URL): void {
  if (!tokenHostAllowed(company, url)) {
    throw new PoppyError(
      "untrusted_server",
      `${api.url} names the server ${url.origin}, which isn't one of ${company.name}'s hosts (not listed in its poppy.json, nor under ${company.domain} or its protected resources), so the agent won't send it its Session header or tokens`,
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
    readonly attachments: readonly AttachmentInfo[],
    readonly identifiers: readonly string[]
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
    const given = {
      ...this.headers,
      ...(this.call.idempotencyKey ? { "Idempotency-Key": this.call.idempotencyKey } : {}),
      ...(this.call.approval ? { "Poppy-Approval": approvalHeader(this.call.approval) } : {})
    };
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
      readonly approval?: ApprovalV2;
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
      ...(key !== undefined ? { idempotencyKey: typeof key === "string" ? key : key() } : {}),
      ...(request.approval ? { approval: request.approval } : {})
    };
    const identifiers = [...new Set([request.operation, op.operationId, `${op.method} ${op.path}`])].filter(name => findOperation(document, name) === op);
    const checked = new CheckedApiRequest(client.sql, () => client.host.now(), company, api, op, call, url.href, files ? uploadedFiles(client, company, op, files) : [], identifiers);
    // A JSON body (not a form's fields) is checked against the operation's schema.
    if (!checked.multipart) checkBody(company, op, call.body);
    return checked;
  }
}

/** What a sent API call got back. */
type ApiAnswer =
  | { readonly kind: "answered"; readonly status: number; readonly body: Json }
  /** Refused until the User approves the operation; a card waits for them (Ops 4). */
  | { readonly kind: "approval"; readonly operation: OperationV2; readonly approvalId: string }
  /** An operation we can't show the User: nothing was done, and the User has been told. */
  | { readonly kind: "unusable"; readonly body: Json };

const UNUSABLE = "The Company asked for approval of an operation the agent can't show, so nothing was done and nothing can be approved; the User has been told.";

function answerForModel(answer: ApiAnswer, company: Company): Json {
  if (answer.kind === "answered") return { status: answer.status, body: answer.body };
  if (answer.kind === "approval") return approvalForModel(company, answer.operation, 403, answer.approvalId);
  return { status: 403, unusable: true, note: UNUSABLE, body: answer.body };
}

/** Send a checked call, and read what came back. */
async function sendApi(client: PoppyClient, label: string, checked: CheckedApiRequest, guard: AuthorityGuard, executingApproval?: string): Promise<ApiAnswer> {
  const { company, op, api } = checked;
  // Read-only lookups ask for a read-only token when the account allows (Guides).
  const readOnly = op.method === "GET" ? readOnlyScope(client.session(company.issuer, label)?.scope, op) : null;
  const response = await client.resource(company, checked, {
    label,
    // The server's own protected resource metadata says whether it takes only its own tokens (4.5).
    service: (await openApi(client, api)).base,
    ...(readOnly ? { scope: readOnly } : {}), ...guard
  });
  const text = await client.readBody(response).catch(error => { throw withUnreadableAnswer(error, response.status); });
  let body: Json = null;
  try {
    body = text ? parseStrictJson(text) : null;
  } catch {
    body = text.slice(0, 4_000);
  }
  // The Company wants the User's approval of exact terms first (Ops 4); nothing was done.
  if (response.status === 403 && isObject(body) && body.error === "approval_required" && company.extensions.operations) {
    const operation = parseOperationV2(body.operation);
    if ("problem" in operation) {
      await unusableApproval(client, company, operation.problem);
      return { kind: "unusable", body };
    }
    const approvalId = await proposeApproval(client, company, label, operation, { params: checked.call.params, body: checked.call.body ?? null }, {
      kind: "openapi",
      call: { ...checked.call, approval: { operation_id: operation.operation_id, revision: operation.revision, expires_at: operation.expires_at }, ...(checked.op.acceptsIdempotencyKey ? { idempotencyKey: randomId() } : {}) },
      method: checked.method,
      url: checked.url,
      binding: guard.binding()
    }, executingApproval);
    return { kind: "approval", operation, approvalId };
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
  return { kind: "answered", status: response.status, body };
}

/**
 * Call an OpenAPI operation in the Session. Every rule is checked first
 * (`CheckedApiRequest.check`), before a token request or a card. Task requests
 * run normally; a Company operation waits on its exact-terms card (Ops 4–6).
 * Photos selected by the User for this task need no second disclosure click.
 * Other files retain their disclosure card. Writes are recorded before dispatch
 * so replay returns their outcome rather than creating another operation.
 */
export type OpenApiTaskRequest = {
  apiUrl?: string;
  operation: string;
  params?: Record<string, string | number | boolean>;
  body?: Json;
  files?: Record<string, string>;
  callKey: string;
};

const apiAliases = jsonText(object({ operation: string, identifiers: array(string), apiUrl: string, originalApiUrl: nullable(string) }));

function rememberApiAliases(client: PoppyClient, request: OpenApiTaskRequest, checked: CheckedApiRequest): void {
  intent(client.sql, `api-aliases|${request.callKey}`, () => JSON.stringify({ operation: request.operation, identifiers: checked.identifiers, apiUrl: checked.api.url, originalApiUrl: request.apiUrl ?? null }));
}

function apiInput(client: PoppyClient, domain: string, label: string, request: OpenApiTaskRequest): { value: string; key: string; requestId?: string; canReplay: boolean } {
  const { callKey, operation, apiUrl, params, files, ...fields } = request;
  const aliases = one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `api-aliases|${callKey}`);
  const saved = aliases ? apiAliases(aliases.value, "API input aliases") : undefined;
  const named = saved?.identifiers.includes(operation) ? saved.operation : operation;
  const api = saved && (apiUrl === undefined || apiUrl === saved.apiUrl) ? saved.originalApiUrl ?? undefined : apiUrl;
  const value = canonicalJson(toJson({ domain: domainFromInput(domain), label, ...fields, operation: named, params: params ?? {}, ...(files && Object.keys(files).length ? { files } : {}), ...(api !== undefined ? { apiUrl: api } : {}) }));
  const key = `api-input|${callKey}`;
  const previous = one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", key);
  if (previous && previous.value !== value) throw new PoppyError("approval_changed", "This tool call already asked for a different API request. Nothing will be sent again.", 0);
  const requestId = one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `request|${callKey}`)?.value;
  const bound = requestId !== undefined && hasTaskCall(client, requestId);
  // A pre-existing mapping without this input proof still takes the ordinary
  // checked/hash-verified path; never stamp new arguments onto an old outcome.
  if (!previous && !bound) intent(client.sql, key, () => value);
  return { value, key, ...(requestId ? { requestId } : {}), canReplay: previous !== undefined && bound };
}

function taskReference(client: PoppyClient, callId: string, result: Json): Json {
  const bound = one(client.sql, taskCallsTable.pick("request_id"), "SELECT request_id FROM poppy_task_calls WHERE call_id = ?", callId);
  if (!bound || !isObject(result)) throw new PoppyError("invalid_response", "The task's recorded outcome is unavailable. Nothing will be resent.", 0);
  return { ...result, poppyTask: taskProjection(client, bound.request_id) };
}

/** Recover only a recorded call with the exact original input, before discovery or file reads. */
export async function replayOpenApiCall(client: PoppyClient, domain: string, label: string, request: OpenApiTaskRequest, beforeDispatch?: () => void): Promise<Json | undefined> {
  const input = apiInput(client, domain, label, request);
  if (!input.canReplay || !input.requestId) return undefined;
  const result = await resumeRecordedTask(client, input.requestId, beforeDispatch);
  return result === undefined ? undefined : taskReference(client, input.requestId, result);
}

export async function callOpenApi(
  client: PoppyClient,
  company: Company,
  label: string,
  request: OpenApiTaskRequest,
  taskFiles: TaskFiles = TaskFiles.none(),
  domain = company.domain,
  beforeDispatch?: () => void
): Promise<Json> {
  const guard = requestGuard(client, company, label, bindingSnapshot(client, company, label), true, beforeDispatch);
  const replay = await replayOpenApiCall(client, domain, label, request, beforeDispatch);
  if (replay !== undefined) return replay;
  const checked = await CheckedApiRequest.check(client, company, {
    ...request,
    idempotencyKey: () => intent(client.sql, `idem|${request.callKey}`, () => crypto.randomUUID())
  });
  const ask = async () =>
    proposeLocal(
      client,
      company,
      label,
      checked.describe(),
      { kind: "openapi", call: checked.call, method: checked.method, url: checked.url, binding: guard.binding(), ...(checked.attachments.length ? { attachments: [...checked.attachments] } : {}) },
      intent(client.sql, `approval|${request.callKey}`, () => randomId("apr_"))
    );
  const requestId = intent(client.sql, `request|${request.callKey}`, () => randomId("req_"));
  if (!hasTaskCall(client, requestId)) rememberApiAliases(client, request, checked);
  if (checked.attachments.length && !hasTaskCall(client, requestId)) {
    const ids = checked.attachments.map(file => file.id).sort();
    const context = { issuer: company.issuer, label, ids, binding: guard.binding() };
    const task = JSON.stringify({ ...context, route: "task" });
    const consent = JSON.stringify({ ...context, route: "consent" });
    // Freeze the route and its files/authority synchronously, before either
    // path can yield while creating its durable record. A later selection
    // cannot turn a pending, declined or completed disclosure into a new send.
    const priorConsent = one(client.sql, intentsTable.pick("value"), "SELECT value FROM poppy_intents WHERE call_key = ?", `approval|${request.callKey}`);
    const route = intent(client.sql, `file-policy|${request.callKey}`, () => !priorConsent && taskFiles.includes(ids) ? task : consent);
    if (route !== task && route !== consent) throw new PoppyError("approval_changed", "This upload call already selected different files or authority. Nothing will be sent again.", 0);
    if (route === consent) {
      return { proposed: await ask(), note: "Waiting for the User to approve sending the file on a card; nothing has been sent yet." };
    }
  }
  // File disclosure always has a durable lifecycle, regardless of method hints.
  if (!checked.attachments.length && checked.method === "GET" && !hasTaskCall(client, requestId)) return answerForModel(await sendApi(client, label, checked, guard), company);
  const result = await dispatchTaskRequest(client, company, label, checked.describe(), {
    kind: "openapi", call: checked.call, method: checked.method, url: checked.url,
    binding: guard.binding(), ...(checked.attachments.length ? { attachments: [...checked.attachments] } : {})
  }, requestId, beforeDispatch);
  const input = apiInput(client, domain, label, request);
  intent(client.sql, input.key, () => input.value);
  rememberApiAliases(client, request, checked);
  return taskReference(client, requestId, result);
}

/**
 * An approved write: the stored call checked again, now, under today's rules
 * and description, and sent only if it still makes exactly the request the
 * card showed. An answer other than 2xx is an error the receipt names with
 * its status and code (operations.ts), never "done": the request was sent as
 * approved, and the Company didn't do it as far as it says. Nor is a
 * proposal we can't use.
 */
registerExecutor("openapi", async (client, company, approval, label, execution) => {
  if (!isTaskRequest(execution.approvalId) && !approval.call.approval && !Object.keys(approval.call.files ?? {}).length) {
    throw new PoppyError("approval_changed", "Preliminary API-write approvals are no longer supported. Ask for current Company terms.", 0);
  }
  const guard = executionGuard(client, company, label, approval.binding, execution);
  if (approval.call.approval && !approvable(approval.call.approval, Date.now())) throw expired(company);
  const checked = await CheckedApiRequest.check(client, company, approval.call);
  if (checked.method !== approval.method || checked.url !== approval.url) {
    throw new PoppyError(
      "approval_changed",
      `Not sent: ${company.name}'s description now makes this ${checked.method} ${checked.url}, not the ${approval.method} ${approval.url} you approved. Ask again to see the request it would make now.`,
      0
    );
  }
  const answer = await sendApi(client, label, checked, guard, execution.approvalId);
  if (answer.kind === "unusable") {
    throw withAnswer(new PoppyError("unusable_proposal", `${company.name} asked for approval of an operation the agent can't use, so nothing was done`, 403), 403);
  }
  // The Company wants the User's approval of its terms (Ops 4): nothing was done, and its card waits.
  if (answer.kind === "approval" && (!approval.call.approval ||
      answer.operation.operation_id !== approval.call.approval.operation_id || answer.operation.revision !== approval.call.approval.revision)) {
    throw new TermsRequested(`${company.name} asks you to approve its exact terms first, on the next card. Nothing has happened yet.`, answer.approvalId);
  }
  // An already-approved revision returned unchanged is a refusal, not a new card or a self-link.
  if (answer.kind === "approval") {
    throw withAnswer(new PoppyError("approval_required", `${company.name} asks for approval of new terms first, on a new card; nothing was done`, 403), 403);
  }
  if (answer.kind === "answered" && (answer.status < 200 || answer.status >= 300)) {
    const { status, body } = answer;
    const code = companyErrorCode(isObject(body) ? body.error : undefined, status);
    throw withAnswer(
      new PoppyError(code, `${company.name} answered ${status}: ${JSON.stringify(body).slice(0, 1_000)}`, status, body !== null ? { body } : {}),
      status
    );
  }
  if (answer.kind === "answered" && answer.status === 202) {
    throw new OperationOutcomeUnknown(`${company.name} accepted the approved request, but its action has not been confirmed. Check with the Company before approving further writes there.`);
  }
  return JSON.stringify(answerForModel(answer, company));
});

/** An approval whose revision expired before the User decided is never sent (Ops 3, "Expiry"). */
function expired(company: Company): PoppyError {
  return new PoppyError("approval_changed", `Not sent: ${company.name}'s terms expired before they were approved. Ask ${company.name} again for current terms.`, 0);
}

/**
 * The User's card for an operation (Ops 5): the Company's name and its
 * summary. One card per revision; the approved request is stored with it.
 */
async function proposeApproval(client: PoppyClient, company: Company, label: string, operation: OperationV2, asked: Json, approval: NewApproval, executingApproval?: string): Promise<string> {
  const revisionKey = await approvalCardId(company, operation);
  const source = executingApproval ? one(client.sql, approvalsTable.pick("request"), "SELECT request FROM poppy_approvals WHERE id = ?", executingApproval) : undefined;
  const saved = source ? readApproval(source.request) : undefined;
  const previous = saved?.ok && (saved.value.kind === "openapi" || saved.value.kind === "mcp") ? saved.value.call.approval : undefined;
  // An unchanged approved revision is a refusal, not a fresh decision. Every
  // new request/revision otherwise owns an immutable local decision ID, so a
  // delayed click cannot approve a later attempt that reused the same terms.
  const sameRevision = previous?.operation_id === operation.operation_id && previous.revision === operation.revision;
  const id = executingApproval ? sameRevision ? executingApproval
    : intent(client.sql, `terms|${executingApproval}|${revisionKey}`, () => randomId("apr2_")) : revisionKey;
  return proposeLocal(client, company, label, approvalSummary(company, operation), approval, id, approvalTerms(company, operation, asked), executingApproval);
}

/** An operation we can't show the User: nothing is approved, and they are told (Ops 5: never treat it as done). */
async function unusableApproval(client: PoppyClient, company: Company, problem: string): Promise<void> {
  await client.host.showCard({
    id: `approval-unusable-${company.issuer}-${randomId()}`,
    kind: "notice",
    company: company.name,
    domain: company.domain,
    open: true,
    text: `${company.name} asked for your approval, but its terms couldn't be used (${problem}), so nothing was done.`
  });
}

// ---------------------------------------------------------------- MCP

const MCP_VERSION = "2025-06-18";
type McpSession = { sessionId: string | null; tools: Json[] | null; expiresAt: number };
type McpState = {
  sessions: Map<string, McpSession>;
  initializing: Map<string, Promise<void>>;
  metadata: Map<string, Promise<{ expiresAt: number }>>;
  bindings: Map<string, { fingerprint: string; generation: number; key: string }>;
};
// Client-owned caches die with the client and its DPoP keys; no cross-user global session state.
const mcpClients = new WeakMap<PoppyClient, McpState>();
function mcpState(client: PoppyClient): McpState {
  let state = mcpClients.get(client);
  if (!state) mcpClients.set(client, (state = { sessions: new Map(), initializing: new Map(), metadata: new Map(), bindings: new Map() }));
  return state;
}

/**
 * An MCP server's protected resource metadata (RFC 9728), fetched without
 * redirects: its `resource` is exactly the server's `url`, and its
 * `authorization_servers` include the Company's issuer (7), or the server
 * isn't the Company's. Signed in, its token is one for that `resource`.
 */
async function checkResourceMetadata(client: PoppyClient, company: Company, api: Api): Promise<{ expiresAt: number }> {
  const url = new URL(api.url);
  const candidates = [
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`,
    `${url.origin}/.well-known/oauth-protected-resource`
  ];
  for (const candidate of candidates) {
    try {
      const { json, maxAgeSeconds } = await fetchJson(client.host.fetcher, candidate, { maxRedirects: 0 });
      if (isObject(json) && Array.isArray(json.authorization_servers)) {
        if (!json.authorization_servers.includes(company.issuer)) throw new PoppyError("bad_api", `${api.url} doesn't name ${company.issuer} as its authorization server`, 0);
        if (json.resource !== api.url) throw new PoppyError("bad_api", "MCP metadata resource must equal its exact URL", 0);
        return { expiresAt: Date.now() + boundedCacheSeconds(maxAgeSeconds) * 1000 };
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
  if (isObject(message.error)) throw withAnswer(new PoppyError("mcp_error", `MCP error: ${String(message.error.message ?? message.error.code)}`, response.status), response.status);
  return message.result ?? null;
}

async function mcpRequest(client: PoppyClient, company: Company, label: string, api: Api, method: string, params: Json, sessionKey: string, guard: DispatchGuard = {}): Promise<{ result: Json; sessionId: string | null }> {
  const sessions = mcpState(client).sessions;
  const session = sessions.get(sessionKey);
  const id = Math.floor(Math.random() * 1e9);
  // The protected-resource metadata selects DPoP or Bearer; each token names this URL.
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
    { label, resource: api.url, ...guard }
  );
  if (response.status === 404 && session?.sessionId) {
    sessions.delete(sessionKey);
    await response.body?.cancel();
    throw withAnswer(new PoppyError("mcp_session_expired", "The MCP session expired", 404), 404);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw withAnswer(new PoppyError(`http_${response.status}`, `${api.url} returned HTTP ${response.status}`, response.status), response.status);
  }
  let result: Json;
  try { result = await rpcResult(client, response, id); }
  catch (error) { throw method === "tools/call" && answerOf(error) === undefined ? withUnreadableAnswer(error, response.status) : error; }
  return { result, sessionId: response.headers.get("Mcp-Session-Id") };
}

async function mcpSession(client: PoppyClient, company: Company, label: string, api: Api, guard: DispatchGuard = {}): Promise<string> {
  const { sessions, initializing, metadata, bindings } = mcpState(client);
  const resourceKey = JSON.stringify([company.issuer, api.url, company.protocolVersion, company.specificationRevision, company.authFingerprint]);
  let loading = metadata.get(resourceKey);
  if (loading && (await loading).expiresAt <= Date.now()) loading = undefined;
  if (!loading) {
    loading = checkResourceMetadata(client, company, api);
    metadata.set(resourceKey, loading);
    void loading.catch(() => { if (metadata.get(resourceKey) === loading) metadata.delete(resourceKey); });
  }
  const mode = await loading;
  // Refresh credentials before choosing a cache entry: sign-in/account changes
  // must never reuse the previous account's MCP session or tool catalogue.
  await client.token(company, { label, resource: api.url });
  const bound = client.session(company.issuer, label);
  const slot = JSON.stringify([resourceKey, label]);
  const fingerprint = JSON.stringify([bound?.session_id, bound?.account, bound?.signed_in, bound?.authority_generation, bound?.scope]);
  let binding = bindings.get(slot);
  if (!binding || binding.fingerprint !== fingerprint) {
    // Returning to signed-out state must not resurrect a pre-sign-in session.
    // Generations also keep an older in-flight initialization out of the cache.
    if (binding) sessions.delete(binding.key);
    const generation = (binding?.generation ?? 0) + 1;
    binding = { fingerprint, generation, key: JSON.stringify([slot, fingerprint, generation]) };
    bindings.set(slot, binding);
  }
  const key = binding.key;
  const pending = initializing.get(key);
  if (pending) { await pending; return key; }
  const cached = sessions.get(key);
  if (cached && cached.expiresAt > Date.now()) return key;
  sessions.delete(key);
  const initialize = (async () => {
    sessions.set(key, { sessionId: null, tools: null, ...mode });
    try {
      const { sessionId } = await mcpRequest(client, company, label, api, "initialize", {
        protocolVersion: MCP_VERSION,
        capabilities: {},
        clientInfo: { name: client.identity.clientName, version: "0.1" }
      }, key, guard);
      sessions.set(key, { sessionId, tools: null, ...mode });
      const response = await client.resource(
        company,
        EndpointRequest.mcp(company, {
          method: "POST", url: api.url,
          body: { jsonrpc: "2.0", method: "notifications/initialized" },
          accept: "application/json, text/event-stream",
          headers: { "MCP-Protocol-Version": MCP_VERSION, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) }
        }),
        { label, resource: api.url, ...guard }
      );
      await response.body?.cancel();
      if (!response.ok) throw new PoppyError(`http_${response.status}`, "The MCP server refused initialization", response.status);
    } catch (error) {
      sessions.delete(key);
      throw error;
    }
  })();
  initializing.set(key, initialize);
  try { await initialize; } finally { initializing.delete(key); }
  return key;
}

export async function listMcpTools(client: PoppyClient, company: Company, label: string, apiUrl?: string, guard: DispatchGuard = {}): Promise<Json[]> {
  const api = findApi(company, "mcp", apiUrl);
  const key = await mcpSession(client, company, label, api, guard);
  const session = mcpState(client).sessions.get(key)!;
  if (!session.tools) {
    const { result } = await mcpRequest(client, company, label, api, "tools/list", {}, key, guard);
    session.tools = isObject(result) && Array.isArray(result.tools) ? result.tools : [];
  }
  return session.tools;
}

/**
 * Call an MCP tool: its arguments, and the User's approval in `_meta` when
 * the call repeats one that returned an operation (Ops 6).
 */
async function performMcp(
  client: PoppyClient,
  company: Company,
  label: string,
  call: { apiUrl: string; tool: string; args: Json; approval?: ApprovalV2 },
  guard: AuthorityGuard,
  executingApproval?: string
): Promise<Json> {
  const api = findApi(company, "mcp", call.apiUrl);
  if (call.approval && !approvable(call.approval, Date.now())) throw expired(company);
  const key = await mcpSession(client, company, label, api, guard).catch(error => { throw withoutAnswer(error); });
  // The same tool and arguments again, the approval in `_meta` (Ops 6).
  const params = { name: call.tool, arguments: call.args, ...(call.approval ? { _meta: { "personalagentprotocol.org/approval": approvalJson(call.approval) } } : {}) };
  const { result } = await mcpRequest(client, company, label, api, "tools/call", params, key, guard);
  // An error result carrying an operation is a request for the User's approval (Ops 4).
  if (company.extensions.operations && isObject(result) && result.isError === true && isObject(result.structuredContent) && result.structuredContent.operation !== undefined) {
    const operation = parseOperationV2(result.structuredContent.operation);
    if ("problem" in operation) {
      await unusableApproval(client, company, operation.problem);
      return { unusable: true, note: UNUSABLE };
    }
    const approvalId = await proposeApproval(client, company, label, operation, call.args, {
      kind: "mcp",
      call: { apiUrl: api.url, tool: call.tool, args: call.args, approval: { operation_id: operation.operation_id, revision: operation.revision, expires_at: operation.expires_at } },
      binding: guard.binding()
    }, executingApproval);
    return approvalForModel(company, operation, 200, approvalId);
  }
  if (isObject(result) && result.isError === true) throw withAnswer(new PoppyError("mcp_error", `The MCP tool reported an error: ${JSON.stringify(result).slice(0, 1_000)}`, 200), 200);
  return result;
}

/**
 * Call an MCP tool. A tool marked `readOnlyHint` goes straight through, as an
 * OpenAPI GET does: it is the Company's own server saying the call changes
 * nothing (our reading, docs/readings.md). Other task calls are recorded
 * before dispatch; only terms the Company returns ask for confirmation.
 */
export async function callMcpTool(
  client: PoppyClient,
  company: Company,
  label: string,
  request: { apiUrl?: string; tool: string; args: Json; callKey?: string }
): Promise<Json> {
  const api = findApi(company, "mcp", request.apiUrl);
  const guard = requestGuard(client, company, label, bindingSnapshot(client, company, label), true);
  const tools = await listMcpTools(client, company, label, api.url, guard);
  const tool = tools.find((item) => isObject(item) && item.name === request.tool);
  if (!isObject(tool)) throw new PoppyError("no_tool", `${api.url} has no tool ${request.tool}`, 0);
  checkMcpArgs(company, request.tool, tool.inputSchema, request.args);
  const readOnly = isObject(tool.annotations) && tool.annotations.readOnlyHint === true;
  const call = { apiUrl: api.url, tool: request.tool, args: request.args };
  const requestId = request.callKey ? intent(client.sql, `request|${request.callKey}`, () => randomId("req_")) : randomId("req_");
  // Today's annotation cannot turn replay of a recorded write into a new call.
  if (readOnly && !hasTaskCall(client, requestId)) return performMcp(client, company, label, call, guard);
  return dispatchTaskRequest(client, company, label, `${company.name}: run ${request.tool} with ${JSON.stringify(request.args)}`, {
    kind: "mcp", call, binding: guard.binding()
  }, requestId);
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
registerExecutor("mcp", async (client, company, approval, label, execution) => {
  if (!isTaskRequest(execution.approvalId) && !approval.call.approval) {
    throw new PoppyError("approval_changed", "Preliminary MCP approvals are no longer supported. Ask for current Company terms.", 0);
  }
  const guard = executionGuard(client, company, label, approval.binding, execution);
  const result = await performMcp(client, company, label, approval.call, guard, execution.approvalId);
  // The tool answered with an operation (Ops 4): its card waits, and nothing was done.
  if (isObject(result) && isObject(result.approval_required) && typeof result.proposed === "string") {
    if (approval.call.approval && result.approval_required.operation_id === approval.call.approval.operation_id &&
        result.approval_required.revision === approval.call.approval.revision) {
      throw withAnswer(new PoppyError("approval_required", `${company.name} returned terms that were already approved, so the request was not completed`, 200), 200);
    }
    throw new TermsRequested(`${company.name} asks you to approve its exact terms first, on the next card. Nothing has happened yet.`, result.proposed);
  }
  return JSON.stringify(result);
});


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
