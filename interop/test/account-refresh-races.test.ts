import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import { PoppyClient, type PoppyHost } from "../../src/poppy/client.ts";
import type { Company } from "../../src/poppy/discovery.ts";
import { toIssuer } from "../../src/poppy/issuer.ts";
import { EndpointRequest } from "../../src/poppy/outgoing.ts";
import { signOut } from "../../src/poppy/signout.ts";
import { migrate, Sealer } from "../../src/poppy/store.ts";
import { memorySql } from "../impls/pda-agent/sqlite.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(answer: PoppyHost["fetcher"], previousEncryptionKey?: string) {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const sql = memorySql();
  migrate(sql);
  const issuer = toIssuer("https://auth.shop.example");
  const company: Company = {
    issuer, domain: "shop.example", name: "Shop", protocolVersion: "0.3",
    endpoints: { token: `${issuer}/token`, revocation: `${issuer}/revoke` },
    signIn: {}, customScopes: {}, extensions: {}, apis: [],
    conversations: { endpoint: "https://api.shop.example/conversations" }
  };
  const host: PoppyHost = {
    env: {
      PUBLIC_ORIGIN: "https://agent.example", POPPY_CLIENT_NAME: "Account race test", POPPY_LOGO_URI: "https://agent.example/logo.svg",
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"), POPPY_SIGNING_JWKS: JSON.stringify([{ ...await exportJWK(privateKey), kid: "account-race" }]),
      ...(previousEncryptionKey ? { TOKEN_ENC_KEY_PREVIOUS: previousEncryptionKey } : {}),
      CompanyLimiter: { getByName: () => ({ delay: async () => 0, observe: async () => {}, blockUntil: async () => {} }) }
    } as unknown as Env,
    sql, fetcher: answer, showCard: async () => {}, notifyModel: async () => {}, schedule: async () => {}, hasJob: () => false,
    pushDirect: () => {}, userContext: () => ({ user_available: true }), sleep: async () => {}, now: () => Date.now()
  };
  const client = new PoppyClient(host);
  sql.exec("INSERT INTO poppy_domains (domain, issuer, company, expires_at) VALUES (?, ?, ?, ?)", company.domain, issuer, JSON.stringify(company), Date.now() + 3600_000);
  await client.completeSignIn(company, "main", "default", { access_token: "old-access", token_type: "Bearer", expires_in: 1, refresh_token: "old-refresh", scope: "orders:read" });
  const outgoing = EndpointRequest.to(company, { method: "GET", url: company.conversations!.endpoint });
  const refreshToken = async () => {
    const account = client.account(issuer, "default");
    return account ? client.sealer.open(account.token, client.accountContext(issuer, "default")) : null;
  };
  const stepUp = () => client.completeSignIn(company, "main", "default", { access_token: "new-signin-access", token_type: "Bearer", expires_in: 3600, refresh_token: "new-signin-refresh", scope: "orders:read orders:write" });
  return { client, company, outgoing, refreshToken, stepUp };
}

describe("refresh responses cannot replace a newer account family", () => {
  it.each(["rotated", "unchanged", "invalid_grant"] as const)("rejects a stale %s response after a successful same-account sign-in", async (outcome) => {
    const ready = deferred(), release = deferred();
    const sent: Request[] = [];
    let refreshes = 0;
    const f = await fixture(async (request) => {
      if (request.url.endsWith("/token")) {
        ++refreshes;
        ready.resolve(); await release.promise;
        return outcome === "invalid_grant" ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({ access_token: "old-family-access", token_type: "Bearer", expires_in: 3600, scope: "orders:read", ...(outcome === "rotated" ? { refresh_token: "old-family-rotated" } : {}) });
      }
      sent.push(request);
      return Response.json({ ok: true });
    });
    const before = f.client.session(f.company.issuer, "main")!;
    const pending = f.client.resource(f.company, f.outgoing);
    const rejected = expect(pending).rejects.toMatchObject({ code: "approval_changed" });
    await ready.promise;
    await f.stepUp();
    release.resolve();
    await rejected;
    expect(sent).toEqual([]);
    expect(await f.refreshToken()).toBe("new-signin-refresh");
    expect(f.client.account(f.company.issuer, "default")?.scope).toBe("orders:read orders:write");
    expect(f.client.session(f.company.issuer, "main")).toMatchObject({ session_id: before.session_id, account: "default", signed_in: 1, scope: "orders:read orders:write", authority_generation: before.authority_generation });
    await expect(f.client.resource(f.company, f.outgoing)).resolves.toHaveProperty("status", 200);
    expect(refreshes).toBe(1);
    expect(sent.map((request) => request.headers.get("Authorization"))).toEqual(["Bearer new-signin-access"]);
  });

  it.each([false, true])("keeps a current refresh usable with token rotation=%s", async (rotated) => {
    const sent: Request[] = [];
    const f = await fixture(async (request) => {
      if (request.url.endsWith("/token")) return Response.json({ access_token: "current-access", token_type: "Bearer", expires_in: 3600, scope: "orders:read", ...(rotated ? { refresh_token: "current-rotated" } : {}) });
      sent.push(request); return Response.json({ ok: true });
    });
    const before = f.client.session(f.company.issuer, "main");
    await expect(f.client.resource(f.company, f.outgoing)).resolves.toHaveProperty("status", 200);
    expect(await f.refreshToken()).toBe(rotated ? "current-rotated" : "old-refresh");
    expect(f.client.session(f.company.issuer, "main")).toEqual(before);
    expect(sent.map((request) => request.headers.get("Authorization"))).toEqual(["Bearer current-access"]);
  });

  it("does not resurrect an account when sign-out wins during sign-in token sealing", async () => {
    const f = await fixture(async (request) => {
      expect(request.url).toBe(f.company.endpoints.revocation);
      return new Response(null, { status: 200 });
    });
    const ready = deferred(), release = deferred();
    const seal = f.client.sealer.seal.bind(f.client.sealer);
    const sealing = vi.spyOn(f.client.sealer, "seal").mockImplementation(async (text, context) => {
      const sealed = await seal(text, context);
      if (text === "new-signin-refresh") { ready.resolve(); await release.promise; }
      return sealed;
    });
    const pending = f.stepUp();
    const rejected = expect(pending).rejects.toMatchObject({ code: "approval_changed" });
    await ready.promise;
    const before = f.client.session(f.company.issuer, "main")!;
    await signOut(f.client, f.company.issuer, "default");
    release.resolve();
    try { await rejected; } finally { sealing.mockRestore(); }
    expect(await f.refreshToken()).toBeNull();
    expect(f.client.session(f.company.issuer, "main")).toMatchObject({ session_id: before.session_id, account: null, signed_in: 0, authority_generation: before.authority_generation + 1 });
  });

  it("does not overwrite newer sign-in access while a rotated refresh token is being sealed", async () => {
    const f = await fixture(async () => Response.json({ access_token: "old-family-access", token_type: "Bearer", expires_in: 3600, refresh_token: "old-family-rotated" }));
    const ready = deferred(), release = deferred();
    const seal = f.client.sealer.seal.bind(f.client.sealer);
    const sealing = vi.spyOn(f.client.sealer, "seal").mockImplementation(async (text, context) => {
      const sealed = await seal(text, context);
      if (text === "old-family-rotated") { ready.resolve(); await release.promise; }
      return sealed;
    });
    const pending = f.client.token(f.company);
    const rejected = expect(pending).rejects.toMatchObject({ code: "approval_changed" });
    await ready.promise;
    await f.stepUp();
    release.resolve();
    try { await rejected; } finally { sealing.mockRestore(); }
    expect(await f.refreshToken()).toBe("new-signin-refresh");
    await expect(f.client.token(f.company)).resolves.toMatchObject({ value: "new-signin-access" });
  });

  it("does not send a superseded refresh token after its client assertion finishes signing", async () => {
    const sent: Request[] = [];
    const f = await fixture(async (request) => { sent.push(request); return Response.json({ access_token: "unexpected-access", token_type: "Bearer", expires_in: 3600 }); });
    const ready = deferred(), release = deferred();
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    const signing = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const signature = await sign(...args);
      const protectedHeader = new TextDecoder().decode(args[2]).split(".")[0]!;
      if (JSON.parse(Buffer.from(protectedHeader, "base64url").toString()).typ === "JWT") { ready.resolve(); await release.promise; }
      return signature;
    });
    const pending = f.client.token(f.company);
    const rejected = expect(pending).rejects.toMatchObject({ code: "approval_changed" });
    await ready.promise;
    await f.stepUp();
    release.resolve();
    try { await rejected; } finally { signing.mockRestore(); }
    expect(sent).toEqual([]);
    expect(await f.refreshToken()).toBe("new-signin-refresh");
  });

  it("does not dispatch an old access token when same-account sign-in finishes during Session signing", async () => {
    const sent: Request[] = [];
    const f = await fixture(async (request) => {
      if (request.url.endsWith("/token")) return Response.json({ access_token: "old-family-access", token_type: "Bearer", expires_in: 3600 });
      sent.push(request); return Response.json({ ok: true });
    });
    const ready = deferred(), release = deferred();
    const header = f.client.sessionHeader.bind(f.client);
    const signing = vi.spyOn(f.client, "sessionHeader").mockImplementation(async (...args) => {
      const jwt = await header(...args); ready.resolve(); await release.promise; return jwt;
    });
    const pending = f.client.resource(f.company, f.outgoing);
    const rejected = expect(pending).rejects.toMatchObject({ code: "approval_changed" });
    await ready.promise;
    await f.stepUp();
    release.resolve();
    try { await rejected; } finally { signing.mockRestore(); }
    expect(sent).toEqual([]);
    await expect(f.client.resource(f.company, f.outgoing)).resolves.toHaveProperty("status", 200);
    expect(sent.map((request) => request.headers.get("Authorization"))).toEqual(["Bearer new-signin-access"]);
  });

  it("refreshes and rotates a token that was resealed from the previous encryption key", async () => {
    const previousKey = Buffer.alloc(32, 8).toString("base64");
    const f = await fixture(async () => Response.json({ access_token: "current-access", token_type: "Bearer", expires_in: 3600, refresh_token: "current-rotated", scope: "orders:read" }), previousKey);
    const previous = new Sealer({ TOKEN_ENC_KEY: previousKey } as Env);
    const sealed = await previous.seal("old-refresh", f.client.accountContext(f.company.issuer, "default"));
    f.client.sql.exec("UPDATE poppy_accounts SET token = ? WHERE issuer = ? AND account = ?", sealed, f.company.issuer, "default");
    await expect(f.client.token(f.company)).resolves.toMatchObject({ value: "current-access" });
    expect(await f.refreshToken()).toBe("current-rotated");
  });

  it("keeps a current invalid_grant as a withdrawal of that account only", async () => {
    const f = await fixture(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const before = f.client.session(f.company.issuer, "main")!;
    await expect(f.client.token(f.company)).resolves.toBeNull();
    expect(await f.refreshToken()).toBeNull();
    expect(f.client.session(f.company.issuer, "main")).toMatchObject({ session_id: before.session_id, signed_in: 0, account: null, authority_generation: before.authority_generation + 1 });
  });

  it("does not invalidate an in-flight resource merely because another current refresh rotates the token", async () => {
    let refreshes = 0;
    const sent: Request[] = [];
    const f = await fixture(async (request) => {
      if (request.url.endsWith("/token")) return Response.json({ access_token: `access-${++refreshes}`, token_type: "Bearer", expires_in: 3600, refresh_token: `rotation-${refreshes}` });
      sent.push(request); return Response.json({ ok: true });
    });
    const ready = deferred(), release = deferred();
    const header = f.client.sessionHeader.bind(f.client);
    let first = true;
    const signing = vi.spyOn(f.client, "sessionHeader").mockImplementation(async (...args) => {
      const jwt = await header(...args);
      if (first) { first = false; ready.resolve(); await release.promise; }
      return jwt;
    });
    const firstRequest = f.client.resource(f.company, f.outgoing);
    await ready.promise;
    await expect(f.client.resource(f.company, f.outgoing, { resource: f.company.conversations!.endpoint })).resolves.toHaveProperty("status", 200);
    release.resolve();
    try { await expect(firstRequest).resolves.toHaveProperty("status", 200); } finally { signing.mockRestore(); }
    expect(refreshes).toBe(2);
    expect(sent.map((request) => request.headers.get("Authorization")).sort()).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(await f.refreshToken()).toBe("rotation-2");
  });

  it("does not restart a new account's Session because an older request returned invalid_session", async () => {
    const ready = deferred(), release = deferred();
    let resources = 0;
    const f = await fixture(async (request) => {
      if (request.url.endsWith("/token")) return Response.json({ access_token: "old-family-access", token_type: "Bearer", expires_in: 3600 });
      if (++resources === 1) { ready.resolve(); await release.promise; return Response.json({ error: "invalid_session" }, { status: 400 }); }
      return Response.json({ ok: true });
    });
    const pending = f.client.resource(f.company, f.outgoing);
    const rejected = expect(pending).rejects.toMatchObject({ code: "approval_changed" });
    await ready.promise;
    await f.client.completeSignIn(f.company, "main", "work", { access_token: "work-access", token_type: "Bearer", expires_in: 3600, refresh_token: "work-refresh", scope: "orders:read" });
    const current = f.client.session(f.company.issuer, "main");
    release.resolve();
    await rejected;
    expect(resources).toBe(1);
    expect(f.client.session(f.company.issuer, "main")).toEqual(current);
    await expect(f.client.resource(f.company, f.outgoing)).resolves.toHaveProperty("status", 200);
    expect(f.client.session(f.company.issuer, "main")).toEqual(current);
  });
});
