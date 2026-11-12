/** MCP negotiation, account-partitioned session caches, JSON-RPC transport and tool catalogues. */
import { type McpEra, modernMeta, modernHeaders, legacyHeaders, eraSignal, MCP_MODERN, MCP_LEGACY, HEADER_MISMATCH, usableTools, headerParameters, parameterHeaders } from "./mcp-wire";
import { type Json, isObject, parseStrictJson } from "./json";
import { extensionRequiredBody, PoppyClient, PoppyError, withAnswer, answerOf, withUnreadableAnswer } from "./client";
import { type Company, boundedCacheSeconds } from "./discovery";
import { type Api, type DispatchGuard, findApi } from "./api-authority";
import { fetchJson } from "./fetch";
import { EndpointRequest } from "./outgoing";
import { companyErrorCode } from "./error-codes";

// ---------------------------------------------------------------- MCP

/**
 * MCP over Streamable HTTP in both versions section 7 names (mcp-wire.ts):
 * 2025-06-18, whose `initialize` opens an MCP session, and 2026-07-28, which
 * has none and carries its version and metadata on every request. Which one
 * a server speaks is its era. It is learnt once per server and cached, as
 * MCP 2026-07-28's Versioning advises: a `server/discover` probe, then
 * `initialize` only after the binding's legacy signal. A cached era that
 * later fails is dropped and probed again with `server/discover`, a read, and
 * never by sending a `tools/call` twice. Either way every request carries the
 * Poppy Session header, and Poppy's `sid` is never an MCP session.
 *
 * The cache below is partitioned by the Company, the server, the Poppy
 * Session and its authority (account, sign-in, scopes, generation): under
 * 2025-06-18 an entry holds the MCP session and its tool list, under
 * 2026-07-28 the tool list alone.
 */
type McpEntry = {
  readonly era: McpEra;
  /** 2025-06-18's `Mcp-Session-Id`, when `initialize` returned one. 2026-07-28 has none. */
  readonly sessionId: string | null;
  tools: Json[] | null;
  /** Until when `tools` may be used: the entry's whole life under 2025-06-18, the list's `ttlMs` under 2026-07-28. */
  toolsUntil: number;
  readonly expiresAt: number;
};

type McpState = {
  entries: Map<string, McpEntry>;
  opening: Map<string, Promise<void>>;
  metadata: Map<string, Promise<{ expiresAt: number }>>;
  bindings: Map<string, { fingerprint: string; generation: number; key: string }>;
  /** Each server's era, by its resource key: "a property of the server, not of an individual request" (MCP 2026-07-28 Versioning). */
  eras: Map<string, McpEra>;
};

/** Where one request goes: an entry's key, its server's resource key, and the lifecycle it is sent under. */
type McpTarget = { readonly key: string; readonly resourceKey: string; readonly era: McpEra; readonly sessionId: string | null };

// Client-owned caches die with the client and its DPoP keys; no cross-user global session state.
const mcpClients = new WeakMap<PoppyClient, McpState>();

function mcpState(client: PoppyClient): McpState {
  let state = mcpClients.get(client);
  if (!state) mcpClients.set(client, (state = { entries: new Map(), opening: new Map(), metadata: new Map(), bindings: new Map(), eras: new Map() }));
  return state;
}

/**
 * The server answered as the other era: a 2025-06-18 request refused with a
 * 2026-07-28 error, or a 2026-07-28 request refused with the binding's
 * legacy signal. Nothing was done; the server's cached era is dropped, so the
 * next request probes again. A read is asked again once; a `tools/call` never.
 */
class McpEraChanged extends PoppyError {}

/**
 * An MCP server's protected resource metadata (RFC 9728), fetched without
 * redirects: its `resource` is exactly the server's `url`, and its
 * `authorization_servers` include the Company's issuer (7), or the server
 * isn't the Company's. Signed in, its token is one for that `resource`.
 */
async function checkResourceMetadata(client: PoppyClient, company: Company, api: Api): Promise<{ expiresAt: number }> {
  const url = new URL(api.url);
  // Only the URL derived from the server's own (RFC 9728 3.1). The root document describes the origin, so
  // its `resource` can't be a server with a path without breaking RFC 9728 3.3's exact match (decision 43).
  try {
    const { json, maxAgeSeconds } = await fetchJson(client.host.fetcher, `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`, { maxRedirects: 0 });
    if (isObject(json) && Array.isArray(json.authorization_servers)) {
      if (!json.authorization_servers.includes(company.issuer)) throw new PoppyError("bad_api", `${api.url} doesn't name ${company.issuer} as its authorization server`, 0);
      if (json.resource !== api.url) throw new PoppyError("bad_api", "MCP metadata resource must equal its exact URL", 0);
      return { expiresAt: Date.now() + boundedCacheSeconds(maxAgeSeconds) * 1000 };
    }
  } catch (error) {
    if (error instanceof PoppyError) throw error;
  }
  throw new PoppyError("bad_api", `${api.url} publishes no protected resource metadata`, 0);
}

/**
 * A JSON-RPC response from a Streamable HTTP reply: JSON, or the matching SSE
 * message. A JSON-RPC error keeps its body. Under 2026-07-28 a result says
 * what it is in `resultType`: `complete` (or absent, as older servers send),
 * or `input_required`, which asks for input this agent declared no
 * capability to give, so the request wasn't completed. Any other type is
 * invalid (Base Protocol, "ResultType").
 */
async function rpcResult(client: PoppyClient, response: Response, id: number, era: McpEra): Promise<Json> {
  const messages = rpcMessages(response, await client.readBody(response));
  const message = messages.find((item) => isObject(item) && item.id === id);
  if (!isObject(message)) throw new PoppyError("mcp_error", "The MCP server didn't answer the request", response.status);
  if (isObject(message.error)) {
    throw withAnswer(new PoppyError("mcp_error", `MCP error: ${String(message.error.message ?? message.error.code)}`, response.status, { body: message.error }), response.status);
  }
  const result = message.result ?? null;
  if (era === "modern") {
    const resultType = isObject(result) && result.resultType !== undefined ? result.resultType : "complete";
    if (resultType === "input_required") {
      throw withAnswer(new PoppyError("mcp_error", "The MCP server asked for input this agent doesn't give, so the request wasn't completed", response.status), response.status);
    }
    if (resultType !== "complete") {
      throw new PoppyError("invalid_response", `The MCP server answered with resultType ${JSON.stringify(resultType).slice(0, 40)}, which this agent can't read`, response.status);
    }
  }
  return result;
}

/** The JSON-RPC messages in a Streamable HTTP reply's body: one JSON value (or a batch), or each SSE event's data. */
function rpcMessages(response: Response, text: string): Json[] {
  const messages: Json[] = [];
  if ((response.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
    for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data) messages.push(parseStrictJson(data));
    }
  } else if (text) {
    const parsed = parseStrictJson(text);
    messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return messages;
}

/**
 * One JSON-RPC request under the target's lifecycle. 2026-07-28 adds its
 * protocol fields to `_meta`, after any the caller set (the Poppy approval),
 * and mirrors method, name and parameters into headers; 2025-06-18 sends its
 * session and version. A refusal keeps its body, and only an era signal
 * (`eraSignal`) becomes `McpEraChanged`: an ordinary failure never changes
 * lifecycle.
 */
export async function mcpRequest(
  client: PoppyClient, company: Company, label: string, api: Api, target: McpTarget,
  method: string, params: Record<string, Json>, guard: DispatchGuard = {}, parameters: Record<string, string> = {}
): Promise<{ result: Json; sessionId: string | null }> {
  const { entries, eras } = mcpState(client);
  const id = Math.floor(Math.random() * 1e9);
  const modern = target.era === "modern";
  const sent = modern ? { ...params, _meta: { ...(isObject(params._meta) ? params._meta : {}), ...modernMeta(client.identity.clientName) } } : params;
  // Each token is sent as its token_type names, DPoP or Bearer (4.5, 7); each names this URL.
  const response = await client.resource(
    company,
    EndpointRequest.mcp(company, {
      method: "POST",
      url: api.url,
      body: { jsonrpc: "2.0", id, method, params: sent },
      accept: "application/json, text/event-stream",
      headers: modern ? modernHeaders(method, params, parameters) : legacyHeaders(target.sessionId)
    }),
    // Without an approval in _meta, the call means the same in any version (3.4).
    { label, resource: api.url, ...guard, ...(isObject(params._meta) && params._meta["personalagentprotocol.org/approval"] !== undefined ? {} : { versionNeutral: true }) }
  );
  if (response.status === 404 && !modern && target.sessionId) {
    entries.delete(target.key);
    await response.body?.cancel();
    throw withAnswer(new PoppyError("mcp_session_expired", "The MCP session expired", 404), 404);
  }
  if (!response.ok) {
    // The refusal's body, JSON or SSE, decides whether it is an era signal; one we can't read counts as empty.
    const text = await client.readBody(response, 64_000).catch(() => "");
    let body: Json | undefined;
    try {
      const messages = rpcMessages(response, text);
      body = messages.find((message) => isObject(message) && message.error !== undefined) ?? messages[0];
    } catch { body = undefined; }
    const signal = eraSignal(response.status, body);
    const otherEra = modern
      ? signal.kind === "legacy" || (signal.kind === "unsupported" && !signal.supported.includes(MCP_MODERN) && signal.supported.includes(MCP_LEGACY))
      : signal.kind === "modern" || (signal.kind === "unsupported" && signal.supported.includes(MCP_MODERN));
    const kept = body !== undefined ? { body } : {};
    if (otherEra) {
      entries.delete(target.key);
      if (eras.get(target.resourceKey) === target.era) eras.delete(target.resourceKey);
      const now = modern ? MCP_LEGACY : MCP_MODERN;
      throw withAnswer(new McpEraChanged("mcp_error", `${api.url} answered as an MCP ${now} server, so this ${modern ? MCP_MODERN : MCP_LEGACY} request wasn't accepted. Nothing was done; the next request uses ${now}.`, response.status, kept), response.status);
    }
    // A header that doesn't match a tool's current schema: the call isn't sent again, but the next one reads the list first.
    if (modern && signal.kind === "modern" && signal.code === HEADER_MISMATCH && method === "tools/call") {
      const entry = entries.get(target.key);
      if (entry) entry.tools = null;
    }
    if (signal.kind === "unsupported") {
      throw withAnswer(new PoppyError("mcp_error", `${api.url} speaks MCP ${signal.supported.join(", ").slice(0, 200) || "versions it didn't name"}; this agent speaks ${MCP_MODERN} and ${MCP_LEGACY}`, response.status, kept), response.status);
    }
    const required = extensionRequiredBody(company, body, response.status);
    if (required) throw required;
    const rpcError = isObject(body) && isObject(body.error) ? body.error : null;
    const code = rpcError ? "mcp_error" : companyErrorCode(isObject(body) ? body.error : undefined, response.status);
    const said = rpcError ? `MCP error: ${String(rpcError.message ?? rpcError.code).slice(0, 500)}` : `returned ${code}`;
    throw withAnswer(new PoppyError(code, `${api.url} answered HTTP ${response.status}: ${said}`, response.status, rpcError ? { body: rpcError } : kept), response.status);
  }
  let result: Json;
  try { result = await rpcResult(client, response, id, target.era); }
  catch (error) { throw method === "tools/call" && answerOf(error) === undefined ? withUnreadableAnswer(error, response.status) : error; }
  return { result, sessionId: modern ? null : response.headers.get("Mcp-Session-Id") };
}

/** A notification in a 2025-06-18 session: accepted with 202, and nothing to read. */
async function mcpNotify(client: PoppyClient, company: Company, label: string, api: Api, sessionId: string | null, method: string, guard: DispatchGuard): Promise<void> {
  const response = await client.resource(
    company,
    EndpointRequest.mcp(company, {
      method: "POST", url: api.url,
      body: { jsonrpc: "2.0", method },
      accept: "application/json, text/event-stream",
      headers: legacyHeaders(sessionId)
    }),
    { label, resource: api.url, ...guard }
  );
  await response.body?.cancel();
  if (!response.ok) throw withAnswer(new PoppyError(`http_${response.status}`, "The MCP server refused initialization", response.status), response.status);
}

/** The cache key for an MCP server, and the partition this Poppy Session and its authority use there. */
async function mcpSession(client: PoppyClient, company: Company, label: string, api: Api, guard: DispatchGuard = {}): Promise<McpTarget> {
  const { entries, opening, metadata, bindings, eras } = mcpState(client);
  const resourceKey = JSON.stringify([company.issuer, api.url, company.protocolVersion, company.specificationRevision, company.authFingerprint]);
  let loading = metadata.get(resourceKey);
  if (loading && (await loading).expiresAt <= Date.now()) loading = undefined;
  // 7: an MCP server's metadata must name the Company's issuer when it offers account access. It is
  // checked before a token is requested for it; a signed-out call, which carries the Session header
  // alone, goes to the server as poppy.json lists it, metadata or not. An interrupted sign-in is
  // recovered first, since recovery can sign the Session in.
  const validate = () => {
    if (!loading) {
      loading = checkResourceMetadata(client, company, api);
      metadata.set(resourceKey, loading);
      void loading.catch(() => { if (metadata.get(resourceKey) === loading) metadata.delete(resourceKey); });
    }
    return loading;
  };
  if (!company.issuerless) await client.recoverSignIns(company.issuer);
  const signedIn = !company.issuerless && !!client.session(company.issuer, label)?.signed_in;
  let mode = signedIn ? await validate() : loading ? await loading : { expiresAt: Date.now() + 60_000 };
  // Refresh credentials before choosing a cache entry: sign-in/account changes
  // must never reuse the previous account's MCP session or tool catalogue.
  const held = await client.token(company, { label, resource: api.url });
  // A sign-in that completed while this was waiting: the metadata is checked before the token is used.
  if (held && !signedIn) mode = await validate();
  const bound = client.session(company.issuer, label);
  const slot = JSON.stringify([resourceKey, label]);
  const fingerprint = JSON.stringify([bound?.session_id, bound?.account, bound?.signed_in, bound?.authority_generation, bound?.scope]);
  let binding = bindings.get(slot);
  if (!binding || binding.fingerprint !== fingerprint) {
    // Returning to signed-out state must not resurrect a pre-sign-in session.
    // Generations also keep an older in-flight opening out of the cache.
    if (binding) entries.delete(binding.key);
    const generation = (binding?.generation ?? 0) + 1;
    binding = { fingerprint, generation, key: JSON.stringify([slot, fingerprint, generation]) };
    bindings.set(slot, binding);
  }
  const key = binding.key;
  const target = (): McpTarget => {
    const entry = entries.get(key);
    if (!entry) throw new PoppyError("mcp_error", "The MCP server's lifecycle changed while this request was being prepared. Start it again.", 0);
    return { key, resourceKey, era: entry.era, sessionId: entry.sessionId };
  };
  const pending = opening.get(key);
  if (pending) { await pending; return target(); }
  const cached = entries.get(key);
  // An entry opened under an era the server no longer has is opened again.
  if (cached && cached.expiresAt > Date.now() && eras.get(resourceKey) === cached.era) return target();
  entries.delete(key);
  const open = openMcp(client, company, label, api, { key, resourceKey }, mode, guard);
  opening.set(key, open);
  try { await open; } finally { opening.delete(key); }
  return target();
}

/**
 * Open an entry under the server's era, learning the era first when it
 * isn't cached. At most three exchanges decide it: a probe, the 2025-06-18
 * handshake after the legacy signal, and one more probe when a server cached
 * as 2025-06-18 answers `initialize` as a 2026-07-28 one. A server whose
 * answers contradict each other is refused rather than probed again.
 */
async function openMcp(client: PoppyClient, company: Company, label: string, api: Api, at: { key: string; resourceKey: string }, mode: { expiresAt: number }, guard: DispatchGuard): Promise<void> {
  const { entries, eras } = mcpState(client);
  let era = eras.get(at.resourceKey);
  let probed = false;
  const probe = async () => {
    probed = true;
    const found = await discoverEra(client, company, label, api, at, guard);
    eras.set(at.resourceKey, found);
    return found;
  };
  era ??= await probe();
  if (era === "legacy") {
    try {
      const sessionId = await initializeLegacy(client, company, label, api, at, guard);
      eras.set(at.resourceKey, "legacy");
      entries.set(at.key, { era: "legacy", sessionId, tools: null, toolsUntil: Number.POSITIVE_INFINITY, ...mode });
      return;
    } catch (error) {
      // A server cached as 2025-06-18 now answers as a 2026-07-28 one: probe it again, once.
      if (!(error instanceof McpEraChanged) || probed || (await probe()) !== "modern") throw error;
    }
  }
  entries.set(at.key, { era: "modern", sessionId: null, tools: null, toolsUntil: 0, ...mode });
}

/**
 * The probe (MCP 2026-07-28 Streamable HTTP, "Backward Compatibility"): a
 * 2026-07-28 `server/discover`, which every such server implements and which
 * changes nothing. Its result names the versions the server speaks; the
 * binding's legacy signal, or an `UnsupportedProtocolVersionError` naming
 * only 2025-06-18, means 2025-06-18. Any other failure is reported as it is.
 */
async function discoverEra(client: PoppyClient, company: Company, label: string, api: Api, at: { key: string; resourceKey: string }, guard: DispatchGuard): Promise<McpEra> {
  try {
    const { result } = await mcpRequest(client, company, label, api, { ...at, era: "modern", sessionId: null }, "server/discover", {}, guard);
    const versions = isObject(result) && Array.isArray(result.supportedVersions) ? result.supportedVersions : [];
    if (versions.includes(MCP_MODERN)) return "modern";
    if (versions.includes(MCP_LEGACY)) return "legacy";
    throw new PoppyError("mcp_error", `${api.url} speaks MCP ${versions.map(String).join(", ").slice(0, 200) || "no version it named"}; this agent speaks ${MCP_MODERN} and ${MCP_LEGACY}`, 200);
  } catch (error) {
    if (error instanceof McpEraChanged) return "legacy";
    // A legacy server that ignores the version header and answers the unknown method with a JSON-RPC
    // error is no 2026-07-28 server either, which answers an unknown method with a 404 (our reading).
    const rpcError = error instanceof PoppyError && error.status === 200 && isObject(error.detail.body) ? error.detail.body : null;
    if (rpcError && typeof rpcError.code === "number" && eraSignal(400, { error: rpcError }).kind === "legacy") return "legacy";
    throw error;
  }
}

/** 2025-06-18's handshake: `initialize` for exactly that version, then `notifications/initialized` in the session it opened. */
async function initializeLegacy(client: PoppyClient, company: Company, label: string, api: Api, at: { key: string; resourceKey: string }, guard: DispatchGuard): Promise<string | null> {
  const { result, sessionId } = await mcpRequest(client, company, label, api, { ...at, era: "legacy", sessionId: null }, "initialize", {
    protocolVersion: MCP_LEGACY,
    capabilities: {},
    clientInfo: { name: client.identity.clientName, version: "0.1" }
  }, guard);
  const version = isObject(result) ? result.protocolVersion : undefined;
  if (version !== MCP_LEGACY) {
    throw new PoppyError("mcp_error", `${api.url} answered initialize with MCP ${JSON.stringify(version ?? null).slice(0, 40)}; this agent speaks ${MCP_LEGACY} with initialize`, 200);
  }
  await mcpNotify(client, company, label, api, sessionId, "notifications/initialized", guard);
  return sessionId;
}

/**
 * The server's tools. Under 2026-07-28 a tool with an invalid `x-mcp-header`
 * is left out, as the binding requires, and the list is kept for its
 * `ttlMs` (none: not kept). A server that changed era since the last request
 * is asked once more under its new one; the list is a read, so nothing is
 * repeated that could act twice.
 */
export async function listMcpTools(client: PoppyClient, company: Company, label: string, apiUrl?: string, guard: DispatchGuard = {}): Promise<Json[]> {
  const api = findApi(company, "mcp", apiUrl);
  for (let attempt = 0; ; attempt++) {
    const target = await mcpSession(client, company, label, api, guard);
    const entry = mcpState(client).entries.get(target.key);
    if (entry?.tools && entry.toolsUntil > Date.now()) return entry.tools;
    try {
      const { result } = await mcpRequest(client, company, label, api, target, "tools/list", {}, guard);
      const listed = isObject(result) && Array.isArray(result.tools) ? result.tools : [];
      const tools = target.era === "modern" ? usableTools(listed) : listed;
      if (entry) {
        const ttl = isObject(result) && typeof result.ttlMs === "number" && result.ttlMs > 0 ? result.ttlMs : 0;
        entry.tools = tools;
        entry.toolsUntil = target.era === "modern" ? Math.min(Date.now() + ttl, entry.expiresAt) : Number.POSITIVE_INFINITY;
      }
      return tools;
    } catch (error) {
      if (!(error instanceof McpEraChanged) || attempt > 0) throw error;
    }
  }
}

/**
 * Where a call goes, and the headers its arguments need. Under 2026-07-28
 * those come from the tool's `x-mcp-header` annotations, so its definition
 * is needed: the caller's, or the server's current list. Nothing is sent
 * when the tool is missing or invalid there.
 */
export async function prepareMcpCall(
  client: PoppyClient, company: Company, label: string, api: Api,
  call: { tool: string; args: Json }, guard: DispatchGuard, listed?: Json
): Promise<{ target: McpTarget; parameters: Record<string, string> }> {
  const first = await mcpSession(client, company, label, api, guard);
  if (first.era !== "modern") return { target: first, parameters: {} };
  const tool = listed ?? (await listMcpTools(client, company, label, api.url, guard)).find((item) => isObject(item) && item.name === call.tool);
  // Listing may have found the server's era changed; nothing is sent yet, so the call goes under the new one.
  const target = await mcpSession(client, company, label, api, guard);
  if (target.era !== "modern") return { target, parameters: {} };
  const found = isObject(tool) ? headerParameters(tool.inputSchema) : null;
  if (!found || !("parameters" in found)) throw new PoppyError("no_tool", `${api.url} lists no usable tool ${call.tool}. Nothing was sent.`, 0);
  const parameters = parameterHeaders(found.parameters, call.args);
  if (!parameters) throw new PoppyError("invalid_args", `args for ${call.tool} at ${company.name} can't go in the headers its tool names. Nothing was sent.`, 0);
  return { target, parameters };
}
