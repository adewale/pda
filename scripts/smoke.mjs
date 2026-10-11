#!/usr/bin/env node
/**
 * A read-only smoke test of a deployed Worker:
 *
 *   node scripts/smoke.mjs <base-url> [--providers google,github] [--json]
 *   npm run smoke -- https://personal-agent-staging.<subdomain>.workers.dev
 *
 * It sends only GET requests without credentials, so it never signs in and
 * never changes state: the signed-out page loads; each sign-in route sends
 * the browser to its provider with PKCE and a `__Host-` flow cookie; a
 * callback with no flow is refused; protected routes refuse without a
 * session, or with a forged one; the Poppy identity documents are served on
 * this origin with public keys only; the validator page loads. Security
 * headers the Worker doesn't set (HSTS, CSP and so on) are listed as notes,
 * not failures.
 *
 * `--providers` limits the sign-in checks to providers whose OAuth app is
 * configured (an unconfigured one answers 500 naming the missing secret).
 *
 * Exit status: 0 every check passed, 1 a check failed, 2 couldn't run.
 *
 * `smoke()` takes the fetch function, so `test/smoke.test.ts` runs the same
 * checks against the Worker in the test runtime and against broken answers.
 * Node's own modules are imported only by the command line, so this file
 * also loads in workerd.
 */

/** Where each provider's consent page is, and the scopes we ask for (src/oauth.ts). */
export const PROVIDERS = {
  google: { origin: "https://accounts.google.com", path: "/o/oauth2/v2/auth", scope: "openid email" },
  github: { origin: "https://github.com", path: "/login/oauth/authorize", scope: "read:user user:email" }
};

/** Members only a private JWK has (RFC 7517, RFC 7518). */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/** Headers a hardened site usually sends; the Worker doesn't set them yet, so they're notes. */
const ADVISORY_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "x-content-type-options",
  "referrer-policy",
  "x-frame-options"
];

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The origin a base URL names: https, or http on a loopback host for `wrangler dev`. */
export function parseBase(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`The base URL must be https (or http on localhost): ${input}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`The base URL must be an origin, with no path, query or fragment: ${input}`);
  }
  return url.origin;
}

/** Each cookie a response sets, as `{ name, value, attributes }` with lower-case attribute names. */
export function parseSetCookies(headers) {
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : splitSetCookie(headers.get("set-cookie"));
  return lines.map((line) => {
    const [pair, ...rest] = line.split(";");
    const at = pair.indexOf("=");
    const attributes = {};
    for (const part of rest) {
      const [key, ...value] = part.trim().split("=");
      if (key) attributes[key.toLowerCase()] = value.join("=");
    }
    return { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim(), attributes };
  });
}

/** A folded `Set-Cookie` header split back into cookies (a comma not inside an `Expires` date). */
function splitSetCookie(value) {
  return value ? value.split(/,(?=\s*[^;,=\s]+=)/) : [];
}

/**
 * What's wrong with a sign-in redirect's `Location`, if anything: the
 * provider's consent page, our callback, `state`, and a PKCE S256 challenge.
 */
export function signInRedirectProblems(location, base, provider) {
  const want = PROVIDERS[provider];
  const problems = [];
  let url;
  try {
    url = new URL(location);
  } catch {
    return [`Location ${JSON.stringify(location)} isn't a URL`];
  }
  if (url.origin !== want.origin || url.pathname !== want.path) {
    problems.push(`goes to ${url.origin}${url.pathname}, not ${want.origin}${want.path}`);
  }
  const params = url.searchParams;
  if (!params.get("client_id")) problems.push("no client_id");
  const callback = `${base}/auth/${provider}/callback`;
  if (params.get("redirect_uri") !== callback) problems.push(`redirect_uri is ${JSON.stringify(params.get("redirect_uri"))}, not ${callback}`);
  if (params.get("response_type") !== "code") problems.push("response_type isn't code");
  if (params.get("scope") !== want.scope) problems.push(`scope is ${JSON.stringify(params.get("scope"))}, not ${JSON.stringify(want.scope)}`);
  const state = params.get("state") ?? "";
  if (state.length < 32 || !BASE64URL.test(state)) problems.push("state is missing or shorter than 32 base64url characters");
  const challenge = params.get("code_challenge") ?? "";
  if (challenge.length !== 43 || !BASE64URL.test(challenge)) problems.push("code_challenge isn't a 43-character base64url SHA-256");
  if (params.get("code_challenge_method") !== "S256") problems.push("code_challenge_method isn't S256");
  for (const secret of ["client_secret", "code_verifier"]) {
    if (params.has(secret)) problems.push(`${secret} is in the URL`);
  }
  return problems;
}

/** What's wrong with the sign-in flow cookie, if anything: `__Host-` rules, HttpOnly, SameSite=Lax, a short life. */
export function flowCookieProblems(cookies) {
  const flow = cookies.find((cookie) => cookie.name === "__Host-oauth");
  if (!flow) return ["no __Host-oauth flow cookie"];
  const problems = [];
  const a = flow.attributes;
  if (!flow.value) problems.push("the flow cookie is empty");
  if (!("secure" in a)) problems.push("the flow cookie isn't Secure");
  if (!("httponly" in a)) problems.push("the flow cookie isn't HttpOnly");
  if (a.path !== "/") problems.push("the flow cookie's Path isn't /");
  if ("domain" in a) problems.push("the flow cookie has a Domain");
  if ((a.samesite ?? "").toLowerCase() !== "lax") problems.push("the flow cookie isn't SameSite=Lax");
  const maxAge = Number(a["max-age"]);
  if (!(maxAge > 0 && maxAge <= 900)) problems.push(`the flow cookie's Max-Age is ${a["max-age"]}, not 1 to 900 seconds`);
  return problems;
}

/** Whether a response set a session cookie with a value (clearing one is fine). */
export function setsSession(cookies) {
  return cookies.some((cookie) => cookie.name === "__Host-session" && cookie.value !== "");
}

/** What's wrong with our Poppy client metadata on this origin, if anything (spec 4.1). */
export function clientMetadataProblems(metadata, base) {
  if (typeof metadata !== "object" || metadata === null) return ["not a JSON object"];
  const problems = [];
  if (metadata.client_id !== `${base}/poppy/client.json`) {
    problems.push(`client_id is ${JSON.stringify(metadata.client_id)}, not ${base}/poppy/client.json (is PUBLIC_ORIGIN this origin?)`);
  }
  if (metadata.jwks_uri !== `${base}/poppy/jwks.json`) problems.push(`jwks_uri is ${JSON.stringify(metadata.jwks_uri)}`);
  const redirects = metadata.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length !== 1 || redirects[0] !== `${base}/poppy/callback`) {
    problems.push(`redirect_uris is ${JSON.stringify(redirects)}, not [${base}/poppy/callback]`);
  }
  if (metadata.token_endpoint_auth_method !== "private_key_jwt") problems.push("token_endpoint_auth_method isn't private_key_jwt");
  if (typeof metadata.client_name !== "string" || metadata.client_name === "") problems.push("no client_name");
  return problems;
}

/** What's wrong with our published JWKS, if anything: at least one key, each public with a `kid`. */
export function jwksProblems(jwks) {
  if (typeof jwks !== "object" || jwks === null || !Array.isArray(jwks.keys)) return ["no keys array"];
  if (jwks.keys.length === 0) return ["no keys"];
  const problems = [];
  const kids = new Set();
  for (const [index, key] of jwks.keys.entries()) {
    const leaked = PRIVATE_JWK_MEMBERS.filter((member) => member in key);
    if (leaked.length > 0) problems.push(`key ${index} has private members: ${leaked.join(", ")}`);
    if (typeof key.kid !== "string" || key.kid === "") problems.push(`key ${index} has no kid`);
    else if (kids.has(key.kid)) problems.push(`kid ${key.kid} is used twice`);
    else kids.add(key.kid);
  }
  return problems;
}

/** Notes for security headers a response lacks. */
export function missingAdvisoryHeaders(headers) {
  return ADVISORY_HEADERS.filter((name) => !headers.has(name));
}

/**
 * Runs every check against `base` with `fetcher(request) => Promise<Response>`,
 * which must not follow redirects. Resolves to the results; never throws for
 * a failed check.
 */
export async function smoke(base, fetcher, options = {}) {
  const origin = parseBase(base);
  const providers = options.providers ?? Object.keys(PROVIDERS);
  for (const provider of providers) {
    if (!(provider in PROVIDERS)) throw new Error(`Unknown provider ${provider}; known: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  const results = [];
  const get = (path, headers = {}) =>
    fetcher(new Request(`${origin}${path}`, { method: "GET", headers, redirect: "manual" }));
  const check = async (name, run) => {
    try {
      const problems = (await run()) ?? [];
      results.push({ name, ok: problems.length === 0, problems });
    } catch (error) {
      results.push({ name, ok: false, problems: [`couldn't check: ${error instanceof Error ? error.message : String(error)}`] });
    }
  };
  const status = (response, want) => (response.status === want ? [] : [`status ${response.status}, not ${want}`]);

  let missing = [];
  await check("the signed-out page loads", async () => {
    const response = await get("/");
    const body = await response.text();
    const problems = status(response, 200);
    if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) problems.push("not text/html");
    if (!body.includes('<div id="root">')) problems.push("no #root element");
    if (setsSession(parseSetCookies(response.headers))) problems.push("sets a session cookie");
    missing = missingAdvisoryHeaders(response.headers);
    return problems;
  });
  if (missing.length > 0) results.push({ name: "security headers on the page", ok: true, note: true, problems: missing.map((name) => `no ${name}`) });

  for (const provider of providers) {
    await check(`/auth/${provider} redirects to ${provider} with PKCE`, async () => {
      const response = await get(`/auth/${provider}`);
      if (response.status === 500) return [`status 500: ${(await response.text()).slice(0, 200)}`];
      await response.body?.cancel();
      const problems = status(response, 303);
      const location = response.headers.get("location");
      problems.push(...(location ? signInRedirectProblems(location, origin, provider) : ["no Location"]));
      if (!(response.headers.get("cache-control") ?? "").includes("no-store")) problems.push("Cache-Control isn't no-store");
      const cookies = parseSetCookies(response.headers);
      problems.push(...flowCookieProblems(cookies));
      if (setsSession(cookies)) problems.push("sets a session cookie");
      return problems;
    });
  }

  if (providers.length > 0) {
    const provider = providers[0];
    await check(`/auth/${provider}/callback without a flow is refused`, async () => {
      const response = await get(`/auth/${provider}/callback?state=smoke&code=smoke`);
      await response.body?.cancel();
      const problems = status(response, 303);
      const location = response.headers.get("location") ?? "";
      if (new URL(location, origin).href !== `${origin}/?signin_error=state`) problems.push(`Location is ${JSON.stringify(location)}, not /?signin_error=state`);
      if (setsSession(parseSetCookies(response.headers))) problems.push("sets a session cookie");
      return problems;
    });
  }

  await check("an unknown sign-in provider is 404", async () => {
    const response = await get("/auth/smoke-unknown");
    await response.body?.cancel();
    return status(response, 404);
  });

  await check("/api/me refuses without a session", async () => {
    const response = await get("/api/me");
    await response.body?.cancel();
    return status(response, 401);
  });

  await check("/api/me refuses a forged session cookie", async () => {
    const response = await get("/api/me", { Cookie: "__Host-session=smoke.forged" });
    await response.body?.cancel();
    return status(response, 401);
  });

  const upgrade = { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "c21va2Utc21va2Utc21va2U=" };
  await check("/ws refuses without a session", async () => {
    const response = await get("/ws", { ...upgrade, Origin: origin });
    await response.body?.cancel();
    return status(response, 401);
  });

  await check("/ws refuses another origin", async () => {
    const response = await get("/ws", { ...upgrade, Origin: "https://smoke.invalid" });
    await response.body?.cancel();
    return status(response, 403);
  });

  await check("/ws needs a WebSocket upgrade", async () => {
    const response = await get("/ws");
    await response.body?.cancel();
    return status(response, 426);
  });

  await check("/poppy/callback refuses without a session", async () => {
    const response = await get("/poppy/callback");
    await response.body?.cancel();
    return status(response, 401);
  });

  await check("/logout refuses GET", async () => {
    const response = await get("/logout");
    await response.body?.cancel();
    return status(response, 405);
  });

  await check("an unknown /api route is 404 from the Worker", async () => {
    const response = await get("/api/smoke-unknown");
    await response.body?.cancel();
    return status(response, 404);
  });

  await check("the Poppy client metadata names this origin", async () => {
    const response = await get("/poppy/client.json");
    if (response.status === 404) {
      await response.body?.cancel();
      return ["status 404: the identity is served only on PUBLIC_ORIGIN, so it isn't this origin"];
    }
    return [...status(response, 200), ...clientMetadataProblems(await response.json(), origin)];
  });

  await check("the Poppy JWKS has public keys only", async () => {
    const response = await get("/poppy/jwks.json");
    if (response.status !== 200) {
      await response.body?.cancel();
      return status(response, 200);
    }
    return jwksProblems(await response.json());
  });

  await check("the validator page loads", async () => {
    const response = await get("/validator");
    const body = await response.text();
    const problems = status(response, 200);
    if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) problems.push("not text/html");
    if (response.headers.get("x-content-type-options") !== "nosniff") problems.push("no X-Content-Type-Options: nosniff");
    if (!body.includes("<form")) problems.push("no form");
    return problems;
  });

  return results;
}

/** One line per result. */
export function report(results) {
  return results
    .map((result) => {
      const mark = result.note ? "note" : result.ok ? "ok  " : "FAIL";
      return [`${mark} ${result.name}`, ...result.problems.map((problem) => `       ${problem}`)].join("\n");
    })
    .join("\n");
}

// ---------------------------------------------------------------- Command line

/**
 * fetch for Node: undici refuses an `Upgrade` header, so WebSocket probes go
 * through node:http(s), and a 101 is reported without keeping the socket.
 */
async function nodeFetcher(request) {
  if (!request.headers.has("upgrade")) return fetch(request, { signal: AbortSignal.timeout(15_000) });
  const url = new URL(request.url);
  const { request: send } = url.protocol === "https:" ? await import("node:https") : await import("node:http");
  return new Promise((resolve, reject) => {
    const outbound = send(url, { method: "GET", headers: Object.fromEntries(request.headers), timeout: 15_000 });
    outbound.on("timeout", () => outbound.destroy(new Error(`${url} timed out`)));
    outbound.on("error", reject);
    outbound.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve({ status: 101, headers: new Headers(), body: null, text: async () => "" });
    });
    outbound.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    outbound.end();
  });
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/smoke.mjs <base-url> [--providers google,github] [--json]");
    return 0;
  }
  const json = args.includes("--json");
  const providersAt = args.indexOf("--providers");
  const providers = providersAt >= 0 ? (args[providersAt + 1] ?? "").split(",").filter(Boolean) : undefined;
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !(providersAt >= 0 && index === providersAt + 1));
  if (positional.length !== 1) {
    console.error("Usage: node scripts/smoke.mjs <base-url> [--providers google,github] [--json]");
    return 2;
  }
  let results;
  try {
    results = await smoke(positional[0], nodeFetcher, providers ? { providers } : {});
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const failed = results.filter((result) => !result.ok);
  if (json) console.log(JSON.stringify({ base: parseBase(positional[0]), ok: failed.length === 0, results }, null, 2));
  else {
    console.log(report(results));
    console.log(`\n${failed.length === 0 ? "passed" : "FAILED"}: ${results.filter((r) => !r.note).length - failed.length} of ${results.filter((r) => !r.note).length} checks`);
  }
  return failed.length === 0 ? 0 : 1;
}

const invoked = typeof process !== "undefined" && process.argv?.[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (invoked) process.exitCode = await main(process.argv);
