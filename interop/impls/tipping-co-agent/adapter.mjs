// Interop adapter (docs/interop-spec.md 5.1, 5.2) for the Personal Agent of
// timothyohare/personal-agent-protocol: packages/agent's CompanyClient, driven directly (no
// model, no CLI), and packages/agent-host's identity app for the client metadata and JWKS.
//
// Port 8080 (behind the proxy, as https://tipping-co.agent.interop.test) serves upstream's
// createAgentHost app: /agent.json (the client_id), /jwks.json and /oauth/callback. Port 8081
// is the control API. The adapter lives in the upstream checkout (/upstream/interop-adapter.mjs)
// so the workspace's packages resolve; Node 24 runs their TypeScript directly, as upstream's
// scripts do. It imports packages/agent/src/company.ts by path rather than the package's index,
// which would also load the LangChain chat loop the grid never uses. Nothing upstream is patched.
import http from 'node:http';
import { serve } from '@hono/node-server';
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { createAgentHost } from 'agent-host';
import { createLogger, PoppyError } from 'poppy-core';
import { CompanyClient } from '/upstream/packages/agent/src/company.ts';
import { loadIdentity } from '/upstream/packages/agent/src/identity.ts';
import { MemoryVault } from '/upstream/packages/agent/src/vault.ts';

const PORT = Number(process.env.PORT ?? 8080);
const ADAPTER_PORT = Number(process.env.ADAPTER_PORT ?? 8081);
const ORIGIN = (process.env.INTEROP_ORIGIN ?? 'https://tipping-co.agent.interop.test').replace(/\/+$/, '');
const SECRET = process.env.INTEROP_SECRET ?? '';
const COMMIT = process.env.INTEROP_COMMIT ?? 'fb7b4e64ad343d9406055a995f4beb06269c1ce6';

const MANIFEST = {
  interop: 1,
  name: 'tipping-co',
  role: 'agent',
  commit: COMMIT,
  poppy: ['0.1'],
  extensions: [],
  // Discovery, signed-out Sessions, Direct Sign-In, renewal with the Account Token, sign-out and
  // OpenAPI calls. No conversations, device or mediated sign-in, MCP, browser joins or
  // Operations.
  scenarios: ['D', 'DP', 'S0', 'N', 'CM', 'SD', 'SX', 'SO', 'R', 'AO', 'AS', 'RL', 'XH', 'XI', 'BX', 'XB', 'XN'],
  readings: {
    // clientAssertion's aud is the token endpoint everywhere, at /oauth/revoke too (company.ts signOut).
    S1: 'token-endpoint',
    // ES256 with a kid, a 60 s lifetime and no typ header (poppy-core assertions.ts).
    S2: 'any',
    // metadataUrl puts the well-known segment between host and path (discover.ts).
    S3: 'insertion',
    // A signed-out Session request carries no scope.
    S4: 'omit',
    // DPoP nonces are kept per origin (CompanyClient.nonces).
    S23: 'per-origin'
  },
  relaxations: ['The run CA is trusted through NODE_EXTRA_CA_CERTS']
};

class AdapterError extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}
const unsupported = (what) => new AdapterError(501, 'unsupported', what);

const log = createLogger('agent', (line) => console.log(line));

/** Everything /reset forgets: the signing key (a new kid), the vault, every Company client. */
let world;
async function freshWorld() {
  const kp = await generateKeyPair('ES256', { extractable: true });
  const pub = await exportJWK(kp.publicKey);
  const kid = `${(await calculateJwkThumbprint(pub, 'sha256')).slice(0, 16)}-${Date.now().toString(36)}`;
  const publicJwk = { ...pub, kid, alg: 'ES256', use: 'sig' };
  const privateJwk = { ...(await exportJWK(kp.privateKey)), kid, alg: 'ES256' };
  const host = createAgentHost({ baseUrl: ORIGIN, clientName: 'Tipping Co demo agent (interop)', publicJwks: [publicJwk] });
  const identity = await loadIdentity(`${ORIGIN}/agent.json`, privateJwk);
  world = { kid, host, deps: { identity, vault: new MemoryVault(), log }, clients: new Map(), openapi: new Map() };
}

function client(company) {
  if (!company || typeof company !== 'string') throw new AdapterError(400, 'bad_request', 'company is required');
  let c = world.clients.get(company);
  if (!c) world.clients.set(company, (c = new CompanyClient(company, world.deps)));
  return c;
}

/** The OpenAPI entry the step names: "openapi" (the first) or an entry's url. */
async function openApiDocument(c, api) {
  const { poppy } = await c.discovered();
  const entries = (poppy.apis ?? []).filter((a) => a.type === 'openapi');
  const entry = api === 'openapi' || api === undefined ? entries[0] : entries.find((a) => a.url === api);
  if (!entry) throw unsupported(`no OpenAPI API ${api}`);
  let doc = world.openapi.get(entry.url);
  if (!doc) {
    // What a model would read to choose a path; the agent itself never fetches it.
    const res = await fetch(entry.url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new AdapterError(502, 'openapi_unavailable', `${entry.url} answered ${res.status}`);
    doc = await res.json();
    world.openapi.set(entry.url, doc);
  }
  return { entry, doc };
}

/** Resolves "METHOD /path" or an operationId to a method and the path the agent's call() takes. */
function operationPath(doc, entryUrl, operation, params = {}) {
  let method;
  let template;
  const m = /^([A-Z]+) (\/\S*)$/.exec(operation ?? '');
  if (m) [, method, template] = m;
  else {
    for (const [p, item] of Object.entries(doc.paths ?? {})) {
      for (const [verb, op] of Object.entries(item ?? {})) {
        if (op?.operationId === operation) [method, template] = [verb.toUpperCase(), p];
      }
    }
  }
  if (!method) throw new AdapterError(400, 'unknown_operation', `no operation ${operation}`);
  const rest = { ...params };
  let path = template.replace(/\{([^}]+)\}/g, (_, k) => {
    const v = rest[k];
    delete rest[k];
    return encodeURIComponent(String(v ?? ''));
  });
  if (Object.keys(rest).length) path += `?${new URLSearchParams(rest)}`;
  // The API's base: the document's first server, relative to the document's own URL.
  const base = new URL(doc.servers?.[0]?.url ?? '/', entryUrl);
  const url = new URL(base.pathname.replace(/\/$/, '') + path, base);
  // call() sends every path to the OpenAPI document's origin.
  if (url.origin !== new URL(entryUrl).origin) throw unsupported(`the API's server ${base.origin} isn't the OpenAPI document's origin, which this client always calls`);
  return { method, path: url.pathname + url.search };
}

const ops = {
  async discover({ company }) {
    const { poppy, metadata } = await client(company).discovered();
    return {
      issuer: metadata.issuer,
      poppy_version: poppy.protocol_version,
      conversations: Boolean(poppy.agent),
      apis: [...new Set((poppy.apis ?? []).map((a) => a.type))]
    };
  },

  async session({ company }) {
    const s = await client(company).ensureSession();
    return { session_id: s.sessionId, signed_in: s.signedIn, scope: s.scope.join(' ') };
  },

  async signin({ company, params }) {
    const method = params.method ?? 'direct';
    if (method !== 'direct') throw unsupported(`${method} sign-in`);
    const c = client(company);
    const { poppy } = await c.discovered();
    const scopes = params.scopes?.length ? [].concat(params.scopes) : poppy.auth.direct?.scopes ?? [];
    // An Account Token that already covers the scopes signs the Session in again (4.8).
    const held = await c.accountToken();
    if (held && scopes.every((s) => held.scope.includes(s))) {
      const s = await c.refreshIntoSession();
      return { signed_in: true, account: null, scope: s.scope.join(' ') };
    }
    return { pending: { url: await c.beginSignIn(scopes) } };
  },

  async signin_continue({ company, params }) {
    if (!params.callback_url) throw unsupported('Direct Sign-In continues only with callback_url');
    const s = await client(company).completeSignIn(params.callback_url);
    return { signed_in: s.signedIn, account: null, scope: s.scope.join(' ') };
  },

  async api({ company, params }) {
    if (params.tool !== undefined || params.api === 'mcp') throw unsupported('MCP');
    if (params.args?.files) throw unsupported('file uploads');
    const c = client(company);
    const { entry, doc } = await openApiDocument(c, params.api);
    const { method, path } = operationPath(doc, entry.url, params.operation, params.args?.params);
    const r = await c.call(method, path, params.args?.body);
    if (r.error) throw new PoppyError(r.error, r.status, `${method} ${path}`);
    return { status: r.status, body: r.body };
  },

  async signout({ company }) {
    return { revoked: await client(company).signOut() };
  },

  async state() {
    const sessions = [];
    const accounts = [];
    for (const c of world.clients.values()) {
      const issuer = c.discovery?.metadata.issuer ?? null;
      if (c.session) sessions.push({ issuer, session_id: c.session.sessionId, signed_in: c.session.signedIn });
      if (c.discovery && (await c.accountToken())) accounts.push({ issuer, scope: (await c.accountToken()).scope });
    }
    return { sessions, accounts };
  }
};

// --- the two servers ------------------------------------------------------------------

await freshWorld();
serve({ fetch: (req, env) => world.host.fetch(req, env), port: PORT, hostname: '0.0.0.0' });

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

http.createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  try {
    if (req.method === 'GET' && path === '/manifest') return send(res, 200, MANIFEST);
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ready: true });
    if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) {
      return send(res, 401, { error: 'unauthorized', detail: 'Bearer INTEROP_SECRET required' });
    }
    if (req.method === 'POST' && path === '/reset') {
      await freshWorld();
      return send(res, 200, { reset: true, kid: world.kid });
    }
    if (req.method === 'POST' && path === '/step') {
      const body = await readJson(req);
      const op = ops[body.op];
      if (!op) return send(res, 501, { error: 'unsupported', detail: `op ${body.op}` });
      try {
        return send(res, 200, { ok: true, result: await op({ company: body.company, params: body.params ?? {} }) });
      } catch (e) {
        if (e instanceof AdapterError) throw e;
        // The agent's own refusals (discovery_failed, access_denied, state_mismatch) carry status 0.
        if (e instanceof PoppyError) return send(res, 200, { ok: false, poppy_error: e.code, status: e.status ?? 0, detail: e.message });
        throw e;
      }
    }
    return send(res, 404, { error: 'not_found', detail: path });
  } catch (e) {
    return send(res, e.status ?? 500, { error: e.code ?? 'adapter_failed', detail: String(e.message ?? e) });
  }
}).listen(ADAPTER_PORT, '0.0.0.0', () => console.log(`[adapter] agent ${ORIGIN}/agent.json; control API on ${ADAPTER_PORT}`));
