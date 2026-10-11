/**
 * scripts/smoke.mjs, the read-only smoke test of a deployed Worker: its
 * checks pass against our Worker here, each fails when the answer it guards
 * is broken, and it only ever sends credential-free GETs.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import page from "../index.html?raw";
import {
  clientMetadataProblems,
  flowCookieProblems,
  jwksProblems,
  parseBase,
  parseSetCookies,
  signInRedirectProblems,
  smoke,
  type SmokeResult
} from "../scripts/smoke.mjs";
import { fetchWorker } from "./agent-helpers";

/** The Worker's own origin in test/wrangler.jsonc, where it serves its Poppy identity. */
const BASE = env.PUBLIC_ORIGIN;

type Fetch = (request: Request) => Promise<Response>;

/** Our Worker, with the page itself standing in for static assets, which the test runtime doesn't serve. */
const ourWorker: Fetch = async (request) =>
  new URL(request.url).pathname === "/"
    ? new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    : fetchWorker(request);

/** Our Worker with the answer at `path` changed. */
function tampered(path: string, change: (response: Response) => Response | Promise<Response>): Fetch {
  return async (request) => {
    const response = await ourWorker(request);
    return new URL(request.url).pathname === path ? change(response) : response;
  };
}

function failed(results: readonly SmokeResult[]): Record<string, string[]> {
  return Object.fromEntries(results.filter((result) => !result.ok).map((result) => [result.name, [...result.problems]]));
}

describe("the smoke test (scripts/smoke.mjs)", () => {
  it("passes against our Worker", async () => {
    const results = await smoke(BASE, ourWorker);
    expect(failed(results)).toEqual({});
    expect(results.filter((result) => !result.note).length).toBeGreaterThanOrEqual(16);
  });

  it("sends only GETs, and no credentials but a forged session cookie", async () => {
    const seen: { method: string; headers: Headers }[] = [];
    await smoke(BASE, async (request) => {
      seen.push({ method: request.method, headers: new Headers(request.headers) });
      return ourWorker(request);
    });
    expect(new Set(seen.map((request) => request.method))).toEqual(new Set(["GET"]));
    const cookies = seen.map((request) => request.headers.get("Cookie")).filter((cookie) => cookie !== null);
    expect(cookies).toEqual(["__Host-session=smoke.forged"]);
    expect(seen.some((request) => request.headers.has("Authorization"))).toBe(false);
  });

  it("checks only the providers it's given", async () => {
    const results = await smoke(BASE, ourWorker, { providers: ["github"] });
    expect(results.map((result) => result.name).filter((name) => name.startsWith("/auth/"))).toEqual([
      "/auth/github redirects to github with PKCE",
      "/auth/github/callback without a flow is refused"
    ]);
  });

  it("fails a sign-in redirect without PKCE", async () => {
    const results = await smoke(
      BASE,
      tampered("/auth/github", (response) => {
        const location = new URL(response.headers.get("Location")!);
        location.searchParams.delete("code_challenge");
        const headers = new Headers(response.headers);
        headers.set("Location", location.href);
        return new Response(null, { status: response.status, headers });
      })
    );
    expect(failed(results)["/auth/github redirects to github with PKCE"]).toEqual([
      "code_challenge isn't a 43-character base64url SHA-256"
    ]);
  });

  it("fails a flow cookie that scripts can read", async () => {
    const results = await smoke(
      BASE,
      tampered("/auth/google", (response) => {
        const headers = new Headers(response.headers);
        headers.set("Set-Cookie", response.headers.get("Set-Cookie")!.replace("; HttpOnly", ""));
        return new Response(null, { status: response.status, headers });
      })
    );
    expect(failed(results)["/auth/google redirects to google with PKCE"]).toEqual(["the flow cookie isn't HttpOnly"]);
  });

  it("fails a callback that signs someone in without a flow", async () => {
    const results = await smoke(
      BASE,
      tampered("/auth/google/callback", (response) => {
        const headers = new Headers(response.headers);
        headers.append("Set-Cookie", "__Host-session=minted; Path=/; HttpOnly; Secure; SameSite=Lax");
        return new Response(null, { status: response.status, headers });
      })
    );
    expect(failed(results)["/auth/google/callback without a flow is refused"]).toEqual(["sets a session cookie"]);
  });

  it("fails a protected route that answers without a session", async () => {
    const results = await smoke(BASE, tampered("/api/me", () => Response.json({ email: "someone@example.com" })));
    expect(Object.keys(failed(results))).toEqual(["/api/me refuses without a session", "/api/me refuses a forged session cookie"]);
  });

  it("fails a JWKS that publishes a private key", async () => {
    const results = await smoke(
      BASE,
      tampered("/poppy/jwks.json", async (response) => {
        const jwks = (await response.json()) as { keys: Record<string, unknown>[] };
        return Response.json({ keys: jwks.keys.map((key) => ({ ...key, d: "private" })) });
      })
    );
    expect(failed(results)["the Poppy JWKS has public keys only"]).toEqual([
      "key 0 has private members: d",
      "key 1 has private members: d"
    ]);
  });

  it("fails on an origin that isn't PUBLIC_ORIGIN", async () => {
    const results = await smoke("https://other.example", ourWorker, { providers: [] });
    expect(failed(results)["the Poppy client metadata names this origin"]).toEqual([
      "status 404: the identity is served only on PUBLIC_ORIGIN, so it isn't this origin"
    ]);
  });

  it("refuses a base URL that isn't an https origin", () => {
    expect(parseBase("https://agent.example/")).toBe("https://agent.example");
    expect(parseBase("http://localhost:8787")).toBe("http://localhost:8787");
    expect(() => parseBase("http://agent.example")).toThrow(/https/);
    expect(() => parseBase("https://agent.example/app")).toThrow(/origin/);
    expect(() => parseBase("agent.example")).toThrow(/Not a URL/);
  });

  it("reads cookies from a folded Set-Cookie header", () => {
    const headers = { get: () => "a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, __Host-oauth=x; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax" } as unknown as Headers;
    const cookies = parseSetCookies(headers);
    expect(cookies.map((cookie) => cookie.name)).toEqual(["a", "__Host-oauth"]);
    expect(flowCookieProblems(cookies)).toEqual([]);
  });

  it("checks the redirect, metadata and keys it is given", () => {
    const base = "https://agent.example";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const state = "s".repeat(43);
    const good = `https://github.com/login/oauth/authorize?client_id=c&redirect_uri=${encodeURIComponent(`${base}/auth/github/callback`)}&response_type=code&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&scope=read%3Auser+user%3Aemail`;
    expect(signInRedirectProblems(good, base, "github")).toEqual([]);
    expect(signInRedirectProblems(good.replace("github.com", "github.example"), base, "github")).toEqual([
      "goes to https://github.example/login/oauth/authorize, not https://github.com/login/oauth/authorize"
    ]);
    expect(signInRedirectProblems(`${good}&client_secret=x`, base, "github")).toEqual(["client_secret is in the URL"]);
    expect(
      clientMetadataProblems(
        {
          client_id: `${base}/poppy/client.json`,
          client_name: "Agent",
          jwks_uri: `${base}/poppy/jwks.json`,
          redirect_uris: [`${base}/poppy/callback`],
          token_endpoint_auth_method: "private_key_jwt"
        },
        base
      )
    ).toEqual([]);
    expect(jwksProblems({ keys: [{ kty: "EC", kid: "a" }, { kty: "EC", kid: "a" }] })).toEqual(["kid a is used twice"]);
    expect(jwksProblems({ keys: [] })).toEqual(["no keys"]);
  });
});
