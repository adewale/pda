// Interop adapter for the adonis-agora Personal Agent (docs/interop-spec.md 5.2). It drives the
// library's protocol functions (@adonis-agora/agent/poppy-client, built from the pinned source
// into poppy-client.mjs) directly: no model, no CLI. Port 8080 serves the agent's identity with
// the library's own identity server; port 8081 is the control API.
import { createServer } from 'node:http';
import {
  AgentIdentity,
  callOpenApi,
  DiscoveryError,
  completeDirectSignIn,
  ConversationClient,
  connectMcp,
  createBrowserAssertion,
  generateEs256Key,
  listApis,
  loadOpenApi,
  mediatedSignIn,
  newMessageId,
  PoppyAgent,
  PoppyError,
  parseSse,
  pollDeviceSignInOnce,
  poppyProtocol,
  StateStore,
  startDirectSignIn,
  startIdentityServer,
  submitMediatedCode,
} from './poppy-client.mjs';

const SECRET = process.env.INTEROP_SECRET ?? '';
const ORIGIN = (process.env.INTEROP_ORIGIN ?? process.env.AGENT_ORIGIN ?? 'https://adonis-agora.agent.interop.test').replace(/\/+$/, '');
const PORT = Number(process.env.PORT ?? 8080);
const ADAPTER_PORT = Number(process.env.ADAPTER_PORT ?? 8081);

const MANIFEST = {
  interop: 1,
  name: 'adonis-agora',
  role: 'agent',
  commit: process.env.INTEROP_COMMIT || 'e66a2329d436f603dd7c57a0ca81b36e65bd486f',
  components: { '@adonis-agora/agent/poppy-client': '0.79.0 (built from source)' },
  poppy: ['0.1'],
  extensions: [],
  // No O/OX: the client has no Operations extension.
  scenarios: ['D', 'CM', 'S0', 'N', 'SD', 'SV', 'SXV', 'SM', 'SMC', 'SX', 'R', 'SE', 'SO', 'C', 'CI', 'CS', 'CA', 'AO', 'AM', 'AS', 'RL', 'W'],
  readings: { S1: 'token-endpoint', S2: 'any', S3: 'insertion', S4: 'omit', S23: 'per-origin' },
  relaxations: ['Container trusts the run CA (/interop/ca.pem) through NODE_EXTRA_CA_CERTS and the system store'],
  notes:
    'Client assertions are signed with a 60 s lifetime and no typ header (S2). Revocation assertions also use the token endpoint as aud.',
};

const log = (line) => console.log(`[poppy-client] ${line}`);

/** Everything /reset forgets: keys, identity, state, pending sign-ins, conversations' cursors. */
let world;
async function freshWorld() {
  if (world?.identityServer) await world.identityServer.close();
  const identity = new AgentIdentity({
    baseUrl: ORIGIN,
    clientName: 'adonis-agora poppy-client (interop)',
    keys: [await generateEs256Key()],
  });
  const store = StateStore.memory();
  const agent = new PoppyAgent({ store, identity, log });
  const callbacks = [];
  const identityServer = await startIdentityServer(identity, {
    host: '0.0.0.0',
    port: PORT,
    onCallback: (params) => callbacks.push(params),
    log: (l) => log(`identity ${l}`),
  });
  world = { identity, store, agent, identityServer, callbacks, companies: new Map(), pending: new Map(), cursors: new Map(), retryKeys: new Map() };
}

async function company(host) {
  if (!host || typeof host !== 'string') throw new AdapterError(400, 'bad_request', 'company is required');
  let c = world.companies.get(host);
  if (!c) {
    c = await world.agent.company(host);
    world.companies.set(host, c);
  }
  return c;
}

class AdapterError extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}
const unsupported = (what) => new AdapterError(501, 'unsupported', what);

function messagesOf(events) {
  return (events ?? [])
    .filter((e) => e?.type === 'message' && e.message)
    .map((e) => ({ role: e.message.role ?? (e.message.sender === 'agent' ? 'company' : 'user'), sender: e.message.sender, text: e.message.text ?? '', id: e.message.id, ...(e.message.data ? { data: e.message.data } : {}) }));
}

function scopeFor(c, method, scopes) {
  if (scopes?.length) return [].concat(scopes).join(' ');
  const offered = c.document.auth?.[method]?.scopes ?? [];
  if (!offered.length) throw new PoppyError('unsupported_sign_in', `${method} sign-in is not offered`);
  return offered.join(' ');
}

/** Reads events after the saved cursor until the Company is no longer working (bounded). */
async function drain(conv, id, untilMs = 20_000) {
  const deadline = Date.now() + untilMs;
  const events = [];
  let page;
  for (;;) {
    page = await conv.read(id, { cursor: world.cursors.get(id) || undefined, wait: 5 });
    events.push(...page.events);
    if (page.cursor) world.cursors.set(id, page.cursor);
    if (page.has_more) continue;
    if (page.status !== 'working' || Date.now() > deadline) break;
  }
  return { events, page };
}

const ops = {
  async discover({ company: host }) {
    const c = await company(host);
    return {
      issuer: c.issuer,
      poppy_version: c.document.protocol_version,
      conversations: !!poppyProtocol(c),
      apis: [...new Set(listApis(c).map((a) => a.type))],
    };
  },

  async session({ company: host }) {
    const c = await company(host);
    const t = await c.token();
    return { session_id: t.sessionId, signed_in: t.signedIn, scope: t.scope };
  },

  async signin({ company: host, params }) {
    const c = await company(host);
    const method = params.method ?? 'direct';
    // An Account Token that already covers the scopes signs the Session in without a new
    // sign-in (4.8): the library renews with it.
    const acct = c.accountToken;
    const wanted = params.scopes?.length ? [].concat(params.scopes) : [];
    if (acct && wanted.every((x) => acct.scope.split(' ').includes(x))) {
      const t = await c.token({ forceRenew: true });
      if (t.signedIn) return { signed_in: true, account: null, scope: t.scope };
    }
    if (method === 'direct') {
      const p = await startDirectSignIn(c, scopeFor(c, 'direct', params.scopes));
      world.pending.set(host, { method, p });
      return { pending: { url: p.url } };
    }
    if (method === 'device') {
      const scope = scopeFor(c, 'device', params.scopes);
      await c.token(); // a Session to sign in
      const d = await c.tokens.deviceAuthorization(scope);
      world.pending.set(host, { method, scope, d });
      return { pending: { url: d.verification_uri_complete ?? d.verification_uri, user_code: d.user_code } };
    }
    if (method === 'mediated') {
      const m = c.document.auth?.mediated;
      if (!m) throw new PoppyError('unsupported_sign_in', 'mediated sign-in is not offered');
      world.pending.set(host, { method, scope: scopeFor(c, 'mediated', params.scopes) });
      return { pending: { fields: m.fields } };
    }
    throw unsupported(`sign-in method ${method}`);
  },

  async signin_continue({ company: host, params }) {
    const c = await company(host);
    const pending = world.pending.get(host);
    if (!pending) throw new AdapterError(409, 'no_pending_sign_in', 'call signin first');
    let result;
    if (pending.method === 'direct') {
      let query;
      if (params.callback_url) query = new URL(params.callback_url).searchParams;
      else query = world.callbacks.findLast((q) => q.get('state') === pending.p.state);
      if (!query) throw new AdapterError(400, 'no_callback', 'no callback_url and none received');
      world.pending.delete(host);
      result = await completeDirectSignIn(c, pending.p, query);
    } else if (pending.method === 'device') {
      const interval = Math.max(1, pending.d.interval ?? 5);
      const deadline = Date.now() + Math.min(pending.d.expires_in ?? 60, 90) * 1000;
      for (;;) {
        const r = await pollDeviceSignInOnce(c, pending.d.device_code, pending.scope);
        if (r !== 'pending') {
          result = r;
          break;
        }
        if (Date.now() > deadline) throw new PoppyError('authorization_pending', 'still pending', { status: 400 });
        await new Promise((ok) => setTimeout(ok, interval * 1000));
      }
      world.pending.delete(host);
    } else {
      const fields = params.fields ?? {};
      const outcome = pending.signInId
        ? await submitMediatedCode(c, pending.scope, pending.signInId, String(params.code ?? fields.code ?? ''))
        : await mediatedSignIn(c, pending.scope, fields);
      if (outcome.status === 'code_required') {
        world.pending.set(host, { ...pending, signInId: outcome.signInId });
        return { pending: { code_required: true, sent_to: outcome.sentTo } };
      }
      if (outcome.status !== 'complete') throw new PoppyError(outcome.status, `mediated sign-in ${outcome.status}`);
      world.pending.delete(host);
      result = outcome.result;
    }
    return { signed_in: true, account: null, scope: result.grantedScope, session_id: result.sessionId, missing_scopes: result.missingScopes };
  },

  async send({ company: host, params }) {
    const c = await company(host);
    const conv = new ConversationClient(c);
    // `message_id` is a retry key: the same key sends the same message with the same id (7.3).
    let id0 = params.message_id ? world.retryKeys.get(params.message_id) : undefined;
    if (!id0) {
      id0 = params.message_id && /^[A-Za-z0-9_-]{1,256}$/.test(params.message_id) ? params.message_id : newMessageId();
      if (params.message_id) world.retryKeys.set(params.message_id, id0);
    }
    const message = { id: id0, sender: params.sender ?? 'agent', text: params.text };
    const wait = params.wait === undefined ? 10 : params.wait === true ? 10 : params.wait === false ? undefined : Number(params.wait);
    let r;
    if (params.conversation) {
      r = await conv.send(params.conversation, message, { wait, cursor: world.cursors.get(params.conversation) || undefined });
    } else {
      r = await conv.start(message, { wait, ...(params.parent_conversation ? { parentConversationId: params.parent_conversation } : {}) });
    }
    const id = r.conversation_id;
    let events = r.events ?? [];
    if (r.cursor) world.cursors.set(id, r.cursor);
    let status = r.status;
    if (r.events === undefined || status === 'working') {
      const d = await drain(conv, id);
      events = events.concat(d.events);
      status = d.page.status;
    }
    return { conversation: id, message_id: message.id, status, messages: messagesOf(events), events };
  },

  async read({ company: host, params }) {
    const c = await company(host);
    const conv = new ConversationClient(c);
    const page = await conv.read(params.conversation, {
      cursor: params.cursor,
      ...(typeof params.wait === 'number' ? { wait: params.wait } : {}),
    });
    if (page.cursor) world.cursors.set(params.conversation, page.cursor);
    return { messages: messagesOf(page.events), cursor: page.cursor ?? null, has_more: !!page.has_more, status: page.status, events: page.events };
  },

  async sse({ company: host, params }) {
    const c = await company(host);
    const conv = new ConversationClient(c);
    const max = Number(params.max_events ?? 50);
    // Stop once the stream has been quiet for `wait` seconds (default 1), or after 10 s.
    const quietMs = Math.max(0.2, Number(params.wait ?? 1)) * 1000;
    const ctrl = new AbortController();
    const hard = setTimeout(() => ctrl.abort(), 10_000);
    let quiet;
    const arm = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => ctrl.abort(), quietMs);
    };
    const events = [];
    try {
      const headers = { accept: 'text/event-stream' };
      if (params.cursor) headers['last-event-id'] = params.cursor;
      const url = `${conv.endpoint}/${encodeURIComponent(params.conversation)}/events`;
      const res = await c.fetch(url, { headers, signal: ctrl.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { __poppy: { poppy_error: body.error ?? `http_${res.status}`, status: res.status } };
      }
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        await res.body?.cancel().catch(() => {});
        return { __poppy: { poppy_error: 'not_streamed', status: res.status, detail: 'the Company answered without an event stream' } };
      }
      arm();
      for await (const e of parseSse(res.body)) {
        let data = e.data;
        try {
          data = JSON.parse(e.data);
        } catch {}
        events.push({ id: e.id ?? null, type: e.event, data });
        arm();
        if (events.length >= max) break;
      }
    } catch (e) {
      if (!ctrl.signal.aborted) throw e;
    } finally {
      clearTimeout(hard);
      clearTimeout(quiet);
      ctrl.abort();
    }
    const ids = events.map((e) => e.id).filter(Boolean);
    return { events, last_id: ids.at(-1) ?? params.cursor ?? null };
  },

  async api({ company: host, params }) {
    const c = await company(host);
    // `api` is the API's type ("openapi", "mcp"); a URL also works.
    const wantedType = params.tool && !params.operation ? 'mcp' : (params.api ?? 'openapi');
    const entry = listApis(c).find((a) => a.url === params.api) ?? listApis(c).find((a) => a.type === wantedType);
    if (!entry) throw new PoppyError('no_api', `Company lists no ${wantedType} API`, { status: 0 });
    if (entry.type === 'mcp' || params.tool) {
      const index = listApis(c).filter((a) => a.type === 'mcp').indexOf(entry);
      const conn = await connectMcp(c, index < 0 ? undefined : index);
      try {
        const r = await conn.client.callTool({ name: params.tool, arguments: params.args ?? {} });
        return { status: r.isError ? 500 : 200, body: r };
      } finally {
        await conn.close().catch(() => {});
      }
    }
    const doc = await loadOpenApi(c, entry);
    let method;
    let path;
    for (const [p, item] of Object.entries(doc.paths ?? {})) {
      for (const [m, op] of Object.entries(item ?? {})) if (op?.operationId === params.operation) [method, path] = [m, p];
    }
    if (!method) throw new AdapterError(400, 'unknown_operation', `no operationId ${params.operation}`);
    // args.params fill path templates; what's left goes in the query string.
    const args = params.args ?? {};
    const rest = { ...(args.params ?? {}) };
    path = path.replace(/\{([^}]+)\}/g, (_, k) => {
      const v = rest[k];
      delete rest[k];
      return encodeURIComponent(String(v ?? ''));
    });
    if (Object.keys(rest).length) path += `?${new URLSearchParams(rest)}`;
    const index = listApis(c).filter((a) => a.type === 'openapi').indexOf(entry);
    const r = await callOpenApi(c, { method, path, body: args.body, apiIndex: index < 0 ? undefined : index });
    return { status: r.status, body: r.body };
  },

  async web_join({ company: host, params }) {
    const c = await company(host);
    // What the library's one-shot page makes a browser do: POST the assertion as a form.
    const { endpoint, assertion } = await createBrowserAssertion(c, params.url);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ assertion }).toString(),
      redirect: 'manual',
    });
    const joined = res.status >= 300 && res.status < 400 && res.headers.getSetCookie().length > 0;
    return { joined, status: res.status, location: res.headers.get('location') };
  },

  async approve_op() {
    throw unsupported('the Operations extension is not implemented by this client');
  },

  async signout({ company: host }) {
    const c = await company(host);
    return { revoked: await c.signOut() };
  },

  async state() {
    const companies = world.store.profile('default').companies;
    return {
      sessions: Object.values(companies).map((s) => ({
        issuer: s.issuer,
        session_id: s.sessionId ?? null,
        signed_in: Object.values(s.tokens).some((t) => t.signedIn),
      })),
      accounts: Object.values(companies)
        .filter((s) => s.accountToken)
        .map((s) => ({ issuer: s.issuer, scope: s.accountToken.scope, via: s.accountToken.via })),
    };
  },
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString('utf8');
  return t ? JSON.parse(t) : {};
}

await freshWorld();
createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  try {
    if (req.method === 'GET' && path === '/manifest') return send(res, 200, MANIFEST);
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ready: true });
    if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) {
      return send(res, 401, { error: 'unauthorized', detail: 'Bearer INTEROP_SECRET required' });
    }
    if (req.method === 'POST' && path === '/reset') {
      await freshWorld();
      return send(res, 200, { reset: true, kid: world.identity.keys[0].kid });
    }
    if (req.method === 'POST' && path === '/step') {
      const body = await readJson(req);
      const op = ops[body.op];
      if (!op) return send(res, 501, { error: 'unsupported', detail: `op ${body.op}` });
      try {
        const result = await op({ company: body.company, params: body.params ?? {} });
        if (result?.__poppy) return send(res, 200, { ok: false, ...result.__poppy });
        return send(res, 200, { ok: true, result });
      } catch (e) {
        if (e instanceof AdapterError) throw e;
        // The agent's own refusals (documents it won't use, a declined sign-in) carry status 0.
        if (e instanceof DiscoveryError) {
          return send(res, 200, { ok: false, poppy_error: 'discovery_failed', status: 0, detail: `${e.code}: ${e.message}` });
        }
        if (e instanceof PoppyError) {
          return send(res, 200, { ok: false, poppy_error: e.code, status: e.status ?? 0, detail: e.message });
        }
        throw e;
      }
    }
    return send(res, 404, { error: 'not_found', detail: path });
  } catch (e) {
    return send(res, e.status ?? 500, { error: e.code ?? 'adapter_failed', detail: String(e.message ?? e) });
  }
}).listen(ADAPTER_PORT, '0.0.0.0', () => log(`control API on ${ADAPTER_PORT}; identity ${world.identity.clientId}`));
