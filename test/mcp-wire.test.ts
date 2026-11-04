import { describe, expect, it } from "vitest";
import { eraSignal, headerParameters, mirroredValue, modernHeaders, modernMeta, parameterHeaders, usableTools } from "../src/poppy/mcp-wire";
import type { Json } from "../src/poppy/json";

/** MCP 2026-07-28's wire format (src/poppy/mcp-wire.ts), against the examples its text gives. */
describe("MCP 2026-07-28 request metadata", () => {
  it("puts the version, the client and no capabilities in _meta, and mirrors method and name into headers", () => {
    expect(modernMeta("PDA")).toEqual({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "PDA", version: "0.1" },
      "io.modelcontextprotocol/clientCapabilities": {}
    });
    expect(modernHeaders("tools/list", {})).toEqual({ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" });
    expect(modernHeaders("tools/call", { name: "get_weather" }, { "Mcp-Param-Region": "us-west1" })).toEqual({
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "get_weather",
      "Mcp-Param-Region": "us-west1"
    });
    expect(modernHeaders("resources/read", { uri: "file:///projects/myapp/config.json" })["Mcp-Name"]).toBe("file:///projects/myapp/config.json");
  });

  // Streamable HTTP, "Value Encoding": the examples table.
  it.each([
    ["us-west1", "us-west1"],
    ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
    [" padded ", "=?base64?IHBhZGRlZCA=?="],
    ["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
    ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="]
  ])("encodes %j as %s", (value, encoded) => {
    expect(mirroredValue(value)).toBe(encoded);
  });

  it("never lets a value add a header: CR, LF and other controls go Base64", () => {
    for (const value of ["a\r\nX-Injected: 1", "tab\there", "\u0000", ""]) expect(mirroredValue(value)).toMatch(/^=\?base64\?[A-Za-z0-9+/=]*\?=$/);
  });
});

describe("x-mcp-header", () => {
  const schema = (properties: Record<string, Json>, extra: Record<string, Json> = {}): Json => ({ type: "object", properties, ...extra });

  it("finds annotated parameters through properties, including nested objects", () => {
    expect(headerParameters(schema({ region: { type: "string", "x-mcp-header": "Region" }, query: { type: "string" } }))).toEqual({ parameters: [{ header: "Region", path: ["region"] }] });
    expect(headerParameters(schema({ where: { type: "object", properties: { zone: { type: "integer", "x-mcp-header": "Zone" } } } }))).toEqual({ parameters: [{ header: "Zone", path: ["where", "zone"] }] });
    // A property merely named x-mcp-header is no annotation.
    expect(headerParameters(schema({ "x-mcp-header": { type: "string" } }))).toEqual({ parameters: [] });
  });

  it.each([
    ["an empty name", schema({ a: { type: "string", "x-mcp-header": "" } })],
    ["a name that isn't a token", schema({ a: { type: "string", "x-mcp-header": "Bad Name" } })],
    ["a name with a line break", schema({ a: { type: "string", "x-mcp-header": "A\r\nB" } })],
    ["two names that differ only in case", schema({ a: { type: "string", "x-mcp-header": "Region" }, b: { type: "string", "x-mcp-header": "region" } })],
    ["a number parameter", schema({ a: { type: "number", "x-mcp-header": "A" } })],
    ["an object parameter", schema({ a: { type: "object", "x-mcp-header": "A" } })],
    ["a parameter under items", schema({ a: { type: "array", items: { type: "string", "x-mcp-header": "A" } } })],
    ["a parameter under oneOf", schema({}, { oneOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }] })],
    ["a parameter under $defs", schema({}, { $defs: { a: { type: "string", "x-mcp-header": "A" } } })],
    ["a parameter under dependencies", schema({ a: { type: "string" } }, { dependencies: { a: { properties: { b: { type: "string", "x-mcp-header": "B" } } } } })],
    ["a parameter under contentSchema", schema({ a: { type: "string", contentMediaType: "application/json", contentSchema: { type: "string", "x-mcp-header": "A" } } })],
    ["the root schema", { type: "string", "x-mcp-header": "Root" }]
  ])("makes a tool invalid with %s", (_what, inputSchema) => {
    expect(headerParameters(inputSchema)).toHaveProperty("problem");
  });

  it("leaves invalid tools out of the list, keeping the rest", () => {
    const tools: Json[] = [
      { name: "ok", inputSchema: schema({ region: { type: "string", "x-mcp-header": "Region" } }) },
      { name: "broken", inputSchema: schema({ amount: { type: "number", "x-mcp-header": "Amount" } }) },
      { name: "plain", inputSchema: schema({ q: { type: "string" } }) }
    ];
    expect(usableTools(tools).map((tool) => (tool as { name: string }).name)).toEqual(["ok", "plain"]);
  });

  it("mirrors present values as strings, omits absent and null ones, and refuses what a header can't carry", () => {
    const parameters = [
      { header: "Region", path: ["region"] },
      { header: "Count", path: ["count"] },
      { header: "Dry", path: ["dry"] },
      { header: "Zone", path: ["where", "zone"] }
    ];
    expect(parameterHeaders(parameters, { region: "Hello, 世界", count: -7, dry: false, where: { zone: null } })).toEqual({
      "Mcp-Param-Region": "=?base64?SGVsbG8sIOS4lueVjA==?=",
      "Mcp-Param-Count": "-7",
      "Mcp-Param-Dry": "false"
    });
    expect(parameterHeaders(parameters, {})).toEqual({});
    expect(parameterHeaders(parameters, { count: 1.5 })).toBeNull();
    expect(parameterHeaders(parameters, { count: 2 ** 53 })).toBeNull();
    expect(parameterHeaders(parameters, { region: { nested: true } })).toBeNull();
  });

  it("omits an absent argument whose name an object inherits, and mirrors one the call gives", () => {
    const inherited = ["constructor", "toString", "__proto__", "hasOwnProperty"].map((name) => ({ header: `P-${name.replace(/_/g, "")}`, path: [name] }));
    expect(parameterHeaders(inherited, {})).toEqual({});
    expect(parameterHeaders([{ header: "Zone", path: ["where", "toString"] }], { where: {} })).toEqual({});
    // A JSON body can carry them as its own members, which do go in headers.
    expect(parameterHeaders(inherited, JSON.parse('{"constructor": "c", "__proto__": "p"}') as Json)).toEqual({ "Mcp-Param-P-constructor": "c", "Mcp-Param-P-proto": "p" });
  });

  it("keeps `dependencies` that only list property names", () => {
    expect(headerParameters(schema({ a: { type: "string", "x-mcp-header": "A" }, b: { type: "string" } }, { dependencies: { a: ["b"] } }))).toEqual({ parameters: [{ header: "A", path: ["a"] }] });
  });
});

describe("what a refusal says about a server's era (Streamable HTTP, \"Backward Compatibility\")", () => {
  const rpc = (code: number, data?: Json): Json => ({ jsonrpc: "2.0", id: 1, error: { code, message: "refused", ...(data === undefined ? {} : { data }) } });

  it.each([
    ["an empty 400", 400, undefined, { kind: "legacy" }],
    ["a 400 with a legacy server's JSON-RPC error", 400, rpc(-32000), { kind: "legacy" }],
    ["a 400 with invalid params", 400, rpc(-32600), { kind: "legacy" }],
    ["a 400 with text", 400, "Bad Request", { kind: "legacy" }],
    ["UnsupportedProtocolVersionError", 400, rpc(-32022, { supported: ["2026-07-28", "2025-11-25"], requested: "1900-01-01" }), { kind: "unsupported", supported: ["2026-07-28", "2025-11-25"] }],
    ["HeaderMismatch", 400, rpc(-32020), { kind: "modern", code: -32020 }],
    ["MissingRequiredClientCapability", 400, rpc(-32021), { kind: "modern", code: -32021 }],
    ["a Poppy error at 400", 400, { error: "invalid_session" }, { kind: "other" }],
    ["session_ended at 400", 400, { error: "session_ended" }, { kind: "other" }],
    ["a 401", 401, {}, { kind: "other" }],
    ["a 404 with Method not found", 404, rpc(-32601), { kind: "other" }],
    ["a 405", 405, undefined, { kind: "other" }],
    ["a 429", 429, undefined, { kind: "other" }],
    ["a 500", 500, rpc(-32603), { kind: "other" }]
  ] as const)("reads %s", (_what, status, body, signal) => {
    expect(eraSignal(status, body as Json | undefined)).toEqual(signal);
  });
});
