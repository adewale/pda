/**
 * Runs our strict mock Company (test/mock-company) in Node on localhost for
 * the Hypothesis suite (test/hypothesis), with no Docker. The conftest
 * bundles this file with interop/impls/shared/build.mjs, as the interop
 * adapter is bundled, and starts it.
 *
 * The placement under `<id>.company.interop.test`, the base settings, the
 * hooks and `GET /violations` come from interop/impls/shared/mock-hooks.ts,
 * the module the interop adapter (interop/impls/dpa-mock) uses too, so the
 * two serve the same hooks by the same names. The Python client connects to
 * 127.0.0.1 and sends the Company's host in `Host` with
 * `X-Forwarded-Proto: https`, which serve.ts turns back into the URL the
 * client meant, so `htu`, `aud` and the issuer are checked against the real
 * `https://` URLs. No check is relaxed.
 *
 * Two ports on 127.0.0.1, printed as one JSON line on stdout:
 * - `company`: the Company's hosts;
 * - `control`: the hooks, with `Authorization: Bearer $HYPOTHESIS_MOCK_SECRET`.
 *
 * Control routes:
 * - `POST /hooks/<name>`: the shared interop hooks;
 * - `GET /violations`: as the interop adapter serves it;
 * - this launcher's own: `POST /reset {config}`, a new mock with these
 *   settings (only the knobs in `KNOBS`) over the shared base;
 *   `POST /client-documents {documents: {url: body}}`, the Python agent's
 *   client metadata and JWKS, served to the mock at those URLs (the mock's
 *   `serveClientDocument`, made for a second client), and still checked
 *   like any client's; and `GET /state`.
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { memoryState } from "../../interop/impls/shared/cloudflare-workers.ts";
import { HookError, MOCK_BASE, mockHooks, placeInteropCompanies, violationsBody } from "../../interop/impls/shared/mock-hooks.ts";
import { authorized, body, failure, json, serve, setting } from "../../interop/impls/shared/serve.ts";
import { MockCompany } from "../mock-company/index.ts";
import type { MockConfig } from "../mock-company/types.ts";

const NAME = "hyp";
const SECRET = setting("HYPOTHESIS_MOCK_SECRET");

placeInteropCompanies();

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

const env = { PUBLIC_ORIGIN: "https://no-direct-worker.invalid" } as unknown as Env;
let mock = new MockCompany(memoryState(NAME) as never, env);
await mock.configure(MOCK_BASE);

const HOOKS = mockHooks(() => mock);

async function control(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!authorized(request, SECRET)) return failure(401, "unauthorized", "Control calls need Authorization: Bearer $HYPOTHESIS_MOCK_SECRET");
  try {
    if (request.method === "POST" && url.pathname === "/reset") {
      const given = ((await body(request)).config ?? {}) as Record<string, unknown>;
      const config: Record<string, unknown> = { ...MOCK_BASE };
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
    if (request.method === "GET" && url.pathname === "/violations") return json(violationsBody(await mock.state()));
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
