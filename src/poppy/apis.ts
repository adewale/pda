import { Validator, type OutputUnit } from "@cfworker/json-schema";
import { attachmentInfo, humanSize, readAttachment, type AttachmentInfo } from "../attachments";
import { PoppyClient, PoppyError, scopeSet, withAnswer } from "./client";
import { boundedCacheSeconds, protocolEndpoint, tokenHostAllowed, type Company } from "./discovery";
import { fetchJson } from "./fetch";
import { isObject, parseStrictJson, type Json } from "./json";
import { handleProposal, proposeLocal, refuseWhileConfirming, registerExecutor, rememberProposal } from "./operations";
import { randomId } from "./jwt";
import { firstTime, intent } from "./store";

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
    validator.addSchema(spec.root as never, BODY_BASE);
    errors = validator.validate(body).errors;
  } catch {
    return;
  }
  if (errors.length === 0) return;
  if (typeof body === "string" && /^\s*[{[]/.test(body)) {
    let parsed: Json | undefined;
    try {
      parsed = JSON.parse(body) as Json;
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && typeof parsed === "object") {
      throw new PoppyError(
        "invalid_body",
        `body for ${op.operationId} at ${company.name} must be the JSON value itself, such as {"product": "prints"}, not a string containing serialised JSON: pass body as a structured object. Nothing was sent.`,
        0
      );
    }
  }
  // The leaves: the wrappers ($ref, properties, allOf…) only say a child failed.
  const leaves = errors.filter((unit) => !/subschema had errors|does not match schema|did not match/i.test(unit.error));
  const shown = (leaves.length ? leaves : errors).slice(0, 5).map((unit) => `${unit.instanceLocation.replace(/^#/, "body") || "body"}: ${unit.error}`);
  throw new PoppyError(
    "invalid_body",
    `body for ${op.operationId} at ${company.name} doesn't match its request schema: ${shown.join("; ")}. See its requestBody in poppy_api_describe. Nothing was sent.`,
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
                  ...(parameter.schema !== undefined ? { schema: resolveRef(json, parameter.schema) } : {}),
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
            (parameter) => !(parameter.in === "header" && (/^idempotency-key$/i.test(parameter.name) || TRANSPORT_HEADERS.test(parameter.name)))
          ),
          // Written out, so poppy_api_describe shows the fields to send, not a bare $ref.
          ...(requestBody !== undefined ? { requestBody: inlineRefs(json, requestBody) } : {}),
          ...(upload ? { upload } : {}),
          acceptsIdempotencyKey: parameters.some((parameter) => parameter.in === "header" && /^idempotency-key$/i.test(parameter.name)),
          proposes: proposesOperation(json, op),
          scopes: declaredScopes(op.security ?? json.security),
          outsidePoppy: outsidePoppySession(dpop, method.toUpperCase(), op.security ?? json.security),
          ...(jsonBody ? { jsonBody } : {})
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
    parameters: op.parameters as unknown as Json,
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

type OpenApiCall = {
  readonly apiUrl: string;
  readonly operation: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly body?: Json;
  /** File fields of a `multipart/form-data` upload, each an attachment id; never the bytes. */
  readonly files?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
};

/**
 * A `multipart/form-data` body: `body`'s members as text fields, and each
 * file field the stored attachment it names, with its name and type. The
 * bytes are read here, as the request is made, never earlier.
 */
function multipartBody(client: PoppyClient, call: OpenApiCall): FormData {
  const form = new FormData();
  if (isObject(call.body ?? null)) {
    for (const [name, value] of Object.entries(call.body as Record<string, Json>)) {
      if (value !== null && value !== undefined) form.append(name, typeof value === "string" ? value : JSON.stringify(value));
    }
  }
  for (const [field, id] of Object.entries(call.files ?? {})) {
    const found = readAttachment(client.sql, id);
    if (!found) throw new PoppyError("no_attachment", `The User's attachment ${id} is gone (deleted, or past its 30 days), so nothing was sent`, 0);
    form.append(field, new Blob([found.bytes], { type: found.info.type }), found.info.name);
  }
  return form;
}

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
 * The description's server, if it is one of the Company's hosts: `servers`
 * can name any host, and Session Tokens (and the User's files) go only to the
 * Company's (N10).
 */
function serverOf(company: Company, api: Api, document: OpenApiDocument): URL {
  const url = new URL(document.base);
  if (!tokenHostAllowed(company, url)) {
    throw new PoppyError(
      "untrusted_server",
      `${api.url} names the server ${url.origin}, which isn't one of ${company.name}'s hosts (not listed in its poppy.json, nor under ${company.domain} or its poppy_domains), so the agent won't send it a Session Token`,
      0
    );
  }
  return url;
}

async function performOpenApi(client: PoppyClient, company: Company, label: string, call: OpenApiCall): Promise<Json> {
  const api = findApi(company, "openapi", call.apiUrl);
  const document = await openApi(client, api);
  const op = findOperation(document, call.operation);
  // Checked again as the request is made: a card shown before this check existed may still be approved.
  refuseOutsidePoppy(company, op);
  const url = serverOf(company, api, document);
  const path = pathFor(op, call.params);
  for (const parameter of op.parameters) {
    const value = given(call.params, parameter.name);
    if (parameter.in === "query" && value !== undefined) url.searchParams.set(parameter.name, String(value));
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  refuseProtocolEndpoint(company, url);
  // Read-only lookups ask for a read-only token when the account allows (Guides).
  const write =
    op.method === "GET"
      ? null
      : `${op.method} ${url.href} ${JSON.stringify(call.body ?? null)}${call.files ? ` ${JSON.stringify(call.files)}` : ""}`;
  if (write) refuseWhileConfirming(client, company.issuer, write);
  const readOnly = op.method === "GET" ? readOnlyScope(client.session(company.issuer, label)?.scope, op) : null;
  // An upload, or an operation that takes only multipart/form-data, sends a form; anything else JSON.
  const form = call.files || (op.upload && !op.upload.json && call.body !== undefined) ? multipartBody(client, call) : null;
  const response = await client.resource(
    company,
    {
      method: op.method,
      url: url.href,
      ...(form ? { form } : call.body !== undefined ? { body: call.body } : {}),
      ...(call.idempotencyKey ? { headers: { "Idempotency-Key": call.idempotencyKey } } : {})
    },
    {
      label,
      ...(api.resource ? { resource: api.resource } : {}),
      ...(readOnly ? { scope: readOnly } : {})
    }
  );
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
    if (operation) {
      if (write) rememberProposal(client, company.issuer, write, operation.operation_id);
      return { status: 202, proposed: { operation_id: operation.operation_id, revision: operation.revision, summary: operation.summary }, note: "Nothing has happened yet; the User decides on the approval card." };
    }
    return { status: 202, unusable: true, note: UNUSABLE, body };
  }
  return { status: response.status, body };
}

const UNUSABLE = "The Company proposed an operation the agent can't use, so nothing was done and nothing can be approved; the User has been told.";

/**
 * Call an OpenAPI operation with a DPoP Session Token. Reads go straight
 * through. A write goes straight to the Company only when it has the
 * Operations extension and the description says this operation answers with
 * a proposal (`proposes`); any other write, and every upload, waits for the
 * User's approval on our own card first, fixed per tool call. A write sent
 * straight through carries a stored `Idempotency-Key` where the API accepts
 * one; where it doesn't, it is sent at most once per tool call, so a replay
 * after a crash says so instead of sending it again.
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
  const api = findApi(company, "openapi", request.apiUrl);
  const document = await openApi(client, api);
  const op = findOperation(document, request.operation);
  // A call that can't fill the path, one that would reach a Poppy endpoint,
  // or a write outside the Poppy Session is refused now, before a token
  // request or an approval card.
  refuseProtocolEndpoint(company, new URL(`${document.base}${pathFor(op, request.params ?? {})}`));
  refuseOutsidePoppy(company, op);
  const files = request.files && Object.keys(request.files).length ? request.files : undefined;
  // A JSON body (not a form's fields) is checked against the operation's schema, before a card.
  if (!(files || (op.upload && !op.upload.json && request.body !== undefined))) checkBody(company, op, request.body);
  // A file the User would be asked to send must be one we'd send: to the Company's own host, checked before the card.
  if (files) serverOf(company, api, document);
  const attached = files ? uploadedFiles(client, company, op, files) : [];
  const call: OpenApiCall = {
    apiUrl: api.url,
    operation: op.operationId,
    params: request.params ?? {},
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(files ? { files } : {}),
    ...(op.method !== "GET" && op.acceptsIdempotencyKey
      ? { idempotencyKey: intent(client.sql, `idem|${request.callKey}`, () => crypto.randomUUID()) }
      : {})
  };
  if (files) {
    // The User's photo leaves their agent only when they say so, at any Company:
    // the Operations extension covers what a Company does, not what we send it.
    const names = attached.map((info) => `“${info.name}” (${info.type.replace("image/", "").toUpperCase()}, ${humanSize(info.size)})`).join(" and ");
    const id = await proposeLocal(
      client,
      company,
      label,
      "openapi",
      `Send your ${attached.length === 1 ? "photo" : "photos"} ${names} to ${company.name}: ${op.method} ${op.path} (${op.summary || op.operationId})${request.body !== undefined ? ` with ${JSON.stringify(request.body)}` : ""}`,
      { issuer: company.issuer, call } as unknown as Json,
      { id: intent(client.sql, `approval|${request.callKey}`, () => randomId("apr_")), attachments: attached }
    );
    return { proposed: id, note: "Waiting for the User to approve sending the file on a card; nothing has been sent yet." };
  }
  if (op.method === "GET") return performOpenApi(client, company, label, call);
  if (company.extensions.operations && op.proposes) {
    if (!call.idempotencyKey && !firstTime(client.sql, `sent|${request.callKey}`)) {
      throw new PoppyError(
        "interrupted",
        `This call to ${company.name} was interrupted after it may have been sent, and the operation takes no Idempotency-Key, so it isn't sent again. Check poppy_status for a proposal from ${company.name} before asking again.`,
        0
      );
    }
    return performOpenApi(client, company, label, call);
  }
  const id = await proposeLocal(
    client,
    company,
    label,
    "openapi",
    `${company.name}: ${op.method} ${op.path} (${op.summary || op.operationId}) with ${JSON.stringify({ params: call.params, body: call.body ?? null })}`,
    { issuer: company.issuer, call } as unknown as Json,
    { id: intent(client.sql, `approval|${request.callKey}`, () => randomId("apr_")) }
  );
  return { proposed: id, note: "Waiting for the User's approval on a card; nothing has happened yet." };
}

/**
 * The attachments an upload names, checked before anything is asked or sent:
 * the operation takes `multipart/form-data`, each field is one of its file
 * fields, each id is an attachment this agent holds, and every required file
 * field is given.
 */
function uploadedFiles(client: PoppyClient, company: Company, op: OpenApiOperation, files: Record<string, string>): AttachmentInfo[] {
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
    const info = attachmentInfo(client.sql, id);
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
 * An approved write. An answer other than 2xx is an error the receipt names
 * with its status and code (operations.ts), never "done": the request was
 * sent as approved, and the Company didn't do it as far as it says.
 */
registerExecutor("openapi", async (client, request, label) => {
  const { issuer, call } = request as unknown as { issuer: string; call: OpenApiCall };
  const company = client.companyByIssuer(issuer);
  const result = await performOpenApi(client, company, label, call);
  const status = isObject(result) && typeof result.status === "number" ? result.status : 200;
  if (status < 200 || status >= 300) {
    const body = isObject(result) ? (result.body ?? null) : null;
    const code = isObject(body) && typeof body.error === "string" ? body.error : `http_${status}`;
    throw withAnswer(
      new PoppyError(code, `${company.name} answered ${status}: ${JSON.stringify(body).slice(0, 1_000)}`, status, body !== null ? { body } : {}),
      status
    );
  }
  return JSON.stringify(result).slice(0, 2_000);
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
    {
      method: "POST",
      url: api.url,
      body: { jsonrpc: "2.0", id, method, params },
      accept: "application/json, text/event-stream",
      headers: {
        "MCP-Protocol-Version": MCP_VERSION,
        ...(session?.sessionId ? { "Mcp-Session-Id": session.sessionId } : {})
      }
    },
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
    {
      method: "POST",
      url: api.url,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      accept: "application/json, text/event-stream",
      headers: { "MCP-Protocol-Version": MCP_VERSION, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) }
    },
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
  const readOnly = isObject(tool.annotations) && tool.annotations.readOnlyHint === true;
  const call = { apiUrl: api.url, tool: request.tool, args: request.args };
  if (readOnly || (company.extensions.operations && mcpToolProposes(tool))) return performMcp(client, company, label, call);
  const id = await proposeLocal(client, company, label, "mcp", `${company.name}: run ${request.tool} with ${JSON.stringify(request.args)}`, { issuer: company.issuer, call } as unknown as Json);
  return { proposed: id, note: "Waiting for the User's approval on a card; nothing has happened yet." };
}

registerExecutor("mcp", async (client, request, label) => {
  const { issuer, call } = request as unknown as { issuer: string; call: { apiUrl: string; tool: string; args: Json } };
  const result = await performMcp(client, client.companyByIssuer(issuer), label, call);
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
