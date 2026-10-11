/**
 * Runs our strict mock Company (test/mock-company) in Node on localhost for
 * the Hypothesis suite (test/hypothesis), with no Docker. The conftest
 * bundles this file with interop/impls/shared/build.mjs, as the interop
 * adapter is bundled, and starts it.
 *
 * It places the mock under `<id>.company.interop.test`, as the interop
 * adapter does. The Python client connects to 127.0.0.1 and sends the
 * Company's host in `Host` with `X-Forwarded-Proto: https`, which serve.ts
 * turns back into the URL the client meant, so `htu`, `aud` and the issuer
 * are checked against the real `https://` URLs. No check is relaxed.
 *
 * Two ports on 127.0.0.1, printed as one JSON line on stdout:
 * - `company`: the Company's hosts;
 * - `control`: the hooks, with `Authorization: Bearer $HYPOTHESIS_MOCK_SECRET`.
 *
 * Control routes (interop/impls/dpa-mock/adapter.ts has the same hooks, by
 * the same names; the rest are this launcher's own):
 * - `POST /reset {config}`: a new mock, with these settings (only the
 *   knobs in `KNOBS`);
 * - `POST /client-documents {documents: {url: body}}`: the Python agent's
 *   client metadata and JWKS, served to the mock at those URLs (the mock's
 *   `serveClientDocument`, made for a second client), and still checked
 *   like any client's;
 * - `GET /violations`, `GET /state`;
 * - `POST /hooks/<name>`: `fixture`, `approve_authorization`,
 *   `deny_authorization`, `approve_device`, `mediated_answers`,
 *   `last_one_time_code`.
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { memoryState } from "../../interop/impls/shared/cloudflare-workers.ts";
import { authorized, body, failure, json, serve, setting } from "../../interop/impls/shared/serve.ts";
import { MockCompany } from "../mock-company/index.ts";
import { DEFAULT_CONFIG, placeCompanies, type MockConfig } from "../mock-company/types.ts";
import { violationId } from "../mock-company/violations.ts";

const NAME = "hyp";
const SUFFIX = "company.interop.test";
const SECRET = setting("HYPOTHESIS_MOCK_SECRET");

placeCompanies({
  domain: (id) => `${id}.${SUFFIX}`,
  altDomain: (id) => `uk.${id}.${SUFFIX}`,
  idFromHost: (host) =>
    /^(?:(?:www|auth|api|mcp|cdn)\.)?(?:uk\.)?([a-z0-9-]+)\.company\.interop\.test$/.exec(host)?.[1] ?? null
});

/** The settings a test may choose: each is a way real Companies differ, never a relaxed check. */
const KNOBS = [
  "strictAssertions",
  "clientAssertionAud",
  "rotateRefreshTokens",
  "reuseDetection",
  "requireNonce",
  "nonceScope",
  "omitTokenScope",
  "issuerTrailingSlash",
  "endSessionsOnSignOut",
  "endedSessionError",
  "streaming",
  "textDeltas",
  "sseKeepAlive",
  "agentReplies"
] as const satisfies readonly (keyof MockConfig)[];

/** Device polling every second, as in the interop adapter. */
const BASE: Partial<MockConfig> = { deviceInterval: 1 };

const env = { PUBLIC_ORIGIN: "https://no-direct-worker.invalid" } as unknown as Env;
let mock = new MockCompany(memoryState(NAME) as never, env);
await mock.configure(BASE);

class HookError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string
  ) {
    super(detail);
  }
}

type Params = Record<string, unknown>;
const str = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") throw new HookError(400, "invalid_params", `${name} must be a non-empty string`);
  return value;
};
const scopes = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
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
      prompts: { hello: "Hello", operation: "I'd like to exchange the jacket on my order", sign_in: "Where is my order?" },
      otp_account: DEFAULT_CONFIG.accounts.find((item) => item.otp)?.account ?? null
    };
  },
  async approve_authorization(params) {
    const granted = scopes(params.scopes);
    const redirect = await mock.approveAuthorization(str(params.url, "url"), {
      account: accountFor(params.account).account,
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
  async mediated_answers(params) {
    const account = accountFor(params.account);
    return { fields: { email: account.email, password: account.password } };
  },
  async last_one_time_code() {
    const code = await mock.lastOneTimeCode();
    if (!code) throw new HookError(409, "no_code", "No one-time code has been sent");
    return { code };
  }
};

async function control(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!authorized(request, SECRET)) return failure(401, "unauthorized", "Control calls need Authorization: Bearer $HYPOTHESIS_MOCK_SECRET");
  try {
    if (request.method === "POST" && url.pathname === "/reset") {
      const given = ((await body(request)).config ?? {}) as Record<string, unknown>;
      const config: Record<string, unknown> = { ...BASE };
      for (const [name, value] of Object.entries(given)) {
        if (!(KNOBS as readonly string[]).includes(name)) throw new HookError(400, "unknown_knob", `Not a setting tests may choose: ${name}`);
        config[name] = value;
      }
      mock = new MockCompany(memoryState(NAME) as never, env);
      await mock.configure(config as Partial<MockConfig>);
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/client-documents") {
      const documents = ((await body(request)).documents ?? {}) as Record<string, unknown>;
      for (const [at, document] of Object.entries(documents)) await mock.serveClientDocument(at, document);
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/violations") {
      const state = await mock.state();
      return json({
        violations: state.violations.map((recorded) => ({ id: violationId(recorded), detail: recorded.replace(/^\[[^\]]+\]\s*/, "") }))
      });
    }
    if (request.method === "GET" && url.pathname === "/state") return json(await mock.state());
    const hook = /^\/hooks\/([a-z_]+)$/.exec(url.pathname);
    if (request.method === "POST" && hook) {
      const run = HOOKS[hook[1]!];
      if (!run) return failure(501, "unsupported", `No hook ${hook[1]}`);
      return json(await run(await body(request)));
    }
    return failure(404, "not_found", `${request.method} ${url.pathname}`);
  } catch (error) {
    if (error instanceof HookError) return failure(error.status, error.code, error.message);
    return failure(500, "hook_failed", error instanceof Error ? error.message : String(error));
  }
}

const company = serve(0, (request) => mock.fetch(request), "127.0.0.1");
const controlServer = serve(0, control, "127.0.0.1");
await Promise.all([once(company, "listening"), once(controlServer, "listening")]);
console.log(
  JSON.stringify({
    company: (company.address() as AddressInfo).port,
    control: (controlServer.address() as AddressInfo).port
  })
);
// Exit with the parent: the conftest closes stdin when the session ends.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
