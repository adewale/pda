// Interop adapter (docs/interop-spec.md 5.1, 5.2) for poppy-demo's Personal Agent (workers/caller).
//
// The caller is a Pi agent, but its Poppy protocol layer is CallerSession.action(), which the
// caller's own UI reaches through POST /api/action (with the visitor cookie and same-origin
// check). The adapter drives that route and never the model.
//
// The caller is built for one Company, fixed by RECEIVER_ORIGIN. The adapter restarts
// `wrangler dev` with RECEIVER_ORIGIN set to a step's `company` when it changes; the agent's
// signing key survives that (it lives in the persisted AgentIdentity Durable Object) and is
// rotated only by /reset, which deletes all state.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const SECRET = process.env.INTEROP_SECRET ?? '';
const AGENT_ORIGIN = `https://${process.env.AGENT_HOST}`; // publishes /agent.json and /jwks.json
const STATE = '/data/wrangler-state';
const WORKER = 'http://127.0.0.1:8080';

const MANIFEST = {
  interop: 1,
  name: 'poppy-demo',
  role: 'agent',
  commit: process.env.INTEROP_COMMIT,
  poppy: ['0.1'],
  extensions: [],
  scenarios: ['D', 'S0', 'N', 'SD', 'SX', 'SO', 'C', 'AO'],
  // S1: client assertions name the endpoint they're sent to (token or revocation endpoint).
  // S3: OAuth metadata is fetched at `${auth.issuer}/.well-known/oauth-authorization-server`.
  // S4: signed-out Session requests carry no scope. Nonces are not cached (S23 n/a).
  readings: { S1: 'token-endpoint', S2: 'jwt-60s', S3: 'append', S4: 'omit' },
  relaxations: [
    'Patch 0001: with no RECEIVER service binding configured, the caller reaches the Company with fetch() over the network (redirect: manual) instead of the service binding; our wrangler.interop.jsonc omits the binding.',
    'Runs under plain wrangler dev with our wrangler.interop.jsonc instead of the upstream cf beta CLI config; no AI binding, no built UI.',
    'One Company at a time: the adapter restarts wrangler dev with RECEIVER_ORIGIN set to the step\'s company (the caller accepts only that origin).',
    'Trusts the run CA via the system store (update-ca-certificates) for workerd outbound fetches.'
  ]
};

// Error codes the caller raises itself, as opposed to codes a Company returned.
const LOCAL = new Set(['discover_first', 'start_session_first', 'invalid_metadata', 'discovery_failed', 'too_many_redirects',
  'invalid_token_response', 'invalid_oauth_response', 'not_connected', 'review_exchange_first', 'unknown_action',
  'missing_oauth_session', 'action_failed', 'callback_failed', 'invalid_request']);

// --- wrangler dev -----------------------------------------------------------------------------
let child, company, visitor;
function startWorker(target) {
  company = target;
  visitor = undefined;
  const args = ['wrangler', 'dev', '-c', 'wrangler.interop.jsonc', '--ip', '0.0.0.0', '--port', '8080',
    '--local-upstream', process.env.AGENT_HOST, '--upstream-protocol', 'https', '--persist-to', STATE, '--show-interactive-dev-session=false',
    '--var', `CALLER_ORIGIN:${AGENT_ORIGIN}`, '--var', `RECEIVER_ORIGIN:https://${target}`];
  child = spawn('npx', args, { cwd: '/app/workers/caller', stdio: 'inherit', detached: true });
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
async function ready(path = '/agent.json') {
  try { return (await fetch(`${WORKER}${path}`, { signal: AbortSignal.timeout(10000) })).ok; } catch { return false; }
}
async function waitReady(ms = 180000) {
  // The first requests after a start can be slow (bundling, Durable Object start-up); wait until
  // both the AgentIdentity (/agent.json) and a CallerSession (/api/state) answer.
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 250))) {
    if (await ready() && await ready('/api/state')) return;
  }
  throw new Error('wrangler dev did not become ready');
}
let switching = Promise.resolve();
async function useCompany(target) {
  await switching;
  if (!target || target === company) return;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(target)) throw new AdapterError(400, 'bad_params', `company must be a host name, got ${target}`);
  switching = (async () => { await stopWorker(); startWorker(target); await waitReady(); })();
  await switching;
}

// --- talking to the caller ---------------------------------------------------------------------
class AdapterError extends Error { constructor(status, code, detail) { super(detail); this.status = status; this.code = code; } }
class Outcome extends Error { constructor(body) { super('outcome'); this.body = body; } } // a non-adapter failure

async function visitorCookie() {
  if (visitor) return visitor;
  const res = await fetch(`${WORKER}/api/state`);
  const set = (res.headers.getSetCookie?.() ?? []).find(c => c.startsWith('poppy_visitor='));
  if (!set) throw new AdapterError(502, 'adapter_error', 'caller set no visitor cookie');
  await res.body?.cancel();
  return (visitor = set.split(';')[0]);
}
async function state() {
  const res = await fetch(`${WORKER}/api/state`, { headers: { Cookie: await visitorCookie() } });
  return res.json();
}
async function action(name, input = {}) {
  const res = await fetch(`${WORKER}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: AGENT_ORIGIN, Cookie: await visitorCookie() },
    body: JSON.stringify({ ...input, action: name })
  });
  const body = await res.json().catch(() => ({ error: 'action_failed' }));
  if (!res.ok || body.error) throw failure(body.error ?? 'action_failed', res.status);
  return body;
}
async function newChat() {
  const res = await fetch(`${WORKER}/api/pi/new`, {
    method: 'POST', body: '{}',
    headers: { 'Content-Type': 'application/json', Origin: AGENT_ORIGIN, Cookie: await visitorCookie() }
  });
  if (!res.ok) throw new AdapterError(502, 'adapter_error', `caller /api/pi/new answered ${res.status}: ${await res.text()}`);
}
function failure(code, status) {
  // A Poppy error the Company returned is a result, not an adapter error (5.2). Errors the caller
  // raises itself (it refused a document, it wasn't ready) have no shape in 5.2; we report them
  // as {ok: false, agent_error}.
  return new Outcome(LOCAL.has(code) ? { ok: false, agent_error: code, status } : { ok: false, poppy_error: code, status });
}
const conversation = (s, id) => (s.conversations ?? []).find(c => c.id === id);
const messagesOf = events => events.filter(e => e.type === 'message' && e.message)
  .map(e => ({ role: e.message.role ?? e.message.sender, text: e.message.text ?? '', id: e.message.id }));

// --- ops ----------------------------------------------------------------------------------------
const unsupported = why => { throw new AdapterError(501, 'unsupported', why); };
const ops = {
  async discover() {
    const s = await action('discover');
    const d = s.discovery ?? {};
    return {
      issuer: d.auth?.issuer, poppy_version: d.protocol_version,
      conversations: Boolean(d.agent?.protocols?.some(p => p.type === 'poppy')),
      apis: (d.apis ?? []).map(a => a.name ?? a.url)
    };
  },
  async session() {
    const before = await state();
    const s = await action(before.session_id ? 'new-session' : 'start');
    return { session_id: s.session_id, signed_in: s.signed_in, scope: s.scope };
  },
  async signin(p) {
    if ((p.method ?? 'direct') !== 'direct') unsupported('poppy-demo implements Direct Sign-In only');
    // The caller always asks for poppy:read poppy:write; a different p.scopes isn't honoured.
    const s = await action('signin');
    return { pending: { url: s.sign_in_url } };
  },
  async signin_continue(p) {
    if (!p.callback_url) unsupported('only Direct Sign-In callbacks are supported');
    const cb = new URL(p.callback_url);
    if (cb.origin !== AGENT_ORIGIN || cb.pathname !== '/oauth/callback') throw new AdapterError(400, 'bad_params', `callback_url must be ${AGENT_ORIGIN}/oauth/callback`);
    const res = await fetch(`${WORKER}/oauth/callback${cb.search}`, { redirect: 'manual', headers: { Cookie: await visitorCookie() } });
    if (res.status !== 303) {
      const code = (await res.text()).match(/<p>([^.<]+)\./)?.[1] ?? 'callback_failed';
      // An `error` on the redirect (access_denied, ...) is the Company's answer.
      if (cb.searchParams.get('error') === code) throw new Outcome({ ok: false, poppy_error: code, status: res.status });
      throw failure(code, res.status);
    }
    const s = await state();
    return { signed_in: s.signed_in, account: null, scope: s.scope };
  },
  async send(p) {
    if (p.message_id) unsupported('the caller generates its own message ids, so a retry with a chosen id (CI) is not possible');
    // Without a conversation the caller continues its active one; its "New session" button
    // (/api/pi/new) clears that, so the next message starts a new conversation.
    if (!p.conversation && (await state()).active_conversation) await newChat();
    const before = await state();
    const seen = p.conversation ? conversation(before, p.conversation)?.events.length ?? 0 : 0;
    const s = await action('message', { text: p.text, sender: 'agent', ...(p.conversation ? { conversation: p.conversation } : {}) });
    const c = conversation(s, p.conversation ?? s.active_conversation);
    const fresh = messagesOf((c?.events ?? []).slice(seen));
    const mine = fresh.find(m => m.text === p.text);
    return {
      conversation: c?.id, message_id: mine?.id ?? null, status: c?.status,
      messages: fresh.filter(m => m !== mine).map(({ role, text }) => ({ role, text }))
    };
  },
  async read(p) {
    const s = await action('events', { conversation: p.conversation });
    const c = conversation(s, p.conversation);
    const events = c?.events ?? [];
    const from = p.cursor ? events.findIndex(e => e.id === p.cursor) + 1 : 0;
    // The caller keeps the Company's cursor itself and never follows has_more.
    return { messages: messagesOf(events.slice(from)).map(({ role, text }) => ({ role, text })), cursor: c?.cursor, has_more: false, status: c?.status };
  },
  async api(p) {
    // The caller knows exactly one API operation, Northstar's GET /api/orders.
    if (p.operation !== 'listOrders') unsupported('the caller can call only Northstar\'s listOrders');
    const s = await action('orders');
    return { status: 200, body: s.orders };
  },
  async signout() {
    try { await action('revoke'); return { revoked: true }; }
    catch (e) { if (e instanceof Outcome && e.body.agent_error === 'not_connected') return { revoked: false }; throw e; }
  },
  async state() {
    const s = await state();
    return {
      sessions: s.session_id ? [{ company, session_id: s.session_id, signed_in: s.signed_in, scope: s.scope }] : [],
      accounts: s.account_connected ? [{ company, scope: s.scope }] : []
    };
  },
  sse: () => unsupported('the caller reads events with GET, not SSE'),
  web_join: () => unsupported('no browser Session exchange'),
  approve_op: () => unsupported('no Operations extension')
};

// --- control server -----------------------------------------------------------------------------
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let s = ''; for await (const c of req) s += c;
  try { return s ? JSON.parse(s) : {}; } catch { throw new AdapterError(400, 'bad_params', 'body is not JSON'); }
}

http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://adapter').pathname;
  try {
    if (req.method === 'GET' && path === '/manifest') return send(res, 200, MANIFEST);
    if (req.method === 'GET' && path === '/healthz') { await switching; return (await ready()) ? send(res, 200, { ok: true }) : send(res, 503, { error: 'starting', detail: 'wrangler dev not ready' }); }
    if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return send(res, 401, { error: 'unauthorized', detail: 'control requests need Authorization: Bearer $INTEROP_SECRET' });
    if (req.method === 'POST' && path === '/reset') {
      await switching;
      switching = (async () => { await stopWorker(); rmSync(STATE, { recursive: true, force: true }); startWorker(process.env.DEFAULT_COMPANY ?? 'poppy-demo.company.interop.test'); await waitReady(); })();
      await switching; return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/step') {
      const { op, company: target, params = {} } = await body(req);
      if (!ops[op]) return send(res, 501, { error: 'unsupported', detail: `op ${op} is not supported` });
      await useCompany(target);
      return send(res, 200, { ok: true, result: await ops[op](params) });
    }
    return send(res, 404, { error: 'not_found', detail: path });
  } catch (e) {
    if (e instanceof Outcome) return send(res, 200, e.body);
    if (e instanceof AdapterError) return send(res, e.status, { error: e.code, detail: e.message });
    return send(res, 500, { error: 'adapter_error', detail: String(e?.stack ?? e) });
  }
}).listen(8081, '0.0.0.0', () => console.log('adapter on 8081'));

startWorker(process.env.DEFAULT_COMPANY ?? 'poppy-demo.company.interop.test');
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, async () => { await stopWorker(); process.exit(0); });
