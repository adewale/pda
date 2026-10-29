import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client.ts";
import type { Company } from "../../src/poppy/discovery.ts";
import { toIssuer } from "../../src/poppy/issuer.ts";
import { EndpointRequest } from "../../src/poppy/outgoing.ts";
import { migrate } from "../../src/poppy/store.ts";
import { memorySql } from "../impls/pda-agent/sqlite.ts";

const ISSUER = "https://auth.books.example";
const SERVICE = "https://api.books.example/v1";
const RESOURCE = "https://api.books.example/v2";
const HINT = "https://api.books.example/resource-metadata";
const INITIAL = "https://api.books.example/.well-known/oauth-protected-resource/v1";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(fetcher: PoppyHost["fetcher"]) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const sql = memorySql();
  migrate(sql);
  const host: PoppyHost = {
    env: {
      PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Metadata refresh test", POPPY_LOGO_URI: "https://agent.example/logo.svg",
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"), POPPY_SIGNING_JWKS: JSON.stringify([{ ...await exportJWK(privateKey), kid: "metadata-test" }]),
      CompanyLimiter: { getByName: () => ({ delay: async () => 0, observe: async () => {}, blockUntil: async () => {} }) }
    } as unknown as Env,
    sql, fetcher, showCard: async () => {}, notifyModel: async () => {}, schedule: async () => {}, hasJob: () => false,
    pushDirect: () => {}, userContext: () => ({ user_available: true }), sleep: async () => {}, now: () => Date.now()
  };
  const company: Company = {
    issuer: toIssuer(ISSUER), domain: "books.example", name: "Books", protocolVersion: "0.3",
    endpoints: { token: `${ISSUER}/token`, revocation: `${ISSUER}/revoke` }, signIn: {}, customScopes: {}, extensions: {},
    conversations: { endpoint: SERVICE }, apis: [{ type: "openapi", url: SERVICE, description: "Books API" }]
  };
  const client = new PoppyClient(host);
  await client.completeSignIn(company, "main", "default", { access_token: "initial-access", token_type: "Bearer", expires_in: 3600, refresh_token: "held-refresh", scope: "orders:read" });
  return { client, company, outgoing: EndpointRequest.to(company, { method: "POST", url: `${SERVICE}/messages`, body: { text: "Private task" } }) };
}

const challenge = (hint = HINT) => new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${hint}"` } });
const metadata = (resource = RESOURCE, issuer = ISSUER) => Response.json({ resource, authorization_servers: [issuer] }, { headers: { "Cache-Control": "max-age=86400" } });

describe("resource metadata refreshed after invalid_token", () => {
  it("replaces a cached default audience and retries with the resource from the challenge", async () => {
    const resources: string[] = [], auth: string[] = [], publicReads: Request[] = [];
    const f = await fixture(async (request) => {
      if (request.url === INITIAL) { publicReads.push(request); return metadata("https://books.example"); }
      if (request.url === HINT) { publicReads.push(request); return metadata(); }
      if (request.url === `${ISSUER}/token`) {
        resources.push(new URLSearchParams(await request.text()).get("resource")!);
        return Response.json({ access_token: "resource-access", token_type: "Bearer", expires_in: 3600 });
      }
      auth.push(request.headers.get("Authorization")!);
      return request.headers.get("Authorization") === "Bearer initial-access" ? challenge() : Response.json({ ok: true });
    });
    await expect(f.client.resource(f.company, f.outgoing, { service: SERVICE })).resolves.toHaveProperty("status", 200);
    await expect(f.client.resource(f.company, f.outgoing, { service: SERVICE })).resolves.toHaveProperty("status", 200);
    expect(resources).toEqual([RESOURCE]);
    expect(auth).toEqual(["Bearer initial-access", "Bearer resource-access", "Bearer resource-access"]);
    expect(publicReads.map((request) => request.url)).toEqual([INITIAL, HINT]);
    for (const request of publicReads) {
      expect(request.method).toBe("GET");
      for (const name of ["Authorization", "Poppy-Session", "DPoP", "Cookie"]) expect(request.headers.has(name)).toBe(false);
    }
  });

  it("refetches challenged metadata for an explicitly selected MCP resource without changing its exact URL", async () => {
    let reads = 0, calls = 0, grants = 0;
    const f = await fixture(async (request) => {
      if (request.url === HINT) { ++reads; return metadata(SERVICE); }
      if (request.url === `${ISSUER}/token`) {
        expect(new URLSearchParams(await request.text()).get("resource")).toBe(SERVICE);
        return Response.json({ access_token: `mcp-access-${++grants}`, token_type: "Bearer", expires_in: 3600 });
      }
      return ++calls === 1 ? challenge() : Response.json({ ok: true });
    });
    await expect(f.client.resource(f.company, f.outgoing, { resource: SERVICE })).resolves.toHaveProperty("status", 200);
    expect({ reads, calls, grants }).toEqual({ reads: 1, calls: 2, grants: 2 });
  });

  it("drops a stale service-specific audience when refreshed metadata selects the default token", async () => {
    const resources: Array<string | null> = [];
    let calls = 0;
    const f = await fixture(async (request) => {
      if (request.url === INITIAL) return metadata(RESOURCE);
      if (request.url === HINT) return metadata("https://books.example");
      if (request.url === `${ISSUER}/token`) {
        resources.push(new URLSearchParams(await request.text()).get("resource"));
        return Response.json({ access_token: `refreshed-${resources.length}`, token_type: "Bearer", expires_in: 3600 });
      }
      return ++calls === 1 ? challenge() : Response.json({ ok: true });
    });
    await expect(f.client.resource(f.company, f.outgoing, { service: SERVICE })).resolves.toHaveProperty("status", 200);
    await expect(f.client.resource(f.company, f.outgoing, { service: SERVICE })).resolves.toHaveProperty("status", 200);
    expect(resources).toEqual([RESOURCE, null]);
    expect(calls).toBe(3);
  });

  it("refreshes challenged metadata only once when a service keeps rejecting tokens", async () => {
    let reads = 0, calls = 0, grants = 0;
    const f = await fixture(async (request) => {
      if (request.url === HINT) { ++reads; return metadata(); }
      if (request.url === `${ISSUER}/token`) { ++grants; return Response.json({ access_token: "still-rejected", token_type: "Bearer", expires_in: 3600 }); }
      ++calls;
      return challenge();
    });
    await expect(f.client.resource(f.company, f.outgoing)).rejects.toMatchObject({ code: "invalid_token" });
    expect({ reads, calls, grants }).toEqual({ reads: 1, calls: 2, grants: 1 });
  });

  it("accepts an unambiguous metadata URI whose query contains a parameter-like name", async () => {
    const hint = `${HINT}?resource_metadata=version2`;
    const seen: string[] = [];
    let calls = 0;
    const f = await fixture(async (request) => {
      seen.push(request.url);
      if (request.url === hint) return metadata();
      if (request.url === `${ISSUER}/token`) return Response.json({ access_token: "resource-access", token_type: "Bearer", expires_in: 3600 });
      return ++calls === 1 ? challenge(hint) : Response.json({ ok: true });
    });
    await expect(f.client.resource(f.company, f.outgoing)).resolves.toHaveProperty("status", 200);
    expect(seen).toContain(hint);
    expect(calls).toBe(2);
  });

  it.each([
    "http://api.books.example/metadata", "https://127.0.0.1/metadata", "https://metadata.evil.example/metadata",
    "https://user:password@api.books.example/metadata", "https://api.books.example/metadata#fragment"
  ])("does not fetch an untrusted resource_metadata hint: %s", async (hint) => {
    const seen: string[] = [];
    const f = await fixture(async (request) => { seen.push(request.url); return challenge(hint); });
    await expect(f.client.resource(f.company, f.outgoing)).rejects.toMatchObject({ code: "invalid_response" });
    expect(seen).toEqual([`${SERVICE}/messages`]);
  });

  it.each([
    [RESOURCE, "https://auth.other.example"], ["https://unlisted.example/service", ISSUER], ["http://api.books.example/service", ISSUER], ["https://127.0.0.1/service", ISSUER]
  ])("rejects refreshed metadata for an untrusted issuer or resource: %s / %s", async (resource, issuer) => {
    const seen: string[] = [];
    const f = await fixture(async (request) => { seen.push(request.url); return request.url === HINT ? metadata(resource, issuer) : challenge(); });
    await expect(f.client.resource(f.company, f.outgoing)).rejects.toMatchObject({ code: "invalid_response" });
    expect(seen).toEqual([`${SERVICE}/messages`, HINT]);
  });

  it("does not follow a metadata redirect or request a token for an unverified document", async () => {
    const seen: string[] = [];
    const f = await fixture(async (request) => {
      seen.push(request.url);
      return request.url === HINT ? new Response(null, { status: 307, headers: { Location: "https://sink.books.example/metadata" } }) : challenge();
    });
    await expect(f.client.resource(f.company, f.outgoing)).rejects.toMatchObject({ code: "invalid_response" });
    expect(seen).toEqual([`${SERVICE}/messages`, HINT]);
  });

  it.each([
    `Bearer error="invalid_token", resource_metadata="${HINT}", resource_metadata="https://api.books.example/other-metadata"`,
    `Bearer error="invalid_token", resource_metadata=${HINT}`,
    `Bearer error="invalid_token", resource_metadata="${HINT}", DPoP error="insufficient_scope", resource_metadata="${HINT}"`
  ])("rejects conflicting or malformed resource metadata challenges before fetching: %s", async (header) => {
    const seen: string[] = [];
    const f = await fixture(async (request) => { seen.push(request.url); return new Response(null, { status: 401, headers: { "WWW-Authenticate": header } }); });
    await expect(f.client.resource(f.company, f.outgoing)).rejects.toMatchObject({ code: "invalid_response" });
    expect(seen).toEqual([`${SERVICE}/messages`]);
  });

  it("rejects a challenged audience that changes an explicitly selected resource", async () => {
    let calls = 0;
    const f = await fixture(async (request) => {
      if (request.url === `${ISSUER}/token`) return Response.json({ access_token: "explicit-access", token_type: "Bearer", expires_in: 3600 });
      if (request.url === HINT) return metadata(RESOURCE);
      ++calls;
      return challenge();
    });
    await expect(f.client.resource(f.company, f.outgoing, { resource: SERVICE })).rejects.toMatchObject({ code: "invalid_response" });
    expect(calls).toBe(1);
  });

  it("does not retry approved work after sign-out and same-account reauthentication during metadata refetch", async () => {
    const ready = deferred(), release = deferred();
    const beforeDispatch = vi.fn();
    let calls = 0, refreshes = 0;
    const f = await fixture(async (request) => {
      if (request.url === HINT) { ready.resolve(); await release.promise; return metadata(); }
      if (request.url === `${ISSUER}/token`) { ++refreshes; return Response.json({ access_token: "unused-access", token_type: "Bearer", expires_in: 3600 }); }
      ++calls;
      return challenge();
    });
    const pending = f.client.resource(f.company, f.outgoing, { beforeDispatch });
    const rejected = expect(pending).rejects.toMatchObject({ code: "approval_changed" });
    await ready.promise;
    f.client.deleteAccount(f.company.issuer, "default");
    await f.client.completeSignIn(f.company, "main", "default", { access_token: "new-signin-access", token_type: "Bearer", expires_in: 3600, refresh_token: "new-refresh", scope: "orders:read" });
    release.resolve();
    await rejected;
    expect({ calls, refreshes }).toEqual({ calls: 1, refreshes: 0 });
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
  });
});
