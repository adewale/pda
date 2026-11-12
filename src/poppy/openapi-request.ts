/** A validated OpenAPI request, including destination, parameters and attachments. */
import { type Company, tokenHostAllowed, protocolEndpoint } from "./discovery";
import { type OpenApiOperation, type OpenApiCall, openApi, findOperation } from "./openapi-document";
import { PoppyError, scopeSet, PoppyClient } from "./client";
import { type Api, findApi } from "./api-authority";
import { assertPublicHost } from "./fetch";
import { type AttachmentInfo, attachmentInfo, humanSize, readAttachment } from "../attachments";
import { type Sql } from "./store";
import { type RequestInit } from "./outgoing";
import { approvalHeader, type ApprovalToSend } from "./operations-v2";
import { isObject, type Json } from "./json";
import { checkParams, checkBody } from "./api-schema";

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

/**
 * The narrower scope a read-only lookup asks for (Guides), or null to use
 * the Session's: the scopes the operation declares, if the signed-in
 * Session holds them all and more besides. Poppy defines no scopes (4.7), so
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
export function given(params: OpenApiCall["params"], name: string): OpenApiCall["params"][string] | undefined {
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
 * The server of a description `poppy.json` lists is a Session destination:
 * 5.2 names "the request URLs its listed APIs describe", and every listed
 * API MUST accept the Session header and access tokens (7), wherever it is
 * hosted. Over HTTPS (3), and, off the Company's own hosts, never a
 * loopback, private or link-local address (3).
 */
function refuseServer(company: Company, api: Api, url: URL): void {
  if (url.protocol !== "https:") throw new PoppyError("invalid_request", "Refusing a non-HTTPS URL", 0);
  if (tokenHostAllowed(company, url)) return;
  try {
    assertPublicHost(url);
  } catch {
    throw new PoppyError("untrusted_server", `${api.url} names the server ${url.origin}, which isn't a public host, so the agent won't send it its Session header or tokens`, 0);
  }
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
    /** The server the listed description names, which makes `url` a Session destination (5.2). */
    readonly describedServer: string,
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
      readonly approval?: ApprovalToSend;
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
    const checked = new CheckedApiRequest(client.sql, () => client.host.now(), company, api, op, call, url.href, document.base, files ? uploadedFiles(client, company, op, files) : [], identifiers);
    // A JSON body (not a form's fields) is checked against the operation's schema.
    if (!checked.multipart) checkBody(company, op, call.body);
    return checked;
  }
}
