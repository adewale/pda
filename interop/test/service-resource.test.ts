import { decodeJwt, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client.ts";
import type { Company } from "../../src/poppy/discovery.ts";
import { toIssuer } from "../../src/poppy/issuer.ts";
import { EndpointRequest } from "../../src/poppy/outgoing.ts";
import { migrate } from "../../src/poppy/store.ts";
import { memorySql } from "../impls/pda-agent/sqlite.ts";

const SERVICE = "https://api.books.example/v1";
const ISSUER = "https://auth.books.example";

function company(domain: string, issuer: string): Company {
  return {
    issuer: toIssuer(issuer), domain, name: domain, protocolVersion: "0.3",
    endpoints: { token: `${issuer}/token`, revocation: `${issuer}/revoke` },
    signIn: {}, customScopes: {}, extensions: {},
    apis: [{ type: "openapi", url: SERVICE, description: "The listed API" }]
  };
}

/** Use the real client with public metadata responses; no OAuth or resource request is needed. */
function fixture(answer: (url: string) => Response) {
  const requests: string[] = [];
  const host: PoppyHost = {
    env: {
      PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Service metadata test",
      POPPY_LOGO_URI: "https://agent.example/logo.svg", TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64")
    } as unknown as Env,
    sql: memorySql(),
    fetcher: async (request) => { requests.push(request.url); return answer(request.url); },
    showCard: async () => {}, notifyModel: async () => {}, schedule: async () => {}, hasJob: () => false,
    pushDirect: () => {}, userContext: () => ({ user_available: true }), sleep: async () => {}, now: () => Date.now()
  };
  return { client: new PoppyClient(host), requests };
}

describe("per-service access-token metadata", () => {
  const books = company("books.example", ISSUER);
  // A Company can list a public service without that service accepting its issuer.
  const other = company("other.example", "https://auth.other.example");
  const metadata = () => Response.json({ resource: SERVICE, authorization_servers: [ISSUER] }, { headers: { "Cache-Control": "max-age=86400" } });

  it("does not let another Company's rejected metadata decision suppress the service's own resource", async () => {
    const { client, requests } = fixture(metadata);
    expect(await client.serviceResource(other, SERVICE)).toBeUndefined();
    expect(await client.serviceResource(books, SERVICE)).toBe(SERVICE);
    // Cache the response, but evaluate its issuer for each Company.
    expect(requests).toEqual(["https://api.books.example/.well-known/oauth-protected-resource/v1"]);
  });

  it("does not reuse one Company's accepted resource for a Company the metadata does not name", async () => {
    const { client, requests } = fixture(metadata);
    expect(await client.serviceResource(books, SERVICE)).toBe(SERVICE);
    expect(await client.serviceResource(other, SERVICE)).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["https://api.books.example/", "https://api.books.example/.well-known/oauth-protected-resource"],
    ["https://api.books.example/conversations", "https://api.books.example/.well-known/oauth-protected-resource/conversations"],
    ["https://api.books.example/conversations/", "https://api.books.example/.well-known/oauth-protected-resource/conversations/"]
  ])("finds the exact protected resource metadata path for %s", async (service, expectedUrl) => {
    const { client, requests } = fixture((url) => url === expectedUrl
      ? Response.json({ resource: service, authorization_servers: [ISSUER] })
      : new Response(null, { status: 404 }));
    expect(await client.serviceResource(books, service)).toBe(service);
    expect(requests).toEqual([expectedUrl]);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function resourceFixture(answer: PoppyHost["fetcher"]) {
  const f = fixture(() => Response.json({}));
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  Object.assign(f.client.host.env, {
    POPPY_SIGNING_JWKS: JSON.stringify([{ ...await exportJWK(privateKey), kid: "resource-binding" }]),
    CompanyLimiter: { getByName: () => ({ delay: async () => 0, observe: async () => {}, blockUntil: async () => {} }) }
  });
  migrate(f.client.sql);
  vi.spyOn(f.client.host, "fetcher").mockImplementation(answer);
  const target: Company = { ...company("books.example", ISSUER), conversations: { endpoint: SERVICE } };
  const outgoing = EndpointRequest.to(target, { method: "GET", url: `${SERVICE}/events` });
  return { client: f.client, target, outgoing };
}

describe("the prepared resource request's Session binding", () => {
  it.each(["sign_in", "sign_out", "new_session", "same_account"] as const)("does not dispatch an earlier binding after %s during JWT signing", async (change) => {
    const sent: Request[] = [];
    const { client, target, outgoing } = await resourceFixture(async (request) => { sent.push(request); return Response.json({}); });
    if (change === "sign_out" || change === "same_account") await client.completeSignIn(target, "main", "default", { access_token: "old-access", token_type: "Bearer", expires_in: 3600, refresh_token: "old-refresh", scope: "orders:read" });
    const ready = deferred(), release = deferred();
    const sign = client.sessionHeader.bind(client);
    const signing = vi.spyOn(client, "sessionHeader").mockImplementation(async (...args) => {
      const jwt = await sign(...args);
      ready.resolve();
      await release.promise;
      return jwt;
    });
    const beforeDispatch = vi.fn();
    const request = client.resource(target, outgoing, { beforeDispatch });
    const rejected = expect(request).rejects.toMatchObject({ code: "approval_changed" });
    await ready.promise;
    if (change === "sign_in") await client.completeSignIn(target, "main", "default", { access_token: "new-access", token_type: "Bearer", expires_in: 3600, refresh_token: "new-refresh", scope: "orders:read" });
    else if (change === "sign_out") client.deleteAccount(target.issuer, "default");
    else if (change === "same_account") {
      const before = client.session(target.issuer, "main")!;
      client.deleteAccount(target.issuer, "default");
      await client.completeSignIn(target, "main", "default", { access_token: "new-access", token_type: "Bearer", expires_in: 3600, refresh_token: "new-refresh", scope: "orders:read" });
      expect(client.session(target.issuer, "main")?.session_id).toBe(before.session_id);
      expect(client.session(target.issuer, "main")?.authority_generation).toBe(before.authority_generation + 1);
    }
    else { client.abandonSession(target.issuer, "main"); client.sessionFor(target, "main"); }
    release.resolve();
    try { await rejected; }
    finally { signing.mockRestore(); }
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("prepares again if an account changes while an access token is being obtained", async () => {
    const ready = deferred(), release = deferred();
    const sent: Request[] = [];
    const refreshes: string[] = [];
    const { client, target, outgoing } = await resourceFixture(async (request) => {
      if (request.url.endsWith("/token")) {
        const token = new URLSearchParams(await request.text()).get("refresh_token")!;
        refreshes.push(token);
        if (token === "old-refresh") { ready.resolve(); await release.promise; }
        return Response.json({ access_token: token === "old-refresh" ? "old-access" : "work-access", token_type: "Bearer", expires_in: 3600, scope: "orders:read" });
      }
      sent.push(request);
      return Response.json({});
    });
    // A near-expired token forces a real refresh rather than a fabricated token() result.
    await client.completeSignIn(target, "main", "default", { access_token: "near-expiry", token_type: "Bearer", expires_in: 1, refresh_token: "old-refresh", scope: "orders:read" });
    const request = client.resource(target, outgoing);
    await ready.promise;
    await client.completeSignIn(target, "main", "work", { access_token: "work-access", token_type: "Bearer", expires_in: 3600, refresh_token: "work-refresh", scope: "orders:read" });
    release.resolve();
    await expect(request).resolves.toHaveProperty("status", 200);
    expect(refreshes).toEqual(["old-refresh", "work-refresh"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("Authorization")).toBe("Bearer work-access");
    expect(decodeJwt(sent[0]!.headers.get("Poppy-Session")!).sid).toBe(client.session(target.issuer, "main")!.session_id);
  });

  it("dispatches an unchanged binding and exposes that same binding to the authority check", async () => {
    const sent: Request[] = [];
    const { client, target, outgoing } = await resourceFixture(async (request) => { sent.push(request); return Response.json({}); });
    await client.completeSignIn(target, "main", "default", { access_token: "current-access", token_type: "Bearer", expires_in: 3600, refresh_token: "current-refresh", scope: "orders:read" });
    let sid: string | undefined;
    await client.resource(target, outgoing, { beforeDispatch: () => { sid = client.session(target.issuer, "main")?.session_id; } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.get("Authorization")).toBe("Bearer current-access");
    expect(decodeJwt(sent[0]!.headers.get("Poppy-Session")!).sid).toBe(sid);
  });

  it("preserves a withdrawal generation across repeated sign-out, reauthentication, Session restart and client recreation", async () => {
    let sent = 0;
    const { client, target, outgoing } = await resourceFixture(async (request) => {
      if (request.url.endsWith("/token")) return Response.json({ access_token: "renewed-access", token_type: "Bearer", expires_in: 3600 });
      return ++sent === 1 ? Response.json({ error: "invalid_session" }, { status: 400 }) : Response.json({});
    });
    await client.completeSignIn(target, "main", "default", { access_token: "old-access", token_type: "Bearer", expires_in: 3600, refresh_token: "old-refresh", scope: "orders:read" });
    const before = client.session(target.issuer, "main")!;
    client.signOutSession(target.issuer, "main");
    client.signOutSession(target.issuer, "main");
    expect(client.session(target.issuer, "main")?.authority_generation).toBe(before.authority_generation + 1);
    await client.completeSignIn(target, "main", "default", { access_token: "new-access", token_type: "Bearer", expires_in: 3600, refresh_token: "new-refresh", scope: "orders:read" });
    await expect(client.resource(target, outgoing)).resolves.toHaveProperty("status", 200);
    const current = client.session(target.issuer, "main")!;
    expect(current.session_id).not.toBe(before.session_id);
    expect(current.authority_generation).toBe(before.authority_generation + 1);
    const recreated = new PoppyClient(client.host);
    expect(recreated.session(target.issuer, "main")?.authority_generation).toBe(current.authority_generation);
  });
});
