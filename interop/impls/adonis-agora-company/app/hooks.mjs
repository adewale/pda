// Interop adapter for the adonis-agora Company (docs/interop-spec.md 5.3), on the control port.
// It runs in the host's process so the hooks that stand in for staff and for a person's phone
// can use the app directly. Sign-in approvals never touch the libraries' internals: the hooks
// act as the person in a browser, signing in on the host's login page and submitting AuthKit's
// own consent forms over the public origin, the same requests a browser would make.
import { randomBytes } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';

const SECRET = process.env.INTEROP_SECRET ?? '';
const PORT = Number(process.env.ADAPTER_PORT ?? 8081);

/** Mutable state shared with server.mjs. */
export const state = {
  app: null,
  ready: false,
  lastCode: null,
  appKey: randomBytes(32).toString('base64url'),
  accounts: [
    { id: 'acct_alice', email: 'alice@example.test', name: 'Alice', password: `alice-${randomBytes(9).toString('base64url')}` },
    {
      id: 'acct_bob',
      email: 'bob@example.test',
      name: 'Bob',
      password: `bob-${randomBytes(9).toString('base64url')}`,
      mediatedCode: true,
    },
  ],
  resetters: [],
  /** Armed by the `rate_limit` hook: how many more requests answer 429, and with what Retry-After. */
  limits: { token: null, resource: null },
  /** Seconds to answer 429 with, or null; consumes one armed request. */
  takeLimit(endpoint) {
    const l = state.limits[endpoint];
    if (!l || l.remaining <= 0) return null;
    l.remaining -= 1;
    return l.retryAfter;
  },
};

const MANIFEST = {
  interop: 1,
  name: 'adonis-agora',
  role: 'company',
  commit: process.env.INTEROP_COMMIT || '97838853c44e55c5d4c71ac5741f26fc34f720dc',
  components: {
    '@adonis-agora/authkit-server': '0.78.0 (DavideCarvalho/adonis-agora-authkit@97838853c44e)',
    '@adonis-agora/agent': '0.79.0 (DavideCarvalho/adonis-agora-agent@e66a2329d436)',
  },
  poppy: ['0.1'],
  extensions: [],
  // No AM (no MCP server), O/OX (no Operations extension).
  // W: AuthKit's browser-session endpoint (on by default). DC: Direct Conversations in @adonis-agora/agent.
  scenarios: ['D', 'CM', 'S0', 'N', 'SD', 'SV', 'SXV', 'SM', 'SMC', 'SX', 'SE', 'SO', 'C', 'CI', 'CS', 'CA', 'H', 'DC', 'W', 'AO', 'AS', 'R', 'RL'],
  readings: { S1: 'either', S2: 'any', S3: 'either', S4: 'omit', S23: 'per-company' },
  relaxations: [
    'personalAgents.poppy.allowInsecureClientIds (upstream dev/test setting, off by default, refused with NODE_ENV=production; on only with INTEROP_ALLOW_PRIVATE_PEERS=1): agent metadata and JWKS are fetched without the SSRF guard (the grid proxy has a private address), and http:// client_ids are also accepted',
    'NODE_ENV=development (required by the setting above)',
    'Container trusts the run CA (/interop/ca.pem) through NODE_EXTRA_CA_CERTS and the system store',
    'require_nonce flips AuthKit\'s personalAgents.poppy.dpop.requireNonce at runtime until /reset',
    'rate_limit: endpoint "token" arms AuthKit\'s own Session limiter (new Sessions only); otherwise the host app answers 429 on its /api/* routes',
    'expire_tokens sets expires_at in AuthKit\'s auth_poppy_tokens; end_sessions sets ended_at in auth_poppy_sessions (AuthKit has no API for either)',
    '/reset replaces AuthKit\'s cached agent metadata and JWKS (PoppyService.registry) so a peer that rotated its keys is accepted at once',
    'Host app written for the grid: in-memory test accounts, plain-HTML login and consent screens, a scripted model (FakeModelProvider) as the Company Agent, memory stores',
  ],
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  return SECRET !== '' && req.headers.authorization === `Bearer ${SECRET}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

/** A minimal browser: a cookie jar, no automatic redirects. */
class Browser {
  #jar = new Map();
  async request(url, { method = 'GET', form } = {}) {
    const headers = { accept: 'text/html' };
    const cookie = [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = new URL(url).origin;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) p.append(k, x);
      body = p.toString();
    }
    const res = await fetch(url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === '') this.#jar.delete(name);
      else this.#jar.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  }
}

const field = (html, name) => {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
};

function accountFor(name) {
  const key = String(name ?? '').toLowerCase();
  const a = state.accounts.find((x) => x.email === key || x.id === key || x.name.toLowerCase() === key || x.email.split('@')[0] === key);
  if (!a) throw Object.assign(new Error(`unknown account ${name}`), { status: 400, code: 'unknown_account' });
  return a;
}

async function signedInBrowser(origin, account) {
  const b = new Browser();
  const page = await b.request(`${origin}/account/login`);
  const csrf = field(page.text, '_csrf');
  if (!csrf) throw new Error(`login page has no CSRF token (HTTP ${page.status})`);
  const r = await b.request(`${origin}/account/login`, {
    method: 'POST',
    form: { _csrf: csrf, email: account.email, password: account.password },
  });
  if (r.status !== 302 && r.status !== 303) throw new Error(`login failed (HTTP ${r.status})`);
  return b;
}

/** Opens the agent's authorization URL as the signed-in person and answers the consent form. */
async function decideAuthorization(origin, { url, account, scopes }, allow) {
  const target = new URL(url);
  if (target.origin !== origin) throw Object.assign(new Error('authorization URL is not this Company'), { status: 400, code: 'foreign_url' });
  const b = await signedInBrowser(origin, accountFor(account ?? state.accounts[0].email));
  const page = await b.request(target.href);
  if (page.status === 302 || page.status === 303) return { redirect: new URL(page.location, origin).href };
  const requestId = field(page.text, 'request_id');
  const csrf = field(page.text, '_csrf');
  if (!requestId || !csrf) throw new Error(`no consent form (HTTP ${page.status}): ${page.text.slice(0, 200)}`);
  const offered = [...page.text.matchAll(/name="scope" value="([^"]*)"/g)].map((m) => m[1]);
  const chosen = scopes ? [].concat(scopes).filter((s) => offered.includes(s)) : offered;
  const r = await b.request(`${origin}/poppy/oauth/authorize`, {
    method: 'POST',
    form: { _csrf: csrf, request_id: requestId, decision: allow ? 'allow' : 'deny', scope: chosen },
  });
  if (!r.location) throw new Error(`consent answered HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  return { redirect: new URL(r.location, origin).href };
}

async function decideDevice(origin, { user_code, account, scopes }, allow) {
  const b = await signedInBrowser(origin, accountFor(account ?? state.accounts[0].email));
  const page = await b.request(`${origin}/poppy/device?user_code=${encodeURIComponent(user_code)}`);
  const csrf = field(page.text, '_csrf');
  const code = field(page.text, 'user_code');
  if (!csrf || !code) throw new Error(`no device consent form (HTTP ${page.status}): ${page.text.slice(0, 200)}`);
  const offered = [...page.text.matchAll(/name="scope" value="([^"]*)"/g)].map((m) => m[1]);
  const chosen = scopes ? [].concat(scopes).filter((s) => offered.includes(s)) : offered;
  const r = await b.request(`${origin}/poppy/device`, {
    method: 'POST',
    form: { _csrf: csrf, user_code: code, decision: allow ? 'allow' : 'deny', scope: chosen },
  });
  const status = /data-status="([^"]+)"/.exec(r.text)?.[1];
  if (status !== (allow ? 'approved' : 'denied')) throw new Error(`device decision answered ${status ?? `HTTP ${r.status}`}`);
  return {};
}

async function conversations() {
  const { PoppyConversations } = await import('@adonis-agora/agent/poppy');
  return state.app.container.make(PoppyConversations);
}

function hooks(origin) {
  return {
    approve_authorization: (p) => decideAuthorization(origin, p, true),
    deny_authorization: (p) => decideAuthorization(origin, p, false),
    approve_device: (p) => decideDevice(origin, p, true),
    deny_device: (p) => decideDevice(origin, p, false),
    mediated_answers: async (p) => {
      const a = accountFor(p.account);
      return { fields: { email: a.email, password: a.password } };
    },
    last_one_time_code: async () => {
      if (!state.lastCode) throw Object.assign(new Error('no code sent yet'), { status: 404, code: 'no_code' });
      return { code: state.lastCode };
    },
    end_sessions: async () => {
      const db = await state.app.container.make('lucid.db');
      const ended = await db.from('auth_poppy_sessions').whereNull('ended_at').update({ ended_at: new Date() });
      return { ended: Array.isArray(ended) ? ended.length : Number(ended) };
    },
    staff_join: async (p) => {
      const c = await conversations();
      await c.humanJoined(p.conversation);
      if (p.text) await c.postMessage(p.conversation, { sender: 'human', text: p.text });
      return {};
    },
    staff_reply: async (p) => {
      const c = await conversations();
      await c.postMessage(p.conversation, { sender: 'human', text: p.text });
      return {};
    },
    require_nonce: async () => {
      (await poppyService()).cfg.dpop.requireNonce = true;
      return {};
    },
    rate_limit: async (p) => {
      const requests = Number.isFinite(p.requests) ? Number(p.requests) : 1;
      const retryAfter = Number.isFinite(p.retry_after) ? Number(p.retry_after) : 1;
      state.limits[p.endpoint === 'token' ? 'token' : 'resource'] = { remaining: requests, retryAfter };
      return {};
    },
    expire_tokens: async () => {
      const db = await state.app.container.make('lucid.db');
      const n = await db.from('auth_poppy_tokens').where('expires_at', '>', new Date()).update({ expires_at: new Date(Date.now() - 1000) });
      return { expired: Array.isArray(n) ? n.length : Number(n) };
    },
    fixture: async () => ({
      accounts: state.accounts.map((a) => a.email),
      scopes: ['poppy:read', 'poppy:write'],
      openapi: { api: 'openapi', operation: 'listOrders', args: {} },
      openapi_public: { api: 'openapi', operation: 'searchCatalog', args: { params: { q: 'mug' } } },
      openapi_write: { api: 'openapi', operation: 'updateProfile', args: { body: { nickname: 'Al' } } },
      prompts: { hello: 'Hello', sign_in: 'Where is my order?' },
      otp_account: state.accounts.find((a) => a.mediatedCode)?.email ?? null,
    }),
  };
}

/** AuthKit's PoppyService, through its own runtime builder (not in the package exports). */
async function poppyService() {
  const { buildPersonalAgentsRuntime } = await import(
    new URL('./node_modules/@adonis-agora/authkit-server/build/src/agents/runtime.js', import.meta.url).href
  );
  const service = await state.app.container.make('authkit.server');
  const runtime = await buildPersonalAgentsRuntime(service, () => state.app.container.make('lucid.db'));
  return runtime.poppy;
}

async function reset() {
  const poppy = await poppyService();
  poppy.cfg.dpop.requireNonce = process.env.POPPY_REQUIRE_NONCE === '1';
  // A fresh client registry: agent metadata and JWKS are fetched again (agents rotate keys on reset).
  poppy.registry = new poppy.registry.constructor(poppy.cfg);
  state.limits = { token: null, resource: null };
  const db = await state.app.container.make('lucid.db');
  for (const t of ['auth_poppy_tokens', 'auth_poppy_requests', 'auth_poppy_sessions', 'auth_agent_grants']) {
    try {
      await db.from(t).delete();
    } catch {
      // table not created yet
    }
  }
  for (const r of state.resetters) await r();
  state.lastCode = null;
}

export async function startAdapter({ origin }) {
  const table = hooks(origin);
  createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/manifest') return send(res, 200, MANIFEST);
      if (req.method === 'GET' && path === '/healthz') return send(res, state.ready ? 200 : 503, { ready: state.ready });
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized', detail: 'Bearer INTEROP_SECRET required' });
      if (req.method === 'POST' && path === '/reset') {
        await reset();
        return send(res, 200, { reset: true });
      }
      if (req.method === 'GET' && path === '/hooks') return send(res, 200, { hooks: Object.keys(table) });
      const m = /^\/hooks\/([a-z_]+)$/.exec(path);
      if (req.method === 'POST' && m) {
        const hook = table[m[1]];
        if (!hook) return send(res, 501, { error: 'unsupported', detail: `hook ${m[1]} is not supported` });
        const body = await readBody(req);
        const params = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        return send(res, 200, await hook(params));
      }
      return send(res, 404, { error: 'not_found', detail: path });
    } catch (e) {
      return send(res, e.status ?? 500, { error: e.code ?? 'hook_failed', detail: String(e.message ?? e) });
    }
  }).listen(PORT, '0.0.0.0');
  // Ready once the app answers its own discovery document through the inner port.
  // (node:http, because fetch does not let a caller set Host.)
  const probe = () =>
    new Promise((resolve) => {
      const req = httpGet(
        {
          host: '127.0.0.1',
          port: Number(process.env.PORT ?? 8080),
          path: '/.well-known/poppy.json',
          headers: { host: new URL(origin).host, 'x-forwarded-proto': 'https' },
          timeout: 2000,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => req.destroy());
    });
  for (let i = 0; i < 120 && !state.ready; i++) {
    state.ready = await probe();
    if (!state.ready) await new Promise((r) => setTimeout(r, 500));
  }
}
