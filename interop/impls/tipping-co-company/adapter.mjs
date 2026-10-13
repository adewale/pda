// Interop adapter (docs/interop-spec.md 5.1, 5.3) for Tipping Co, the Company in
// timothyohare/personal-agent-protocol (packages/company): Hono on Node 24, in-memory stores.
//
// Port 8080 (behind the proxy, as https://tipping-co.company.interop.test) serves upstream's
// own Hono app, built with createCompany() and its tippingCo() config, as packages/company's
// server.ts does. Port 8081 is the control API. The adapter lives in the upstream checkout
// (/upstream/interop-adapter.mjs) so the workspace's packages resolve; Node 24 runs their
// TypeScript directly, as upstream's own scripts do. Nothing upstream is patched.
//
// Hooks play the person on Tipping Co's own sign-in pages, in process (app.request): open the
// authorization URL, sign in with the account's password, then allow or refuse on the consent
// page, and answer with the 303's Location. require_nonce rebuilds the Company with
// requireDpopNonce (upstream's POPPY_REQUIRE_DPOP_NONCE) over the same stores; expire_tokens
// and end_sessions edit the in-memory stores.
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { serve } from '@hono/node-server';
import { createCompany, DEFAULT_TEST_USER, FIXTURES, memoryStores, SECOND_TEST_USER, tippingCo } from 'company';
import { createLogger } from 'poppy-core';

const PORT = Number(process.env.PORT ?? 8080);
const ADAPTER_PORT = Number(process.env.ADAPTER_PORT ?? 8081);
const ORIGIN = (process.env.INTEROP_ORIGIN ?? 'https://tipping-co.company.interop.test').replace(/\/+$/, '');
const SECRET = process.env.INTEROP_SECRET ?? '';
const COMMIT = process.env.INTEROP_COMMIT ?? 'fb7b4e64ad343d9406055a995f4beb06269c1ce6';
const ALLOW_TEST_HOSTS = process.env.INTEROP_ALLOW_TEST_HOSTS === '1';

const PASSWORDS = new Map([DEFAULT_TEST_USER, SECOND_TEST_USER].map((u) => [u.username, u.password]));

const MANIFEST = {
  interop: 1,
  name: 'tipping-co',
  role: 'company',
  commit: COMMIT,
  poppy: ['0.1'],
  extensions: [],
  // Signed out and Direct Sign-In only: no conversations, device or mediated sign-in, MCP,
  // browser Sessions, Operations or staff. R needs the Account Token rotated, which the
  // tippingCo config leaves off, so its trace check finds nothing to judge there.
  scenarios: ['D', 'S0', 'N', 'CM', 'SD', 'SX', 'SO', 'R', 'AO', 'AS'],
  readings: {
    // verifyAssertion's audience is the token endpoint for every client assertion, at
    // /oauth/revoke too (token.ts authenticateClient, revoke.ts).
    S1: 'token-endpoint',
    // Any typ (none is checked), ES256, at most 300 s old (poppy-core ASSERTION_MAX_AGE_S).
    S2: 'lenient-300s',
    // The issuer is always the bare origin (config.ts resolveConfig).
    S3: 'either',
    // A signed-out Session ignores scope and is granted none.
    S4: 'either'
  },
  relaxations: [
    'INTEROP_ALLOW_TEST_HOSTS=1 (set in the image; off when unset): the Company config\'s resolveHost hook, which its private-address check uses before fetching an agent\'s client_id and jwks_uri, reports *.interop.test names as 192.0.2.1 (TEST-NET-1), because every such name resolves to the proxy on a private network. Other names resolve as upstream does. The fetch itself goes to the proxy.',
    'The run CA is trusted through NODE_EXTRA_CA_CERTS'
  ]
};

async function resolveHost(hostname) {
  if (ALLOW_TEST_HOSTS && /(^|\.)interop\.test$/i.test(hostname)) return ['192.0.2.1'];
  return (await lookup(hostname, { all: true })).map((a) => a.address);
}

const log = createLogger('company', (line) => console.log(line));
let company;
function build({ stores, requireDpopNonce = false } = {}) {
  company = createCompany(
    { ...tippingCo(ORIGIN, false), requireDpopNonce, log, resolveHost },
    { stores: stores ?? memoryStores() }
  );
}
build();

// --- the person on Tipping Co's pages ---------------------------------------------------

class HookError extends Error {
  constructor(status, code, detail) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

const hidden = (html, name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
const form = (entries) => {
  const body = new URLSearchParams();
  for (const [k, v] of entries) body.append(k, v);
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() };
};

/** Runs a Direct Sign-In on Tipping Co's pages and returns the redirect it ends with. */
async function consent(url, account, decision, scopes) {
  if (typeof url !== 'string' || !url.startsWith(`${ORIGIN}/oauth/authorize`)) {
    throw new HookError(400, 'bad_request', `not this Company's authorization URL: ${url}`);
  }
  const start = await company.app.request(url);
  if (start.status === 303) return { redirect: start.headers.get('location') };
  const page = await start.text();
  if (start.status !== 200) throw new HookError(502, 'authorize_failed', `authorize answered ${start.status}`);
  const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
  const req = hidden(page, 'req');
  const csrf = hidden(page, 'csrf');
  const username = account ?? DEFAULT_TEST_USER.username;
  const password = PASSWORDS.get(username);
  if (!password) throw new HookError(400, 'unknown_account', `no password for ${username}`);
  const login = await company.app.request(`${ORIGIN}/oauth/authorize/login`, {
    ...form([['req', req], ['csrf', csrf], ['username', username], ['password', password]]),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }
  });
  const consentPage = await login.text();
  if (login.status !== 200) throw new HookError(502, 'login_failed', `login answered ${login.status}`);
  // Allow every scope the page offers, or only those asked for.
  const offered = [...consentPage.matchAll(/name="scope" value="([^"]*)"/g)].map((m) => m[1]);
  const granted = scopes?.length ? offered.filter((s) => scopes.includes(s)) : offered;
  const done = await company.app.request(`${ORIGIN}/oauth/authorize/consent`, {
    ...form([['req', req], ['csrf', csrf], ['decision', decision], ...granted.map((s) => ['scope', s])]),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }
  });
  const redirect = done.headers.get('location');
  if (done.status !== 303 || !redirect) throw new HookError(502, 'consent_failed', `consent answered ${done.status}`);
  return { redirect };
}

const first = FIXTURES[0];
const hooks = {
  fixture: () => ({
    accounts: [DEFAULT_TEST_USER.username, SECOND_TEST_USER.username],
    scopes: { read: ['poppy:read'], write: ['poppy:read', 'poppy:write'] },
    // The OpenAPI document has no operationIds, so operations are named "METHOD /path" (5.2).
    openapi: { api: 'openapi', operation: 'GET /api/me/tips', args: {} },
    openapi_public: { api: 'openapi', operation: 'GET /api/ladder', args: {} },
    openapi_write: { api: 'openapi', operation: 'POST /api/me/tips', args: { body: { fixture_id: first.id, team: first.home } } },
    otp_account: null
  }),
  approve_authorization: (p) => consent(p.url, p.account, 'approve', p.scopes),
  deny_authorization: (p) => consent(p.url, p.account, 'deny'),
  require_nonce: () => {
    build({ stores: company.stores, requireDpopNonce: true });
    return {};
  },
  expire_tokens: () => {
    let expired = 0;
    for (const t of company.stores.tokens.values()) {
      if (t.expiresAt > Date.now()) expired++;
      t.expiresAt = Date.now() - 1000;
    }
    return { expired };
  },
  end_sessions: () => {
    let ended = 0;
    for (const s of company.stores.sessions.values()) {
      if (!s.ended) ended++;
      s.ended = true;
    }
    return { ended };
  }
};

// --- the two servers ------------------------------------------------------------------

serve({ fetch: (req, env) => company.app.fetch(req, env), port: PORT, hostname: '0.0.0.0' });

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
      build();
      return send(res, 200, { reset: true });
    }
    if (req.method === 'GET' && path === '/hooks') return send(res, 200, { hooks: Object.keys(hooks) });
    const m = /^\/hooks\/([a-z_]+)$/.exec(path);
    if (req.method === 'POST' && m) {
      const hook = hooks[m[1]];
      if (!hook) return send(res, 501, { error: 'unsupported', detail: `hook ${m[1]}` });
      return send(res, 200, await hook(await readJson(req)));
    }
    return send(res, 404, { error: 'not_found', detail: path });
  } catch (e) {
    return send(res, e.status ?? 500, { error: e.code ?? 'adapter_failed', detail: String(e.message ?? e) });
  }
}).listen(ADAPTER_PORT, '0.0.0.0', () => console.log(`[adapter] Tipping Co at ${ORIGIN}; control API on ${ADAPTER_PORT}`));
