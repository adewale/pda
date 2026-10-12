// Interop adapter (docs/interop-spec.md 5.1, 5.3) for print-with-poppy, an agent-first
// photo-print store (spenciefy/print-with-poppy).
//
// Starts the store (server/index.ts under tsx) on PORT (8080) in its demo mode and serves
// the control API on ADAPTER_PORT (8081). The store offers signed-out Sessions only: no
// sign-in, no conversations, no staff. Its OpenAPI API and the Operations v1 extension need
// a native Poppy Session whose agent is on its allowlist (AGENT_CLIENT_IDS). The only hook
// is `fixture`; every other hook answers 501.
//
// Zero dependencies; Node 22.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

const PORT = Number(process.env.PORT ?? 8080);
const ADAPTER_PORT = Number(process.env.ADAPTER_PORT ?? 8081);
// The runner sets INTEROP_ORIGIN (spec section 3); the default is for running by hand.
const ORIGIN = (process.env.INTEROP_ORIGIN ?? 'https://print-with-poppy.company.interop.test').replace(/\/+$/, '');
const SECRET = process.env.INTEROP_SECRET ?? '';
const COMMIT = process.env.INTEROP_COMMIT ?? '7ef69bef9ca9e485386b28a679c532ed7cbee739';
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
  // Signed out only. No sign-in (AO, AS, O and OX all start with Direct Sign-In), no
  // conversations (C, CI, CS), no DPoP nonces (N), no Account Tokens (SO, R, SE).
  scenarios: ['D', 'S0'],
  readings: {
    // A client assertion's aud must be exactly the endpoint it is sent to: the token
    // endpoint at /oauth/token, the revocation endpoint at /oauth/revoke (a string, not an array).
    S1: 'endpoint',
    // Any typ (only poppy-browser+jwt is refused), at most 120 s (exp - iat <= 120, iat no
    // older than 120 s).
    S2: 'lenient-120s',
    // The issuer is the bare origin, so both metadata locations are the same URL.
    S3: 'either',
    // The jwt-bearer grant ignores scope; every Session Token comes back with scope "".
    S4: 'either'
  },
  relaxations: [
    'APP_MODE=demo, upstream\'s local mode: payments, print orders and email are simulated in process, prices are illustrative, and no Stripe, Prodigi or Resend client is configured. Demo mode also serves the store\'s own browser demo (/api/demo/*, the Demo authorization scheme, its built-in demo agent), which no grid agent uses.'
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

const HOOKS = {
  async fixture() {
    // No accounts or scopes (signed out only) and no prompts (no conversations). getCatalog
    // answers without any Session; every other operation needs one, plus a photo uploaded
    // as multipart/form-data before an order can be proposed.
    return {
      accounts: [],
      scopes: [],
      openapi_public: { api: 'openapi', operation: 'getCatalog', args: {} },
      prompts: {},
      otp_account: null
    };
  }
  // require_nonce, rate_limit, expire_tokens, issuer_path: 501. The store never asks for a
  // DPoP nonce, its rate limits are fixed (30 a minute at /oauth), Session Tokens live an
  // hour, and its issuer is its origin.
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
      if (!hook) return send(res, 501, { error: 'unsupported', detail: `print-with-poppy has no ${m[1]}: it is a signed-out Company with no accounts, conversations or staff` });
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
