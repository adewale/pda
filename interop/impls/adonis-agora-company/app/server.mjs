// Minimal AdonisJS host for the Poppy interop grid: @adonis-agora/authkit-server as the Poppy
// authorization server (discovery, sessions, Direct/Device/Mediated sign-in, revocation) and
// @adonis-agora/agent as the Company Agent of Poppy conversations. Everything Poppy is the
// libraries'; this file only does what their docs leave to the host app: config, an account
// store, screens, a deterministic model in place of an LLM, and one OpenAPI endpoint.
//
// Booted programmatically (IgnitorFactory) so the app is one file with no build step.
import 'reflect-metadata';
import { mkdirSync } from 'node:fs';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { defineConfig as httpConfig } from '@adonisjs/core/http';
import { defineConfig as sessionConfig, stores as sessionStores } from '@adonisjs/session';
import { defineConfig as shieldConfig } from '@adonisjs/shield';
import { defineConfig as dbConfig } from '@adonisjs/lucid';
import {
  adapters,
  authkitCsrfExceptions,
  defineConfig as authkitConfig,
  poppyAuth,
  poppyOf,
  registerAuthHost,
} from '@adonis-agora/authkit-server';
import { definePoppyConfig, InMemoryPoppyStore } from '@adonis-agora/agent/poppy';
import {
  AgentDepsFactory,
  AgentRegistry,
  AgentService,
  DefaultToolAuthorizer,
  InlineAgentRunner,
  InProcessTokenStreamSink,
  ToolRegistry,
} from '@adonis-agora/agent';
import { personalAgentGate } from '@adonis-agora/agent/a2a';
import { FakeModelProvider, InMemoryAgentStore } from '@adonis-agora/agent/testing';
import { z } from 'zod';
import { render } from './render.mjs';
import { startAdapter, state } from './hooks.mjs';

const ORIGIN = (process.env.INTEROP_ORIGIN ?? process.env.PUBLIC_ORIGIN ?? 'https://adonis-agora.company.interop.test').replace(/\/+$/, '');
const HOST = new URL(ORIGIN).hostname;
const DATA = process.env.DATA_DIR ?? '/data';
mkdirSync(DATA, { recursive: true });

// Test people. Passwords are generated per container start; the hooks hand them to the runner.
export const ACCOUNTS = state.accounts;

const accountStore = {
  async findById(id) {
    const a = ACCOUNTS.find((x) => x.id === id);
    return a ? { id: a.id, email: a.email, name: a.name, avatarUrl: null, globalRoles: ['USER'] } : null;
  },
  async findByEmail(email) {
    const a = ACCOUNTS.find((x) => x.email === String(email).toLowerCase());
    return a ? this.findById(a.id) : null;
  },
  async verifyCredentials(email, password) {
    const a = ACCOUNTS.find((x) => x.email === String(email).toLowerCase() && x.password === password);
    return a ? this.findById(a.id) : null;
  },
  async create() {
    throw new Error('registration is off');
  },
  async issuePasswordResetToken() {
    return null;
  },
  async consumePasswordResetToken() {
    return false;
  },
  async issueEmailVerificationToken() {
    return null;
  },
  async consumeEmailVerificationToken() {
    return false;
  },
  async listAccounts() {
    const data = await Promise.all(ACCOUNTS.map((a) => this.findById(a.id)));
    return { data, meta: { total: data.length, page: 1, perPage: data.length, lastPage: 1 } };
  },
  async setGlobalRoles() {},
};

// Mediated Sign-In (4.7): alice signs in with her password; bob also needs a one-time code,
// which the `last_one_time_code` hook reads (as a person would read their phone).
const mediated = {
  fields: [
    { name: 'email', label: 'Email', secret: false },
    { name: 'password', label: 'Password', secret: true },
  ],
  scopes: ['poppy:read', 'poppy:write'],
  async verify({ credentials }) {
    const a = ACCOUNTS.find(
      (x) => x.email === String(credentials.email ?? '').toLowerCase() && x.password === credentials.password,
    );
    if (!a) return { status: 'failed' };
    if (!a.mediatedCode) return { status: 'complete', accountId: a.id };
    const code = String(Math.floor(100000 + Math.random() * 900000));
    state.lastCode = code;
    return { status: 'code_required', accountId: a.id, sentTo: 'the phone number ending in 42', code };
  },
};

// The Company Agent's "model": deterministic, offline. Orders go through a tool that needs
// poppy:read, so a signed-out ask ends in an `authorization` event, as with a real model.
const tools = new ToolRegistry();
tools.register(
  {
    name: 'list_orders',
    kind: 'read',
    description: "List the signed-in customer's orders.",
    roles: ['scope:poppy:read'],
    inputSchema: z.object({}),
  },
  {
    execute: async (_input, ctx) => ({ orders: ordersFor(ctx?.actor?.id) }),
  },
);
const model = new FakeModelProvider((args) => {
  const last = args.messages.at(-1);
  if (last?.toolResults?.length || last?.role === 'tool') {
    if (last.toolResults?.some((r) => r.error)) return { text: 'I need you to sign in and allow access to your orders first.' };
    const found = last.toolResults?.length ? JSON.stringify(last.toolResults.map((r) => r.output ?? r.content ?? r)) : last.content;
    return { text: `Here is what I found: ${String(found).slice(0, 300)}` };
  }
  const said = String(last?.content ?? '');
  if (/\border/i.test(said)) return { text: '', toolCall: { name: 'list_orders', input: {} } };
  return { text: `Adonis Agora interop shop here. You said: "${said.slice(0, 200)}"` };
});
// Memory stores behind a switchable reference, so the adapter's /reset can start them afresh.
function resettable(make) {
  let current = make();
  state.resetters.push(async () => {
    current = make();
  });
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        const v = current[key];
        return typeof v === 'function' ? v.bind(current) : v;
      },
      has: (_t, key) => key in current,
    },
  );
}
const agentStore = resettable(() => new InMemoryAgentStore());
const poppyStore = resettable(() => new InMemoryPoppyStore());
const deps = new AgentDepsFactory({
  model,
  store: agentStore,
  sink: new InProcessTokenStreamSink(),
  rolesPolicy: personalAgentGate(new DefaultToolAuthorizer()),
  registry: tools,
  agents: new AgentRegistry(),
});
const agentService = new AgentService(new InlineAgentRunner(deps, agentStore), agentStore, deps);

function ordersFor(accountId) {
  return [{ id: 'ord_1001', account: accountId ?? null, item: 'Interop mug', status: 'delivered' }];
}

const insecurePeers = process.env.INTEROP_ALLOW_PRIVATE_PEERS === '1';

const config = {
  app: {
    appKey: process.env.APP_KEY ?? state.appKey,
    appUrl: ORIGIN,
    http: httpConfig({
      trustProxy: () => true,
      cookie: { domain: '', path: '/', maxAge: '2h', httpOnly: true, secure: true, sameSite: 'lax' },
    }),
  },
  session: sessionConfig({
    enabled: true,
    cookieName: 'adonis-session',
    clearWithBrowser: false,
    age: '2h',
    cookie: { path: '/', httpOnly: true, secure: true, sameSite: 'lax' },
    store: 'cookie',
    stores: { cookie: sessionStores.cookie() },
  }),
  shield: shieldConfig({
    csp: { enabled: false },
    csrf: {
      enabled: true,
      // AuthKit's machine-to-machine routes, and the host's API (authenticated by Session Token + DPoP).
      exceptRoutes: (ctx) => authkitCsrfExceptions(ctx.request.url(), { mountPath: '/oidc' }) || ctx.request.url().startsWith('/api/'),
      enableXsrfCookie: false,
      methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    },
    xFrame: { enabled: true, action: 'DENY' },
    hsts: { enabled: false },
    contentTypeSniffing: { enabled: true },
  }),
  database: dbConfig({
    connection: 'sqlite',
    connections: {
      sqlite: { client: 'better-sqlite3', connection: { filename: `${DATA}/db.sqlite3` }, useNullAsDefault: true },
    },
  }),
  authkit: authkitConfig({
    issuer: `${ORIGIN}/oidc`,
    adapter: adapters.database(),
    jwks: { source: 'managed', algorithm: 'ES256' },
    clients: [],
    accountStore,
    render,
    trustedDevices: { enabled: false },
    personalAgents: {
      poppy: {
        organization: { name: 'Adonis Agora Interop Shop', domain: HOST },
        signIn: { direct: true, device: true, mediated },
        apis: [{ type: 'openapi', url: `${ORIGIN}/api/openapi.json`, description: 'Orders (needs poppy:read)' }],
        agent: { protocols: [{ type: 'poppy', endpoint: `${ORIGIN}/poppy/conversations` }] },
        replay: 'memory',
        // INTEROP-ONLY (off by default upstream, refused with NODE_ENV=production): fetch agent
        // metadata without the SSRF guard, so peers behind the grid's private-network proxy resolve.
        allowInsecureClientIds: insecurePeers,
        dpop: { requireNonce: process.env.POPPY_REQUIRE_NONCE === '1' },
        // AuthKit's own limiter on new Sessions; the `rate_limit` hook (endpoint "token") arms it.
        rateLimit: async ({ action }) => (action === 'session' ? state.takeLimit('token') : null),
      },
    },
  }),
  poppy: definePoppyConfig({
    path: 'poppy/conversations',
    baseUrl: ORIGIN,
    store: poppyStore,
    service: () => agentService,
    handoff: {
      // A person is always "queued" here; the `staff_join` / `staff_reply` hooks act as that person.
      request: async () => 'queued',
      message: async () => {},
      cancel: async () => {},
    },
  }),
};

const ignitor = new IgnitorFactory()
  .withCoreConfig()
  .withCoreProviders()
  .merge({
    config,
    rcFileContents: {
      providers: [
        () => import('@adonisjs/core/providers/vinejs_provider'),
        () => import('@adonisjs/session/session_provider'),
        () => import('@adonisjs/shield/shield_provider'),
        () => import('@adonisjs/lucid/database_provider'),
        () => import('@adonis-agora/authkit-server/authkit_server_provider'),
        () => import('@adonis-agora/agent/poppy_provider'),
      ],
    },
  })
  .preload(async (app) => {
    app.container.singleton(ToolRegistry, () => tools);
    const server = await app.container.make('server');
    server.use([() => import('./rate_limit_middleware.mjs'), () => import('@adonisjs/core/bodyparser_middleware')]);
    const router = await app.container.make('router');
    router.use([
      () => import('@adonisjs/session/session_middleware'),
      () => import('@adonisjs/shield/shield_middleware'),
    ]);
    registerAuthHost(router, {
      admin: false,
      adminApi: false,
      account: { tokens: false, orgs: false, security: false, mfa: false, apps: false },
    });
    router.get('/', async ({ response }) => response.send('Adonis Agora interop shop'));
    router.get('/api/openapi.json', async ({ response }) => response.json(openapi()));
    router
      .get('/api/orders', async (ctx) => {
        const p = poppyOf(ctx);
        return ctx.response.json({ orders: ordersFor(p?.accountId) });
      })
      .use(poppyAuth({ scopes: ['poppy:read'] }));
    // Works with any Session Token, signed in or not.
    router
      .get('/api/catalog', async (ctx) => {
        const q = String(ctx.request.qs().q ?? '');
        return ctx.response.json({ q, products: [{ sku: 'mug-1', name: 'Interop mug', price: 12 }] });
      })
      .use(poppyAuth({}));
    router
      .post('/api/profile', async (ctx) => {
        const p = poppyOf(ctx);
        return ctx.response.status(200).json({ account: p?.accountId ?? null, nickname: String(ctx.request.input('nickname') ?? '') });
      })
      .use(poppyAuth({ scopes: ['poppy:write'] }));
    state.app = app;
  })
  .create(new URL('./', import.meta.url), {
    importer: (path) => import(path),
  });

const httpServer = ignitor.httpServer();
await httpServer.start();
await startAdapter({ origin: ORIGIN });

function openapi() {
  return {
    openapi: '3.1.0',
    info: { title: 'Adonis Agora interop orders', version: '1' },
    servers: [{ url: `${ORIGIN}/api` }],
    paths: {
      '/orders': {
        get: {
          operationId: 'listOrders',
          summary: 'List orders (poppy:read)',
          security: [{ poppy: ['poppy:read'] }],
          responses: { 200: { description: 'Orders' } },
        },
      },
      '/catalog': {
        get: {
          operationId: 'searchCatalog',
          summary: 'Search products (any Session)',
          parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
          security: [{ poppy: [] }],
          responses: { 200: { description: 'Products' } },
        },
      },
      '/profile': {
        post: {
          operationId: 'updateProfile',
          summary: 'Change the nickname (poppy:write)',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { nickname: { type: 'string' } } } } } },
          security: [{ poppy: ['poppy:write'] }],
          responses: { 200: { description: 'Updated' } },
        },
      },
    },
    components: { securitySchemes: { poppy: { type: 'http', scheme: 'DPoP' } } },
  };
}
