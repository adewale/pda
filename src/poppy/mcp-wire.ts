/**
 * MCP's wire format in the two versions section 7 names: 2025-06-18, whose
 * `initialize` opens an MCP session that later requests carry, and
 * 2026-07-28, which has no session and carries its version and the client's
 * metadata in every request's `_meta`, mirrored into HTTP headers. These are
 * pure functions: what a request carries, how a mirrored value is encoded,
 * which tools are usable, and what a refusal says about the server's era.
 * The lifecycle that uses them is in apis.ts; the choices the MCP text
 * leaves open are in docs/readings.md.
 */
import { isProtocolErrorCode } from "./error-codes";
import { isObject, type Json } from "./json";

/** The legacy version: `initialize`, then `Mcp-Session-Id` and `MCP-Protocol-Version` on every later request. */
export const MCP_LEGACY = "2025-06-18";
/** The modern version: no handshake or session; `_meta` and its mirrored headers on every request. */
export const MCP_MODERN = "2026-07-28";

/** Which lifecycle a server speaks (MCP 2026-07-28 Versioning, "Terminology"). */
export type McpEra = "modern" | "legacy";

/** The `_meta` keys MCP 2026-07-28 reserves for each request's protocol fields (Base Protocol, "_meta"). */
export const MCP_META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities"
} as const;

/** MCP's own error codes for a 2026-07-28 server refusing a request (Base Protocol, "Error Codes"). */
export const HEADER_MISMATCH = -32020;
export const MISSING_CLIENT_CAPABILITY = -32021;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const MODERN_CODES: ReadonlySet<number> = new Set([HEADER_MISMATCH, MISSING_CLIENT_CAPABILITY, UNSUPPORTED_PROTOCOL_VERSION]);

/**
 * The protocol fields of a 2026-07-28 request: the version, who the client
 * is, and its capabilities, which are none: it takes no sampling,
 * elicitation or roots requests, so a server may not ask for them.
 */
export function modernMeta(clientName: string): Record<string, Json> {
  return {
    [MCP_META.protocolVersion]: MCP_MODERN,
    [MCP_META.clientInfo]: { name: clientName, version: "0.1" },
    [MCP_META.clientCapabilities]: {}
  };
}

/** The headers a 2026-07-28 request mirrors from its body (Streamable HTTP, "Request Metadata"). */
export function modernHeaders(method: string, params: Readonly<Record<string, Json>>, parameters: Readonly<Record<string, string>> = {}): Record<string, string> {
  const name = method === "tools/call" || method === "prompts/get" ? params.name : method === "resources/read" ? params.uri : undefined;
  return {
    "MCP-Protocol-Version": MCP_MODERN,
    "Mcp-Method": method,
    ...(typeof name === "string" ? { "Mcp-Name": mirroredValue(name) } : {}),
    ...parameters
  };
}

/** The headers a request in a 2025-06-18 session carries. `initialize` has no session yet. */
export function legacyHeaders(sessionId: string | null): Record<string, string> {
  return { "MCP-Protocol-Version": MCP_LEGACY, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) };
}

const PLAIN = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

/**
 * A value as a mirrored header carries it (Streamable HTTP, "Value
 * Encoding"): as it is when it is visible ASCII with no surrounding space,
 * else Base64 of its UTF-8 between `=?base64?` and `?=`, as is anything that
 * already looks like that, so no value can add a header or change one.
 */
export function mirroredValue(value: string): string {
  if (PLAIN.test(value) && !(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return `=?base64?${btoa(binary)}?=`;
}

/** An argument a tool mirrors into `Mcp-Param-{header}`, found at `path` through `properties`. */
export type HeaderParameter = { readonly header: string; readonly path: readonly string[] };

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRIMITIVE = new Set(["string", "integer", "boolean"]);
/** Keywords whose values are schemas, or lists or maps of them; `x-mcp-header` under any of them is invalid. */
const SCHEMA_IN = ["items", "additionalItems", "contains", "additionalProperties", "unevaluatedItems", "unevaluatedProperties", "propertyNames", "not", "if", "then", "else"];
const SCHEMAS_IN = ["allOf", "anyOf", "oneOf"];
const SCHEMA_MAPS_IN = ["$defs", "definitions", "patternProperties", "dependentSchemas"];

/**
 * A tool's `x-mcp-header` parameters (Streamable HTTP, "Custom Headers from
 * Tool Parameters"), or why the tool is invalid: a name that isn't an HTTP
 * token or repeats another, ignoring case; a parameter that isn't a string,
 * integer or boolean; or an annotation reached through anything but
 * `properties` from the root. A client MUST leave such a tool out of its list.
 */
export function headerParameters(inputSchema: Json | undefined): { readonly parameters: readonly HeaderParameter[] } | { readonly problem: string } {
  const parameters: HeaderParameter[] = [];
  const seen = new Set<string>();
  const found: { problem: string | null } = { problem: null };
  const visit = (schema: Json | undefined, path: readonly string[] | null) => {
    if (found.problem || !isObject(schema)) return;
    const header = schema["x-mcp-header"];
    if (header !== undefined) {
      if (!path || path.length === 0) found.problem = "x-mcp-header on a schema that isn't reached through properties alone";
      else if (typeof header !== "string" || !TOKEN.test(header)) found.problem = `x-mcp-header ${JSON.stringify(header)} isn't an HTTP token`;
      else if (seen.has(header.toLowerCase())) found.problem = `x-mcp-header ${header} appears twice`;
      else if (typeof schema.type !== "string" || !PRIMITIVE.has(schema.type)) found.problem = `x-mcp-header ${header} is on a parameter that isn't a string, integer or boolean`;
      else {
        seen.add(header.toLowerCase());
        parameters.push({ header, path });
      }
    }
    if (isObject(schema.properties)) {
      for (const [name, child] of Object.entries(schema.properties)) visit(child, path ? [...path, name] : null);
    }
    for (const keyword of SCHEMA_IN) visit(schema[keyword], null);
    for (const keyword of SCHEMAS_IN) {
      const list = schema[keyword];
      if (Array.isArray(list)) for (const child of list) visit(child, null);
    }
    for (const keyword of SCHEMA_MAPS_IN) {
      const map = schema[keyword];
      if (isObject(map)) for (const child of Object.values(map)) visit(child, null);
    }
    const items = schema.items;
    if (Array.isArray(items)) for (const child of items) visit(child, null);
    const prefix = schema.prefixItems;
    if (Array.isArray(prefix)) for (const child of prefix) visit(child, null);
  };
  visit(inputSchema, []);
  return found.problem ? { problem: found.problem } : { parameters };
}

/** The tools a 2026-07-28 client may offer: those whose `x-mcp-header` annotations are valid. */
export function usableTools(tools: readonly Json[]): Json[] {
  return tools.filter((tool) => isObject(tool) && "parameters" in headerParameters(tool.inputSchema));
}

/**
 * The `Mcp-Param-*` headers for a call's arguments: each annotated value
 * that is present, as its string (an integer in decimal, a boolean as
 * `true` or `false`), encoded. Null when a value can't be carried, which the
 * tool's schema would have refused.
 */
export function parameterHeaders(parameters: readonly HeaderParameter[], args: Json): Record<string, string> | null {
  const headers: Record<string, string> = {};
  for (const { header, path } of parameters) {
    let value: Json | undefined = args;
    for (const key of path) value = isObject(value) ? value[key] : undefined;
    if (value === undefined || value === null) continue;
    if (typeof value === "string") headers[`Mcp-Param-${header}`] = mirroredValue(value);
    else if (typeof value === "boolean") headers[`Mcp-Param-${header}`] = String(value);
    else if (typeof value === "number" && Number.isSafeInteger(value)) headers[`Mcp-Param-${header}`] = String(value);
    else return null;
  }
  return headers;
}

/**
 * What a refused request's answer says about the server's era (Streamable
 * HTTP, "Backward Compatibility"):
 *
 * - `unsupported`: an `UnsupportedProtocolVersionError`, with the versions
 *   the server does speak. A 2026-07-28 server, or one answering `initialize`.
 * - `modern`: another of 2026-07-28's own errors (a header mismatch, a
 *   missing capability). A 2026-07-28 server refusing this request as made.
 * - `legacy`: a 400 whose body is empty, not JSON, or a JSON-RPC error that
 *   isn't one of 2026-07-28's: the binding's signal of a legacy server.
 * - `other`: anything else, including a 400 that carries one of the Poppy
 *   or OAuth error codes (`{"error": "invalid_session"}`), a 401, 403, 404,
 *   429 or 5xx: an ordinary failure, never a reason to change lifecycle.
 */
export type EraSignal =
  | { readonly kind: "unsupported"; readonly supported: readonly string[] }
  | { readonly kind: "modern"; readonly code: number }
  | { readonly kind: "legacy" }
  | { readonly kind: "other" };

export function eraSignal(status: number, body: Json | undefined): EraSignal {
  const error = isObject(body) && isObject(body.error) ? body.error : null;
  const code = error && typeof error.code === "number" ? error.code : null;
  if (status === 400 && code === UNSUPPORTED_PROTOCOL_VERSION) {
    const supported = isObject(error!.data) && Array.isArray(error!.data.supported) ? error!.data.supported : [];
    return { kind: "unsupported", supported: supported.filter((version): version is string => typeof version === "string") };
  }
  if (status === 400 && code !== null && MODERN_CODES.has(code)) return { kind: "modern", code };
  if (status !== 400) return { kind: "other" };
  // A Poppy or OAuth error from the Session's checks (5.3, 7) is about the request, not the MCP version.
  if (isObject(body) && isProtocolErrorCode(body.error)) return { kind: "other" };
  return { kind: "legacy" };
}
