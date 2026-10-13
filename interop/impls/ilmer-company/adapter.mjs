// Interop adapter for Ilmer Past's Poppy Company (interop spec 5.1 and 5.3).
//
// Starts `wrangler dev` for agent/ on PORT (default 8080) and serves the control API on
// ADAPTER_PORT (default 8081). Ilmer Past has no accounts, sign-in, staff or operations,
// so the only hook is `fixture`; every other hook answers 501.
//
// Zero dependencies; Node 22.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

const PORT = Number(process.env.PORT ?? 8080);
const ADAPTER_PORT = Number(process.env.ADAPTER_PORT ?? 8081);
// The runner sets INTEROP_ORIGIN (spec section 3); ILMER_ORIGIN and the default are for running by hand.
const ORIGIN = (process.env.INTEROP_ORIGIN ?? process.env.ILMER_ORIGIN ?? 'https://ilmer.company.interop.test').replace(/\/+$/, '');
const SECRET = process.env.INTEROP_SECRET ?? '';
const APP_DIR = '/opt/ilmer/agent';
const STATE = '/tmp/ilmer-state';
const INNER = `http://127.0.0.1:${PORT}`;
const COMMIT = process.env.INTEROP_COMMIT ?? 'de0d1ec50f09906fedf26a83b7b88042ebfebd56';

const MANIFEST = {
  interop: 1,
  name: 'ilmer',
  role: 'company',
  commit: COMMIT,
  poppy: ['0.1'],
  extensions: [],
  // Signed out only. No nonce challenges (no N), no Account Tokens to revoke (no SO).
  scenarios: ['D', 'S0', 'C', 'CI', 'CM'],
  readings: {
    // Each client assertion's aud is the endpoint it is sent to (token or revocation).
    S1: 'token-endpoint',
    // Assertions need typ JWT, a kid, and exp - iat <= 60 s.
    S2: 'jwt-60s',
    // The issuer is the bare origin, so both metadata locations are the same URL.
    S3: 'either',
    // An omitted scope gets poppy:read poppy:write; conversations need poppy:write, so an
    // agent that sends scope=poppy:read on a signed-out Session can't converse.
    S4: 'omit'
  },
  relaxations: [
    'Runs under wrangler dev with a container-only wrangler.jsonc (upstream deploys with the cf CLI): ORIGIN is the interop origin, LOCAL_DEV=false',
    'No Workers AI binding (as upstream\'s ILMER_POPPY_OFFLINE=true): every Company Agent reply is Ilmer\'s fixed "Sorry, I could not answer that just now" message',
    'A container-only entry module (interop-main.js) re-exports upstream\'s Worker and gives HistoryAgent a stand-in env.AI that refuses every call, because its web_search and web_fetch tools need a binding to be constructed',
    'workerd trusts the run CA through the system trust store, installed by the entrypoint, for fetching client metadata'
  ]
};

// --- the implementation process --------------------------------------------------------

let child;
function startApp() {
  child = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev',
    '--ip', '0.0.0.0', '--port', String(PORT),
    // request.url carries the public https origin (Ilmer itself builds URLs from ORIGIN).
    '--local-upstream', new URL(ORIGIN).host, '--upstream-protocol', 'https',
    '--persist-to', STATE,
    '--var', `ORIGIN:${ORIGIN}`,
    '--show-interactive-dev-session=false'
  ], { cwd: APP_DIR, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  child.on('exit', (code, signal) => console.log(`[adapter] wrangler exited (${code ?? signal})`));
}
async function stopApp() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(r => setTimeout(r, 8000))]);
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

// --- spec 5.3 hooks --------------------------------------------------------------------

const HOOKS = {
  async fixture() {
    // Signed out only: no accounts, no APIs (discovery lists none), no sign-in or
    // operation prompts. Replies are Ilmer's fixed offline apology (no Workers AI here).
    return {
      accounts: [],
      scopes: [],
      prompts: { hello: "Who built St Peter's Church in Ilmer?" },
      otp_account: null
    };
  }
  // require_nonce, rate_limit, expire_tokens: 501. Ilmer has no DPoP nonces, its only
  // limit is a daily prompt budget, and token lifetimes are fixed.
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
      // Durable Object storage is the only state: stop, delete it, start again.
      await stopApp();
      await rm(STATE, { recursive: true, force: true });
      startApp();
      if (!(await waitReady())) throw new AdapterError(500, 'restart_failed', 'the Company did not come back within 60 s');
      return send(res, 200, { reset: true });
    }
    if (req.method === 'GET' && path === '/hooks') return send(res, 200, { hooks: Object.keys(HOOKS) });
    const m = /^\/hooks\/([a-z_]+)$/.exec(path);
    if (req.method === 'POST' && m) {
      const hook = HOOKS[m[1]];
      if (!hook) return send(res, 501, { error: 'unsupported', detail: `Ilmer Past has no ${m[1]}: it is a signed-out Company with no accounts, staff or operations` });
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
