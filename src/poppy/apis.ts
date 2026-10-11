import { PoppyClient, PoppyError } from "./client";
import type { Company } from "./discovery";
import { fetchJson, readLimited } from "./fetch";
import { isObject, parseStrictJson, type Json } from "./json";
import { handleProposal, proposeLocal, registerExecutor } from "./operations";
import { intent } from "./store";

type Api = Company["apis"][number];

export function findApi(company: Company, type: Api["type"], url?: string): Api {
  const matches = company.apis.filter((api) => api.type === type && (!url || api.url === url));
  if (matches.length === 0) throw new PoppyError("no_api", `${company.name} lists no ${type} API${url ? ` at ${url}` : ""}`, 0);
  return matches[0]!;
}

// ---------------------------------------------------------------- OpenAPI

type OpenApiOperation = {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly parameters: readonly { name: string; in: string; required: boolean; schema?: Json; description?: string }[];
  readonly requestBody?: Json;
  readonly acceptsIdempotencyKey: boolean;
};

type OpenApiDocument = { readonly base: string; readonly operations: readonly OpenApiOperation[] };

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
        operations.push({
          operationId: typeof op.operationId === "string" ? op.operationId : `${method.toUpperCase()} ${path}`,
          method: method.toUpperCase(),
          path,
          summary: [op.summary, op.description].filter((text) => typeof text === "string").join(" — "),
          parameters: parameters.filter((parameter) => !(parameter.in === "header" && /^idempotency-key$/i.test(parameter.name))),
          ...(requestBody !== undefined ? { requestBody } : {}),
          acceptsIdempotencyKey: parameters.some((parameter) => parameter.in === "header" && /^idempotency-key$/i.test(parameter.name))
        });
      }
    }
  }
  const document = { base, operations };
  documents.set(api.url, { document, expiresAt: Date.now() + Math.min(86_400, Math.max(60, maxAgeSeconds ?? 300)) * 1000 });
  return document;
}

function findOperation(document: OpenApiDocument, name: string): OpenApiOperation {
  const found = document.operations.find((op) => op.operationId === name || `${op.method} ${op.path}` === name);
  if (!found) throw new PoppyError("no_operation", `The API has no operation ${name}`, 0);
  return found;
}

/** A compact description of an API's operations, or one operation's inputs. */
export async function describeOpenApi(client: PoppyClient, company: Company, apiUrl: string | undefined, name?: string): Promise<Json> {
  const api = findApi(company, "openapi", apiUrl);
  const document = await openApi(client, api);
  if (!name) {
    return {
      api: api.url,
      description: api.description,
      operations: document.operations.map((op) => ({ operation: op.operationId, method: op.method, path: op.path, summary: op.summary }))
    };
  }
  const op = findOperation(document, name);
  return {
    operation: op.operationId,
    method: op.method,
    path: op.path,
    summary: op.summary,
    parameters: op.parameters as unknown as Json,
    ...(op.requestBody !== undefined ? { requestBody: op.requestBody } : {})
  };
}

type OpenApiCall = {
  readonly apiUrl: string;
  readonly operation: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly body?: Json;
  readonly idempotencyKey?: string;
};

async function performOpenApi(client: PoppyClient, company: Company, label: string, call: OpenApiCall): Promise<Json> {
  const api = findApi(company, "openapi", call.apiUrl);
  const document = await openApi(client, api);
  const op = findOperation(document, call.operation);
  let path = op.path;
  const url = new URL(document.base);
  for (const parameter of op.parameters) {
    const value = call.params[parameter.name];
    if (value === undefined) {
      if (parameter.required) throw new PoppyError("invalid_request", `Missing parameter ${parameter.name}`, 0);
      continue;
    }
    if (parameter.in === "path") path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
    else if (parameter.in === "query") url.searchParams.set(parameter.name, String(value));
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  // Read-only lookups ask for a read-only token when the account allows (Guides).
  const session = client.session(company.issuer, label);
  const readOnly = op.method === "GET" && session?.signed_in && session.scope.split(" ").includes("poppy:read") && session.scope !== "poppy:read";
  const response = await client.resource(
    company,
    {
      method: op.method,
      url: url.href,
      ...(call.body !== undefined ? { body: call.body } : {}),
      ...(call.idempotencyKey ? { headers: { "Idempotency-Key": call.idempotencyKey } } : {})
    },
    {
      label,
      ...(api.resource ? { resource: api.resource } : {}),
      ...(readOnly ? { scope: "poppy:read" } : {})
    }
  );
  const text = await readLimited(response, 2_000_000);
  let body: Json = null;
  try {
    body = text ? parseStrictJson(text) : null;
  } catch {
    body = text.slice(0, 4_000);
  }
  if (response.status === 403 && isObject(body) && body.error === "extension_required") {
    throw new PoppyError("extension_required", `${company.name} requires the extension ${String(body.extension)}, which this agent doesn't support`, 403);
  }
  // An endpoint that would perform an action proposes an operation instead (Ops 4.1).
  if (response.status === 202 && isObject(body) && isObject(body.operation)) {
    const operation = await handleProposal(client, company, label, body.operation);
    if (operation) {
      return { status: 202, proposed: { operation_id: operation.operation_id, revision: operation.revision, summary: operation.summary }, note: "Nothing has happened yet; the User decides on the approval card." };
    }
  }
  return { status: response.status, body };
}

/**
 * Call an OpenAPI operation with a DPoP Session Token. Reads go straight
 * through. Writes get a stored `Idempotency-Key` where the API accepts one;
 * at a Company without the operations extension they wait for the User's
 * approval first.
 */
export async function callOpenApi(
  client: PoppyClient,
  company: Company,
  label: string,
  request: { apiUrl?: string; operation: string; params?: Record<string, string | number | boolean>; body?: Json; callKey: string }
): Promise<Json> {
  const api = findApi(company, "openapi", request.apiUrl);
  const op = findOperation(await openApi(client, api), request.operation);
  const call: OpenApiCall = {
    apiUrl: api.url,
    operation: op.operationId,
    params: request.params ?? {},
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(op.method !== "GET" && op.acceptsIdempotencyKey
      ? { idempotencyKey: intent(client.sql, `idem|${request.callKey}`, () => crypto.randomUUID()) }
      : {})
  };
  if (op.method === "GET" || company.extensions.operations) {
    return performOpenApi(client, company, label, call);
  }
  const id = await proposeLocal(client, company, label, "openapi", `${company.name}: ${op.method} ${op.path} (${op.summary || op.operationId}) with ${JSON.stringify({ params: call.params, body: call.body ?? null })}`, { issuer: company.issuer, call } as unknown as Json);
  return { proposed: id, note: "Waiting for the User's approval on a card; nothing has happened yet." };
}

registerExecutor("openapi", async (client, request, label) => {
  const { issuer, call } = request as unknown as { issuer: string; call: OpenApiCall };
  const result = await performOpenApi(client, client.companyByIssuer(issuer), label, call);
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
async function rpcResult(response: Response, id: number): Promise<Json> {
  const type = response.headers.get("Content-Type") ?? "";
  const text = await readLimited(response, 2_000_000);
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
    throw new PoppyError("mcp_session_expired", "The MCP session expired", 404);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PoppyError(`http_${response.status}`, `${api.url} returned HTTP ${response.status}`, response.status);
  }
  return { result: await rpcResult(response, id), sessionId: response.headers.get("Mcp-Session-Id") };
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
  const key = await mcpSession(client, company, label, api);
  const { result } = await mcpRequest(client, company, label, api, "tools/call", { name: call.tool, arguments: call.args }, key);
  if (isObject(result) && isObject(result.structuredContent) && isObject(result.structuredContent.operation)) {
    const operation = await handleProposal(client, company, label, result.structuredContent.operation);
    if (operation) {
      return { proposed: { operation_id: operation.operation_id, revision: operation.revision, summary: operation.summary }, note: "Nothing has happened yet; the User decides on the approval card." };
    }
  }
  return result;
}

/**
 * Call an MCP tool. Tools marked `readOnlyHint` go straight through; others
 * wait for the User's approval at a Company without the operations
 * extension, as with OpenAPI writes.
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
  if (readOnly || company.extensions.operations) return performMcp(client, company, label, call);
  const id = await proposeLocal(client, company, label, "mcp", `${company.name}: run ${request.tool} with ${JSON.stringify(request.args)}`, { issuer: company.issuer, call } as unknown as Json);
  return { proposed: id, note: "Waiting for the User's approval on a card; nothing has happened yet." };
}

export async function isReadOnlyMcpTool(client: PoppyClient, company: Company, label: string, apiUrl: string | undefined, toolName: string): Promise<boolean> {
  const tools = await listMcpTools(client, company, label, apiUrl);
  const tool = tools.find((item) => isObject(item) && item.name === toolName);
  return isObject(tool) && isObject(tool.annotations) && tool.annotations.readOnlyHint === true;
}

registerExecutor("mcp", async (client, request, label) => {
  const { issuer, call } = request as unknown as { issuer: string; call: { apiUrl: string; tool: string; args: Json } };
  const result = await performMcp(client, client.companyByIssuer(issuer), label, call);
  return JSON.stringify(result).slice(0, 2_000);
});

