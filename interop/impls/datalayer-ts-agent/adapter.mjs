// Interop adapter (docs/interop-spec.md 5.2) for Datalayer's TypeScript Personal Agent SDK.
//
// Port 8080: the agent's published identity (client metadata, JWKS, redirect URI),
// reached by Companies as https://<name>.agent.interop.test through the proxy.
// Port 8081: the control API. Every step calls the SDK's protocol clients directly;
// there is no model anywhere.
//
// Runs inside the image, next to the upstream build in /upstream/lib.
import { createServer } from "node:http";

import { exportJWK, generateKeyPair } from "jose";

import {
  AccountTokenClient,
  AuthorizationStateStores,
  BrowserFormPosts,
  BrowserHandoffs,
  BrowserSessionClient,
  ConversationClient,
  DeviceSignInClient,
  DirectSignInClient,
  DpopFetchClient,
  DpopProofProviders,
  JoseDpopProofProvider,
  McpClient,
  MediatedSignInClient,
  OperationsClient,
  ProtectedInputs,
  SecretValue,
  SessionClient,
  Signers,
  TokenStores,
  approve,
  buildPapReactor,
  discoverCompany,
  operationsEndpoint,
  parseClientMetadata,
} from "../lib/index.js";
import { JoseSigner } from "../lib/server.js";

const UPSTREAM_COMMIT = "00216eb7c1f20e2f9e0f808a06c6fe1a35b7ca65";
const NAME = process.env.INTEROP_NAME || "datalayer-ts";
const ORIGIN = (process.env.INTEROP_ORIGIN || `https://${NAME}.agent.interop.test`).replace(/\/$/, "");
const SECRET = process.env.INTEROP_SECRET || "";
const TENANT = "interop";

const MANIFEST = {
  interop: 1,
  name: NAME,
  role: "agent",
  commit: UPSTREAM_COMMIT,
  poppy: ["0.1"],
  extensions: ["operations"],
  scenarios: ["D", "S0", "N", "SD", "SV", "SVN", "SXV", "SM", "SMC", "SX", "SE", "SO", "R", "RL", "C", "CI", "CS", "CA", "AO", "AS", "AM", "O", "OX", "H", "DC", "W", "O2", "CM", "XH", "XI", "BX", "XB", "XN", "XO", "XE", "XR", "XT"],
  readings: { S1: "endpoint", S2: "jwt-60s", S3: "insertion", S4: "omit" },
  relaxations: [],
};

// ---------------------------------------------------------------------------------
// The agent's host: identity, keys, stores. Rebuilt on /reset (keys rotate).

let world;
let generation = 0;

async function buildWorld() {
  generation += 1;
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = `key-${generation}-${Date.now().toString(36)}`;
  const clientId = `${ORIGIN}/agent.json`;
  const metadata = {
    client_id: clientId,
    client_name: `Datalayer TS agent (${NAME}, interop)`,
    jwks_uri: `${ORIGIN}/jwks.json`,
    redirect_uris: [`${ORIGIN}/oauth/callback`],
    token_endpoint_auth_method: "private_key_jwt",
    extensions: { operations: { version: "1" } },
  };
  const jwks = {
    keys: [{ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y, kid, use: "sig", alg: "ES256" }],
  };
  const tokens = new Map();
  const states = new Map();
  const dpopKeys = new Map();
  const browser = { last: undefined, async open(url) { browser.last = url.reveal(); } };
  const input = {
    answers: [],
    async collect(request) {
      const answer = input.answers.shift();
      if (answer === undefined) throw new Error(`no answer queued for ${request.purpose}`);
      return Object.fromEntries(Object.entries(answer).map(([k, v]) => [k, new SecretValue(String(v))]));
    },
  };
  const fetch = globalThis.fetch;
  // The host's browser for a browser Session join (spec 5): the SDK signs the assertion and
  // hands it here to POST as a form, as a page that submits itself makes a browser do. It
  // keeps the Company's answer (a 303 and its cookie) for web_join to report.
  const poster = {
    last: undefined,
    async post(endpoint, fields) {
      const body = new URLSearchParams(Object.entries(fields).map(([name, value]) => [name, value.reveal()]));
      const response = await fetch(endpoint.href, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        redirect: "manual",
      });
      await response.arrayBuffer().catch(() => undefined);
      poster.last = { status: response.status, location: response.headers.get("location"), cookies: response.headers.getSetCookie() };
    },
  };
  const reactor = buildPapReactor({ fetch }, [
    {
      name: "interop-host",
      contributes: [
        { point: Signers, value: new JoseSigner({ privateKey: pair.privateKey, algorithm: "ES256", keyId: kid }), options: { id: "agent-key" } },
        {
          point: DpopProofProviders,
          value: new JoseDpopProofProvider({
            now: () => new Date(),
            async resolveKey(request) {
              const key = `${request.tenantId}\u0000${request.subject}\u0000${request.issuer}`;
              if (!dpopKeys.has(key)) {
                dpopKeys.set(key, generateKeyPair("ES256", { extractable: true }).then(async (p) => ({
                  privateKey: p.privateKey,
                  publicJwk: await exportJWK(p.publicKey),
                })));
              }
              return dpopKeys.get(key);
            },
          }),
          options: { id: "dpop-keys" },
        },
        {
          point: TokenStores,
          value: {
            async put(ref, token) { tokens.set(ref, token); },
            async get(ref) { return tokens.get(ref); },
            async delete(ref) { tokens.delete(ref); },
          },
          options: { id: "vault" },
        },
        {
          point: AuthorizationStateStores,
          value: {
            async put(ref, value) { states.set(ref, value); },
            async take(ref) { const v = states.get(ref); states.delete(ref); return v; },
          },
          options: { id: "vault" },
        },
        { point: BrowserHandoffs, value: browser, options: { id: "browser" } },
        { point: BrowserFormPosts, value: poster, options: { id: "browser-form" } },
        { point: ProtectedInputs, value: input, options: { id: "trusted-input" } },
      ],
    },
  ]);
  const transport = new DpopFetchClient({ reactor, fetch });
  world = {
    clientId,
    metadata,
    jwks,
    reactor,
    fetch,
    transport,
    browser,
    poster,
    input,
    conversations: new ConversationClient({ reactor, transport }),
    companies: new Map(),
  };
}

// ---------------------------------------------------------------------------------
// Per-Company state.

class StepError extends Error {
  constructor(status, code, detail) {
    super(detail ?? code);
    this.status = status;
    this.code = code;
  }
}

/** `{ok: false, poppy_error, status}`: the Company refused, or the agent refused the Company (status 0). */
class Refusal extends Error {
  constructor(code, status, detail) {
    super(detail ?? code);
    this.code = code;
    this.status = status;
  }
}

function randomId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${Buffer.from(bytes).toString("base64url")}`;
}

function company(host) {
  if (typeof host !== "string" || !host) throw new StepError(400, "bad_request", "company is required");
  let c = world.companies.get(host);
  if (!c) {
    c = { host, pairwise: randomId("u"), conversations: new Map(), operations: new Map() };
    world.companies.set(host, c);
  }
  return c;
}

async function discovered(c) {
  if (!c.discovered) {
    try {
      c.discovered = await discoverCompany(c.host, { reactor: world.reactor });
    } catch (error) {
      // Documents the agent won't use (spec 5.2: discovery_failed, status 0).
      throw new Refusal("discovery_failed", 0, `${error?.code ?? "error"}: ${error?.message ?? error}`);
    }
  }
  return c.discovered;
}

function oauth(c) {
  const metadata = c.discovered?.oauthMetadata;
  if (!metadata) throw new StepError(409, "no_auth", "the Company publishes no auth");
  return metadata;
}

function who(c) {
  return { tenantId: TENANT, pairwiseUserId: c.pairwise, issuer: oauth(c).issuer };
}

async function ensureSession(c) {
  await discovered(c);
  if (!c.session) await startSession(c);
  return c.signedIn ?? c.session;
}

async function startSession(c) {
  const metadata = oauth(c);
  c.session = await new SessionClient({ reactor: world.reactor, fetch: world.fetch }).start({
    clientId: world.clientId,
    pairwiseUserId: c.pairwise,
    issuer: metadata.issuer,
    tokenEndpoint: metadata.token_endpoint,
    tenantId: TENANT,
  });
  c.signedIn = undefined;
  return c.session;
}

function accountContext(c) {
  const metadata = oauth(c);
  return {
    tokenEndpoint: metadata.token_endpoint,
    issuer: metadata.issuer,
    clientId: world.clientId,
    tenantId: TENANT,
    pairwiseUserId: c.pairwise,
    ...(metadata.revocation_endpoint ? { revocationEndpoint: metadata.revocation_endpoint } : {}),
  };
}

/** Sign the current Session in again with the stored Account Token (refresh grant, §4.8). */
async function refreshInto(c) {
  const result = await new AccountTokenClient({ reactor: world.reactor, fetch: world.fetch }).refresh(c.accountRef, {
    context: accountContext(c),
    sessionId: c.session.sessionId,
  });
  if (result.status !== "signed_in" || !result.token) {
    c.accountRef = undefined;
    c.signedIn = undefined;
    return false;
  }
  c.signedIn = result.token;
  c.session = result.token;
  return true;
}

/**
 * What the SDK leaves to its host (and Datalayer's own examples do): on 401
 * invalid_token renew the Session (with the Account Token when signed in), and on
 * invalid_session start a new one and sign it in again. Retried once.
 */
async function recover(c, error) {
  const code = error?.code;
  const status = error?.statusCode;
  if (!((status === 401 && code === "invalid_token") || code === "invalid_session")) return false;
  const metadata = oauth(c);
  if (code === "invalid_token" && c.session) {
    try {
      if (c.accountRef) return await refreshInto(c);
      c.session = await new SessionClient({ reactor: world.reactor, fetch: world.fetch }).renew({
        clientId: world.clientId,
        pairwiseUserId: c.pairwise,
        issuer: metadata.issuer,
        tokenEndpoint: metadata.token_endpoint,
        tenantId: TENANT,
        sessionId: c.session.sessionId,
      });
      c.signedIn = c.session.signedIn ? c.session : undefined;
      return true;
    } catch (renewal) {
      if (renewal?.code !== "invalid_session" && renewal?.code !== "invalid_grant") throw renewal;
    }
  }
  await startSession(c);
  if (c.accountRef) await refreshInto(c);
  return true;
}

async function withSession(c, work) {
  const token = await ensureSession(c);
  try {
    return await work(token);
  } catch (error) {
    if (!(await recover(c, error))) throw error;
    return work(c.signedIn ?? c.session);
  }
}

function conversationEndpoint(c) {
  const protocol = c.discovered.document.agent?.protocols?.find((p) => p.type === "poppy");
  if (!protocol) throw new StepError(409, "no_conversations", "the Company lists no poppy agent endpoint");
  return protocol.endpoint;
}

function messagesOf(page) {
  const out = [];
  for (const event of page?.events ?? []) {
    if (event.type === "message" && event.message) {
      out.push({ role: event.message.role ?? event.message.sender, sender: event.message.sender ?? null, text: event.message.text ?? "" });
    }
  }
  return out;
}

function operationsOf(page) {
  return (page?.events ?? [])
    .map((event) => event.message?.operation)
    .filter((operation) => operation?.operation_id)
    .map((operation) => ({ operation_id: operation.operation_id, state: operation.state, summary: operation.summary }));
}

function remember(c, page) {
  for (const event of page?.events ?? []) {
    const operation = event.message?.operation;
    if (operation?.operation_id) c.operations.set(operation.operation_id, operation);
  }
}

function signedInResult(c, token, granted, params) {
  c.signedIn = token;
  c.session = token;
  c.grantedScopes = [...granted];
  c.account = params?.account ?? c.account;
  return { signed_in: token.signedIn, account: params?.account ?? null, scope: [...granted].join(" ") };
}

async function sendOnce(c, endpoint, token, message, conversation, params) {
  const options = { token, ...who(c), ...(params.wait === undefined ? {} : { wait: params.wait }) };
  const previous = conversation ? c.conversations.get(conversation) : undefined;
  let response = conversation
    ? await world.conversations.send(endpoint, conversation, message, {
        ...options,
        ...(previous?.cursor ? { cursor: previous.cursor } : {}),
      })
    : await world.conversations.start(endpoint, message, {
        ...options,
        // A Direct Conversation (7.10): the SDK's start with parentConversationId.
        ...(params.parent_conversation ? { parentConversationId: params.parent_conversation } : {}),
      });
  if (response.events === undefined) {
    // A bare receipt: read what has happened since our last cursor.
    response = {
      ...(await world.conversations.readEvents(endpoint, response.conversation_id, {
        token,
        ...who(c),
        ...(previous?.cursor ? { cursor: previous.cursor } : {}),
      })),
      receipt: response,
    };
  }
  c.conversations.set(response.conversation_id, { cursor: response.cursor });
  remember(c, response);
  return {
    conversation: response.conversation_id,
    message_id: message.id,
    status: response.status,
    messages: messagesOf(response),
    operations: operationsOf(response),
    cursor: response.cursor ?? null,
    events: response.events ?? [],
  };
}

async function readOnce(c, token, params) {
  const page = await world.conversations.readEvents(conversationEndpoint(c), params.conversation, {
    token,
    ...who(c),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.wait === undefined ? {} : { wait: params.wait }),
  });
  remember(c, page);
  return {
    messages: messagesOf(page),
    operations: operationsOf(page),
    cursor: page.cursor,
    has_more: page.has_more,
    status: page.status,
    events: page.events,
  };
}

async function sseOnce(c, token, params) {
  const max = params.max_events ?? 10;
  const abort = new AbortController();
  // `wait` (seconds) bounds how long the step listens; the stream may stay open.
  const limit = params.timeout_ms ?? (typeof params.wait === "number" ? Math.max(1, params.wait) * 1000 + 2000 : 10_000);
  const timer = setTimeout(() => abort.abort(), limit);
  const events = [];
  const stream = world.conversations.stream(conversationEndpoint(c), params.conversation, {
    token,
    ...who(c),
    ...(params.cursor ? { lastEventId: params.cursor } : {}),
    signal: abort.signal,
  });
  let failure;
  const reading = (async () => {
    for await (const item of stream) {
      if (item.kind !== undefined) continue; // text deltas and reconnect notices
      events.push({ id: item.id, type: item.type, data: item });
      if (events.length >= max) return;
    }
  })().catch((error) => {
    failure = error;
  });
  // The abort signal alone doesn't stop a read waiting on a quiet stream, so the step
  // also ends at the deadline, whatever the stream is doing.
  const deadline = new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true }));
  try {
    await Promise.race([reading, deadline]);
  } finally {
    clearTimeout(timer);
    const timedOut = abort.signal.aborted;
    abort.abort();
    stream.return?.().catch(() => undefined);
    if (failure && !timedOut && events.length === 0) throw failure;
  }
  return {
    events,
    last_id: events.at(-1)?.id ?? params.cursor ?? null,
    ...(failure ? { ended: failure.code ?? String(failure) } : {}),
  };
}

/** Resolve `operation` ("METHOD /path" or an OpenAPI operationId) and `args` to a request. */
async function apiOnce(c, token, params) {
  const apis = c.discovered.document.apis ?? [];
  const api = apis.find((a) => a.url === params.api || a.type === params.api || a.name === params.api) ?? apis[0];
  if (!api) throw new StepError(409, "no_api", "the Company lists no API");
  const args = params.args ?? {};
  const values = { ...(args.params ?? {}) };
  let method;
  let path;
  let base = new URL("/", api.url).toString();
  const literal = /^([A-Z]+)\s+(\/\S*)$/.exec(String(params.operation ?? "GET /"));
  if (literal) {
    [, method, path] = literal;
  } else {
    const described = await world.transport.request("GET", api.url, { token, ...who(c), headers: { Accept: "application/json" } });
    if (!described.ok) throw new Refusal("api_description_failed", described.status, `GET ${api.url}`);
    const openapi = await described.json();
    for (const [template, item] of Object.entries(openapi.paths ?? {})) {
      for (const [verb, operation] of Object.entries(item ?? {})) {
        if (operation?.operationId === params.operation) {
          method = verb.toUpperCase();
          path = template;
        }
      }
    }
    if (!method) throw new StepError(404, "unknown_operation", `no operationId ${params.operation} in ${api.url}`);
    const server = openapi.servers?.[0]?.url;
    if (server) base = new URL(server, api.url).toString();
  }
  path = path.replace(/\{([^}]+)\}/g, (_, name) => {
    const value = values[name] ?? args[name] ?? "";
    delete values[name];
    return encodeURIComponent(String(value));
  });
  // Paths are relative to the first server URL (OpenAPI 3), or to the origin; params
  // left over after the path go in the query.
  const url = new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, String(value));
  const body = args.body;
  const response = await world.transport.request(method, url.toString(), {
    token,
    ...who(c),
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  if (response.status >= 400) {
    const challenge = /error="([^"]+)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1];
    const code = (typeof parsed === "object" && parsed?.error) || challenge || `http_${response.status}`;
    const error = new Refusal(code, response.status, `${method} ${url.pathname}`);
    error.statusCode = response.status;
    throw error;
  }
  return { status: response.status, body: parsed };
}

/**
 * Call an MCP tool (0.10.0's McpClient) with a Bearer Session Token for that server's
 * url: from the Account Token when signed in, otherwise the Session's own renewal.
 */
async function mcpOnce(c, token, params) {
  const apis = c.discovered.document.apis ?? [];
  const api = apis.find((a) => a.type === "mcp" && (a.url === params.api || params.api === undefined || params.api === "mcp"));
  if (!api) throw new StepError(409, "no_api", "the Company lists no MCP server");
  const metadata = oauth(c);
  let bearer;
  if (c.accountRef) {
    const result = await new AccountTokenClient({ reactor: world.reactor, fetch: world.fetch }).bearerForMcp(c.accountRef, {
      context: accountContext(c),
      sessionId: token.sessionId,
      resource: api.url,
    });
    if (result.status !== "signed_in" || !result.token) {
      throw new Refusal(String(result.status ?? "no_bearer"), 0, "no Bearer token for the MCP server");
    }
    bearer = result.token;
  } else {
    bearer = await new SessionClient({ reactor: world.reactor, fetch: world.fetch }).bearerForMcp({
      clientId: world.clientId,
      pairwiseUserId: c.pairwise,
      issuer: metadata.issuer,
      tokenEndpoint: metadata.token_endpoint,
      tenantId: TENANT,
      sessionId: token.sessionId,
      resource: api.url,
    });
  }
  const client = new McpClient({ token: bearer, url: api.url, fetch: world.fetch });
  const result = await client.callTool(String(params.tool), params.args ?? {});
  if (result.operation?.operation_id) c.operations.set(result.operation.operation_id, result.operation);
  return {
    status: 200,
    body: {
      content: result.content,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      isError: result.isError,
      text: result.text,
    },
  };
}

// ---------------------------------------------------------------------------------
// Operations (spec 5.2).

const ops = {
  async discover(c) {
    const d = await discovered(c);
    return {
      issuer: d.oauthMetadata?.issuer ?? d.document.auth?.issuer ?? null,
      poppy_version: d.document.protocol_version,
      conversations: Boolean(d.document.agent?.protocols?.some((p) => p.type === "poppy")),
      apis: (d.document.apis ?? []).map((api) => api.type),
    };
  },

  async session(c) {
    await discovered(c);
    // The Session this agent already holds with the Company, or a new one.
    const token = c.session ?? (await startSession(c));
    return { session_id: token.sessionId, signed_in: token.signedIn, scope: token.scopes.join(" ") };
  },

  async signin(c, params) {
    await ensureSession(c);
    const metadata = oauth(c);
    const auth = c.discovered.document.auth ?? {};
    const method = params.method ?? "direct";
    const scopesFor = (descriptor) => params.scopes ?? descriptor?.scopes ?? [];
    const wanted = scopesFor(auth[method]);
    if (c.accountRef && wanted.every((scope) => (c.grantedScopes ?? []).includes(scope))) {
      if (!c.signedIn) await refreshInto(c);
      if (c.signedIn) {
        return { signed_in: true, account: params.account ?? c.account ?? null, scope: c.signedIn.scopes.join(" ") };
      }
    }
    if (method === "direct") {
      if (!metadata.authorization_endpoint) throw new StepError(501, "unsupported", "no Direct Sign-In");
      world.browser.last = undefined;
      const client = new DirectSignInClient({ reactor: world.reactor, fetch: world.fetch });
      await client.begin({
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        issuer: metadata.issuer,
        clientId: world.clientId,
        redirectUri: world.metadata.redirect_uris[0],
        scopes: scopesFor(auth.direct),
        tenantId: TENANT,
        pairwiseUserId: c.pairwise,
        sessionId: c.session.sessionId,
      });
      c.pending = { method, client };
      return { pending: { url: world.browser.last } };
    }
    if (method === "device") {
      if (!metadata.device_authorization_endpoint) throw new StepError(501, "unsupported", "no Device Sign-In");
      const client = new DeviceSignInClient({ reactor: world.reactor, fetch: world.fetch });
      const start = await client.begin({
        deviceAuthorizationEndpoint: metadata.device_authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
        issuer: metadata.issuer,
        clientId: world.clientId,
        scopes: scopesFor(auth.device),
        tenantId: TENANT,
        pairwiseUserId: c.pairwise,
        sessionId: c.session.sessionId,
      });
      c.pending = { method, client, reference: start.reference };
      return { pending: { url: start.verificationUriComplete ?? start.verificationUri, user_code: start.userCode } };
    }
    if (method === "mediated") {
      if (!auth.mediated) throw new StepError(501, "unsupported", "no Mediated Sign-In");
      c.pending = { method, scopes: scopesFor(auth.mediated), stage: "credentials" };
      return { pending: { fields: auth.mediated.fields.map((field) => field.name) } };
    }
    throw new StepError(400, "bad_request", `unknown method ${method}`);
  },

  async signin_continue(c, params) {
    const pending = c.pending;
    if (!pending) throw new StepError(409, "no_pending_signin", "call signin first");
    if (pending.method === "direct") {
      c.pending = undefined;
      let result;
      try {
        result = await pending.client.complete({ callbackUrl: params.callback_url });
      } catch (error) {
        // An OAuth error the Company sent back through the redirect is the Company's
        // refusal (spec 5.2 poppy_error), not an adapter failure. It has no HTTP status.
        const refused = error?.code === "authorization_denied" && new URL(params.callback_url).searchParams.get("error");
        if (refused) throw new Refusal(refused, 0, "the Company's redirect carried an error");
        throw error;
      }
      c.accountRef = result.accountTokenReference;
      return signedInResult(c, result.token, result.grantedScopes, params);
    }
    if (pending.method === "device") {
      const deadline = Date.now() + (params.timeout_ms ?? 60_000);
      for (;;) {
        let poll;
        try {
          poll = await pending.client.poll(pending.reference);
        } catch (error) {
          c.pending = undefined;
          throw error;
        }
        if (poll.status === "complete") {
          c.pending = undefined;
          c.accountRef = poll.accountTokenReference;
          return signedInResult(c, poll.token, poll.grantedScopes, params);
        }
        const wait = Math.max(0, (poll.retryAt?.getTime() ?? Date.now() + 5000) - Date.now());
        if (Date.now() + wait > deadline) return { pending: { reason: "authorization_pending" } };
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    if (pending.method === "mediated") {
      const auth = c.discovered.document.auth;
      const client = new MediatedSignInClient({ reactor: world.reactor, fetch: world.fetch });
      world.input.answers = [pending.stage === "code" ? { code: params.code ?? params.fields?.code } : (params.fields ?? {})];
      let result;
      if (pending.stage === "credentials") {
        result = await client.signIn({
          mediated: auth.mediated,
          organization: c.discovered.document.organization,
          issuer: oauth(c).issuer,
          scopes: pending.scopes,
          token: c.session,
          ...{ tenantId: TENANT, pairwiseUserId: c.pairwise },
        });
      } else {
        result = await client.submitCode(pending.reference, { token: c.session, ...who(c) });
      }
      if (result.status === "code_required") {
        c.pending = { ...pending, stage: "code", reference: result.reference };
        return { pending: { code_required: true, fields: ["code"], sent_to: result.sentTo ?? null } };
      }
      c.pending = undefined;
      if (result.status !== "complete") throw new Refusal(result.status === "failed" ? "access_denied" : `mediated_${result.status}`, 0, "Mediated Sign-In did not complete");
      c.accountRef = result.accountTokenReference;
      return signedInResult(c, result.token, result.grantedScopes, params);
    }
    throw new StepError(500, "internal", "unknown pending method");
  },

  async send(c, params) {
    await ensureSession(c);
    const endpoint = conversationEndpoint(c);
    // `message_id` is a retry key (spec 5.2): the same key sends the same message, same id,
    // as the same request. A retried first message starts the conversation again (Poppy 7.3
    // answers it with the original response); it doesn't go to the conversation it started,
    // which Companies disagree about (spec issue S9).
    const key = params.message_id;
    const retried = key === undefined ? undefined : c.retryKeys?.get(key);
    const message = retried?.message ?? { id: world.conversations.generateMessageId(), sender: params.sender ?? "human", text: params.text };
    const conversation = params.conversation ?? retried?.conversation;
    const result = await withSession(c, (token) => sendOnce(c, endpoint, token, message, conversation, params));
    if (key !== undefined && !retried) (c.retryKeys ??= new Map()).set(key, { message, conversation });
    return result;
  },

  async read(c, params) {
    return withSession(c, (token) => readOnce(c, token, params));
  },

  async sse(c, params) {
    return withSession(c, (token) => sseOnce(c, token, params));
  },

  async api(c, params) {
    if (params.tool !== undefined || params.api === "mcp") {
      return withSession(c, (token) => mcpOnce(c, token, params));
    }
    return withSession(c, (token) => apiOnce(c, token, params));
  },

  async approve_op(c, params) {
    const token = await ensureSession(c);
    const operation = c.operations.get(params.operation);
    if (!operation) throw new StepError(404, "unknown_operation", "no proposal with that id has been seen");
    const endpoint = operationsEndpoint(c.discovered.document, parseClientMetadata(world.metadata));
    if (!endpoint) throw new StepError(409, "no_operations", "the Company doesn't offer Operations v1");
    const client = new OperationsClient({ reactor: world.reactor, transport: world.transport });
    if (params.decision === "decline") {
      const cancelled = await client.cancel(endpoint, operation.operation_id, { token, ...who(c) });
      return { status: cancelled.state, operation: cancelled };
    }
    const outcome = await client.confirm(endpoint, operation, { token, ...who(c), approval: await approve(operation) });
    return { status: outcome.operation?.state ?? outcome.status, outcome: outcome.status, operation: outcome.operation ?? null };
  },

  async signout(c) {
    await discovered(c);
    const metadata = oauth(c);
    if (!c.accountRef) return { revoked: false };
    const result = await new AccountTokenClient({ reactor: world.reactor, fetch: world.fetch }).revoke(c.accountRef, {
      context: {
        tokenEndpoint: metadata.token_endpoint,
        issuer: metadata.issuer,
        clientId: world.clientId,
        tenantId: TENANT,
        pairwiseUserId: c.pairwise,
        revocationEndpoint: metadata.revocation_endpoint,
      },
    });
    c.accountRef = undefined;
    c.signedIn = undefined;
    c.session = undefined;
    return { revoked: result.revoked };
  },

  async state() {
    const sessions = [];
    const accounts = [];
    for (const c of world.companies.values()) {
      if (c.session) {
        sessions.push({ company: c.host, session_id: c.session.sessionId, signed_in: c.session.signedIn, scope: c.session.scopes.join(" ") });
      }
      if (c.accountRef) accounts.push({ company: c.host, scope: c.signedIn?.scopes.join(" ") ?? "" });
    }
    return { sessions, accounts };
  },

  /** Browser Session join (spec 5): the SDK's BrowserSessionClient, posting through the host's poster. */
  async web_join(c, params) {
    await discovered(c);
    const endpoint = c.discovered.document.web?.browser_session_endpoint;
    if (!endpoint) throw new Refusal("no_browser_sessions", 0, "the Company declares no browser_session_endpoint");
    world.poster.last = undefined;
    await withSession(c, (token) =>
      new BrowserSessionClient({ reactor: world.reactor }).join({
        clientId: world.clientId,
        pairwiseUserId: c.pairwise,
        browserSessionEndpoint: endpoint,
        sessionId: token.sessionId,
        returnTo: params.url ?? `https://${c.discovered.document.organization.domain}/`,
        companyDomain: c.discovered.document.organization.domain,
      }),
    );
    const last = world.poster.last;
    return { joined: !!last && last.status >= 300 && last.status < 400 && last.cookies.length > 0, status: last?.status ?? null, location: last?.location ?? null };
  },

  /** Ask for a person (7.9): the SDK's ConversationClient.handoff. */
  async handoff(c, params) {
    await ensureSession(c);
    const endpoint = conversationEndpoint(c);
    const receipt = await withSession(c, (token) => world.conversations.handoff(endpoint, params.conversation, { token, ...who(c) }));
    return { status: receipt.status, responder: receipt.responder };
  },

  /** Close a conversation (7.12): the SDK's ConversationClient.close. */
  async close(c, params) {
    await ensureSession(c);
    const endpoint = conversationEndpoint(c);
    const receipt = await withSession(c, (token) => world.conversations.close(endpoint, params.conversation, { token, ...who(c) }));
    return { status: receipt.status, responder: receipt.responder };
  },

  /**
   * Confirm again (Ops 5.2, 6): the SDK's OperationsClient.confirm with the proposal as the
   * agent first saw it, as a host retries after losing the first answer. The SDK refuses
   * locally only an operation it is handed in another state.
   */
  async confirm_again(c, params) {
    const token = await ensureSession(c);
    const operation = c.operations.get(params.operation);
    if (!operation) throw new StepError(404, "unknown_operation", "no proposal with that id has been seen");
    const endpoint = operationsEndpoint(c.discovered.document, parseClientMetadata(world.metadata));
    if (!endpoint) throw new StepError(409, "no_operations", "the Company doesn't offer Operations v1");
    const client = new OperationsClient({ reactor: world.reactor, transport: world.transport });
    const outcome = await client.confirm(endpoint, operation, { token, ...who(c), approval: await approve(operation) });
    return { status: outcome.operation?.state ?? outcome.status, outcome: outcome.status, operation: outcome.operation ?? null };
  },
};

// ---------------------------------------------------------------------------------
// HTTP plumbing.

function send(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function authorized(request) {
  return SECRET !== "" && request.headers.authorization === `Bearer ${SECRET}`;
}

function errorOf(error) {
  if (error instanceof StepError) {
    return error.status === 501
      ? [501, { error: "unsupported", detail: error.message }]
      : [error.status, { error: error.code, detail: error.message }];
  }
  if (error instanceof Refusal) {
    return [200, { ok: false, poppy_error: error.code, status: error.status, detail: error.message }];
  }
  const status = error?.statusCode;
  if (typeof error?.code === "string" && typeof status === "number" && status >= 400) {
    // A refusal the Company sent: not an adapter error (spec 5.2).
    return [200, { ok: false, poppy_error: error.code, status, detail: error.message }];
  }
  if (typeof error?.code === "string") {
    // The SDK refused something the Company did or sent: the agent's own refusal, status 0.
    return [200, { ok: false, poppy_error: error.code, status: 0, detail: String(error.message ?? error) }];
  }
  return [500, { error: "adapter_error", detail: String(error?.stack ?? error) }];
}

let queue = Promise.resolve();
function serialized(work) {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

const control = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://control").pathname;
  try {
    if (request.method === "GET" && path === "/manifest") return send(response, 200, MANIFEST);
    if (request.method === "GET" && path === "/healthz") return send(response, 200, { ok: true });
    if (!authorized(request)) return send(response, 401, { error: "unauthorized", detail: "Bearer INTEROP_SECRET required" });
    if (request.method === "POST" && path === "/reset") {
      await serialized(buildWorld);
      return send(response, 200, { ok: true, result: {} });
    }
    if (request.method === "POST" && path === "/step") {
      const body = await readJson(request);
      const op = ops[body.op];
      if (!op) return send(response, 501, { error: "unsupported", detail: `op ${body.op}` });
      const result = await serialized(() => op(body.op === "state" ? undefined : company(body.company), body.params ?? {}));
      return send(response, 200, { ok: true, result });
    }
    return send(response, 404, { error: "not_found" });
  } catch (error) {
    const [status, body] = errorOf(error);
    console.error(`[adapter] ${request.method} ${path}:`, error?.code ?? "", error?.message ?? error);
    return send(response, status, body);
  }
});

const identity = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://identity").pathname;
  if (request.method === "GET" && path === "/agent.json") return send(response, 200, world.metadata);
  if (request.method === "GET" && path === "/jwks.json") return send(response, 200, world.jwks);
  if (path === "/oauth/callback") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    return response.end("Sign-in callback received; the interop runner hands it to the adapter.\n");
  }
  return send(response, 404, { error: "not_found" });
});

await buildWorld();
identity.listen(8080, "0.0.0.0");
control.listen(8081, "0.0.0.0", () => console.log(`[adapter] ${NAME} agent at ${ORIGIN}; control on 8081`));
