// Interop adapter (docs/interop-spec.md 5.1, 5.3) for print-with-poppy, an agent-first
// photo-print store (spenciefy/print-with-poppy).
//
// Starts the store (server/index.ts under tsx) on PORT (8080) in its demo mode and serves
// the control API on ADAPTER_PORT (8081). The store offers signed-out Sessions and, since
// upstream 260dbb4, accounts: Direct Sign-In (a browser page asks for an email, then for the
// six-digit code sent to it, then for consent) and Mediated Sign-In (the email, then the
// code). No conversations, no staff. Its OpenAPI API and the Operations v1 extension need a
// native Poppy Session whose agent is on its allowlist (AGENT_CLIENT_IDS). Demo mode stores
// each code email in the store's SQLite instead of sending it; the sign-in hooks read the
// code from there. Hooks the store has no counterpart for answer 501.
//
// No dependencies of its own: it opens the store's SQLite with the store's better-sqlite3.
// Node 22.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const PORT = Number(process.env.PORT ?? 8080);
const ADAPTER_PORT = Number(process.env.ADAPTER_PORT ?? 8081);
// The runner sets INTEROP_ORIGIN (spec section 3); the default is for running by hand.
const ORIGIN = (process.env.INTEROP_ORIGIN ?? 'https://print-with-poppy.company.interop.test').replace(/\/+$/, '');
const SECRET = process.env.INTEROP_SECRET ?? '';
const COMMIT = process.env.INTEROP_COMMIT ?? '260dbb4634f5dc0026d790715304be9b78783ff2';
const APP_DIR = '/opt/pwp';
const DATA = '/data/pwp';
const INNER = `http://127.0.0.1:${PORT}`;

// The store admits only the agents its operator lists, by exact client_id. These are the
// grid's honest agents, each at the client metadata URL its adapter publishes under
// <name>.agent.interop.test. AGENT_CLIENT_IDS (comma-separated) replaces the list.
const GRID_AGENTS = [
  'https://dpa.agent.interop.test/poppy/client.json',
  'https://datalayer-ts.agent.interop.test/agent.json',
  'https://datalayer-py.agent.interop.test/agent.json',
  'https://pi-poppy.agent.interop.test/agent.json',
  'https://poppy-demo.agent.interop.test/agent.json',
  'https://adonis-agora.agent.interop.test/agent.json',
  'https://everruns.agent.interop.test/api/v1/poppy/agent.json'
];
const AGENT_CLIENT_IDS = process.env.AGENT_CLIENT_IDS || GRID_AGENTS.join(',');

const MANIFEST = {
  interop: 1,
  name: 'print-with-poppy',
  role: 'company',
  commit: COMMIT,
  poppy: ['0.1'],
  extensions: ['operations'],
  // OU is the store's own path: a multipart photo upload, then POST /api/orders proposes an
  // operation in the signed-out Session, which the agent confirms once its User approves.
  // Sign-in: Direct (SD, SX, SO, AO, AS, R) and Mediated with a code (SMC). Not SM: its
  // Mediated Sign-In always asks for a code. Not O, OX: no conversation in which the Company
  // proposes. No conversations (C, CI, CS, SE), Device Sign-In (SV, SXV) or nonces (N).
  scenarios: ['D', 'S0', 'OU', 'CM', 'SD', 'SX', 'SMC', 'SO', 'AO', 'AS', 'R'],
  readings: {
    // A client assertion's aud must be exactly the endpoint it is sent to: the token
    // endpoint at /oauth/token, the revocation endpoint at /oauth/revoke (a string, not an array).
    S1: 'endpoint',
    // Any typ (only poppy-browser+jwt is refused), at most 120 s (exp - iat <= 120, iat no
    // older than 120 s).
    S2: 'lenient-120s',
    // The issuer is the bare origin, so both metadata locations are the same URL.
    S3: 'either',
    // A signed-out Session request carrying a scope is refused, 400 invalid_scope ("Account
    // scopes require sign-in"); a signed-out Session Token comes back with scope "".
    S4: 'omit'
  },
  relaxations: [
    'APP_MODE=demo, upstream\'s local mode: payments, print orders and email are simulated in process, prices are illustrative, and no Stripe, Prodigi or Resend client is configured. Demo mode also serves the store\'s own browser demo (/api/demo/*, the Demo authorization scheme, its built-in demo agent), which no grid agent uses.',
    'Sign-in codes: demo mode stores each code email in the store\'s SQLite (kind demo-signin-email) instead of sending it, and the adapter reads the code from there for the person signing in (approve_authorization, deny_authorization, last_one_time_code). expire_tokens rewrites the expiry of the store\'s Session Token records.'
  ]
};

// --- the implementation process --------------------------------------------------------

let child;
function startApp() {
  child = spawn(`${APP_DIR}/node_modules/.bin/tsx`, ['server/index.ts'], {
    cwd: APP_DIR,
    stdio: 'inherit',
    detached: true,
    env: {
      // Only what the store needs: no provider keys, so nothing can reach Stripe, Prodigi or Resend.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      NODE_ENV: 'production', // as upstream's own image
      APP_MODE: 'demo',
      PORT: String(PORT),
      HOST: '0.0.0.0',
      PUBLIC_URL: ORIGIN,
      DATA_DIR: DATA,
      AGENT_CLIENT_IDS,
      // Patch 0001: off, so only native Poppy Sessions reach the API (no Bearer guest tokens).
      ALLOW_COMPAT_AGENT_SESSIONS: 'false'
    }
  });
  child.on('error', e => console.error(`[adapter] could not start the store: ${e.message}`));
  child.on('exit', (code, signal) => { if (child && !child.stopping) console.log(`[adapter] the store exited (${code ?? signal})`); });
}
async function stopApp() {
  if (!child) return;
  child.stopping = true;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  child = undefined;
}
async function ready() {
  try {
    const r = await fetch(`${INNER}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}
async function waitReady(ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ready()) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

// --- spec 5.3 hooks --------------------------------------------------------------------

// The store's SQLite, through the store's own better-sqlite3, opened for each hook and closed
// after it, so /reset can delete the file. The busy timeout is the store's.
const Database = createRequire(`${APP_DIR}/package.json`)('better-sqlite3');
function withDb(fn, { write = false } = {}) {
  const db = new Database(`${DATA}/poppy.sqlite`, { readonly: !write, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

// The six-digit code in the newest code email, to `owner`'s sign-in when given. Demo mode
// stores the message ({to, subject, text, html}) as kind demo-signin-email, owned by the
// Session id (Mediated) or `browser:<flow id>` (Direct).
function lastCode(owner) {
  const row = withDb(db => owner === undefined
    ? db.prepare("SELECT body FROM records WHERE kind='demo-signin-email' ORDER BY rowid DESC LIMIT 1").get()
    : db.prepare("SELECT body FROM records WHERE kind='demo-signin-email' AND owner=? ORDER BY rowid DESC LIMIT 1").get(owner));
  const code = row && /sign-in code is (\d{6})\./.exec(JSON.parse(row.body).text ?? '')?.[1];
  if (!code) throw new AdapterError(409, 'no_code', `the store has sent no sign-in code${owner ? ` for ${owner}` : ''}`);
  return code;
}

// Direct Sign-In, as the person in the browser. The store's pages, driven as a browser would:
// GET the authorization URL (a page asking for an email; it sets the poppy_signin cookie),
// POST the email, POST the code it sent, then POST the decision with the scopes the person
// ticks. Each form carries the flow id and CSRF token from the page, the cookie, and Origin:
// the store's public origin. They go to the store directly, not through the proxy: they are
// the person's requests, not the agent's.
const ACCOUNT = 'ada@example.com';
const excerpt = html => html.replace(/<style>[\s\S]*?<\/style>/, '').slice(0, 300);
function formField(html, name) {
  const value = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  if (!value) throw new AdapterError(502, 'consent_failed', `the sign-in page has no ${name} field: ${excerpt(html)}`);
  return value;
}
async function signInAs(url, account) {
  const authz = new URL(url);
  if (authz.origin !== ORIGIN || authz.pathname !== '/oauth/authorize') throw new AdapterError(400, 'bad_params', `not this store's authorization URL: ${url}`);
  const page = await fetch(`${INNER}${authz.pathname}${authz.search}`, { redirect: 'manual' });
  let html = await page.text();
  if (page.status !== 200) throw new AdapterError(502, 'consent_failed', `the authorization page answered ${page.status}: ${excerpt(html)}`);
  const cookie = (page.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).find(c => c.startsWith('poppy_signin='));
  if (!cookie) throw new AdapterError(502, 'consent_failed', 'the authorization page set no poppy_signin cookie');
  const flow = formField(html, 'flow'), csrf = formField(html, 'csrf');
  const post = async (path, fields) => {
    const form = new URLSearchParams({ flow, csrf });
    for (const [name, value] of fields) form.append(name, value);
    const res = await fetch(`${INNER}${path}`, {
      method: 'POST', redirect: 'manual', body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: cookie }
    });
    return { res, html: await res.text() };
  };
  const next = async (path, fields, form) => {
    const r = await post(path, fields);
    if (r.res.status !== 200 || !r.html.includes(`action="${form}"`)) throw new AdapterError(502, 'consent_failed', `${path} answered ${r.res.status}: ${excerpt(r.html)}`);
    return r.html;
  };
  await next('/oauth/authorize/email', [['email', account]], '/oauth/authorize/verify');
  html = await next('/oauth/authorize/verify', [['code', lastCode(`browser:${flow}`)]], '/oauth/authorize/approve');
  return { offered: [...html.matchAll(/name="scopes" value="([^"]+)"/g)].map(m => m[1]), post };
}
async function consent(p, decision) {
  const { offered, post } = await signInAs(p.url, p.account ?? ACCOUNT);
  const chosen = p.scopes?.length ? offered.filter(s => p.scopes.includes(s)) : offered;
  const { res, html } = await post('/oauth/authorize/approve', [['decision', decision], ...(decision === 'approve' ? chosen.map(s => ['scopes', s]) : [])]);
  const location = res.headers.get('location');
  if (res.status !== 303 || !location) throw new AdapterError(502, 'consent_failed', `the decision answered ${res.status}: ${excerpt(html)}`);
  return { redirect: location };
}

const HOOKS = {
  approve_authorization: p => consent(p, 'approve'),
  // The store shows Allow and Cancel only after the email and its code, so a refusal signs
  // in first, then cancels.
  deny_authorization: p => consent(p, 'deny'),
  // Mediated Sign-In asks for the email; the store then emails a code (last_one_time_code).
  mediated_answers: p => ({ fields: { email: p.account ?? ACCOUNT } }),
  last_one_time_code: () => ({ code: lastCode() }),
  // Session Tokens live an hour; this expires every one issued so far.
  expire_tokens: () => ({
    expired: withDb(db => db.prepare("UPDATE records SET body = json_set(body, '$.expires', 0) WHERE kind = 'token'").run().changes, { write: true })
  }),
  async fixture() {
    // One account, an email address (the store creates it when its code is first verified),
    // with Poppy's scopes, and no prompts (no conversations). getCatalog answers without a
    // Session; getAccount needs poppy:read. Signed in, proposeOrder needs poppy:write and is
    // refused with insufficient_scope before the store reads the order (scenario AS).
    // OU: the photo goes up as multipart/form-data in the field `photo` (uploadPhoto), then
    // proposeOrder (with the Idempotency-Key its description requires) names it by the id the
    // upload answered, which the scenario saves as upload_id.
    const order = photoId => ({
      email: ACCOUNT,
      address: { name: 'Ada Lovelace', line1: '123 Market Street', city: 'San Francisco', state: 'CA', postalCode: '94103', country: 'US' },
      items: [{ photoId, quantity: 1, fit: 'contain' }]
    });
    return {
      accounts: [ACCOUNT],
      scopes: { read: ['poppy:read'], write: ['poppy:read', 'poppy:write'] },
      openapi: { api: 'openapi', operation: 'getAccount', args: {} },
      openapi_write: { api: 'openapi', operation: 'proposeOrder', args: { body: order('photo_none') } },
      openapi_public: { api: 'openapi', operation: 'getCatalog', args: {} },
      openapi_upload: { api: 'openapi', operation: 'uploadPhoto', args: { files: { photo: 'lake.jpg' } } },
      openapi_propose: { api: 'openapi', operation: 'proposeOrder', args: { body: order('${upload_id}') } },
      prompts: {},
      otp_account: ACCOUNT
    };
  }
  // require_nonce, rate_limit, issuer_path, end_sessions and the device, staff and operation
  // hooks: 501. The store never asks for a DPoP nonce, its rate limits are fixed (30 a minute
  // at /oauth), its issuer is its origin, and it has no way to end a Session, no Device
  // Sign-In, no conversations and no Company Agent to propose an operation.
};

// --- HTTP ----------------------------------------------------------------------------

class AdapterError extends Error {
  constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
async function readJson(req) {
  let s = '';
  for await (const c of req) s += c;
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw new AdapterError(400, 'invalid_json', 'body is not JSON'); }
}
let resetting = Promise.resolve();

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://adapter').pathname;
  try {
    if (req.method === 'GET' && path === '/manifest') return send(res, 200, MANIFEST);
    if (req.method === 'GET' && path === '/healthz') {
      await resetting.catch(() => {});
      return (await ready()) ? send(res, 200, { ok: true }) : send(res, 503, { error: 'starting', detail: 'the store is not answering yet' });
    }
    if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return send(res, 401, { error: 'unauthorized', detail: 'Authorization: Bearer $INTEROP_SECRET required' });
    if (req.method === 'POST' && path === '/reset') {
      // The SQLite file, uploaded photos and the demo secret live in DATA; replay caches,
      // the client metadata cache and rate limits live in the process. Stop, delete, start.
      resetting = (async () => {
        await stopApp();
        await rm(DATA, { recursive: true, force: true });
        startApp();
        if (!(await waitReady())) throw new AdapterError(500, 'restart_failed', 'the store did not come back within 60 s');
      })();
      await resetting;
      return send(res, 200, { reset: true });
    }
    if (req.method === 'GET' && path === '/hooks') return send(res, 200, { hooks: Object.keys(HOOKS) });
    const m = /^\/hooks\/([a-z_]+)$/.exec(path);
    if (req.method === 'POST' && m) {
      const hook = HOOKS[m[1]];
      if (!hook) return send(res, 501, { error: 'unsupported', detail: `print-with-poppy has no ${m[1]}: the store has no Device Sign-In, conversations, staff, nonces or way to end a Session` });
      // Bare params in, bare result out (spec 5.3).
      return send(res, 200, await hook(await readJson(req)));
    }
    send(res, 404, { error: 'not_found', detail: `${req.method} ${path}` });
  } catch (e) {
    const status = e instanceof AdapterError ? e.status : 500;
    send(res, status, { error: e instanceof AdapterError ? e.code : 'adapter_error', detail: String(e?.message ?? e) });
  }
}).listen(ADAPTER_PORT, '0.0.0.0', () => console.log(`[adapter] control API on ${ADAPTER_PORT}; Company origin ${ORIGIN}`));

startApp();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await stopApp(); process.exit(0); });
