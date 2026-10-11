/**
 * Our strict mock Company (test/mock-company) as an interop Company
 * (docs/interop-spec.md, section 5.3). It runs the mock unchanged in Node,
 * moved under `<name>.company.interop.test`, and maps each hook to the RPC
 * the conformance tests use. It is the reference Company for attribution
 * rule 2, and serves the violations it records at `GET /violations`.
 *
 * Port 8080: the Company itself (behind the recording proxy).
 * Port 8081: the manifest and hooks, with `Authorization: Bearer $INTEROP_SECRET`.
 */
import { memoryState } from "../shared/cloudflare-workers.ts";
import { authorized, body, failure, json, serve, setting } from "../shared/serve.ts";
import { MockCompany } from "../../../test/mock-company/index.ts";
import { DEFAULT_CONFIG, placeCompanies, type MockConfig } from "../../../test/mock-company/types.ts";
import { violationId } from "../../../test/mock-company/violations.ts";

const NAME = process.env.INTEROP_NAME ?? "dpa-mock";
const SECRET = setting("INTEROP_SECRET");
const COMMIT = process.env.INTEROP_COMMIT ?? "unknown";
const SUFFIX = "company.interop.test";

// `<id>.company.interop.test`, its `www.`, `auth.`, `api.`, `mcp.` and `cdn.`
// hosts, and a second domain `uk.<id>.company.interop.test` for poppy_domains.
placeCompanies({
  domain: (id) => `${id}.${SUFFIX}`,
  altDomain: (id) => `uk.${id}.${SUFFIX}`,
  idFromHost: (host) =>
    /^(?:(?:www|auth|api|mcp|cdn)\.)?(?:uk\.)?([a-z0-9-]+)\.company\.interop\.test$/.exec(host)?.[1] ?? null
});

/**
 * Two profiles, chosen by `INTEROP_MOCK_PROFILE` (registry `env`), one image:
 *
 * - `lenient` (default; `dpa-mock`, the reference Company for attribution
 *   rule 2): the conformance suite's S2-lenient settings
 *   (`strictAssertions: false`: no `typ` or `kid` needed, assertions up to
 *   300 s). Section 8 of the interop spec treats S2 as a warning, so the
 *   reference Company doesn't refuse an agent for it.
 * - `strict` (`dpa-mock-strict`): `strictAssertions` on, as the strictest
 *   live Companies are; it declares S2 `jwt-60s`.
 *
 * Both rotate Account Tokens (scenario R) and poll devices every second so
 * Device Sign-In cells don't wait five.
 */
const PROFILE = process.env.INTEROP_MOCK_PROFILE === "strict" ? "strict" : "lenient";
if (process.env.INTEROP_MOCK_PROFILE && process.env.INTEROP_MOCK_PROFILE !== PROFILE) {
  throw new Error(`INTEROP_MOCK_PROFILE must be lenient or strict, not ${process.env.INTEROP_MOCK_PROFILE}`);
}
const BASE: Partial<MockConfig> = {
  rotateRefreshTokens: true,
  deviceInterval: 1,
  strictAssertions: PROFILE === "strict"
};

// `PUBLIC_ORIGIN` is where the mock would reach our Worker directly in tests;
// here no host matches it, so every client document is fetched over the network.
const env = { PUBLIC_ORIGIN: "https://no-direct-worker.invalid" } as unknown as Env;

let mock: MockCompany;

async function reset(): Promise<void> {
  mock = new MockCompany(memoryState(NAME) as never, env);
  await mock.configure(BASE);
}
await reset();

const MANIFEST = {
  interop: 1,
  name: NAME,
  role: "company",
  commit: COMMIT,
  poppy: ["0.1"],
  extensions: ["operations"],
  scenarios: ["D", "S0", "N", "SD", "SV", "SVN", "SM", "SMC", "SX", "SXV", "C", "CI", "CS", "CA", "SO", "O", "OX", "SE", "R", "AO", "AM", "AS", "RL"],
  readings: { S1: "either", S2: PROFILE === "strict" ? "jwt-60s" : "any", S3: "insertion", S4: "either", S23: "per-company" },
  relaxations: [] as string[],
  profile: PROFILE,
  notes: `test/mock-company, ${PROFILE} profile: checks recorded as named violations (GET /violations).`
};

type Params = Record<string, unknown>;
const str = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") throw new HookError(400, "invalid_params", `${name} must be a non-empty string`);
  return value;
};
const scopes = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

class HookError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

function accountFor(account: unknown) {
  const id = typeof account === "string" ? account : DEFAULT_CONFIG.accounts[0]!.account;
  const found = DEFAULT_CONFIG.accounts.find((item) => item.account === id);
  if (!found) throw new HookError(400, "unknown_account", `No account ${id}`);
  return found;
}

const HOOKS: Record<string, (params: Params) => Promise<unknown>> = {
  async fixture() {
    return {
      accounts: DEFAULT_CONFIG.accounts.map((item) => item.account),
      scopes: { read: ["poppy:read"], write: ["poppy:read", "poppy:write"] },
      openapi_public: { api: "openapi", operation: "searchProducts", args: { params: { q: "jacket" } } },
      openapi: { api: "openapi", operation: "listOrders", args: {} },
      openapi_write: {
        api: "openapi",
        operation: "exchangeItem",
        args: { params: { order_id: "ord_7Hk2" }, body: { item_id: "itm_4Qa", replacement_sku: "stormline-insulated-m" } }
      },
      mcp: { api: "mcp", tool: "search_products", args: { query: "jacket" } },
      prompts: {
        hello: "Hello",
        operation: "I'd like to exchange the jacket on my order",
        sign_in: "Where is my order?"
      },
      otp_account: DEFAULT_CONFIG.accounts.find((item) => item.otp)?.account ?? null
    };
  },
  async approve_authorization(params) {
    const account = accountFor(params.account).account;
    const granted = scopes(params.scopes);
    const redirect = await mock.approveAuthorization(str(params.url, "url"), {
      account,
      approve: true,
      ...(granted ? { scopes: granted } : {})
    });
    return { redirect };
  },
  async deny_authorization(params) {
    return { redirect: await mock.approveAuthorization(str(params.url, "url"), { approve: false }) };
  },
  async approve_device(params) {
    const granted = scopes(params.scopes);
    await mock.approveDevice(str(params.user_code, "user_code"), {
      account: accountFor(params.account).account,
      ...(granted ? { scopes: granted } : {})
    });
    return {};
  },
  async deny_device(params) {
    await mock.denyDevice(str(params.user_code, "user_code"));
    return {};
  },
  async mediated_answers(params) {
    const account = accountFor(params.account);
    return { fields: { email: account.email, password: account.password } };
  },
  async last_one_time_code() {
    const code = await mock.lastOneTimeCode();
    if (!code) throw new HookError(409, "no_code", "No one-time code has been sent");
    return { code };
  },
  async end_sessions() {
    return { ended: await mock.endAllSessions() };
  },
  async staff_join(params) {
    await mock.humanJoin(str(params.conversation, "conversation"), str(params.text, "text"));
    return {};
  },
  async staff_reply(params) {
    await mock.say(str(params.conversation, "conversation"), str(params.text, "text"));
    return {};
  },
  /**
   * The mock's Company Agent proposes the exchange when the agent asks for
   * one (fixture `prompts.operation`) in a signed-in conversation; this
   * returns that proposal.
   */
  async propose_operation() {
    const state = await mock.state();
    const proposed = state.operations.filter((item) => item.state === "proposed").at(-1);
    if (!proposed) {
      throw new HookError(409, "no_operation", "Nothing proposed: send fixture.prompts.operation in a signed-in conversation first");
    }
    return { operation: proposed.id };
  },
  async require_nonce() {
    await mock.configure({ requireNonce: true });
    return {};
  },
  async rate_limit(params) {
    const count = typeof params.requests === "number" ? params.requests : 1;
    const retryAfter = typeof params.retry_after === "number" ? params.retry_after : 1;
    await mock.limitNext(params.endpoint === "token" ? "token" : "other", count, retryAfter);
    return {};
  },
  async expire_tokens() {
    return { expired: await mock.expireSessionTokens() };
  }
};

async function control(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
  if (request.method === "GET" && url.pathname === "/manifest") return json(MANIFEST);
  if (!authorized(request, SECRET)) return failure(401, "unauthorized", "Control calls need Authorization: Bearer $INTEROP_SECRET");
  if (request.method === "POST" && url.pathname === "/reset") {
    await reset();
    return json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/hooks") return json({ hooks: Object.keys(HOOKS) });
  if (request.method === "GET" && url.pathname === "/violations") {
    const state = await mock.state();
    return json({
      violations: state.violations.map((recorded) => ({ id: violationId(recorded), detail: recorded.replace(/^\[[^\]]+\]\s*/, "") }))
    });
  }
  const hook = /^\/hooks\/([a-z_]+)$/.exec(url.pathname);
  if (request.method === "POST" && hook) {
    const run = HOOKS[hook[1]!];
    if (!run) return failure(501, "unsupported", `No hook ${hook[1]}`);
    try {
      return json(await run(await body(request)));
    } catch (error) {
      if (error instanceof HookError) return failure(error.status, error.code, error.message);
      return failure(500, "hook_failed", error instanceof Error ? error.message : String(error));
    }
  }
  return failure(404, "not_found", `${request.method} ${url.pathname}`);
}

serve(8080, (request) => mock.fetch(request));
serve(8081, control);
console.log(`dpa-mock (${PROFILE}): ${NAME}.${SUFFIX} on 8080, control on 8081`);
