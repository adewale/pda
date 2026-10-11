// Interop adapter (docs/interop-spec.md 5.1, 5.3) for poppy-demo's Company, Northstar.
// Runs `wrangler dev` for workers/receiver on 8080 and serves the control API on 8081.
// Consent goes through Northstar's own consent page (GET the authorization URL, POST its form),
// the same requests a browser makes; nothing here reaches into the Company's storage.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const SECRET = process.env.INTEROP_SECRET ?? '';
const HOST = process.env.COMPANY_HOST;            // public name, e.g. poppy-demo.company.interop.test
const ORIGIN = `https://${HOST}`;
const AGENT = `https://${process.env.AGENT_HOST}`; // sibling agent; Northstar links to it
const STATE = '/data/wrangler-state';

const MANIFEST = {
  interop: 1,
  name: 'poppy-demo',
  role: 'company',
  commit: process.env.INTEROP_COMMIT,
  poppy: ['0.1'],
  extensions: [],
  scenarios: ['D', 'S0', 'SD', 'SX', 'SO', 'C', 'CI', 'H', 'DC', 'AO', 'AS'],
  readings: { S1: 'token-endpoint', S2: 'jwt-60s', S4: 'omit' },
  relaxations: [
    'INTEROP_PEER_SUFFIX=.agent.interop.test (patch 0001): admits any HTTPS client_id under *.agent.interop.test besides the sibling agent, fetched over the network rather than the CALLER service binding; its jwks_uri must share the client_id origin. Off (unset) by default.',
    'With INTEROP_PEER_SUFFIX set, API and conversation requests identify the client by the token owner record instead of comparing with the sibling client_id (patch 0001).',
    'Runs under plain wrangler dev with our wrangler.interop.jsonc instead of the upstream cf beta CLI config; no service bindings.',
    'Trusts the run CA via the system store (update-ca-certificates) for workerd outbound fetches.'
  ]
};

const HOOKS = ['approve_authorization', 'deny_authorization', 'fixture'];

// --- wrangler dev ---------------------------------------------------------------------------
let child;
function startWorker() {
  const args = ['wrangler', 'dev', '-c', 'wrangler.interop.jsonc', '--ip', '0.0.0.0', '--port', '8080',
    '--local-upstream', HOST, '--upstream-protocol', 'https', '--persist-to', STATE, '--show-interactive-dev-session=false',
    '--var', `RECEIVER_ORIGIN:${ORIGIN}`, '--var', `CALLER_ORIGIN:${AGENT}`];
  if (process.env.INTEROP_PEER_SUFFIX) args.push('--var', `INTEROP_PEER_SUFFIX:${process.env.INTEROP_PEER_SUFFIX}`);
  child = spawn('npx', args, { cwd: '/app/workers/receiver', stdio: 'inherit', detached: true });
  child.on('exit', code => { if (child && !child.stopping) console.error(`wrangler exited (${code})`); });
}
async function stopWorker() {
  if (!child) return;
  child.stopping = true;
  const exited = new Promise(r => child.once('exit', r));
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  child = undefined;
}
async function ready() {
  try { return (await fetch('http://127.0.0.1:8080/.well-known/poppy.json')).ok; } catch { return false; }
}
async function waitReady(ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 250))) if (await ready()) return;
  throw new Error('wrangler dev did not become ready');
}

// --- hooks ----------------------------------------------------------------------------------
const cookieOf = res => (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');

async function consent(url, decision, scopes) {
  const authz = new URL(url);
  if (authz.origin !== ORIGIN) throw Object.assign(new Error(`authorization URL is not on ${ORIGIN}`), { code: 'bad_params' });
  const page = await fetch(authz, { redirect: 'manual' });
  const html = await page.text();
  if (page.status !== 200) throw Object.assign(new Error(`consent page answered ${page.status}: ${html.slice(0, 300)}`), { code: 'consent_failed' });
  const nonce = html.match(/name="consent_nonce" value="([^"]+)"/)?.[1];
  if (!nonce) throw Object.assign(new Error('no consent form on the page'), { code: 'consent_failed' });
  const offered = [...html.matchAll(/<input type="checkbox" name="([^"]+)" value="yes"/g)].map(m => m[1]);
  const chosen = scopes?.length ? offered.filter(s => scopes.includes(s)) : offered;
  const form = new URLSearchParams({ consent_nonce: nonce, decision });
  for (const s of chosen) form.set(s, 'yes');
  const res = await fetch(`${ORIGIN}/oauth/authorize`, {
    method: 'POST', redirect: 'manual', body: form,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Cookie: cookieOf(page) }
  });
  const location = res.headers.get('location');
  if (res.status !== 303 || !location) throw Object.assign(new Error(`consent POST answered ${res.status}: ${(await res.text()).slice(0, 300)}`), { code: 'consent_failed' });
  return { redirect: location };
}

const hooks = {
  approve_authorization: p => consent(p.url, 'approve', p.scopes),
  deny_authorization: p => consent(p.url, 'deny'),
  // Northstar has one synthetic account and an OpenAPI description; no MCP, no Mediated or Device sign-in.
  fixture: async () => ({
    accounts: ['demo-account'],
    scopes: ['poppy:read', 'poppy:write'],
    openapi: { api: `${ORIGIN}/openapi.json`, operation: 'listOrders' }
  })
};

// --- control server -------------------------------------------------------------------------
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let s = ''; for await (const c of req) s += c;
  try { return s ? JSON.parse(s) : {}; } catch { throw Object.assign(new Error('body is not JSON'), { code: 'bad_params' }); }
}
let resetting = Promise.resolve();

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://adapter').pathname;
  try {
    if (req.method === 'GET' && path === '/manifest') return send(res, 200, MANIFEST);
    if (req.method === 'GET' && path === '/healthz') { await resetting; return (await ready()) ? send(res, 200, { ok: true }) : send(res, 503, { error: 'starting', detail: 'wrangler dev not ready' }); }
    if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return send(res, 401, { error: 'unauthorized', detail: 'control requests need Authorization: Bearer $INTEROP_SECRET' });
    if (req.method === 'POST' && path === '/reset') {
      resetting = (async () => { await stopWorker(); rmSync(STATE, { recursive: true, force: true }); startWorker(); await waitReady(); })();
      await resetting; return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/hooks') return send(res, 200, { hooks: HOOKS });
    const m = path.match(/^\/hooks\/([a-z_]+)$/);
    if (req.method === 'POST' && m) {
      if (!hooks[m[1]]) return send(res, 501, { error: 'unsupported', detail: `hook ${m[1]} is not supported by poppy-demo` });
      const b = await body(req); const params = b.params ?? b; // 5.3 leaves the envelope open: accept {params} or the bare object
      return send(res, 200, { ok: true, result: await hooks[m[1]](params) });
    }
    return send(res, 404, { error: 'not_found', detail: path });
  } catch (e) {
    return send(res, e.code === 'bad_params' ? 400 : 502, { error: e.code ?? 'adapter_error', detail: e.message });
  }
}).listen(8081, '0.0.0.0', () => console.log('adapter on 8081'));

startWorker();
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { await stopWorker(); process.exit(0); });
