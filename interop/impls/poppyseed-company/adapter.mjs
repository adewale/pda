// Interop adapter for poppyseed's reference Company (interop spec 5.1 and 5.3).
//
// Starts the fixture app (next start on PORT, default 8080) and serves the control API on
// ADAPTER_PORT (default 8081). Every Company hook maps onto poppyseed's own test hooks
// (POST {origin}/test-hooks/{hook} {"args": [...]}, served only with POPPYSEED_TEST_HOOKS=1)
// or onto the Company's own consent pages, driven over HTTP exactly as a browser would:
// the site's sign-in cookie comes from poppyseed's siteSignIn hook, and the person approves
// on poppyseed's consent page. Nothing here signs anyone in another way.
//
// Zero dependencies; Node 22.
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT ?? 8080);
const ADAPTER_PORT = Number(process.env.ADAPTER_PORT ?? 8081);
const ORIGIN = (process.env.POPPYSEED_BASE_URL ?? 'https://poppyseed.company.interop.test').replace(/\/+$/, '');
const SECRET = process.env.INTEROP_SECRET ?? '';
const APP_DIR = '/opt/poppyseed/fixtures/next-app';
const INNER = `http://127.0.0.1:${PORT}`;
const COMMIT = 'f479fb6bd1754b9639440515f259e01936b0a18a';

const MANIFEST = {
  interop: 1,
  name: 'poppyseed',
  role: 'company',
  commit: COMMIT,
  poppy: ['0.1'],
  extensions: ['operations'],
  // N is left out: poppyseed never sends DPoP nonce challenges.
  scenarios: ['D', 'S0', 'SD', 'SV', 'SM', 'SX', 'R', 'SE', 'SO', 'C', 'CI', 'CS', 'H', 'DC', 'AO', 'AM', 'AS', 'O', 'O2', 'OX', 'RL'],
  readings: {
    // Each client assertion's aud is the endpoint it is sent to (token, revocation or device authorization).
    S1: 'token-endpoint',
    // typ is not checked (only the browser typ is refused); lifetimes up to 120 s are accepted.
    S2: 'any',
    // The issuer is the bare origin, so the insertion and append locations are the same URL.
    S3: 'either',
    // A signed-out Session request's scope is ignored.
    S4: 'either'
  },
  relaxations: [
    'fixtures/next-app hard-wires dev.allowInsecureClients: true (upstream, not a patch): http and private-address client_ids are accepted and metadata is fetched with the platform fetch, not safeFetch, so the proxy\'s private IP is not refused',
    'POPPYSEED_TEST_HOOKS=1 serves poppyseed\'s own test hooks at /test-hooks/{hook} (upstream, off by default)',
    'POPPYSEED_BASE_URL sets the public origin (upstream setting)'
  ]
};

// --- the implementation process --------------------------------------------------------

let child;
function startApp() {
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '0.0.0.0', '-p', String(PORT)], {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: { ...process.env, POPPYSEED_BASE_URL: ORIGIN, POPPYSEED_TEST_HOOKS: '1' }
  });
  child.on('exit', (code, signal) => console.log(`[adapter] next exited (${code ?? signal})`));
}
async function stopApp() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
async function ready() {
  try {
    const r = await fetch(`${INNER}/.well-known/poppy.json`, { signal: AbortSignal.timeout(2000) });
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

// --- poppyseed's own hooks -------------------------------------------------------------

async function seedHook(name, ...args) {
  const r = await fetch(`${INNER}/test-hooks/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args })
  });
  if (!r.ok) throw new AdapterError(502, 'hook_failed', `poppyseed hook ${name} answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).result;
}
let profileCache;
async function seedProfile() {
  if (!profileCache) {
    const r = await fetch(`${INNER}/test-hooks/hooks`);
    if (!r.ok) throw new AdapterError(502, 'hooks_off', `GET /test-hooks/hooks answered ${r.status}`);
    profileCache = (await r.json()).profile;
  }
  return profileCache;
}

// --- a minimal browser: the person on the Company's own pages --------------------------

class Browser {
  constructor(cookies = {}) { this.cookies = { ...cookies }; }
  header() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async request(url, { method = 'GET', form } = {}) {
    const headers = { cookie: this.header(), accept: 'text/html' };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = ORIGIN;
      body = new URLSearchParams(form).toString();
    }
    const r = await fetch(url, { method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  }
}
const unescape = s => s.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
function formFields(html) {
  const sealed = /name="sealed" value="([^"]*)"/.exec(html)?.[1];
  const scopes = [...html.matchAll(/name="scope" value="([^"]*)"/g)].map(m => unescape(m[1]));
  return { sealed: sealed && unescape(sealed), scopes };
}
const pageText = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

/** The test people poppyseed's reference Company knows: alice and bob. */
function person(account) {
  const name = String(account ?? 'alice').toLowerCase().replace(/^acct_/, '').replace(/@.*$/, '');
  if (name !== 'alice' && name !== 'bob') throw new AdapterError(400, 'unknown_account', `poppyseed's reference Company has accounts alice and bob, not ${account}`);
  return name;
}
async function signedInBrowser(account) {
  const cookie = await seedHook('siteSignIn', person(account)); // "site_session=alice"
  const [k, v] = String(cookie).split('=');
  return new Browser({ [k]: v });
}
function decisionForm(sealed, offered, scopes, approve) {
  const granted = scopes?.length ? offered.filter(s => scopes.includes(s)) : offered;
  const form = new URLSearchParams({ sealed, decision: approve ? 'approve' : 'decline' });
  for (const s of granted) form.append('scope', s);
  return form;
}

async function authorization({ url, account, scopes }, approve) {
  if (typeof url !== 'string' || !url.startsWith(ORIGIN + '/')) throw new AdapterError(400, 'invalid_params', `url must be an authorization URL under ${ORIGIN}`);
  const browser = await signedInBrowser(account);
  const page = await browser.request(url);
  // The Company may answer the authorization request itself with a redirect (an error back to the agent).
  if (page.status === 302 || page.status === 303) return { redirect: page.location };
  if (page.status !== 200) throw new AdapterError(502, 'consent_page_refused', `GET authorization URL answered ${page.status}: ${pageText(page.text)}`);
  const { sealed, scopes: offered } = formFields(page.text);
  if (!sealed) throw new AdapterError(502, 'no_consent_form', pageText(page.text));
  const decided = await browser.request(url, { method: 'POST', form: decisionForm(sealed, offered, scopes, approve) });
  if (decided.status !== 302 && decided.status !== 303) throw new AdapterError(502, 'consent_failed', `POST consent answered ${decided.status}: ${pageText(decided.text)}`);
  return { redirect: decided.location };
}

async function device({ user_code, account, scopes }, approve) {
  if (typeof user_code !== 'string') throw new AdapterError(400, 'invalid_params', 'user_code is required');
  const browser = await signedInBrowser(account);
  const verify = `${ORIGIN}/poppy/device`;
  const entry = await browser.request(`${verify}?user_code=${encodeURIComponent(user_code)}`);
  if (entry.status !== 200) throw new AdapterError(502, 'device_page_refused', `GET ${verify} answered ${entry.status}`);
  const page = await browser.request(verify, { method: 'POST', form: { user_code } });
  if (page.status !== 200) throw new AdapterError(502, 'device_code_refused', `POST user_code answered ${page.status}: ${pageText(page.text)}`);
  const { sealed, scopes: offered } = formFields(page.text);
  if (!sealed) throw new AdapterError(502, 'no_consent_form', pageText(page.text));
  const decided = await browser.request(verify, { method: 'POST', form: decisionForm(sealed, offered, scopes, approve) });
  if (decided.status !== 200) throw new AdapterError(502, 'consent_failed', `POST consent answered ${decided.status}: ${pageText(decided.text)}`);
  return {};
}

// --- spec 5.3 hooks --------------------------------------------------------------------

const HOOKS = {
  approve_authorization: p => authorization(p, true),
  deny_authorization: p => authorization(p, false),
  approve_device: p => device(p, true),
  deny_device: p => device(p, false),
  async mediated_answers({ account }) {
    const m = (await seedProfile()).mediated;
    // Bob's sign-ins always need a one-time code; alice's never do.
    return { fields: person(account) === 'bob' ? m.codeCredentials : m.credentials };
  },
  async last_one_time_code() {
    return { code: await seedHook('lastCode') };
  },
  async end_sessions(params = {}) {
    // poppyseed ends one Session by id (endSession(sessionId)); it can't enumerate them.
    const ids = params.session_id ? [params.session_id] : params.sessions ?? [];
    if (!ids.length) throw new AdapterError(400, 'session_id_required', "poppyseed's endSession hook ends one Session by id; pass params.session_id (spec 5.3's end_sessions takes no parameters)");
    for (const id of ids) await seedHook('endSession', id);
    return { ended: ids.length };
  },
  async staff_join({ conversation, text }) {
    await seedHook('staffJoin', conversation);
    if (text) await seedHook('staffReply', conversation, text);
    return {};
  },
  async staff_reply({ conversation, text }) {
    await seedHook('staffReply', conversation, text);
    return {};
  },
  async settle_operation({ operation, outcome, summary }) {
    const state = { success: 'succeeded', succeeded: 'succeeded', failure: 'failed', failed: 'failed', cancelled: 'cancelled' }[outcome];
    if (!state) throw new AdapterError(400, 'invalid_params', 'outcome is succeeded, failed or cancelled');
    await seedHook('settle', operation, state, summary ?? `Settled ${state} by the interop runner.`);
    return {};
  },
  async fixture() {
    const profile = await seedProfile();
    const d = await (await fetch(`${INNER}/.well-known/poppy.json`)).json();
    const api = type => d.apis?.find(a => a.type === type)?.url;
    return {
      accounts: ['alice', 'bob'],
      scopes: d.auth?.direct?.scopes ?? [],
      openapi: { api: api('openapi'), operation: profile.publicTool.name, args: profile.publicTool.arguments },
      mcp: { api: api('mcp'), tool: profile.publicTool.name, args: profile.publicTool.arguments },
      scoped: profile.scopedTool,
      conversations: profile.conversations,
      // The whole poppyseed TargetProfile, for scenarios that want more.
      poppyseed_profile: profile
    };
  }
  // propose_operation: no hook. Operations are proposed by the Company Agent when a
  // conversation asks for one (fixture().conversations.operationRequest), not by staff.
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

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://adapter').pathname;
  try {
    if (req.method === 'GET' && path === '/manifest') return send(res, 200, MANIFEST);
    if (req.method === 'GET' && path === '/healthz') return (await ready()) ? send(res, 200, { ok: true }) : send(res, 503, { error: 'starting', detail: 'the Company is not answering yet' });
    if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return send(res, 401, { error: 'unauthorized', detail: 'Authorization: Bearer $INTEROP_SECRET required' });
    if (req.method === 'POST' && path === '/reset') {
      // Everything lives in the fixture's memory store: a restart forgets it all.
      await stopApp();
      profileCache = undefined;
      startApp();
      if (!(await waitReady())) throw new AdapterError(500, 'restart_failed', 'the Company did not come back within 60 s');
      return send(res, 200, { reset: true });
    }
    if (req.method === 'GET' && path === '/hooks') return send(res, 200, { hooks: Object.keys(HOOKS) });
    const m = /^\/hooks\/([a-z_]+)$/.exec(path);
    if (req.method === 'POST' && m) {
      const hook = HOOKS[m[1]];
      if (!hook) return send(res, 501, { error: 'unsupported', detail: `hook ${m[1]} is not supported by poppyseed` });
      const body = await readJson(req);
      return send(res, 200, { ok: true, result: await hook(body.params ?? body) });
    }
    send(res, 404, { error: 'not_found', detail: `${req.method} ${path}` });
  } catch (e) {
    const status = e instanceof AdapterError ? e.status : 500;
    send(res, status, { error: e instanceof AdapterError ? e.code : 'adapter_error', detail: String(e?.message ?? e) });
  }
}).listen(ADAPTER_PORT, '0.0.0.0', () => console.log(`[adapter] control API on ${ADAPTER_PORT}; Company origin ${ORIGIN}`));

startApp();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await stopApp(); process.exit(0); });
